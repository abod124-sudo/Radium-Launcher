use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

static MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct CustomThemeColors {
    pub bg_dark: String,
    pub bg_main: String,
    pub bg_panel: String,
    pub bg_btn: String,
    pub border_light: String,
    pub border_dark: String,
    pub green: String,
    pub green_dim: String,
    pub text: String,
    pub text_muted: String,
    pub status_online: String,
    pub style_base: String,
    pub bg_image: String,
    pub glass_enabled: bool,
    pub glass_bg: String,
}

impl Default for CustomThemeColors {
    fn default() -> Self {
        Self {
            bg_dark: "#21281e".to_string(),
            bg_main: "#384232".to_string(),
            bg_panel: "#4b5845".to_string(),
            bg_btn: "#5e6d56".to_string(),
            border_light: "#829478".to_string(),
            border_dark: "#1b2118".to_string(),
            green: "#00ff00".to_string(),
            green_dim: "#7ca969".to_string(),
            text: "#d4e0ce".to_string(),
            text_muted: "#8da082".to_string(),
            status_online: "#00ff00".to_string(),
            style_base: "retro".to_string(),
            bg_image: String::new(),
            glass_enabled: false,
            glass_bg: "#0b0c14".to_string(),
        }
    }
}

/// Which revival network the launcher is currently pointed at.
///
/// The launcher speaks to one network at a time. Radium is the historical
/// default and owns the flat `Config` fields; Vanilla's install state lives in
/// [`VanillaState`] so existing configs keep working with no migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Radium,
    Vanilla,
}

impl Network {
    /// Parse a network name from config/IPC. Anything unrecognised (including
    /// `None`) falls back to Radium, so a corrupt value can never strand the
    /// user on a network they can't leave.
    pub fn parse(name: Option<&str>) -> Self {
        match name.unwrap_or("") {
            "vanilla" => Network::Vanilla,
            _ => Network::Radium,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Network::Radium => "radium",
            Network::Vanilla => "vanilla",
        }
    }
}

/// Vanilla-specific install state.
///
/// Mirrors the flat Radium fields on [`Config`] so the two clients can be
/// installed side by side without either one's paths, version or ETag
/// standing in for the other's.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct VanillaState {
    pub install_dir: String,
    pub game_exe_path: String,
    /// Where to download the Vanilla client zip from. Empty until Vanilla
    /// actually ships a build - vanillarec.net currently lists every platform
    /// as "coming soon" with no download link, so the UI falls back to opening
    /// their download page instead.
    pub client_url: String,
    pub client_version: String,
    pub client_etag: String,
    pub client_build: String,
    pub defender_excluded: bool,
}

impl Default for VanillaState {
    fn default() -> Self {
        Self {
            install_dir: String::new(),
            game_exe_path: String::new(),
            client_url: String::new(),
            client_version: String::new(),
            client_etag: String::new(),
            client_build: String::new(),
            defender_excluded: false,
        }
    }
}

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
    /// Whether the user has opted out of the launch-time third-party antivirus
    /// warning ("Don't warn me again"). Distinct from `defender_excluded`, which
    /// tracks a real Windows Defender folder exclusion — a third-party AV can't
    /// be auto-excluded, so this is a pure "stop warning me" acknowledgement.
    pub third_party_av_acknowledged: bool,
    pub theme: String,
    pub baseline_theme: String,
    pub close_on_launch: bool,
    pub launch_options: String,
    pub enable_animations: bool,
    pub disable_warnings: bool,
    pub custom_theme: Option<CustomThemeColors>,
    /// Build id of the currently-installed client (see download::REQUIRED_CLIENT_BUILD).
    pub client_build: String,
    /// Real version string of the installed client (e.g. "0.9.2"), as published
    /// on the recroom.baby downloads page. Used to detect live client updates,
    /// separately from `client_build`'s launcher-compatibility marker.
    pub client_version: String,
    /// CDN ETag of the downloaded client zip, captured at download time. Lets
    /// update checks catch a rebuilt zip even when the version number on the
    /// download page hasn't changed.
    pub client_etag: String,
    /// Whether the one-time "your client predates version tracking, please
    /// sync" nudge has already been shown. Without this, a client with no
    /// recorded version would be flagged as needing an update on every single
    /// check forever, since there's no version to compare against.
    pub client_version_sync_prompted: bool,
    /// Active network name: "radium" | "vanilla". See [`Network`].
    pub network: String,
    /// Install state for the Vanilla network. The flat fields above stay Radium's.
    pub vanilla: VanillaState,
}

