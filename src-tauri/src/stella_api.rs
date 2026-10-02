//! Stella's live game API — rooms, people and profiles — reached the way the
//! game client reaches it.
//!
//! Stella runs the stock Rec Room backend behind Cloudflare on
//! `api.stellaonline.org`. Three things, and only these three, get a request
//! through and answered (measured against the real client, 2026-10-01):
//!
//! 1. **`User-Agent: BestHTTP`.** Cloudflare's rule is purely on this string —
//!    the game's HTTP library. Anything else is a 403 block page before the
//!    origin is even reached (`/download/*` is the one open exception, which is
//!    why the installer in `stella.rs` uses a different User-Agent). The whole
//!    "we can't read Stella" story up to now was this one header.
//! 2. **A bearer token**, from [`login`]: the game signs in with a Steam
//!    auth-session ticket, and so does this. No ticket, 401.
//! 3. For a handful of write paths, an `X-RNSIG` request signature — which none
//!    of the read endpoints here need, so it is not implemented.
//!
//! The Stella developers run this same access for their own Discord bot and
//! asked us to use it; it is a community revival of a shut-down game, read with
//! the player's own account. Everything below is read-only: room and people
//! listings and public profiles, reshaped into the exact envelope the frontend
//! already consumes for Radium and Vanilla (`{ Results, TotalResults }`, with
//! absolute `ThumbUrl` / `AvatarUrl`), so `loadRooms()` / `loadPeople()` do not
//! care which network answered.
//!
//! ## Auth, and why there is no refresh
//!
//! `POST /auth/connect/token` with `grant_type=cached_login` takes the Steam
//! ticket and returns an access token (a JWT) and a refresh token. The refresh
//! grant answers 500 on this server, so this does not use it: when the access
//! token nears its `exp`, [`ensure_session`] simply signs in again with a fresh
//! ticket. A sign-in needs Steam running and the account owning Rec Room
//! (AppId 471710); when it isn't, the tabs show that rather than an error.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::server::{http_client_besthttp, read_capped, MAX_API_BYTES};

const BASE: &str = "https://api.stellaonline.org";
const IMG_BASE: &str = "https://api.stellaonline.org/img";

/// Stella's Cloudflare answers the API only for this User-Agent.
pub const USER_AGENT: &str = "BestHTTP";

/// The game's OAuth client. `client_id` and `client_secret` are a single shared
/// credential baked into every copy of the Rec Room client (and every revival
/// that reuses it) — not a per-user secret, and extractable from any install —
/// so it lives here as a constant rather than being asked for.
const CLIENT_ID: &str = "recroom";
const CLIENT_SECRET: &str = "VxZ53kgbbEaRoZAeMe00MagtgD12GLL2";

/// Rec Room's Steam App ID; the auth ticket is minted for it.
const STEAM_APP_ID: u32 = 471710;

/// Re-sign-in this many seconds before the token's own expiry, so a request is
/// never sent with a token about to lapse.
const EXPIRY_SKEW_SECS: u64 = 120;

