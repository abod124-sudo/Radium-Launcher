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

/// Migrates data from the legacy Electron `%APPDATA%\radium-launcher` folder
/// to the new Tauri `%APPDATA%\com.radium.launcher` folder.

fn migrate_legacy_data(app_handle: &tauri::AppHandle) {
    if MIGRATED.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    if MIGRATED.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    if let Ok(data_dir) = app_handle.path().data_dir() {
        let legacy_dir = data_dir.join("radium-launcher");
        if let Ok(new_dir) = app_handle.path().app_data_dir() {
            // Check if legacy dir exists to identify if migration is needed
            if legacy_dir.exists() {
                if !new_dir.exists() {
                    let _ = std::fs::create_dir_all(&new_dir);
                }
                
                // Move everything (including the 'client' directory) individually
                if let Ok(entries) = std::fs::read_dir(&legacy_dir) {
                    for entry in entries.flatten() {
                        let target_path = new_dir.join(entry.file_name());
                        // Only move if target doesn't exist to avoid overwriting new data
                        if !target_path.exists() {
                            let _ = std::fs::rename(entry.path(), target_path);
                        }
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
