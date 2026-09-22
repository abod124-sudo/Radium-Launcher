use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::Emitter;
use tauri::Manager;

use crate::config::{self, Network};
use crate::game;
use crate::scraper::unescape_html;

/// Page that hosts the current client download links. The launcher fetches this
/// at runtime and resolves the Windows build zip, so it stays correct when the
/// build version is bumped on the site.
const DOWNLOAD_PAGE: &str = "https://recroom.baby/downloads/";

/// Browser-like User-Agent — the download site rejects requests without one.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Identifier for the client build this launcher expects. Bump this whenever the
/// client on the download page changes in a way that requires a fresh install;
/// any client installed under a different build id is treated as outdated and
/// the user is prompted to re-download. (See `check_install` -> `clientOutdated`.)
pub const REQUIRED_CLIENT_BUILD: &str = "recroom-baby-2016";

/// SHA-256 of the zip [`REQUIRED_CLIENT_BUILD`] names, lowercase hex.
///
/// What gets extracted here is executable code, and the URL it comes from is
/// scraped off a web page — so TLS proves only that the page and the CDN were
/// reached, not that the bytes are the build this launcher was tested against.
/// A pin turns that into something checkable.
///
/// `None` disables the check, which is the state to avoid: set it whenever
/// `REQUIRED_CLIENT_BUILD` is bumped, by downloading the zip once and running
///
/// ```text
/// certutil -hashfile client.zip SHA256
/// ```
///
/// A mismatch aborts before extraction, so a wrong value here is a loud
/// failure rather than a silent one.
pub const EXPECTED_CLIENT_SHA256: Option<&str> = None;

/// Lowercase hex SHA-256 of a file, read in chunks so a multi-gigabyte zip is
/// never held in memory.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read while hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect())
}

/// Lowercase hex SHA-256 of bytes already in memory.
pub fn sha256_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Compare a computed digest against an expected one, case- and
/// `sha256:`-prefix-insensitively.
pub fn digest_matches(actual: &str, expected: &str) -> bool {
    let expected = expected
        .trim()
        .trim_start_matches("sha256:")
        .trim_start_matches("SHA256:");
    actual.eq_ignore_ascii_case(expected.trim())
}

/// Basename of the download artifacts for `network`.
///
/// The two networks keep separate zips and separate resume state, so a paused
/// Radium download is not clobbered by starting a Vanilla one (and vice versa).
fn zip_stem(network: Network) -> &'static str {
    match network {
        Network::Radium => "client.zip",
        Network::Vanilla => "client-vanilla.zip",
    }
}

/// Atomic flag used to signal cancellation of an in-progress download.
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// The error a cancelled download or extraction ends with. The frontend
/// matches it exactly, to tell a cancel apart from a failure.
const CANCELLED: &str = "Cancelled";

/// Atomic flag used to pause an in-progress download. Unlike cancellation, a
/// pause leaves the partial file (and its resume metadata) on disk so the
/// download can be continued later — either by clicking Resume, or by reopening
/// the launcher after it was closed mid-download.
static DOWNLOAD_PAUSED: AtomicBool = AtomicBool::new(false);

/// Guards against two downloads running concurrently (e.g. cancel + immediate
/// re-download), which would race on the same client.zip and client directory.
static DOWNLOAD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// How long to wait for the client zip's response headers.
const RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How often the download loop looks at the pause and cancel flags while it
/// waits for the next chunk.
const FLAG_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// A download that receives nothing for this long is given up on (and can be
/// resumed), rather than left holding the download guard forever.
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// An `Instant` far enough back that the first progress event is sent at once.
///
/// `Instant::now() - interval` panics if the clock is younger than `interval`,
/// and the release profile turns a panic into an abort.
fn emit_now_baseline(interval: std::time::Duration) -> std::time::Instant {
    let now = std::time::Instant::now();
    now.checked_sub(interval).unwrap_or(now)
}

/// RAII guard that clears `DOWNLOAD_IN_PROGRESS` on every exit path.
struct DownloadGuard;
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        DOWNLOAD_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Metadata persisted next to a partial download (`client.zip.part.meta`) so an
/// interrupted download can be validated and resumed later. Survives launcher
/// restarts alongside the `.part` file itself.
struct PartMeta {
    url: String,
    etag: String,
    total: u64,
}

/// Read the sidecar resume metadata, if present and well-formed.
fn read_part_meta(path: &Path) -> Option<PartMeta> {
    let txt = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    Some(PartMeta {
        url: v.get("url")?.as_str()?.to_string(),
        etag: v.get("etag").and_then(|e| e.as_str()).unwrap_or("").to_string(),
        total: v.get("total").and_then(|t| t.as_u64()).unwrap_or(0),
    })
}

/// Persist the sidecar resume metadata (best-effort).
fn write_part_meta(path: &Path, meta: &PartMeta) {
    let v = json!({ "url": meta.url, "etag": meta.etag, "total": meta.total });
    if let Ok(txt) = serde_json::to_string(&v) {
        let _ = fs::write(path, txt);
    }
}

/// Pull the true total size out of a `Content-Range: bytes start-end/total`
/// header (the `Content-Length` of a 206 response is only the remaining bytes).
fn parse_content_range_total(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let v = headers
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    v.rsplit('/').next()?.trim().parse::<u64>().ok()
}

/// The first byte a `Content-Range: bytes start-end/total` header says the
/// body begins at.
fn parse_content_range_start(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let v = headers
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    let range = v.trim().strip_prefix("bytes")?.trim_start();
    range.split('-').next()?.trim().parse::<u64>().ok()
}

/// Resolve a possibly-relative link from the download page into an absolute URL.
///
/// The launcher executes what it downloads, so a plaintext `http://` link from
/// the page is upgraded to https rather than fetched in the clear. (The old
/// `starts_with("http")` test also treated any string merely beginning with
/// those four letters as an absolute URL.)
fn resolve_link(raw: &str) -> String {
    if raw.starts_with("https://") {
        raw.to_string()
    } else if let Some(rest) = raw.strip_prefix("http://") {
        format!("https://{}", rest)
    } else if let Some(stripped) = raw.strip_prefix("//") {
        format!("https://{}", stripped)
    } else if raw.starts_with('/') {
        format!("https://recroom.baby{}", raw)
    } else {
        format!("https://recroom.baby/downloads/{}", raw)
    }
}

/// Pull the `ETag` header (the CDN's content fingerprint for this exact file)
/// out of a response, if present.
fn extract_etag(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// HEAD the given URL and return its `ETag`, without downloading the body.
/// Returns `None` on any failure (missing header, network error, method not
/// allowed, etc.) — this is a best-effort secondary signal, not a hard error.
async fn fetch_remote_etag(url: &str) -> Option<String> {
    let response = crate::server::http()
        .head(url)
        .timeout(std::time::Duration::from_secs(10))
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .ok()?;
    extract_etag(response.headers())
}

/// Fetch the raw HTML of the downloads page.
///
/// The status is checked first: an error page or a Cloudflare challenge has no
/// Windows card in it, and was reported as "could not determine the latest
/// client version" — true, but no help working out that the site was down.
async fn fetch_download_page_html() -> Result<String, String> {
    let response = crate::server::http()
        .get(DOWNLOAD_PAGE)
        .timeout(std::time::Duration::from_secs(20))
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("Failed to load download page: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The download page answered HTTP {}.", status.as_u16()));
    }
    response
        .text()
        .await
        .map_err(|e| format!("Failed to read download page: {}", e))
}

/// Extract the Windows build's version string and download link from the
/// downloads page's "Windows" card, e.g.
/// `<h3>Windows</h3><p>0.9.2</p><p><a href="...windows.zip">Download</a></p>`.
fn extract_windows_card(html: &str) -> Option<(String, String)> {
    // Compiled once: this runs on every update check, and building the pattern
    // costs more than matching it against the page.
    static RE: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let re = RE
        .get_or_init(|| {
            regex::Regex::new(
                r#"(?s)<h3>\s*Windows\s*</h3>\s*<p>([^<]+)</p>\s*<p><a href="([^"]+)""#,
            )
            .ok()
        })
        .as_ref()?;
    let c = re.captures(html)?;
    Some((
        c.get(1)?.as_str().trim().to_string(),
        c.get(2)?.as_str().to_string(),
    ))
}

