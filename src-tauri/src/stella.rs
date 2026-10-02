//! Stella: where its client and patch come from, which patch is trusted, and
//! how the patch gets into the game.
//!
//! Stella ships the stock 2024 Rec Room client plus `Stella2024.dll`, a small
//! patch that hooks `GameAssembly.dll` to send the game to Stella's servers
//! instead of Rec Room's. Nothing in the client loads that DLL — it has no
//! exports and is not a proxy for any DLL the game imports — so, as Stella's
//! own launcher does, this one starts `RecRoom.exe` and loads the patch into
//! it once the game code is in memory.
//!
//! The patch is unsigned and served from a "latest" URL that can change at any
//! time, so where it came from proves nothing. Trust is decided by its SHA-256
//! instead:
//!
//! * a build in [`PINNED_PATCH_SHA256`] was checked by hand and is installed
//!   without asking, alongside the client;
//! * any other build is offered as an UPDATE on Home, and is only installed
//!   when the user presses it;
//! * at launch the file on disk must still hash to the build the user
//!   accepted (`config.stella.patchSha256`), or nothing is injected.
//!
//! Both downloads are refused by Stella's Cloudflare without their launcher's
//! User-Agent, so every request here sends [`USER_AGENT`].

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::config;
use crate::download::sha256_of;

/// The full Windows client, a zip of about 4.7 GB (8.6 GB extracted). Served
/// chunked, with no length, ETag or range support.
pub const CLIENT_URL: &str = "https://api.stellaonline.org/download/latestwindowsbuild";

/// The current patch DLL.
pub const PATCH_URL: &str = "https://api.stellaonline.org/download/latestpcpatch";

/// Stella's Cloudflare lets downloads through only with this User-Agent.
pub const USER_AGENT: &str = "Stella Launcher/1.0";

/// Patch builds checked by hand, lowercase hex SHA-256. These install without
/// a prompt; anything else waits for the user to press UPDATE.
///
/// `e11367b7…` is the build served on 2026-10-01: a 1,368,576-byte x64 DLL
/// with no exports that imports only KERNEL32 and hooks GameAssembly.dll with
/// MinHook. Add a new build's hash here once it has been looked at, e.g. with
/// `certutil -hashfile Stella2024.dll SHA256`.
pub const PINNED_PATCH_SHA256: &[&str] =
    &["e11367b7d8fbb9fed83e3874bd087beb862a303f32040fdb57b80a8157fc4574"];

/// Name the patch is stored under, in `<app data>/stella/`.
const PATCH_FILE: &str = "Stella2024.dll";

/// Largest patch this will accept. The real one is 1.3 MB.
const MAX_PATCH_BYTES: u64 = 16 * 1024 * 1024;

/// The event the UPDATE progress bar listens to.
const PROGRESS_EVENT: &str = "stella-patch-progress";

/// One patch update at a time.
static UPDATING: AtomicBool = AtomicBool::new(false);

struct UpdatingGuard;
impl Drop for UpdatingGuard {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::SeqCst);
    }
}

pub fn is_pinned(sha256: &str) -> bool {
    PINNED_PATCH_SHA256
        .iter()
        .any(|pin| crate::download::digest_matches(sha256, pin))
}

/// Where the accepted patch lives. Outside the client folder on purpose, so a
/// reinstall of the client can't lose it and a folder picked by the user never
/// holds a file the launcher injects.
pub fn patch_path(app: &tauri::AppHandle) -> PathBuf {
    config::app_data_dir(app).join("stella").join(PATCH_FILE)
}

