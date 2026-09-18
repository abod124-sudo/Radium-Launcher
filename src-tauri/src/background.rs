//! Running in the background and starting with Windows.
//!
//! * **Tray icon.** Always there while the launcher runs. Clicking it brings
//!   the window back; its menu has Open and Quit.
//! * **Close to tray.** With `runInBackground` on (the default), closing the
//!   window hides it instead of quitting, so notifications keep arriving. Quit
//!   from the tray menu ends the process. The updater exits the app itself and
//!   is unaffected.
//! * **Start with Windows.** A per-user `Run` registry value — no admin
//!   rights, and the same value name the NSIS uninstaller already removes.
//!   It launches with [`BACKGROUND_ARG`], which keeps the window hidden.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Passed by the startup entry: start in the tray, window hidden.
pub const BACKGROUND_ARG: &str = "--background";

/// The registry value name. Must match `${PRODUCTNAME}` in installer.nsi,
/// whose uninstaller deletes it.
#[cfg(windows)]
const RUN_VALUE_NAME: &str = "Radium Launcher";
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Whether this process was started by the startup entry.
pub fn started_in_background() -> bool {
    std::env::args().any(|a| a == BACKGROUND_ARG)
}

/// Bring the launcher window back from the tray, minimised or behind.
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "Open Radium Launcher", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Radium Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    match tray_icon() {
        Some(icon) => tray = tray.icon(icon),
        None => {
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    tray.build(app)?;
    Ok(())
}

/// The tray icon, drawn at exactly the size the notification area shows.
///
/// Handed a large image, Windows shrinks it for the tray itself, and badly:
/// that is what made the icon look rough. So the 512px artwork is scaled here
/// with a proper filter to the small-icon size for the display's scaling
/// (16px at 100%, 20 at 125%, 24 at 150%, 32 at 200%).
fn tray_icon() -> Option<tauri::image::Image<'static>> {
    const ARTWORK: &[u8] = include_bytes!("../icons/icon.png");
    let size = tray_icon_size();
    let img = image::load_from_memory(ARTWORK).ok()?.to_rgba8();
    let small = image::imageops::resize(&img, size, size, image::imageops::FilterType::Lanczos3);
    Some(tauri::image::Image::new_owned(small.into_raw(), size, size))
}

#[cfg(windows)]
fn tray_icon_size() -> u32 {
    use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::SM_CXSMICON;
    // SAFETY: both are plain queries with no pointers involved.
    let px = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, GetDpiForSystem()) };
    if (16..=128).contains(&px) { px as u32 } else { 16 }
}

#[cfg(not(windows))]
fn tray_icon_size() -> u32 {
    32
}

/// Give a window the icon sizes Windows actually draws.
///
/// Tauri hands every window one image — the 256px entry of icon.ico — and
/// Windows then shrinks it itself for the title bar, the taskbar and Alt-Tab,
/// which is what made it look blurry: most visibly in the title bar of the
/// Vanilla sign-in window, the one window with a native frame. `icon.ico`
/// carries every size from 16 to 256, and the build embeds it in the exe as
/// resource 32512, so the right entries are loaded at the exact sizes for the
/// window's display scaling and set on the window instead.
///
/// Posted rather than sent, so it is safe from any thread: the sign-in window
/// is created from an async command, not on the thread that owns it.
#[cfg(windows)]
pub fn sharpen_window_icon(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        PostMessageW, ICON_BIG, ICON_SMALL, WM_SETICON,
    };

    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = hwnd.0 as _;
    // SAFETY: plain queries; `hwnd` is this live window's handle.
    let dpi = match unsafe { GetDpiForWindow(hwnd) } {
        0 => unsafe { GetDpiForSystem() },
        dpi => dpi,
    };
    let Some((small, big)) = app_icons_for_dpi(dpi) else { return };
    // SAFETY: the icons are cached for the life of the process (see
    // `app_icons_for_dpi`), so they outlive the window using them.
    unsafe {
        PostMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, small);
        PostMessageW(hwnd, WM_SETICON, ICON_BIG as usize, big);
    }
}

#[cfg(not(windows))]
pub fn sharpen_window_icon(_: &tauri::WebviewWindow) {}

/// The app icon at the small (title bar) and large (Alt-Tab) sizes Windows
/// draws at `dpi`, as raw `HICON`s.
///
/// Loaded once per DPI and never freed. Loading afresh for every window leaked
/// two icon handles each time the sign-in window opened, and a window must not
/// be left holding an icon that has been destroyed.
#[cfg(windows)]
fn app_icons_for_dpi(dpi: u32) -> Option<(isize, isize)> {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetSystemMetricsForDpi;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        LoadImageW, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON,
    };
    /// The nameID tauri-winres gives the app icon.
    const ICON_RESOURCE_ID: u32 = 32512;
    static CACHE: std::sync::Mutex<Vec<(u32, isize, isize)>> = std::sync::Mutex::new(Vec::new());

    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(&(_, small, big)) = cache.iter().find(|(d, _, _)| *d == dpi) {
        return Some((small, big));
    }
    // SAFETY: the module handle is this exe's; LoadImageW returns null when
    // the resource or size is unavailable, and a null icon is not used.
    let load = |metric| unsafe {
        let px = GetSystemMetricsForDpi(metric, dpi);
        let icon = LoadImageW(
            GetModuleHandleW(std::ptr::null()),
            ICON_RESOURCE_ID as *const u16,
            IMAGE_ICON,
            px,
            px,
            LR_DEFAULTCOLOR,
        );
        (!icon.is_null()).then_some(icon as isize)
    };
    let icons = (load(SM_CXSMICON)?, load(SM_CXICON)?);
    cache.push((dpi, icons.0, icons.1));
    Some(icons)
}

