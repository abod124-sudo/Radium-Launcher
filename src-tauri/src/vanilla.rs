//! Vanilla (`vanillarec.net`) network support.
//!
//! Everything in here talks to `https://api.vanillarec.net` and then reshapes
//! the response into the envelope the frontend already consumes for Radium
//! (`{ Results: [...], TotalResults: n }` with PascalCase room fields and
//! camelCase people fields). Keeping the translation on this side means
//! `loadRooms()` / `loadPeople()` and the detail views stay network-agnostic.
//!
//! ## Two ways in, and why both exist
//!
//! `api.vanillarec.net` sits behind a Cloudflare rule that is an *allowlist of
//! paths*, not a header check: `/ws/*` and `/images/*` answer any client, while
//! everything else — `/api/website/*`, and even `/` — is blocked outright for
//! anything that isn't a browser. Measured 2026-09-07: a request carrying a
//! perfect `Referer` and `Origin` is refused just the same, so no combination
//! of headers opens it. `/ws/` is exempt because the game client uses it.
//!
//! So rooms and players come from the two bulk `/ws` endpoints, which hand back
//! the whole public set in one response and are cached here (see
//! [`rooms_snapshot`] and [`players_snapshot`]). Searching, sorting, paging and
//! the tag rail are then exact and local, instead of guesses layered over an
//! API with no `skip`, no sort parameter and no totals.
//!
//! Photos have no `/ws` equivalent, so they still go through the site's own
//! `vanillarec.net/api.php?path=...` proxy ([`api_get_json`]) — as does the
//! per-page staff-badge lookup, because the bulk player dump carries
//! `Developer` but not the moderator or community-team flags.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;

use crate::server::{http, USER_AGENT};

/// Image, player-count and bulk-dump host. Those paths are served to any client.
const API_BASE: &str = "https://api.vanillarec.net";

/// Vanilla's website, which fronts the same API at `/api.php?path=...`.
const SITE_BASE: &str = "https://vanillarec.net";

/// Sent with proxied requests; the proxy only answers when it is present.
const SITE_REFERER: &str = "https://vanillarec.net/";

/// Vanilla rejects a proxied search of fewer than this many characters with a
/// 400 (`{"error":"query_too_short"}`), so we short-circuit instead. It applies
/// only to what still goes through the proxy — searching the cached room and
/// player sets is local and has no such floor.
const MIN_QUERY_LEN: usize = 2;

/// Ceiling on a single over-fetch, so deep paging can't ask for a huge page.
const MAX_FETCH_COUNT: i64 = 500;

/// `players?ids=` returns at most 20 rows per request, which bounds how many
/// ids one proxied lookup can resolve.
const PLAYERS_BATCH_CAP: i64 = 20;

/// GET a `/api/website/...` path as JSON through Vanilla's own site proxy.
///
/// The direct host is closed to non-browsers (see the module docs), but their
/// website reaches the same public data through `vanillarec.net/api.php`, which
/// accepts this launcher's own User-Agent as long as a Referer naming their
/// site is present.
async fn api_get_json(path: &str) -> Result<Value, String> {
    let url = format!("{}/api.php?path={}", SITE_BASE, urlencoding(path));

    let response = http()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header("User-Agent", USER_AGENT)
        .header("Referer", SITE_REFERER)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP error: {}", status));
    }

    let body = response.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        format!(
            "Unexpected response from Vanilla: {}",
            body.chars().take(120).collect::<String>()
        )
    })?;

    // The proxy reports its own refusals as a 200 carrying an error object, so
    // a successful status alone isn't enough to treat this as a result.
    if let Some(err) = value.get("error").and_then(|e| e.as_str()) {
        return Err(format!("Vanilla API: {}", err));
    }
    Ok(value)
}

/// Absolute URL for an image, from the relative `imageUrl` the API returns.
///
/// Used verbatim rather than rebuilt from `imageName`: some values already
/// carry a `?cachebuster` query (e.g. `/images/2_webso?1785023462696`), and
/// Vanilla's image endpoint has no `?width=` resizing to append anyway.
fn image_url(rel: Option<&str>) -> Option<String> {
    let rel = rel?.trim();
    if rel.is_empty() {
        return None;
    }
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return Some(rel.to_string());
    }
    Some(format!("{}{}", API_BASE, rel))
}

/// Absolute URL for an image named by a bulk row's `ImageName` or
/// `ProfileImageName`.
///
/// The bulk dumps carry the bare name where the website API carries a path, and
/// `/images/<name>` is exactly what that path expands to — checked against the
/// website's own `imageUrl` for the same rooms and players, which matched on
/// every row. Cachebusters are part of the name (`95_webso?1779688409249`) and
/// are kept.
///
/// Empty rather than a guessed default when there is no name: the frontend
/// substitutes each network's own placeholder.
fn image_for_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return String::new();
    }
    format!("{}/images/{}", API_BASE, name)
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

