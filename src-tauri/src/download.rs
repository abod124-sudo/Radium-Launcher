use std::fs;
use std::io::Write;
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

/// Atomic flag used to pause an in-progress download. Unlike cancellation, a
/// pause leaves the partial file (and its resume metadata) on disk so the
/// download can be continued later — either by clicking Resume, or by reopening
/// the launcher after it was closed mid-download.
static DOWNLOAD_PAUSED: AtomicBool = AtomicBool::new(false);

/// Guards against two downloads running concurrently (e.g. cancel + immediate
/// re-download), which would race on the same client.zip and client directory.
static DOWNLOAD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

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
async fn fetch_download_page_html() -> Result<String, String> {
    crate::server::http()
        .get(DOWNLOAD_PAGE)
        .timeout(std::time::Duration::from_secs(20))
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("Failed to load download page: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read download page: {}", e))
}

/// Extract the Windows build's version string and download link from the
/// downloads page's "Windows" card, e.g.
/// `<h3>Windows</h3><p>0.9.2</p><p><a href="...windows.zip">Download</a></p>`.
fn extract_windows_card(html: &str) -> Option<(String, String)> {
    let re = regex::Regex::new(
        r#"(?s)<h3>\s*Windows\s*</h3>\s*<p>([^<]+)</p>\s*<p><a href="([^"]+)""#,
    )
    .ok()?;
    let c = re.captures(html)?;
    Some((
        c.get(1)?.as_str().trim().to_string(),
        c.get(2)?.as_str().to_string(),
    ))
}

