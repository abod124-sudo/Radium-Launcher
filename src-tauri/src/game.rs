use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use tauri::Emitter;
use tauri::Manager;

use crate::config;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Recursively search for a `.bat` file by `name` inside `dir`, up to `depth` 4.
///
/// Returns the full path to the first matching file, or `None` if not found.
pub fn find_bat_in(dir: &str, name: &str, depth: u32) -> Option<String> {
    if depth > 4 {
        return None;
    }

    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        return None;
    }

    let entries = match std::fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(_) => return None,
    };

    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let entry_name = entry.file_name().to_string_lossy().to_string();

        if file_type.is_file() && entry_name.eq_ignore_ascii_case(name) {
            return Some(entry.path().to_string_lossy().to_string());
        }

        if file_type.is_dir() {
            subdirs.push(entry.path());
        }
    }

    // Recurse into subdirectories
    for subdir in subdirs {
        if let Some(found) = find_bat_in(&subdir.to_string_lossy(), name, depth + 1) {
            return Some(found);
        }
    }

    None
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Checks whether `RecRoom.exe` is currently running via `tasklist`.
#[tauri::command]
pub fn check_game_running() -> bool {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[cfg(target_os = "windows")]
    let output = Command::new("tasklist")
        .args(["/NH", "/FI", "IMAGENAME eq RecRoom.exe"])
        .creation_flags(0x08000000)
        .output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("tasklist")
        .args(["/NH", "/FI", "IMAGENAME eq RecRoom.exe"])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_lowercase();
            stdout.contains("recroom.exe")
        }
        Err(_) => false,
    }
}

/// Checks whether `steam.exe` is currently running via `tasklist`.
#[tauri::command]
pub fn check_steam() -> bool {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[cfg(target_os = "windows")]
    let output = Command::new("tasklist")
        .args(["/NH", "/FI", "IMAGENAME eq steam.exe"])
        .creation_flags(0x08000000)
        .output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("tasklist")
        .args(["/NH", "/FI", "IMAGENAME eq steam.exe"])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_lowercase();
            stdout.contains("steam.exe")
        }
        Err(_) => false,
    }
}

#[tauri::command]
pub fn launch_game(
    app: tauri::AppHandle,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match launch_game_impl(app, config) {
        Ok(val) => Ok(val),
        Err(err) => Ok(json!({ "success": false, "error": err })),
    }
}

fn launch_game_impl(
    app: tauri::AppHandle,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Check if already running
    if check_game_running() {
        return Err("Game already running.".into());
    }

    // 2. Determine bat name from play_mode
    let play_mode = config
        .get("playMode")
        .and_then(|v| v.as_str())
        .unwrap_or("screen");

    let bat_name = if play_mode == "vr" {
        "RecRoom_VR.bat"
    } else {
        "RecRoom_ScreenMode.bat"
    };

    // 3. Resolve client directory
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    // 4. Locate the bat file
    let direct_bat_path = Path::new(&client_dir).join(bat_name);
    let bat_path: String = if direct_bat_path.exists() {
        direct_bat_path.to_string_lossy().to_string()
    } else if let Some(game_exe_path) = config.get("gameExePath").and_then(|v| v.as_str()) {
        let sibling = Path::new(game_exe_path)
            .parent()
            .map(|p| p.join(bat_name));
        if let Some(ref s) = sibling {
            if s.exists() {
                s.to_string_lossy().to_string()
            } else {
                find_bat_in(&client_dir, bat_name, 0).unwrap_or_default()
            }
        } else {
            find_bat_in(&client_dir, bat_name, 0).unwrap_or_default()
        }
    } else {
        find_bat_in(&client_dir, bat_name, 0).unwrap_or_default()
    };

    if bat_path.is_empty() {
        return Err(format!(
            "Launch file not found: {}\nLooked in: {}\n\nPlease download the client first.",
            bat_name, client_dir
        ));
    }

    // 5. Determine launch directory and check for RecRoom.exe
    let bat_dir = Path::new(&bat_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let exe_path = Path::new(&bat_dir).join("RecRoom.exe");
    let has_exe = exe_path.exists();

    let play_mode_arg = if play_mode == "vr" {
        "+mode:vr"
    } else {
        "+mode:screen"
    };

    let launch_opts = config
        .get("launchOptions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    // 6. Spawn the process (DETACHED_PROCESS = 0x00000008)
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let child = if has_exe {
        let mut cmd = Command::new(&exe_path);
        cmd.arg(play_mode_arg);
        if !launch_opts.is_empty() {
            for opt in launch_opts.split_whitespace() {
                cmd.arg(opt);
            }
        }
        cmd.current_dir(&bat_dir);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x00000008); // DETACHED_PROCESS
        cmd.spawn()
            .map_err(|e| format!("Failed to launch game executable: {}", e))?
    } else {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/c");
        cmd.arg("start");
            cmd.arg("");
            cmd.arg(bat_path);
            if !launch_opts.is_empty() {
                for opt in launch_opts.split_whitespace() {
                    cmd.arg(opt);
                }
            }
        cmd.current_dir(&bat_dir);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x00000008); // DETACHED_PROCESS
        cmd.spawn()
            .map_err(|e| format!("Failed to launch batch file: {}", e))?
    };

    let pid = child.id();

    // 7. Emit game-state event
    GAME_RUNNING_STATE.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("game-state", json!({ "running": true }));

    // 8. Optionally minimize the launcher
    let minimize = config
        .get("minimizeOnLaunch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if minimize {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
        }
    }

    // 9. Optionally close the launcher
    let close = config
        .get("closeOnLaunch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if close || cfg.close_on_launch {
        app.exit(0);
    }

    Ok(json!({ "success": true, "pid": pid }))
}

