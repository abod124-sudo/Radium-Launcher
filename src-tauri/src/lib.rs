pub mod config;
pub mod defender;
pub mod download;
pub mod game;
pub mod scraper;
pub mod server;
pub mod updater;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // Config
            cmd_get_config,
            cmd_save_config,
            // Server / Data
            server::ping_server,
            server::get_player_count,
            server::fetch_rooms,
            server::fetch_people,
            server::fetch_filters,
            server::fetch_user_photos,
            server::fetch_user_rooms,
            server::fetch_user_feed,
            server::fetch_recent_photos,
            // Scraper
            scraper::fetch_room_web_details,
            scraper::fetch_user_web_details,
            scraper::fetch_photo_web_details,
            scraper::fetch_photo_comments,
            // Download / Install
            download::download_client,
            download::cancel_download,
            download::uninstall_client,
            download::check_install,
            download::check_client_update,
            download::open_client_folder,
            download::select_folder,
            download::get_default_client_dir,
            download::restore_dll,
            // Game
            game::launch_game,
            game::kill_game,
            game::check_game_running,
            game::check_steam,
            game::check_required_steam_app,
            game::check_smart_app_control,
            // Defender
            defender::add_defender_exclusion,
            defender::remove_defender_exclusion,
            defender::detect_antivirus,
            // Updater
            updater::check_for_update,
            updater::download_update,
            updater::get_version,
            // Debug
            cmd_debug_exec,
            cmd_debug_paths,
            // Bug Report
            submit_bug_report,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Start game monitoring background task
            game::start_game_monitor(app_handle.clone());

            // Listen for window maximize/unmaximize events
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    use tauri::Emitter;
                    if let tauri::WindowEvent::Resized(_) = event {
                        if let Ok(maximized) = window_clone.is_maximized() {
                            let _ = window_clone.emit("window-maximized-state", maximized);
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Config commands - thin wrappers that pass the app handle
#[tauri::command]
fn cmd_get_config(app: tauri::AppHandle) -> serde_json::Value {
    let cfg = config::ensure_config(&app);
    serde_json::to_value(&cfg).unwrap_or(serde_json::json!({}))
}

#[tauri::command]
fn cmd_save_config(app: tauri::AppHandle, config: serde_json::Value) -> bool {
    match serde_json::from_value::<config::Config>(config) {
        Ok(cfg) => {
            // Only reject characters that are illegal in Windows paths anyway
            // (plus control chars). Legal folder names like "Games & Mods" or
            // "100%" must be saveable; the launch path is explicitly quoted at
            // spawn time, so shell metacharacters in the path are inert.
            let dir = &cfg.install_dir;
            if dir.chars().any(|c| c.is_control())
                || dir.contains('"') || dir.contains('<') || dir.contains('>') || dir.contains('|')
            {
                return false;
            }
            let opt = &cfg.launch_options;
            if opt.contains(';') || opt.contains('&') || opt.contains('|') || opt.contains('\r') || opt.contains('\n') || opt.contains('`') || opt.contains('$') || opt.contains('%') || opt.contains('>') || opt.contains('<') || opt.contains('^') {
                return false;
            }
            config::save_config(&app, &cfg).is_ok()
        }
        Err(_) => false,
    }
}

// Debug commands
#[tauri::command]
fn cmd_debug_exec(app: tauri::AppHandle, mode: String) -> serde_json::Value {
    let bat_name = if mode == "vr" {
        "RecRoom_VR.bat"
    } else {
        "RecRoom_ScreenMode.bat"
    };
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);
    let bat_path = std::path::Path::new(&client_dir).join(bat_name);

    if !bat_path.exists() {
        return serde_json::json!({
            "ok": false,
            "msg": format!("Not found: {}", bat_path.display())
        });
    }

    // Spawn (don't wait) — the bat launches the game, so blocking on its output
    // would freeze this command until the game exits.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        match std::process::Command::new("cmd")
            .raw_arg("/c")
            .raw_arg(format!("\"{}\"", bat_path.to_string_lossy()))
            .current_dir(&client_dir)
            .creation_flags(0x00000008) // DETACHED_PROCESS
            .spawn()
        {
            Ok(child) => serde_json::json!({ "ok": true, "pid": child.id() }),
            Err(e) => serde_json::json!({ "ok": false, "err": e.to_string() }),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("\"{}\"", bat_path.to_string_lossy()))
            .current_dir(&client_dir)
            .spawn()
        {
            Ok(child) => serde_json::json!({ "ok": true, "pid": child.id() }),
            Err(e) => serde_json::json!({ "ok": false, "err": e.to_string() }),
        }
    }
}

