use serde_json::{json, Value};
use std::path::Path;
use tokio::process::Command;

use crate::config;
use crate::download;

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

    // Refuse to hand Defender a directory broad enough that excluding it would
    // disable real-time protection for most of the disk. The install folder is
    // user-chosen through a folder picker, so "C:\\" is two clicks away.
    if download::is_overly_broad_dir(&client_dir) {
        return json!({
            "success": false,
            "error": format!(
                "Refusing to change antivirus settings for '{}': that folder is too broad.                  Point the client install folder at a dedicated directory first.",
                client_dir
            )
        });
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
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Awaited, not blocked on: this waits for an elevated PowerShell process
    // and, with it, for the user to answer a UAC prompt — which could be a long
    // time to hold a tokio worker that other commands are queued behind.
    match command.output().await {
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

    // Refuse to hand Defender a directory broad enough that excluding it would
    // disable real-time protection for most of the disk. The install folder is
    // user-chosen through a folder picker, so "C:\\" is two clicks away.
    if download::is_overly_broad_dir(&client_dir) {
        return json!({
            "success": false,
            "error": format!(
                "Refusing to change antivirus settings for '{}': that folder is too broad.                  Point the client install folder at a dedicated directory first.",
                client_dir
            )
        });
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
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Awaited, not blocked on: this waits for an elevated PowerShell process
    // and, with it, for the user to answer a UAC prompt — which could be a long
    // time to hold a tokio worker that other commands are queued behind.
    match command.output().await {
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
        // Emit one "displayName|productState" line per registered AV. productState
        // is a hex bitmask whose middle byte encodes real-time-protection status
        // ("00" = off); the Rust side uses it to drop disabled/stale entries.
        let ps_command = r#"
            $result = @()
            try {
                $avs = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue
                if (-not $avs) {
                    $avs = Get-WmiObject -Namespace root/SecurityCenter2 -Class AntiVirusProduct -ErrorAction SilentlyContinue
                }
                foreach ($av in $avs) {
                    $name = "$($av.displayName)".Trim()
                    if ([string]::IsNullOrWhiteSpace($name)) { continue }
                    $state = '{0:x6}' -f [int]$av.productState
                    $result += ($name + '|' + $state)
                }
            } catch {}
            if ($result.Count -eq 0) {
                if (Get-Service -Name WinDefend -ErrorAction SilentlyContinue) {
                    $result += "Windows Defender|001000"
                }
            }
            $result | Write-Output
        "#;

        match Command::new(&powershell_path)
            .args(["-NoProfile", "-Command", ps_command])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .await
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut products = Vec::new();
                let mut seen = std::collections::HashSet::new();
                for line in stdout.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    // Split "name|productState" from the right, since a display
                    // name could (rarely) contain a '|' itself.
                    let (name, state) = match line.rsplit_once('|') {
                        Some((n, s)) => (n.trim(), s.trim()),
                        None => (line, ""),
                    };
                    if name.is_empty() {
                        continue;
                    }

                    // Skip products whose real-time protection is off ("00" in the
                    // middle byte). This drops a passive Defender when a
                    // third-party AV is active, plus disabled/stale entries.
                    if state.len() == 6 && &state[2..4] == "00" {
                        continue;
                    }

                    let lower_name = name.to_lowercase();

                    // Dedup: SecurityCenter2 can list the same product more than once.
                    if !seen.insert(lower_name.clone()) {
                        continue;
                    }

                    // Match Microsoft Defender precisely. A bare `contains("defender")`
                    // wrongly flags third-party products like *Bitdefender*, hiding
                    // them from the third-party AV warning.
                    let is_defender = lower_name.contains("windows defender")
                        || lower_name.contains("microsoft defender")
                        || lower_name.contains("microsoft security essentials");

                    products.push(AntivirusProduct {
                        name: name.to_string(),
                        is_defender,
                    });
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