/// Extract patch notes (version, date, bullet list) from the downloads page,
/// newest first, as published on the site.
fn extract_patch_notes(html: &str) -> Vec<Value> {
    static BLOCK: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    static LI: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();

    let block_re = BLOCK.get_or_init(|| {
        regex::Regex::new(
            r#"(?s)<div class="well patch-note"><h3>([^<]+)</h3><p class="muted">([^<]+)</p><ul>(.*?)</ul></div>"#,
        )
        .ok()
    });
    let li_re = LI.get_or_init(|| regex::Regex::new(r#"(?s)<li>(.*?)</li>"#).ok());

    let (Some(block_re), Some(li_re)) = (block_re.as_ref(), li_re.as_ref()) else {
        return Vec::new();
    };

    block_re
        .captures_iter(html)
        .take(10)
        .map(|cap| {
            let version = cap[1].trim().to_string();
            let date = cap[2].trim().to_string();
            let notes: Vec<String> = li_re
                .captures_iter(&cap[3])
                .map(|m| unescape_html(m[1].trim()))
                .collect();
            json!({ "version": version, "date": date, "notes": notes })
        })
        .collect()
}

/// The numeric release of a version string, and its pre-release suffix.
///
/// `"v4.1.0-beta.2"` is `([4, 1, 0], "beta.2")`; `"4.1.0"` is `([4, 1, 0], "")`.
/// A leading `v` is dropped, `+build` metadata is discarded (semver says it
/// takes no part in ordering), everything after the first `-` is the
/// pre-release suffix, and each remaining dotted segment is read up to its
/// first non-digit.
///
/// Splitting the suffix off is what the old parse missed: it split on `.`
/// first, so `"4.1.0-beta"` became `["4", "1", "0-beta"]`, and `"0-beta"`
/// failed to parse and fell back to 0 — making a pre-release compare exactly
/// equal to the release it precedes. A `-beta` tag on GitHub was therefore
/// never offered to anyone on the final, and vice versa.
fn version_parts(s: &str) -> (Vec<u64>, &str) {
    let s = s.trim().trim_start_matches('v');
    let s = s.split('+').next().unwrap_or(s);
    let (release, pre) = match s.find('-') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let nums = release
        .split('.')
        .map(|part| {
            let digits = part.trim();
            let end = digits
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(digits.len());
            digits[..end].parse::<u64>().unwrap_or(0)
        })
        .collect();
    (nums, pre)
}

/// Compare two dotted version strings (e.g. "0.9.2", "v3.5.2" or "v4.1.0-rc1"),
/// returning true if `a` is greater than `b`. A leading 'v' is stripped from
/// each side; non-numeric or missing segments are treated as 0.
///
/// A pre-release sorts *below* the release with the same numbers, as semver
/// says: `4.1.0-beta < 4.1.0`. Two pre-releases of the same version fall back
/// to comparing their suffixes as text, which orders the shapes actually used
/// (`alpha` < `beta` < `rc`, and `rc1` < `rc2`) correctly.
pub fn version_gt(a: &str, b: &str) -> bool {
    let (a_parts, a_pre) = version_parts(a);
    let (b_parts, b_pre) = version_parts(b);
    let max_len = a_parts.len().max(b_parts.len());

    for i in 0..max_len {
        let a_val = a_parts.get(i).copied().unwrap_or(0);
        let b_val = b_parts.get(i).copied().unwrap_or(0);
        if a_val > b_val {
            return true;
        }
        if a_val < b_val {
            return false;
        }
    }

    // Same numbers: only the pre-release suffix can separate them.
    match (a_pre.is_empty(), b_pre.is_empty()) {
        // A release beats a pre-release of the same version.
        (true, false) => true,
        (false, true) => false,
        (true, true) => false,
        (false, false) => a_pre > b_pre,
    }
}

/// Fetch the download page and resolve the version + direct URL of the
/// Windows client zip. Falls back to a generic `.zip` link (with an unknown
/// version) if the page layout doesn't match the expected "Windows" card.
async fn resolve_download_info(
    app: &tauri::AppHandle,
    network: Network,
) -> Result<(String, String), String> {
    if network == Network::Vanilla {
        // Vanilla has no published build yet — vanillarec.net lists every
        // platform as "coming soon" with dead download buttons — so the URL is
        // whatever the user configured in Settings. The UI does not offer a
        // Download action at all while this is blank.
        let cfg = config::current(app);
        let url = cfg.vanilla.client_url.trim().to_string();
        if url.is_empty() {
            return Err(
                "No Vanilla client URL is configured. Vanilla has not published a \
                 download yet; set one in Settings once it does."
                    .into(),
            );
        }
        // Parsed rather than prefix-matched: `starts_with("https://")` alone
        // says nothing about where the bytes come from, and these bytes become
        // executables. There is no build to pin a hash against, so the host is
        // the only thing that can be checked — and a URL that isn't well-formed
        // at all should fail here rather than at fetch time.
        let parsed = reqwest::Url::parse(&url)
            .map_err(|_| "The Vanilla client URL is not a valid URL.".to_string())?;
        if parsed.scheme() != "https" {
            return Err("The Vanilla client URL must start with https://".into());
        }
        if parsed.host_str().unwrap_or("").is_empty() {
            return Err("The Vanilla client URL has no host.".into());
        }
        return Ok((String::new(), url));
    }

    // ─── TEMPORARY TEST OVERRIDE — REMOVE BEFORE RELEASE ───────────────────
    // The tenwholeyears download page was shut down, so hardcode a known-good
    // client zip on the recroomarchive CDN just so the download flow can be
    // tested end-to-end. Delete this block to restore normal page resolution.
    return Ok((
        "test".to_string(),
        "https://cdn.recroomarchive.org/radium/game-client/production/toukeh24kq6w2v4lndyc4z0pblvfyj75/windows/client.zip".to_string(),
    ));
    // ───────────────────────────────────────────────────────────────────────

    #[allow(unreachable_code)]
    let html = fetch_download_page_html().await?;

    if let Some((version, raw_url)) = extract_windows_card(&html) {
        return Ok((version, resolve_link(&raw_url)));
    }

    // Fallback: any .zip link on the page, version unknown.
    let win_re = regex::Regex::new(r#"href\s*=\s*["']([^"']*windows[^"']*\.zip)["']"#)
        .map_err(|e| e.to_string())?;
    if let Some(c) = win_re.captures(&html) {
        return Ok((String::new(), resolve_link(c.get(1).unwrap().as_str())));
    }
    let zip_re = regex::Regex::new(r#"href\s*=\s*["']([^"']*\.zip)["']"#)
        .map_err(|e| e.to_string())?;
    if let Some(c) = zip_re.captures(&html) {
        return Ok((String::new(), resolve_link(c.get(1).unwrap().as_str())));
    }

    Err("Could not find a Windows download link on the download page.".into())
}

/// Check recroom.baby for a newer client build than the one currently
/// installed, returning version info and "what's new" patch notes for a
/// Steam-style update prompt.
#[tauri::command]
pub async fn check_client_update(app: tauri::AppHandle, network: Option<String>) -> Value {
    let cfg = config::current(&app);
    let network = Network::parse(network.as_deref());

    if cfg.game_exe_for(network).is_empty() {
        return json!({ "success": true, "hasUpdate": false });
    }

    // Update checking is driven by scraping the recroom.baby download page,
    // which describes Radium's client only. Vanilla installs come from a
    // user-supplied URL with no version feed to compare against.
    if network == Network::Vanilla {
        return json!({ "success": true, "hasUpdate": false, "versionKnown": false });
    }

    let html = match fetch_download_page_html().await {
        Ok(h) => h,
        Err(e) => return json!({ "success": false, "error": e }),
    };

    let (latest_version, download_url) = match extract_windows_card(&html) {
        Some((version, raw_url)) => (version, resolve_link(&raw_url)),
        None => {
            return json!({
                "success": false,
                "error": "Could not determine the latest client version."
            });
        }
    };

    let installed_version = cfg.client_version.clone();
    let version_known = !installed_version.is_empty();
    let version_is_newer = !latest_version.is_empty() && version_gt(&latest_version, &installed_version);

    // Version numbers alone can miss a silent rebuild of the same version, so
    // also compare the CDN's ETag (a real content fingerprint) against the one
    // captured at download time. This is the authoritative "did the file
    // actually change" check; the version string is just for display. Skip
    // the extra network round-trip when the version comparison alone already
    // proves an update exists.
    let etag_changed = if version_known && !version_is_newer {
        let remote_etag = fetch_remote_etag(&download_url).await;
        !cfg.client_etag.is_empty()
            && remote_etag
                .as_deref()
                .map(|e| e != cfg.client_etag)
                .unwrap_or(false)
    } else {
        false
    };

    // Clients installed before live version tracking was added (or by an older
    // launcher build) have no recorded version, so a direct comparison is
    // impossible. Recommend a sync exactly once — persisted so this doesn't
    // re-fire as a false "update available" on every single future check.
    let has_update = if version_known {
        version_is_newer || etag_changed
    } else if cfg.client_build == REQUIRED_CLIENT_BUILD
        && !latest_version.is_empty()
        && !cfg.client_version_sync_prompted
    {
        // Re-read rather than writing back the `cfg` captured at the top of
        // this function. Two awaits have happened since — the download page
        // fetch, and sometimes a HEAD for the ETag — which is seconds during
        // which the settings UI can have saved a change the user just made.
        // Saving the stale copy over it reverted that change silently. Only
        // this one flag belongs to this function.
        let _lock = config::write_lock();
        let mut updated_cfg = config::ensure_config(&app);
        updated_cfg.client_version_sync_prompted = true;
        let _ = config::save_config(&app, &updated_cfg);
        true
    } else {
        false
    };

    let patch_notes: Vec<Value> = if has_update {
        extract_patch_notes(&html)
            .into_iter()
            .filter(|n| {
                n.get("version")
                    .and_then(|v| v.as_str())
                    .map(|v| !version_known || v == latest_version || version_gt(v, &installed_version))
                    .unwrap_or(false)
            })
            .collect()
    } else {
        Vec::new()
    };

    json!({
        "success": true,
        "hasUpdate": has_update,
        "versionKnown": version_known,
        "sameVersionRebuilt": version_known && !version_is_newer && etag_changed,
        "installedVersion": installed_version,
        "latestVersion": latest_version,
        "downloadUrl": download_url,
        "patchNotes": patch_notes
    })
}

// ─── Download + extract client ──────────────────────────────────────────────

/// Download the game client zip from the CDN and extract it to the client
/// directory.
///
/// Emits `download-progress` events to the frontend during both the download
/// and extraction phases. Returns `{ success: true, exePath }` on success.
#[tauri::command]
pub async fn download_client(
    app: tauri::AppHandle,
    network: Option<String>,
) -> Result<Value, String> {
    match download_client_impl(app, Network::parse(network.as_deref())).await {
        Ok(val) => Ok(val),
        Err(err) => Ok(json!({ "success": false, "error": err })),
    }
}

async fn download_client_impl(
    app: tauri::AppHandle,
    network: Network,
) -> Result<Value, String> {
    // Reject a second concurrent download — a cancelled download keeps running
    // until its next chunk, so a quick re-click could otherwise start a second
    // writer on the same client.zip.
    if DOWNLOAD_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("A download is already in progress.".into());
    }
    let _guard = DownloadGuard;

    // Block if the game is already running.
    if game::check_game_running() {
        return Err("Cannot download or install while the game is running.".into());
    }

    // Reset cancellation/pause flags — this call either starts a fresh download
    // or resumes a paused/interrupted one, so both must be cleared.
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);
    DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);

    let cfg = config::current(&app);
    let client_dir = config::get_client_dir_for(&app, &cfg, network);
    let user_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    // Ensure directories exist.
    fs::create_dir_all(&user_data).map_err(|e| e.to_string())?;
    fs::create_dir_all(&client_dir).map_err(|e| e.to_string())?;

    let stem = zip_stem(network);
    let client_zip = user_data.join(stem);
    let part_path = user_data.join(format!("{}.part", stem));
    let meta_path = user_data.join(format!("{}.part.meta", stem));

    // A completed zip from a previous run is stale — remove it so we never
    // extract an old build. (In-progress resume state lives in the .part file.)
    if client_zip.exists() {
        let _ = fs::remove_file(&client_zip);
    }

    // ── Phase 1: Download ──────────────────────────────────────────────
    let _ = app.emit("download-progress", json!({
        "phase": "download",
        "pct": 0,
        "downloaded": 0,
        "total": 0,
        "speed": 0,
        "eta": -1
    }));

    // Resolve the current Windows client zip (and its version) from the download page.
    let (resolved_version, download_url) = resolve_download_info(&app, network).await?;

    // Belt and braces: whatever produced this URL — a scraped page, a
    // user-supplied Vanilla URL — the bytes become an executable, so they are
    // never fetched over a channel that can be rewritten in transit.
    if !download_url.starts_with("https://") {
        return Err("Refusing to download the client over an insecure URL.".into());
    }

    // Resume support: if a partial download for this exact URL already exists,
    // continue it with a byte-range request instead of starting over. The .part
    // file and its sidecar metadata survive launcher restarts, so this resumes a
    // download interrupted by a pause OR by closing the launcher entirely.
    let existing_meta = read_part_meta(&meta_path);
    let mut resume_from: u64 = 0;
    if part_path.exists() {
        if let Some(m) = &existing_meta {
            if m.url == download_url {
                resume_from = fs::metadata(&part_path).map(|md| md.len()).unwrap_or(0);
            }
        }
    }
    // A partial file we can't validate (missing/mismatched metadata) can't be
    // trusted — discard it and start clean.
    if resume_from == 0 {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&meta_path);
    }

    // No overall `.timeout()`: that would cap the whole multi-gigabyte body.
    // Stalls are caught per read in the loop below instead. `https_only` also
    // covers redirects, which the `https://` check above cannot see — a CDN
    // bouncing to plain http would otherwise be followed.
    //
    // No transparent decompression either (the crate features switch it on for
    // every client by default). Byte ranges count the bytes on the wire, so a
    // resume offset taken from a decoded file would point into the middle of
    // the encoded one — and a zip gains nothing from being gzipped again.
    let http = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(15))
        .no_gzip()
        .no_brotli()
        .build()
        .map_err(|e| e.to_string())?;

    let send = |from: u64| {
        let mut req = http.get(&download_url).header("User-Agent", BROWSER_UA);
        if from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={}-", from));
            // If-Range: the server returns 206 (continue) only if the file still
            // matches this ETag, otherwise a full 200 — so we never stitch
            // together bytes from two different builds.
            if let Some(m) = &existing_meta {
                if !m.etag.is_empty() {
                    req = req.header(reqwest::header::IF_RANGE, m.etag.clone());
                }
            }
        }
        async move {
            tokio::time::timeout(RESPONSE_TIMEOUT, req.send())
                .await
                .map_err(|_| "The download server did not respond. Try again later.".to_string())?
                .map_err(|e| format!("Download request failed: {}", e))
        }
    };

    let mut response = send(resume_from).await?;

    // 416: the partial file is already as long as the file — or longer, if the
    // build was replaced by a smaller one. That happens when a pause lands
    // between the last chunk and the end of the stream. Retrying the same range
    // can only fail the same way, so the partial is dropped and the download
    // starts over rather than leaving Resume broken for good.
    //
    // A 206 for some other range than the one asked for is treated the same
    // way. Appending it would splice the wrong bytes into the middle of the
    // zip, which only a pinned hash would catch, and only once the whole
    // download is done; without one it is extracted over the old install.
    let wrong_range = response.status() == reqwest::StatusCode::PARTIAL_CONTENT
        && parse_content_range_start(response.headers()) != Some(resume_from);
    if resume_from > 0
        && (response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE || wrong_range)
    {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&meta_path);
        resume_from = 0;
        response = send(0).await?;
    }

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP error: {}", status));
    }

    // 206 Partial Content => our range was honored, append to the .part file.
    // Anything else (200) => the server sent the whole file, so start over.
    let is_resume = status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0;
    if !is_resume {
        resume_from = 0;
    }

    // Capture the CDN's ETag for this build so future checks can detect a
    // rebuilt zip even if the version number on the download page is unchanged.
    let resolved_etag = extract_etag(response.headers());

    // For a 206 the Content-Length is only the *remaining* bytes, so derive the
    // true total from Content-Range; fall back to the stored total if needed.
    let total: u64 = if is_resume {
        parse_content_range_total(response.headers())
            .or_else(|| existing_meta.as_ref().map(|m| m.total).filter(|t| *t > 0))
            .unwrap_or(0)
    } else {
        response.content_length().unwrap_or(0)
    };

    // Persist resume metadata up front, so even a hard close on the very next
    // chunk leaves enough behind to continue from.
    write_part_meta(&meta_path, &PartMeta {
        url: download_url.clone(),
        etag: resolved_etag.clone().unwrap_or_default(),
        total,
    });

    let mut downloaded: u64 = resume_from;
    let session_start_bytes = resume_from; // for a speed/ETA based on this run only
    let start_time = std::time::Instant::now();

    // Throttle progress events: chunks can arrive hundreds of times per second,
    // and each emit is an IPC round-trip to the webview.
    const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
    let mut last_emit = emit_now_baseline(EMIT_INTERVAL);

    // Stream the response body to disk — append when resuming, otherwise create.
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let file = if is_resume {
        fs::OpenOptions::new()
            .append(true)
            .open(&part_path)
            .map_err(|e| format!("Failed to open partial file: {}", e))?
    } else {
        fs::File::create(&part_path)
            .map_err(|e| format!("Failed to create partial file: {}", e))?
    };
    // Chunks arrive a few kilobytes at a time, and each unbuffered write_all
    // was its own system call on the async worker — thousands of them per
    // gigabyte. Every early exit below drops this, which flushes it, and a
    // resume measures the .part on disk rather than trusting `downloaded`, so a
    // flush that fails on the way out costs nothing but a re-fetched tail.
    let mut file = std::io::BufWriter::with_capacity(1024 * 1024, file);

    let mut last_data = std::time::Instant::now();
    loop {
        // Waited on in short slices rather than outright. Pause and Cancel are
        // only flags, and a connection that goes quiet without closing never
        // hands back another chunk: waiting on `next()` alone left both buttons
        // dead and the download guard held until the launcher was restarted.
        let chunk_result = match tokio::time::timeout(FLAG_POLL_INTERVAL, stream.next()).await {
            Ok(Some(chunk)) => Some(chunk),
            Ok(None) => break,
            Err(_) => None,
        };

        // Cancellation wipes the partial file — the user wants to start fresh.
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&part_path);
            let _ = fs::remove_file(&meta_path);
            return Err(CANCELLED.into());
        }

        // Pause stops the loop but keeps the .part file + metadata so it can be
        // resumed (this session or after a restart). Report the paused state.
        if DOWNLOAD_PAUSED.load(Ordering::SeqCst) {
            drop(file);
            let pct = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0).min(99.0) as i64
            } else {
                -1
            };
            let _ = app.emit("download-progress", json!({
                "phase": "paused",
                "pct": pct,
                "downloaded": downloaded,
                "total": total
            }));
            return Err("Paused".into());
        }

        let Some(chunk_result) = chunk_result else {
            // Nothing arrived in this slice. Keep the .part so the next run
            // resumes, but give up on a connection that has gone silent.
            if last_data.elapsed() >= STALL_TIMEOUT {
                drop(file);
                return Err(format!(
                    "The download stalled (no data for {} seconds). Resume to continue.",
                    STALL_TIMEOUT.as_secs()
                ));
            }
            continue;
        };
        last_data = std::time::Instant::now();

        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                // Keep the .part on a network error so it can be resumed later.
                drop(file);
                return Err(format!("Download stream error: {}", e));
            }
        };

        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            return Err(format!("Failed to write chunk: {}", e));
        }

        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= EMIT_INTERVAL {
            last_emit = std::time::Instant::now();

            let elapsed = start_time.elapsed().as_secs_f64().max(0.001);
            // Speed/ETA reflect only bytes fetched this session (not resumed ones).
            let speed = (downloaded - session_start_bytes) as f64 / elapsed; // bytes/sec
            let pct = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0).min(99.0) as i64
            } else {
                -1
            };
            // saturating_sub: a server can deliver more bytes than Content-Length
            // claimed, which would otherwise wrap to a huge ETA.
            let eta = if total > 0 && speed > 0.0 {
                (total.saturating_sub(downloaded) as f64 / speed) as i64
            } else {
                -1
            };

            let _ = app.emit("download-progress", json!({
                "phase": "download",
                "pct": pct,
                "downloaded": downloaded,
                "total": total,
                "speed": speed as u64,
                "eta": eta
            }));
        }
    }

    // Checked here, unlike the early exits: the file is about to be promoted
    // and extracted, so the last megabyte has to be known to be on disk.
    file.flush().map_err(|e| format!("Failed to write chunk: {}", e))?;
    drop(file);

    if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&meta_path);
        return Err(CANCELLED.into());
    }

    // A stream that ends early without erroring (a proxy closing the connection,
    // for instance) would otherwise be promoted and extracted as a truncated
    // zip. Keep the .part so the next run resumes from here instead.
    if total > 0 && downloaded < total {
        return Err(format!(
            "Download ended early: got {} of {} bytes. Resume to finish it.",
            downloaded, total
        ));
    }

    // Download finished — promote the completed .part to the real zip and drop
    // the now-obsolete resume metadata.
    fs::rename(&part_path, &client_zip)
        .map_err(|e| format!("Failed to finalize download: {}", e))?;
    let _ = fs::remove_file(&meta_path);

    // Verify the pin before anything is extracted or the old install is
    // touched. Only Radium has a build this launcher pins; a Vanilla zip comes
    // from a URL the user supplied, so there is nothing to compare it against.
    if network == Network::Radium {
        if let Some(expected) = EXPECTED_CLIENT_SHA256 {
            let _ = app.emit("download-progress", json!({
                "phase": "extract",
                "pct": 0,
                "status": "Verifying download..."
            }));
            let zip_for_hash = client_zip.clone();
            let actual = tokio::task::spawn_blocking(move || sha256_file(&zip_for_hash))
                .await
                .map_err(|e| format!("Verification task failed: {}", e))??;
            if !digest_matches(&actual, expected) {
                // The bytes are not the build this launcher was tested with, so
                // they do not get to become executables on the user's disk.
                let _ = fs::remove_file(&client_zip);
                return Err(format!(
                    "The downloaded client does not match the expected build \
                     (expected {}, got {}). Nothing was installed.",
                    expected, actual
                ));
            }
        }
    }

    // ── Phase 2: Extract ───────────────────────────────────────────────
    let _ = app.emit("download-progress", json!({
        "phase": "extract",
        "pct": 0,
        "status": "Preparing extraction..."
    }));

    // Extraction is minutes of synchronous file I/O — `std::io::copy` over
    // gigabytes, thousands of times. Run directly in this `async fn` it held a
    // tokio worker for the whole install, starving every other command and the
    // thumbnail pipeline sharing that runtime. `spawn_blocking` puts it on the
    // blocking pool where it belongs; the app handle is cloned in so progress
    // events still reach the frontend from there.
    let extracted = {
        let app = app.clone();
        let client_dir = client_dir.clone();
        let client_zip = client_zip.clone();
        tokio::task::spawn_blocking(move || {
            extract_client_zip(&client_zip, &client_dir, &mut |progress| {
                let _ = app.emit("download-progress", progress);
            })
        })
        .await
        .map_err(|e| format!("Extraction task failed: {}", e))?
    };

    // Whatever happened, the zip has done its job or can't: a fresh download
    // removes any leftover one before it starts, so keeping a multi-gigabyte
    // file around after a failure only costs the user the disk space.
    let _ = fs::remove_file(&client_zip);

    if let Err(e) = extracted {
        // One that stopped partway has removed the old install and cleared
        // what landed of the new one (see `extract_client_zip`), while the
        // config still names the old exe; one that stopped earlier left that
        // install alone. `forget_missing_install` tells the two apart.
        forget_missing_install(&app, network);
        return Err(e);
    }

    // Find RecRoom_ScreenMode.bat in the extracted files.
    let bat_path = game::find_game_exe(&client_dir).unwrap_or_default();

    // Save the bat path and the installed client build id to config.
    {
        let _lock = config::write_lock();
        let mut cfg = config::ensure_config(&app);
        let exe = if bat_path.is_empty() {
            cfg.game_exe_for(network).to_string()
        } else {
            bat_path.clone()
        };
        // Always assign together so the fields never desync: if the version
        // couldn't be scraped this time, clear it rather than leaving a
        // stale value paired with the newly-downloaded build's ETag.
        cfg.set_client_install(
            network,
            exe,
            REQUIRED_CLIENT_BUILD.to_string(),
            resolved_version,
            resolved_etag.unwrap_or_default(),
        );
        let _ = config::save_config(&app, &cfg);
    }

    let _ = app.emit("download-progress", json!({
        "phase": "done",
        "pct": 100
    }));

    Ok(json!({
        "success": true,
        "exePath": bat_path
    }))
}