/// A signed-in session, cached until the token nears expiry.
struct Session {
    access_token: String,
    /// Unix seconds; 0 if the token carried no readable `exp` (then a short
    /// fixed lifetime is assumed by [`ensure_session`]).
    expires_at: u64,
    account_id: i64,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Clear the cached session, so the next call signs in again. Called on a 401,
/// and when the user signs out.
pub fn forget_session() {
    if let Ok(mut s) = SESSION.lock() {
        *s = None;
    }
}

// ─── Account (signed in / signed out) ───────────────────────────────────────

/// Set by LOG OUT and kept across restarts (as a marker file), so a signed-out
/// launcher stays signed out: with it set, nothing signs in on its own — every
/// API call answers [`SIGNED_OUT_ERROR`] until LOG IN clears it. Without this a
/// log-out would last only until the next Rooms page silently signed back in.
static SIGNED_OUT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SIGNED_OUT_MARKER: OnceLock<std::path::PathBuf> = OnceLock::new();
const SIGNED_OUT_FILE: &str = "stella-signed-out";

/// What a sign-in answers when Steam isn't running. The frontend matches on it
/// to offer "start Steam" and to retry when the window is next focused.
pub const STEAM_NOT_RUNNING: &str = "Steam isn't running.";

/// What an API call answers while signed out; the frontend shows a sign-in
/// prompt for it rather than an error.
pub const SIGNED_OUT_ERROR: &str = "Signed out of Stella.";

/// Called once at startup with the app's local data dir.
pub fn init(local_data_dir: std::path::PathBuf) {
    let marker = local_data_dir.join(SIGNED_OUT_FILE);
    SIGNED_OUT.store(marker.exists(), std::sync::atomic::Ordering::SeqCst);
    let _ = SIGNED_OUT_MARKER.set(marker);
}

pub(crate) fn signed_out() -> bool {
    SIGNED_OUT.load(std::sync::atomic::Ordering::SeqCst)
}

fn set_signed_out(out: bool) {
    SIGNED_OUT.store(out, std::sync::atomic::Ordering::SeqCst);
    if let Some(marker) = SIGNED_OUT_MARKER.get() {
        if out {
            if let Some(dir) = marker.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(marker, b"");
        } else {
            let _ = std::fs::remove_file(marker);
        }
    }
}

/// The signed-in account as the frontend's person row, or an error.
async fn me() -> Result<Value, String> {
    let (_, account_id) = ensure_session().await?;
    let account = api_get(&format!("/account/bulk?id={account_id}"))
        .await?
        .as_array()
        .and_then(|a| a.first().cloned())
        .ok_or("Stella returned no account.")?;
    Ok(person_row(&account))
}

/// `{ authenticated, player?, signedOut?, error? }`. Signs in (with Steam) if
/// not already, unless the user logged out — then it only reports that.
#[tauri::command]
pub async fn stella_auth_status() -> Value {
    if signed_out() {
        return json!({ "authenticated": false, "signedOut": true });
    }
    match me().await {
        Ok(player) => {
            prefetch_rooms();
            json!({ "authenticated": true, "player": player })
        }
        Err(e) => json!({ "authenticated": false, "error": e }),
    }
}

/// LOG IN: clear the signed-out state and sign in with Steam now.
#[tauri::command]
pub async fn stella_login() -> Result<Value, String> {
    set_signed_out(false);
    forget_session();
    let player = me().await?;
    prefetch_rooms();
    Ok(player)
}

/// LOG OUT: drop the session and stay signed out until LOG IN.
#[tauri::command]
pub fn stella_logout() {
    set_signed_out(true);
    forget_session();
    crate::stella_hub::stop();
    if let Ok(mut c) = HOT_CACHE.lock() {
        *c = None;
    }
}

// ─── Steam ticket ─────────────────────────────────────────────────────────

/// Acquire a Steam auth-session ticket for Rec Room, as uppercase hex, with the
/// signed-in Steam id. Blocking (the Steamworks callbacks are pumped briefly),
/// so callers run it on a blocking thread.
///
/// Fails cleanly when Steam isn't running or the account doesn't own the app —
/// the caller turns that into a message the tab can show.
#[cfg(target_os = "windows")]
fn steam_ticket() -> Result<(String, String), String> {
    // Told apart from a failed init so the UI can say "start Steam" and retry
    // when it does, rather than a vaguer either-or.
    if !crate::game::check_steam() {
        return Err(STEAM_NOT_RUNNING.into());
    }
    let client = steamworks::Client::init_app(STEAM_APP_ID).map_err(|_| {
        "Steam couldn't sign you in to Stella. Make sure you're logged in to Steam with an account that owns Rec Room.".to_string()
    })?;
    let steam_id = client.user().steam_id().raw().to_string();

    let identity = steamworks::networking_types::NetworkingIdentity::new();
    let (_handle, ticket) = client.user().authentication_session_ticket(identity);

    // GetAuthSessionTicket fills the bytes synchronously but Steam validates it
    // with its backend a moment later; pump callbacks briefly so the ticket is
    // live by the time the server checks it.
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_millis(1300) {
        client.run_callbacks();
        std::thread::sleep(Duration::from_millis(50));
    }
    if ticket.is_empty() {
        return Err("Steam returned an empty auth ticket.".into());
    }
    Ok((steam_id, hex_upper(&ticket)))
}

#[cfg(not(target_os = "windows"))]
fn steam_ticket() -> Result<(String, String), String> {
    Err("Stella sign-in is only supported on Windows.".into())
}

fn hex_upper(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

// ─── Device id ───────────────────────────────────────────────────────────

/// Rec Room's `device_id` for `cached_login` is Unity's
/// `deviceUniqueIdentifier` — a per-machine value the game registered to this
/// account on its first sign-in. The server binds it: `cached_login` with any
/// other device id is rejected ("platform verification failed"), because an
/// unregistered device would need the full `dinfo` registration blob the game
/// computes. So the launcher must present the *same* id the game did.
///
/// Unity doesn't store it as a plain field, but it stamps it on every analytics
/// event as `"deviceid":"<40 hex>"`. This reads it back from Rec Room's own
/// analytics events on disk, caches it for the process, and is why signing in
/// needs the game to have run at least once (it always has: the launcher
/// installed it).
fn device_id() -> Result<String, String> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(g) = cache.lock() {
        if let Some(v) = g.as_ref() {
            return Ok(v.clone());
        }
    }
    let id = scan_device_id()
        .ok_or("Couldn't read your Rec Room device id — launch Rec Room once so Stella registers this device, then try again.")?;
    if let Ok(mut g) = cache.lock() {
        *g = Some(id.clone());
    }
    Ok(id)
}

/// Walk Rec Room's Unity analytics events for the first `"deviceid":"<40 hex>"`.
fn scan_device_id() -> Option<String> {
    let base = std::env::var("USERPROFILE").ok()?;
    let analytics = std::path::Path::new(&base)
        .join("AppData")
        .join("LocalLow")
        .join("Against Gravity")
        .join("Rec Room")
        .join("Unity");
    let mut found = None;
    // Bounded walk: Unity/<appid>/Analytics/ArchivedEvents/<batch>/{e,s}
    visit_files(&analytics, 6, &mut |path| {
        if found.is_some() {
            return;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name != "e" && name != "s" {
            return;
        }
        if let Ok(bytes) = std::fs::read(path) {
            if let Some(id) = extract_deviceid(&bytes) {
                found = Some(id);
            }
        }
    });
    found
}

/// First `"deviceid":"<40 lowercase hex>"` value in `bytes`.
fn extract_deviceid(bytes: &[u8]) -> Option<String> {
    let hay = String::from_utf8_lossy(bytes);
    let key = "\"deviceid\":\"";
    let start = hay.find(key)? + key.len();
    let rest = &hay[start..];
    let end = rest.find('"')?;
    let val = &rest[..end];
    if val.len() == 40 && val.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(val.to_string())
    } else {
        None
    }
}

/// Depth-bounded file walk, calling `f` on every file found.
fn visit_files(dir: &std::path::Path, depth: usize, f: &mut impl FnMut(&std::path::Path)) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_files(&path, depth - 1, f);
        } else {
            f(&path);
        }
    }
}

// ─── Sign-in ─────────────────────────────────────────────────────────────

/// The `exp` claim of a JWT, as unix seconds, or 0 if it can't be read.
fn jwt_expiry(token: &str) -> u64 {
    let Some(payload) = token.split('.').nth(1) else { return 0 };
    let Some(bytes) = base64url_decode(payload) else { return 0 };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get("exp").and_then(|e| e.as_u64()))
        .unwrap_or(0)
}

