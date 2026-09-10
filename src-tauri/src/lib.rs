pub mod config;
pub mod defender;
pub mod download;
pub mod game;
pub mod scraper;
pub mod server;
pub mod thumbs;
pub mod updater;
pub mod vanilla;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Enforce a single running instance. Must be registered before any other
        // plugin. When the user launches the launcher again while one is already
        // running, this fires in the existing process instead of opening a second
        // window — we restore and focus the current window so it comes to front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        // Every remote image in the UI is loaded through here rather than
        // straight from its origin, so it arrives downscaled to the size the
        // card draws it at and is kept on disk. See the `thumbs` module for
        // what that is worth: Vanilla's room images are 2560x1440 PNGs served
        // with no cache headers at all.
        //
        // Asynchronous, so a slow origin blocks only its own `<img>` rather
        // than the webview's main thread.
        .register_asynchronous_uri_scheme_protocol("radiumimg", |_ctx, request, responder| {
            let target = thumb_request(request.uri());
            tauri::async_runtime::spawn(async move {
                responder.respond(match target {
                    Some((url, width)) => match thumbs::thumbnail(&url, width).await {
                        // The content type comes back with the bytes: a
                        // thumbnail is JPEG unless the source needed an alpha
                        // channel, in which case it stays PNG.
                        Ok((bytes, mime)) => tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            // A custom scheme is a separate origin from the
                            // page, so this matches what Tauri's own asset
                            // protocol sends. `<img>` does not need it, but
                            // anything that ever reads one of these with
                            // fetch() would.
                            .header("Access-Control-Allow-Origin", "*")
                            // The bytes are already keyed by URL and width and
                            // are re-derived on a miss, so letting the webview
                            // hold them saves even the file read.
                            .header("Cache-Control", "public, max-age=86400")
                            .body(bytes)
                            .unwrap_or_else(|_| empty_response(500)),
                        // The `<img>` fires `error` and the shared handler in
                        // app.js swaps in the bundled placeholder.
                        Err(_) => empty_response(502),
                    },
                    None => empty_response(400),
                });
            });
        })
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
            server::prefetch_network_data,
            // Scraper
            scraper::fetch_room_web_details,
            scraper::fetch_user_web_details,
            scraper::fetch_photo_web_details,
            scraper::fetch_photo_comments,
            // Download / Install
            download::download_client,
            download::cancel_download,
            download::pause_download,
            download::resumable_download_info,
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

            // The scheme handler above runs without an app handle, so the
            // thumbnail directory has to be resolved here and handed over.
            // Under the cache dir rather than app data: losing it costs a
            // refetch, and nothing in it is worth backing up.
            thumbs::init(
                app.path()
                    .app_cache_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("radium-launcher"))
                    .join("thumbs"),
            );

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

/// The image URL and width a `radiumimg://` request is asking for.
///
/// Tauri hands the request as an absolute URI, which on Windows is
/// `http://radiumimg.localhost/thumb?...` and elsewhere `radiumimg://thumb?...`
/// — so only the query is read, and the host and path are ignored rather than
/// matched against a platform-specific shape.
///
/// Returns `None` for anything malformed; the URL itself is checked against the
/// allowed image hosts in `thumbs`, not here.
fn thumb_request(uri: &tauri::http::Uri) -> Option<(String, u32)> {
    let query = uri.query()?;
    let mut url = None;
    let mut width = None;

    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        match key {
            "url" => url = Some(percent_decode(value)),
            "w" => width = value.parse::<u32>().ok(),
            _ => {}
        }
    }
    Some((url?, width?))
}

