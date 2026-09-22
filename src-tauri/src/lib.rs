pub mod background;
pub mod config;
pub mod defender;
pub mod desktop_notify;
pub mod download;
pub mod frost;
pub mod game;
pub mod scraper;
pub mod server;
pub mod thumbs;
pub mod updater;
pub mod vanilla;
pub mod vanilla_auth;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Enforce a single running instance. Must be registered before any other
        // plugin. When the user launches the launcher again while one is already
        // running, this fires in the existing process instead of opening a second
        // window — we restore and focus the current window so it comes to front.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Also how a launcher hidden in the tray comes back when it is
            // started again from the Start menu or a shortcut. Not when the
            // second start is the startup entry itself: that one asked to
            // stay in the tray.
            if !args.iter().any(|a| a == background::BACKGROUND_ARG) {
                background::show_main(app);
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
            cmd_set_glass_backdrop,
            cmd_fetch_glass_backdrop,
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
            // Vanilla account
            vanilla_auth::vanilla_login,
            vanilla_auth::vanilla_logout,
            vanilla_auth::vanilla_auth_status,
            vanilla_auth::vanilla_account,
            vanilla_auth::vanilla_notifications,
            vanilla_auth::vanilla_room_cheered,
            vanilla_auth::vanilla_set_room_cheer,
            vanilla_auth::vanilla_cheered_photos,
            vanilla_auth::vanilla_toggle_photo_cheer,
            vanilla_auth::vanilla_subscribed,
            vanilla_auth::vanilla_set_subscribed,
            vanilla_auth::vanilla_join_room,
            vanilla_auth::vanilla_current_room,
            // Background / startup
            background::get_autostart,
            background::set_autostart,
            background::set_tray_state,
            background::show_launcher,
            background::tray_menu_state,
            background::tray_menu_show,
            background::tray_menu_hide,
            background::tray_menu_pick,
            // Desktop notification pop-up
            desktop_notify::desktop_notify,
            desktop_notify::desktop_notif_take,
            desktop_notify::desktop_notif_layout,
            desktop_notify::desktop_notif_open,
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

            // Give back the Vanilla bulk sets once nothing has read them for a
            // while. See `vanilla::BULK_IDLE_EVICT`.
            vanilla::start_idle_eviction();

            // Tray icon. Not fatal: without it the launcher still works, it
            // just can't be reopened from the tray.
            let _ = background::setup_tray(&app_handle);
            background::apply_startup_default(&app_handle);
            if let Some(main) = app.get_webview_window("main") {
                background::sharpen_window_icon(&main);
            }

            // The window is created hidden (tauri.conf.json). Started with
            // Windows, it stays in the tray; otherwise it is shown now.
            if !background::started_in_background() {
                background::show_main(&app_handle);
            }

            // Listen for window maximize/unmaximize events
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                let popup_app = app_handle.clone();
                window.on_window_event(move |event| {
                    use tauri::Emitter;
                    match event {
                        tauri::WindowEvent::Resized(_) => {
                            if let Ok(maximized) = window_clone.is_maximized() {
                                let _ = window_clone.emit("window-maximized-state", maximized);
                            }
                        }
                        // The notification pop-up is a separate, usually hidden
                        // window; left open it would keep the app running.
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            if background::hide_instead_of_close(&popup_app) {
                                api.prevent_close();
                            }
                        }
                        tauri::WindowEvent::Destroyed => {
                            desktop_notify::close_popup(&popup_app);
                            background::close_tray_menu(&popup_app);
                        }
                        _ => {}
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
///
/// Decoding works over the bytes throughout. Re-slicing the `&str` by byte
/// index instead — `&s[i + 1..i + 3]` — panics whenever those indices land
/// inside a multi-byte character, which a `%` followed by one ASCII byte and
/// then any non-ASCII character produces. That panic happens on a spawned task
/// in the `radiumimg:` scheme handler, and the release profile sets
/// `panic = "abort"`, so it would take the whole launcher down rather than fail
/// one image. See `a_stray_percent_before_a_multibyte_char_does_not_panic`.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = hex_pair(bytes[i + 1], bytes[i + 2]) {
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

/// The byte two ASCII hex digits spell, or `None` if either isn't one.
fn hex_pair(hi: u8, lo: u8) -> Option<u8> {
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    Some(digit(hi)? * 16 + digit(lo)?)
}

#[cfg(test)]
mod thumb_request_tests {
    use super::*;

    #[test]
    fn a_stray_percent_before_a_multibyte_char_does_not_panic() {
        // The exact shape that used to abort the process: a '%' followed by one
        // ASCII byte and then a character whose bytes straddle the index the
        // old `&s[i + 1..i + 3]` slice asked for.
        assert_eq!(percent_decode("%aé"), "%aé");
        assert_eq!(percent_decode("%é"), "%é");
        assert_eq!(percent_decode("%%é"), "%%é");
        assert_eq!(percent_decode("https://x/ü?%zz"), "https://x/ü?%zz");
    }

    #[test]
    fn ordinary_escapes_still_decode() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fapi.vanillarec.net%2Fimages%2Fa_b"),
            "https://api.vanillarec.net/images/a_b"
        );
        // Lower and upper case hex, and a multi-byte character that was encoded
        // properly, both round-trip.
        assert_eq!(percent_decode("%c3%a9%C3%A9"), "éé");
        // A truncated escape at the very end is passed through, not consumed.
        assert_eq!(percent_decode("abc%4"), "abc%4");
        assert_eq!(percent_decode("%"), "%");
    }

    #[test]
    fn a_malformed_query_is_refused_rather_than_guessed_at() {
        let parse = |q: &str| {
            thumb_request(&format!("http://radiumimg.localhost/thumb?{}", q).parse().unwrap())
        };
        assert_eq!(
            parse("url=https%3A%2F%2Fimg.radie.app%2FRoom_1&w=480"),
            Some(("https://img.radie.app/Room_1".to_string(), 480))
        );
        assert_eq!(parse("url=https%3A%2F%2Fimg.radie.app%2FRoom_1"), None);
        assert_eq!(parse("w=480"), None);
        assert_eq!(parse("url=x&w=notanumber"), None);
    }
}

fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("a status-only response is always well-formed")
}