/// Whether `bytes` is a 64-bit Windows DLL — the only thing that can load into
/// the 64-bit game. Catches an HTML error page, a truncated file or a wrong
/// download before anything is written.
pub fn looks_like_x64_dll(bytes: &[u8]) -> bool {
    const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
    const IMAGE_FILE_DLL: u16 = 0x2000;
    let u16_at = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |at: usize| {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    if !bytes.starts_with(b"MZ") {
        return false;
    }
    let Some(pe) = u32_at(0x3c).map(|v| v as usize) else {
        return false;
    };
    if bytes.get(pe..pe + 4) != Some(b"PE\0\0".as_slice()) {
        return false;
    }
    u16_at(pe + 4) == Some(IMAGE_FILE_MACHINE_AMD64)
        && u16_at(pe + 22).is_some_and(|c| c & IMAGE_FILE_DLL != 0)
}

/// Download the current patch, reporting `(downloaded, total)` as it arrives
/// (`total` is 0 when the server doesn't say).
async fn fetch_patch(mut on_progress: impl FnMut(u64, u64)) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(PATCH_URL)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| crate::stella_api::unreachable_message(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Stella's patch server answered HTTP {}.", status.as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_PATCH_BYTES {
        return Err("Stella's patch is far larger than expected, so it was not downloaded.".into());
    }

    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The patch download failed: {}", e))?;
        if bytes.len() as u64 + chunk.len() as u64 > MAX_PATCH_BYTES {
            return Err("Stella's patch is far larger than expected, so it was not downloaded.".into());
        }
        bytes.extend_from_slice(&chunk);
        on_progress(bytes.len() as u64, total);
    }
    if total > 0 && bytes.len() as u64 != total {
        return Err("The patch download ended early.".into());
    }
    if !looks_like_x64_dll(&bytes) {
        return Err("Stella's server sent something that is not a 64-bit Windows DLL.".into());
    }
    Ok(bytes)
}

/// Write the patch over the stored one: to a temporary file first, then
/// renamed over, so a failed write never leaves half a DLL to inject.
fn store_patch(app: &tauri::AppHandle, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let path = patch_path(app);
    let dir = path.parent().ok_or("No folder for the patch.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {}", dir.display(), e))?;
    let tmp = dir.join(format!("{}.download", PATCH_FILE));
    {
        let mut file =
            std::fs::File::create(&tmp).map_err(|e| format!("Couldn't write the patch: {}", e))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Couldn't write the patch: {}", e))?;
    }
    // An antivirus scanning the old file can hold it for a moment.
    let mut attempt = 0;
    loop {
        match std::fs::rename(&tmp, &path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt >= 4 => {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("Couldn't replace the patch: {}", e));
            }
            Err(_) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }
}

/// Store `bytes` as the accepted patch and record its hash.
fn accept_patch(app: &tauri::AppHandle, bytes: &[u8]) -> Result<String, String> {
    let sha = sha256_of(bytes);
    store_patch(app, bytes)?;
    config::update(app, |cfg| cfg.stella.patch_sha256 = sha.clone())?;
    Ok(sha)
}

/// Whether the stored patch is present and still the build the user accepted.
fn stored_patch_matches(path: &Path, accepted: &str) -> bool {
    if accepted.is_empty() {
        return false;
    }
    std::fs::read(path).is_ok_and(|bytes| crate::download::digest_matches(&sha256_of(&bytes), accepted))
}

/// After the client is installed: fetch the patch, and install it at once if
/// it is a pinned build. Returns whether it was installed; a patch that isn't
/// pinned, or couldn't be fetched, is left for the UPDATE button.
pub async fn adopt_pinned_patch(app: &tauri::AppHandle) -> Result<bool, String> {
    let bytes = fetch_patch(|_, _| {}).await?;
    if !is_pinned(&sha256_of(&bytes)) {
        return Ok(false);
    }
    accept_patch(app, &bytes)?;
    Ok(true)
}

