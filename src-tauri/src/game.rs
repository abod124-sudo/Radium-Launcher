use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{json, Value};
use tauri::Emitter;
use tauri::Manager;

use crate::config;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Game executables the launcher recognises, newest client first.
/// (The new recroom.baby client uses `Recroom_Release.exe`; the legacy client
/// used `RecRoom.exe`.) The legacy screen-mode script is the last resort.
pub const GAME_EXES: [&str; 2] = ["Recroom_Release.exe", "RecRoom.exe"];

/// Every launch target, in preference order.
const LAUNCH_TARGETS: [&str; 3] = [
    "Recroom_Release.exe",
    "RecRoom.exe",
    "RecRoom_ScreenMode.bat",
];

/// Locate the game executable inside `dir` — recursive to depth 4, preferring
/// the newest known client, then the legacy exe, then the screen-mode script.
///
/// All three names are matched in a single walk. Searching for one name at a
/// time meant that on the common install (which has `RecRoom.exe`, not
/// `Recroom_Release.exe`) the whole tree was walked to exhaustion for the name
/// that isn't there before the second pass found the one that is — a full scan
/// of a multi-gigabyte install on every `check_install`, which runs on every
/// settings autosave. Preference is applied per directory level, so a
/// `Recroom_Release.exe` nested one level down still loses to nothing: the
/// shallowest directory containing any target wins, and within it the
/// most-preferred name.
pub fn find_game_exe(dir: &str) -> Option<String> {
    find_launch_target(Path::new(dir), 0)
}

fn find_launch_target(dir: &Path, depth: u32) -> Option<String> {
    if depth > 4 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;

    // Index this level in one pass, then decide — a second read_dir per name
    // would put the per-name cost straight back.
    let mut found: [Option<std::path::PathBuf>; LAUNCH_TARGETS.len()] = Default::default();
    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            subdirs.push(entry.path());
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        for (i, target) in LAUNCH_TARGETS.iter().enumerate() {
            if found[i].is_none() && name.eq_ignore_ascii_case(target) {
                found[i] = Some(entry.path());
            }
        }
    }

    if let Some(hit) = found.into_iter().flatten().next() {
        return Some(hit.to_string_lossy().to_string());
    }

    for subdir in subdirs {
        if let Some(hit) = find_launch_target(&subdir, depth + 1) {
            return Some(hit);
        }
    }

    None
}

/// Returns true if any process with one of the given image names is running.
///
/// Walks the kernel's process snapshot directly rather than shelling out to
/// `tasklist`. The old implementation cost ~76ms per call — essentially all of
/// it process-creation overhead, which is why filtering by image name made no
/// difference — and this runs every 2 seconds for the whole session from the
/// game monitor. A snapshot walk over ~320 processes is about 1ms, spawns
/// nothing, and keeps the call off the blocking path of the async commands that
/// use it. It also stops the launcher from creating a hidden console process
/// twice a second, which is exactly the pattern antivirus heuristics flag.
#[cfg(target_os = "windows")]
fn any_process_running(images: &[&str]) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: the snapshot handle is checked against INVALID_HANDLE_VALUE
    // before use and closed on every exit path. `entry` is zeroed and has its
    // `dwSize` set before the first call, which is what Process32FirstW
    // requires; both iteration calls receive that same initialised struct.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut found = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if image_name_matches(&entry.szExeFile, images) {
                    found = true;
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        found
    }
}

/// Whether a `PROCESSENTRY32W` image name matches any of `images`.
///
/// The field is a fixed-size UTF-16 buffer padded with NULs, so it is truncated
/// at the first NUL before comparing — the whole 260-wchar buffer would never
/// match anything.
#[cfg(target_os = "windows")]
fn image_name_matches(sz_exe_file: &[u16], images: &[&str]) -> bool {
    let len = sz_exe_file
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(sz_exe_file.len());
    let name = &sz_exe_file[..len];
    images.iter().any(|img| utf16_eq_ignore_ascii_case(name, img))
}