/// Called for the main window's close request. Returns true when the close
/// was turned into a hide.
pub fn hide_instead_of_close(app: &AppHandle) -> bool {
    if !crate::config::current(app).run_in_background {
        return false;
    }
    hide_main(app);
    true
}

/// Hide the launcher window to the tray.
pub fn hide_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    // The launcher's page decides whether to say where it went (once).
    let _ = app.emit_to("main", "launcher-hidden", ());
}

// ── Start with Windows ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_autostart() -> bool {
    autostart::current().is_some()
}

/// Turn the startup entry on or off. Returns the state it ended up in.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    if enabled {
        autostart::set(&startup_command()?)?;
    } else {
        autostart::remove()?;
    }
    Ok(get_autostart())
}

fn startup_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Couldn't find the launcher's exe: {}", e))?;
    Ok(format!("\"{}\" {}", exe.display(), BACKGROUND_ARG))
}

/// "Start with Windows" is on by default: the first time an installed build
/// runs, it adds the entry once and records that it did, so turning it off
/// later sticks. After that, an existing entry is re-pointed at this exe in
/// case the launcher was reinstalled somewhere else.
///
/// Skipped in debug builds, which would otherwise register the development
/// exe under target/.
pub fn apply_startup_default(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let _lock = crate::config::write_lock();
    let mut cfg = crate::config::ensure_config(app);
    if !cfg.autostart_initialized {
        let _ = set_autostart(true);
        cfg.autostart_initialized = true;
        let _ = crate::config::save_config(app, &cfg);
        return;
    }
    if let (Some(current), Ok(wanted)) = (autostart::current(), startup_command()) {
        if !current.eq_ignore_ascii_case(&wanted) {
            let _ = autostart::set(&wanted);
        }
    }
}

#[cfg(windows)]
mod autostart {
    use super::{RUN_KEY, RUN_VALUE_NAME};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: the handle came from RegCreateKeyExW and is closed once.
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(access: u32) -> Result<Key, String> {
        let path = wide(RUN_KEY);
        let mut hkey: HKEY = std::ptr::null_mut();
        // SAFETY: all pointers are valid for the call; `hkey` is written on success.
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER, path.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE,
                access, std::ptr::null(), &mut hkey, std::ptr::null_mut(),
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("Couldn't open the startup registry key (error {})", rc));
        }
        Ok(Key(hkey))
    }

    /// The startup command, if the entry exists.
    pub fn current() -> Option<String> {
        let key = open(KEY_READ).ok()?;
        let name = wide(RUN_VALUE_NAME);
        let mut buf = vec![0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: `buf` holds `bytes` bytes; the value is read as REG_SZ only.
        let rc = unsafe {
            RegGetValueW(
                key.0, std::ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(),
                buf.as_mut_ptr().cast(), &mut bytes,
            )
        };
        if rc != ERROR_SUCCESS {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    pub fn set(command: &str) -> Result<(), String> {
        let key = open(KEY_WRITE)?;
        let name = wide(RUN_VALUE_NAME);
        let data = wide(command);
        // SAFETY: `data` is a NUL-terminated UTF-16 string of the given byte length.
        let rc = unsafe {
            RegSetValueExW(
                key.0, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("Couldn't add the startup entry (error {})", rc));
        }
        Ok(())
    }

    pub fn remove() -> Result<(), String> {
        let key = open(KEY_WRITE)?;
        let name = wide(RUN_VALUE_NAME);
        // SAFETY: `name` is NUL-terminated.
        let rc = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
        if rc != ERROR_SUCCESS && rc != ERROR_FILE_NOT_FOUND {
            return Err(format!("Couldn't remove the startup entry (error {})", rc));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod autostart {
    pub fn current() -> Option<String> {
        None
    }
    pub fn set(_: &str) -> Result<(), String> {
        Err("Starting with the system is only supported on Windows".into())
    }
    pub fn remove() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod icon_tests {
    #[test]
    fn tray_icon_is_drawn_at_the_tray_size() {
        let icon = super::tray_icon().expect("artwork decodes");
        let size = super::tray_icon_size();
        assert_eq!((icon.width(), icon.height()), (size, size));
        assert_eq!(icon.rgba().len(), (size * size * 4) as usize);
        // Not blank: the logo's green survives the scaling.
        assert!(icon.rgba().chunks(4).any(|p| p[1] > 150 && p[3] > 200));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::autostart;

    /// Writes the real per-user Run key, so it only runs when asked for
    /// (`cargo test -- --ignored`), and puts back whatever was there.
    #[test]
    #[ignore]
    fn startup_entry_round_trips_and_is_restored() {
        let before = autostart::current();
        autostart::set(r#""C:\radium-test\radium-launcher.exe" --background"#).unwrap();
        assert_eq!(
            autostart::current().as_deref(),
            Some(r#""C:\radium-test\radium-launcher.exe" --background"#)
        );
        autostart::remove().unwrap();
        assert_eq!(autostart::current(), None);
        // Removing twice is fine.
        autostart::remove().unwrap();
        if let Some(cmd) = before {
            autostart::set(&cmd).unwrap();
        }
    }
}