/// Undo the `encodeURIComponent` the frontend applied to the image URL.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("a status-only response is always well-formed")
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
        Ok(mut cfg) => {
            // Only reject characters that are illegal in Windows paths anyway
            // (plus control chars). Legal folder names like "Games & Mods" or
            // "100%" must be saveable; the launch path is explicitly quoted at
            // spawn time, so shell metacharacters in the path are inert.
            let bad_dir = |dir: &str| {
                dir.chars().any(|c| c.is_control())
                    || dir.contains('"')
                    || dir.contains('<')
                    || dir.contains('>')
                    || dir.contains('|')
            };
            // Both networks' install dirs are user-settable, so both get checked.
            if bad_dir(&cfg.install_dir) || bad_dir(&cfg.vanilla.install_dir) {
                return false;
            }

            // Preserve backend-managed fields from the on-disk config. The
            // settings UI keeps a full in-memory copy of the config and writes
            // the whole thing back on every autosave, but it loads that copy
            // once at startup and never learns about fields the backend writes
            // afterwards (e.g. the client build id / version / ETag stamped in
            // by a download, or the one-time version-sync flag). Without this,
            // a stale settings save silently reverts those to their defaults —
            // which reported a freshly-downloaded client as "outdated" on the
            // very next check, causing an endless re-download loop.
            let current = config::ensure_config(&app);
            cfg.preserve_backend_managed_fields(&current);

            // Last line of defence for the per-network install dirs: whatever
            // the settings form sends, the two networks must never end up
            // resolving to the same client folder — that is what let a Radium
            // download land in the Vanilla folder and made Vanilla report an
            // install it never had.
            config::dedupe_install_dirs(&app, &mut cfg);

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

/// Human-readable reachability for a tri-state ping result. `None` means the
/// frontend hadn't polled yet, which must not be reported as OFFLINE.
fn online_label(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "ONLINE",
        Some(false) => "OFFLINE",
        None => "Not checked",
    }
}

/// Bug-report label for the installed client's build health. Mirrors
/// `check_install`'s rule: a client whose recorded build id differs from the
/// one this launcher requires is outdated and must be re-downloaded.
fn client_status_label(is_installed: bool, client_build: &str) -> &'static str {
    if !is_installed {
        "Not installed"
    } else if client_build != download::REQUIRED_CLIENT_BUILD {
        "OUTDATED — re-download required"
    } else {
        "Up to date"
    }
}

#[cfg(test)]
mod bug_report_tests {
    use super::*;

    #[test]
    fn online_label_is_tri_state() {
        assert_eq!(online_label(Some(true)), "ONLINE");
        assert_eq!(online_label(Some(false)), "OFFLINE");
        // Not-yet-polled must never read as OFFLINE.
        assert_eq!(online_label(None), "Not checked");
    }

