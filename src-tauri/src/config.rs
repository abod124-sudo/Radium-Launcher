use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

static MIGRATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// One-shot guard for the cross-network install repair. `ensure_config` runs on
/// nearly every IPC command, and the repair has to scan a client folder to
/// decide anything — on a 5 GB install that is a full directory walk. The
/// repair is a one-time migration, so it runs once per process, not per command.
static INSTALL_REPAIR_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

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
    /// Arguments passed to Vanilla's client. Per-network for the same reason
    /// the install directory is: the two are different builds that take
    /// different flags, and a flag that is right for one can stop the other
    /// from starting. The flat `Config::launch_options` stays Radium's.
    pub launch_options: String,
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
            launch_options: String::new(),
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
    /// Font pack selected in Settings -> Theme -> Font: "default" | "ios" |
    /// "minecraft" | "radium". Orthogonal to `theme`: it only re-points the
    /// --font-ui / --font-mono CSS variables, so it composes with any skin,
    /// custom themes included.
    pub font: String,
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
    /// A client folder the launcher renamed out of the way because it held a
    /// client that did not belong to the network installing there (see
    /// [`recover_misplaced_radium_install`]). Kept so the UI can tell the user
    /// where their files went; cleared once the folder is gone.
    pub orphaned_client_dir: String,
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
        self.orphaned_client_dir = current.orphaned_client_dir.clone();
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
            font: "default".to_string(),
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
            orphaned_client_dir: String::new(),
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
                    // No delete first: the target holds no client, but it may
                    // hold something else. rename() refuses an existing target,
                    // and the recursive move then merges into it.
                    if std::fs::rename(&legacy_client, &target_client).is_err() {
                        let _ = move_dir_recursive(legacy_client, target_client);
                    }
                } else if legacy_client.exists() && !target_client.exists() {
                    // Fallback standard move
                    if std::fs::rename(&legacy_client, &target_client).is_err() {
                        let _ = move_dir_recursive(legacy_client, target_client);
                    }
                }
                
                // Try to clean up the legacy directory, but only if migrating
                // its contents emptied it. remove_dir (not remove_dir_all)
                // fails on a non-empty directory, so anything the Electron
                // launcher kept there that this migration does not understand
                // is left for the user rather than deleted on their behalf.
                let _ = std::fs::remove_dir(&legacy_dir);
            }
        }
    }
}