// Config commands - thin wrappers that pass the app handle
#[tauri::command(async)]
fn cmd_get_config(app: tauri::AppHandle) -> serde_json::Value {
    let cfg = config::current(&app);
    serde_json::to_value(&*cfg).unwrap_or(serde_json::json!({}))
}

#[tauri::command(async)]
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
            config::drop_relative_install_dirs(&mut cfg);

            // The glass tint and backdrop become CSS in a generated
            // stylesheet, so anything that isn't one is repaired on the way in
            // rather than stored and handed back to the renderer next load.
            cfg.glass.sanitize();

            // Only skins that actually ship. Without this a save could pin the
            // window to a class with no rules behind it.
            if !config::AVAILABLE_THEMES.contains(&cfg.theme.as_str()) {
                cfg.theme = config::DEFAULT_THEME.to_string();
            }
            if !config::AVAILABLE_THEMES.contains(&cfg.baseline_theme.as_str()) {
                cfg.baseline_theme = cfg.theme.clone();
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
            let _lock = config::write_lock();
            // Refused while config.json can't be read: `current` would be the
            // stand-in defaults, and preserving *their* backend fields would
            // blank the client build and version the file really holds.
            let Ok(current) = config::current_checked(&app) else {
                return false;
            };
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

/// Set the Liquid Glass backdrop, and nothing else.
///
/// Its own command because the value can be a 1.4 MB data URI: whole-config
/// saves leave it out and keep the stored one (see
/// `preserve_backend_managed_fields`), so an autosave no longer ships and
/// re-parses it. Returns the value as stored, which is blank if it was not a
/// backdrop that is safe to put in the stylesheet.
#[tauri::command(async)]
fn cmd_set_glass_backdrop(app: tauri::AppHandle, value: String) -> Result<String, String> {
    config::update(&app, |cfg| {
        cfg.glass.bg_image = value;
        cfg.glass.sanitize();
        cfg.glass.bg_image.clone()
    })
}

/// Download a picture for the glass backdrop from an address the user typed.
///
/// Handed back as raw bytes (an `ArrayBuffer` on the page), which the page
/// downscales and saves through [`cmd_set_glass_backdrop`] like a picked file.
/// See `thumbs::backdrop_source` for why the page can't load the address
/// itself.
#[tauri::command]
async fn cmd_fetch_glass_backdrop(url: String) -> Result<tauri::ipc::Response, String> {
    thumbs::backdrop_source(&url).await.map(tauri::ipc::Response::new)
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
/// `check_install`'s rule: a Radium client whose recorded build id differs
/// from the one this launcher requires is outdated and must be re-downloaded.
/// Vanilla installs come from a user-supplied zip with no build to track, so
/// they are never called outdated.
fn client_status_label(network: config::Network, is_installed: bool, client_build: &str) -> &'static str {
    if !is_installed {
        "Not installed"
    } else if network == config::Network::Vanilla {
        "Installed (no build tracking)"
    } else if client_build != download::REQUIRED_CLIENT_BUILD {
        "OUTDATED — re-download required"
    } else {
        "Up to date"
    }
}

/// The signed-in Windows user's profile folder (`C:\Users\<name>`), if known.
fn user_profile_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(|p| p.trim_end_matches(['\\', '/']).to_string())
        // Too short to be a profile path; replacing it would mangle the text.
        .filter(|p| p.len() >= 4)
}

