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
            download::open_client_folder,
            download::select_folder,
            download::get_default_client_dir,
            download::restore_dll,
            // Game
            game::launch_game,
            game::kill_game,
            game::check_game_running,
            game::check_steam,
            game::check_smart_app_control,
            // Defender
            defender::add_defender_exclusion,
            defender::remove_defender_exclusion,
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
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                use tauri::Emitter;
                if let tauri::WindowEvent::Resized(_) = event {
                    if let Ok(maximized) = window_clone.is_maximized() {
                        let _ = window_clone.emit("window-maximized-state", maximized);
                    }
                }
            });

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
            let dir = &cfg.install_dir;
            if dir.contains('"') || dir.contains(';') || dir.contains('&') || dir.contains('|') || dir.contains('\r') || dir.contains('\n') {
                return false;
            }
            let opt = &cfg.launch_options;
            if opt.contains(';') || opt.contains('&') || opt.contains('|') || opt.contains('\r') || opt.contains('\n') {
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

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    match std::process::Command::new("cmd")
        .raw_arg("/c")
        .raw_arg(format!("\"{}\"", bat_path.to_string_lossy()))
        .current_dir(&client_dir)
        .output()
    {
        Ok(output) => serde_json::json!({
            "ok": output.status.success(),
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
        }),
        Err(e) => serde_json::json!({
            "ok": false,
            "err": e.to_string(),
        }),
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
async fn submit_bug_report(app: tauri::AppHandle, description: String, logs: String) -> Result<String, String> {
    // 1. Cooldown Safeguard (60 seconds)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let last_time = LAST_SUBMISSION_TIME.load(Ordering::Relaxed);
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

    // Create the payload
    let payload = serde_json::json!({
        "content": "🛠️ **New Bug Report Received**",
        "embeds": [
            {
                "title": "Bug Description",
                "description": sanitized_desc,
                "color": 16738656, // Orange
                "fields": [
                    {
                        "name": "💻 OS & Architecture",
                        "value": format!("{} ({})", os_name, os_arch),
                        "inline": true
                    },
                    {
                        "name": "🚀 Play Mode",
                        "value": &cfg.play_mode,
                        "inline": true
                    },
                    {
                        "name": "🎨 Active Theme",
                        "value": &cfg.theme,
                        "inline": true
                    },
                    {
                        "name": "📂 Options",
                        "value": format!("Minimize on launch: {}\nClose on launch: {}\nLaunch Options: `{}`", cfg.minimize_on_launch, cfg.close_on_launch, cfg.launch_options),
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
    LAST_SUBMISSION_TIME.store(now, Ordering::Relaxed);

    Ok("Bug report successfully submitted. Thank you!".to_string())
}