impl Config {
    /// Overwrite the backend-managed fields on `self` with the authoritative
    /// values from `current` (the config currently on disk).
    ///
    /// These fields are written by backend commands — the client build id,
    /// version and ETag are stamped in by a download; the version-sync flag by
    /// the live update check; the exe path by download/uninstall — *after* the
    /// settings UI loaded its in-memory copy of the config. That UI writes the
    /// whole config back on every autosave, so without this a stale save would
    /// silently revert these to the values it holds (typically the empty
    /// defaults from startup). That is what made a freshly-downloaded client
    /// read as "outdated" on the next check, triggering an endless re-download
    /// loop. `defender_excluded` is deliberately *not* preserved: the AV-exclude
    /// UI owns it and must be able to save changes to it.
    pub fn preserve_backend_managed_fields(&mut self, current: &Config) {
        self.client_build = current.client_build.clone();
        self.client_version = current.client_version.clone();
        self.client_etag = current.client_etag.clone();
        self.client_version_sync_prompted = current.client_version_sync_prompted;
        self.game_exe_path = current.game_exe_path.clone();
        // Vanilla's install state is written by the same backend commands and is
        // just as absent from a stale frontend copy, so it needs the identical
        // treatment. `vanilla.client_url` and `vanilla.defender_excluded` are
        // deliberately NOT preserved - the settings and AV-exclude UIs own those.
        self.vanilla.client_build = current.vanilla.client_build.clone();
        self.vanilla.client_version = current.vanilla.client_version.clone();
        self.vanilla.client_etag = current.vanilla.client_etag.clone();
        self.vanilla.game_exe_path = current.vanilla.game_exe_path.clone();
    }

    /// The currently selected network.
    pub fn network(&self) -> Network {
        Network::parse(Some(self.network.as_str()))
    }

    /// User-chosen install directory for `network`, or "" to use the default.
    pub fn install_dir_for(&self, network: Network) -> &str {
        match network {
            Network::Radium => &self.install_dir,
            Network::Vanilla => &self.vanilla.install_dir,
        }
    }

    /// Recorded game executable path for `network`.
    pub fn game_exe_for(&self, network: Network) -> &str {
        match network {
            Network::Radium => &self.game_exe_path,
            Network::Vanilla => &self.vanilla.game_exe_path,
        }
    }

    /// Build id recorded for `network`'s installed client.
    pub fn client_build_for(&self, network: Network) -> &str {
        match network {
            Network::Radium => &self.client_build,
            Network::Vanilla => &self.vanilla.client_build,
        }
    }

    /// Installed client version for `network`.
    pub fn client_version_for(&self, network: Network) -> &str {
        match network {
            Network::Radium => &self.client_version,
            Network::Vanilla => &self.vanilla.client_version,
        }
    }

    /// ETag of the zip `network`'s installed client came from.
    pub fn client_etag_for(&self, network: Network) -> &str {
        match network {
            Network::Radium => &self.client_etag,
            Network::Vanilla => &self.vanilla.client_etag,
        }
    }

    /// Record the results of a successful download for `network`.
    pub fn set_client_install(
        &mut self,
        network: Network,
        exe_path: String,
        build: String,
        version: String,
        etag: String,
    ) {
        match network {
            Network::Radium => {
                self.game_exe_path = exe_path;
                self.client_build = build;
                self.client_version = version;
                self.client_etag = etag;
                self.client_version_sync_prompted = false;
            }
            Network::Vanilla => {
                self.vanilla.game_exe_path = exe_path;
                self.vanilla.client_build = build;
                self.vanilla.client_version = version;
                self.vanilla.client_etag = etag;
            }
        }
    }

    /// Clear the recorded install for `network` (used by uninstall).
    pub fn clear_client_install(&mut self, network: Network) {
        match network {
            Network::Radium => {
                self.game_exe_path = String::new();
                self.client_build = String::new();
                self.client_version = String::new();
                self.client_etag = String::new();
            }
            Network::Vanilla => {
                self.vanilla.game_exe_path = String::new();
                self.vanilla.client_build = String::new();
                self.vanilla.client_version = String::new();
                self.vanilla.client_etag = String::new();
            }
        }
    }
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
            third_party_av_acknowledged: false,
            theme: "steam-green".to_string(),
            baseline_theme: "steam-green".to_string(),
            close_on_launch: false,
            launch_options: String::new(),
            enable_animations: true,
            disable_warnings: false,
            custom_theme: None,
            client_build: String::new(),
            client_version: String::new(),
            client_etag: String::new(),
            client_version_sync_prompted: false,
            network: "radium".to_string(),
            vanilla: VanillaState::default(),
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