/// Extract patch notes (version, date, bullet list) from the downloads page,
/// newest first, as published on the site.
fn extract_patch_notes(html: &str) -> Vec<Value> {
    let block_re = regex::Regex::new(
        r#"(?s)<div class="well patch-note"><h3>([^<]+)</h3><p class="muted">([^<]+)</p><ul>(.*?)</ul></div>"#,
    );
    let li_re = regex::Regex::new(r#"(?s)<li>(.*?)</li>"#);

    let (Ok(block_re), Ok(li_re)) = (block_re, li_re) else {
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

/// Compare two dotted version strings (e.g. "0.9.2" or "v3.5.2"), returning
/// true if `a` is greater than `b`. A leading 'v' is stripped from each side;
/// non-numeric or missing segments are treated as 0.
pub fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };

    let a_parts = parse(a);
    let b_parts = parse(b);
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
    false
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
        let cfg = config::ensure_config(app);
        let url = cfg.vanilla.client_url.trim().to_string();
        if url.is_empty() {
            return Err(
                "No Vanilla client URL is configured. Vanilla has not published a \
                 download yet; set one in Settings once it does."
                    .into(),
            );
        }
        if !url.starts_with("https://") {
            return Err("The Vanilla client URL must start with https://".into());
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
    let cfg = config::ensure_config(&app);
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
        let mut updated_cfg = cfg.clone();
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

    let cfg = config::ensure_config(&app);
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

    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = http.get(&download_url).header("User-Agent", BROWSER_UA);
    if resume_from > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={}-", resume_from));
        // If-Range: the server returns 206 (continue) only if the file still
        // matches this ETag, otherwise a full 200 — so we never stitch together
        // bytes from two different builds.
        if let Some(m) = &existing_meta {
            if !m.etag.is_empty() {
                req = req.header(reqwest::header::IF_RANGE, m.etag.clone());
            }
        }
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

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
    let mut last_emit = std::time::Instant::now() - EMIT_INTERVAL;

    // Stream the response body to disk — append when resuming, otherwise create.
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut file = if is_resume {
        fs::OpenOptions::new()
            .append(true)
            .open(&part_path)
            .map_err(|e| format!("Failed to open partial file: {}", e))?
    } else {
        fs::File::create(&part_path)
            .map_err(|e| format!("Failed to create partial file: {}", e))?
    };

    while let Some(chunk_result) = stream.next().await {
        // Cancellation wipes the partial file — the user wants to start fresh.
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&part_path);
            let _ = fs::remove_file(&meta_path);
            return Err("Cancelled".into());
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

    drop(file);

    if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&meta_path);
        return Err("Cancelled".into());
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

    // ── Phase 2: Extract ───────────────────────────────────────────────
    let _ = app.emit("download-progress", json!({
        "phase": "extract",
        "pct": 0,
        "status": "Preparing extraction..."
    }));

    // Open and parse the archive BEFORE touching the existing install. Clearing
    // first meant a corrupt or truncated download wiped a working client and
    // then failed, leaving the user with nothing to launch and nothing to
    // roll back to.
    let zip_file = fs::File::open(&client_zip)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|e| format!("Failed to read zip archive: {}", e))?;

    // The archive is readable, so the old install can go.
    if Path::new(&client_dir).exists() {
        let _ = safe_clear_client_dir(&client_dir);
    }
    fs::create_dir_all(&client_dir)
        .map_err(|e| format!("Failed to create client dir: {}", e))?;

    let entry_count = archive.len();
    let mut was_cancelled = false;
    last_emit = std::time::Instant::now() - EMIT_INTERVAL;

    for i in 0..entry_count {
        // Honor cancellation during extraction too — previously Cancel only
        // worked during the download phase.
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            was_cancelled = true;
            break;
        }

        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;

        let out_path = match entry.enclosed_name() {
            Some(p) => Path::new(&client_dir).join(p),
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

            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Failed to write extracted data: {}", e))?;
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
            let _ = app.emit("download-progress", json!({
                "phase": "extract",
                "pct": pct,
                "status": format!("Extracting: {} ({}/{})", entry_name, i + 1, entry_count),
                "entry": entry_base,
                "done": i + 1,
                "totalEntries": entry_count
            }));
        }
    }

    // Cleanup zip file.
    drop(archive);
    let _ = fs::remove_file(&client_zip);

    if was_cancelled {
        // Remove the half-extracted client so it isn't detected as installed.
        let _ = safe_clear_client_dir(&client_dir);
        return Err("Cancelled".into());
    }

    // Find RecRoom_ScreenMode.bat in the extracted files.
    let bat_path = game::find_game_exe(&client_dir).unwrap_or_default();

    // Save the bat path and the installed client build id to config.
    {
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

// ─── Cancel download ────────────────────────────────────────────────────────

/// Signal cancellation of the current download. The download loop checks this
/// flag between chunks and will abort (deleting the partial file) if set.
///
/// If nothing is actively downloading — e.g. the user cancels a *paused*
/// download — there is no loop to observe the flag, so the partial file and its
/// resume metadata are removed here directly.
#[tauri::command]
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
#[tauri::command]
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

    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir_for(&app, &cfg, network);

    if Path::new(&client_dir).exists() {
        safe_clear_client_dir(&client_dir)
            .map_err(|e| format!("Failed to clear client dir: {}", e))?;
    }

    // Clear relevant config fields.
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
    let cfg = config::ensure_config(&app);
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
    if exe_path.is_empty() {
        exe_path = game::find_game_exe(&client_dir).unwrap_or_default();
    }

    let installed = !exe_path.is_empty() && Path::new(&exe_path).exists();
    let is_running = game::check_game_running();

    // DLL-restore feature is disabled — never report a missing patch DLL.
    let dll_missing = false;

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
        "dllMissing": dll_missing,
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
#[tauri::command]
pub async fn open_client_folder(app: tauri::AppHandle, network: Option<String>) -> bool {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir_for(&app, &cfg, Network::parse(network.as_deref()));

    if Path::new(&client_dir).exists() {
        let _ = std::process::Command::new("explorer")
            .arg(&client_dir)
            .spawn();
        true
    } else {
        false
    }
}

// ─── Select folder dialog ───────────────────────────────────────────────────

/// Show a native folder picker dialog and return the selected path.
#[tauri::command]
pub async fn select_folder(network: Option<String>) -> Result<Option<String>, String> {
    let title = match Network::parse(network.as_deref()) {
        Network::Radium => "Select Radium Client Install Folder",
        Network::Vanilla => "Select Vanilla Client Install Folder",
    };
    let folder = rfd::FileDialog::new().set_title(title).pick_folder();

    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

// ─── Default client directory ───────────────────────────────────────────────

/// Return the default client directory path (`<app_data_dir>/client`).
#[tauri::command]
pub fn get_default_client_dir(app: tauri::AppHandle, network: Option<String>) -> String {
    let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let folder = config::default_client_folder(Network::parse(network.as_deref()));
    app_data_dir.join(folder).to_string_lossy().to_string()
}

/// Restore-DLL feature is disabled.
#[tauri::command]
pub async fn restore_dll(_app: tauri::AppHandle) -> Result<Value, String> {
    Ok(json!({ "success": false, "error": "Restore DLL is disabled." }))
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
    const DENY_SUFFIXES: [&str; 8] = [
        "\\windows",
        "\\program files",
        "\\program files (x86)",
        "\\programdata",
        "\\users",
        "\\users\\public",
        "\\system32",
        "\\appdata",
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

    false
}

/// Targeted cleanup function that deletes only Rec Room game client files and
/// directories, ensuring unrelated user files (like parent project folders)
/// are left completely untouched.
///
/// Returns an error (without deleting anything) if the target directory does
/// not appear to be a Rec Room game installation. This is the primary guard
/// against the "reinstall deletes parent folder" bug class.
fn safe_clear_client_dir(client_dir: &str) -> std::io::Result<()> {
    let path = Path::new(client_dir);
    if !path.exists() {
        return Ok(());
    }

    // Safety guard: abort if this directory does not look like a game install.
    if !is_game_install_dir(client_dir) {
        // The directory is not empty but has no game files — do not touch it.
        return Ok(());
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
    // client dir. Remove any immediate subdirectory that is itself a game
    // installation, so uninstall/reinstall doesn't leave a stale nested copy
    // behind. Subfolders with no game files are left untouched.
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let sub = entry.path();
            if sub.is_dir() && dir_contains_game_files(&sub, 0) {
                let _ = fs::remove_dir_all(&sub);
            }
        }
    }

    Ok(())
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
    fn test_unescape_html_decimal_apostrophe() {
        assert_eq!(unescape_html("&#39;3D Charades&#39; &amp; more"), "'3D Charades' & more");
    }
}