    #[test]
    fn client_status_reflects_build_health() {
        assert_eq!(client_status_label(false, ""), "Not installed");
        assert_eq!(client_status_label(false, download::REQUIRED_CLIENT_BUILD), "Not installed");
        // Installed but with a stale/blank build id → flagged outdated.
        assert_eq!(client_status_label(true, ""), "OUTDATED — re-download required");
        assert_eq!(client_status_label(true, "recroom-baby-2015"), "OUTDATED — re-download required");
        // Installed with the required build id → healthy.
        assert_eq!(client_status_label(true, download::REQUIRED_CLIENT_BUILD), "Up to date");
    }
}

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
    // Phase of the download, so a paused or cancelling launcher isn't reported
    // as simply "not downloading". Older frontends omit it; fall back to the bool.
    let download_state = diagnostics
        .get("downloadState")
        .and_then(|v| v.as_str())
        .unwrap_or(if is_downloading { "downloading" } else { "idle" });
    let error_count = diagnostics.get("errorCount").and_then(|v| v.as_u64()).unwrap_or(0);

    // Server reachability comes from the frontend's last poll; a tri-state so a
    // report made before the first poll doesn't misreport servers as OFFLINE.
    let api_online = diagnostics.get("apiOnline").and_then(|v| v.as_bool());
    let cdn_online = diagnostics.get("cdnOnline").and_then(|v| v.as_bool());

    // Client build/version are read straight from config (authoritative) rather
    // than trusted from the frontend.
    let client_build = if cfg.client_build.is_empty() { "unrecorded".to_string() } else { cfg.client_build.clone() };
    let client_version = if cfg.client_version.is_empty() { "unknown".to_string() } else { cfg.client_version.clone() };
    let client_status = client_status_label(is_installed, &cfg.client_build);

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
                            "Installed: {}\nRunning: {}\nDownload: {}\nPlay Mode: {}\nErrors logged: {}",
                            if is_installed { "Yes" } else { "No" },
                            if is_game_running { "Yes" } else { "No" },
                            download_state,
                            cfg.play_mode,
                            error_count
                        ),
                        "inline": false
                    },
                    {
                        "name": "Client Build",
                        "value": format!(
                            "Version: v{}\nBuild: {}\nRequired: {}\nStatus: {}",
                            client_version, client_build, download::REQUIRED_CLIENT_BUILD, client_status
                        ),
                        "inline": false
                    },
                    {
                        "name": "Server Status",
                        "value": format!(
                            "API Gateway: {}\nCDN Server: {}",
                            online_label(api_online), online_label(cdn_online)
                        ),
                        "inline": true
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
                            "Minimize on Launch: {}
Close on Launch: {}
Install Location: {}",
                            cfg.minimize_on_launch,
                            cfg.close_on_launch,
                            if cfg.install_dir.is_empty() { "Default" } else { "Custom" }
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
    
    // Prepend a self-contained diagnostics header so logs.txt stands alone when
    // read outside the Discord embed. The runtime log lines already carry their
    // [INFO]/[WARN]/[ERROR] severity tags from the launcher's log formatter.
    let log_header = format!(
        "===== RADIUM LAUNCHER — BUG REPORT DIAGNOSTICS =====\n\
         Launcher : v{}\n\
         OS       : {} ({})\n\
         Category : {}\n\
         Severity : {}\n\
         Client   : v{} (build {}) | required {} | {}\n\
         Runtime  : installed={} running={} download={} mode={}\n\
         Errors   : {} logged this session\n\
         Servers  : API {} | CDN {}\n\
         Install  : {}\n\
         Theme    : {} (baseline {})\n\
         ====================================================\n\n",
        launcher_version,
        os_name, os_arch,
        category_name, severity_name,
        client_version, client_build, download::REQUIRED_CLIENT_BUILD, client_status,
        is_installed, is_game_running, download_state, cfg.play_mode,
        error_count,
        online_label(api_online), online_label(cdn_online),
        if cfg.install_dir.is_empty() { "Default".to_string() } else { cfg.install_dir.clone() },
        cfg.theme, cfg.baseline_theme,
    );

    // Always attach the file — even with no runtime logs the header is useful.
    let log_body = if logs.is_empty() {
        format!("{}(no runtime log lines captured this session)\n", log_header)
    } else {
        format!("{}{}", log_header, logs)
    };
    let logs_part = reqwest::multipart::Part::text(log_body)
        .file_name("logs.txt")
        .mime_str("text/plain")
        .map_err(|e| format!("Mime type error: {}", e))?;
    form = form.part("files[0]", logs_part);

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

#[cfg(test)]
mod csp_tests {
    /// The CSP is written twice — `app.security.csp` in `tauri.conf.json`, and a
    /// `<meta http-equiv>` in `index.html` — and a browser enforces the
    /// *intersection* of the two. A source added to only one is therefore still
    /// blocked, silently, and only at runtime. That is exactly how the
    /// `radiumimg:` thumbnail scheme first shipped: allowed in the config,
    /// missing from the meta tag, so every room image failed to load.
    #[test]
    fn the_two_copies_of_the_csp_agree() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("the config is JSON");
        let configured = conf["app"]["security"]["csp"]
            .as_str()
            .expect("tauri.conf.json declares a csp");

        let html = include_str!("../../src/index.html");
        let meta = html
            .split_once(r#"http-equiv="Content-Security-Policy" content=""#)
            .and_then(|(_, rest)| rest.split_once('"'))
            .map(|(csp, _)| csp)
            .expect("index.html declares a CSP meta tag");

        // Compared directive by directive: the two differ in whitespace and in
        // whether they end with a `;`, neither of which changes the policy.
        let directives = |csp: &str| {
            let mut parts: Vec<String> = csp
                .split(';')
                .map(|d| d.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|d| !d.is_empty())
                .collect();
            parts.sort();
            parts
        };

        assert_eq!(
            directives(configured),
            directives(meta),
            "the CSP in tauri.conf.json and the one in src/index.html have drifted; \
             whichever source is missing from either is blocked at runtime"
        );
    }
}