/// Largest total the extracted client may occupy.
///
/// Nothing upstream promises a sane archive: the Radium zip is resolved from a
/// scraped page, and the Vanilla one is whatever URL the user typed into
/// Settings. Without a ceiling an archive that decompresses to far more than it
/// claims fills the disk before anything notices — the classic zip bomb, which
/// costs a few bytes of archive per gigabyte written.
///
/// The real client is a few gigabytes, so this leaves generous headroom while
/// still bounding the damage.
const MAX_EXTRACTED_BYTES: u64 = 32 * 1024 * 1024 * 1024;

/// Most entries the archive may hold.
const MAX_ENTRIES: usize = 200_000;

/// Clear the recorded install for `network` if its executable is gone.
///
/// Used after an extraction that failed or was cancelled. One that stopped
/// before touching the old install leaves its exe in place, and the record
/// stands; one that stopped partway has removed it, and a record naming a
/// missing exe would otherwise carry the old build id and version into the
/// next install check.
fn forget_missing_install(app: &tauri::AppHandle, network: Network) {
    let _lock = config::write_lock();
    let mut cfg = config::ensure_config(app);
    let exe = cfg.game_exe_for(network);
    if exe.is_empty() || Path::new(exe).exists() {
        return;
    }
    cfg.clear_client_install(network);
    let _ = config::save_config(app, &cfg);
}