/// Forcibly kills all `RecRoom.exe` processes via `taskkill`.
#[tauri::command]
pub fn kill_game() -> bool {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[cfg(target_os = "windows")]
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "RecRoom.exe"])
        .creation_flags(0x08000000)
        .output();

    #[cfg(not(target_os = "windows"))]
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "RecRoom.exe"])
        .output();
    true
}

/// Queries the Windows registry to determine whether Smart App Control is
/// enabled. Returns `{ enabled: bool, state: i32 }`.
#[tauri::command]
pub fn check_smart_app_control() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    #[cfg(target_os = "windows")]
    let output = Command::new("reg")
        .args([
            "query",
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy",
            "/v",
            "VerifiedAndReputablePolicyState",
        ])
        .creation_flags(0x08000000)
        .output();

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("reg")
        .args([
            "query",
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy",
            "/v",
            "VerifiedAndReputablePolicyState",
        ])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Look for the DWORD value in the output
            // Format: "    VerifiedAndReputablePolicyState    REG_DWORD    0x00000001"
            let re_pattern = "VerifiedAndReputablePolicyState";
            if let Some(line) = stdout.lines().find(|l| l.contains(re_pattern)) {
                // Parse the value — could be hex (0x...) or decimal
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(val_str) = parts.last() {
                    let val = if let Some(hex) = val_str.strip_prefix("0x") {
                        i32::from_str_radix(hex, 16).unwrap_or(-1)
                    } else {
                        val_str.parse::<i32>().unwrap_or(-1)
                    };
                    return json!({ "enabled": val == 1 || val == 2, "state": val });
                }
            }
            json!({ "enabled": false, "state": -1 })
        }
        Err(e) => {
            json!({ "enabled": false, "error": e.to_string() })
        }
    }
}

// ─── Background Game Monitor ─────────────────────────────────────────────────

/// Tracks the last known running state so the monitor only emits on transitions.
static GAME_RUNNING_STATE: AtomicBool = AtomicBool::new(false);

/// Spawns a background tokio task that polls `RecRoom.exe` every 2 seconds and
/// emits `game-state` events to the frontend whenever the running state changes.
pub fn start_game_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            // Graceful shutdown: break if the main window is gone
            if app.get_webview_window("main").is_none() {
                break;
            }

            let running = check_game_running();
            let previous = GAME_RUNNING_STATE.load(Ordering::Relaxed);

            if running != previous {
                GAME_RUNNING_STATE.store(running, Ordering::Relaxed);
                let _ = app.emit("game-state", json!({ "running": running }));
            }
        }
    });
}