/// Case-insensitive comparison of a UTF-16 slice against an ASCII string,
/// without allocating.
///
/// Decoding each name into a `String` instead cost 300-odd allocations per
/// poll, which was most of the walk's runtime. Comparing lengths up front is
/// valid because every image name we look for is ASCII, so one byte is one
/// UTF-16 unit; a non-ASCII `ascii` argument simply fails to match, which is
/// the safe answer.
#[cfg(target_os = "windows")]
fn utf16_eq_ignore_ascii_case(utf16: &[u16], ascii: &str) -> bool {
    if utf16.len() != ascii.len() {
        return false;
    }
    utf16
        .iter()
        .zip(ascii.bytes())
        .all(|(&u, a)| u < 128 && (u as u8).eq_ignore_ascii_case(&a))
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

/// Checks whether `steam.exe` is currently running.
#[tauri::command]
pub fn check_steam() -> bool {
    any_process_running(&["steam.exe"])
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

    // 3. Resolve client directory + game executable for the selected network
    let network = config::Network::parse(config.get("network").and_then(|v| v.as_str()));
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir_for(&app, &cfg, network);

    // Prefer the saved exe path; otherwise search the client dir for a known exe.
    let mut exe_path = match network {
        // The frontend passes Radium's exe path as a flat config field.
        config::Network::Radium => config
            .get("gameExePath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        // Vanilla's install state lives in its own config sub-object, so read it
        // from disk rather than from the frontend's flat (Radium) field.
        config::Network::Vanilla => cfg.vanilla.game_exe_path.clone(),
    };
    // The exe path arrives from the frontend for Radium, so it is confirmed to
    // live inside the resolved client directory before anything is spawned —
    // the same containment check `check_install` applies. Without it, anything
    // that could reach the IPC layer (a compromised API feeding the room and
    // photo views, say) could name any executable on disk and have the
    // launcher run it.
    if exe_path.is_empty()
        || !Path::new(&exe_path).exists()
        || !config::path_is_inside_dir(&exe_path, &client_dir)
    {
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

    // Launch options are per-network, like the install directory: the two are
    // different builds that take different flags, and one client's flag can
    // stop the other from starting. Radium's arrive as a flat config field;
    // Vanilla's live in its own sub-object and are read from disk, the same
    // way its exe path is above.
    let launch_opts = match network {
        config::Network::Radium => config
            .get("launchOptions")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        config::Network::Vanilla => cfg.vanilla.launch_options.clone(),
    };
    let launch_opts = launch_opts.trim();

    // Shares its list with the save path, so nothing can be stored from
    // Settings that is then refused here.
    if !config::launch_options_are_safe(launch_opts) {
        return Err("Launch options contain invalid or dangerous characters.".into());
    }

    // 6. Spawn the process (DETACHED_PROCESS = 0x00000008)
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let is_bat = file_lower.ends_with(".bat");
    let child = if is_bat {
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

    // A .bat launch goes through `cmd /c start`, so `child` is the transient
    // cmd.exe wrapper (which exits immediately), not the game — its PID is
    // meaningless. Only report a PID for a direct executable launch.
    let pid_value = if is_bat { Value::Null } else { Value::from(child.id()) };

    // 7. Enter the post-launch "grace" state and mark the game as running.
    //
    // The background monitor must not report "closed" until the game process
    // has actually appeared: a `.bat`/`start` launch (and slow first-time Unity
    // startup) can take several seconds, during which no game process exists yet.
    // Without this, the monitor's first poll would see no process, flip the
    // state back to not-running, and fire a spurious "Game closed". See
    // `start_game_monitor`.
    GAME_SEEN_SINCE_LAUNCH.store(false, Ordering::SeqCst);
    LAUNCH_GRACE_POLLS.store(GRACE_POLLS_AFTER_LAUNCH, Ordering::SeqCst);
    GAME_RUNNING_STATE.store(true, Ordering::SeqCst);
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

    Ok(json!({ "success": true, "pid": pid_value }))
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

/// Whether the game process has been observed at least once since the last
/// launch. Until it has, the monitor treats "not running" as "not started yet"
/// rather than "closed" (see `LAUNCH_GRACE_POLLS`).
static GAME_SEEN_SINCE_LAUNCH: AtomicBool = AtomicBool::new(false);

/// Remaining monitor polls during which a premature "closed" is suppressed
/// after a launch. Decremented once per poll; set by `launch_game`.
static LAUNCH_GRACE_POLLS: AtomicU64 = AtomicU64::new(0);

/// Length of the post-launch grace window, in monitor polls. At the 2s poll
/// interval this is ~16s — enough for a slow `.bat`/`start` launch or a cold
/// Unity start to make the game process appear in the process snapshot.
const GRACE_POLLS_AFTER_LAUNCH: u64 = 8;

/// Decide whether the monitor should emit a `game-state` transition this poll.
///
/// Returns `false` (no emit) when the state is unchanged, and also when a
/// "closed" transition would fire prematurely — i.e. the process hasn't been
/// seen yet and we're still inside the post-launch grace window.
fn should_emit_game_state(
    running: bool,
    previous: bool,
    seen_since_launch: bool,
    grace_polls: u64,
) -> bool {
    if running == previous {
        return false;
    }
    if !running && !seen_since_launch && grace_polls > 0 {
        return false;
    }
    true
}

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
            if running {
                GAME_SEEN_SINCE_LAUNCH.store(true, Ordering::SeqCst);
            }

            // Consume one grace poll if we're inside the post-launch window.
            let grace = LAUNCH_GRACE_POLLS.load(Ordering::SeqCst);
            if grace > 0 {
                LAUNCH_GRACE_POLLS.store(grace - 1, Ordering::SeqCst);
            }

            // Right after a launch the game process can take a few seconds to
            // appear; don't flip to not-running until it's been seen at least
            // once or the grace window has elapsed (see should_emit_game_state).
            let previous = GAME_RUNNING_STATE.load(Ordering::SeqCst);
            let seen = GAME_SEEN_SINCE_LAUNCH.load(Ordering::SeqCst);
            if should_emit_game_state(running, previous, seen, grace) {
                GAME_RUNNING_STATE.store(running, Ordering::SeqCst);
                let _ = app.emit("game-state", json!({ "running": running }));
            }
        }
    });
}

#[cfg(test)]
mod game_monitor_tests {
    use super::should_emit_game_state;

    #[test]
    fn no_emit_when_state_unchanged() {
        assert!(!should_emit_game_state(true, true, true, 0));
        assert!(!should_emit_game_state(false, false, false, 0));
    }

    #[test]
    fn suppresses_premature_close_during_grace() {
        // Just launched: previous=running(true), process not seen yet, grace left.
        // A "not running" poll must NOT emit "closed".
        assert!(!should_emit_game_state(false, true, false, 8));
    }

    #[test]
    fn emits_close_once_process_has_been_seen() {
        // The process appeared earlier (seen=true), then genuinely exited: emit,
        // even if grace polls remain.
        assert!(should_emit_game_state(false, true, true, 5));
    }

    #[test]
    fn emits_close_when_grace_elapsed_without_appearing() {
        // Launch that never produced a process: after the grace window, report it.
        assert!(should_emit_game_state(false, true, false, 0));
    }

    #[test]
    fn emits_running_transition_immediately() {
        // Process appearing is always emitted (grace only guards the close edge).
        assert!(should_emit_game_state(true, false, false, 8));
        assert!(should_emit_game_state(true, false, true, 0));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod process_snapshot_tests {
    use super::{any_process_running, image_name_matches};

    /// The snapshot walk must find a process that is definitely running: this
    /// test binary. Guards against the whole enumeration silently returning
    /// false — the failure mode that would make the launcher believe the game
    /// had closed the moment it started.
    #[test]
    fn the_snapshot_finds_this_test_process() {
        let exe = std::env::current_exe().expect("current exe");
        let name = exe
            .file_name()
            .expect("exe file name")
            .to_string_lossy()
            .to_string();

        assert!(
            any_process_running(&[&name]),
            "expected to find this test process ({}) in the snapshot",
            name
        );
    }

    #[test]
    fn a_process_that_is_not_running_is_not_reported() {
        assert!(!any_process_running(&[
            "radium-launcher-no-such-process-9f3a1c.exe"
        ]));
    }

    #[test]
    fn an_empty_image_list_matches_nothing() {
        assert!(!any_process_running(&[]));
    }

    /// The image name arrives as a fixed 260-wchar buffer padded with NULs, so
    /// it has to be truncated at the first NUL before comparing. Comparison is
    /// case-insensitive because Windows process names are.
    #[test]
    fn a_nul_padded_image_name_is_truncated_before_comparing() {
        let mut buf = [0u16; 260];
        for (slot, ch) in buf.iter_mut().zip("RecRoom.exe".encode_utf16()) {
            *slot = ch;
        }

        assert!(image_name_matches(&buf, &["RecRoom.exe"]));
        assert!(image_name_matches(&buf, &["recroom.EXE"]));
        assert!(image_name_matches(&buf, &["Recroom_Release.exe", "RecRoom.exe"]));
        assert!(!image_name_matches(&buf, &["RecRoom"]));
        assert!(!image_name_matches(&buf, &["steam.exe"]));
    }

    /// A buffer with no NUL at all must not read past its end.
    #[test]
    fn an_unterminated_image_name_does_not_overrun() {
        let buf = [b'a' as u16; 260];
        assert!(!image_name_matches(&buf, &["a.exe"]));
        assert!(image_name_matches(&buf, &["a".repeat(260).as_str()]));
    }
}