/// `text` with the user's profile folder replaced by `%USERPROFILE%`.
///
/// Bug reports go to a Discord channel, and the log lines and install path
/// they carry spell out `C:\Users\<name>\...` — the person's Windows account
/// name, which a report needs no more than it needs their password. Matched
/// case-insensitively (Windows paths are) and in the three spellings that
/// reach the log: backslashes, forward slashes and JSON-escaped backslashes.
fn redact_profile_path(text: &str, profile: &str) -> String {
    let mut out = text.to_string();
    for needle in [
        profile.to_string(),
        profile.replace('\\', "/"),
        profile.replace('\\', "\\\\"),
    ] {
        out = replace_path_ignore_ascii_case(&out, &needle, "%USERPROFILE%");
    }
    out
}

/// Replace every ASCII-case-insensitive occurrence of the path `needle` in
/// `haystack` that ends where a path component ends — so `C:\Users\Jane` is
/// not matched inside `C:\Users\Janet`.
///
/// Compared byte by byte, but only ever cut at a match's first and last byte:
/// non-ASCII bytes must match exactly, so a match begins and ends on the same
/// character boundaries it has in `needle`, and slicing there cannot panic.
fn replace_path_ignore_ascii_case(haystack: &str, needle: &str, with: &str) -> String {
    let (hay, pat) = (haystack.as_bytes(), needle.as_bytes());
    if pat.is_empty() || pat.len() > hay.len() {
        return haystack.to_string();
    }
    let ends_component = |at: usize| {
        hay.get(at)
            // A '.' ends it: after a profile path that is far more often the
            // end of a log sentence than the rest of a longer account name.
            .map(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_') || *b >= 0x80))
            .unwrap_or(true)
    };
    let mut out = String::with_capacity(haystack.len());
    let (mut last, mut i) = (0, 0);
    while i + pat.len() <= hay.len() {
        if hay[i..i + pat.len()].eq_ignore_ascii_case(pat) && ends_component(i + pat.len()) {
            out.push_str(&haystack[last..i]);
            out.push_str(with);
            i += pat.len();
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&haystack[last..]);
    out
}

#[cfg(test)]
mod bug_report_tests {
    use super::*;

    #[test]
    fn the_profile_path_is_redacted_in_every_spelling() {
        let profile = r"C:\Users\Jane Doe";
        let text = concat!(
            r"Install dir: C:\Users\Jane Doe\AppData\Roaming\com.radium.launcher\client",
            "\n",
            r"Exe: c:\users\jane doe\x\RecRoom.exe | C:/Users/Jane Doe/y | C:\\Users\\Jane Doe\\z",
        );
        let out = redact_profile_path(text, profile);
        assert!(!out.to_lowercase().contains("jane"), "{out}");
        assert!(out.contains(r"%USERPROFILE%\AppData\Roaming"));
        assert!(out.contains("%USERPROFILE%/y"));
        assert!(out.contains(r"%USERPROFILE%\\z"));
    }

    #[test]
    fn redaction_leaves_other_text_and_multibyte_characters_alone() {
        let profile = r"C:\Users\Zoë";
        let text = r"é C:\Users\Zoë\x — C:\Users\Zoey stays, D:\Users\Zoë stays";
        let out = redact_profile_path(text, profile);
        assert_eq!(out, r"é %USERPROFILE%\x — C:\Users\Zoey stays, D:\Users\Zoë stays");
        assert_eq!(replace_path_ignore_ascii_case("abc", "", "x"), "abc");
        assert_eq!(replace_path_ignore_ascii_case("ab", "abc", "x"), "ab");
    }

    #[test]
    fn another_account_sharing_the_name_prefix_is_not_touched() {
        let out = redact_profile_path(r"C:\Users\Janet\x and C:\Users\Jane.", r"C:\Users\Jane");
        assert_eq!(out, r"C:\Users\Janet\x and %USERPROFILE%.");
    }

    #[test]
    fn a_long_log_keeps_its_newest_whole_lines() {
        assert_eq!(log_tail("short", 100), "short");
        let log = "old line one\nold line two\nnewest line\n";
        // Cut inside "old line two": that partial line goes too.
        assert_eq!(log_tail(log, 20), "newest line\n");
        // A cut that would split a multi-byte character moves past it.
        let tail = log_tail("ééééé\nlast", 6);
        assert_eq!(tail, "last");
    }

    #[test]
    fn online_label_is_tri_state() {
        assert_eq!(online_label(Some(true)), "ONLINE");
        assert_eq!(online_label(Some(false)), "OFFLINE");
        // Not-yet-polled must never read as OFFLINE.
        assert_eq!(online_label(None), "Not checked");
    }

    #[test]
    fn client_status_reflects_build_health() {
        use config::Network::{Radium, Vanilla};
        assert_eq!(client_status_label(Radium, false, ""), "Not installed");
        assert_eq!(client_status_label(Radium, false, download::REQUIRED_CLIENT_BUILD), "Not installed");
        // Installed but with a stale/blank build id → flagged outdated.
        assert_eq!(client_status_label(Radium, true, ""), "OUTDATED — re-download required");
        assert_eq!(client_status_label(Radium, true, "recroom-baby-2015"), "OUTDATED — re-download required");
        // Installed with the required build id → healthy.
        assert_eq!(client_status_label(Radium, true, download::REQUIRED_CLIENT_BUILD), "Up to date");
        // Vanilla has no build to compare, as in `check_install`.
        assert_eq!(client_status_label(Vanilla, true, ""), "Installed (no build tracking)");
        assert_eq!(client_status_label(Vanilla, false, ""), "Not installed");
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
    // 1. Length Validation
    let trimmed = description.trim();
    let len = trimmed.chars().count();
    if len < 10 {
        return Err("Description is too short. Minimum 10 characters required.".into());
    }
    if len > 1500 {
        return Err("Description is too long. Maximum 1500 characters allowed.".into());
    }

    // 2. Cooldown Safeguard (60 seconds). The slot is claimed before the send
    // rather than stamped after it: two clicks landing together each read the
    // old time, both passed, and both reports went out. A send that fails
    // gives the slot back.
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
    if LAST_SUBMISSION_TIME
        .compare_exchange(last_time, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Another bug report is being sent. Please wait a minute.".into());
    }
    let result = send_bug_report(app, trimmed, logs, &category, &severity, &diagnostics).await;
    if result.is_err() {
        let _ = LAST_SUBMISSION_TIME.compare_exchange(now, last_time, Ordering::SeqCst, Ordering::SeqCst);
    }
    result
}

/// The most of the runtime log a report attaches: the newest part, which is
/// the part that explains the problem. The launcher keeps 2,000 lines, but a
/// line can quote a whole server reply.
const MAX_REPORT_LOG_BYTES: usize = 2 * 1024 * 1024;

/// The last `max` bytes of `text`, cut at a line start.
fn log_tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let tail = &text[start..];
    tail.find('\n').map(|i| &tail[i + 1..]).unwrap_or(tail)
}

async fn send_bug_report(
    app: tauri::AppHandle,
    trimmed: &str,
    logs: String,
    category: &str,
    severity: &str,
    diagnostics: &serde_json::Value,
) -> Result<String, String> {

    // 3. Discord Ping Sanitization
    let sanitized_desc = trimmed
        .replace("@everyone", "`@everyone`")
        .replace("@here", "`@here`");
    // The Windows account name is not the report's to send. See
    // `redact_profile_path`; applied to the description and the log file.
    let profile = user_profile_dir();
    let redact = |text: String| match &profile {
        Some(p) => redact_profile_path(&text, p),
        None => text,
    };
    let sanitized_desc = redact(sanitized_desc);

    // 4. Gather System Diagnostics
    let cfg = config::current(&app);
    let os_name = std::env::consts::OS;
    let os_arch = std::env::consts::ARCH;

    // This build's own version, not the page's word for it.
    let launcher_version = format!("v{}", app.package_info().version);
    let is_installed = diagnostics.get("isInstalled").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_game_running = diagnostics.get("isGameRunning").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_downloading = diagnostics.get("isDownloading").and_then(|v| v.as_bool()).unwrap_or(false);
    // Phase of the download, so a paused or cancelling launcher isn't reported
    // as simply "not downloading". Older frontends omit it; fall back to the
    // bool. Only the four phases there are: this lands in the embed as-is.
    let download_state = match diagnostics.get("downloadState").and_then(|v| v.as_str()) {
        Some(state @ ("idle" | "downloading" | "paused" | "cancelling")) => state,
        _ if is_downloading => "downloading",
        _ => "idle",
    };
    let error_count = diagnostics.get("errorCount").and_then(|v| v.as_u64()).unwrap_or(0);
    // The two modes there are. config.json is hand-editable, and a long value
    // here would push the embed field past Discord's 1024 characters, which
    // refuses the whole report.
    let play_mode = if cfg.play_mode == "vr" { "vr" } else { "screen" };

    // Server reachability comes from the frontend's last poll; a tri-state so a
    // report made before the first poll doesn't misreport servers as OFFLINE.
    let api_online = diagnostics.get("apiOnline").and_then(|v| v.as_bool());
    let cdn_online = diagnostics.get("cdnOnline").and_then(|v| v.as_bool());

    // Client build/version are read straight from config (authoritative) rather
    // than trusted from the frontend — and for the network the report was
    // filed from. Radium's flat fields used to be read whatever it was, so a
    // Vanilla report described Radium's client, and called a Vanilla install
    // with no Radium build "OUTDATED".
    let network = cfg.network();
    let client_build = match cfg.client_build_for(network) {
        "" => "unrecorded".to_string(),
        b => b.to_string(),
    };
    let client_version = match cfg.client_version_for(network) {
        "" => "unknown".to_string(),
        v => v.to_string(),
    };
    let client_status = client_status_label(network, is_installed, cfg.client_build_for(network));
    let install_dir = cfg.install_dir_for(network);
    let av_excluded = match network {
        config::Network::Radium => cfg.defender_excluded,
        config::Network::Vanilla => cfg.vanilla.defender_excluded,
    };

    // Only the labels the form offers. Anything else used to be echoed as-is
    // into the embed and into the message that pings the channel, where an
    // `@here` or an overlong string (Discord rejects a field over 1024
    // characters) would have ridden along.
    let category_name = match category.to_lowercase().as_str() {
        "general" => "General / Launcher Issue",
        "launch" => "Game Launch Failure / Crash",
        "theme" => "UI Layout / Custom Themes",
        _ => "Other / Unspecified",
    };

    let severity_name = match severity.to_lowercase().as_str() {
        "critical" => "Critical - Launcher Crash/Freeze",
        "high" => "High - Cannot Launch/Play",
        "low" => "Low - Cosmetic/Typo",
        _ => "Medium - Functional Issue",
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
                            "Network: {}\nInstalled: {}\nRunning: {}\nDownload: {}\nPlay Mode: {}\nErrors logged: {}",
                            network.as_str(),
                            if is_installed { "Yes" } else { "No" },
                            if is_game_running { "Yes" } else { "No" },
                            download_state,
                            play_mode,
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
                        "value": if av_excluded { "Excluded" } else { "Not Excluded" },
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
                            if install_dir.is_empty() { "Default" } else { "Custom" }
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
         Launcher : {}\n\
         Network  : {}\n\
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
        network.as_str(),
        os_name, os_arch,
        category_name, severity_name,
        client_version, client_build, download::REQUIRED_CLIENT_BUILD, client_status,
        is_installed, is_game_running, download_state, play_mode,
        error_count,
        online_label(api_online), online_label(cdn_online),
        if install_dir.is_empty() { "Default" } else { install_dir },
        cfg.theme, cfg.baseline_theme,
    );

    // Always attach the file — even with no runtime logs the header is useful.
    let log_body = redact(if logs.is_empty() {
        format!("{}(no runtime log lines captured this session)\n", log_header)
    } else {
        format!("{}{}", log_header, log_tail(&logs, MAX_REPORT_LOG_BYTES))
    });
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
