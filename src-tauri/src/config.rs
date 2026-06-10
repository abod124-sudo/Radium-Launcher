use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

static MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Application configuration for the Radium Launcher.
///
/// Fields are serialized as camelCase to match the existing config.json format
/// used by the Electron version of the launcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Config {
    pub api_url: String,
    pub game_exe_path: String,
    pub play_mode: String,
    pub minimize_on_launch: bool,
    pub auto_update: bool,
    pub install_dir: String,
    pub defender_excluded: bool,
    pub theme: String,
    pub close_on_launch: bool,
    pub launch_options: String,
    pub enable_animations: bool,
    pub disable_warnings: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_url: "https://api.radie.app/".to_string(),
            game_exe_path: String::new(),
            play_mode: "screen".to_string(),
            minimize_on_launch: true,
            auto_update: true,
            install_dir: String::new(),
            defender_excluded: false,
            theme: "steam-green".to_string(),
            close_on_launch: false,
            launch_options: String::new(),
            enable_animations: true,
            disable_warnings: false,
        }
    }
}

/// Returns the path to config.json inside the app data directory.
pub fn get_config_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    app_data_dir.join("config.json")
}

fn move_dir_recursive(src: std::path::PathBuf, dst: std::path::PathBuf) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(&dst)?;
        for entry in std::fs::read_dir(src.clone())? {
            let entry = entry?;
            move_dir_recursive(entry.path(), dst.join(entry.file_name()))?;
        }
        std::fs::remove_dir(src)?;
    } else {
        std::fs::copy(src.clone(), dst)?;
        std::fs::remove_file(src)?;
    }
    Ok(())
}

/// Migrates data from the legacy Electron `%APPDATA%\radium-launcher` folder
/// to the new Tauri `%APPDATA%\com.radium.launcher` folder.
fn migrate_legacy_data(app_handle: &tauri::AppHandle) {
    if MIGRATED.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    if let Ok(data_dir) = app_handle.path().data_dir() {
        let legacy_dir = data_dir.join("radium-launcher");
        if let Ok(new_dir) = app_handle.path().app_data_dir() {
            // Check if legacy dir exists to identify if migration is needed
            if legacy_dir.exists() {
                if !new_dir.exists() {
                    let _ = std::fs::create_dir_all(&new_dir);
                }
                
                // Move config.json first
                let target_config = new_dir.join("config.json");
                let legacy_config = legacy_dir.join("config.json");
                if legacy_config.exists() && !target_config.exists() {
                    let _ = std::fs::rename(&legacy_config, &target_config);
                }

                // Move client folder (containing rec room files)
                let target_client = new_dir.join("client");
                let legacy_client = legacy_dir.join("client");
                
                let legacy_has_client = legacy_client.exists() && (
                    legacy_client.join("RecRoom.exe").exists() ||
                    legacy_client.join("RecRoom_ScreenMode.bat").exists()
                );
                
                let target_has_client = target_client.exists() && (
                    target_client.join("RecRoom.exe").exists() ||
                    target_client.join("RecRoom_ScreenMode.bat").exists()
                );

                if legacy_has_client && !target_has_client {
                    if target_client.exists() {
                        let _ = std::fs::remove_dir_all(&target_client);
                    }
                    if std::fs::rename(&legacy_client, &target_client).is_err() {
                        let _ = move_dir_recursive(legacy_client, target_client);
                    }
                } else if legacy_client.exists() && !target_client.exists() {
                    // Fallback standard move
                    if std::fs::rename(&legacy_client, &target_client).is_err() {
                        let _ = move_dir_recursive(legacy_client, target_client);
                    }
                }
                
                // Try to clean up legacy directory after moving its contents
                let _ = std::fs::remove_dir_all(&legacy_dir);
            }
        }
    }
}

/// Reads config.json from the app data directory, creating it with defaults if
/// it doesn't exist. Migrates the old `apiUrl` values to the current endpoint.
pub fn ensure_config(app_handle: &tauri::AppHandle) -> Config {
    // Run data migration from legacy Electron folder if needed
    migrate_legacy_data(app_handle);

    let config_path = get_config_path(app_handle);

    let mut config = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(contents) => serde_json::from_str::<Config>(&contents).unwrap_or_default(),
            Err(_) => Config::default(),
        }
    } else {
        Config::default()
    };

    // Migrate old API URL to the current one.
    if config.api_url == "https://ns.radie.app" || config.api_url == "https://ns.radie.app/" {
        config.api_url = "https://api.radie.app/".to_string();
    }

    // Detect if client is/was installed in the old directory "%APPDATA%\radium-launcher\client"
    // or if the settings path points to it, and trigger a reset.
    if let Ok(data_dir) = app_handle.path().data_dir() {
        let legacy_client_dir = data_dir.join("radium-launcher").join("client");
        let legacy_client_dir_str = legacy_client_dir.to_string_lossy().to_string();
        
        let normalized_install = config.install_dir.replace('\\', "/");
        let normalized_legacy = legacy_client_dir_str.replace('\\', "/");

        let settings_points_to_old = !config.install_dir.is_empty() && (
            normalized_install.eq_ignore_ascii_case(&normalized_legacy) ||
            normalized_install.contains("radium-launcher/client")
        );

        let legacy_client_installed = legacy_client_dir.exists() && (
            legacy_client_dir.join("RecRoom.exe").exists() ||
            legacy_client_dir.join("RecRoom_ScreenMode.bat").exists()
        );

        if settings_points_to_old || legacy_client_installed {
            config.install_dir = String::new();
        }
    }

    // Persist the (potentially migrated) config back to disk.
    let _ = save_config(app_handle, &config);

    config
}

/// Serializes and writes the config to config.json in the app data directory.
pub fn save_config(app_handle: &tauri::AppHandle, config: &Config) -> Result<(), String> {
    let config_path = get_config_path(app_handle);

    // Ensure the parent directory exists.
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let json =
        serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;

    fs::write(&config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

/// Returns the game client directory.
///
/// If `config.install_dir` is non-empty it is used as-is; otherwise the
/// default location (`<app_data_dir>/client`) is returned.
pub fn get_client_dir(app_handle: &tauri::AppHandle, config: &Config) -> String {
    if !config.install_dir.is_empty() {
        config.install_dir.clone()
    } else {
        let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        app_data_dir.join("client").to_string_lossy().to_string()
    }
}