/// Minimal base64url (no padding) decode, enough for a JWT payload.
fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        let v = val(c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// Sign in with a fresh Steam ticket and return a live [`Session`].
async fn login() -> Result<Session, String> {
    let (steam_id, ticket_hex) =
        tokio::task::spawn_blocking(steam_ticket).await.map_err(|e| e.to_string())??;

    // The device id must be the one the game registered for this account.
    let device = device_id()?;

    let client = http_client_besthttp();

    // account id for the signed-in Steam id (also tells us the account exists)
    let lookup = send_with_retry(
        client
            .get(format!("{BASE}/auth/cachedlogin/forplatformid/0/{steam_id}"))
            .timeout(Duration::from_secs(15)),
    )
    .await?;
    let lookup_body = read_capped(lookup, MAX_API_BYTES).await?;
    let account_id = serde_json::from_slice::<Value>(&lookup_body)
        .ok()
        .and_then(|v| v.get(0).and_then(|x| x.get("accountId")).and_then(|x| x.as_i64()))
        .ok_or("This Steam account has no Stella account yet. Launch the game once to create one.")?;

    // eac challenge (the server wants the value echoed back; it isn't verified)
    let eac = client
        .get(format!("{BASE}/auth/eac/challenge"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok();
    let eac = match eac {
        Some(r) => {
            let b = read_capped(r, MAX_API_BYTES).await.unwrap_or_default();
            String::from_utf8_lossy(&b).trim().trim_matches('"').to_string()
        }
        None => String::new(),
    };

    let asid = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string();
    let platform_auth = json!({ "Ticket": ticket_hex, "AppId": "471710", "Error": "-1" }).to_string();

    let form = [
        ("grant_type", "cached_login"),
        ("account_id", &account_id.to_string()),
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("platform", "0"),
        ("platform_id", &steam_id),
        ("device_id", &device),
        ("device_class", "2"),
        ("ver", "20240418"),
        ("cid", "13735"),
        ("asid", &asid),
        ("locale", "en"),
        ("isInitialLogin", "true"),
        ("eac_challenge", &eac),
        ("eac_response", "test"),
        ("platform_auth", &platform_auth),
    ];

    let resp = client
        .post(format!("{BASE}/auth/connect/token"))
        .form(&form)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Stella sign-in failed: {e}"))?;
    let status = resp.status();
    let body = read_capped(resp, MAX_API_BYTES).await?;
    if !status.is_success() {
        return Err(format!("Stella sign-in was refused (HTTP {}).", status.as_u16()));
    }
    let token: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let access_token = token
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("Stella sign-in returned no token.")?
        .to_string();
    let expires_at = jwt_expiry(&access_token);

    Ok(Session { access_token, expires_at, account_id })
}

/// The cached session, if present and not within [`EXPIRY_SKEW_SECS`] of its
/// `exp`. A token with no readable `exp` is treated as already stale, so a fresh
/// sign-in replaces it (in practice Stella's tokens always carry `exp`).
fn cached_valid() -> Option<(String, i64)> {
    let guard = SESSION.lock().ok()?;
    let s = guard.as_ref()?;
    if s.expires_at > 0 && now_secs() < s.expires_at.saturating_sub(EXPIRY_SKEW_SECS) {
        Some((s.access_token.clone(), s.account_id))
    } else {
        None
    }
}

/// Serializes sign-in. Steamworks allows only one `Client` in a process at a
/// time, so two concurrent `login()` calls would call `SteamAPI_Init` twice and
/// abort the whole launcher. Opening the Rooms tab fires several API calls at
/// once (rooms + filters), so this is the normal case, not an edge one.
fn login_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Return a valid `(access_token, account_id)`, signing in if the cache is empty
/// or the token is near expiry. Concurrent callers sign in at most once: the
/// first takes [`login_lock`] and signs in, the rest wait and then find the
/// session it cached.
pub(crate) async fn ensure_session() -> Result<(String, i64), String> {
    if signed_out() {
        return Err(SIGNED_OUT_ERROR.into());
    }
    if let Some(hit) = cached_valid() {
        return Ok(hit);
    }
    let _guard = login_lock().lock().await;
    // Another task may have signed in while we waited for the lock, or the
    // user logged out.
    if signed_out() {
        return Err(SIGNED_OUT_ERROR.into());
    }
    if let Some(hit) = cached_valid() {
        return Ok(hit);
    }

    let session = login().await?;
    // Logged out while that sign-in was under way: don't keep it.
    if signed_out() {
        return Err(SIGNED_OUT_ERROR.into());
    }
    let out = (session.access_token.clone(), session.account_id);
    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some(session);
    }
    Ok(out)
}

// ─── Authenticated GET ─────────────────────────────────────────────────────

/// GET an API path as JSON, signing in as needed and retrying once on a 401.
pub(crate) async fn api_get(path: &str) -> Result<Value, String> {
    api_request(reqwest::Method::GET, path).await
}

/// [`api_get`] with any method. The writes used here (PUT/DELETE on a room's
/// cheer and favorite) take no body and, unlike the game's matchmaking calls,
/// need no request signature.
async fn api_request(method: reqwest::Method, path: &str) -> Result<Value, String> {
    for attempt in 0..2 {
        let (token, _account) = ensure_session().await?;
        let mut req = http_client_besthttp()
            .request(method.clone(), format!("{BASE}{path}"))
            .bearer_auth(&token);
        // An explicit empty body, so a PUT goes out with Content-Length: 0
        // (what was tested) rather than none.
        if method != reqwest::Method::GET {
            req = req.body("");
        }
        let req = req.timeout(Duration::from_secs(20));
        let resp = send_with_retry(req).await?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            // Token rejected: drop it and sign in fresh once.
            forget_session();
            continue;
        }
        if !status.is_success() {
            return Err(format!("Stella API error: HTTP {}", status.as_u16()));
        }
        let body = read_capped(resp, MAX_API_BYTES).await?;
        return serde_json::from_slice(&body).map_err(|e| e.to_string());
    }
    Err("Stella rejected the session twice.".into())
}

/// Send a request, trying again (twice, briefly spaced) when it fails before
/// any answer arrives: a pooled connection Stella's edge had already closed,
/// or a blip in the network. Every request through here is safe to repeat
/// (reads, and PUT/DELETE of a cheer or favorite). A timeout isn't retried —
/// that has already waited its full 20 seconds.
async fn send_with_retry(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let mut last = None;
    for attempt in 0..3u64 {
        let Some(this) = req.try_clone() else {
            return req.send().await.map_err(|e| unreachable_message(&e));
        };
        match this.send().await {
            Ok(resp) => return Ok(resp),
            Err(e) if !e.is_timeout() && attempt < 2 => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))).await;
            }
            Err(e) => return Err(unreachable_message(&e)),
        }
    }
    Err(last.map(|e| unreachable_message(&e)).unwrap_or_else(|| "Couldn't reach Stella.".into()))
}

/// "Couldn't reach Stella (<cause>)." reqwest's own text is only "error sending
/// request for url (…)"; the reason — refused, reset, closed early, DNS — is
/// at the bottom of its source chain.
pub(crate) fn unreachable_message(e: &reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    let reason = if e.is_timeout() { "timed out".to_string() } else { cause.to_string() };
    format!("Couldn't reach Stella ({reason}). Check your internet connection and try again.")
}

/// `account_id` of the signed-in user (used for "my rooms" etc.).
pub async fn my_account_id() -> Result<i64, String> {
    ensure_session().await.map(|(_, id)| id)
}

// ─── Reshaping ──────────────────────────────────────────────────────────────