/// Extract the downloaded zip into `client_dir`, emitting progress as it goes.
///
/// Fails with [`CANCELLED`] when a cancel is seen, and with a message for
/// anything else. Nothing is touched until the archive has been checked, and
/// the old install is left alone if a cancel arrives before then. Past that
/// point the old install is gone, so a failure or cancel also removes what
/// this run had written: a half-extracted client is not one anybody can play,
/// and left in place it would be found and reported as installed. Runs on the
/// blocking pool — see the call site. `progress` is handed each
/// `download-progress` payload.
fn extract_client_zip(
    client_zip: &Path,
    client_dir: &str,
    progress: &mut dyn FnMut(Value),
) -> Result<(), String> {
    // Open and parse the archive BEFORE touching the existing install. Clearing
    // first meant a corrupt or truncated download wiped a working client and
    // then failed, leaving the user with nothing to launch and nothing to
    // roll back to.
    let zip_file =
        fs::File::open(client_zip).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|e| format!("Failed to read zip archive: {}", e))?;

    let entry_count = archive.len();
    if entry_count > MAX_ENTRIES {
        return Err(format!(
            "Refusing to extract: the archive declares {} entries, over the {} limit.",
            entry_count, MAX_ENTRIES
        ));
    }

    // The declared total is only a claim — it is checked again against bytes
    // actually written below — but rejecting up front avoids clearing a working
    // install for an archive that was never going to fit.
    let declared: u64 = (0..entry_count)
        .filter_map(|i| archive.by_index_raw(i).ok().map(|e| e.size()))
        .sum();
    if declared > MAX_EXTRACTED_BYTES {
        return Err(format!(
            "Refusing to extract: the archive expands to {}, over the {} limit.",
            human_bytes(declared),
            human_bytes(MAX_EXTRACTED_BYTES)
        ));
    }

    // Last moment a cancel can leave the old install as it was. One that came
    // in while the download was being verified would otherwise be noticed only
    // at the first entry below — after that install had been deleted.
    if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }

    // The archive is readable and within budget, so the old install can go.
    //
    // A `false` here — the folder exists but holds nothing recognisable, e.g.
    // the remains of a run cancelled before the exe was written — is not worth
    // refusing over: extraction overwrites by name, and a folder the launcher
    // doesn't recognise as an install is not one it reports as installed
    // either. Deleting it anyway is the behaviour the guard exists to prevent.
    if Path::new(client_dir).exists() {
        let _ = safe_clear_client_dir(client_dir);
    }
    fs::create_dir_all(client_dir)
        .map_err(|e| format!("Failed to create client dir: {}", e))?;

    // Record what this archive is about to put in the folder before any of it
    // lands, so a cancel partway through — and every later uninstall or
    // reinstall — removes exactly these and nothing that was already there.
    // See [`INSTALL_MANIFEST`].
    write_install_manifest(Path::new(client_dir), &top_level_entries(&mut archive))
        .map_err(|e| format!("Failed to record the install: {}", e))?;

    // From here on the old install is gone. If this run stops partway, what it
    // wrote goes too — the manifest above names exactly that — rather than
    // staying behind as a client the launcher would find and report installed.
    let result = write_entries(&mut archive, client_dir, progress);
    if result.is_err() {
        let _ = safe_clear_client_dir(client_dir);
    }
    result
}

