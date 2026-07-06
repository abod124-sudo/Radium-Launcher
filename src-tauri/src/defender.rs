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

fn is_path_safe(path: &str) -> bool {
    // Reject control characters and the few characters that could break out of
    // the PowerShell command's quoting. Single quotes are handled separately by
    // doubling them before interpolation, so they are allowed here. Everything
    // else — parentheses, ampersands, '#', '$', etc., all legal in Windows
    // paths — is permitted so users with folders like "Program Files (x86)" or
    // "Rec'Room" can still add a Defender exclusion.
    !path
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '\r' | '\n'))
}

/// Add the Rec Room client directory to the Windows Defender exclusion list.
///
/// The command is executed through an elevated (`-Verb RunAs`) PowerShell
/// process so that the user sees a single UAC prompt.
#[tauri::command]
pub async fn add_defender_exclusion(app: tauri::AppHandle) -> Value {
    let cfg = config::ensure_config(&app);
    let client_dir = config::get_client_dir(&app, &cfg);

    if !is_path_safe(&client_dir) {
        return json!({ "success": false, "error": "Invalid characters in client path." });
    }

    // The path sits inside TWO nesting levels of single-quoted PowerShell
    // strings (the -ArgumentList string, and the inner -Command's path quotes),
    // so each apostrophe must be doubled twice: ' -> ''''.
    let escaped_path = client_dir.replace('\'', "''''");

    let powershell_path = get_powershell_path();

    // Build the inner command that will run elevated. -Wait + -PassThru let us
    // propagate the elevated process's exit code, so a failed Add-MpPreference
    // (or a declined UAC prompt) is reported as failure instead of success.
    let ps_command = format!(
        "$p = Start-Process '{}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command \"Add-MpPreference -ExclusionPath ''{}''\"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        powershell_path, escaped_path
    );

    let mut command = Command::new(&powershell_path);
    command.args(["-NoProfile", "-Command", &ps_command]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match command.output() {
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

    if !is_path_safe(&client_dir) {
        return json!({ "success": false, "error": "Invalid characters in client path." });
    }

    // See add_defender_exclusion for the escaping and -Wait/-PassThru rationale.
    let escaped_path = client_dir.replace('\'', "''''");

    let powershell_path = get_powershell_path();

    let ps_command = format!(
        "$p = Start-Process '{}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command \"Remove-MpPreference -ExclusionPath ''{}''\"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        powershell_path, escaped_path
    );

    let mut command = Command::new(&powershell_path);
    command.args(["-NoProfile", "-Command", &ps_command]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match command.output() {
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

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AntivirusProduct {
    pub name: String,
    #[serde(rename = "isDefender")]
    pub is_defender: bool,
}

/// Query the system's antivirus products.
/// Classifies products as Microsoft Defender or third-party.
#[tauri::command]
pub async fn detect_antivirus() -> Vec<AntivirusProduct> {
    #[cfg(target_os = "windows")]
    {
        let powershell_path = get_powershell_path();
        let ps_command = r#"
            $result = @()
            try {
                $avs = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue
                if ($avs) {
                    foreach ($av in $avs) {
                        $result += $av.displayName
                    }
                } else {
                    $avs = Get-WmiObject -Namespace root/SecurityCenter2 -Class AntiVirusProduct -ErrorAction SilentlyContinue
                    foreach ($av in $avs) {
                        $result += $av.displayName
                    }
                }
            } catch {}
            if ($result.Count -eq 0) {
                if (Get-Service -Name WinDefend -ErrorAction SilentlyContinue) {
                    $result += "Windows Defender"
                }
            }
            $result | Write-Output
        "#;

        use std::os::windows::process::CommandExt;
        match Command::new(&powershell_path)
            .args(["-NoProfile", "-Command", ps_command])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut products = Vec::new();
                for line in stdout.lines() {
                    let name = line.trim();
                    if !name.is_empty() {
                        let lower_name = name.to_lowercase();
                        let is_defender = lower_name.contains("defender") || lower_name.contains("microsoft security essentials");
                        products.push(AntivirusProduct {
                            name: name.to_string(),
                            is_defender,
                        });
                    }
                }
                if products.is_empty() {
                    products.push(AntivirusProduct {
                        name: "Windows Defender".to_string(),
                        is_defender: true,
                    });
                }
                products
            }
            Err(_) => vec![AntivirusProduct {
                name: "Windows Defender".to_string(),
                is_defender: true,
            }],
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![]
    }
}