/// Canonical form for comparing install paths: forward slashes, lowercase, no
/// trailing separator. Not for display or filesystem use.
fn norm_dir(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// "Is this the same folder?" — separator- and case-insensitive. Install paths
/// reach us from three sources (config.json, the folder picker and
/// `app_data_dir()`) that do not agree on separators or casing, so a plain
/// string compare misses real collisions. Empty is never equal to anything,
/// including another empty.
fn same_dir(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && norm_dir(a) == norm_dir(b)
}

/// True when `path` is `dir` or sits inside it.
fn is_inside(path: &str, dir: &str) -> bool {
    if path.is_empty() || dir.is_empty() {
        return false;
    }
    let (path, dir) = (norm_dir(path), norm_dir(dir));
    path == dir || path.starts_with(&format!("{}/", dir))
}

/// Whether `path` resolves to a location inside `dir`.
///
/// Prefers a canonicalized comparison so slash style, drive-letter casing and
/// symlinks can't disguise an escape; falls back to a normalized, separator-
/// aware prefix test when either side can't be canonicalized (a path that does
/// not exist yet, a permission error). The fallback appends a trailing
/// separator so `C:\client2\x` is not treated as inside `C:\client`.
///
/// This is what keeps a recorded — or frontend-supplied — exe path from
/// pointing the launcher at an executable outside the install folder.
pub fn path_is_inside_dir(path: &str, dir: &str) -> bool {
    if path.is_empty() || dir.is_empty() {
        return false;
    }
    match (
        std::fs::canonicalize(std::path::Path::new(path)),
        std::fs::canonicalize(std::path::Path::new(dir)),
    ) {
        (Ok(path_canon), Ok(dir_canon)) => path_canon.starts_with(&dir_canon),
        _ => {
            let mut dir = norm_dir(dir);
            dir.push('/');
            norm_dir(path).starts_with(&dir)
        }
    }
}

/// Characters refused in launch options, as code points.
///
/// These reach a process spawn, so anything a shell would treat as syntax is
/// out: command separators, redirection, quoting, substitution and newlines.
const LAUNCH_OPTION_METACHARS: &[u32] = &[
    0x3B, // ;   command separator
    0x26, // &   background / chain
    0x7C, // |   pipe
    0x5E, // ^   cmd.exe escape
    0x60, // `   substitution
    0x24, // $   substitution
    0x25, // %   cmd.exe variable
    0x3E, // >   redirect out
    0x3C, // <   redirect in
    0x22, // "   double quote
    0x27, // '   single quote
    0x0D, //     carriage return
    0x0A, //     line feed
];

/// Whether `options` is safe to pass to the client.
///
/// One function rather than a copy at each call site. The save path and the
/// launch path used to carry their own lists, and the two had drifted: saving
/// accepted quotes that launching then rejected, so Settings could store
/// options that made the game refuse to start with no hint as to why.
pub fn launch_options_are_safe(options: &str) -> bool {
    !options
        .chars()
        .any(|c| LAUNCH_OPTION_METACHARS.contains(&(c as u32)))
}

/// Whether `dir` contains a game client. Uses the same lookup as launching, so
/// a folder that the launcher would happily run counts as occupied here.
fn dir_holds_client(dir: &std::path::Path) -> bool {
    crate::game::find_game_exe(&dir.to_string_lossy()).is_some()
}

/// Recovers from the cross-network install bug: a Radium client sitting in the
/// Vanilla client folder.
///
/// Before the install directory became per-network, an autosave taken while
/// Vanilla was the active network copied Vanilla's resolved folder into
/// Radium's flat `installDir`. Radium then downloaded into `client-vanilla`,
/// and Vanilla — which has never shipped a build — reported that client as its
/// own install.
///
/// The trigger is a client in Vanilla's *default* folder that Vanilla has no
/// record of (no custom dir, no build, no version, no exe path). Nothing but a
/// Vanilla download writes those fields, so a client there without them was
/// not put there by Vanilla. What happens next depends on how much is known:
///
/// * Radium's config still points into that folder — its install dir is pinned
///   there, or its recorded exe lives there — so the client is provably
///   Radium's and is moved back into Radium's own folder.
/// * Otherwise the folder is only renamed aside, never deleted and never
///   claimed for Radium: the launcher is confident the client is not Vanilla's,
///   not that it is Radium's.
///
/// Returns true if `config` changed.
fn recover_misplaced_radium_install(config: &mut Config, app_data_dir: &std::path::Path) -> bool {
    let vanilla_default = app_data_dir.join(default_client_folder(Network::Vanilla));
    let radium_default = app_data_dir.join(default_client_folder(Network::Radium));
    let vanilla_default_str = vanilla_default.to_string_lossy().to_string();

    if !dir_holds_client(&vanilla_default) {
        return false;
    }
    let v = &config.vanilla;
    let vanilla_recorded_nothing = v.install_dir.is_empty()
        && v.client_build.is_empty()
        && v.client_version.is_empty()
        && v.game_exe_path.is_empty();
    if !vanilla_recorded_nothing {
        return false;
    }

    // Is the client in there provably Radium's, or merely not Vanilla's?
    let radium_points_there = same_dir(&config.install_dir, &vanilla_default_str)
        || is_inside(&config.game_exe_path, &vanilla_default_str);

    if radium_points_there && !dir_holds_client(&radium_default) {
        // Radium's own folder is free, so the client goes home. Nothing here
        // deletes: an absent target is a plain rename, and an existing one is
        // merged into, because whatever else is sitting in that folder is not
        // this function's to remove.
        let moved = if radium_default.exists() {
            move_dir_recursive(vanilla_default.clone(), radium_default.clone()).is_ok()
        } else {
            fs::rename(&vanilla_default, &radium_default).is_ok()
                || move_dir_recursive(vanilla_default.clone(), radium_default.clone()).is_ok()
        };
        if moved {
            config.install_dir = String::new();
            config.game_exe_path =
                crate::game::find_game_exe(&radium_default.to_string_lossy()).unwrap_or_default();
            return true;
        }
    }

    // Not provably Radium's, or Radium's folder is already taken. Move the
    // folder out of the way so Vanilla stops reporting a client it never had,
    // and remember where it went so the UI can point the user at it.
    let Some(aside) = set_aside_path(&vanilla_default) else {
        return false;
    };
    if fs::rename(&vanilla_default, &aside).is_err() {
        return false;
    }
    config.orphaned_client_dir = aside.to_string_lossy().to_string();

    if same_dir(&config.install_dir, &vanilla_default_str) {
        config.install_dir = String::new();
    }
    if is_inside(&config.game_exe_path, &vanilla_default_str) {
        // The recorded client is somewhere nothing points at any more. Drop the
        // stale bookkeeping so the launcher re-derives it from disk instead of
        // reporting a build for a folder it does not read.
        config.game_exe_path = String::new();
        config.client_build = String::new();
        config.client_version = String::new();
        config.client_etag = String::new();
    }
    true
}

/// First free `<dir>.orphan`, `<dir>.orphan2`, … next to `dir`. `None` if the
/// name is somehow taken every time, in which case the caller leaves `dir` be
/// rather than picking a surprising location.
fn set_aside_path(dir: &std::path::Path) -> Option<PathBuf> {
    let name = dir.file_name()?.to_string_lossy().to_string();
    let parent = dir.parent()?;
    for n in 1..100 {
        let suffix = if n == 1 {
            ".orphan".to_string()
        } else {
            format!(".orphan{}", n)
        };
        let candidate = parent.join(format!("{}{}", name, suffix));
        if !candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Enforces that the two networks never resolve to the same client folder.
/// Returns true if `config` was changed.
///
/// They install different games from different sources, so a shared folder
/// means each network's download overwrites the other's install and each then
/// reports the other's client as its own. An explicit dir that collides is
/// cleared, which returns that network to its own default folder; Radium is
/// cleared first because its flat `installDir` is the field the old settings
/// autosave overwrote.
pub fn dedupe_install_dirs(app_handle: &tauri::AppHandle, config: &mut Config) -> bool {
    dedupe_install_dirs_at(config, &app_data_dir(app_handle))
}

pub fn dedupe_install_dirs_at(config: &mut Config, app_data_dir: &std::path::Path) -> bool {
    let collides = |config: &Config| {
        same_dir(
            &client_dir_for(config, Network::Radium, app_data_dir),
            &client_dir_for(config, Network::Vanilla, app_data_dir),
        )
    };

    if !collides(config) {
        return false;
    }
    if !config.install_dir.is_empty() {
        config.install_dir = String::new();
        // Clearing Radium's can still leave a collision if Vanilla was in turn
        // pointed at Radium's default folder.
        if collides(config) {
            config.vanilla.install_dir = String::new();
        }
        return true;
    }
    if !config.vanilla.install_dir.is_empty() {
        config.vanilla.install_dir = String::new();
        return true;
    }
    // Both are already on their defaults, which are different folders by
    // construction, so there is nothing left to clear.
    false
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

    // Undo a Radium client that the pre-fix settings autosave dropped into the
    // Vanilla folder, then guarantee the two networks resolve to separate
    // folders regardless of how the config got into its current state.
    let data_dir = app_data_dir(app_handle);
    if !INSTALL_REPAIR_DONE.swap(true, std::sync::atomic::Ordering::SeqCst)
        && recover_misplaced_radium_install(&mut config, &data_dir)
    {
        changed = true;
    }
    // Stop pointing at a set-aside folder the user has since deleted.
    if !config.orphaned_client_dir.is_empty()
        && !std::path::Path::new(&config.orphaned_client_dir).exists()
    {
        config.orphaned_client_dir = String::new();
        changed = true;
    }
    if dedupe_install_dirs_at(&mut config, &data_dir) {
        changed = true;
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
    client_dir_for(config, network, &app_data_dir(app_handle))
}

/// Folder each network installs into by default, relative to the app data dir.
/// The two must never be equal — see [`dedupe_install_dirs_at`].
pub fn default_client_folder(network: Network) -> &'static str {
    match network {
        Network::Radium => "client",
        Network::Vanilla => "client-vanilla",
    }
}

pub fn app_data_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// [`get_client_dir_for`] without the app handle, so the resolution rule has a
/// single definition that tests can exercise directly.
pub fn client_dir_for(config: &Config, network: Network, app_data_dir: &std::path::Path) -> String {
    let configured = config.install_dir_for(network);
    if !configured.is_empty() {
        return configured.to_string();
    }
    app_data_dir
        .join(default_client_folder(network))
        .to_string_lossy()
        .to_string()
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

    /// The font pack round-trips through a save. It is not one of the
    /// backend-managed fields, so nothing should be preserving or resetting
    /// it behind the settings UI's back.
    #[test]
    fn font_pack_survives_a_save_round_trip() {
        let incoming = config_from_frontend_json(serde_json::json!({
            "theme": "moderndark",
            "font": "minecraft"
        }));
        assert_eq!(incoming.font, "minecraft");

        let json = serde_json::to_value(&incoming).expect("config should serialize");
        assert_eq!(json["font"], "minecraft", "font is serialized as camelCase `font`");

        let reloaded = config_from_frontend_json(json);
        assert_eq!(reloaded.font, "minecraft");
    }

    /// A config written before the font setting existed has no `font` key at
    /// all. It must land on the default pack rather than failing to load and
    /// wiping every other setting with it.
    #[test]
    fn config_without_font_key_defaults_to_default_pack() {
        let legacy = config_from_frontend_json(serde_json::json!({
            "theme": "steam-green",
            "minimizeOnLaunch": true
        }));
        assert_eq!(legacy.font, "default");
    }

    /// A font pack is not backend-managed, so a save must be able to change it
    /// (unlike the client build fields, which the backend owns).
    #[test]
    fn preserve_backend_managed_fields_leaves_font_alone() {
        let mut on_disk = Config::default();
        on_disk.font = "radium".to_string();

        let mut incoming = config_from_frontend_json(serde_json::json!({ "font": "ios" }));
        incoming.preserve_backend_managed_fields(&on_disk);

        assert_eq!(incoming.font, "ios", "the user's new font choice must win");
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

    // ── Per-network install directories ─────────────────────────────────────
    //
    // Regression cover for the cross-network install bug: the settings autosave
    // copied the *active* network's resolved folder into Radium's flat
    // `installDir`, so after a visit to Vanilla, Radium pointed at
    // `client-vanilla`. Radium's download then extracted there and Vanilla —
    // which has never shipped a build — reported that client as installed.

    /// Scratch app-data dir for the tests that touch the filesystem.
    fn temp_app_data(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "radium-cfg-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp app data dir");
        dir
    }

    fn write_client(dir: &std::path::Path) {
        fs::create_dir_all(dir).expect("client dir");
        fs::write(dir.join("RecRoom.exe"), b"stub").expect("client exe");
    }

    #[test]
    fn networks_default_to_separate_client_folders() {
        let cfg = Config::default();
        let data = PathBuf::from("C:/data");
        assert_ne!(
            client_dir_for(&cfg, Network::Radium, &data),
            client_dir_for(&cfg, Network::Vanilla, &data)
        );
    }

    #[test]
    fn radium_pointed_at_the_vanilla_folder_is_reset_to_its_own() {
        let data = PathBuf::from("C:/data");
        let mut cfg = Config::default();
        cfg.install_dir = "C:/data/client-vanilla".to_string();

        assert!(dedupe_install_dirs_at(&mut cfg, &data));
        assert_eq!(cfg.install_dir, "", "the colliding pin is dropped");
        assert_ne!(
            client_dir_for(&cfg, Network::Radium, &data),
            client_dir_for(&cfg, Network::Vanilla, &data)
        );
    }

    /// Separators and casing differ between config.json, the folder picker and
    /// `app_data_dir()`, so the collision check cannot be a string compare.
    #[test]
    fn collision_is_detected_across_separators_and_casing() {
        let data = PathBuf::from("C:/data");
        let mut cfg = Config::default();
        cfg.install_dir = "C:\\Data\\Client-Vanilla\\".to_string();

        assert!(dedupe_install_dirs_at(&mut cfg, &data));
        assert_eq!(cfg.install_dir, "");
    }

    #[test]
    fn vanilla_pointed_at_the_radium_folder_is_reset_to_its_own() {
        let data = PathBuf::from("C:/data");
        let mut cfg = Config::default();
        cfg.vanilla.install_dir = "C:/data/client".to_string();

        assert!(dedupe_install_dirs_at(&mut cfg, &data));
        assert_eq!(cfg.vanilla.install_dir, "");
        assert_ne!(
            client_dir_for(&cfg, Network::Radium, &data),
            client_dir_for(&cfg, Network::Vanilla, &data)
        );
    }

    /// Two custom dirs pointing at one folder: Radium yields, because its flat
    /// field is the one the buggy autosave wrote.
    #[test]
    fn a_shared_custom_folder_is_split_apart() {
        let data = PathBuf::from("C:/data");
        let mut cfg = Config::default();
        cfg.install_dir = "D:/Games/RecRoom".to_string();
        cfg.vanilla.install_dir = "D:/Games/RecRoom".to_string();

        assert!(dedupe_install_dirs_at(&mut cfg, &data));
        assert_eq!(cfg.install_dir, "");
        assert_eq!(cfg.vanilla.install_dir, "D:/Games/RecRoom");
        assert_ne!(
            client_dir_for(&cfg, Network::Radium, &data),
            client_dir_for(&cfg, Network::Vanilla, &data)
        );
    }

    #[test]
    fn distinct_custom_dirs_are_left_alone() {
        let data = PathBuf::from("C:/data");
        let mut cfg = Config::default();
        cfg.install_dir = "D:/Games/Radium".to_string();
        cfg.vanilla.install_dir = "D:/Games/Vanilla".to_string();

        assert!(!dedupe_install_dirs_at(&mut cfg, &data));
        assert_eq!(cfg.install_dir, "D:/Games/Radium");
        assert_eq!(cfg.vanilla.install_dir, "D:/Games/Vanilla");
    }

    /// The repair for users who already hit the bug: their Radium client sits
    /// in `client-vanilla` and, since Radium's own folder is free, comes home.
    #[test]
    fn a_radium_client_left_in_the_vanilla_folder_is_moved_back() {
        let data = temp_app_data("recover");
        write_client(&data.join("client-vanilla"));

        let mut cfg = Config::default();
        cfg.install_dir = data.join("client-vanilla").to_string_lossy().to_string();
        cfg.game_exe_path = data
            .join("client-vanilla")
            .join("RecRoom.exe")
            .to_string_lossy()
            .to_string();
        cfg.client_build = "recroom-baby-2016".to_string();

        assert!(recover_misplaced_radium_install(&mut cfg, &data));
        assert!(data.join("client").join("RecRoom.exe").exists());
        assert!(
            !data.join("client-vanilla").exists(),
            "Vanilla must stop claiming a client it never had"
        );
        assert_eq!(cfg.install_dir, "", "Radium tracks its own default again");
        assert!(is_inside(
            &cfg.game_exe_path,
            &data.join("client").to_string_lossy()
        ));
        assert_eq!(cfg.client_build, "recroom-baby-2016", "same client, just moved");
        assert_eq!(cfg.orphaned_client_dir, "", "nothing was left behind");

        let _ = fs::remove_dir_all(&data);
    }

    /// A real Vanilla install must never be touched, even while Radium's
    /// install dir is (wrongly) pinned to the same folder.
    #[test]
    fn a_real_vanilla_install_is_never_moved() {
        let data = temp_app_data("keep-vanilla");
        write_client(&data.join("client-vanilla"));

        let mut cfg = Config::default();
        cfg.install_dir = data.join("client-vanilla").to_string_lossy().to_string();
        cfg.vanilla.client_build = "vanilla-build".to_string();

        assert!(!recover_misplaced_radium_install(&mut cfg, &data));
        assert!(data.join("client-vanilla").join("RecRoom.exe").exists());
        assert!(!data.join("client").exists());

        // The pin is still wrong, so the collision guard is what unwinds it.
        assert!(dedupe_install_dirs_at(&mut cfg, &data));
        assert_eq!(cfg.install_dir, "");

        let _ = fs::remove_dir_all(&data);
    }

    /// Radium's own folder is already occupied, so the duplicate cannot go
    /// home. It is renamed aside rather than deleted, and the stale bookkeeping
    /// for the abandoned folder is dropped — otherwise the launcher would
    /// report a build for a folder it no longer reads.
    #[test]
    fn a_duplicate_is_set_aside_when_it_cannot_be_moved_back() {
        let data = temp_app_data("occupied");
        write_client(&data.join("client-vanilla"));
        write_client(&data.join("client"));

        let mut cfg = Config::default();
        cfg.install_dir = data.join("client-vanilla").to_string_lossy().to_string();
        cfg.game_exe_path = data
            .join("client-vanilla")
            .join("RecRoom.exe")
            .to_string_lossy()
            .to_string();
        cfg.client_build = "recroom-baby-2016".to_string();
        cfg.client_version = "0.9.2".to_string();

        assert!(recover_misplaced_radium_install(&mut cfg, &data));
        assert!(!data.join("client-vanilla").exists());
        assert!(
            data.join("client-vanilla.orphan").join("RecRoom.exe").exists(),
            "set aside, never deleted"
        );
        assert!(data.join("client").join("RecRoom.exe").exists(), "Radium's own install is untouched");
        assert_eq!(
            cfg.orphaned_client_dir,
            data.join("client-vanilla.orphan").to_string_lossy().to_string()
        );
        assert_eq!(cfg.install_dir, "");
        assert_eq!(cfg.game_exe_path, "");
        assert_eq!(cfg.client_build, "");
        assert_eq!(cfg.client_version, "");

        let _ = fs::remove_dir_all(&data);
    }

    /// The shape this bug leaves behind once the config has been reset: neither
    /// network points at the stray folder any more, so nothing proves it is
    /// Radium's. It is not claimed for Radium — only moved out of the way, so
    /// Vanilla stops reporting an install it never had.
    #[test]
    fn an_unclaimed_client_in_the_vanilla_folder_is_set_aside_not_adopted() {
        let data = temp_app_data("unclaimed");
        write_client(&data.join("client-vanilla"));

        let mut cfg = Config::default();

        assert!(recover_misplaced_radium_install(&mut cfg, &data));
        assert!(!data.join("client").exists(), "an unproven client is not adopted");
        assert!(data.join("client-vanilla.orphan").join("RecRoom.exe").exists());
        assert_eq!(
            cfg.orphaned_client_dir,
            data.join("client-vanilla.orphan").to_string_lossy().to_string()
        );

        let _ = fs::remove_dir_all(&data);
    }

    /// A second run must not clobber the folder set aside by the first.
    #[test]
    fn a_second_set_aside_folder_gets_its_own_name() {
        let data = temp_app_data("twice");
        write_client(&data.join("client-vanilla"));
        write_client(&data.join("client-vanilla.orphan"));

        let mut cfg = Config::default();
        assert!(recover_misplaced_radium_install(&mut cfg, &data));
        assert!(data.join("client-vanilla.orphan").join("RecRoom.exe").exists());
        assert!(data.join("client-vanilla.orphan2").join("RecRoom.exe").exists());

        let _ = fs::remove_dir_all(&data);
    }

    /// An empty Vanilla folder is the normal case and must be left alone.
    #[test]
    fn an_empty_vanilla_folder_is_not_touched() {
        let data = temp_app_data("empty");
        fs::create_dir_all(data.join("client-vanilla")).expect("dir");

        let mut cfg = Config::default();
        assert!(!recover_misplaced_radium_install(&mut cfg, &data));
        assert!(data.join("client-vanilla").exists());

        let _ = fs::remove_dir_all(&data);
    }

    /// The set-aside path is backend-managed: a stale settings autosave must
    /// not wipe the only record of where the user's files went.
    #[test]
    fn stale_autosave_does_not_clobber_the_set_aside_path() {
        let mut on_disk = Config::default();
        on_disk.orphaned_client_dir = "C:/data/client-vanilla.orphan".to_string();

        let mut incoming = config_from_frontend_json(serde_json::json!({ "theme": "moderngreen" }));
        assert_eq!(incoming.orphaned_client_dir, "");

        incoming.preserve_backend_managed_fields(&on_disk);
        assert_eq!(incoming.orphaned_client_dir, "C:/data/client-vanilla.orphan");
    }

    /// Nothing in the repair path deletes. When Radium's folder already exists
    /// but holds no client — a cancelled download, or files the user put there
    /// — the client is merged in alongside them, not dropped on top of a
    /// wiped folder.
    #[test]
    fn moving_a_client_home_never_deletes_what_is_already_there() {
        let data = temp_app_data("merge");
        write_client(&data.join("client-vanilla"));
        fs::create_dir_all(data.join("client")).expect("dir");
        fs::write(data.join("client").join("notes.txt"), b"keep me").expect("stray file");

        let mut cfg = Config::default();
        cfg.install_dir = data.join("client-vanilla").to_string_lossy().to_string();

        assert!(recover_misplaced_radium_install(&mut cfg, &data));
        assert!(data.join("client").join("RecRoom.exe").exists(), "client moved home");
        assert!(
            data.join("client").join("notes.txt").exists(),
            "an unrelated file in the target folder survives"
        );
        assert_eq!(
            fs::read_to_string(data.join("client").join("notes.txt")).expect("read"),
            "keep me"
        );

        let _ = fs::remove_dir_all(&data);
    }

    // ── Executable containment ──────────────────────────────────────────────

    /// The launcher spawns whatever `gameExePath` names, and for Radium that
    /// value arrives from the frontend. It must never resolve outside the
    /// client directory.
    #[test]
    fn an_exe_outside_the_client_dir_is_not_contained() {
        let data = temp_app_data("contain");
        let client = data.join("client");
        write_client(&client);
        fs::write(data.join("evil.exe"), b"stub").expect("stub");

        let client_str = client.to_string_lossy().to_string();
        assert!(path_is_inside_dir(
            &client.join("RecRoom.exe").to_string_lossy(),
            &client_str
        ));
        assert!(!path_is_inside_dir(
            &data.join("evil.exe").to_string_lossy(),
            &client_str
        ));
        assert!(
            !path_is_inside_dir(r"C:\Windows\System32\cmd.exe", &client_str),
            "an absolute path elsewhere on disk is never inside the client dir"
        );

        let _ = fs::remove_dir_all(&data);
    }

    /// Traversal has to be resolved, not string-matched: the prefix of this
    /// path looks like the client dir.
    #[test]
    fn traversal_out_of_the_client_dir_is_not_contained() {
        let data = temp_app_data("traversal");
        let client = data.join("client");
        write_client(&client);
        fs::write(data.join("evil.exe"), b"stub").expect("stub");

        let escape = client.join("..").join("evil.exe").to_string_lossy().to_string();
        assert!(!path_is_inside_dir(&escape, &client.to_string_lossy()));

        let _ = fs::remove_dir_all(&data);
    }

    /// A sibling folder whose name starts with the client dir's name is a
    /// different folder, not a child of it.
    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_contained() {
        assert!(!path_is_inside_dir(
            r"C:\data\client2\RecRoom.exe",
            r"C:\data\client"
        ));
        assert!(path_is_inside_dir(
            r"C:/data/client/RecRoom.exe",
            r"C:\data\client"
        ));
    }

    #[test]
    fn launch_options_reject_everything_a_shell_would_read_as_syntax() {
        assert!(launch_options_are_safe("-fullscreen -windowed"));
        assert!(launch_options_are_safe(""));
        assert!(launch_options_are_safe("-width 1920 -height 1080"));

        for bad in [
            "-a; calc",
            "-a & calc",
            "-a | calc",
            "-a > out.txt",
            "-a < in.txt",
            "-a ^ b",
            "-a `whoami`",
            "-a $HOME",
            "-a %APPDATA%",
        ] {
            assert!(!launch_options_are_safe(bad), "{bad:?} was accepted");
        }

        // Newlines, spelled by code point so the test is checking the byte
        // rather than whatever an editor left in the file.
        let cr = char::from_u32(0x0D).unwrap();
        let lf = char::from_u32(0x0A).unwrap();
        assert!(!launch_options_are_safe(&format!("-a{cr}calc")));
        assert!(!launch_options_are_safe(&format!("-a{lf}calc")));

        // Quotes. The save path used to allow these while the launch path
        // refused them, so options could be stored that would not start.
        let single = char::from_u32(0x27).unwrap();
        let double = char::from_u32(0x22).unwrap();
        assert!(!launch_options_are_safe(&format!("-name {single}a b{single}")));
        assert!(!launch_options_are_safe(&format!("-name {double}a b{double}")));
    }

    #[test]
    fn each_network_keeps_its_own_launch_options() {
        // The two are different client builds taking different flags, so a
        // config round trip must not let one network's options land on the
        // other's slot - the bug the per-network install directory already had.
        let mut cfg = Config::default();
        cfg.launch_options = "-radium-only".to_string();
        cfg.vanilla.launch_options = "-vanilla-only".to_string();

        let json = serde_json::to_string(&cfg).expect("the config should serialize");
        assert!(
            json.contains("\"launchOptions\":\"-radium-only\""),
            "Radium's options are not on the flat camelCase field: {json}"
        );

        let back: Config = serde_json::from_str(&json).expect("and deserialize");
        assert_eq!(back.launch_options, "-radium-only");
        assert_eq!(back.vanilla.launch_options, "-vanilla-only");
    }

    #[test]
    fn a_config_written_before_vanilla_had_launch_options_still_loads() {
        // #[serde(default)] on both the struct and the field is what keeps an
        // existing config.json - which has no vanilla.launchOptions at all -
        // from failing to parse and resetting every setting the user has.
        let old = r#"{"launchOptions":"-keep-me","vanilla":{"installDir":"C:/v"}}"#;
        let cfg: Config = serde_json::from_str(old).expect("an older config should still load");

        assert_eq!(cfg.launch_options, "-keep-me");
        assert_eq!(cfg.vanilla.install_dir, "C:/v");
        assert_eq!(cfg.vanilla.launch_options, "");
    }
}