/// Write every entry of `archive` into `client_dir`, emitting progress. Stops
/// with [`CANCELLED`] when a cancel is seen. See [`extract_client_zip`].
fn write_entries<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    client_dir: &str,
    progress: &mut dyn FnMut(Value),
) -> Result<(), String> {
    const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

    let entry_count = archive.len();
    let mut written: u64 = 0;
    let mut last_emit = emit_now_baseline(EMIT_INTERVAL);

    for i in 0..entry_count {
        // Honor cancellation during extraction too — previously Cancel only
        // worked during the download phase.
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }

        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

        let out_path = match entry.enclosed_name() {
            // The archive does not get to rewrite the launcher's own record of
            // what it installed; that record decides what an uninstall deletes.
            Some(p) if first_component(&p).is_some_and(|n| is_manifest_name(&n)) => continue,
            Some(p) => Path::new(client_dir).join(p),
            None => continue, // skip entries with unsafe paths
        };

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir {:?}: {}", out_path, e))?;
        } else {
            // Ensure parent directory exists.
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir: {}", e))?;
            }

            let mut out_file = fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create file {:?}: {}", out_path, e))?;

            // Copy through a capped reader rather than trusting `entry.size()`:
            // the header is written by whoever built the archive and a bomb
            // simply lies in it, so the limit has to apply to bytes that
            // actually land on disk.
            let remaining = MAX_EXTRACTED_BYTES - written;
            let copied = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut out_file)
                .map_err(|e| format!("Failed to write extracted data: {}", e))?;
            if copied > remaining {
                drop(out_file);
                return Err(format!(
                    "Refusing to extract: the archive expands past the {} limit.",
                    human_bytes(MAX_EXTRACTED_BYTES)
                ));
            }
            written += copied;
        }

        // Emit extraction progress (throttled; a zip can hold thousands of entries).
        if last_emit.elapsed() >= EMIT_INTERVAL || i + 1 == entry_count {
            last_emit = std::time::Instant::now();
            let pct = ((i + 1) as f64 / entry_count as f64 * 100.0) as i64;
            let entry_name = entry.name().trim_end_matches('/').to_string();
            // Just the file/folder name (drop the archive path) for a compact,
            // readable "current file" display.
            let entry_base = entry_name
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_string();
            progress(json!({
                "phase": "extract",
                "pct": pct,
                "status": format!("Extracting: {} ({}/{})", entry_name, i + 1, entry_count),
                "entry": entry_base,
                "done": i + 1,
                "totalEntries": entry_count
            }));
        }
    }

    Ok(())
}

/// Round a byte count for an error message the user will read.
fn human_bytes(n: u64) -> String {
    const GB: u64 = 1024 * 1024 * 1024;
    const MB: u64 = 1024 * 1024;
    if n >= GB {
        format!("{:.1} GB", n as f64 / GB as f64)
    } else {
        format!("{} MB", n / MB)
    }
}

// ─── Cancel download ────────────────────────────────────────────────────────

/// Signal cancellation of the current download. The download loop checks this
/// flag between chunks and will abort (deleting the partial file) if set.
///
/// If nothing is actively downloading — e.g. the user cancels a *paused*
/// download — there is no loop to observe the flag, so the partial file and its
/// resume metadata are removed here directly.
#[tauri::command(async)]
pub fn cancel_download(app: tauri::AppHandle, network: Option<String>) {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
    DOWNLOAD_PAUSED.store(false, Ordering::SeqCst);
    if !DOWNLOAD_IN_PROGRESS.load(Ordering::SeqCst) {
        if let Ok(user_data) = app.path().app_data_dir() {
            let stem = zip_stem(Network::parse(network.as_deref()));
            let _ = fs::remove_file(user_data.join(format!("{}.part", stem)));
            let _ = fs::remove_file(user_data.join(format!("{}.part.meta", stem)));
        }
    }
}

/// Signal a pause of the current download. The loop checks this flag between
/// chunks and stops, leaving the partial file in place so it can be resumed by
/// calling `download_client` again.
#[tauri::command(async)]
pub fn pause_download() {
    DOWNLOAD_PAUSED.store(true, Ordering::SeqCst);
}

/// Report whether an interrupted download can be resumed (a valid `.part` file
/// exists on disk), along with how many bytes are already downloaded and the
/// expected total. Used on launcher startup to offer to continue a download that
/// was in progress when the launcher was last closed.
#[tauri::command]
pub async fn resumable_download_info(app: tauri::AppHandle, network: Option<String>) -> Value {
    let user_data = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => return json!({ "resumable": false }),
    };
    let stem = zip_stem(Network::parse(network.as_deref()));
    let part_path = user_data.join(format!("{}.part", stem));
    let meta_path = user_data.join(format!("{}.part.meta", stem));

    if !part_path.exists() {
        return json!({ "resumable": false });
    }
    let downloaded = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    if downloaded == 0 {
        return json!({ "resumable": false });
    }
    let total = read_part_meta(&meta_path).map(|m| m.total).unwrap_or(0);

    json!({
        "resumable": true,
        "downloaded": downloaded,
        "total": total
    })
}

// ─── Uninstall client ───────────────────────────────────────────────────────

/// Remove the game client directory and clear the saved exe path from config.
#[tauri::command]
pub async fn uninstall_client(
    app: tauri::AppHandle,
    network: Option<String>,
) -> Result<Value, String> {
    match uninstall_client_impl(app, Network::parse(network.as_deref())).await {
        Ok(val) => Ok(val),
        Err(err) => Ok(json!({ "success": false, "error": err })),
    }
}

async fn uninstall_client_impl(
    app: tauri::AppHandle,
    network: Network,
) -> Result<Value, String> {
    if game::check_game_running() {
        return Err("Cannot uninstall while the game is running.".into());
    }
    // A running download or extraction is writing into the folder this would
    // delete, and would then record an install that is no longer there.
    if DOWNLOAD_IN_PROGRESS.load(Ordering::SeqCst) {
        return Err("Cannot uninstall while a download is in progress.".into());
    }

    let cfg = config::current(&app);
    let client_dir = config::get_client_dir_for(&app, &cfg, network);

    if Path::new(&client_dir).exists() {
        // Deleting a multi-gigabyte install is seconds of synchronous I/O, so
        // it goes to the blocking pool rather than parking a tokio worker.
        let dir = client_dir.clone();
        let cleared = tokio::task::spawn_blocking(move || safe_clear_client_dir(&dir))
            .await
            .map_err(|e| format!("Uninstall task failed: {}", e))?
            .map_err(|e| format!("Failed to clear client dir: {}", e))?;

        // The folder is there but holds nothing this launcher recognises as a
        // game install, so the safety guard refused to delete anything. Say so
        // and leave the config alone: clearing it here is what used to leave
        // the UI reporting "not installed" over gigabytes still on disk.
        if !cleared {
            return Err(format!(
                "Nothing was removed: '{}' holds no recognisable game files, so it \
                 was left untouched in case it is not a client folder. Delete it \
                 yourself if it is.",
                client_dir
            ));
        }
    }

    // Clear relevant config fields.
    let _lock = config::write_lock();
    let mut cfg = config::ensure_config(&app);
    cfg.clear_client_install(network);
    match network {
        Network::Radium => cfg.defender_excluded = false,
        Network::Vanilla => cfg.vanilla.defender_excluded = false,
    }
    config::save_config(&app, &cfg)?;

    Ok(json!({ "success": true }))
}

// ─── Check install ──────────────────────────────────────────────────────────

/// Check whether the game client is installed and return its status.
///
/// Verifies that the saved `gameExePath` exists and lives inside the client
/// directory. Falls back to searching for `RecRoom_ScreenMode.bat` if the
/// config path is stale.
#[tauri::command]
pub async fn check_install(
    app: tauri::AppHandle,
    network: Option<String>,
) -> Result<Value, String> {
    let cfg = config::current(&app);
    let network = Network::parse(network.as_deref());
    let client_dir = config::get_client_dir_for(&app, &cfg, network);

    let mut exe_path = cfg.game_exe_for(network).to_string();

    // Verify the configured path is valid and inside client_dir.
    if !exe_path.is_empty()
        && (!config::path_is_inside_dir(&exe_path, &client_dir) || !Path::new(&exe_path).exists())
    {
        exe_path = String::new();
    }

    // Try to locate the bat file if the config path was empty or invalid.
    // This walks the install tree, so on the miss path — which is the one that
    // costs anything — it runs on the blocking pool. The hit path above does no
    // I/O beyond two `exists()` calls and stays here.
    if exe_path.is_empty() {
        let dir = client_dir.clone();
        exe_path = tokio::task::spawn_blocking(move || game::find_game_exe(&dir))
            .await
            .map_err(|e| format!("Install scan failed: {}", e))?
            .unwrap_or_default();
    }

    let installed = !exe_path.is_empty() && Path::new(&exe_path).exists();
    let is_running = game::check_game_running();

    // A client installed under a different build id (or with no recorded build,
    // e.g. installed by an older launcher) is outdated and needs re-downloading.
    // Only Radium has a launcher-tracked build id; a Vanilla install comes from
    // a user-supplied zip with no build feed, so it is never flagged outdated.
    let client_outdated = installed
        && network == Network::Radium
        && cfg.client_build != REQUIRED_CLIENT_BUILD;

    Ok(json!({
        "installed": installed,
        "exePath": exe_path,
        "clientDir": client_dir,
        "isRunning": is_running,
        "clientOutdated": client_outdated,
        "clientVersion": cfg.client_version_for(network),
        "network": network.as_str(),
        // A client folder the launcher renamed out of the way because it held
        // another network's client. Reported so the UI can tell the user where
        // those files went instead of silently leaving them on disk.
        "orphanedClientDir": cfg.orphaned_client_dir,
        // Surfaced so the frontend can log the concrete build mismatch behind an
        // "outdated" verdict instead of an opaque message.
        "clientBuild": cfg.client_build_for(network),
        "requiredBuild": REQUIRED_CLIENT_BUILD
    }))
}

// ─── Open client folder ─────────────────────────────────────────────────────

/// Open the game client directory in the system file explorer.
///
/// `explorer.exe` is named by its full path rather than resolved through
/// `PATH` (which searches the current directory first on Windows), so a file
/// dropped beside the launcher cannot stand in for it.
#[tauri::command]
pub async fn open_client_folder(app: tauri::AppHandle, network: Option<String>) -> bool {
    let cfg = config::current(&app);
    let client_dir = config::get_client_dir_for(&app, &cfg, Network::parse(network.as_deref()));

    if !Path::new(&client_dir).exists() {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        // explorer.exe lives beside System32 rather than in it; the helper's
        // fallback covers an install that doesn't match either spelling.
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let explorer = format!(r"{}\explorer.exe", root.trim_end_matches('\\'));
        let explorer = if Path::new(&explorer).exists() {
            explorer
        } else {
            "explorer".to_string()
        };
        let _ = std::process::Command::new(explorer).arg(&client_dir).spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&client_dir).spawn();
    }
    true
}

