use serde_json::{json, Value};
use std::path::Path;
use tokio::process::Command;

use crate::config::{self, Network};
use crate::download;

/// Resolve the full path to `powershell.exe`.
///
/// Built from `SystemRoot` rather than assuming `C:\Windows`; falls back to the
/// bare name, resolved through `PATH`, only if that file isn't there.
fn get_powershell_path() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let path = format!(
        r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
        root.trim_end_matches('\\')
    );
    if Path::new(&path).exists() {
        path
    } else {
        "powershell".to_string()
    }
}

fn is_path_safe(path: &str) -> bool {
    // Control characters, and the characters Windows forbids in a path anyway.
    // The path never appears in a command line or a script as text (see
    // `elevated_script`), so nothing here is about quoting.
    !path
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '\r' | '\n'))
}

/// Exit code the non-elevated wrapper reports when the elevated process never
/// started: the UAC prompt was declined, or Windows refused to launch it.
/// Windows' own `ERROR_CANCELLED`.
const ELEVATION_CANCELLED: i32 = 1223;

/// UTF-16LE base64, the encoding PowerShell's `-EncodedCommand` takes.
fn utf16_base64(s: &str) -> String {
    let bytes: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
    crate::frost::base64(&bytes)
}

/// `s` as a PowerShell single-quoted string literal.
///
/// PowerShell ends a single-quoted string at any of five quote characters, not
/// only the ASCII one: ‘ ’ ‚ and ‛ count too. Doubling only `'` left a folder
/// like `O’Brien` able to close the string early — a syntax error at best, and
/// in a script that then runs elevated.
fn ps_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// The script the non-elevated PowerShell runs to apply `cmdlet` to `dir` in an
/// elevated one.
///
/// The folder never appears in either script as text. The elevated script is
/// handed over as `-EncodedCommand`, and inside it the path is decoded from
/// base64 at run time, so no character a folder name can hold — quotes of any
/// kind, `$`, backticks — is ever parsed as PowerShell.
///
/// `$ErrorActionPreference = 'Stop'` plus the `catch` is what makes a declined
/// UAC prompt a failure. Without them Start-Process's error ended only that
/// statement, `$p` stayed null, and `exit $null` exited 0 — so declining the
/// prompt reported the exclusion as added and the launcher saved it as done.
fn elevated_script(powershell_path: &str, cmdlet: &str, dir: &str) -> String {
    let inner = format!(
        "{} -ExclusionPath ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')))",
        cmdlet,
        utf16_base64(dir)
    );
    format!(
        "$ErrorActionPreference = 'Stop'; \
         try {{ \
           $p = Start-Process -FilePath {} -ArgumentList '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; \
           exit $p.ExitCode \
         }} catch {{ exit {} }}",
        ps_quote(powershell_path),
        utf16_base64(&inner),
        ELEVATION_CANCELLED
    )
}

/// Apply `cmdlet` (`Add-MpPreference` or `Remove-MpPreference`) to
/// `network`'s client folder, through one UAC prompt.
///
/// The network is the one the page names, as for every other install command,
/// rather than the one last saved to config: the page records the result
/// against the network it is showing, so the folder has to be that one's.
async fn change_exclusion(app: &tauri::AppHandle, cmdlet: &str, network: Option<String>) -> Value {
    let cfg = config::current(app);
    let network = network.map_or_else(|| cfg.network(), |n| Network::parse(Some(&n)));
    let client_dir = config::get_client_dir_for(app, &cfg, network);

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
                "Refusing to change antivirus settings for '{}': that folder is too broad. \
                 Point the client install folder at a dedicated directory first.",
                client_dir
            )
        });
    }

    let powershell_path = get_powershell_path();
    let script = elevated_script(&powershell_path, cmdlet, &client_dir);

    let mut command = Command::new(&powershell_path);
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Awaited, not blocked on: this waits for an elevated PowerShell process
    // and, with it, for the user to answer a UAC prompt — which could be a long
    // time to hold a tokio worker that other commands are queued behind.
    match command.output().await {
        Ok(output) if output.status.success() => json!({ "success": true }),
        Ok(output) => {
            let error = match output.status.code() {
                Some(ELEVATION_CANCELLED) => {
                    "The administrator prompt was declined, so nothing was changed.".to_string()
                }
                code => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let detail = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
                    format!(
                        "Windows Defender did not accept the change (exit code {}). {}",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()),
                        detail
                    )
                    .trim()
                    .to_string()
                }
            };
            json!({ "success": false, "error": error })
        }
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// Add the Rec Room client directory to the Windows Defender exclusion list.
///
/// The command is executed through an elevated (`-Verb RunAs`) PowerShell
/// process so that the user sees a single UAC prompt.
#[tauri::command]
pub async fn add_defender_exclusion(app: tauri::AppHandle, network: Option<String>) -> Value {
    change_exclusion(&app, "Add-MpPreference", network).await
}

/// Remove the Rec Room client directory from the Windows Defender exclusion list.
#[tauri::command]
pub async fn remove_defender_exclusion(app: tauri::AppHandle, network: Option<String>) -> Value {
    change_exclusion(&app, "Remove-MpPreference", network).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_powershell_quote_character_is_doubled() {
        assert_eq!(ps_quote("C:\\plain"), "'C:\\plain'");
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("O\u{2019}Brien"), "'O\u{2019}\u{2019}Brien'");
        assert_eq!(ps_quote("\u{2018}\u{201A}\u{201B}"), "'\u{2018}\u{2018}\u{201A}\u{201A}\u{201B}\u{201B}'");
    }

    #[test]
    fn the_folder_never_appears_in_the_script_as_text() {
        let dir = "C:\\Users\\O\u{2019}Brien\\$(calc)'; Remove-Item C:\\ -Recurse #\\client";
        let script = elevated_script("C:\\ps.exe", "Add-MpPreference", dir);
        assert!(!script.contains("Brien"));
        assert!(!script.contains("calc"));
        assert!(!script.contains("Remove-Item"));
    }

    /// The real round trip: PowerShell decodes the path to exactly the string
    /// that went in, however hostile its characters. Not elevated — the same
    /// decoding, printed instead of handed to Defender.
    #[cfg(windows)]
    #[test]
    fn powershell_decodes_the_path_exactly() {
        let dir = "C:\\Users\\O\u{2019}Brien\\it's $env:TEMP `n (x) & client";
        let script = format!(
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
             [Console]::Out.Write([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')))",
            utf16_base64(dir)
        );
        let out = std::process::Command::new(get_powershell_path())
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &utf16_base64(&script)])
            .output()
            .expect("powershell runs");
        assert_eq!(String::from_utf8_lossy(&out.stdout), dir);
    }

    /// A launch that fails before anything elevated runs — which is what a
    /// declined UAC prompt is — must come back as a failure, not exit 0.
    #[cfg(windows)]
    #[test]
    fn a_failed_elevation_is_not_reported_as_success() {
        let script = elevated_script("C:\\radium-no-such-dir\\missing.exe", "Add-MpPreference", "C:\\x");
        let status = std::process::Command::new(get_powershell_path())
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .expect("powershell runs");
        assert_eq!(status.code(), Some(ELEVATION_CANCELLED));
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
                    // `get` rather than slicing: a byte range that splits a
                    // character would panic, and panics abort in release.
                    if state.len() == 6 && state.get(2..4) == Some("00") {
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

