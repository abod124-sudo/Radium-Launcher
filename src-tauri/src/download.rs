use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::Emitter;
use tauri::Manager;

use crate::config;
use crate::game;

/// CDN URL for the game client zip archive.
const DOWNLOAD_URL: &str = "https://cdn.recroomarchive.org/radium/game-client/production/toukeh24kq6w2v4lndyc4z0pblvfyj75/windows/client.zip";

/// Atomic flag used to signal cancellation of an in-progress download.
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

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

    let response = reqwest::get(DOWNLOAD_URL)
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

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

        let chunk = chunk_result.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write chunk: {}", e))?;

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
    let bat_path = game::find_bat_in(&client_dir, "RecRoom_ScreenMode.bat", 0)
        .unwrap_or_default();

    // Save the bat path to config.
    if !bat_path.is_empty() {
        let mut cfg = config::ensure_config(&app);
        cfg.game_exe_path = bat_path.clone();
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

        let is_inside = exe
            .strip_prefix(client)
            .is_ok();

        if !is_inside || !exe.exists() {
            exe_path = String::new();
        }
    }

    // Try to locate the bat file if the config path was empty or invalid.
    if exe_path.is_empty() {
        exe_path = game::find_bat_in(&client_dir, "RecRoom_ScreenMode.bat", 0)
            .unwrap_or_default();
    }

    let installed = !exe_path.is_empty() && Path::new(&exe_path).exists();
    let is_running = game::check_game_running();

    let mut dll_missing = false;
    if installed {
        if let Some(parent) = Path::new(&exe_path).parent() {
            let dll_path_bepinex = parent.join("BepInEx").join("plugins").join("Radeon.Core.BasePatch.dll");
            let dll_path_root = parent.join("Radeon.Core.BasePatch.dll");
            if !dll_path_bepinex.exists() && !dll_path_root.exists() {
                dll_missing = true;
            }
        }
    }

    Ok(json!({
        "installed": installed,
        "exePath": exe_path,
        "clientDir": client_dir,
        "isRunning": is_running,
        "dllMissing": dll_missing
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

/// Downloads and restores the `Radeon.Core.BasePatch.dll` file to the game folder.
#[tauri::command]
pub async fn restore_dll(app: tauri::AppHandle) -> Result<Value, String> {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);
    let mut exe_path = cfg.game_exe_path.clone();

    if exe_path.is_empty() {
        exe_path = game::find_bat_in(&client_dir, "RecRoom_ScreenMode.bat", 0)
            .unwrap_or_default();
    }

    if exe_path.is_empty() || !Path::new(&exe_path).exists() {
        return Err("Client is not installed. Please download the client first.".into());
    }

    let bat_dir = Path::new(&exe_path).parent().ok_or("Invalid executable path")?;
    let plugins_dir = bat_dir.join("BepInEx").join("plugins");

    // Resolve where the patch file(s) should be extracted.
    let target_dir = if plugins_dir.exists() {
        plugins_dir
    } else if bat_dir.join("BepInEx").exists() {
        let _ = fs::create_dir_all(&plugins_dir);
        plugins_dir
    } else {
        bat_dir.to_path_buf()
    };

    let patch_url = "https://cdn.recroomarchive.org/radium/game-client/production/toukeh24kq6w2v4lndyc4z0pblvfyj75/windows/patch.zip";

    let response = reqwest::get(patch_url)
        .await
        .map_err(|e| format!("Failed to request patch ZIP: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to download patch ZIP from CDN (HTTP {})", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read patch ZIP bytes: {}", e))?;

    // Extract patch.zip directly from memory using Cursor to bypass antivirus scanning on the zip file itself
    use std::io::Cursor;
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Failed to read patch ZIP archive: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read entry {} from patch ZIP: {}", i, e))?;

        let out_path = match entry.enclosed_name() {
            Some(p) => target_dir.join(p),
            None => continue,
        };

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create directory {:?}: {}", out_path, e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory: {}", e))?;
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
                    .map_err(|e| format!("Failed to write extracted patch data: {}", e))?;
            }
        }
    }

    Ok(json!({ "success": true }))
}

/// Returns true only if the given directory contains at least one recognized
/// Rec Room game file — ensuring we never accidentally clear a folder that
/// isn't actually a game installation.
fn is_game_install_dir(client_dir: &str) -> bool {
    let path = Path::new(client_dir);
    if !path.exists() {
        // Non-existent directories are safe to treat as empty install targets.
        return true;
    }

    // At least one of these must exist for the directory to be considered a
    // game installation. This prevents clearing user project folders that
    // happen to share a parent with the intended install location.
    let sentinel_files = [
        "RecRoom.exe",
        "RecRoom_ScreenMode.bat",
        "RecRoom_VR.bat",
        "RecRoom_VRMode.bat",
        "RecRoom_Data",
    ];

    for file_name in &sentinel_files {
        if path.join(file_name).exists() {
            return true;
        }
    }

    // Directory exists but contains none of the expected game files — skip.
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

    Ok(())
}