// ─── Select folder dialog ───────────────────────────────────────────────────

/// Show a native folder picker dialog and return the selected path.
#[tauri::command]
pub async fn select_folder(network: Option<String>) -> Result<Option<String>, String> {
    let title = match Network::parse(network.as_deref()) {
        Network::Radium => "Select Radium Client Install Folder",
        Network::Vanilla => "Select Vanilla Client Install Folder",
    };
    // The dialog blocks until the user answers, which can be minutes. On the
    // blocking pool, so it doesn't hold an async worker other commands and the
    // thumbnail pipeline are queued behind.
    let folder = tokio::task::spawn_blocking(move || rfd::FileDialog::new().set_title(title).pick_folder())
        .await
        .map_err(|e| format!("Folder picker failed: {}", e))?;

    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

// ─── Default client directory ───────────────────────────────────────────────

/// Return the default client directory path (`<app_data_dir>/client`).
#[tauri::command(async)]
pub fn get_default_client_dir(app: tauri::AppHandle, network: Option<String>) -> String {
    let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let folder = config::default_client_folder(Network::parse(network.as_deref()));
    app_data_dir.join(folder).to_string_lossy().to_string()
}

/// Distinctive Rec Room game files. The presence of any one marks a directory
/// as a game installation. Kept narrow (exe / data folders / launch scripts) so
/// unrelated folders are never mistaken for an install.
const SENTINEL_FILES: [&str; 7] = [
    "Recroom_Release.exe",
    "Recroom_Release_Data",
    "RecRoom.exe",
    "RecRoom_ScreenMode.bat",
    "RecRoom_VR.bat",
    "RecRoom_VRMode.bat",
    "RecRoom_Data",
];

/// Returns true if `path` (or any subdirectory up to `depth` 4) contains a
/// recognized Rec Room game file. The recursion mirrors `game::find_game_exe`,
/// so a client that extracted into a nested subfolder is still detected.
fn dir_contains_game_files(path: &Path, depth: u32) -> bool {
    if depth > 4 || !path.is_dir() {
        return false;
    }

    for file_name in &SENTINEL_FILES {
        if path.join(file_name).exists() {
            return true;
        }
    }

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && dir_contains_game_files(&p, depth + 1) {
                return true;
            }
        }
    }

    false
}

/// Returns true only if the given directory contains at least one recognized
/// Rec Room game file (at any depth) — ensuring we never accidentally clear a
/// folder that isn't actually a game installation.
pub fn is_game_install_dir(client_dir: &str) -> bool {
    let path = Path::new(client_dir);
    if !path.exists() {
        // Non-existent directories are safe to treat as empty install targets.
        return true;
    }
    dir_contains_game_files(path, 0)
}

/// Whether `dir` is broad enough that operating on it would reach far beyond a
/// game install — a drive root, a system directory, or a well-known user
/// folder.
///
/// Deletion is already protected by the sentinel scan above, but that check
/// deliberately passes for a *non-existent* directory and says nothing about
/// scope. Adding a Windows Defender exclusion is the opposite problem: the
/// directory always exists, and the danger is picking one so broad that the
/// exclusion disables real-time protection for most of the disk. Choosing `C:\`
/// as the install folder is a couple of clicks in the folder picker.
pub fn is_overly_broad_dir(dir: &str) -> bool {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return true;
    }

    let normalized = trimmed.replace('/', "\\");
    let without_trailing = normalized.trim_end_matches('\\');

    // "C:", "C:\" or a bare UNC share root.
    if without_trailing.len() <= 2 || without_trailing == "\\\\" {
        return true;
    }

    let lower = without_trailing.to_lowercase();

    // Any directory this shallow is a top-level system or profile folder.
    const DENY_SUFFIXES: &[&str] = &[
        "\\windows",
        "\\program files",
        "\\program files (x86)",
        "\\programdata",
        "\\users",
        "\\users\\public",
        "\\system32",
        "\\appdata",
        "\\appdata\\local",
        "\\appdata\\locallow",
        "\\appdata\\roaming",
        "\\appdata\\local\\temp",
    ];
    if DENY_SUFFIXES.iter().any(|s| lower.ends_with(s)) {
        return true;
    }

    // A user's profile root and its common folders: "C:\Users\<name>" is three
    // components, so anything at or above that depth under Users is too broad.
    let components: Vec<&str> = lower
        .trim_start_matches('\\')
        .split('\\')
        .filter(|c| !c.is_empty())
        .collect();
    if components.len() <= 2 && components.first().map(|c| c.contains(':')).unwrap_or(false) {
        // e.g. "c:\downloads" — a top-level folder on a drive.
        return true;
    }
    if components.len() <= 3 && components.get(1).map(|c| *c == "users").unwrap_or(false) {
        // e.g. "c:\users\abdullah"
        return true;
    }
    // The profile's own well-known folders: Downloads and the Desktop are
    // where downloaded executables land, so they are the last places real-time
    // protection should be switched off for.
    const PROFILE_FOLDERS: [&str; 8] = [
        "desktop", "documents", "downloads", "music", "pictures", "videos", "onedrive", "saved games",
    ];
    if components.len() == 4
        && components[1] == "users"
        && PROFILE_FOLDERS.contains(&components[3])
    {
        return true;
    }

    false
}

/// The launcher's record of what an extraction put in the client folder, kept
/// in that folder: one line per top-level file or folder the archive created.
///
/// Clearing an install used to mean guessing. It deleted a fixed list of
/// Unity file names, and then any subfolder with a Rec Room executable
/// anywhere up to four levels down — so an install folder pointed at, say,
/// `D:\Games`, which is a couple of clicks in the folder picker, would have
/// taken `D:\Games\SteamLibrary` with it on the first download or uninstall,
/// because the real Rec Room sits in `steamapps\common` underneath. With this
/// file an install removes exactly what it added. The old guesswork is kept,
/// narrowed, only for installs made before the file existed.
const INSTALL_MANIFEST: &str = ".radium-install";

/// Whether `name` is the manifest itself. Case-blind, as Windows paths are:
/// an archive entry spelled `.RADIUM-INSTALL` would land on the same file.
fn is_manifest_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(INSTALL_MANIFEST)
}

/// The first component of an archive path, if it is a plain name.
fn first_component(path: &Path) -> Option<String> {
    match path.components().next()? {
        std::path::Component::Normal(name) => Some(name.to_string_lossy().to_string()),
        _ => None,
    }
}

/// Every distinct top-level name the archive will create, in archive order.
fn top_level_entries<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else { continue };
        let Some(name) = entry.enclosed_name().as_deref().and_then(first_component) else { continue };
        if !is_manifest_name(&name) && seen.insert(name.to_lowercase()) {
            out.push(name);
        }
    }
    out
}

/// A manifest line that names a single entry directly inside the client
/// folder: no separators, no drive, no `.` or `..`. Anything else is ignored
/// on read, so a damaged or hand-edited manifest can never reach outside it.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !is_manifest_name(name)
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(|c| c.is_control())
}

fn write_install_manifest(dir: &Path, entries: &[String]) -> std::io::Result<()> {
    let mut text = String::new();
    for name in entries.iter().filter(|n| is_plain_name(n)) {
        text.push_str(name);
        text.push('\n');
    }
    fs::write(dir.join(INSTALL_MANIFEST), text)
}

/// The recorded entries, or `None` for an install made before the manifest
/// existed (or one whose manifest can't be read).
fn read_install_manifest(dir: &Path) -> Option<Vec<String>> {
    let text = fs::read_to_string(dir.join(INSTALL_MANIFEST)).ok()?;
    Some(
        text.lines()
            .map(str::trim)
            .filter(|n| is_plain_name(n))
            .map(str::to_string)
            .collect(),
    )
}

/// Remove one entry inside the client folder, file or folder alike. A link is
/// removed as a link: `remove_dir_all` on a junction would otherwise follow it
/// out of the folder.
fn remove_entry(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// Whether a launch target or the game's data folder sits directly in `dir`.
/// No recursion: this decides whether `dir` itself is a nested copy of the
/// client, not whether a game is somewhere beneath it.
fn dir_is_client_root(dir: &Path) -> bool {
    SENTINEL_FILES.iter().any(|name| dir.join(name).exists())
}

/// Targeted cleanup function that deletes only Rec Room game client files and
/// directories, ensuring unrelated user files (like parent project folders)
/// are left completely untouched.
///
/// Returns `Ok(false)` — having deleted nothing — when the target directory
/// exists but holds no recognisable game files. That is the primary guard
/// against the "reinstall deletes parent folder" bug class, and the caller has
/// to know it fired: `uninstall_client` used to report plain success here,
/// clear the config, and leave the UI saying "not installed" over a client
/// still sitting on disk. `Ok(true)` means the directory was a game install
/// (or was already gone) and has been cleared.
fn safe_clear_client_dir(client_dir: &str) -> std::io::Result<bool> {
    let path = Path::new(client_dir);
    if !path.exists() {
        return Ok(true);
    }

    // An install this launcher recorded: remove exactly what it put there.
    // See [`INSTALL_MANIFEST`].
    if let Some(entries) = read_install_manifest(path) {
        for name in &entries {
            remove_entry(&path.join(name));
        }
        let _ = fs::remove_file(path.join(INSTALL_MANIFEST));
        return Ok(true);
    }

    // Safety guard: abort if this directory does not look like a game install.
    if !is_game_install_dir(client_dir) {
        // The directory is not empty but has no game files — do not touch it.
        return Ok(false);
    }

    let game_files = [
        "Recroom_Release.exe",
        "Recroom_Release_Data",
        "GameAssembly.dll",
        "steam_appid.txt",
        "RecRoom.exe",
        "UnityPlayer.dll",
        "UnityCrashHandler64.exe",
        "Radeon.Core.BasePatch.dll",
        "RecRoom_ScreenMode.bat",
        "RecRoom_VR.bat",
        "RecRoom_VRMode.bat",
        "RecRoom_Data",
        "MonoBleedingEdge",
        "BepInEx",
        "dotnet",
        "winhttp.dll",
        "doorstop_config.ini",
        "changelog.txt",
    ];

    for file_name in &game_files {
        let file_path = path.join(file_name);
        if file_path.exists() {
            if file_path.is_dir() {
                let _ = fs::remove_dir_all(&file_path);
            } else {
                let _ = fs::remove_file(&file_path);
            }
        }
    }

    // Some client builds extract into a subfolder rather than directly into the
    // client dir. Remove an immediate subdirectory only when it is itself the
    // root of a client — the game's files directly inside it. This used to
    // remove any subfolder with a game *somewhere* beneath it, four levels
    // deep, which is a Steam library holding the real Rec Room.
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let sub = entry.path();
            let is_real_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_real_dir && dir_is_client_root(&sub) {
                let _ = fs::remove_dir_all(&sub);
            }
        }
    }

    Ok(true)
}