    // Tracks whether anything below modified the config, so we only write back
    // to disk when there is an actual change (avoids redundant I/O on every read).
    let mut changed = false;

    let mut config = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(contents) => match serde_json::from_str::<Config>(&contents) {
                Ok(cfg) => cfg,
                Err(_) => {
                    let backup_path = config_path.with_extension("json.bak");
                    let _ = fs::copy(&config_path, &backup_path);
                    changed = true;
                    Config::default()
                }
            },
            Err(_) => {
                changed = true;
                Config::default()
            }
        }
    } else {
        // No config file yet — create one with defaults.
        changed = true;
        Config::default()
    };

    // Migrate old API URL to the current one.
    if config.api_url == "https://ns.radie.app" || config.api_url == "https://ns.radie.app/" {
        config.api_url = "https://api.radie.app/".to_string();
        changed = true;
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
            if !config.install_dir.is_empty() {
                changed = true;
            }
            config.install_dir = String::new();
        }
    }

    // Persist only when something actually changed, to avoid rewriting
    // config.json on every command that reads the config.
    if changed {
        let _ = save_config(app_handle, &config);
    }

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

    let temp_path = config_path.with_extension("json.tmp");
    fs::write(&temp_path, json).map_err(|e| e.to_string())?;
    fs::rename(&temp_path, &config_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        e.to_string()
    })?;

    Ok(())
}

/// Returns the game client directory for `network`.
///
/// If that network's configured install dir is non-empty it is used as-is;
/// otherwise the default location is returned. The two networks default to
/// separate folders (`client` and `client-vanilla`) so both clients can be
/// installed at once without one uninstall wiping the other.
pub fn get_client_dir_for(
    app_handle: &tauri::AppHandle,
    config: &Config,
    network: Network,
) -> String {
    let configured = config.install_dir_for(network);
    if !configured.is_empty() {
        return configured.to_string();
    }
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let folder = match network {
        Network::Radium => "client",
        Network::Vanilla => "client-vanilla",
    };
    app_data_dir.join(folder).to_string_lossy().to_string()
}