#[tauri::command]
fn cmd_debug_paths(app: tauri::AppHandle) -> serde_json::Value {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);
    let user_data = app
        .path()
        .app_data_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let screen_bat = std::path::Path::new(&client_dir).join("RecRoom_ScreenMode.bat");
    let vr_bat = std::path::Path::new(&client_dir).join("RecRoom_VR.bat");
    let exe = std::path::Path::new(&client_dir).join("RecRoom.exe");

    serde_json::json!({
        "CLIENT_DIR": client_dir,
        "USER_DATA": user_data,
        "screenBat": screen_bat.to_string_lossy(),
        "screenBatExists": screen_bat.exists(),
        "vrBat": vr_bat.to_string_lossy(),
        "vrBatExists": vr_bat.exists(),
        "exe": exe.to_string_lossy(),
        "exeExists": exe.exists(),
    })
}

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static LAST_SUBMISSION_TIME: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
async fn submit_bug_report(
    app: tauri::AppHandle,
    description: String,
    logs: String,
    category: String,
    severity: String,
    diagnostics: serde_json::Value,
) -> Result<String, String> {
    // 1. Cooldown Safeguard (60 seconds)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let last_time = LAST_SUBMISSION_TIME.load(Ordering::SeqCst);
    if now < last_time + 60 {
        let remaining = (last_time + 60) - now;
        return Err(format!(
            "Please wait {} seconds before submitting another bug report.",
            remaining
        ));
    }

    // 2. Length Validation
    let trimmed = description.trim();
    let len = trimmed.chars().count();
    if len < 10 {
        return Err("Description is too short. Minimum 10 characters required.".into());
    }
    if len > 1500 {
        return Err("Description is too long. Maximum 1500 characters allowed.".into());
    }

    // 3. Discord Ping Sanitization
    let sanitized_desc = trimmed
        .replace("@everyone", "`@everyone`")
        .replace("@here", "`@here`");

    // 4. Gather System Diagnostics
    let cfg = config::ensure_config(&app);
    let os_name = std::env::consts::OS;
    let os_arch = std::env::consts::ARCH;

    let launcher_version = diagnostics.get("launcherVersion").and_then(|v| v.as_str()).unwrap_or("unknown");
    let is_installed = diagnostics.get("isInstalled").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_game_running = diagnostics.get("isGameRunning").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_downloading = diagnostics.get("isDownloading").and_then(|v| v.as_bool()).unwrap_or(false);

    let category_name = match category.to_lowercase().as_str() {
        "general" => "General / Launcher Issue",
        "launch" => "Game Launch Failure / Crash",
        "theme" => "UI Layout / Custom Themes",
        "other" => "Other / Unspecified",
        _ => &category,
    };

    let severity_name = match severity.to_lowercase().as_str() {
        "critical" => "Critical - Launcher Crash/Freeze",
        "high" => "High - Cannot Launch/Play",
        "medium" => "Medium - Functional Issue",
        "low" => "Low - Cosmetic/Typo",
        _ => &severity,
    };

    let embed_color = match severity.to_lowercase().as_str() {
        "critical" => 16711680, // Red
        "high" => 16737792,     // Red/Orange
        "medium" => 16763904,   // Yellow
        "low" => 65280,         // Green
        _ => 16738656,          // Default Orange
    };

    // Create the payload (no emojis, pings everyone)
    let payload = serde_json::json!({
        "content": format!("New Bug Report Received [{}] @everyone", severity_name),
        "allowed_mentions": { "parse": ["everyone"] },
        "embeds": [
            {
                "title": "Bug Description",
                "description": sanitized_desc,
                "color": embed_color,
                "fields": [
                    {
                        "name": "Category",
                        "value": category_name,
                        "inline": true
                    },
                    {
                        "name": "Severity",
                        "value": severity_name,
                        "inline": true
                    },
                    {
                        "name": "OS & Architecture",
                        "value": format!("{} ({})", os_name, os_arch),
                        "inline": true
                    },
                    {
                        "name": "Launcher Version",
                        "value": launcher_version,
                        "inline": true
                    },
                    {
                        "name": "Game Status",
                        "value": format!(
                            "Installed: {}\nRunning: {}\nDownloading: {}\nPlay Mode: {}",
                            if is_installed { "Yes" } else { "No" },
                            if is_game_running { "Yes" } else { "No" },
                            if is_downloading { "Yes" } else { "No" },
                            cfg.play_mode
                        ),
                        "inline": false
                    },
                    {
                        "name": "Active Theme",
                        "value": format!("{} (Baseline: {})", cfg.theme, cfg.baseline_theme),
                        "inline": true
                    },
                    {
                        "name": "AV Exclusion Status",
                        "value": if cfg.defender_excluded { "Excluded" } else { "Not Excluded" },
                        "inline": true
                    },
                    {
                        "name": "Options",
                        "value": format!(
                            "Minimize on Launch: {}\nClose on Launch: {}\nInstall Location: {}\nLaunch Options: {}",
                            cfg.minimize_on_launch,
                            cfg.close_on_launch,
                            if cfg.install_dir.is_empty() { "Default" } else { "Custom" },
                            if cfg.launch_options.is_empty() { "None" } else { &cfg.launch_options }
                        ),
                        "inline": false
                    }
                ]
            }
        ]
    });

    // 5. Send POST request via reqwest multipart form
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

    let url = "https://discord.com/api/webhooks/1513559636333170749/pf4DGcoowdQsFZignVKwcErrTb-HnOXPnOOGORRi1w_xAljckbmx9g0BZhSjzzhVmefj";
    
    // Build multipart form data
    let mut form = reqwest::multipart::Form::new();
    
    let payload_str = serde_json::to_string(&payload)
        .map_err(|e| format!("JSON serialization error: {}", e))?;
    let payload_part = reqwest::multipart::Part::text(payload_str)
        .mime_str("application/json")
        .map_err(|e| format!("Mime type error: {}", e))?;
    form = form.part("payload_json", payload_part);
    
    if !logs.is_empty() {
        let logs_part = reqwest::multipart::Part::text(logs)
            .file_name("logs.txt")
            .mime_str("text/plain")
            .map_err(|e| format!("Mime type error: {}", e))?;
        form = form.part("files[0]", logs_part);
    }

    let response = client
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Discord webhook failed with status: {}", response.status()));
    }

    // Update cooldown timestamp only on successful send
    LAST_SUBMISSION_TIME.store(now, Ordering::SeqCst);

    Ok("Bug report successfully submitted. Thank you!".to_string())
}
