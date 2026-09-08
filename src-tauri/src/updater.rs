use serde_json::json;
use std::env;
use std::process::Command;


const GITHUB_OWNER: &str = "abod124-sudo";
const GITHUB_REPO: &str = "Radium-Launcher";

/// Check GitHub for a newer release of the launcher.
///
/// Returns a JSON object with update information including whether an update
/// is available, version strings, and download URLs.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> serde_json::Value {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        GITHUB_OWNER, GITHUB_REPO
    );

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "hasUpdate": false,
                "error": format!("Failed to create HTTP client: {}", e)
            });
        }
    };

    let response = match client
        .get(&url)
        .header("User-Agent", "Radium-Launcher-Updater")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return json!({
                "hasUpdate": false,
                "error": format!("Failed to fetch release info: {}", e)
            });
        }
    };

    let release: serde_json::Value = match response.json().await {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "hasUpdate": false,
                "error": format!("Failed to parse release JSON: {}", e)
            });
        }
    };

    let current_version = app.package_info().version.to_string();

    let latest_version = release["tag_name"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let has_update = crate::download::version_gt(&latest_version, &current_version);

    let release_url = release["html_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let release_notes = release["body"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // Find the installer asset: name contains "setup" and ends with ".exe" (case-insensitive)
    let download_url = release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|asset| {
                if let Some(name) = asset["name"].as_str() {
                    let lower = name.to_lowercase();
                    lower.contains("setup") && lower.ends_with(".exe")
                } else {
                    false
                }
            })
        })
        .and_then(|asset| asset["browser_download_url"].as_str())
        .unwrap_or("")
        .to_string();

    json!({
        "hasUpdate": has_update,
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "releaseUrl": release_url,
        "downloadUrl": download_url,
        "releaseNotes": release_notes
    })
}

/// Filename prefix for the downloaded launcher installer. Each run appends a
/// unique suffix (see [`download_update`]), so old ones accumulate in temp.
const INSTALLER_PREFIX: &str = "RadiumLauncherSetup_update_";

/// Delete installers left behind by previous updates.
///
/// Each update writes a uniquely-named installer to temp and then exits the app
/// to run it, so nothing ever cleaned them up — one abandoned executable per
/// update, forever. Only files matching our own prefix are considered, and only
/// ones older than an hour, so the installer this run is about to write (and any
/// installer a concurrently-updating instance is still executing) is left alone.
fn clean_stale_installers(temp_dir: &std::path::Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(INSTALLER_PREFIX) || !name.ends_with(".exe") {
            continue;
        }
        let is_stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .map(|age| age > MAX_AGE)
            .unwrap_or(false);
        if is_stale {
            // Best-effort: a file still locked by a running installer stays.
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Download the update installer and launch it.
///
/// Downloads the file from the given URL to the system temp directory as
/// "RadiumLauncherSetup_update.exe", spawns the installer as a detached process,
/// waits briefly, then exits the current application.
///
/// If `place_on_desktop` is true, the `/DESKTOP` flag is passed to the installer
/// so it re-creates the desktop shortcut even when running in update mode.
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, url: String, place_on_desktop: bool) -> Result<serde_json::Value, String> {
    // Security check: restrict downloads to trusted official release URLs
    if !url.starts_with("https://github.com/abod124-sudo/Radium-Launcher/releases/download/") {
        return Err("Untrusted update download URL.".into());
    }

    // Unique per run. A fixed name here is a file another process running as
    // this user can replace in the window between writing the installer and
    // executing it — and what gets executed is an installer, elevated by NSIS.
    // The nanosecond clock plus the pid is enough to make the target
    // unpredictable without pulling in a rand dependency.
    let unique = format!(
        "{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let temp_dir = env::temp_dir();
    clean_stale_installers(&temp_dir);
    let installer_path = temp_dir.join(format!("{}{}.exe", INSTALLER_PREFIX, unique));

    // Download the installer. Without timeouts a stalled connection would
    // leave the update modal stuck on "Downloading..." forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Update download failed: HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read update bytes: {}", e))?;

    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("Failed to write installer to disk: {}", e))?;

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    // Build the installer command, optionally requesting a desktop shortcut
    let mut cmd = Command::new(&installer_path);
    if place_on_desktop {
        cmd.arg("/DESKTOP");
    }

    // Spawn the installer as a detached process
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x00000008) // DETACHED_PROCESS
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    cmd.spawn()
        .map_err(|e| format!("Failed to launch installer: {}", e))?;

    // Wait briefly to let the installer start, then exit the app
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    app.exit(0);
    Ok(json!({ "success": true }))
}


/// Return the current application version string.
#[tauri::command]
pub fn get_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod installer_cleanup_tests {
    use super::{clean_stale_installers, INSTALLER_PREFIX};
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "radium-updater-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Backdate a file so the age check sees it as stale.
    fn age(path: &std::path::Path, secs: u64) {
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
        let f = fs::File::options().write(true).open(path).expect("open");
        f.set_modified(when).expect("set mtime");
    }

    #[test]
    fn a_stale_installer_is_removed() {
        let dir = temp_dir("stale");
        let stale = dir.join(format!("{}12345_678.exe", INSTALLER_PREFIX));
        fs::write(&stale, b"stub").expect("write");
        age(&stale, 60 * 60 * 24);

        clean_stale_installers(&dir);
        assert!(!stale.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// The installer this run is about to write, and one a concurrently
    /// updating instance may still be executing, are both recent.
    #[test]
    fn a_recent_installer_is_left_alone() {
        let dir = temp_dir("recent");
        let fresh = dir.join(format!("{}999_111.exe", INSTALLER_PREFIX));
        fs::write(&fresh, b"stub").expect("write");

        clean_stale_installers(&dir);
        assert!(fresh.exists(), "a running installer must not be deleted");

        let _ = fs::remove_dir_all(&dir);
    }

    /// Temp is shared with the rest of the system, so nothing outside our own
    /// naming scheme may be touched however old it is.
    #[test]
    fn unrelated_temp_files_are_never_touched() {
        let dir = temp_dir("unrelated");
        let others = [
            "important.exe",
            "RadiumLauncherSetup.exe",
            "SomeOtherApp_update_1.exe",
        ];
        for name in others {
            let p = dir.join(name);
            fs::write(&p, b"stub").expect("write");
            age(&p, 60 * 60 * 24 * 30);
        }
        // Our prefix but not an executable.
        let log = dir.join(format!("{}1_2.log", INSTALLER_PREFIX));
        fs::write(&log, b"stub").expect("write");
        age(&log, 60 * 60 * 24 * 30);

        clean_stale_installers(&dir);

        for name in others {
            assert!(dir.join(name).exists(), "{} must survive", name);
        }
        assert!(log.exists(), "only .exe files match");

        let _ = fs::remove_dir_all(&dir);
    }
}