/// Absolute image URL for a Rec Room `ImageName`, at `width` px. Stella serves
/// these openly (no User-Agent or token needed), so the webview loads them
/// straight from this URL.
fn img_url(name: &str, width: u32) -> String {
    let name = name.trim();
    if name.is_empty() || name == "DefaultProfileImage" {
        return String::new();
    }
    format!("{IMG_BASE}/{name}?width={width}")
}

fn i64_at(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn str_at<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// Map of accountId → (username, displayName, avatarUrl) for creator attribution.
pub(crate) type People = std::collections::HashMap<i64, Value>;

/// Look up a set of accounts in one `/account/bulk` call.
pub(crate) async fn resolve_accounts(ids: &[i64]) -> People {
    let mut map = People::new();
    if ids.is_empty() {
        return map;
    }
    let query = ids.iter().map(|id| format!("id={id}")).collect::<Vec<_>>().join("&");
    let Ok(arr) = api_get(&format!("/account/bulk?{query}")).await else {
        return map;
    };
    if let Some(rows) = arr.as_array() {
        for p in rows {
            let id = i64_at(p, "accountId");
            if id != 0 {
                map.insert(id, p.clone());
            }
        }
    }
    map
}

/// Reshape one Stella room into the frontend's room row, flattening `Stats` and
/// attaching an absolute thumbnail and (when resolved) its creator.
fn room_row(r: &Value, creators: &People) -> Value {
    let stats = r.get("Stats").cloned().unwrap_or(Value::Null);
    let stat = |k: &str| stats.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let creator_id = i64_at(r, "CreatorAccountId");
    let creator = creators.get(&creator_id);
    let image_name = str_at(r, "ImageName");

    json!({
        "RoomId": i64_at(r, "RoomId"),
        "Name": str_at(r, "Name"),
        "Description": str_at(r, "Description"),
        "ImageName": image_name,
        "ThumbUrl": img_url(image_name, 512),
        "CreatorPlayerId": creator_id,
        "CreatorUsername": creator.map(|c| str_at(c, "username")).filter(|u| !u.is_empty()).unwrap_or("Unknown"),
        "CreatorAvatarUrl": creator.map(|c| img_url(str_at(c, "profileImage"), 128)).unwrap_or_default(),
        "CheerCount": stat("CheerCount"),
        "FavoriteCount": stat("FavoriteCount"),
        "VisitCount": stat("VisitCount"),
        "ActivePlayerCount": stat("VisitorCount"),
        "CreatedAt": str_at(r, "CreatedAt"),
        "Accessibility": r.get("Accessibility").cloned().unwrap_or(Value::Null),
    })
}

/// Reshape one Stella account into the frontend's people row.
pub(crate) fn person_row(p: &Value) -> Value {
    let image = str_at(p, "profileImage");
    json!({
        "id": i64_at(p, "accountId"),
        "userName": str_at(p, "username"),
        "displayName": str_at(p, "displayName"),
        "bio": "",
        "profileImage": image,
        "AvatarUrl": img_url(image, 256),
        // Stella has no public presence for arbitrary players (only friends,
        // via a separate call), so leave it unknown rather than assert offline.
        "isOnline": Value::Null,
    })
}

/// Pull the room array out of whichever envelope an endpoint used: `hot` returns
/// `{ Results: [...] }`, `search` returns `{ TotalResults, Results }`, and the
/// `ownedby`/`createdby` lists return a bare array.
fn rooms_of(v: &Value) -> (Vec<Value>, Option<i64>) {
    if let Some(arr) = v.as_array() {
        return (arr.clone(), None);
    }
    let results = v.get("Results").and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let total = v.get("TotalResults").and_then(|t| t.as_i64());
    (results, total)
}

// ─── Public API (mirrors the server.rs command shapes) ───────────────────────

/// The full `hot` list: every public room (~3,900), as one 5.5 MB answer that
/// Stella takes about 7 seconds to build, whatever is asked for (`skip`/`take`
/// are ignored, and a `?tag=` list takes as long) — measured 2026-10-02. So it
/// is fetched once and everything else is done here: paging, sorting, and the
/// tag filters (see [`filter_tag`]), which matched Stella's own `?tag=` lists
/// room for room and in the same order.
///
/// Nobody should sit through those 7 seconds twice. The list is fetched in the
/// background as soon as the player signs in ([`prefetch_rooms`]); once it is
/// [`HOT_FRESH`] old it is still served at once while a fresh copy is fetched
/// behind it; and only one fetch is ever in flight.
struct HotCache {
    rooms: Vec<Value>,
    at: std::time::Instant,
}
static HOT_CACHE: Mutex<Option<HotCache>> = Mutex::new(None);
const HOT_FRESH: Duration = Duration::from_secs(180);
static HOT_REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn hot_fetch_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The cached list and whether it is still fresh.
fn hot_cached() -> Option<(Vec<Value>, bool)> {
    let guard = HOT_CACHE.lock().ok()?;
    let c = guard.as_ref()?;
    Some((c.rooms.clone(), c.at.elapsed() < HOT_FRESH))
}

/// Download the list and keep it. One at a time: a caller that waited for
/// another's download uses that instead of starting its own.
async fn fetch_hot(force: bool) -> Result<Vec<Value>, String> {
    let _guard = hot_fetch_lock().lock().await;
    if !force {
        if let Some((rooms, true)) = hot_cached() {
            return Ok(rooms);
        }
    }
    let data = api_get("/roomserver/rooms/hot?skip=0&take=1000").await?;
    let (rows, _) = rooms_of(&data);
    // Logged out meanwhile: don't keep it.
    if !signed_out() {
        if let Ok(mut guard) = HOT_CACHE.lock() {
            *guard = Some(HotCache { rooms: rows.clone(), at: std::time::Instant::now() });
        }
    }
    Ok(rows)
}

/// Fetch a fresh copy in the background, unless one is already coming.
fn refresh_hot_in_background() {
    use std::sync::atomic::Ordering;
    if HOT_REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let _ = fetch_hot(true).await;
        HOT_REFRESHING.store(false, Ordering::SeqCst);
    });
}

/// Start downloading the room list now, so Rooms opens without the wait.
pub fn prefetch_rooms() {
    if signed_out() || hot_cached().is_some_and(|(_, fresh)| fresh) {
        return;
    }
    refresh_hot_in_background();
}

/// The whole list: from the cache (refreshed behind it once stale), or
/// downloaded now if there is none yet.
async fn hot_all() -> Result<Vec<Value>, String> {
    match hot_cached() {
        Some((rooms, fresh)) => {
            if !fresh {
                refresh_hot_in_background();
            }
            Ok(rooms)
        }
        None => fetch_hot(false).await,
    }
}