#[cfg(test)]
mod clear_tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("radium-clear-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        fs::write(path, b"stub").expect("file");
    }

    /// The case that used to delete a Steam library: the install folder was
    /// pointed at a parent folder, and the real Rec Room sits several levels
    /// down in it. Reinstalling or uninstalling must not touch that tree.
    #[test]
    fn a_game_nested_deep_in_a_sibling_folder_is_not_deleted() {
        let dir = temp_dir("steam");
        touch(&dir.join("RecRoom.exe"));
        let steam_game = dir.join("SteamLibrary/steamapps/common/Rec Room/Recroom_Release.exe");
        touch(&steam_game);
        touch(&dir.join("Photos/holiday.jpg"));

        assert!(safe_clear_client_dir(&dir.to_string_lossy()).expect("clear"));
        assert!(!dir.join("RecRoom.exe").exists(), "the client itself goes");
        assert!(steam_game.exists(), "a game four levels down in another folder stays");
        assert!(dir.join("Photos/holiday.jpg").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A client that extracted into a subfolder of its own is still cleared.
    #[test]
    fn a_client_nested_one_level_down_is_still_cleared() {
        let dir = temp_dir("nested");
        touch(&dir.join("client-build/RecRoom.exe"));
        touch(&dir.join("client-build/RecRoom_Data/level0"));

        assert!(safe_clear_client_dir(&dir.to_string_lossy()).expect("clear"));
        assert!(!dir.join("client-build").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// With a manifest, exactly the recorded entries go — including ones the
    /// old name list never knew — and everything else stays.
    #[test]
    fn a_recorded_install_removes_exactly_what_it_added() {
        let dir = temp_dir("manifest");
        touch(&dir.join("Recroom_Release.exe"));
        touch(&dir.join("Recroom_Release_Data/globalgamemanagers"));
        touch(&dir.join("some_new_runtime.dll"));
        touch(&dir.join("UnityPlayer.dll")); // not recorded: someone else's
        touch(&dir.join("notes.txt"));
        write_install_manifest(
            &dir,
            &["Recroom_Release.exe".into(), "Recroom_Release_Data".into(), "some_new_runtime.dll".into()],
        )
        .expect("manifest");

        assert!(safe_clear_client_dir(&dir.to_string_lossy()).expect("clear"));
        assert!(!dir.join("Recroom_Release.exe").exists());
        assert!(!dir.join("Recroom_Release_Data").exists());
        assert!(!dir.join("some_new_runtime.dll").exists());
        assert!(dir.join("UnityPlayer.dll").exists(), "not in the manifest, not ours");
        assert!(dir.join("notes.txt").exists());
        assert!(!dir.join(INSTALL_MANIFEST).exists(), "the record goes with the install");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A damaged or hand-edited manifest can never name anything outside the
    /// client folder.
    #[test]
    fn manifest_lines_cannot_reach_outside_the_folder() {
        let root = temp_dir("escape");
        let dir = root.join("client");
        touch(&root.join("keep.txt"));
        touch(&dir.join("RecRoom.exe"));
        fs::write(
            dir.join(INSTALL_MANIFEST),
            "..\n../keep.txt\n..\\keep.txt\nC:\\Windows\n.\n\nRecRoom.exe\n",
        )
        .expect("manifest");

        assert_eq!(read_install_manifest(&dir), Some(vec!["RecRoom.exe".to_string()]));
        assert!(safe_clear_client_dir(&dir.to_string_lossy()).expect("clear"));
        assert!(root.join("keep.txt").exists());
        assert!(!dir.join("RecRoom.exe").exists());

        let _ = fs::remove_dir_all(&root);
    }

    /// The manifest is built from the archive itself: one entry per top-level
    /// name, and never the manifest's own name, so a hostile archive can't
    /// plant a record of its choosing.
    #[test]
    fn top_level_entries_come_from_the_archive() {
        use std::io::Cursor;
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for name in [
                "Recroom_Release.exe",
                "Recroom_Release_Data/a.assets",
                "Recroom_Release_Data/b.assets",
                "recroom_release_data/c.assets",
                ".radium-install",
                ".RADIUM-INSTALL/x",
                "../escape.txt",
            ] {
                zip.start_file(name, opts).expect("entry");
                zip.write_all(b"x").expect("bytes");
            }
            zip.finish().expect("finish");
        }
        let mut archive = zip::ZipArchive::new(Cursor::new(buf.into_inner())).expect("archive");
        assert_eq!(
            top_level_entries(&mut archive),
            vec!["Recroom_Release.exe".to_string(), "Recroom_Release_Data".to_string()]
        );
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;

    /// The known SHA-256 of the empty input, so the wiring is checked against a
    /// value that does not come from this code.
    const EMPTY_SHA256: &str =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn hashing_a_file_and_hashing_bytes_agree() {
        let dir = std::env::temp_dir().join(format!("radium-hash-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("payload.bin");
        // Larger than the 1 MB read buffer, so the chunked loop is exercised
        // rather than a single read.
        let payload: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&path, &payload).expect("write");

        assert_eq!(sha256_file(&path).expect("hash"), sha256_of(&payload));

        fs::write(&path, b"").expect("write empty");
        assert_eq!(sha256_file(&path).expect("hash"), EMPTY_SHA256);
        assert_eq!(sha256_of(b""), EMPTY_SHA256);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_digest_matches_however_the_publisher_spelled_it() {
        // GitHub publishes `sha256:<hex>`; a hash pasted from certutil comes
        // back uppercase and padded with whitespace. Both name the same bytes.
        let actual = EMPTY_SHA256;
        assert!(digest_matches(actual, EMPTY_SHA256));
        assert!(digest_matches(actual, &format!("sha256:{}", EMPTY_SHA256)));
        assert!(digest_matches(actual, &EMPTY_SHA256.to_uppercase()));
        assert!(digest_matches(actual, &format!("  sha256:{}  ", EMPTY_SHA256)));

        // And a different file must not pass.
        assert!(!digest_matches(actual, &sha256_of(b"x")));
        assert!(!digest_matches(actual, ""));
    }

    #[test]
    fn the_pinned_client_hash_is_well_formed_if_it_is_set() {
        // A typo here would reject every download with a confusing mismatch,
        // so the shape is checked even while the pin is unset.
        if let Some(pin) = EXPECTED_CLIENT_SHA256 {
            assert_eq!(pin.len(), 64, "a SHA-256 is 64 hex characters");
            assert!(
                pin.chars().all(|c| c.is_ascii_hexdigit()),
                "the pin must be hex"
            );
            assert_eq!(pin, pin.to_lowercase(), "store the pin lowercase");
        }
    }
}

#[cfg(test)]
mod extraction_budget_tests {
    use super::*;

    #[test]
    fn the_budget_leaves_room_for_a_real_client() {
        // The client is a few gigabytes; a ceiling under that would reject
        // every legitimate download, which is a worse failure than the one this
        // guards against.
        const { assert!(MAX_EXTRACTED_BYTES >= 16 * 1024 * 1024 * 1024) };
        const { assert!(MAX_ENTRIES >= 100_000) };
    }

    #[test]
    fn sizes_are_reported_in_units_a_person_reads() {
        assert_eq!(human_bytes(MAX_EXTRACTED_BYTES), "32.0 GB");
        assert_eq!(human_bytes(512 * 1024 * 1024), "512 MB");
        assert_eq!(human_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }
}

#[cfg(test)]
mod extraction_tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("radium-extract-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A zip of `entries`, stored rather than deflated so a test can find an
    /// entry's bytes in the file and damage them.
    fn build_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).expect("zip file"));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            zip.start_file(*name, options).expect("start entry");
            zip.write_all(data).expect("write entry");
        }
        zip.finish().expect("finish zip");
    }

    #[test]
    fn a_good_archive_is_extracted_and_recorded() {
        let root = temp_dir("good");
        let client = root.join("client");
        let zip_path = root.join("client.zip");
        build_zip(&zip_path, &[
            ("Recroom_Release.exe", b"exe"),
            ("Recroom_Release_Data/level0", b"data"),
        ]);

        let mut events = 0;
        extract_client_zip(&zip_path, &client.to_string_lossy(), &mut |_| events += 1)
            .expect("extracts");

        assert_eq!(fs::read(client.join("Recroom_Release_Data/level0")).expect("entry"), b"data");
        assert_eq!(
            read_install_manifest(&client).expect("manifest"),
            vec!["Recroom_Release.exe".to_string(), "Recroom_Release_Data".to_string()]
        );
        assert!(events > 0, "the last entry always reports progress");

        let _ = fs::remove_dir_all(&root);
    }

    /// The old install is gone by the time entries are written, so a run that
    /// fails partway must not leave half a client for the install check to
    /// find and report as installed. Only what the run wrote goes.
    #[test]
    fn a_failure_partway_removes_what_it_wrote_and_nothing_else() {
        let root = temp_dir("corrupt");
        let client = root.join("client");
        fs::create_dir_all(&client).expect("client dir");
        fs::write(client.join("notes.txt"), b"mine").expect("unrelated file");

        let zip_path = root.join("client.zip");
        build_zip(&zip_path, &[
            ("Recroom_Release.exe", b"exe"),
            ("Recroom_Release_Data/level0", b"SECOND-ENTRY-PAYLOAD"),
        ]);
        // Damage the second entry's bytes, so its checksum fails after the
        // first entry has already been written.
        let mut bytes = fs::read(&zip_path).expect("zip bytes");
        let at = bytes
            .windows(b"SECOND-ENTRY-PAYLOAD".len())
            .position(|w| w == b"SECOND-ENTRY-PAYLOAD")
            .expect("payload in the stored zip");
        bytes[at] ^= 0xFF;
        fs::write(&zip_path, &bytes).expect("rewrite zip");

        let result = extract_client_zip(&zip_path, &client.to_string_lossy(), &mut |_| {});

        assert!(result.is_err(), "a damaged entry fails the extraction");
        assert!(!client.join("Recroom_Release.exe").exists(), "the half-written client goes");
        assert!(!client.join("Recroom_Release_Data").exists());
        assert!(!client.join(INSTALL_MANIFEST).exists());
        assert!(client.join("notes.txt").exists(), "what was already there stays");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_start_of_a_content_range_is_read() {
        let headers = |value: &str| {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(reqwest::header::CONTENT_RANGE, value.parse().expect("header"));
            h
        };
        assert_eq!(parse_content_range_start(&headers("bytes 1024-2047/4096")), Some(1024));
        assert_eq!(parse_content_range_start(&headers("bytes 0-99/100")), Some(0));
        assert_eq!(parse_content_range_total(&headers("bytes 0-99/100")), Some(100));
        // An unsatisfied-range answer names no start.
        assert_eq!(parse_content_range_start(&headers("bytes */4096")), None);
        assert_eq!(parse_content_range_start(&reqwest::header::HeaderMap::new()), None);
    }
}

#[cfg(test)]
mod install_dir_scope_tests {
    use super::*;

    #[test]
    fn drive_roots_and_system_folders_are_too_broad() {
        // Adding a Defender exclusion for any of these would switch off
        // real-time protection across most of the disk. The install folder is
        // picked in a folder dialog, so "C:\" is two clicks away.
        for dir in [
            "C:\\", "C:", "c:/", "D:\\",
            "C:\\Windows", "C:\\windows\\System32",
            "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData",
            "C:\\Users", "C:\\Users\\Public",
            "C:\\Users\\Abdullah",          // a whole user profile
            "C:\\Downloads",                 // any top-level folder on a drive
            "",
        ] {
            assert!(
                is_overly_broad_dir(dir),
                "should have been rejected as too broad: {:?}",
                dir
            );
        }
    }

    #[test]
    fn real_install_folders_are_allowed() {
        for dir in [
            "C:\\Users\\Abdullah\\AppData\\Roaming\\com.radium.launcher\\client",
            "C:\\Users\\Abdullah\\AppData\\Roaming\\com.radium.launcher\\client-vanilla",
            "C:\\Games\\Radium\\client",
            "D:\\Program Files\\Radium\\client",
            "C:/Users/Abdullah/Documents/Radium",
        ] {
            assert!(
                !is_overly_broad_dir(dir),
                "should have been allowed: {:?}",
                dir
            );
        }
    }

    #[test]
    fn a_profiles_own_folders_are_too_broad() {
        for dir in [
            "C:\\Users\\Abdullah\\Downloads",
            "C:\\Users\\Abdullah\\Desktop\\",
            "c:/users/abdullah/documents",
            "C:\\Users\\Abdullah\\OneDrive",
            "C:\\Users\\Abdullah\\AppData\\Local",
            "C:\\Users\\Abdullah\\AppData\\Roaming",
            "C:\\Users\\Abdullah\\AppData\\Local\\Temp",
        ] {
            assert!(is_overly_broad_dir(dir), "should have been rejected as too broad: {:?}", dir);
        }
        // A dedicated folder inside one of them is still fine.
        assert!(!is_overly_broad_dir("C:\\Users\\Abdullah\\Downloads\\Radium"));
        assert!(!is_overly_broad_dir("C:\\Users\\Abdullah\\AppData\\Local\\Radium\\client"));
    }

    #[test]
    fn a_trailing_separator_does_not_smuggle_a_root_through() {
        assert!(is_overly_broad_dir("C:\\Windows\\"));
        assert!(is_overly_broad_dir("C:\\Users\\Abdullah\\"));
    }
}

#[cfg(test)]
mod update_check_tests {
    use super::*;

    const SAMPLE_PAGE: &str = r#"<div class="row"><div class="span4"><div class="well text-center download-card"><p><img src="/_image?href=%2F_astro%2Fplatform-windows.png" alt loading="lazy" decoding="async" width="72" height="72"></p><h3>Windows</h3><p>0.9.2</p><p><a href="https://cdn.recroom.baby/builds/0.9.2/windows.zip" class="btn btn-primary" data-download-platform="windows" aria-label="Download for Windows">Download</a></p></div></div><div class="span4"><div class="well text-center download-card"><p><img src="/_image?href=%2F_astro%2Fplatform-linux.png"></p><h3>Linux</h3><p>0.9.0</p><p><a href="https://cdn.recroom.baby/builds/0.9.0/linux.zip" class="btn btn-primary" data-download-platform="linux" aria-label="Download for Linux">Download</a></p></div></div></div><section class="download-patch-notes"><div class="well patch-note"><h3>0.9.2</h3><p class="muted">6/30/2026</p><ul><li>Backported &#39;3D Charades&#39;</li><li>Added Push to Talk setting</li></ul></div><div class="well patch-note"><h3>0.9.1</h3><p class="muted">6/29/2026</p><ul><li>Fixed a bug related to players showing up naked</li></ul></div><div class="well patch-note"><h3>0.9.0</h3><p class="muted">6/28/2026</p><ul><li>Initial release</li></ul></div></section>"#;

    #[test]
    fn test_extract_windows_card() {
        let (version, url) = extract_windows_card(SAMPLE_PAGE).expect("windows card should parse");
        assert_eq!(version, "0.9.2");
        assert_eq!(url, "https://cdn.recroom.baby/builds/0.9.2/windows.zip");
    }

    #[test]
    fn test_extract_patch_notes() {
        let notes = extract_patch_notes(SAMPLE_PAGE);
        assert_eq!(notes.len(), 3);
        assert_eq!(notes[0]["version"], "0.9.2");
        assert_eq!(notes[0]["date"], "6/30/2026");
        assert_eq!(notes[0]["notes"][0], "Backported '3D Charades'");
        assert_eq!(notes[1]["version"], "0.9.1");
        assert_eq!(notes[2]["version"], "0.9.0");
    }

    #[test]
    fn test_version_gt() {
        assert!(version_gt("0.9.2", "0.9.1"));
        assert!(version_gt("0.10.0", "0.9.9"));
        assert!(version_gt("1.0.0", "0.9.9"));
        assert!(!version_gt("0.9.1", "0.9.1"));
        assert!(!version_gt("0.9.0", "0.9.2"));
        // 'v'-prefixed tags, as used by updater::check_for_update for launcher releases.
        assert!(version_gt("v1.1.0", "v1.0.0"));
        assert!(version_gt("v2.0.0", "1.9.9"));
        assert!(!version_gt("v1.0.0", "v1.0.0"));
        assert!(!version_gt("v1.0.0", "v1.0.1"));
    }

    #[test]
    fn a_pre_release_sorts_below_the_release_it_precedes() {
        // The bug this replaced: "4.1.0-beta" parsed as [4, 1, 0] and compared
        // exactly equal to "4.1.0", so neither side was ever offered the other.
        assert!(version_gt("4.1.0", "4.1.0-beta"));
        assert!(!version_gt("4.1.0-beta", "4.1.0"));
        assert!(version_gt("v4.1.0", "v4.1.0-rc1"));

        // A pre-release still beats an older release outright.
        assert!(version_gt("4.1.0-beta", "4.0.0"));
        assert!(!version_gt("4.0.0", "4.1.0-beta"));

        // Between two pre-releases of the same version, the suffix decides.
        assert!(version_gt("4.1.0-rc2", "4.1.0-rc1"));
        assert!(version_gt("4.1.0-beta", "4.1.0-alpha"));
        assert!(!version_gt("4.1.0-rc1", "4.1.0-rc1"));

        // Build metadata takes no part in the ordering, as semver says.
        assert!(!version_gt("4.1.0+build8", "4.1.0+build7"));
        assert!(!version_gt("4.1.0+build7", "4.1.0"));
        assert!(!version_gt("4.1.0", "4.1.0+build7"));
        assert!(version_gt("4.1.1+build1", "4.1.0+build9"));
    }

    #[test]
    fn test_unescape_html_decimal_apostrophe() {
        assert_eq!(unescape_html("&#39;3D Charades&#39; &amp; more"), "'3D Charades' & more");
    }
}
