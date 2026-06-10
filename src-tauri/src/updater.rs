use serde_json::json;
use std::env;
use std::process::Command;


const GITHUB_OWNER: &str = "abod124-sudo";
const GITHUB_REPO: &str = "Radium-Launcher";

/// Compare two semver strings, returning true if `a` is greater than `b`.
/// Leading 'v' characters are stripped before comparison.
fn semver_gt(a: &str, b: &str) -> bool {
    let a = a.trim_start_matches('v');
    let b = b.trim_start_matches('v');

    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };

    let a_parts = parse(a);
    let b_parts = parse(b);

    let max_len = a_parts.len().max(b_parts.len());
    for i in 0..max_len {
        let a_val = a_parts.get(i).copied().unwrap_or(0);
        let b_val = b_parts.get(i).copied().unwrap_or(0);
        if a_val > b_val {
            return true;
        }
        if a_val < b_val {
            return false;
        }
    }
    false
}

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

    let has_update = semver_gt(&latest_version, &current_version);

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

/// Download the update installer and launch it.
///
/// Downloads the file from the given URL to the system temp directory as
/// "RadiumLauncherSetup_update.exe", spawns the installer as a detached process,
/// waits briefly, then exits the current application.
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, url: String) -> Result<serde_json::Value, String> {
    // Security check: restrict downloads to trusted official release URLs
    if !url.starts_with("https://github.com/abod124-sudo/Radium-Launcher/releases/download/") {
        return Err("Untrusted update download URL.".into());
    }

    let temp_dir = env::temp_dir();
    let installer_path = temp_dir.join("RadiumLauncherSetup_update.exe");

    // Download the installer
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read update bytes: {}", e))?;

    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("Failed to write installer to disk: {}", e))?;

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    // Spawn the installer as a detached process
    #[cfg(target_os = "windows")]
    Command::new(&installer_path)
        .creation_flags(0x00000008) // DETACHED_PROCESS
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    Command::new(&installer_path)
        .spawn()
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
mod tests {
    use super::*;

    #[test]
    fn test_semver_gt() {
        assert!(semver_gt("1.1.0", "1.0.0"));
        assert!(semver_gt("2.0.0", "1.9.9"));
        assert!(semver_gt("1.0.1", "1.0.0"));
        assert!(semver_gt("v1.1.0", "v1.0.0"));
        assert!(semver_gt("v2.0.0", "1.9.9"));
        assert!(!semver_gt("1.0.0", "1.0.0"));
        assert!(!semver_gt("1.0.0", "1.0.1"));
        assert!(!semver_gt("0.9.0", "1.0.0"));
    }
}
