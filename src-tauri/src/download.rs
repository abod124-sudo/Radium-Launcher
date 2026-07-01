use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::Emitter;
use tauri::Manager;

use crate::config;
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

/// Atomic flag used to signal cancellation of an in-progress download.
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Resolve a possibly-relative link from the download page into an absolute URL.
fn resolve_link(raw: &str) -> String {
    if raw.starts_with("http") {
        raw.to_string()
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;
    let response = client
        .head(url)
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .ok()?;
    extract_etag(response.headers())
}

/// Fetch the raw HTML of the downloads page.
async fn fetch_download_page_html() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    client
        .get(DOWNLOAD_PAGE)
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
async fn resolve_download_info() -> Result<(String, String), String> {
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
pub async fn check_client_update(app: tauri::AppHandle) -> Value {
    let cfg = config::ensure_config(&app);

    if cfg.game_exe_path.is_empty() {
        return json!({ "success": true, "hasUpdate": false });
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
pub async fn download_client(app: tauri::AppHandle) -> Result<Value, String> {
    match download_client_impl(app).await {
        Ok(val) => Ok(val),
        Err(err) => Ok(json!({ "success": false, "error": err })),
    }
}

async fn download_client_impl(app: tauri::AppHandle) -> Result<Value, String> {
    // Block if the game is already running.
    if game::check_game_running() {
        return Err("Cannot download or install while the game is running.".into());
    }

    // Reset cancellation flag.
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);

    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);
    let user_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    // Ensure directories exist.
    fs::create_dir_all(&user_data).map_err(|e| e.to_string())?;
    fs::create_dir_all(&client_dir).map_err(|e| e.to_string())?;

    let client_zip = user_data.join("client.zip");

    // Remove leftover zip if present.
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
    let (resolved_version, download_url) = resolve_download_info().await?;

    let http = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let response = http
        .get(&download_url)
        .header("User-Agent", BROWSER_UA)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    // Capture the CDN's ETag for this build so future checks can detect a
    // rebuilt zip even if the version number on the download page is unchanged.
    let resolved_etag = extract_etag(response.headers());

    let total: u64 = response
        .content_length()
        .unwrap_or(0);

    let mut downloaded: u64 = 0;
    let start_time = std::time::Instant::now();

    // Stream the response body to disk.
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(&client_zip)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;

    while let Some(chunk_result) = stream.next().await {
        // Check for cancellation between chunks.
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&client_zip);
            return Err("Cancelled".into());
        }

        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&client_zip);
                return Err(format!("Download stream error: {}", e));
            }
        };

        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&client_zip);
            return Err(format!("Failed to write chunk: {}", e));
        }

        downloaded += chunk.len() as u64;

        let elapsed = start_time.elapsed().as_secs_f64().max(0.001);
        let speed = downloaded as f64 / elapsed; // bytes/sec
        let pct = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0).min(99.0) as i64
        } else {
            -1
        };
        let eta = if total > 0 && speed > 0.0 {
            ((total - downloaded) as f64 / speed) as i64
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

    drop(file);

    if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&client_zip);
        return Err("Cancelled".into());
    }

    // ── Phase 2: Extract ───────────────────────────────────────────────
    let _ = app.emit("download-progress", json!({
        "phase": "extract",
        "pct": 0,
        "status": "Preparing extraction..."
    }));

    // Clear existing client directory contents before extracting.
    if Path::new(&client_dir).exists() {
        let _ = safe_clear_client_dir(&client_dir);
    }
    fs::create_dir_all(&client_dir)
        .map_err(|e| format!("Failed to create client dir: {}", e))?;

    let zip_file = fs::File::open(&client_zip)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|e| format!("Failed to read zip archive: {}", e))?;

    let entry_count = archive.len();

    for i in 0..entry_count {
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

            let mut buf = vec![0u8; 8192];
            loop {
                let n = entry
                    .read(&mut buf)
                    .map_err(|e| format!("Failed to read zip data: {}", e))?;
                if n == 0 {
                    break;
                }
                out_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("Failed to write extracted data: {}", e))?;
            }
        }

        // Emit extraction progress.
        let pct = ((i + 1) as f64 / entry_count as f64 * 100.0) as i64;
        let entry_name = entry.name().to_string();
        let _ = app.emit("download-progress", json!({
            "phase": "extract",
            "pct": pct,
            "status": format!("Extracting: {} ({}/{})", entry_name, i + 1, entry_count)
        }));
    }

    // Cleanup zip file.
    drop(archive);
    let _ = fs::remove_file(&client_zip);

    // Find RecRoom_ScreenMode.bat in the extracted files.
    let bat_path = game::find_game_exe(&client_dir).unwrap_or_default();

    // Save the bat path and the installed client build id to config.
    {
        let mut cfg = config::ensure_config(&app);
        if !bat_path.is_empty() {
            cfg.game_exe_path = bat_path.clone();
        }
        cfg.client_build = REQUIRED_CLIENT_BUILD.to_string();
        // Always assign together so the two never desync: if the version
        // couldn't be scraped this time, clear it rather than leaving a
        // stale value paired with the newly-downloaded build's ETag.
        cfg.client_version = resolved_version;
        cfg.client_etag = resolved_etag.unwrap_or_default();
        cfg.client_version_sync_prompted = false;
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
/// flag between chunks and will abort if set.
#[tauri::command]
pub fn cancel_download() {
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
}

// ─── Uninstall client ───────────────────────────────────────────────────────

/// Remove the game client directory and clear the saved exe path from config.
#[tauri::command]
pub async fn uninstall_client(app: tauri::AppHandle) -> Result<Value, String> {
    match uninstall_client_impl(app).await {
        Ok(val) => Ok(val),
        Err(err) => Ok(json!({ "success": false, "error": err })),
    }
}

async fn uninstall_client_impl(app: tauri::AppHandle) -> Result<Value, String> {
    if game::check_game_running() {
        return Err("Cannot uninstall while the game is running.".into());
    }

    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    if Path::new(&client_dir).exists() {
        safe_clear_client_dir(&client_dir)
            .map_err(|e| format!("Failed to clear client dir: {}", e))?;
    }

    // Clear relevant config fields.
    let mut cfg = config::ensure_config(&app);
    cfg.game_exe_path = String::new();
    cfg.defender_excluded = false;
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
pub async fn check_install(app: tauri::AppHandle) -> Result<Value, String> {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    let mut exe_path = cfg.game_exe_path.clone();

    // Verify the configured path is valid and inside client_dir.
    if !exe_path.is_empty() {
        let exe = Path::new(&exe_path);
        let client = Path::new(&client_dir);

        // Prefer canonicalized comparison so differences in slash style or
        // drive-letter casing on Windows don't cause a false "outside" result.
        // Fall back to a normalized, case-insensitive string prefix check if
        // either path can't be canonicalized.
        let is_inside = match (std::fs::canonicalize(exe), std::fs::canonicalize(client)) {
            (Ok(exe_canon), Ok(client_canon)) => exe_canon.starts_with(&client_canon),
            _ => {
                let normalize = |p: &str| p.replace('/', "\\").to_lowercase();
                normalize(&exe_path).starts_with(&normalize(&client_dir))
            }
        };

        if !is_inside || !exe.exists() {
            exe_path = String::new();
        }
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
    let client_outdated = installed && cfg.client_build != REQUIRED_CLIENT_BUILD;

    Ok(json!({
        "installed": installed,
        "exePath": exe_path,
        "clientDir": client_dir,
        "isRunning": is_running,
        "dllMissing": dll_missing,
        "clientOutdated": client_outdated,
        "clientVersion": cfg.client_version
    }))
}

// ─── Open client folder ─────────────────────────────────────────────────────

/// Open the game client directory in the system file explorer.
#[tauri::command]
pub async fn open_client_folder(app: tauri::AppHandle) -> bool {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

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
pub async fn select_folder() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select Radium Client Install Folder")
        .pick_folder();

    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

// ─── Default client directory ───────────────────────────────────────────────

/// Return the default client directory path (`<app_data_dir>/client`).
#[tauri::command]
pub fn get_default_client_dir(app: tauri::AppHandle) -> String {
    let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    app_data_dir
        .join("client")
        .to_string_lossy()
        .to_string()
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
fn is_game_install_dir(client_dir: &str) -> bool {
    let path = Path::new(client_dir);
    if !path.exists() {
        // Non-existent directories are safe to treat as empty install targets.
        return true;
    }
    dir_contains_game_files(path, 0)
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