/// Whether Stella's patch needs installing or has a new build.
///
/// Returns `{ success, installed, updateAvailable, latestSha256,
/// installedSha256, latestPinned }`. When Stella can't be reached,
/// `success` is false and `updateAvailable` says only whether the patch is
/// missing — which it would need to be to play at all.
#[tauri::command]
pub async fn stella_patch_status(app: tauri::AppHandle) -> Value {
    let accepted = config::current(&app).stella.patch_sha256.clone();
    let path = patch_path(&app);
    let check_path = path.clone();
    let check_accepted = accepted.clone();
    let installed = tokio::task::spawn_blocking(move || stored_patch_matches(&check_path, &check_accepted))
        .await
        .unwrap_or(false);

    match fetch_patch(|_, _| {}).await {
        Ok(bytes) => {
            let latest = sha256_of(&bytes);
            json!({
                "success": true,
                "installed": installed,
                "updateAvailable": !installed || !crate::download::digest_matches(&latest, &accepted),
                "latestSha256": latest,
                "installedSha256": accepted,
                "latestPinned": is_pinned(&latest),
            })
        }
        Err(e) => json!({
            "success": false,
            "installed": installed,
            "updateAvailable": !installed,
            "installedSha256": accepted,
            "error": e,
        }),
    }
}

/// Install the current patch: what the UPDATE button runs. Pressing it is the
/// user accepting that build, pinned or not.
///
/// Emits `stella-patch-progress` `{ phase, pct }` for the progress bar.
#[tauri::command]
pub async fn stella_update_patch(app: tauri::AppHandle) -> Value {
    match update_patch(&app).await {
        Ok(sha) => json!({ "success": true, "sha256": sha, "pinned": is_pinned(&sha) }),
        Err(e) => {
            let _ = app.emit(PROGRESS_EVENT, json!({ "phase": "error", "pct": 0 }));
            json!({ "success": false, "error": e })
        }
    }
}

async fn update_patch(app: &tauri::AppHandle) -> Result<String, String> {
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Err("An update is already running.".into());
    }
    let _guard = UpdatingGuard;
    // The running game holds the DLL open, and swapping it underneath would
    // change what the next launch injects mid-session anyway.
    if crate::game::game_running(app) {
        return Err("Close the game before updating.".into());
    }

    let _ = app.emit(PROGRESS_EVENT, json!({ "phase": "download", "pct": 0 }));
    let mut last_pct = -1i64;
    let bytes = fetch_patch(|done, total| {
        if total == 0 {
            return;
        }
        // Held below 100 until the file is in place.
        let pct = ((done as f64 / total as f64) * 99.0) as i64;
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit(PROGRESS_EVENT, json!({ "phase": "download", "pct": pct }));
        }
    })
    .await?;

    let _ = app.emit(PROGRESS_EVENT, json!({ "phase": "install", "pct": 99 }));
    let app_for_write = app.clone();
    let sha = tokio::task::spawn_blocking(move || accept_patch(&app_for_write, &bytes))
        .await
        .map_err(|e| format!("The update failed: {}", e))??;
    let _ = app.emit(PROGRESS_EVENT, json!({ "phase": "done", "pct": 100 }));
    Ok(sha)
}

/// Remove the stored patch (uninstall).
pub fn remove_patch(app: &tauri::AppHandle) {
    let _ = std::fs::remove_file(patch_path(app));
}

// ─── Launch ─────────────────────────────────────────────────────────────────

/// Read the accepted patch and confirm it is still the build the user
/// accepted. Returns its path.
fn verified_patch(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let accepted = config::current(app).stella.patch_sha256.clone();
    let path = patch_path(app);
    if accepted.is_empty() || !path.exists() {
        return Err("Stella's patch isn't installed. Press UPDATE on Home to get it.".into());
    }
    if !stored_patch_matches(&path, &accepted) {
        return Err("Stella's patch file has changed since it was installed, so it was not \
                    loaded. Press UPDATE on Home to download it again."
            .into());
    }
    Ok(path)
}