/// Stella's room tags, applied here as its `?tag=` does: "rro" is the official
/// rooms (`IsRRO`), "community" every other room, and any other tag a room
/// whose `Tags` list holds it. Checked against Stella's own lists for "pvp",
/// "rro" and "community": the same rooms, in the same order.
fn filter_tag(rooms: Vec<Value>, tag: &str) -> Vec<Value> {
    let tag = tag.trim();
    if tag.is_empty() {
        return rooms;
    }
    let rro = |r: &Value| r.get("IsRRO").and_then(Value::as_bool) == Some(true);
    rooms
        .into_iter()
        .filter(|r| match tag.to_ascii_lowercase().as_str() {
            "rro" => rro(r),
            "community" => !rro(r),
            _ => r
                .get("Tags")
                .and_then(Value::as_array)
                .is_some_and(|tags| tags.iter().any(|t| str_at(t, "Tag").eq_ignore_ascii_case(tag))),
        })
        .collect()
}

/// The `hot` list for `tag` ("" for all).
async fn hot_rooms(tag: &str) -> Result<Vec<Value>, String> {
    Ok(filter_tag(hot_all().await?, tag))
}

/// Rooms list: `query` → search (server-paged), else `tag`/none → hot (paged
/// locally from the cached full list, sorted by `sort_by`; see [`sort_rooms`]).
pub async fn fetch_rooms(app: &tauri::AppHandle, skip: i64, take: i64, query: &str, tag: &str, sort_by: i64) -> Value {
    let query = query.trim();
    let tag = tag.trim();

    // Search is the one endpoint that pages server-side and returns a real
    // total, so it is used as-is.
    if !query.is_empty() {
        let path = format!("/roomserver/rooms/search?query={}&skip={}&take={}", urlenc(query), skip, take);
        let data = match api_get(&path).await {
            Ok(v) => v,
            Err(e) => return json!({ "success": false, "error": e }),
        };
        let (rows, total) = rooms_of(&data);
        return finish_room_page(rows, skip, take, total).await;
    }

    // Hot (optionally tag-filtered): whole list cached, sorted and sliced
    // locally.
    let mut all = match hot_rooms(tag).await {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    sort_rooms(app, &mut all, sort_by).await;
    let total = all.len() as i64;
    let page: Vec<Value> = all.into_iter().skip(skip.max(0) as usize).take(take.max(1) as usize).collect();
    finish_room_page(page, skip, take, Some(total)).await
}

/// The Rooms tab's sort list, applied to the whole hot list (Stella's API takes
/// no sort): 0 Hot (Stella's own order), 1 Newest, 2 Most Visited, 3 Most
/// Cheered, 4 Most Favorited, 5 Most Players — which also drops every room
/// with nobody in it, so the list is only where people are. Ties keep Hot's
/// order.
async fn sort_rooms(app: &tauri::AppHandle, rooms: &mut Vec<Value>, sort_by: i64) {
    let stat = |r: &Value, k: &str| r.get("Stats").and_then(|s| s.get(k)).and_then(Value::as_i64).unwrap_or(0);
    match sort_by {
        // ISO-8601 timestamps sort as text.
        1 => rooms.sort_by(|a, b| str_at(b, "CreatedAt").cmp(str_at(a, "CreatedAt"))),
        2 => rooms.sort_by_key(|r| std::cmp::Reverse(stat(r, "VisitCount"))),
        3 => rooms.sort_by_key(|r| std::cmp::Reverse(stat(r, "CheerCount"))),
        4 => rooms.sort_by_key(|r| std::cmp::Reverse(stat(r, "FavoriteCount"))),
        5 => {
            let live = live_by_room(app, rooms).await;
            rooms.retain(|r| live.contains_key(&i64_at(r, "RoomId")));
            rooms.sort_by_key(|r| std::cmp::Reverse(live.get(&i64_at(r, "RoomId")).copied().unwrap_or(0)));
        }
        _ => {}
    }
}

/// Rooms from the top of Hot always checked for Most Players, besides those
/// the hub has seen players in; and the most that are ever checked at once.
const LIVE_TOP_ROOMS: usize = 12;
const LIVE_MAX_CHECKED: usize = 80;
/// Without the hub, how far down Hot is checked instead.
const LIVE_FALLBACK_ROOMS: usize = 120;

/// Players in each room now, for Most Players: the exact per-room counts of
/// public copies (they include hidden players, which the hub can't place),
/// plus the private copies the hub sees — what the cards' badges add up. Asking every room would be thousands of requests, so the hub picks
/// which to ask: every room it has seen anyone in — it sees all rooms at once,
/// for free — plus the top of Hot. While the hub can't help (just started, or
/// paused because the game is running), the top of Hot is asked instead, where
/// nearly everyone is. All through the same one-minute cache as the badges.
async fn live_by_room(app: &tauri::AppHandle, rooms: &[Value]) -> std::collections::HashMap<i64, usize> {
    let listed: std::collections::HashSet<i64> = rooms.iter().map(|r| i64_at(r, "RoomId")).collect();
    let mut ids: Vec<i64> = Vec::new();
    match crate::stella_hub::room_counts(app.clone()).filter(|c| !c.is_empty()) {
        Some(seen) => {
            // Busiest first, so the cap drops the quietest; only rooms in this
            // list (not dorms or unlisted rooms).
            let mut busy: Vec<(i64, usize)> = seen.into_iter().filter(|(id, _)| listed.contains(id)).collect();
            busy.sort_by_key(|&(_, n)| std::cmp::Reverse(n));
            ids.extend(busy.into_iter().map(|(id, _)| id));
            for r in rooms.iter().take(LIVE_TOP_ROOMS) {
                let id = i64_at(r, "RoomId");
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            ids.truncate(LIVE_MAX_CHECKED);
        }
        None => ids.extend(rooms.iter().take(LIVE_FALLBACK_ROOMS).map(|r| i64_at(r, "RoomId"))),
    }
    ids.retain(|&id| id != 0);

    let mut counts = std::collections::HashMap::new();
    for chunk in ids.chunks(20) {
        let got = futures_util::future::join_all(chunk.iter().map(|&id| async move {
            let n = match cached_room_players(id) {
                Some(n) => Some(n),
                None => fetch_room_players(id).await,
            };
            (id, n.unwrap_or(0))
        }))
        .await;
        for (id, n) in got {
            if n > 0 {
                counts.insert(id, n as usize);
            }
        }
    }
    // Plus the private copies, which the per-room list leaves out.
    if let Some(private) = crate::stella_hub::private_counts() {
        for (id, n) in private {
            if listed.contains(&id) {
                *counts.entry(id).or_insert(0) += n;
            }
        }
    }
    counts
}

/// Resolve the page's creators and shape the rows. `total` is `Some` when known
/// exactly (hot's full length, or search's reported total).
async fn finish_room_page(rows: Vec<Value>, skip: i64, take: i64, total: Option<i64>) -> Value {
    let ids: Vec<i64> = {
        let mut set = std::collections::BTreeSet::new();
        for r in &rows {
            let id = i64_at(r, "CreatorAccountId");
            if id != 0 {
                set.insert(id);
            }
        }
        set.into_iter().collect()
    };
    let creators = resolve_accounts(&ids).await;
    let mut shaped: Vec<Value> = rows.iter().map(|r| room_row(r, &creators)).collect();
    attach_live_players(&mut shaped).await;

    let (total_results, total_known) = match total {
        Some(t) => (t, true),
        None => {
            let shown = skip + shaped.len() as i64;
            if (shaped.len() as i64) < take { (shown, true) } else { (shown + 1, false) }
        }
    };
    json!({
        "success": true,
        "data": { "Results": shaped, "TotalResults": total_results, "TotalKnown": total_known }
    })
}

// ─── Live player counts ─────────────────────────────────────────────────────
//
// Stella publishes no players-online total, and every room's `VisitorCount`
// stat is 0. What it does answer is `/match/room/{id}/instances`: each running
// copy of a room with the ids of the players in it. Summed, that is the room's
// live count — one request per room, so it is fetched for the rooms on screen
// only, all at once, and kept briefly so paging back and forth doesn't ask again.

const LIVE_TTL: Duration = Duration::from_secs(60);
/// More rooms than this in one list (a creator's whole catalogue) aren't
/// counted: that would be a request per room for rooms nobody is looking at.
const LIVE_MAX_ROOMS: usize = 24;

/// Each room's listed player ids, briefly, so the ghost filter in
/// [`count_real`] is applied to whatever the hub knows at the time of asking.
type RoomPlayers = std::collections::HashMap<i64, (Vec<i64>, std::time::Instant)>;
static LIVE_CACHE: Mutex<Option<RoomPlayers>> = Mutex::new(None);

/// How many of a room's listed players are really there.
///
/// Stella's instance lists keep "ghosts": players who left without signing
/// off (measured 2026-10-02: a Paintball instance created the day before still
/// listed three players the hub never heard from, which is why Paintball kept
/// showing 3 at any hour). Every player in the game, hidden ones included, is
/// re-sent on the hub every 20–45 s, so once the hub has listened long enough
/// a listed player it hasn't heard from is a ghost. Until then — or while it is
/// paused for the game — the list is taken as it is.
fn count_real(ids: &[i64]) -> i64 {
    crate::stella_hub::heard_among(ids).unwrap_or(ids.len()) as i64
}

/// Players in `room_id` right now, straight from Stella (and remembered).
async fn fetch_room_players(room_id: i64) -> Option<i64> {
    let data = api_get(&format!("/match/room/{room_id}/instances")).await.ok()?;
    let ids: Vec<i64> = data
        .as_array()?
        .iter()
        .flat_map(|i| i.get("playerIds").and_then(|p| p.as_array()).cloned().unwrap_or_default())
        .filter_map(|p| p.as_i64())
        .collect();
    let players = count_real(&ids);
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        let map = guard.get_or_insert_with(Default::default);
        // Forget lapsed entries so the map holds only what was recently shown.
        map.retain(|_, (_, at)| at.elapsed() < LIVE_TTL);
        map.insert(room_id, (ids, std::time::Instant::now()));
    }
    Some(players)
}

fn cached_room_players(room_id: i64) -> Option<i64> {
    let guard = LIVE_CACHE.lock().ok()?;
    let (ids, at) = guard.as_ref()?.get(&room_id)?;
    (at.elapsed() < LIVE_TTL).then(|| count_real(ids))
}

/// Set `LivePlayers` on each shaped room row: a number, or null if it couldn't
/// be read (the UI then shows nothing rather than a misleading 0).
async fn attach_live_players(rows: &mut [Value]) {
    if rows.is_empty() || rows.len() > LIVE_MAX_ROOMS {
        return;
    }
    let counts = futures_util::future::join_all(rows.iter().map(|r| {
        let id = i64_at(r, "RoomId");
        async move {
            match cached_room_players(id) {
                Some(n) => Some(n),
                None if id != 0 => fetch_room_players(id).await,
                None => None,
            }
        }
    }))
    .await;
    // Private copies, which that list leaves out, from the live hub.
    let private = crate::stella_hub::private_counts();
    for (row, count) in rows.iter_mut().zip(counts) {
        row["LivePlayers"] = json!(count);
        row["PrivatePlayers"] = match &private {
            Some(p) => json!(p.get(&i64_at(row, "RoomId")).copied().unwrap_or(0)),
            None => Value::Null,
        };
    }
}

/// A room's live player counts, fetched fresh — for the room page, which may
/// sit open a while after the list it came from was loaded:
/// `{ players, private }`, `players` being the public copies (exact, null if
/// it couldn't be read) and `private` the private ones the hub can place (null
/// while it isn't connected).
#[tauri::command]
pub async fn stella_room_players(room_id: i64) -> Value {
    let players = fetch_room_players(room_id).await;
    let private = crate::stella_hub::private_counts().map(|p| p.get(&room_id).copied().unwrap_or(0));
    json!({ "players": players, "private": private })
}

/// People search. Stella's `/account/search` takes the text as `name` (a
/// `query` parameter is accepted and silently matches nothing), ignores
/// `skip`/`take`, and returns its best 50 matches with an exact username first.
/// So the whole answer is one page of at most 50, sliced here. With no text
/// there is no browse-all endpoint, so an empty query returns an empty page.
///
/// This is also how a profile opened by name (a photo's uploader, a tagged
/// player) finds the account behind it.
pub async fn fetch_people(skip: i64, take: i64, query: &str) -> Value {
    let query = query.trim();
    if query.is_empty() {
        return json!({
            "success": true,
            "data": { "Results": [], "TotalResults": 0, "TotalKnown": true }
        });
    }

    let path = format!("/account/search?name={}", urlenc(query));
    let data = match api_get(&path).await {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    let rows = data.as_array().cloned().unwrap_or_default();
    let total = rows.len() as i64;
    let shaped: Vec<Value> = rows
        .iter()
        .skip(skip.max(0) as usize)
        .take(take.max(1) as usize)
        .map(person_row)
        .collect();

    json!({
        "success": true,
        "data": { "Results": shaped, "TotalResults": total, "TotalKnown": true }
    })
}

/// Rooms a given account owns.
pub async fn fetch_user_rooms(user_id: &str, skip: i64, take: i64) -> Value {
    let path = format!("/roomserver/rooms/ownedby/{}?skip={}&take={}", urlenc(user_id), skip, take);
    let data = match api_get(&path).await {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    let (rows, total) = rooms_of(&data);
    let ids: Vec<i64> = rows.iter().map(|r| i64_at(r, "CreatorAccountId")).filter(|&i| i != 0).collect();
    let creators = resolve_accounts(&ids).await;
    let mut shaped: Vec<Value> = rows.iter().map(|r| room_row(r, &creators)).collect();
    attach_live_players(&mut shaped).await;
    let total_results = total.unwrap_or(skip + shaped.len() as i64);
    json!({
        "success": true,
        "data": { "Results": shaped, "TotalResults": total_results, "TotalKnown": true }
    })
}

/// Reshape one Stella photo into the feed card's shape, with its uploader
/// resolved and an absolute image URL.
fn photo_row(p: &Value, creators: &People) -> Value {
    let image = str_at(p, "ImageName");
    let creator_id = i64_at(p, "PlayerId");
    let creator = creators.get(&creator_id);
    json!({
        "Id": i64_at(p, "Id"),
        "ImageName": image,
        "ThumbUrl": img_url(image, 1024),
        "RoomId": i64_at(p, "RoomId"),
        "RoomName": "",
        "CheerCount": i64_at(p, "CheerCount"),
        "CommentCount": i64_at(p, "CommentCount"),
        "Description": p.get("Description").cloned().unwrap_or(Value::Null),
        "CreatedAt": str_at(p, "CreatedAt"),
        "CreatorPlayerId": creator_id,
        "CreatorUsername": creator.map(|c| str_at(c, "username")).unwrap_or(""),
        "CreatorDisplayName": creator.map(|c| str_at(c, "displayName")).unwrap_or(""),
        "CreatorAvatarUrl": creator.map(|c| img_url(str_at(c, "profileImage"), 128)).unwrap_or_default(),
    })
}

/// Photos taken in a room. Unlike Radium/Vanilla (which scan a global feed),
/// Stella has a direct per-room endpoint.
pub async fn fetch_room_photos(room_id: &str, skip: i64, take: i64) -> Value {
    let path = format!("/api/images/v4/room/{}?skip={}&take={}", urlenc(room_id), skip, take);
    let data = match api_get(&path).await {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    let rows = data.as_array().cloned().unwrap_or_default();
    let ids: Vec<i64> = {
        let mut set = std::collections::BTreeSet::new();
        for p in &rows {
            let id = i64_at(p, "PlayerId");
            if id != 0 {
                set.insert(id);
            }
        }
        set.into_iter().collect()
    };
    let creators = resolve_accounts(&ids).await;
    let shaped: Vec<Value> = rows.iter().map(|p| photo_row(p, &creators)).collect();
    let shown = skip + shaped.len() as i64;
    let (total, known) = if (shaped.len() as i64) < take { (shown, true) } else { (shown + 1, false) };
    json!({
        "success": true,
        "data": { "Results": shaped, "TotalResults": total, "TotalKnown": known }
    })
}

/// Photos a given account has taken.
pub async fn fetch_user_photos(user_id: &str, skip: i64, take: i64) -> Value {
    let path = format!("/api/images/v5/player/{}?skip={}&take={}", urlenc(user_id), skip, take);
    let data = match api_get(&path).await {
        Ok(v) => v,
        Err(e) => return json!({ "success": false, "error": e }),
    };
    let rows = data.as_array().cloned().unwrap_or_default();
    let ids: Vec<i64> = rows.iter().map(|p| i64_at(p, "PlayerId")).filter(|&i| i != 0).collect();
    let creators = resolve_accounts(&ids).await;
    let shaped: Vec<Value> = rows.iter().map(|p| photo_row(p, &creators)).collect();
    let shown = skip + shaped.len() as i64;
    let (total, known) = if (shaped.len() as i64) < take { (shown, true) } else { (shown + 1, false) };
    json!({
        "success": true,
        "data": { "Results": shaped, "TotalResults": total, "TotalKnown": known }
    })
}

/// Profile details for one account: bio, subscriber count, avatar and banner.
///
/// Fills the person detail view. Friends and visit counts aren't exposed for an
/// arbitrary account on Stella (friends is only the signed-in user's own list),
/// so those come back empty and the UI hides them — like Vanilla.
pub async fn user_details(account_id: i64) -> Value {
    // Core record (display name, images). A system/placeholder account id (e.g.
    // 1, the owner of the official rooms) returns an empty array here.
    let account = api_get(&format!("/account/bulk?id={account_id}"))
        .await
        .ok()
        .and_then(|v| v.as_array().and_then(|a| a.first().cloned()));
    let (username, display, avatar, banner) = match account.as_ref() {
        Some(a) => (
            str_at(a, "username").to_string(),
            str_at(a, "displayName").to_string(),
            img_url(str_at(a, "profileImage"), 256),
            {
                let b = str_at(a, "bannerImage");
                if b.is_empty() { String::new() } else { img_url(b, 1000) }
            },
        ),
        None => (String::new(), String::new(), String::new(), String::new()),
    };

    let bio = api_get(&format!("/account/{account_id}/bio"))
        .await
        .ok()
        .map(|v| str_at(&v, "bio").to_string())
        .unwrap_or_default();

    // Reputation carries the subscriber count. It answers 500 for some
    // system accounts, so a failure just leaves the count blank.
    let subscribers = api_get(&format!("/api/playerReputation/v2/bulk?id={account_id}"))
        .await
        .ok()
        .and_then(|v| v.as_array().and_then(|a| a.first().cloned()))
        .map(|r| i64_at(&r, "SubscriberCount"))
        .map(|n| n.to_string())
        .unwrap_or_default();

    json!({
        "success": true,
        "friends": "",
        "subscribers": subscribers,
        "visits": "",
        "status": "",
        "bio": bio,
        "banner": banner,
        "avatar": avatar,
        "userName": username,
        "displayName": display,
    })
}

/// The account whose username is exactly `name` (any case), via people search.
pub async fn account_id_for_name(name: &str) -> Option<i64> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let data = api_get(&format!("/account/search?name={}", urlenc(name))).await.ok()?;
    data.as_array()?
        .iter()
        .find(|p| str_at(p, "username").eq_ignore_ascii_case(name))
        .map(|p| i64_at(p, "accountId"))
        .filter(|&id| id != 0)
}

// ─── Room cheer and favorite ────────────────────────────────────────────────
//
// `/roomserver/rooms/{id}/interactionby/me` answers `{Cheered, Favorited,
// LastVisitedAt}` for the signed-in player; PUT on `…/me/cheer` or
// `…/me/favorite` sets one and DELETE clears it, each answering the new state
// (POST is a 405). Measured on RecCenter on 2026-10-01, with the user's
// go-ahead: the room's counts moved by one and back.

fn interaction_of(v: &Value) -> Value {
    json!({
        "cheered": v.get("Cheered").and_then(Value::as_bool).unwrap_or(false),
        "favorited": v.get("Favorited").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// Whether the signed-in player has cheered and favorited a room.
#[tauri::command]
pub async fn stella_room_interaction(room_id: i64) -> Result<Value, String> {
    let v = api_get(&format!("/roomserver/rooms/{room_id}/interactionby/me")).await?;
    Ok(interaction_of(&v))
}

/// Cheer or favorite a room (`on`), or take it back. `kind` is "cheer" or
/// "favorite". Answers the room's new `{ cheered, favorited }`.
#[tauri::command]
pub async fn stella_set_room_interaction(room_id: i64, kind: String, on: bool) -> Result<Value, String> {
    if kind != "cheer" && kind != "favorite" {
        return Err(format!("Unknown room interaction: {kind}"));
    }
    let method = if on { reqwest::Method::PUT } else { reqwest::Method::DELETE };
    let v = api_request(method, &format!("/roomserver/rooms/{room_id}/interactionby/me/{kind}")).await?;
    Ok(interaction_of(&v))
}

/// Room tag/category filters.
pub async fn fetch_filters() -> Value {
    match api_get("/api/rooms/v1/filters").await {
        Ok(data) => json!({ "success": true, "data": data }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Minimal percent-encoding for a query-string value.
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {

    #[test]
    fn tag_filter_matches_stellas() {
        let rooms = vec![
            json!({ "RoomId": 9, "IsRRO": true, "Tags": [{ "Tag": "recroomoriginal", "Type": 2 }] }),
            json!({ "RoomId": 100, "IsRRO": false, "Tags": [{ "Tag": "pvp", "Type": 0 }] }),
            json!({ "RoomId": 101, "IsRRO": false, "Tags": [{ "Tag": "PVP", "Type": 0 }, { "Tag": "quest", "Type": 0 }] }),
            json!({ "RoomId": 102, "IsRRO": false }),
        ];
        let ids = |tag: &str| filter_tag(rooms.clone(), tag).iter().map(|r| i64_at(r, "RoomId")).collect::<Vec<_>>();
        assert_eq!(ids(""), vec![9, 100, 101, 102]);
        assert_eq!(ids("rro"), vec![9]);
        assert_eq!(ids("community"), vec![100, 101, 102]);
        assert_eq!(ids("pvp"), vec![100, 101]);
        assert_eq!(ids("quest"), vec![101]);
        assert!(ids("horror").is_empty());
    }

    #[tokio::test]
    async fn unreachable_retries_then_names_the_cause() {
        // Port 1 on loopback: nothing listens, so every attempt is refused.
        let req = reqwest::Client::new().get("http://127.0.0.1:1/").timeout(Duration::from_secs(5));
        let started = std::time::Instant::now();
        let err = send_with_retry(req).await.unwrap_err();
        assert!(err.starts_with("Couldn't reach Stella ("), "{err}");
        assert!(!err.contains("error sending request"), "{err}");
        // Three attempts, with 0.4 s and 0.8 s between them.
        assert!(started.elapsed() >= Duration::from_millis(1100), "{:?}", started.elapsed());
    }
    use super::*;

    #[test]
    fn img_url_handles_empty_and_default() {
        assert_eq!(img_url("", 512), "");
        assert_eq!(img_url("DefaultProfileImage", 256), "");
        assert_eq!(img_url("RoomThumbnail-reccenter", 512), "https://api.stellaonline.org/img/RoomThumbnail-reccenter?width=512");
    }

    #[test]
    fn room_row_flattens_stats_and_builds_thumb() {
        let r = json!({
            "RoomId": 9, "Name": "RecCenter", "Description": "hi",
            "ImageName": "RoomThumbnail-reccenter", "CreatorAccountId": 1,
            "Stats": { "CheerCount": 313, "FavoriteCount": 1698, "VisitCount": 491859, "VisitorCount": 4 }
        });
        let out = room_row(&r, &People::new());
        assert_eq!(out["RoomId"], 9);
        assert_eq!(out["CheerCount"], 313);
        assert_eq!(out["VisitCount"], 491859);
        assert_eq!(out["ActivePlayerCount"], 4);
        assert_eq!(out["ThumbUrl"], "https://api.stellaonline.org/img/RoomThumbnail-reccenter?width=512");
        assert_eq!(out["CreatorUsername"], "Unknown");
    }

    #[test]
    fn person_row_maps_fields() {
        let p = json!({ "accountId": 70541, "username": "abod124", "displayName": "abod124", "profileImage": "ProfileThumbnail-70541-x" });
        let out = person_row(&p);
        assert_eq!(out["id"], 70541);
        assert_eq!(out["userName"], "abod124");
        assert_eq!(out["AvatarUrl"], "https://api.stellaonline.org/img/ProfileThumbnail-70541-x?width=256");
        assert!(out["isOnline"].is_null());
    }

    #[test]
    fn jwt_expiry_reads_exp() {
        // {"exp":1790873724} base64url, no padding
        let payload = base64url_encode(br#"{"exp":1790873724}"#);
        let token = format!("hdr.{payload}.sig");
        assert_eq!(jwt_expiry(&token), 1790873724);
        assert_eq!(jwt_expiry("not-a-jwt"), 0);
    }

    fn base64url_encode(bytes: &[u8]) -> String {
        const C: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            let take = chunk.len() + 1;
            for i in 0..take {
                out.push(C[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
            }
        }
        out
    }
}