fn num_field(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// One page of results, plus what we honestly know about the size of the set.
struct Page {
    rows: Vec<Value>,
    total: i64,
    /// False when `total` is a running estimate rather than a real count.
    ///
    /// The proxied photo endpoints never report the size of a result set. When
    /// we have provably fetched all of it, `total` is exact and the UI can say
    /// "Page 2 of 5". When rows might still be waiting behind the API's row
    /// cap, any total we invent would be a lie that grows as the user pages, so
    /// the UI drops the "of N" rather than print a number that keeps moving.
    ///
    /// Rooms and people are served from the cached bulk sets, where the whole
    /// result set is in hand and the total is always exact.
    total_known: bool,
}

/// Slice `results` to one page.
///
/// `fetched_everything` says whether `results` is the complete set — the caller
/// knows this because it asked for more rows than came back.
fn paginate(results: Vec<Value>, skip: i64, take: i64, fetched_everything: bool) -> Page {
    let skip = skip.max(0) as usize;
    let take = take.max(1) as usize;
    let total_fetched = results.len();
    let rows: Vec<Value> = results.into_iter().skip(skip).take(take).collect();
    page_of(rows, skip, total_fetched, fetched_everything)
}

/// [`paginate`] for rows already cut out of a longer list, given how long that
/// list was. Split out so a caller holding a cached list can slice the dozen
/// rows it needs rather than copy all five hundred to hand them over.
fn page_of(rows: Vec<Value>, skip: usize, total_fetched: usize, fetched_everything: bool) -> Page {
    let shown = skip + rows.len();

    if fetched_everything {
        return Page { rows, total: total_fetched as i64, total_known: true };
    }

    // More rows may exist beyond what the API handed over. Report one page
    // further than we've shown so Next stays enabled, and flag it as a guess.
    let has_more = total_fetched > shown;
    Page {
        rows,
        total: if has_more { shown as i64 + 1 } else { shown as i64 },
        total_known: !has_more,
    }
}

/// How many rows to ask Vanilla for to be able to serve page `skip..skip+take`.
/// The `+ 1` is the probe row that reveals whether a next page exists.
fn fetch_count(skip: i64, take: i64) -> i64 {
    (skip.max(0) + take.max(1) + 1).min(MAX_FETCH_COUNT)
}

fn results_of(data: &Value) -> Vec<Value> {
    data.get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
}

// ─── Player count / reachability ──────────────────────────────────────────

/// Current online player count.
///
/// `/ws/getplrcount` answers with a bare integer (served as `application/json`,
/// but it is a scalar, not an object), so it is read as text and parsed.
pub async fn get_player_count() -> Value {
    let url = format!("{}/ws/getplrcount", API_BASE);

    let resp = match http()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .header("User-Agent", USER_AGENT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return json!({ "success": false, "error": e.to_string() }),
    };

    let status = resp.status();
    if !status.is_success() {
        return json!({ "success": false, "error": format!("HTTP error: {}", status) });
    }

    match resp.text().await {
        Ok(body) => match body.trim().parse::<i64>() {
            Ok(count) => json!({ "success": true, "count": count }),
            Err(_) => json!({
                "success": false,
                "error": format!("Unexpected player-count response: {}", body.trim())
            }),
        },
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// The URL used to test whether Vanilla is up.
///
/// Vanilla has no `/health`; the player-count endpoint is the cheapest thing
/// that proves the API is actually serving rather than just resolving.
pub fn ping_url() -> String {
    format!("{}/ws/getplrcount", API_BASE)
}

// ─── Bulk snapshots (`/ws/getrooms`, `/ws/getplayers`) ────────────────────
//
// Both endpoints return the entire set with no parameters — there is nothing to
// page, filter or sort server-side, and no ETag to revalidate against. They are
// large but compress well (measured 2026-09-07: rooms 11.4 MB → 1.0 MB brotli,
// players 51.6 MB → 5.3 MB), so each is downloaded at most once per TTL and
// every query afterwards is answered from memory.
//
// The two are cached independently and fetched only when something needs them:
// browsing rooms must not pay for the much larger player dump, so the Rooms tab
// resolves the handful of creators on the visible page through the proxy
// instead, and the player set is downloaded when the People tab first asks.

/// How long a downloaded set is served before it is fetched again.
const BULK_TTL: Duration = Duration::from_secs(10 * 60);

/// Timeout for a bulk download. Generous because these are megabytes, not the
/// kilobytes the other calls move.
const BULK_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to leave a failed background refresh alone before trying again.
const BULK_RETRY_DELAY: Duration = Duration::from_secs(60);

/// How long a resolved player record is reused before it is looked up again.
///
/// Longer than [`BULK_TTL`]: what this caches is a username, an avatar URL and
/// three staff flags, none of which change on the timescale a room's cheer
/// count does.
const CREATOR_TTL: Duration = Duration::from_secs(30 * 60);

/// Tag kind on a room. Vanilla publishes three, and only one is worth browsing:
///
/// * `0` — chosen by the room's creator (`fun`, `hangout`, `artistic`, `pvp`).
/// * `1` — applied by the server. `community` alone is on 6,697 of 7,042 rooms,
///   so offering it as a filter would be a button that changes nothing.
/// * `2` — curation (`rrstudio`, `recroomoriginal`), a handful of rooms each.
///
/// The rail is built from kind 0; clicking one still matches the tag by name
/// whatever kind carries it.
const TAG_KIND_CREATOR: u8 = 0;

/// How many tags the Filters rail shows.
const TAG_RAIL_LEN: usize = 14;

// ── Wire shapes ──
//
// Deserialized into narrow structs rather than `Value`: serde drops the fields
// we don't name without allocating them, which is what keeps a 51 MB response
// from becoming a 51 MB tree of `Value`s. Every field is optional so one odd
// row can't fail the whole parse.

#[derive(Deserialize)]
struct RawRoomRecord {
    #[serde(rename = "Room")]
    room: Option<RawRoom>,
    /// Live aggregate. Zero on most rooms (4,161 of 7,042), so it cannot be
    /// used on its own — see [`RoomRow::from_raw`].
    #[serde(rename = "CheerCount", default)]
    cheer_count: Option<i64>,
    #[serde(rename = "FavoriteCount", default)]
    favorite_count: Option<i64>,
    /// The only place a visit count appears; the inner room has none.
    #[serde(rename = "VisitCount", default)]
    visit_count: Option<i64>,
    #[serde(rename = "Tags", default)]
    tags: Option<Vec<RawTag>>,
}

#[derive(Deserialize)]
struct RawTag {
    #[serde(rename = "Tag", default)]
    tag: Option<String>,
    #[serde(rename = "Type", default)]
    kind: Option<u8>,
}

#[derive(Deserialize)]
struct RawRoom {
    #[serde(rename = "RoomId", default)]
    room_id: Option<i64>,
    #[serde(rename = "Name", default)]
    name: Option<String>,
    #[serde(rename = "Description", default)]
    description: Option<String>,
    #[serde(rename = "ImageName", default)]
    image_name: Option<String>,
    #[serde(rename = "CreatorPlayerId", default)]
    creator_player_id: Option<i64>,
    #[serde(rename = "CreatedAt", default)]
    created_at: Option<String>,
    /// Denormalized counter kept on the room itself. This is what the website
    /// displays; see [`RoomRow::from_raw`].
    #[serde(rename = "CheerCount", default)]
    cheer_count: Option<i64>,
    #[serde(rename = "FavoriteCount", default)]
    favorite_count: Option<i64>,
}

#[derive(Deserialize)]
struct RawPlayer {
    #[serde(rename = "Id", default)]
    id: Option<i64>,
    #[serde(rename = "Username", default)]
    username: Option<String>,
    #[serde(rename = "DisplayName", default)]
    display_name: Option<String>,
    #[serde(rename = "Bio", default)]
    bio: Option<String>,
    #[serde(rename = "ProfileImageName", default)]
    profile_image_name: Option<String>,
    #[serde(rename = "Developer", default)]
    developer: Option<bool>,
    #[serde(rename = "PlayerReputation", default)]
    reputation: Option<RawReputation>,
}

#[derive(Deserialize)]
struct RawReputation {
    /// The same number the website API calls `followerCount` — checked player
    /// by player against the proxied records, and identical on every one.
    #[serde(rename = "SubscriberCount", default)]
    subscriber_count: Option<i64>,
}

// ── Cached shapes ──

struct RoomTag {
    name: String,
    kind: u8,
}

struct RoomRow {
    id: i64,
    name: String,
    /// Lowercased once at load so a search doesn't re-fold 7,000 strings per
    /// keystroke.
    name_lc: String,
    description: String,
    description_lc: String,
    image_name: String,
    creator_id: i64,
    cheers: i64,
    favorites: i64,
    visits: i64,
    created_at: String,
    tags: Vec<RoomTag>,
}

impl RoomRow {
    fn from_raw(raw: RawRoomRecord) -> Option<RoomRow> {
        let room = raw.room?;
        let id = room.room_id?;

        let name = room.name.unwrap_or_default();
        let description = room.description.unwrap_or_default();

        // Cheers and favourites appear twice and disagree. Compared against the
        // website's own numbers for 100 rooms: the room's own counter matched
        // 99 times and the outer aggregate 19, but the larger of the two
        // matched all 100 — the aggregate reads 0 on cloned rooms, and the
        // counter lags by a few on very busy ones. So take whichever is ahead,
        // which is the number Vanilla's site is showing.
        let cheers = room.cheer_count.unwrap_or(0).max(raw.cheer_count.unwrap_or(0));
        let favorites = room
            .favorite_count
            .unwrap_or(0)
            .max(raw.favorite_count.unwrap_or(0));

        Some(RoomRow {
            id,
            name_lc: name.to_lowercase(),
            name,
            description_lc: description.to_lowercase(),
            description,
            image_name: room.image_name.unwrap_or_default(),
            creator_id: room.creator_player_id.unwrap_or(0),
            cheers,
            favorites,
            visits: raw.visit_count.unwrap_or(0),
            created_at: room.created_at.unwrap_or_default(),
            tags: raw
                .tags
                .unwrap_or_default()
                .into_iter()
                .filter_map(|t| {
                    let name = t.tag?.trim().to_lowercase();
                    if name.is_empty() {
                        return None;
                    }
                    Some(RoomTag { name, kind: t.kind.unwrap_or(TAG_KIND_CREATOR) })
                })
                .collect(),
        })
    }

    /// Whether the room's creator tagged it with `tag`.
    ///
    /// Creator tags only, matching how the rail is built. Several names exist
    /// as both kinds — `community` is a creator tag on 61 rooms and a
    /// server-applied one on 6,697 — so matching every kind would hand back
    /// 6,697 rooms for a button the rail justified with 61.
    fn has_tag(&self, tag: &str) -> bool {
        self.tags
            .iter()
            .any(|t| t.kind == TAG_KIND_CREATOR && t.name == tag)
    }

    /// Whether every word of a search appears somewhere in this room.
    ///
    /// Vanilla's own `rooms/search` matches names, descriptions and tags but
    /// takes a single word — a two-word query matches nothing there. Matching
    /// locally means each word can land in a different field, so "horror quest"
    /// finds a horror room tagged quest.
    fn matches(&self, terms: &[String]) -> bool {
        terms.iter().all(|term| {
            self.name_lc.contains(term.as_str())
                || self.description_lc.contains(term.as_str())
                || self.tags.iter().any(|t| t.name.contains(term.as_str()))
        })
    }
}

struct PlayerRow {
    id: i64,
    username: String,
    username_lc: String,
    display_name: String,
    display_name_lc: String,
    bio: String,
    image_name: String,
    subscribers: i64,
    developer: bool,
}

impl PlayerRow {
    fn from_raw(raw: RawPlayer) -> Option<PlayerRow> {
        let id = raw.id?;
        let username = raw.username.unwrap_or_default();
        let display_name = raw.display_name.unwrap_or_default();

        Some(PlayerRow {
            id,
            username_lc: username.to_lowercase(),
            username,
            display_name_lc: display_name.to_lowercase(),
            display_name,
            bio: raw.bio.unwrap_or_default(),
            image_name: raw.profile_image_name.unwrap_or_default(),
            subscribers: raw
                .reputation
                .and_then(|r| r.subscriber_count)
                .unwrap_or(0),
            developer: raw.developer.unwrap_or(false),
        })
    }
}

struct RoomsSnapshot {
    rooms: Vec<RoomRow>,
    fetched: Instant,
}

struct PlayersSnapshot {
    /// Sorted by id ascending, so browsing without a search reads as join
    /// order — oldest accounts first — and a page is a plain slice.
    players: Vec<PlayerRow>,
    fetched: Instant,
}

/// Age of a cached bulk set, so [`BulkCache`] can tell fresh from stale
/// without knowing what it is holding.
trait Fetched {
    fn fetched(&self) -> Instant;
}
impl Fetched for RoomsSnapshot {
    fn fetched(&self) -> Instant {
        self.fetched
    }
}
impl Fetched for PlayersSnapshot {
    fn fetched(&self) -> Instant {
        self.fetched
    }
}

/// One bulk set, served stale while it is being replaced.
///
/// The TTL used to be a hard expiry: the first request after ten minutes paid
/// for the whole download again, so opening People at the wrong moment sat on
/// "Loading players..." for as long as a cold start had. A set past its TTL is
/// still perfectly usable — these are room and player listings, not a bank
/// balance — so it is handed back immediately and a replacement is downloaded
/// behind the request. Only a caller that finds *nothing* cached waits.
struct BulkCache<T> {
    value: AsyncMutex<Option<Arc<T>>>,
    /// Set while a background refresh is running, so a burst of stale reads
    /// starts one download rather than one each.
    refreshing: AtomicBool,
    /// When a failed refresh may be retried. Without it a dead endpoint would
    /// be re-attempted by every request, each starting a multi-megabyte
    /// download that is going to fail.
    retry_at: StdMutex<Option<Instant>>,
}

impl<T> BulkCache<T> {
    const fn new() -> Self {
        Self {
            value: AsyncMutex::const_new(None),
            refreshing: AtomicBool::new(false),
            retry_at: StdMutex::new(None),
        }
    }
}

impl<T: Fetched + Send + Sync + 'static> BulkCache<T> {
    /// The cached set, downloading it first only if there isn't one yet.
    async fn get<F, Fut>(&'static self, fetch: F) -> Result<Arc<T>, String>
    where
        F: Fn() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Arc<T>, String>> + Send + 'static,
    {
        // Anything already downloaded answers from memory, fresh or not.
        {
            let guard = self.value.lock().await;
            if let Some(snap) = guard.as_ref() {
                let snap = snap.clone();
                drop(guard);
                if snap.fetched().elapsed() >= BULK_TTL {
                    self.spawn_refresh(fetch);
                }
                return Ok(snap);
            }
        }

        // Cold. This caller has to wait, and holds the lock while it does so a
        // burst at startup shares one download instead of starting one each.
        let mut guard = self.value.lock().await;
        if let Some(snap) = guard.as_ref() {
            // Another caller won the race and downloaded it while we queued.
            return Ok(snap.clone());
        }
        let snap = fetch().await?;
        *guard = Some(snap.clone());
        Ok(snap)
    }

    /// Download a replacement behind the request that found the set stale.
    ///
    /// The lock is taken only to store the result, never across the download,
    /// so readers keep being served the old set for however long it takes.
    fn spawn_refresh<F, Fut>(&'static self, fetch: F)
    where
        F: Fn() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<Arc<T>, String>> + Send + 'static,
    {
        {
            let retry = self.retry_at.lock().unwrap_or_else(|e| e.into_inner());
            if retry.map(|at| Instant::now() < at).unwrap_or(false) {
                return;
            }
        }
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }

        tokio::spawn(async move {
            match fetch().await {
                Ok(snap) => {
                    *self.value.lock().await = Some(snap);
                    *self.retry_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
                // A refresh that fails is no reason to throw away a list we
                // already have: serving it a while longer beats emptying the
                // tab, and backing off beats hammering a host that is down.
                Err(_) => {
                    *self.retry_at.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some(Instant::now() + BULK_RETRY_DELAY);
                }
            }
            self.refreshing.store(false, Ordering::SeqCst);
        });
    }
}

static ROOMS_CACHE: BulkCache<RoomsSnapshot> = BulkCache::new();
static PLAYERS_CACHE: BulkCache<PlayersSnapshot> = BulkCache::new();

/// Download a `/ws` bulk endpoint and parse it into `T`.
///
/// Read as bytes and parsed with `from_slice` rather than `Response::json`, so
/// the body is never materialized as a `String` on top of everything else.
async fn ws_get<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let url = format!("{}{}", API_BASE, path);

    let response = http()
        .get(&url)
        .timeout(BULK_TIMEOUT)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP error: {}", status));
    }

    let body = response.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice::<T>(&body)
        .map_err(|e| format!("Unexpected response from {}: {}", path, e))
}

/// Download and parse the room dump.
async fn download_rooms() -> Result<Arc<RoomsSnapshot>, String> {
    let raw: Vec<RawRoomRecord> = ws_get("/ws/getrooms").await?;
    Ok(Arc::new(RoomsSnapshot {
        rooms: raw.into_iter().filter_map(RoomRow::from_raw).collect(),
        fetched: Instant::now(),
    }))
}

/// Download and parse the player dump.
async fn download_players() -> Result<Arc<PlayersSnapshot>, String> {
    let raw: Vec<RawPlayer> = ws_get("/ws/getplayers").await?;
    let mut players: Vec<PlayerRow> = raw.into_iter().filter_map(PlayerRow::from_raw).collect();
    // The dump arrives in no useful order. Sorting once here is what lets
    // every later page be a slice.
    players.sort_by_key(|p| p.id);
    Ok(Arc::new(PlayersSnapshot { players, fetched: Instant::now() }))
}

/// Every public room, cached. See [`BulkCache`] for what "cached" costs a
/// caller once the set is past its TTL: nothing.
async fn rooms_snapshot() -> Result<Arc<RoomsSnapshot>, String> {
    ROOMS_CACHE.get(download_rooms).await
}

/// Every registered player, cached. See [`rooms_snapshot`].
async fn players_snapshot() -> Result<Arc<PlayersSnapshot>, String> {
    PLAYERS_CACHE.get(download_players).await
}

/// Start downloading both bulk sets, without waiting for either.
///
/// Called when the launcher settles after boot, and after a switch to Vanilla,
/// so the sets are already in memory by the time a tab asks for them. Before
/// this, the download began on the click that opened Rooms or People — which
/// is exactly when the user is watching, and the player dump is 5 MB over the
/// wire and 51 MB parsed.
///
/// Safe to call repeatedly: a set that is already cached and fresh returns
/// immediately, and concurrent cold callers share one download.
pub fn prefetch() {
    tokio::spawn(async {
        let _ = rooms_snapshot().await;
    });
    tokio::spawn(async {
        let _ = players_snapshot().await;
    });
}

// ─── Normalizers ──────────────────────────────────────────────────────────

/// Reshape a cached room into the PascalCase shape the room grid and detail
/// view read. `creators` resolves `CreatorPlayerId` when known.
fn room_row_json(r: &RoomRow, creators: Option<&CreatorMap>) -> Value {
    let creator = creators.and_then(|m| m.get(&r.creator_id));

    json!({
        "RoomId": r.id,
        "Name": r.name,
        "Description": r.description,
        "ImageName": r.image_name,
        "ThumbUrl": image_for_name(&r.image_name),
        "CreatorUsername": creator
            .map(|c| c.username.as_str())
            .filter(|u| !u.is_empty())
            .unwrap_or("Unknown"),
        "CreatorPlayerId": r.creator_id,
        "CreatorAvatarUrl": creator.map(|c| c.avatar.clone()).unwrap_or_default(),
        "CheerCount": r.cheers,
        "FavoriteCount": r.favorites,
        "VisitCount": r.visits,
        // Vanilla reports no per-room presence anywhere, bulk or proxied.
        "ActivePlayerCount": 0,
        "CreatedAt": r.created_at,
        // Every row in the dump is public — there are no private or dorm rooms
        // in it — so there is no accessibility distinction to pass on.
        "Accessibility": "",
    })
}

/// Reshape a cached player into the camelCase shape the people table reads.
///
/// `staff` carries the moderator and community-team flags, which exist only on
/// the proxied record; without it those badges are simply absent rather than
/// asserted false-by-omission in some louder way.
///
/// `isOnline` is deliberately `null`: Vanilla exposes no presence, and
/// reporting everyone as offline would be a lie the UI would render as a dot.
fn player_row_json(p: &PlayerRow, staff: Option<&CreatorInfo>) -> Value {
    json!({
        "id": p.id,
        "userName": p.username,
        "displayName": p.display_name,
        "bio": p.bio,
        "profileImage": p.image_name,
        "AvatarUrl": image_for_name(&p.image_name),
        "isOnline": Value::Null,
        "followerCount": p.subscribers,
        // The dump carries `Developer`; the other two staff flags come from the
        // proxied lookup when it answered.
        "isDeveloper": p.developer || staff.map(|s| s.is_developer).unwrap_or(false),
        "isModerator": staff.map(|s| s.is_moderator).unwrap_or(false),
        "isCommunityTeam": staff.map(|s| s.is_community_team).unwrap_or(false),
    })
}

/// Reshape a Vanilla image/photo into the shape the feed cards read.
fn normalize_photo(p: &Value) -> Value {
    json!({
        "Id": p.get("photoId").cloned().unwrap_or(Value::Null),
        "ImageName": str_field(p, "imageName").unwrap_or(""),
        "ThumbUrl": image_url(str_field(p, "imageUrl")).unwrap_or_default(),
        "RoomId": p.get("roomId").cloned().unwrap_or(Value::Null),
        "RoomName": str_field(p, "roomName").unwrap_or(""),
        "CreatorPlayerId": num_field(p, "creatorPlayerId"),
        "CreatorDisplayName": str_field(p, "creatorDisplayName").unwrap_or(""),
        // The photo feed embeds its uploader, so the card can attribute the
        // shot without the extra per-photo lookup Radium needs.
        "CreatorUsername": p
            .get("sender")
            .and_then(|s| str_field(s, "username"))
            .unwrap_or_else(|| str_field(p, "creatorDisplayName").unwrap_or("")),
        // "recnetupload" is the marker the game stamps on an untitled photo,
        // not something a player wrote — vanillarec.net doesn't render it and
        // neither should we.
        "Description": match str_field(p, "description") {
            Some("recnetupload") | None => "",
            Some(d) => d,
        },
        "CheerCount": num_field(p, "cheerCount"),
        // Null, not zero: Vanilla has no comment count at all, and the card
        // hides the stat when it is absent rather than claiming "0 Comments"
        // on every photo. `num_field` would flatten the difference to 0.
        "CommentCount": p.get("commentCount").cloned().unwrap_or(Value::Null),
        // Everyone in the shot, for the "In this photo:" line.
        "TaggedPlayers": p
            .get("taggedPlayers")
            .and_then(|t| t.as_array())
            .map(|players| {
                players
                    .iter()
                    .map(|tp| {
                        json!({
                            "id": tp.get("id").cloned().unwrap_or(Value::Null),
                            "userName": str_field(tp, "username").unwrap_or(""),
                            "displayName": str_field(tp, "displayName")
                                .or_else(|| str_field(tp, "username"))
                                .unwrap_or(""),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        "CreatedAt": p
            .get("takenAt")
            .cloned()
            .or_else(|| p.get("createdAt").cloned())
            .unwrap_or(Value::Null),
    })
}

// ─── Batched player lookup (proxied) ──────────────────────────────────────

/// A player as far as a room card, photo card or staff badge needs them.
#[derive(Clone, Default)]
struct CreatorInfo {
    username: String,
    avatar: String,
    is_developer: bool,
    is_moderator: bool,
    is_community_team: bool,
}

type CreatorMap = HashMap<i64, CreatorInfo>;

/// Resolve player ids to names, avatars and staff flags through the proxy.
///
/// Two callers need this even though the bulk player set exists:
///
/// * Room and photo rows carry only a creator id, and the Rooms and FEED tabs
///   would otherwise have to download the 5 MB player dump to print a name.
/// * The dump has no moderator or community-team flag, so a page of people is
///   enriched with the badges for just the rows on screen.
///
/// `players?ids=` caps at [`PLAYERS_BATCH_CAP`] rows, so larger sets are split
/// into chunks issued concurrently.
///
/// Resolved players are kept in [`CREATOR_CACHE`] and only the ids missing from
/// it are asked for. Every list in the app went through here on every page:
/// paging Rooms forward and back, retyping a search, or simply returning to a
/// tab re-resolved the same handful of creators over a proxy round-trip the
/// user waited on. Warm, a page that repeats ids costs no request at all.
///
/// Failures are swallowed: an unresolved player degrades one card to "Unknown"
/// or drops a badge, which beats failing the whole page over it.
async fn resolve_creators(ids: &BTreeSet<i64>) -> CreatorMap {
    let mut map = CreatorMap::new();
    if ids.is_empty() {
        return map;
    }

    // Serve what the cache holds; ask the proxy only for the rest.
    let mut missing: Vec<i64> = Vec::new();
    {
        let cache = creator_cache().lock().unwrap_or_else(|e| e.into_inner());
        for id in ids {
            match cache.get(id) {
                Some((info, at)) if at.elapsed() < CREATOR_TTL => {
                    map.insert(*id, info.clone());
                }
                _ => missing.push(*id),
            }
        }
    }
    if missing.is_empty() {
        return map;
    }

    let chunks: Vec<String> = missing
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .chunks(PLAYERS_BATCH_CAP as usize)
        .map(|c| c.join(","))
        .collect();

    let responses = futures_util::future::join_all(chunks.into_iter().map(|joined| async move {
        api_get_json(&format!("/api/website/players?ids={}", joined)).await
    }))
    .await;

    let mut fetched: Vec<(i64, CreatorInfo)> = Vec::new();
    for data in responses.into_iter().flatten() {
        for p in results_of(&data) {
            let Some(id) = p.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            fetched.push((
                id,
                CreatorInfo {
                    username: str_field(&p, "username").unwrap_or_default().to_string(),
                    avatar: image_url(str_field(&p, "profileImageUrl")).unwrap_or_default(),
                    is_developer: p["isDeveloper"].as_bool().unwrap_or(false),
                    is_moderator: p["isModerator"].as_bool().unwrap_or(false),
                    is_community_team: p["isCommunityTeam"].as_bool().unwrap_or(false),
                },
            ));
        }
    }

    {
        let mut cache = creator_cache().lock().unwrap_or_else(|e| e.into_inner());
        // Bounded so a long session browsing People — where every page resolves
        // a fresh batch of ids — can't grow this without limit. Dropping the
        // lot costs one round-trip on the next page, which is what this looked
        // like before the cache existed.
        if cache.len() + fetched.len() > CREATOR_CACHE_CAP {
            cache.clear();
        }
        let now = Instant::now();
        for (id, info) in fetched {
            cache.insert(id, (info.clone(), now));
            map.insert(id, info);
        }
    }

    map
}

/// Cap on [`CREATOR_CACHE`]. Roughly a thousand pages' worth of creators, well
/// past any one browsing session, at a few hundred bytes each.
const CREATOR_CACHE_CAP: usize = 20_000;

/// Players already resolved through the proxy, with when. See
/// [`resolve_creators`].
static CREATOR_CACHE: OnceLock<StdMutex<HashMap<i64, (CreatorInfo, Instant)>>> = OnceLock::new();

fn creator_cache() -> &'static StdMutex<HashMap<i64, (CreatorInfo, Instant)>> {
    CREATOR_CACHE.get_or_init(Default::default)
}

/// Fill in `CreatorUsername` / `CreatorAvatarUrl` on a page of normalized
/// photos, so the feed cards can attribute a shot without a lookup each.
async fn attach_photo_creators(photos: &mut [Value]) {
    let ids: BTreeSet<i64> = photos
        .iter()
        .map(|p| p["CreatorPlayerId"].as_i64().unwrap_or(0))
        .filter(|id| *id != 0)
        .collect();
    if ids.is_empty() {
        return;
    }

    let creators = resolve_creators(&ids).await;
    for photo in photos.iter_mut() {
        let id = photo["CreatorPlayerId"].as_i64().unwrap_or(0);
        if let Some(info) = creators.get(&id) {
            if !info.username.is_empty() {
                photo["CreatorUsername"] = json!(info.username);
            }
            photo["CreatorAvatarUrl"] = json!(info.avatar);
        }
    }
}

// ─── Rooms ────────────────────────────────────────────────────────────────

/// Split a search box into lowercase words.
fn search_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(|w| w.to_string())
        .collect()
}

/// Order rooms in place to match one of the launcher's sort buttons.
///
/// Sort 0 is "Hot", which used to mean "whatever order `rooms/popular` returned".
/// That order turns out to be cheer count descending — checked over 100 rooms,
/// where it was monotonic in cheers and in nothing else — so Hot and "Most
/// Cheered" are one ordering, and it is Vanilla's own.
///
/// Every comparison falls back to room id so that two rooms with equal counts
/// keep a fixed position between pages instead of swapping under the user.
fn sort_rooms(rooms: &mut [&RoomRow], sort_by: i64) {
    match sort_by {
        // Timestamps are RFC 3339 from one source, so lexical order is
        // chronological order; newest first.
        1 => rooms.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id))),
        2 => rooms.sort_by(|a, b| b.visits.cmp(&a.visits).then(a.id.cmp(&b.id))),
        4 => rooms.sort_by(|a, b| b.favorites.cmp(&a.favorites).then(a.id.cmp(&b.id))),
        _ => rooms.sort_by(|a, b| b.cheers.cmp(&a.cheers).then(a.id.cmp(&b.id))),
    }
}

pub async fn fetch_rooms(skip: i64, take: i64, query: &str, tag: &str, sort_by: i64) -> Value {
    let snap = match rooms_snapshot().await {
        Ok(s) => s,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let terms = search_terms(query);
    let tag = tag.trim().to_lowercase();

    // A tag and a search now compose. Against Vanilla's own API they could not:
    // its single `q` matches tags as well as names, so the two collapsed into
    // one field and the frontend had to clear whichever the user touched last.
    let mut matched: Vec<&RoomRow> = snap
        .rooms
        .iter()
        .filter(|r| tag.is_empty() || r.has_tag(&tag))
        .filter(|r| terms.is_empty() || r.matches(&terms))
        .collect();

    sort_rooms(&mut matched, sort_by);

    // The whole result set is in hand, so this is a real count, not an estimate
    // that grows as the user pages.
    let total = matched.len() as i64;
    let page: Vec<&RoomRow> = matched
        .into_iter()
        .skip(skip.max(0) as usize)
        .take(take.max(1) as usize)
        .collect();

    let ids: BTreeSet<i64> = page.iter().map(|r| r.creator_id).filter(|id| *id != 0).collect();
    let creators = resolve_creators(&ids).await;

    let rooms: Vec<Value> = page.iter().map(|r| room_row_json(r, Some(&creators))).collect();

    json!({
        "success": true,
        "data": { "Results": rooms, "TotalResults": total, "TotalKnown": true }
    })
}

/// The filter list the Rooms rail renders, in Radium's `fetch_filters` shape.
///
/// Vanilla publishes no tag or filter endpoint, but every room in the bulk set
/// carries its tags, so the vocabulary is the exact tally over all of them —
/// where it used to be inferred from a sample of 40 popular rooms.
pub async fn fetch_filters() -> Value {
    let Ok(snap) = rooms_snapshot().await else {
        // An empty set is a valid answer; the rail just shows "All Rooms".
        return json!({
            "success": true,
            "data": { "PinnedFilters": [], "PopularFilters": [] }
        });
    };

    let mut tally: HashMap<&str, usize> = HashMap::new();
    for room in &snap.rooms {
        for tag in room.tags.iter().filter(|t| t.kind == TAG_KIND_CREATOR) {
            *tally.entry(tag.name.as_str()).or_insert(0) += 1;
        }
    }

    let mut ranked: Vec<(&str, usize)> = tally.into_iter().collect();
    // Count first, then alphabetically so the rail doesn't reshuffle between
    // refreshes when several tags are tied.
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));

    let tags: Vec<&str> = ranked
        .into_iter()
        // Drop the long tail of tags only one room uses — they'd fill the rail
        // with dead ends.
        .filter(|(_, n)| *n > 1)
        .map(|(tag, _)| tag)
        .take(TAG_RAIL_LEN)
        .collect();

    json!({
        "success": true,
        // Vanilla has no notion of a pinned tag, so everything lands in
        // PopularFilters and the rail renders it after "All Rooms".
        "data": { "PinnedFilters": [], "PopularFilters": tags }
    })
}

/// Resolve one room's creator and render it.
async fn one_room_json(room: &RoomRow) -> Value {
    let ids: BTreeSet<i64> = [room.creator_id].into_iter().filter(|id| *id != 0).collect();
    let creators = resolve_creators(&ids).await;
    room_row_json(room, Some(&creators))
}

/// Room detail by numeric id.
pub async fn fetch_room_details(room_id: &str) -> Value {
    let snap = match rooms_snapshot().await {
        Ok(s) => s,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let Ok(id) = room_id.trim().parse::<i64>() else {
        return json!({ "success": false, "error": "Invalid room id." });
    };

    match snap.rooms.iter().find(|r| r.id == id) {
        Some(room) => json!({ "success": true, "data": one_room_json(room).await }),
        None => json!({ "success": false, "error": "Room not found." }),
    }
}

/// Find a room by name, preferring an exact case-insensitive match over the
/// first room whose name merely contains it.
fn find_room_by_name<'a>(snap: &'a RoomsSnapshot, name: &str) -> Option<&'a RoomRow> {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    snap.rooms
        .iter()
        .find(|r| r.name_lc == wanted)
        .or_else(|| snap.rooms.iter().find(|r| r.name_lc.contains(&wanted)))
}

/// Room stats by *name*, matching the scraper-backed Radium command the room
/// detail view calls.
pub async fn room_web_details(name: &str) -> Value {
    let snap = match rooms_snapshot().await {
        Ok(s) => s,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let Some(room) = find_room_by_name(&snap, name) else {
        return json!({ "success": false, "error": "Room not found." });
    };

    let ids: BTreeSet<i64> = [room.creator_id].into_iter().filter(|id| *id != 0).collect();
    let creator_avatar = resolve_creators(&ids)
        .await
        .get(&room.creator_id)
        .map(|c| c.avatar.clone())
        .unwrap_or_default();

    json!({
        "success": true,
        "cheers": room.cheers.to_string(),
        "favorites": room.favorites.to_string(),
        "visits": room.visits.to_string(),
        "description": room.description,
        "creatorAvatar": creator_avatar,
    })
}

// ─── People ───────────────────────────────────────────────────────────────

/// How well a player matches a search, lowest first.
///
/// The roster is browsed in join order, but a search should put the person you
/// typed at the top rather than whoever registered earliest among the matches.
fn match_rank(p: &PlayerRow, query: &str) -> u8 {
    if p.username_lc == query || p.display_name_lc == query {
        0
    } else if p.username_lc.starts_with(query) || p.display_name_lc.starts_with(query) {
        1
    } else {
        2
    }
}

pub async fn fetch_people(skip: i64, take: i64, query: &str) -> Value {
    let snap = match players_snapshot().await {
        Ok(s) => s,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let query = query.trim().to_lowercase();
    let skip = skip.max(0) as usize;
    let take = take.max(1) as usize;

    // Browsing with no search is a plain slice of an already-sorted roster.
    // Taking a reference to every one of the hundreds of thousands of players
    // first, only to drop all but fifteen, is work this did on every page
    // click — and the roster is the largest thing the launcher holds.
    let (page, total): (Vec<&PlayerRow>, i64) = if query.is_empty() {
        (
            snap.players.iter().skip(skip).take(take).collect(),
            snap.players.len() as i64,
        )
    } else {
        let mut matched: Vec<&PlayerRow> = snap
            .players
            .iter()
            .filter(|p| p.username_lc.contains(&query) || p.display_name_lc.contains(&query))
            .collect();
        // Stable within a rank, so equally-good matches stay in join order.
        matched.sort_by_key(|p| match_rank(p, &query));
        let total = matched.len() as i64;
        (matched.into_iter().skip(skip).take(take).collect(), total)
    };

    // The bulk record has no moderator or community-team flag, so the rows on
    // screen — and only those — get them from the proxied lookup.
    let ids: BTreeSet<i64> = page.iter().map(|p| p.id).collect();
    let staff = resolve_creators(&ids).await;

    let people: Vec<Value> = page
        .iter()
        .map(|p| player_row_json(p, staff.get(&p.id)))
        .collect();

    json!({
        "success": true,
        "data": { "Results": people, "TotalResults": total, "TotalKnown": true }
    })
}

/// Player stats by *username*, matching the scraper-backed Radium command.
///
/// Still proxied rather than read from the bulk set: a profile is often opened
/// without ever visiting the People tab, and one small lookup beats downloading
/// the whole roster to render one header.
pub async fn user_web_details(username: &str) -> Value {
    let username = username.trim();
    if username.chars().count() < MIN_QUERY_LEN {
        return json!({ "success": false, "error": "Username too short to look up." });
    }

    let path = format!("/api/website/players/search?q={}", urlencoding(username));
    let data = match api_get_json(&path).await {
        Ok(d) => d,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let results = results_of(&data);
    let person = results
        .iter()
        .find(|p| {
            str_field(p, "username")
                .map(|n| n.eq_ignore_ascii_case(username))
                .unwrap_or(false)
        })
        .or_else(|| results.first());

    let Some(person) = person else {
        return json!({ "success": false, "error": "Player not found." });
    };

    json!({
        "success": true,
        // Vanilla's player record carries exactly one social number,
        // `followerCount`. There is no friend count and no profile visit
        // count anywhere in its API — their own site doesn't show them either.
        // Empty (rather than a dash) tells the UI the stat doesn't exist on
        // this network, so it hides the tile instead of displaying a blank one.
        "friends": "",
        "subscribers": num_field(person, "followerCount").to_string(),
        "visits": "",
        "bio": str_field(person, "bio").unwrap_or(""),
        "banner": "",
        "avatar": image_url(str_field(person, "profileImageUrl")).unwrap_or_default(),
        "id": person.get("id").cloned().unwrap_or(Value::Null),
    })
}

pub async fn fetch_user_photos(user_id: &str, skip: i64, take: i64) -> Value {
    let path = format!("/api/website/players/{}/photos", user_id);
    match api_get_json(&path).await {
        Ok(d) => {
            // This endpoint takes no count and returns the whole set in one go.
            let page = paginate(results_of(&d), skip, take, true);
            let mut photos: Vec<Value> = page.rows.iter().map(normalize_photo).collect();
            attach_photo_creators(&mut photos).await;
            json!({ "success": true, "data": {
                "Results": photos, "TotalResults": page.total, "TotalKnown": page.total_known } })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// The rooms a player created.
///
/// Served from the cached room set: `players/{id}/rooms` returns the same rooms
/// but one page has to come back before we know how many there are, and this
/// way a creator with 200 rooms pages properly. Co-owned rooms are not counted
/// here, matching what the endpoint it replaces returned.
pub async fn fetch_user_rooms(user_id: &str, skip: i64, take: i64) -> Value {
    let snap = match rooms_snapshot().await {
        Ok(s) => s,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let Ok(id) = user_id.trim().parse::<i64>() else {
        return json!({ "success": false, "error": "Invalid player id." });
    };

    let mut matched: Vec<&RoomRow> = snap.rooms.iter().filter(|r| r.creator_id == id).collect();
    sort_rooms(&mut matched, 0);

    let total = matched.len() as i64;
    let page: Vec<&RoomRow> = matched
        .into_iter()
        .skip(skip.max(0) as usize)
        .take(take.max(1) as usize)
        .collect();

    // One creator, so the avatar and name are a single lookup for the page.
    let ids: BTreeSet<i64> = [id].into_iter().collect();
    let creators = resolve_creators(&ids).await;

    let rooms: Vec<Value> = page.iter().map(|r| room_row_json(r, Some(&creators))).collect();

    json!({
        "success": true,
        "data": { "Results": rooms, "TotalResults": total, "TotalKnown": true }
    })
}

/// How long the recent-photo list is reused. Short, because the FEED tab's
/// whole point is that it is recent — but long enough that scrolling through
/// it does not re-download the pages already on screen.
const FEED_TTL: Duration = Duration::from_secs(60);

/// Photos fetched per trip to the feed endpoint.
///
/// `count` is rounded up to a multiple of this, so the request that loads the
/// FEED tab also covers the next several scrolls. Asking for exactly the page
/// in hand would mean a fresh request per page, each one re-downloading every
/// page before it — which is the shape this cache exists to fix. Five pages'
/// worth is a small enough first request to not be felt and a long enough
/// runway that most sessions never make a second one.
const FEED_CHUNK: i64 = 60;

/// How many rows to ask the feed endpoint for, to serve `skip`..`skip + take`.
fn feed_fetch_count(skip: i64, take: i64) -> i64 {
    let needed = fetch_count(skip, take);
    let rounded = ((needed + FEED_CHUNK - 1) / FEED_CHUNK) * FEED_CHUNK;
    rounded.min(MAX_FETCH_COUNT)
}

struct FeedSnapshot {
    rows: Vec<Value>,
    /// What `count` this list was fetched with. A deeper page needs to know
    /// whether a short list is everything Vanilla has or just as much as was
    /// asked for last time.
    requested: i64,
    fetched: Instant,
}

static FEED_CACHE: AsyncMutex<Option<Arc<FeedSnapshot>>> = AsyncMutex::const_new(None);

/// Drop the cached photo list, so the next read goes back to the network.
/// Called by the FEED tab's Refresh button, which otherwise would have shown
/// the same photos again for as long as [`FEED_TTL`].
pub async fn invalidate_feed() {
    *FEED_CACHE.lock().await = None;
}

/// Recent photo feed. Also backs the room-photos view, which filters this feed
/// by room id the same way it does for Radium.
///
/// `/api/website/images/recent` takes a `count` and no offset, so every page
/// has to ask for its whole prefix and throw away the rows it already showed:
/// page 2 re-downloaded page 1, page 5 re-downloaded pages 1-4, and the FEED
/// tab pages on scroll. The longest list fetched is cached, so those pages are
/// slices of it instead of four more round-trips.
pub async fn fetch_recent_photos(skip: i64, take: i64) -> Value {
    let count = feed_fetch_count(skip, take);

    let mut guard = FEED_CACHE.lock().await;
    let usable = guard
        .as_ref()
        .filter(|s| s.fetched.elapsed() < FEED_TTL && s.requested >= count)
        .cloned();

    let snap = match usable {
        Some(s) => s,
        None => {
            let path = format!("/api/website/images/recent?count={}", count);
            match api_get_json(&path).await {
                Ok(d) => {
                    let snap = Arc::new(FeedSnapshot {
                        rows: results_of(&d),
                        requested: count,
                        fetched: Instant::now(),
                    });
                    *guard = Some(snap.clone());
                    snap
                }
                Err(e) => return json!({ "success": false, "error": e }),
            }
        }
    };
    drop(guard);

    // Fewer rows than were asked for means the feed ended, so the total is
    // exact rather than the running estimate page_of() otherwise reports.
    let complete = (snap.rows.len() as i64) < snap.requested;
    let skip_n = skip.max(0) as usize;
    let take_n = take.max(1) as usize;
    let rows: Vec<Value> = snap.rows.iter().skip(skip_n).take(take_n).cloned().collect();
    let page = page_of(rows, skip_n, snap.rows.len(), complete);
    let mut photos: Vec<Value> = page.rows.iter().map(normalize_photo).collect();
    attach_photo_creators(&mut photos).await;
    json!({ "success": true, "data": {
        "Results": photos, "TotalResults": page.total, "TotalKnown": page.total_known } })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Percent-encode a query-string value or a single path segment.
///
/// Hand-rolled rather than pulling in a crate: these are search terms typed by
/// the user and ids echoed back from an API, and the unreserved set from
/// RFC 3986 is all we need to keep. Keeping `/`, `?` and `#` encoded is what
/// stops an id from reshaping the URL it is interpolated into.
pub(crate) fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bulk room record as `/ws/getrooms` publishes it.
    fn raw_room(id: i64, name: &str, cheers: i64, favs: i64, visits: i64, created: &str) -> Value {
        json!({
            "Room": {
                "RoomId": id, "Name": name, "Description": "",
                "ImageName": format!("vnlaroom_{}", id), "CreatorPlayerId": 42,
                "CreatedAt": created, "CheerCount": cheers, "FavoriteCount": favs
            },
            "CheerCount": cheers, "FavoriteCount": favs, "VisitCount": visits,
            "Tags": []
        })
    }

    fn room_row(id: i64, name: &str, cheers: i64, favs: i64, visits: i64, created: &str) -> RoomRow {
        RoomRow::from_raw(
            serde_json::from_value(raw_room(id, name, cheers, favs, visits, created)).unwrap(),
        )
        .unwrap()
    }

    fn names<'a>(rooms: &[&'a RoomRow]) -> Vec<&'a str> {
        rooms.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn image_url_keeps_existing_cachebuster() {
        // Avatar URLs come back with a query already attached; rebuilding from
        // `imageName` would drop it and serve a stale image.
        assert_eq!(
            image_url(Some("/images/2_webso?1785023462696")).unwrap(),
            "https://api.vanillarec.net/images/2_webso?1785023462696"
        );
        assert_eq!(image_url(Some("")), None);
        assert_eq!(image_url(None), None);
    }

    #[test]
    fn image_for_name_matches_the_website_url() {
        // The bulk dumps name the image; the website API spells out the path.
        // Both must land on the same URL or every thumbnail 404s.
        assert_eq!(
            image_for_name("95_webso?1779688409249"),
            "https://api.vanillarec.net/images/95_webso?1779688409249"
        );
        assert_eq!(image_for_name(""), "");
        assert_eq!(image_for_name("   "), "");
    }

    #[test]
    fn room_takes_the_higher_of_the_two_cheer_counts() {
        // The outer aggregate reads 0 on cloned rooms while the room's own
        // counter holds the real number; on busy rooms it is the counter that
        // lags. Taking the larger is what matched Vanilla's site on all 100
        // rooms compared.
        let cloned: RawRoomRecord = serde_json::from_value(json!({
            "Room": { "RoomId": 1, "CheerCount": 310, "FavoriteCount": 890 },
            "CheerCount": 0, "FavoriteCount": 4, "VisitCount": 1073
        }))
        .unwrap();
        let row = RoomRow::from_raw(cloned).unwrap();
        assert_eq!(row.cheers, 310);
        assert_eq!(row.favorites, 890);

        let busy: RawRoomRecord = serde_json::from_value(json!({
            "Room": { "RoomId": 13, "CheerCount": 499, "FavoriteCount": 1309 },
            "CheerCount": 504, "FavoriteCount": 1314, "VisitCount": 223197
        }))
        .unwrap();
        let row = RoomRow::from_raw(busy).unwrap();
        assert_eq!(row.cheers, 504);
        assert_eq!(row.favorites, 1314);
    }

    #[test]
    fn room_record_without_a_room_is_skipped_not_fatal() {
        // One malformed row must not empty the Rooms tab.
        let raw: RawRoomRecord = serde_json::from_value(json!({ "CheerCount": 3 })).unwrap();
        assert!(RoomRow::from_raw(raw).is_none());
    }

    #[test]
    fn search_matches_words_across_different_fields() {
        // Vanilla's own search takes one word and matches nothing for two. The
        // point of doing it locally is that "horror quest" can find a room
        // named for one and tagged with the other.
        let raw: RawRoomRecord = serde_json::from_value(json!({
            "Room": { "RoomId": 7, "Name": "HorrorHouse", "Description": "spooky" },
            "Tags": [{ "Tag": "quest", "Type": 0 }]
        }))
        .unwrap();
        let row = RoomRow::from_raw(raw).unwrap();

        assert!(row.matches(&search_terms("horror quest")));
        assert!(row.matches(&search_terms("SPOOKY")), "matching is case-insensitive");
        assert!(!row.matches(&search_terms("horror pinball")));
        assert!(row.matches(&search_terms("")), "an empty search excludes nothing");
    }

    #[test]
    fn tag_match_is_exact_not_a_substring() {
        // "pvp" must not be dragged in by a room tagged "pvparena", or the
        // filter quietly widens.
        let raw: RawRoomRecord = serde_json::from_value(json!({
            "Room": { "RoomId": 8, "Name": "Arena" },
            "Tags": [{ "Tag": "PvPArena", "Type": 0 }]
        }))
        .unwrap();
        let row = RoomRow::from_raw(raw).unwrap();
        assert!(row.has_tag("pvparena"), "tags are folded to lowercase");
        assert!(!row.has_tag("pvp"));
    }

    #[test]
    fn sort_hot_and_cheered_are_the_same_order() {
        // Measured: `rooms/popular` is descending cheer count and nothing else,
        // so "Hot" is not a separate ranking we'd be discarding.
        let a = room_row(1, "low", 1, 1, 1, "2020-01-01T00:00:00Z");
        let b = room_row(2, "high", 9, 9, 9, "2026-01-01T00:00:00Z");

        let mut hot = vec![&a, &b];
        sort_rooms(&mut hot, 0);
        assert_eq!(names(&hot), ["high", "low"]);

        let mut cheered = vec![&a, &b];
        sort_rooms(&mut cheered, 3);
        assert_eq!(names(&cheered), ["high", "low"]);
    }

    #[test]
    fn sort_orders_by_each_counter_descending() {
        let low = room_row(1, "low", 1, 20, 300, "2021-05-01T00:00:00Z");
        let high = room_row(2, "high", 500, 5, 2, "2020-01-01T00:00:00Z");
        let mid = room_row(3, "mid", 50, 900, 40, "2026-09-01T00:00:00Z");
        let base = || vec![&low, &high, &mid];

        let mut r = base();
        sort_rooms(&mut r, 1); // Newest
        assert_eq!(names(&r), ["mid", "low", "high"]);

        let mut r = base();
        sort_rooms(&mut r, 2); // Most Visited
        assert_eq!(names(&r), ["low", "mid", "high"]);

        let mut r = base();
        sort_rooms(&mut r, 3); // Most Cheered
        assert_eq!(names(&r), ["high", "mid", "low"]);

        let mut r = base();
        sort_rooms(&mut r, 4); // Most Favorited
        assert_eq!(names(&r), ["mid", "low", "high"]);
    }

    #[test]
    fn sort_breaks_ties_by_id_so_pages_dont_shuffle() {
        // Two rooms on the same count must not swap between page 1 and page 2,
        // which would drop one room and repeat the other.
        let a = room_row(9, "nine", 5, 5, 5, "2026-01-01T00:00:00Z");
        let b = room_row(4, "four", 5, 5, 5, "2026-01-01T00:00:00Z");

        let mut asc = vec![&a, &b];
        sort_rooms(&mut asc, 3);
        let mut desc = vec![&b, &a];
        sort_rooms(&mut desc, 3);
        assert_eq!(names(&asc), names(&desc), "order must not depend on input order");
        assert_eq!(names(&asc), ["four", "nine"]);
    }

    #[test]
    fn room_without_creator_lookup_degrades_to_unknown() {
        let row = room_row(5, "RecCenter", 0, 0, 0, "2026-01-01T00:00:00Z");
        let out = room_row_json(&row, None);
        assert_eq!(out["CreatorUsername"], "Unknown");
        assert_eq!(out["Name"], "RecCenter");
        assert_eq!(out["ThumbUrl"], "https://api.vanillarec.net/images/vnlaroom_5");
    }

    #[test]
    fn room_uses_the_looked_up_creator_when_there_is_one() {
        let row = room_row(5, "RecCenter", 0, 0, 0, "2026-01-01T00:00:00Z");
        let mut map = CreatorMap::new();
        map.insert(
            42,
            CreatorInfo {
                username: "Nilla".into(),
                avatar: "https://api.vanillarec.net/images/42".into(),
                ..Default::default()
            },
        );
        let out = room_row_json(&row, Some(&map));
        assert_eq!(out["CreatorUsername"], "Nilla");
        assert_eq!(out["CreatorAvatarUrl"], "https://api.vanillarec.net/images/42");
    }

    fn player(id: i64, username: &str, display: &str) -> PlayerRow {
        PlayerRow::from_raw(
            serde_json::from_value(json!({
                "Id": id, "Username": username, "DisplayName": display,
                "Bio": "hi", "ProfileImageName": format!("{}", id),
                "Developer": false,
                "PlayerReputation": { "SubscriberCount": 7 }
            }))
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn person_online_state_is_unknown_not_offline() {
        // Vanilla has no presence API. Reporting `false` would render everyone
        // with an "offline" dot, which asserts something we don't know.
        let out = player_row_json(&player(2, "Nilla", "Nilla"), None);
        assert!(out["isOnline"].is_null());
        assert_eq!(out["userName"], "Nilla");
        assert_eq!(out["followerCount"], 7);
        assert_eq!(out["AvatarUrl"], "https://api.vanillarec.net/images/2");
    }

    #[test]
    fn staff_badges_come_from_the_proxied_lookup() {
        // The bulk dump has `Developer` and nothing else, so a moderator shows
        // no MOD badge until the per-page lookup fills it in — and the absence
        // of that lookup must not turn a developer into a non-developer.
        let p = player(3, "Mod", "Mod");
        let bare = player_row_json(&p, None);
        assert_eq!(bare["isModerator"], false);

        let staff = CreatorInfo {
            is_developer: true,
            is_moderator: true,
            is_community_team: false,
            ..Default::default()
        };
        let enriched = player_row_json(&p, Some(&staff));
        assert_eq!(enriched["isModerator"], true);
        assert_eq!(enriched["isDeveloper"], true);
        assert_eq!(enriched["isCommunityTeam"], false);
    }

    #[test]
    fn search_puts_the_exact_name_first() {
        let exact = player(1, "nilla", "nilla");
        let prefix = player(2, "nillabean", "nillabean");
        let middle = player(3, "notnilla", "notnilla");

        let mut rows = [&middle, &prefix, &exact];
        rows.sort_by_key(|p| match_rank(p, "nilla"));
        let got: Vec<&str> = rows.iter().map(|p| p.username.as_str()).collect();
        assert_eq!(got, ["nilla", "nillabean", "notnilla"]);
    }

    #[test]
    fn pagination_reports_more_when_probe_row_arrives() {
        let rows: Vec<Value> = (0..13).map(|i| json!({ "n": i })).collect();
        // Page 1 of 12, with a 13th row proving there's more.
        let page = paginate(rows, 0, 12, false);
        assert_eq!(page.rows.len(), 12);
        assert_eq!(page.total, 13, "total must exceed the page so Next stays enabled");
        assert!(!page.total_known, "an estimate must not be presented as a count");
    }

    #[test]
    fn pagination_reports_exact_total_on_last_page() {
        let rows: Vec<Value> = (0..17).map(|i| json!({ "n": i })).collect();
        let page = paginate(rows, 12, 12, false);
        assert_eq!(page.rows.len(), 5);
        assert_eq!(page.total, 17, "no probe row left, so the total is now exact");
        assert!(page.total_known);
    }

    #[test]
    fn pagination_past_the_end_is_empty_not_a_panic() {
        let rows: Vec<Value> = (0..3).map(|i| json!({ "n": i })).collect();
        let page = paginate(rows, 96, 12, false);
        assert!(page.rows.is_empty());
        assert_eq!(page.total, 96);
    }

    #[test]
    fn a_complete_fetch_reports_a_real_page_count() {
        // The whole set in hand: the total is the set's size on every page, so
        // "Page 1 of 3" and "Page 2 of 3" agree instead of the total creeping up.
        let rows: Vec<Value> = (0..30).map(|i| json!({ "n": i })).collect();

        let first = paginate(rows.clone(), 0, 12, true);
        assert_eq!(first.total, 30);
        assert!(first.total_known);

        let second = paginate(rows, 12, 12, true);
        assert_eq!(second.total, 30, "the total must not move between pages");
        assert!(second.total_known);
    }

    #[test]
    fn fetch_count_covers_the_page_plus_a_probe() {
        assert_eq!(fetch_count(0, 12), 13);
        assert_eq!(fetch_count(24, 12), 37);
        assert_eq!(fetch_count(10_000, 12), MAX_FETCH_COUNT);
    }

    #[test]
    fn feed_fetches_in_chunks_so_scrolling_reuses_one_download() {
        // The first page pulls a chunk, and the next four pages have to fall
        // inside it or the cache never gets a hit.
        assert_eq!(feed_fetch_count(0, 12), FEED_CHUNK);
        for page in 0..4 {
            assert_eq!(
                feed_fetch_count(page * 12, 12),
                FEED_CHUNK,
                "page {} left the first chunk",
                page
            );
        }
        // Page 6 needs rows 60..72, so it pulls the next chunk up.
        assert_eq!(feed_fetch_count(60, 12), 2 * FEED_CHUNK);
        // And rounding up never carries a request past the ceiling, including
        // at the boundary where the cap is not a whole number of chunks.
        assert_eq!(feed_fetch_count(10_000, 12), MAX_FETCH_COUNT);
        for skip in (0..600).step_by(12) {
            assert!(
                feed_fetch_count(skip, 12) <= MAX_FETCH_COUNT,
                "skip {} rounded past the cap",
                skip
            );
        }
    }

    #[test]
    fn a_page_taken_from_a_cached_list_totals_the_same_as_a_fetched_one() {
        // page_of() is what lets a cached feed be sliced instead of copied, so
        // it has to agree with paginate() on every total it reports.
        let rows: Vec<Value> = (0..30).map(|i| json!({ "photoId": i })).collect();

        for &(skip, take, complete) in &[
            (0i64, 12i64, true),
            (12, 12, true),
            (24, 12, true),
            (0, 12, false),
            (12, 12, false),
            (24, 12, false),
            (48, 12, false),
        ] {
            let whole = paginate(rows.clone(), skip, take, complete);
            let skip_n = skip as usize;
            let take_n = take as usize;
            let sliced: Vec<Value> = rows.iter().skip(skip_n).take(take_n).cloned().collect();
            let part = page_of(sliced, skip_n, rows.len(), complete);

            assert_eq!(part.rows, whole.rows, "rows differ at skip {}", skip);
            assert_eq!(part.total, whole.total, "total differs at skip {}", skip);
            assert_eq!(
                part.total_known, whole.total_known,
                "total_known differs at skip {}",
                skip
            );
        }
    }

    #[test]
    fn photo_drops_the_upload_placeholder_caption() {
        // Almost every photo carries description "recnetupload" — the game's
        // marker for an untitled shot, not a caption anyone wrote. Rendering it
        // would put the same meaningless word under most of the feed.
        let out = normalize_photo(&json!({ "photoId": "a", "description": "recnetupload" }));
        assert_eq!(out["Description"], "");

        let real = normalize_photo(&json!({ "photoId": "b", "description": "my cool room" }));
        assert_eq!(real["Description"], "my cool room");

        let missing = normalize_photo(&json!({ "photoId": "c" }));
        assert_eq!(missing["Description"], "");
    }

    #[test]
    fn photo_carries_everyone_in_the_shot() {
        let out = normalize_photo(&json!({
            "photoId": "a",
            "sender": { "id": 2, "username": "Nilla", "displayName": "Nilla" },
            "taggedPlayers": [
                { "id": 2, "username": "Nilla", "displayName": "Nilla" },
                { "id": 63088, "username": "spidr", "displayName": "spidr" }
            ]
        }));
        let tagged = out["TaggedPlayers"].as_array().unwrap();
        assert_eq!(tagged.len(), 2);
        assert_eq!(tagged[1]["userName"], "spidr");
        assert_eq!(out["CreatorUsername"], "Nilla");
    }

    #[test]
    fn photo_comment_count_is_absent_not_zero() {
        // The card shows the Comments stat only when the network reports one.
        // Flattening "no such field" to 0 would put "0 Comments" under every
        // Vanilla photo, which reads as "nobody commented" rather than "this
        // network has no comments".
        let out = normalize_photo(&json!({ "photoId": "a" }));
        assert!(out["CommentCount"].is_null());

        let with = normalize_photo(&json!({ "photoId": "b", "commentCount": 4 }));
        assert_eq!(with["CommentCount"], 4);
    }

    #[test]
    fn photo_with_no_tags_yields_an_empty_list_not_null() {
        // The card iterates this directly, so it must always be an array.
        let out = normalize_photo(&json!({ "photoId": "a" }));
        assert!(out["TaggedPlayers"].as_array().unwrap().is_empty());
    }

    #[test]
    fn urlencoding_escapes_query_metacharacters() {
        assert_eq!(urlencoding("rec room"), "rec%20room");
        assert_eq!(urlencoding("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoding("Nilla-1_2.3~"), "Nilla-1_2.3~");
    }

    // ── Live endpoint checks ──
    //
    // Ignored by default: these hit Vanilla over the network, so they are not
    // part of a normal `cargo test`. Run them with
    // `cargo test --lib -- --ignored --nocapture` when Rooms or People break —
    // they are what tells apart "their payload changed shape" from a bug here.

    #[tokio::test]
    #[ignore = "hits api.vanillarec.net"]
    async fn live_room_dump_still_parses() {
        let snap = rooms_snapshot().await.expect("/ws/getrooms should answer");

        assert!(snap.rooms.len() > 1000, "only {} rooms parsed", snap.rooms.len());
        assert!(
            snap.rooms.iter().all(|r| r.id != 0),
            "a room came through without an id"
        );
        assert!(
            snap.rooms.iter().filter(|r| !r.name.is_empty()).count() * 10 > snap.rooms.len() * 9,
            "most rooms should have a name; the field may have been renamed"
        );
        assert!(
            snap.rooms.iter().any(|r| r.visits > 0),
            "VisitCount is the one counter with no fallback — it must arrive"
        );
        assert!(
            snap.rooms
                .iter()
                .any(|r| r.tags.iter().any(|t| t.kind == TAG_KIND_CREATOR)),
            "no creator tags found, so the Filters rail would be empty"
        );

        // The Rec Center is room 2 on every Rec Room revival and is the one row
        // safe to assert by name.
        let hub = snap.rooms.iter().find(|r| r.id == 2).expect("room 2 should exist");
        assert!(hub.cheers > 0 && hub.favorites > 0 && hub.visits > 0);
        println!(
            "rooms: {} parsed; room 2 = {:?} ({} cheers, {} visits)",
            snap.rooms.len(),
            hub.name,
            hub.cheers,
            hub.visits
        );
    }

    #[tokio::test]
    #[ignore = "hits api.vanillarec.net"]
    async fn live_player_dump_still_parses() {
        let snap = players_snapshot().await.expect("/ws/getplayers should answer");

        assert!(snap.players.len() > 1000, "only {} players parsed", snap.players.len());
        assert!(
            snap.players.windows(2).all(|w| w[0].id <= w[1].id),
            "the roster must be sorted by id or paging is not a slice"
        );
        assert!(
            snap.players.iter().filter(|p| !p.username.is_empty()).count() * 10
                > snap.players.len() * 9,
            "most players should have a username"
        );
        assert!(
            snap.players.iter().any(|p| p.subscribers > 0),
            "SubscriberCount is nested under PlayerReputation; a rename would zero every profile"
        );
        assert!(
            snap.players.iter().any(|p| p.developer),
            "no developer flag anywhere, so the DEV badge would never show"
        );
        println!("players: {} parsed", snap.players.len());
    }

    /// Everything the Rooms and People tabs actually call, against live data.
    #[tokio::test]
    #[ignore = "hits api.vanillarec.net"]
    async fn live_commands_return_usable_pages() {
        let hot = fetch_rooms(0, 12, "", "", 0).await;
        assert_eq!(hot["success"], true, "fetch_rooms failed: {}", hot);
        let rows = hot["data"]["Results"].as_array().unwrap();
        assert_eq!(rows.len(), 12);
        assert_eq!(hot["data"]["TotalKnown"], true, "the room total is now exact");
        assert!(hot["data"]["TotalResults"].as_i64().unwrap() > 1000);
        assert!(
            !rows[0]["ThumbUrl"].as_str().unwrap().is_empty(),
            "a room card with no thumbnail URL"
        );
        assert_ne!(
            rows[0]["CreatorUsername"], "Unknown",
            "the per-page creator lookup did not resolve"
        );
        println!(
            "hot page 1: {} of {}, first = {} by {}",
            rows.len(),
            hot["data"]["TotalResults"],
            rows[0]["Name"],
            rows[0]["CreatorUsername"]
        );

        // Page 2 must not repeat page 1, and the total must not move.
        let next = fetch_rooms(12, 12, "", "", 0).await;
        assert_eq!(
            next["data"]["TotalResults"], hot["data"]["TotalResults"],
            "the total moved between pages"
        );
        assert_ne!(next["data"]["Results"][0]["RoomId"], rows[0]["RoomId"]);

        // The two-word search that matched nothing against their own API.
        let combo = fetch_rooms(0, 12, "rec center", "", 0).await;
        assert_eq!(combo["success"], true);
        assert!(
            combo["data"]["TotalResults"].as_i64().unwrap() > 0,
            "a multi-word search still finds nothing"
        );

        // A tag and a search together — impossible before.
        let both = fetch_rooms(0, 12, "arena", "pvp", 0).await;
        assert_eq!(both["success"], true, "tag + query failed: {}", both);

        let filters = fetch_filters().await;
        let tags = filters["data"]["PopularFilters"].as_array().unwrap();
        assert!(!tags.is_empty(), "the Filters rail came back empty");
        println!("filters: {:?}", tags);

        // Every tag the rail offers must lead somewhere, and nowhere near
        // everywhere: `community` is a creator tag on ~61 rooms but a
        // server-applied one on 6,697, and clicking it must mean the former.
        for tag in tags {
            let tag = tag.as_str().unwrap();
            let page = fetch_rooms(0, 12, "", tag, 0).await;
            let hits = page["data"]["TotalResults"].as_i64().unwrap();
            assert!(hits > 0, "the rail offers {tag:?} but it matches no rooms");
            assert!(
                hits < 5000,
                "{tag:?} matched {hits} rooms — a server-applied tag has leaked into the filter"
            );
        }

        let people = fetch_people(0, 12, "").await;
        assert_eq!(people["success"], true, "fetch_people failed: {}", people);
        let rows = people["data"]["Results"].as_array().unwrap();
        assert_eq!(rows.len(), 12);
        assert_eq!(people["data"]["TotalKnown"], true, "the roster total is now exact");
        assert!(rows[0]["isOnline"].is_null(), "presence must stay tri-state");

        // Searching the roster at all is new; it had no browse-all endpoint.
        let found = fetch_people(0, 12, "nilla").await;
        assert!(
            found["data"]["TotalResults"].as_i64().unwrap() > 0,
            "player search found nobody"
        );
        println!(
            "people: {} total, search hit = {}",
            people["data"]["TotalResults"], found["data"]["Results"][0]["userName"]
        );
    }

    /// The bulk set and the proxied record must agree, because the launcher
    /// shows them side by side: the People row comes from the dump and the
    /// badges on that same row come from the proxy.
    #[tokio::test]
    #[ignore = "hits api.vanillarec.net"]
    async fn live_bulk_and_proxied_players_agree() {
        let snap = players_snapshot().await.expect("/ws/getplayers should answer");

        let sample: Vec<&PlayerRow> = snap.players.iter().take(10).collect();
        let ids: BTreeSet<i64> = sample.iter().map(|p| p.id).collect();
        let proxied = resolve_creators(&ids).await;
        assert!(!proxied.is_empty(), "the proxy answered nothing; check the Referer gate");

        for p in sample {
            let Some(info) = proxied.get(&p.id) else { continue };
            assert_eq!(info.username, p.username, "username disagrees for id {}", p.id);
            assert_eq!(
                info.avatar,
                image_for_name(&p.image_name),
                "avatar URL disagrees for id {} — thumbnails would 404",
                p.id
            );
        }
    }
}
