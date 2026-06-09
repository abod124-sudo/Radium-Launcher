use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;

use crate::config;

/// Resolve the full path to `powershell.exe`.
/// Prefers the well-known System32 location; falls back to the bare name
/// so that the system `PATH` can resolve it.
fn get_powershell_path() -> String {
    let system32_path = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    if Path::new(system32_path).exists() {
        system32_path.to_string()
    } else {
        "powershell".to_string()
    }
}

/// Add the Rec Room client directory to the Windows Defender exclusion list.
///
/// The command is executed through an elevated (`-Verb RunAs`) PowerShell
/// process so that the user sees a single UAC prompt.
#[tauri::command]
pub async fn add_defender_exclusion(app: tauri::AppHandle) -> Value {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    // Escape single quotes for PowerShell by doubling them.
    let escaped_path = client_dir.replace('\'', "''");

    let powershell_path = get_powershell_path();

    // Build the inner command that will run elevated.
    let ps_command = format!(
        "Start-Process '{}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command \"Add-MpPreference -ExclusionPath ''{}''\"' -Verb RunAs",
        powershell_path, escaped_path
    );

    match Command::new(&powershell_path)
        .args(["-NoProfile", "-Command", &ps_command])
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                json!({ "success": true })
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                json!({ "success": false, "error": stderr.to_string() })
            }
        }
        Err(e) => {
            json!({ "success": false, "error": e.to_string() })
        }
    }
}

/// Remove the Rec Room client directory from the Windows Defender exclusion list.
///
/// Mirrors [`add_defender_exclusion`] but invokes `Remove-MpPreference`
/// instead of `Add-MpPreference`.
#[tauri::command]
pub async fn remove_defender_exclusion(app: tauri::AppHandle) -> Value {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    let escaped_path = client_dir.replace('\'', "''");

    let powershell_path = get_powershell_path();

    let ps_command = format!(
        "Start-Process '{}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command \"Remove-MpPreference -ExclusionPath ''{}''\"' -Verb RunAs",
        powershell_path, escaped_path
    );

    match Command::new(&powershell_path)
        .args(["-NoProfile", "-Command", &ps_command])
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                json!({ "success": true })
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                json!({ "success": false, "error": stderr.to_string() })
            }
        }
        Err(e) => {
            json!({ "success": false, "error": e.to_string() })
        }
    }
}