/// Start the Stella client with its patch loaded. Returns the game's pid.
///
/// The patch goes in once `GameAssembly.dll` is in memory: that is the module
/// it hooks, and it is loaded before any of the game's own code runs. If the
/// patch can't be loaded the game is closed again, because an unpatched client
/// would talk to Rec Room's servers rather than Stella's.
#[cfg(target_os = "windows")]
pub fn launch(
    app: &tauri::AppHandle,
    exe: &Path,
    work_dir: &str,
    args: &[&str],
) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;

    let patch = verified_patch(app)?;
    let mut child = std::process::Command::new(exe)
        .args(args)
        .current_dir(work_dir)
        .creation_flags(0x00000008) // DETACHED_PROCESS
        .spawn()
        .map_err(|e| format!("Failed to launch game executable: {}", e))?;

    match inject::load_when_ready(&mut child, &patch) {
        Ok(()) => Ok(child.id()),
        Err(e) => {
            let _ = child.kill();
            Err(format!("Stella's patch couldn't be loaded, so the game was closed. {}", e))
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn launch(
    _app: &tauri::AppHandle,
    _exe: &Path,
    _work_dir: &str,
    _args: &[&str],
) -> Result<u32, String> {
    Err("Stella can only be launched on Windows.".into())
}

#[cfg(target_os = "windows")]
mod inject {
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Memory::{
        VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateRemoteThread, GetExitCodeThread, WaitForSingleObject,
    };

    /// The module the patch hooks.
    const GAME_MODULE: &str = "GameAssembly.dll";

    /// How long the game may take to load its code. A first start on a slow
    /// disk is the long case.
    const READY_TIMEOUT: Duration = Duration::from_secs(120);

    /// How often the game's modules are looked at while waiting. Short, since
    /// the game starts running its code straight after the module loads.
    const POLL: Duration = Duration::from_millis(5);

    /// How long loading the patch may take.
    const LOAD_TIMEOUT_MS: u32 = 30_000;

    pub fn load_when_ready(child: &mut std::process::Child, patch: &Path) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("The game exited before it finished starting ({}).", status));
            }
            if has_module(child.id(), GAME_MODULE) {
                break;
            }
            if started.elapsed() > READY_TIMEOUT {
                return Err("The game took too long to start.".into());
            }
            std::thread::sleep(POLL);
        }
        // The handle from CreateProcess carries full access to the process.
        load_library(child.as_raw_handle() as HANDLE, patch)
    }

    /// Whether process `pid` has a module named `name` loaded.
    fn has_module(pid: u32, name: &str) -> bool {
        // SAFETY: the snapshot handle is checked before use and closed on
        // every path. `entry` is zeroed with `dwSize` set, as Module32FirstW
        // requires, and both calls get that same struct.
        unsafe {
            // Fails with ERROR_BAD_LENGTH while the loader is mid-change in a
            // starting process; the caller simply asks again.
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid);
            if snapshot == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut entry: MODULEENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
            let mut found = false;
            if Module32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let len = entry.szModule.iter().position(|&c| c == 0).unwrap_or(entry.szModule.len());
                    if String::from_utf16_lossy(&entry.szModule[..len]).eq_ignore_ascii_case(name) {
                        found = true;
                        break;
                    }
                    if Module32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
            found
        }
    }

    /// Have `process` load the DLL at `dll` with `LoadLibraryW`.
    fn load_library(process: HANDLE, dll: &Path) -> Result<(), String> {
        let wide: Vec<u16> = dll
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let size = wide.len() * std::mem::size_of::<u16>();
        let kernel32: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();

        // SAFETY: every handle and allocation is checked before use and
        // released on every path. `LoadLibraryW` is resolved in this process;
        // kernel32 is mapped at the same address in every process of a boot
        // session, so the address is valid in the game too, and its signature
        // (one pointer in, a handle out) matches a thread start routine's.
        // The remote buffer holds the NUL-terminated path the call reads.
        unsafe {
            let load_library = GetProcAddress(GetModuleHandleW(kernel32.as_ptr()), c"LoadLibraryW".as_ptr().cast())
                .ok_or("LoadLibraryW was not found.")?;

            let remote = VirtualAllocEx(process, std::ptr::null(), size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if remote.is_null() {
                return Err(format!("Couldn't reserve memory in the game ({}).", std::io::Error::last_os_error()));
            }
            let result = (|| {
                let mut written = 0usize;
                if WriteProcessMemory(process, remote, wide.as_ptr().cast(), size, &mut written) == 0 || written != size {
                    return Err(format!("Couldn't pass the patch path to the game ({}).", std::io::Error::last_os_error()));
                }
                let start: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 = std::mem::transmute(load_library);
                let thread = CreateRemoteThread(process, std::ptr::null(), 0, Some(start), remote, 0, std::ptr::null_mut());
                if thread.is_null() {
                    return Err(format!("Couldn't start the patch in the game ({}).", std::io::Error::last_os_error()));
                }
                let waited = WaitForSingleObject(thread, LOAD_TIMEOUT_MS);
                let mut code = 0u32;
                let got_code = GetExitCodeThread(thread, &mut code) != 0;
                CloseHandle(thread);
                if waited != WAIT_OBJECT_0 {
                    return Err("The patch took too long to load.".into());
                }
                // The thread's exit code is the low half of the module handle
                // LoadLibraryW returned: zero means it failed.
                if !got_code || code == 0 {
                    return Err("Windows refused to load the patch. An antivirus may have blocked it.".into());
                }
                Ok(())
            })();
            VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal PE header: `MZ`, e_lfanew at 0x3c, then `PE\0\0`, machine and
    /// characteristics at their offsets.
    fn pe(machine: u16, characteristics: u16) -> Vec<u8> {
        let mut b = vec![0u8; 0x100];
        b[0] = b'M';
        b[1] = b'Z';
        b[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        b[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        b[0x96..0x98].copy_from_slice(&characteristics.to_le_bytes());
        b
    }

    #[test]
    fn only_a_64_bit_dll_passes() {
        assert!(looks_like_x64_dll(&pe(0x8664, 0x2022)));
        // An x86 DLL can't load into the 64-bit game.
        assert!(!looks_like_x64_dll(&pe(0x014c, 0x2102)));
        // An executable rather than a DLL.
        assert!(!looks_like_x64_dll(&pe(0x8664, 0x0022)));
        // A Cloudflare page, or nothing at all.
        assert!(!looks_like_x64_dll(b"<!DOCTYPE html><html>"));
        assert!(!looks_like_x64_dll(b""));
        // e_lfanew pointing past the end must not panic.
        let mut truncated = pe(0x8664, 0x2022);
        truncated[0x3c..0x40].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
        assert!(!looks_like_x64_dll(&truncated));
    }

    #[test]
    fn pins_match_case_insensitively() {
        assert!(is_pinned(PINNED_PATCH_SHA256[0]));
        assert!(is_pinned(&PINNED_PATCH_SHA256[0].to_uppercase()));
        assert!(!is_pinned(""));
        assert!(!is_pinned(&"0".repeat(64)));
    }

    #[test]
    fn a_changed_patch_file_is_not_the_accepted_one() {
        let dir = std::env::temp_dir().join(format!("stella-patch-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PATCH_FILE);
        std::fs::write(&path, b"accepted build").unwrap();
        let accepted = sha256_of(b"accepted build");

        assert!(stored_patch_matches(&path, &accepted));
        // Nothing accepted yet: not even a matching file counts.
        assert!(!stored_patch_matches(&path, ""));
        std::fs::write(&path, b"swapped build").unwrap();
        assert!(!stored_patch_matches(&path, &accepted));
        std::fs::remove_file(&path).unwrap();
        assert!(!stored_patch_matches(&path, &accepted));
        let _ = std::fs::remove_dir(&dir);
    }
}