/// Backwards-compatible wrapper: the client directory for the active network.
pub fn get_client_dir(app_handle: &tauri::AppHandle, config: &Config) -> String {
    get_client_dir_for(app_handle, config, config.network())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::REQUIRED_CLIENT_BUILD;

    /// Rebuild a Config the way `cmd_save_config` does: JSON from the frontend
    /// is deserialized straight into a `Config`, so any field the frontend
    /// omits (or holds a stale value for) lands as the serde default.
    fn config_from_frontend_json(json: serde_json::Value) -> Config {
        serde_json::from_value::<Config>(json).expect("frontend config should deserialize")
    }

    #[test]
    fn stale_autosave_does_not_clobber_downloaded_build() {
        // On disk after a successful download: build id + version + ETag stamped in.
        let mut on_disk = Config::default();
        on_disk.client_build = REQUIRED_CLIENT_BUILD.to_string();
        on_disk.client_version = "0.9.2".to_string();
        on_disk.client_etag = "\"etag-xyz\"".to_string();
        on_disk.client_version_sync_prompted = true;
        on_disk.game_exe_path = "C:/client/Recroom_Release.exe".to_string();

        // What the settings UI actually sends on autosave: it was loaded at
        // startup (before the download) so it carries no client fields, plus a
        // genuine settings change the user just made.
        let mut incoming = config_from_frontend_json(serde_json::json!({
            "theme": "steam-green",
            "minimizeOnLaunch": false,
            "closeOnLaunch": true
        }));
        // Sanity: the stale copy really is missing the build id.
        assert_eq!(incoming.client_build, "", "frontend copy should be stale/empty");

        incoming.preserve_backend_managed_fields(&on_disk);

        // The download's fields survive the save untouched...
        assert_eq!(incoming.client_build, REQUIRED_CLIENT_BUILD);
        assert_eq!(incoming.client_version, "0.9.2");
        assert_eq!(incoming.client_etag, "\"etag-xyz\"");
        assert!(incoming.client_version_sync_prompted);
        assert_eq!(incoming.game_exe_path, "C:/client/Recroom_Release.exe");

        // ...and the user's real settings change is still applied.
        assert!(!incoming.minimize_on_launch);
        assert!(incoming.close_on_launch);
    }

    #[test]
    fn preserved_build_is_not_flagged_outdated() {
        // The exact regression: check_install computes
        // `client_outdated = client_build != REQUIRED_CLIENT_BUILD`.
        let mut on_disk = Config::default();
        on_disk.client_build = REQUIRED_CLIENT_BUILD.to_string();

        let mut incoming = Config::default(); // stale: client_build == ""
        let outdated_before = incoming.client_build != REQUIRED_CLIENT_BUILD;
        assert!(outdated_before, "stale save alone would report outdated (the bug)");

        incoming.preserve_backend_managed_fields(&on_disk);

        let outdated_after = incoming.client_build != REQUIRED_CLIENT_BUILD;
        assert!(!outdated_after, "after preserving, client is correctly up to date");
    }

    #[test]
    fn stale_autosave_does_not_clobber_vanilla_install() {
        // Same hazard as the Radium case: a Vanilla download stamps its exe
        // path, build and ETag into the nested `vanilla` object, and a settings
        // autosave that was loaded beforehand would otherwise revert them.
        let mut on_disk = Config::default();
        on_disk.vanilla.game_exe_path = "C:/client-vanilla/RecRoom.exe".to_string();
        on_disk.vanilla.client_build = REQUIRED_CLIENT_BUILD.to_string();
        on_disk.vanilla.client_version = "1.2.3".to_string();
        on_disk.vanilla.client_etag = "\"vanilla-etag\"".to_string();
        on_disk.vanilla.client_url = "https://example.invalid/old.zip".to_string();

        // The settings UI sends the whole config, including a *new* client URL
        // the user just typed, but a stale (empty) copy of everything the
        // backend owns.
        let mut incoming = config_from_frontend_json(serde_json::json!({
            "network": "vanilla",
            "vanilla": { "clientUrl": "https://example.invalid/new.zip" }
        }));
        assert_eq!(incoming.vanilla.client_build, "", "frontend copy should be stale");

        incoming.preserve_backend_managed_fields(&on_disk);

        // Backend-owned Vanilla fields survive...
        assert_eq!(incoming.vanilla.game_exe_path, "C:/client-vanilla/RecRoom.exe");
        assert_eq!(incoming.vanilla.client_build, REQUIRED_CLIENT_BUILD);
        assert_eq!(incoming.vanilla.client_version, "1.2.3");
        assert_eq!(incoming.vanilla.client_etag, "\"vanilla-etag\"");
        // ...while the URL the settings UI owns is the one the user just set.
        assert_eq!(incoming.vanilla.client_url, "https://example.invalid/new.zip");
        assert_eq!(incoming.network(), Network::Vanilla);
    }

    #[test]
    fn networks_keep_separate_install_state() {
        // The whole point of the nested object: uninstalling one network must
        // not disturb the other's recorded install.
        let mut cfg = Config::default();
        cfg.set_client_install(
            Network::Radium,
            "C:/client/Recroom_Release.exe".into(),
            REQUIRED_CLIENT_BUILD.into(),
            "0.9.2".into(),
            "r-etag".into(),
        );
        cfg.set_client_install(
            Network::Vanilla,
            "C:/client-vanilla/RecRoom.exe".into(),
            REQUIRED_CLIENT_BUILD.into(),
            "1.2.3".into(),
            "v-etag".into(),
        );

        cfg.clear_client_install(Network::Vanilla);

        assert_eq!(cfg.game_exe_for(Network::Radium), "C:/client/Recroom_Release.exe");
        assert_eq!(cfg.client_version_for(Network::Radium), "0.9.2");
        assert_eq!(cfg.game_exe_for(Network::Vanilla), "");
        assert_eq!(cfg.client_version_for(Network::Vanilla), "");
    }

    #[test]
    fn unknown_network_name_falls_back_to_radium() {
        // A corrupt or future value must never strand the user on a network the
        // launcher can't talk to.
        assert_eq!(Network::parse(None), Network::Radium);
        assert_eq!(Network::parse(Some("")), Network::Radium);
        assert_eq!(Network::parse(Some("nonsense")), Network::Radium);
        assert_eq!(Network::parse(Some("vanilla")), Network::Vanilla);
    }

    #[test]
    fn defender_excluded_stays_frontend_owned() {
        // The AV-exclude UI sets defender_excluded and saves it, so an incoming
        // `true` must win over a stale `false` on disk (i.e. it is NOT preserved).
        let on_disk = Config::default(); // defender_excluded == false
        let mut incoming = Config::default();
        incoming.defender_excluded = true;

        incoming.preserve_backend_managed_fields(&on_disk);

        assert!(incoming.defender_excluded, "frontend-owned field must not be reverted");
    }
}
