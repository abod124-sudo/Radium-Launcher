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

/// Game executables the launcher recognises, newest client first.
/// (The new recroom.baby client uses `Recroom_Release.exe`; the legacy client
/// used `RecRoom.exe`.)
pub const GAME_EXES: [&str; 2] = ["Recroom_Release.exe", "RecRoom.exe"];

/// Locate the game executable inside `dir` (recursive, newest-known first),
/// falling back to the legacy screen-mode launch script.
pub fn find_game_exe(dir: &str) -> Option<String> {
    for name in GAME_EXES {
        if let Some(p) = find_bat_in(dir, name, 0) {
            return Some(p);
        }
    }
    find_bat_in(dir, "RecRoom_ScreenMode.bat", 0)
}

/// Returns true if any process with one of the given image names is running.
/// One unfiltered `tasklist` call covers all names — cheaper than spawning a
/// filtered `tasklist` per image (this runs every 2s in the game monitor).
#[cfg(target_os = "windows")]
fn any_process_running(images: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("tasklist")
        .arg("/NH")
        .creation_flags(0x08000000)
        .output()
        .map(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().any(|line| {
                line.split_whitespace()
                    .next()
                    .map(|name| images.iter().any(|img| name.eq_ignore_ascii_case(img)))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
#[cfg(not(target_os = "windows"))]
fn any_process_running(_images: &[&str]) -> bool {
    false
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Checks whether any recognised game executable is currently running.
#[tauri::command]
pub fn check_game_running() -> bool {
    any_process_running(&GAME_EXES)
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

/// Returns true if the required Rec Room Steam app (appid 92) is installed,
/// by reading the Steam per-user registry key. Returns true on non-Windows so
/// the check never blocks there.
#[tauri::command]
pub fn check_required_steam_app() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Valve\Steam\Apps\92",
                "/v",
                "Installed",
            ])
            .creation_flags(0x08000000)
            .output();

        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                stdout
                    .lines()
                    .find(|l| l.contains("Installed"))
                    .map(|l| {
                        let v = l.trim();
                        v.ends_with("0x1") || v.ends_with("0x00000001")
                    })
                    .unwrap_or(false)
            }
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
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

/// Spawn a legacy `.bat` launch script via `cmd /c start`. The path is quoted
/// explicitly (via `raw_arg`) so a client directory containing characters like
/// `&` — legal in Windows folder names — can't break cmd's parsing. Launch
/// options are already validated to exclude quotes and shell metacharacters.
#[cfg(target_os = "windows")]
fn spawn_bat(exe_path: &str, launch_opts: &str, work_dir: &str) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    let mut line = format!("start \"\" \"{}\"", exe_path);
    for opt in launch_opts.split_whitespace() {
        line.push(' ');
        line.push_str(opt);
    }
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg("/c")
        .raw_arg(line)
        .current_dir(work_dir)
        .creation_flags(0x00000008); // DETACHED_PROCESS
    cmd.spawn()
}

#[cfg(not(target_os = "windows"))]
fn spawn_bat(exe_path: &str, launch_opts: &str, work_dir: &str) -> std::io::Result<std::process::Child> {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/c").arg("start").arg("").arg(exe_path);
    for opt in launch_opts.split_whitespace() {
        cmd.arg(opt);
    }
    cmd.current_dir(work_dir);
    cmd.spawn()
}

fn launch_game_impl(
    app: tauri::AppHandle,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Check if already running
    if check_game_running() {
        return Err("Game already running.".into());
    }

    // 2. Play mode (legacy clients accept a +mode arg; the new client ignores it)
    let play_mode = config
        .get("playMode")
        .and_then(|v| v.as_str())
        .unwrap_or("screen");

    // 3. Resolve client directory + game executable
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    // Prefer the saved exe path; otherwise search the client dir for a known exe.
    let mut exe_path = config
        .get("gameExePath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if exe_path.is_empty() || !Path::new(&exe_path).exists() {
        exe_path = find_game_exe(&client_dir).unwrap_or_default();
    }
    if exe_path.is_empty() {
        return Err(format!(
            "Game executable not found in: {}\n\nPlease download the client first.",
            client_dir
        ));
    }

    let exe = Path::new(&exe_path);
    let work_dir = exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let file_lower = exe
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let launch_opts = config
        .get("launchOptions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    // Validate launch options (block shell metacharacters)
    if launch_opts.contains(';') || launch_opts.contains('&') || launch_opts.contains('|') || 
       launch_opts.contains('\r') || launch_opts.contains('\n') || launch_opts.contains('`') || 
       launch_opts.contains('$') || launch_opts.contains('%') || launch_opts.contains('>') || 
       launch_opts.contains('<') || launch_opts.contains('^') || launch_opts.contains('\'') || 
       launch_opts.contains('"') {
        return Err("Launch options contain invalid or dangerous characters.".into());
    }

    // 6. Spawn the process (DETACHED_PROCESS = 0x00000008)
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let child = if file_lower.ends_with(".bat") {
        spawn_bat(&exe_path, launch_opts, &work_dir)
            .map_err(|e| format!("Failed to launch batch file: {}", e))?
    } else {
        let mut cmd = Command::new(exe);
        // Legacy RecRoom.exe accepts a +mode argument; the new Recroom_Release.exe
        // is launched plain.
        if file_lower == "recroom.exe" {
            cmd.arg(if play_mode == "vr" { "+mode:vr" } else { "+mode:screen" });
        }
        for opt in launch_opts.split_whitespace() {
            cmd.arg(opt);
        }
        cmd.current_dir(&work_dir);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x00000008); // DETACHED_PROCESS
        cmd.spawn()
            .map_err(|e| format!("Failed to launch game executable: {}", e))?
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

/// Forcibly kills every recognised game process via `taskkill`.
///
/// Covers both the current client (`Recroom_Release.exe`) and the legacy one
/// (`RecRoom.exe`); see [`GAME_EXES`].
#[tauri::command]
pub fn kill_game() -> bool {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    for image in GAME_EXES {
        #[cfg(target_os = "windows")]
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", image])
            .creation_flags(0x08000000)
            .output();

        #[cfg(not(target_os = "windows"))]
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", image])
            .output();
    }
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
