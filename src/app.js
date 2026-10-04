// ─── Log ─────────────────────────────────────────────────────────────────────
// Every line the launcher logs, kept three ways: here for the Logs page
// (logs.js draws it) and for bug reports; and on disk, a file per session,
// through applog.rs — so a report can still attach the session that froze or
// crashed after the launcher has been restarted.
//
// First in this file, and `var` throughout: `var` has no temporal dead zone,
// so anything from here on can log. Startup is when the launcher is most
// likely to break (missing runtime, bad config, denied permissions), and a
// failure there used to leave no trace at all.

var LOG_LEVELS = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERROR' };
/// Where a line comes from. The Logs page filters on it, and it is written
/// into the line so a log read outside the launcher says the same.
var LOG_SOURCES = {
  launcher: 'LAUNCHER',  // the launcher itself: startup, settings, themes
  update:   'UPDATE',    // launcher updates
  server:   'SERVER',    // server status, player counts, lookups
  account:  'ACCOUNT',   // signing in to Vanilla and Stella
  install:  'INSTALL',   // download, install, verify, uninstall
  game:     'GAME',      // launching, antivirus checks, the running game
};
/// How many lines the page keeps. The file on disk keeps the whole session.
var LOG_MAX = 2000;
var logEntries = [];     // { seq, time, level, source, msg }, oldest first
var logSeq = 0;
var logListeners = [];   // called with each new entry (logs.js)
var logDiskQueue = [];
var logDiskTimer = null;
var logSessionStart = new Date();

function logPad2(n) { return String(n).padStart(2, '0'); }
function logClock(d = new Date()) {
  return `${logPad2(d.getHours())}:${logPad2(d.getMinutes())}:${logPad2(d.getSeconds())}`;
}
function logDate(d = new Date()) {
  return `${d.getFullYear()}-${logPad2(d.getMonth() + 1)}-${logPad2(d.getDate())}`;
}

/// An entry as one line of text, the way it is saved, copied and sent:
/// `[17:27:18] ERROR  ACCOUNT   Sign-in failed`. Padded with spaces, which
/// is the only alignment a text file has; a message's own line breaks are
/// indented under its start.
function logLineText(e) {
  const head = `[${e.time}] ${LOG_LEVELS[e.level].padEnd(5)}  ${LOG_SOURCES[e.source].padEnd(8)}  `;
  return head + e.msg.split('\n').join('\n' + ' '.repeat(head.length));
}

/// Log a line. `type` is a key of LOG_LEVELS, `source` a key of LOG_SOURCES.
function addLog(msg, type = 'info', source = 'launcher') {
  const entry = {
    seq: ++logSeq,
    time: logClock(),
    level: LOG_LEVELS[type] ? type : 'info',
    source: LOG_SOURCES[source] ? source : 'launcher',
    msg: String(msg).replace(/\r\n?/g, '\n'),
  };
  logEntries.push(entry);
  if (logEntries.length > LOG_MAX) logEntries.splice(0, logEntries.length - LOG_MAX);

  logDiskQueue.push(logLineText(entry));
  if (!logDiskTimer) logDiskTimer = setTimeout(flushLogToDisk, 700);

  for (const fn of logListeners) {
    try { fn(entry); } catch (e) { /* a broken view must not stop logging */ }
  }
}

/// Hand the queued lines to applog.rs. Straight through Tauri's global rather
/// than the window.radium shim below, which doesn't exist yet when the first
/// lines are logged.
function flushLogToDisk() {
  logDiskTimer = null;
  if (!logDiskQueue.length) return;
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (!invoke) { logDiskTimer = setTimeout(flushLogToDisk, 1000); return; }
  const lines = logDiskQueue.splice(0, logDiskQueue.length);
  invoke('log_append', { lines }).catch(() => {});
}
// A reload (Ctrl+R) restarts the page but not the session file; mark where.
logDiskQueue.push(`===== Session started ${logDate(logSessionStart)} ${logClock(logSessionStart)} =====`);
window.addEventListener('pagehide', flushLogToDisk);

// ─── Uncaught fault capture ──────────────────────────────────────────────────
var seenFaults = new Set();

function recordFault(label, message, where) {
  // Deduped: a fault inside a render or polling loop would otherwise flood the
  // log and push out the history that explains it.
  const key = `${label}|${message}|${where || ''}`;
  if (seenFaults.has(key)) return;
  if (seenFaults.size > 50) seenFaults.clear();
  seenFaults.add(key);
  addLog(`${label}: ${message}${where ? ` (${where})` : ''}`, 'error');
}

window.addEventListener('error', (e) => {
  // Failed <img>/<script> loads fire this too, with the element as the target.
  // The UI has its own onerror fallbacks for those, so they are noise here.
  if (e && e.target && e.target !== window && e.target.tagName) return;
  const file = e && e.filename ? e.filename.split('/').pop() : '';
  const where = file ? `${file}:${e.lineno}:${e.colno}` : '';
  recordFault('Uncaught error', (e && e.message) || String((e && e.error) || 'unknown'), where);
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  const msg = (r && (r.message || (typeof r === 'string' ? r : r.toString()))) || 'unknown';
  recordFault('Unhandled promise rejection', msg);
});

// ─── Tauri v2 Compatibility Shim ───────────────────────────────────────────────
// Recreates the window.radium API from the Electron preload bridge using Tauri APIs.
// This allows the rest of app.js to remain unchanged.
// ── Network selection ────────────────────────────────────────────────────
// Which revival the launcher is pointed at. Read by the IPC shim below so every
// backend call carries it, instead of threading the value through ~30 call
// sites. Set from config at startup by setNetwork().
let activeNetwork = 'radium';

/// What the backend was last told about whether Stella is in use (see
/// syncStellaInUse()). Up here because applyNetworkUI() runs during startup,
/// before the rest of this file has been evaluated.
let stellaInUseSent = null;

/// Tell the backend whether Stella is in use: the network picked, in a window
/// on screen. Only then does it sign in with Steam (which Steam shows to your
/// friends as playing Rec Room) or keep Stella's live friends connection open;
/// hidden in the tray or on another network, it does neither. See
/// stella_api::IN_USE.
function syncStellaInUse() {
  const inUse = activeNetwork === 'stella' && !document.hidden;
  if (inUse === stellaInUseSent) return;
  stellaInUseSent = inUse;
  window.radium?.stellaSetInUse?.(inUse);
}

// Per-network descriptors. `capabilities` records what a network's API can
// actually do — Vanilla has no activity feed and no presence — so the UI hides
// controls rather than showing dead ones.
const NETWORKS = {
  radium: {
    label: 'RADIUM',
    logo: 'logo.png',
    site: 'https://www.radie.app/',
    downloadPage: 'https://www.radie.app/',
    imageBase: 'https://img.radie.app',
    hasFilters: true,
    hasSort: true,
    hasFeed: true,
    hasPresence: true,
    // Radium's API could serve one, but the FEED tab was asked for on Vanilla
    // only — this flag is the switch if that ever changes.
    hasPhotoFeed: false,
    // Radium resolves its own download URL from the recroom.baby page.
    needsConfiguredDownloadUrl: false
  },
  vanilla: {
    label: 'VANILLA',
    logo: 'assets/vanilla-logo.png',
    site: 'https://vanillarec.net/',
    downloadPage: 'https://vanillarec.net/download/',
    imageBase: '',
    // Both true since rooms moved to the bulk /ws set: filtering and sorting
    // happen over the whole room list in the backend, so a tag and a typed
    // search compose instead of overwriting each other, and a sort orders every
    // room rather than the first page the API happened to return.
    hasFilters: true,
    hasSort: true,
    hasFeed: false,
    hasPresence: false,
    hasPhotoFeed: true,
    // Vanilla has not shipped a client; the URL comes from Settings.
    needsConfiguredDownloadUrl: true
  },
  stella: {
    label: 'STELLA',
    logo: 'assets/stella-logo.png',
    site: 'https://discord.com/invite/stella-rr',
    downloadPage: 'https://discord.com/invite/stella-rr',
    // Stella serves images openly at api.stellaonline.org/img/<name>; the
    // backend attaches absolute ThumbUrl/AvatarUrl, so no imageBase is needed.
    imageBase: '',
    // Stella's game API (rooms, people, profiles) is reached by signing in with
    // the player's Steam account — see stella_api.rs. Rooms and People are live;
    // there is no network-wide photo feed, and presence exists only for friends.
    hasSocial: true,
    hasFilters: true,
    // Sorted in the backend over the whole room list (stella_api::sort_rooms).
    hasSort: true,
    hasFeed: false,
    hasPresence: false,
    hasPhotoFeed: false,
    // There is no list of everyone, so before something is typed People lists
    // the players online now, from the live hub (stella_api::browse_online).
    hasPeopleBrowse: true,
    needsConfiguredDownloadUrl: false,
    // The client is patched at launch; the patch has its own UPDATE button.
    hasPatch: true
  }
};

/// Where `network`'s own settings live in config: Radium's are the flat fields,
/// every other network's are nested under its name (`config.vanilla`,
/// `config.stella`).
function networkState(network) {
  return network === 'radium' ? config : (config?.[network] || {});
}

/// Write `fields` into `network`'s own part of config.
function setNetworkState(network, fields) {
  if (!config) return;
  if (network === 'radium') Object.assign(config, fields);
  else config[network] = { ...(config[network] || {}), ...fields };
}

function networkInfo(name = activeNetwork) {
  return NETWORKS[name] || NETWORKS.radium;
}

/// Install directories are per-network: Radium's lives on the flat
/// `config.installDir`, Vanilla's on `config.vanilla.installDir`. Every read
/// and write has to go through these two helpers — touching the flat field
/// while Vanilla is active is what stamped the Vanilla folder onto Radium's
/// slot, which then sent Radium's download into the Vanilla client folder and
/// made Vanilla report that Radium's client was a Vanilla install.
function configInstallDir(network = activeNetwork) {
  if (!config) return '';
  return networkState(network).installDir || '';
}

/// Whether `network`'s client folder has been excluded from Windows Defender
/// (or, with a third-party antivirus, the warning acknowledged for it).
///
/// Per network, like the folder it describes: Radium's is the flat
/// `config.defenderExcluded`, Vanilla's `config.vanilla.defenderExcluded`, and
/// each network's uninstall clears its own. A single flat flag meant excluding
/// Radium's folder also skipped the check for Vanilla's, which never was.
function avExcluded(network = activeNetwork) {
  if (!config) return false;
  return networkState(network).defenderExcluded === true;
}

function setAvExcluded(value, network = activeNetwork) {
  setNetworkState(network, { defenderExcluded: value });
}

/// Placeholder for the log/modal text before checkInstall() has resolved the
/// real path. Per-network, since each defaults to its own folder.
function defaultInstallDirHint(network = activeNetwork) {
  const folder = network === 'radium' ? 'client' : `client-${network}`;
  return `%APPDATA%\\com.radium.launcher\\${folder}`;
}

function setConfigInstallDir(dir, network = activeNetwork) {
  setNetworkState(network, { installDir: dir });
}

/// The Settings path span for a network. Every network's row exists at once,
/// so each read and write of a displayed path has to name which one it means.
function installDirSpan(network = activeNetwork) {
  return $(`cfgInstallDir${network.charAt(0).toUpperCase()}${network.slice(1)}`);
}

/// Best known install path for `network`: what Settings is showing (the
/// resolved path, once checkInstall() has filled it in), else the configured
/// override, else the default hint.
function shownInstallDir(network = activeNetwork) {
  return installDirSpan(network)?.textContent.trim()
    || configInstallDir(network)
    || defaultInstallDirHint(network);
}

/// Fill both install-location rows.
///
/// The inactive network has no checkInstall() result to draw on, so its
/// resolved folder comes straight from the backend — the same path its
/// download would use: the default, or a custom location's network subfolder.
async function refreshInstallDirRows() {
  for (const network of Object.keys(NETWORKS)) {
    const span = installDirSpan(network);
    if (!span) continue;
    let dir = '';
    try {
      dir = await window.radium?.resolveClientDir(network, configInstallDir(network));
    } catch (e) {
      console.error('resolveClientDir error:', e);
    }
    span.textContent = dir || configInstallDir(network) || defaultInstallDirHint(network);
  }
}

/// Mirrors `norm_dir` in config.rs: install paths reach the UI from the folder
/// picker, config.json and the backend's own resolver, which disagree on
/// separators and casing.
function normDir(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/// Whether two install folders are one folder or one holds the other. Mirrors
/// `install_dirs_overlap` in config.rs, which resets a folder that does.
function installDirsOverlap(a, b) {
  const x = normDir(a), y = normDir(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/// The first other network whose folder, as Settings is showing it, is `dir`
/// or holds it or sits inside it: `{ network, dir }`, or null.
function overlappingInstallDir(network, dir) {
  for (const other of Object.keys(NETWORKS)) {
    if (other === network) continue;
    const otherDir = installDirSpan(other)?.textContent.trim() || configInstallDir(other) || '';
    if (otherDir && installDirsOverlap(otherDir, dir)) return { network: other, dir: otherDir };
  }
  return null;
}

/// `cfg` without `glass.bgImage`. See saveConfig in the shim below.
function withoutBackdrop(cfg) {
  if (!cfg || !cfg.glass || !('bgImage' in cfg.glass)) return cfg;
  const { bgImage, ...glass } = cfg.glass;
  return { ...cfg, glass };
}

(function setupTauriShim() {
  // Every call waits for the last "is Stella in use" message to land first,
  // so a sign-in asked for straight after Stella is opened is never turned
  // down as a background one. Normally already settled: a microtask's wait.
  const rawInvoke = window.__TAURI__.core.invoke;
  let inUseSent = Promise.resolve();
  const invoke = (...args) => inUseSent.then(() => rawInvoke(...args));
  const { listen } = window.__TAURI__.event;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { open } = window.__TAURI__.shell;

  const appWindow = getCurrentWindow();

  let unlistenMap = {};

  window.radium = {
    // Window controls
    minimize: () => appWindow.minimize(),
    maximize: () => appWindow.toggleMaximize(),
    close:    () => appWindow.close(),

    // Config. The glass backdrop can be a 1.4 MB data URI, so it is left out
    // of every whole-config save (the backend keeps the stored one) and is
    // written only through setGlassBackdrop — otherwise each autosave, toggle
    // and play-mode click shipped it over IPC and had it re-parsed.
    getConfig:  ()    => invoke('cmd_get_config'),
    saveConfig: (cfg) => invoke('cmd_save_config', { config: withoutBackdrop(cfg) }),
    setGlassBackdrop: (value) => invoke('cmd_set_glass_backdrop', { value: String(value || '') }),
    // The picture at a typed address, as an ArrayBuffer. The CSP lets the
    // page load no remote image itself; see setGlassBackdropFromUrl().
    fetchGlassBackdrop: (url) => invoke('cmd_fetch_glass_backdrop', { url: String(url || '') }),

    // Server. Every command below takes the active network so the backend can
    // route to the right API without the call sites having to care.
    pingServer:     (url) => invoke('ping_server', { url }),
    getPlayerCount: ()    => invoke('get_player_count', { network: activeNetwork }),
    addDefenderExclusion:    () => invoke('add_defender_exclusion', { network: activeNetwork }),
    removeDefenderExclusion: () => invoke('remove_defender_exclusion', { network: activeNetwork }),
    detectAntivirus:         () => invoke('detect_antivirus'),

    // Install
    checkInstall: () => invoke('check_install', { network: activeNetwork }),
    checkClientUpdate: () => invoke('check_client_update', { network: activeNetwork }),

    // Download
    downloadClient:  () => invoke('download_client', { network: activeNetwork }),
    cancelDownload:  () => invoke('cancel_download', { network: activeNetwork }),
    pauseDownload:   () => invoke('pause_download'),
    resumableDownloadInfo: () => invoke('resumable_download_info', { network: activeNetwork }),
    uninstallClient: () => invoke('uninstall_client', { network: activeNetwork }),
    // Verify Files: check every installed file, then repair the ones that
    // failed — single files where the server allows, else from a full
    // download when `full` (see verify.rs).
    verifyClient: () => invoke('verify_client', { network: activeNetwork }),
    repairClient: (full = false) => invoke('repair_client', { network: activeNetwork, full }),
    // These take an explicit network: Settings lists every network's install
    // folder at once, so it has to address the inactive ones too.
    openClientFolder: (network = activeNetwork) => invoke('open_client_folder', { network }),
    selectFolder:     (network = activeNetwork) => invoke('select_folder', { network }),
    getDefaultClientDir: (network = activeNetwork) => invoke('get_default_client_dir', { network }),
    // The folder the client really goes in for a picked location: its
    // network's subfolder of it (`config::custom_client_dir`).
    resolveClientDir: (network = activeNetwork, folder = '') => invoke('resolve_client_dir', { network, folder }),
    onDownloadProgress: async (cb) => {
      if (unlistenMap['download-progress']) unlistenMap['download-progress']();
      unlistenMap['download-progress'] = await listen('download-progress', (event) => cb(event.payload));
    },

    // Stella's patch: whether it needs an UPDATE, and running one.
    stellaPatchStatus: () => invoke('stella_patch_status'),
    stellaUpdatePatch: () => invoke('stella_update_patch'),
    onStellaPatchProgress: async (cb) => {
      if (unlistenMap['stella-patch-progress']) unlistenMap['stella-patch-progress']();
      unlistenMap['stella-patch-progress'] = await listen('stella-patch-progress', (event) => cb(event.payload));
    },

    // Game
    launchGame: (cfg) => invoke('launch_game', { config: { ...cfg, network: activeNetwork } }),
    killGame:   ()    => invoke('kill_game'),
    onGameState: async (cb) => {
      if (unlistenMap['game-state']) unlistenMap['game-state']();
      unlistenMap['game-state'] = await listen('game-state', (event) => cb(event.payload));
    },

    // Misc
    openUrl:    (url)  => open(url),
    getVersion: ()     => invoke('get_version'),
    checkSteam: ()     => invoke('check_steam'),
    checkRequiredSteamApp: () => invoke('check_required_steam_app'),
    checkSmartAppControl: () => invoke('check_smart_app_control'),

    // Auto-update. Only the installer the last check offered is accepted, and
    // the backend checks it against the digest GitHub published with it.
    checkForUpdate:  ()                            => invoke('check_for_update'),
    downloadUpdate:  (downloadUrl, placeOnDesktop) =>
      invoke('download_update', { url: downloadUrl, placeOnDesktop: !!placeOnDesktop }),

    // Data Fetching
    fetchRooms:           (args) => invoke('fetch_rooms', { args: { ...args, network: activeNetwork } }),
    fetchPeople:          (args) => invoke('fetch_people', { args: { ...args, network: activeNetwork } }),
    fetchFilters:         ()     => invoke('fetch_filters', { network: activeNetwork }),
    fetchRoomWebDetails:  (name) => invoke('fetch_room_web_details', { name: String(name), network: activeNetwork }),
    fetchUserWebDetails:  (name, accountId) => invoke('fetch_user_web_details', { name: String(name), network: activeNetwork, accountId: accountId ?? null }),
    fetchUserPhotos:      (args) => invoke('fetch_user_photos', { args: { ...args, network: activeNetwork } }),
    fetchRoomPhotos:      (args) => invoke('fetch_room_photos', { args: { ...args, network: activeNetwork } }),
    fetchUserRooms:       (args) => invoke('fetch_user_rooms', { args: { ...args, network: activeNetwork } }),
    fetchUserFeed:        (args) => invoke('fetch_user_feed', { args: { ...args, network: activeNetwork } }),
    fetchRecentPhotos:    (args) => invoke('fetch_recent_photos', { args: { ...args, network: activeNetwork } }),
    // Fire-and-forget: warms the active network's caches so the first visit to
    // Rooms or People reads a list that is already downloaded. Callers don't
    // await it, so a failure is swallowed here rather than surfacing as an
    // unhandled rejection — there is nothing to tell the user, and the tab
    // that needs the data will fetch it itself.
    prefetchNetworkData:  ()     => invoke('prefetch_network_data', { network: activeNetwork }).catch(() => {}),
    fetchPhotoWebDetails: (photoId) => invoke('fetch_photo_web_details', { photoId: String(photoId), network: activeNetwork }),
    fetchPhotoComments:   (photoId) => invoke('fetch_photo_comments', { photoId: String(photoId), network: activeNetwork }),

    // Vanilla account. The session cookie stays in the backend: these return
    // only `{ authenticated, player }`, a token count and notification rows.
    vanillaLogin:         () => invoke('vanilla_login'),
    vanillaLogout:        () => invoke('vanilla_logout'),
    stellaAuthStatus:     () => invoke('stella_auth_status'),
    stellaLogin:          () => invoke('stella_login'),
    stellaLogout:         () => invoke('stella_logout'),
    stellaRoomInteraction:    (roomId) => invoke('stella_room_interaction', { roomId: Number(roomId) }),
    stellaSetRoomInteraction: (roomId, kind, on) => invoke('stella_set_room_interaction', { roomId: Number(roomId), kind, on }),
    stellaRoomPlayers:    (roomId) => invoke('stella_room_players', { roomId: Number(roomId) }),
    stellaTokens:         () => invoke('stella_tokens'),
    stellaCheeredPhotos:  (ids) => invoke('stella_cheered_photos', { ids: ids.map(Number) }),
    stellaSetPhotoCheer:  (photoId, on) => invoke('stella_set_photo_cheer', { photoId: Number(photoId), on }),
    stellaJoinCheck:      (playerId, roomId) => invoke('stella_join_check', { playerId: Number(playerId), roomId: Number(roomId) || 0 }),
    stellaRequestJoin:    (playerId) => invoke('stella_request_join', { playerId: Number(playerId) }),
    stellaAskToJoin:      (playerId) => invoke('stella_ask_to_join', { playerId: Number(playerId) }),
    stellaNotifications:  () => invoke('stella_notifications'),
    vanillaAuthStatus:    () => invoke('vanilla_auth_status'),
    vanillaAccount:       () => invoke('vanilla_account'),
    vanillaNotifications: () => invoke('vanilla_notifications'),
    vanillaRoomCheered:      (roomId)        => invoke('vanilla_room_cheered', { roomId }),
    vanillaSetRoomCheer:     (roomId, cheer) => invoke('vanilla_set_room_cheer', { roomId, cheer }),
    vanillaCheeredPhotos:    ()              => invoke('vanilla_cheered_photos'),
    vanillaTogglePhotoCheer: (photoId)       => invoke('vanilla_toggle_photo_cheer', { photoId: String(photoId) }),
    vanillaSubscribed:       (playerId)      => invoke('vanilla_subscribed', { playerId }),
    vanillaSetSubscribed:    (playerId, subscribe) => invoke('vanilla_set_subscribed', { playerId, subscribe }),
    vanillaJoinRoom:         (roomId)        => invoke('vanilla_join_room', { roomId }),
    vanillaCurrentRoom:      ()              => invoke('vanilla_current_room'),
    // Background (tray) and start with Windows.
    getAutostart: ()        => invoke('get_autostart'),
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),
    onLauncherHidden: async (cb) => {
      if (unlistenMap['launcher-hidden']) unlistenMap['launcher-hidden']();
      unlistenMap['launcher-hidden'] = await listen('launcher-hidden', () => cb());
    },
    setTrayState: (network, gameRunning, style) => invoke('set_tray_state', { network, gameRunning, style }),
    showLauncher: () => invoke('show_launcher'),
    onTrayAction: async (cb) => {
      if (unlistenMap['tray-action']) unlistenMap['tray-action']();
      unlistenMap['tray-action'] = await listen('tray-action', (event) => cb(event.payload));
    },

    // Desktop notification pop-up (a separate always-on-top window).
    desktopNotify:     (cards) => invoke('desktop_notify', { cards }),
    onDesktopNotifOpen: async (cb) => {
      if (unlistenMap['desktop-notif-open']) unlistenMap['desktop-notif-open']();
      unlistenMap['desktop-notif-open'] = await listen('desktop-notif-open', (event) => cb(event.payload));
    },
    stellaFriends:      () => invoke('stella_friends'),
    stellaFriendsStop:  () => invoke('stella_friends_stop'),
    stellaSetInUse: (inUse) => {
      inUseSent = inUseSent.then(() => rawInvoke('stella_set_in_use', { inUse })).catch(() => {});
      return inUseSent;
    },
    stellaPresence:     (playerId) => invoke('stella_presence', { playerId: Number(playerId) }),
    onStellaFriends: async (cb) => {
      if (unlistenMap['stella-friends-changed']) unlistenMap['stella-friends-changed']();
      unlistenMap['stella-friends-changed'] = await listen('stella-friends-changed', () => cb());
    },
    onStellaMessage: async (cb) => {
      if (unlistenMap['stella-message']) unlistenMap['stella-message']();
      unlistenMap['stella-message'] = await listen('stella-message', () => cb());
    },
    onStellaInvite: async (cb) => {
      if (unlistenMap['stella-invite']) unlistenMap['stella-invite']();
      unlistenMap['stella-invite'] = await listen('stella-invite', (event) => cb(event.payload));
    },
    onStellaJoinRequest: async (cb) => {
      if (unlistenMap['stella-join-request']) unlistenMap['stella-join-request']();
      unlistenMap['stella-join-request'] = await listen('stella-join-request', (event) => cb(event.payload));
    },
    onVanillaAuth: async (cb) => {
      if (unlistenMap['vanilla-auth-changed']) unlistenMap['vanilla-auth-changed']();
      unlistenMap['vanilla-auth-changed'] = await listen('vanilla-auth-changed', (event) => cb(event.payload));
    },

    // Window state events
    onWindowMaximizedState: async (cb) => {
      if (unlistenMap['window-maximized-state']) unlistenMap['window-maximized-state']();
      unlistenMap['window-maximized-state'] = await listen('window-maximized-state', (event) => cb(event.payload));
    },

    // Logs and bug reports (logs.js)
    logPrevious:       () => invoke('log_previous'),
    logOpenFolder:     () => invoke('log_open_folder'),
    logSave:           (text, fileName) => invoke('log_save', { text, fileName }),
    bugReportPreview:  (diagnostics, logs) => invoke('bug_report_preview', { diagnostics, logs }),
    bugReportCooldown: () => invoke('bug_report_cooldown'),
    submitBugReport:   (report) => invoke('submit_bug_report', { report }),
  };
})();

// App state variables
let config                = {};
let isGameRunning         = false;
let isGameLaunching       = false;
// Set while a launch started from the tray is under way; see playFromTray().
let revealOnModal         = false;
let revealOnModalTimer    = null;
let isDownloading         = false;
// Cancel requested, but the backend loop only aborts at its next chunk and
// holds a global "download in progress" guard until it exits. Re-enabling
// Download before then makes the next click fail with "A download is already
// in progress.", so the button stays disabled through this window.
let isCancelling          = false;
let isPaused              = false;
// 'verify' or 'repair' while Verify Files is using the download panel (and
// `isDownloading`, so everything a download blocks, it blocks too). 'repair'
// covers both a repair that fetches single files and one that has to download
// the whole client. See runVerifyFiles().
let clientTask            = null;
// Whether the running download can be paused and resumed; see updateDlProgress().
// False until the backend has the server's answer, so Pause never shows for a
// moment on a download that turns out not to be able to pause (Stella's).
let dlResumable           = false;
let isInstalled           = false;
// The client is there but missing files, its executable among them (deleted,
// or quarantined by an antivirus). The hero offers REPAIR, which runs Verify
// Files, instead of a fresh download. See check_install's `needsRepair`.
let needsRepair           = false;
// Stella's patch: the last stella_patch_status result (null until one has run
// since the client was found), and whether an UPDATE is running.
let stellaPatch           = null;
let stellaPatchUpdating   = false;
// Where Stella keeps its patch (from checkInstall); outside the client folder.
let stellaPatchDir        = '';
let playMode              = 'screen';
let launchAfterExclusion  = false;
let sacWarnedThisSession  = false;
// Last-known reachability from checkServerStatus(), surfaced in bug reports.
// null = not checked yet this session.
let lastServerStatus      = { apiOnline: null, cdnOnline: null };

// ── Image load handling ──────────────────────────────────────────────────
// Every thumbnail in the app wants the same two things: drop the shimmer class
// once it resolves, and swap to a local placeholder if it 404s. That used to be
// an `onload`/`onerror` attribute on each `<img>`, which forced the CSP to allow
// `script-src 'unsafe-inline'` — and with inline script permitted, any HTML
// injection anywhere becomes code execution inside a webview that can reach
// every backend command.
//
// `load` and `error` don't bubble, but they do reach document in the capture
// phase, so one pair of listeners covers every image including ones added
// later. Images opt into a fallback with `data-fallback`.
function handleImageSettled(e) {
  const el = e.target;
  if (!(el instanceof HTMLImageElement)) return;
  el.classList.remove('image-loading-placeholder');
  if (e.type !== 'error') return;

  const fallback = el.dataset.fallback;
  if (!fallback) return;
  // Cleared before assigning, so a fallback that is itself missing fires this
  // once and stops rather than looping.
  delete el.dataset.fallback;
  el.src = fallback;
}
document.addEventListener('load', handleImageSettled, true);
document.addEventListener('error', handleImageSettled, true);

// ── Image sources ────────────────────────────────────────────────────────
// The two networks serve images differently. Radium exposes a resizing CDN
// addressed by image *name* (`img.radie.app/<name>?width=N`); Vanilla returns a
// ready-made absolute URL that must be used verbatim, because some already
// carry a cachebuster query and its endpoint does no resizing. The backend
// normalizer attaches that URL as ThumbUrl / AvatarUrl, so the presence of
// those fields is what decides which form to use — Radium payloads simply
// don't have them and fall through to the existing behaviour.
const RADIUM_IMG_BASE = 'https://img.radie.app';

/// Base URL of the launcher's thumbnail cache.
///
/// Tauri serves a custom scheme as `http://<scheme>.localhost` on Windows and
/// `<scheme>://localhost` everywhere else. Rather than sniff the platform, ask
/// Tauri how it rewrites the asset protocol and take the same shape — the
/// backend reads only the query, so the host and path don't have to match.
const THUMB_BASE = (() => {
  try {
    // Hands back the fully-formed origin for this platform with the path we
    // passed on the end, which is exactly the shape we want — and it keeps
    // working if Tauri ever changes how it rewrites schemes.
    const built = window.__TAURI_INTERNALS__.convertFileSrc('thumb', 'radiumimg');
    if (built) return built;
  } catch (e) { /* fall through */ }
  return navigator.userAgent.includes('Windows')
    ? 'http://radiumimg.localhost/thumb'
    : 'radiumimg://localhost/thumb';
})();

/// Point an `<img>` at the launcher's thumbnail cache instead of the origin.
///
/// The backend fetches the image once, scales it to `width` and keeps the
/// result on disk. This matters most on Vanilla, which serves room images as
/// the file the game uploaded: measured 2026-09-09, a room thumbnail is a
/// 2560x1440 PNG of about 3 MB — drawn in a card roughly 200 px wide. Twelve of
/// those is ~35 MB off the network and well over a hundred megabytes of decoded
/// bitmap, and since the responses carry no cache headers whatsoever it was
/// paid again on every single visit to the tab.
///
/// `width` is the size the element is drawn at in CSS pixels. It is multiplied
/// by the display's pixel ratio here, in one place, so every caller can name
/// the size from its own stylesheet and not think about it. Windows defaults to
/// 125% or 150% scaling on most laptops, and asking for a 480 px image to fill
/// a 480 px box on a 1.5x screen is a 1.5x upscale — which reads as a blurry
/// thumbnail, not as a scaling setting.
///
/// Local paths (`./images.png`) and anything that isn't http(s) come back
/// untouched — there is nothing to fetch or shrink.
function thumbSrc(url, width) {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  return `${THUMB_BASE}?url=${encodeURIComponent(url)}&w=${devicePx(width)}`;
}

/// Device pixels for a size given in CSS pixels.
///
/// Clamped at 3 so an unusual display setting can't turn a thumbnail request
/// into a demand for an enormous image. Shared with the Radium CDN URLs below,
/// which name their own size in the query string: asking the CDN for 96 px and
/// then asking the thumbnail cache for 144 got a 96 px image stretched to 144,
/// which is exactly the blur this was meant to remove.
function devicePx(cssWidth) {
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  return Math.round(cssWidth * ratio);
}

/// Source width needed to fill a *square* avatar slot `cssSize` across.
///
/// Every avatar in the app is a square box with `object-fit: cover`, and the
/// pictures behind them are usually not square. Vanilla lets a player use any
/// screenshot as a profile picture, and most are 16:9 — measured 2026-09-10,
/// two of three sampled profile pictures were 2560x1440, and only one was a
/// square 256x256. Cover crops to the shorter side, so a 16:9 source
/// contributes just 9/16 of its width to a square slot: sizing the request by
/// the slot's width gets a picture that is sharp in a landscape card and
/// visibly soft here. Square or portrait sources need less than this, and are
/// over-asked for slightly rather than the common case being under-asked.
const AVATAR_SOURCE_ASPECT = 16 / 9;
function avatarWidth(cssSize) {
  return Math.round(cssSize * AVATAR_SOURCE_ASPECT);
}

/// Where a room's image really lives, before the thumbnail cache. Used
/// directly only where the full-resolution original is the point.
function roomSourceUrl(room, width) {
  if (!room) return './images.png';
  if (room.ThumbUrl) return room.ThumbUrl;
  const name = room.ImageName || room.imageName || '';
  return name ? `${RADIUM_IMG_BASE}/${name}?width=${devicePx(width)}` : './images.png';
}

function roomThumbUrl(room, width) {
  return thumbSrc(roomSourceUrl(room, width), width);
}

/// Format a count the way the room cards and detail view show it.
function formatCount(n) {
  return Number(n).toLocaleString();
}

/// Cheers / favourites / visits already present on a room row, or null.
///
/// Both networks send these with the list — `vanilla::room_row_json` builds
/// them from the bulk snapshot, and Radium's rooms endpoint carries the same
/// PascalCase fields. A row that has them needs no per-card lookup at all.
/// Null (rather than zero) when the row is missing them entirely, so the caller
/// can fall back instead of printing a confident 0.
function roomStatsFromRow(room) {
  if (!room) return null;
  const pick = (...names) => {
    for (const name of names) {
      const v = room[name];
      if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  const cheers = pick('CheerCount', 'cheerCount');
  const visits = pick('VisitCount', 'visitCount');
  const favorites = pick('FavoriteCount', 'favoriteCount');
  if (cheers == null && visits == null) return null;
  return {
    cheers: formatCount(cheers ?? 0),
    visits: formatCount(visits ?? 0),
    favorites: favorites == null ? null : formatCount(favorites)
  };
}

/// `fetchRoomWebDetails` with a short-lived memo.
///
/// The underlying call scrapes a full HTML page on Radium. Without this,
/// scrolling a profile's room grid re-fetched the same pages, and reopening a
/// room detail view paid for it again. Keyed by network so switching networks
/// doesn't serve the other one's numbers.
const ROOM_DETAILS_TTL_MS = 5 * 60 * 1000;
const roomDetailsMemo = new Map();

async function getRoomWebDetails(roomName) {
  const key = `${activeNetwork}:${roomName}`;
  const hit = roomDetailsMemo.get(key);
  if (hit && Date.now() - hit.at < ROOM_DETAILS_TTL_MS) return hit.value;

  const value = await window.radium?.fetchRoomWebDetails(roomName);
  // Only successes are cached: a failed lookup should be retried, not
  // remembered for five minutes.
  if (value && value.success) {
    // Bounded, so a long session browsing rooms can't grow this without limit.
    if (roomDetailsMemo.size > 300) roomDetailsMemo.clear();
    roomDetailsMemo.set(key, { value, at: Date.now() });
  }
  return value;
}

/// See [roomSourceUrl].
function photoSourceUrl(photo, width) {
  if (!photo) return './images.png';
  if (photo.ThumbUrl) return photo.ThumbUrl;
  const name = photo.ImageName || photo.imageName || '';
  return name ? `${RADIUM_IMG_BASE}/${name}?width=${devicePx(width)}` : './images.png';
}

function photoImageUrl(photo, width) {
  return thumbSrc(photoSourceUrl(photo, width), width);
}

/// A person with no picture, or whose picture failed to load: the orange
/// outline mark, centred on a transparent square so a slot's cover crop never
/// clips it. What used to stand in here was images.png, which is the Radium
/// logo: on Vanilla every player without a picture, and every desktop pop-up,
/// wore Radium's brand.
const PLACEHOLDER_AVATAR = './assets/default-avatar.png';

/// Placeholder avatar for a network. Radium has a real DefaultProfileImage on
/// its CDN; Vanilla has no such asset, so it gets the bundled one.
function defaultAvatarUrl(width) {
  if (activeNetwork !== 'radium') return PLACEHOLDER_AVATAR;
  return thumbSrc(`${RADIUM_IMG_BASE}/DefaultProfileImage?width=${devicePx(width)}&cropSquare=1`, width);
}

/// `size` is the width of the square slot in CSS pixels, not the width of the
/// image to fetch — see [avatarWidth], which is what turns one into the other.
function personAvatarUrl(person, size) {
  if (!person) return defaultAvatarUrl(size);
  // Vanilla hands back the picture at whatever shape the player uploaded, so
  // the cover crop has to be paid for.
  if (person.AvatarUrl) return thumbSrc(person.AvatarUrl, avatarWidth(size));
  const name = person.profileImage || '';
  if (!name || name === 'DefaultProfileImage') return defaultAvatarUrl(size);
  // Radium's CDN crops to a square itself (`cropSquare=1`), so what comes back
  // already fills the slot and its width is the slot's width.
  return thumbSrc(`${RADIUM_IMG_BASE}/${name}?width=${devicePx(size)}&cropSquare=1`, size);
}

// ── Network photo feed ───────────────────────────────────────────────────
// Vanilla publishes a network-wide feed of the photos players are taking right
// now — the same thing its website's front page shows. Radium has no such tab
// by request, so the nav button is hidden there.

let feedSkip = 0;
const feedTake = 12;
let feedLoading = false;
let feedHasMore = false;
let feedObserver = null;
let feedSequenceId = 0;

/// Point a card's creator and room at real people/places, once known.
///
/// Split out because attribution arrives two different ways: embedded in the
/// photo row (Vanilla), or from a per-photo lookup (Radium). Both end here, so
/// the card behaves identically whichever way it was filled.
function applyPhotoAttribution(card, { creatorName, creatorUsername, roomName, avatar }) {
  const creatorEl = card.querySelector('.creator-name');
  if (creatorEl) {
    creatorEl.textContent = creatorName || 'Unknown Creator';
    const profile = creatorUsername || creatorName;
    if (profile && profile !== 'Unknown' && profile !== 'Unknown Creator') {
      creatorEl.addEventListener('click', (e) => {
        e.stopPropagation();
        showCreatorProfile(profile);
      });
    }
  }

  const roomEl = card.querySelector('.room-link');
  if (roomEl) {
    if (roomName && roomName.toLowerCase() !== 'none') {
      roomEl.textContent = roomName;
      roomEl.addEventListener('click', (e) => {
        e.stopPropagation();
        showRoomByName(roomName);
      });
    } else {
      // Drop the whole "in <room> •" run rather than leaving a dangling label.
      roomEl.previousElementSibling?.remove();
      roomEl.nextElementSibling?.remove();
      roomEl.remove();
    }
  }

  if (avatar) {
    const avatarEl = card.querySelector('.creator-avatar');
    if (avatarEl) {
      avatarEl.classList.add('image-loading-placeholder');
      avatarEl.src = thumbSrc(avatar, avatarWidth(36));
    }
  }
}

/// A photo as a square thumbnail, for the grid on a player's profile. Opens
/// the photo page, where the uploader, room, caption and cheers are.
function buildPhotoTile(photo, backToView) {
  const tile = document.createElement('div');
  tile.className = 'profile-photo-tile';
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  const caption = String(photo.Description || photo.description || '').trim();
  tile.setAttribute('aria-label', caption ? `Photo: ${caption}` : 'Photo');

  const img = document.createElement('img');
  img.className = 'image-loading-placeholder';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.dataset.fallback = './images.png';
  img.src = photoImageUrl(photo, 400);
  tile.appendChild(img);

  const open = () => showPhotoDetails(photo, backToView);
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return tile;
}

/// Build one feed card from a photo row.
///
/// The single renderer behind the FEED tab, a room's photos and a player's
/// feed — those used to carry their own copies of this markup. (A player's
/// photos are thumbnails: buildPhotoTile().)
///
/// Vanilla embeds the uploader, room and tagged players in every row, so the
/// card is complete on first paint. Radium's rows carry none of that, so the
/// card paints with a placeholder and fills itself in from the per-photo
/// lookup in the background.
function buildPhotoCard(photo, backToView) {
  const card = document.createElement('div');
  card.className = 'feed-post-card';

  // Coerced to numbers — these are interpolated into innerHTML below.
  const cheers = Number(photo.CheerCount ?? photo.cheerCount) || 0;
  const comments = Number(photo.CommentCount ?? photo.commentCount) || 0;
  // Vanilla has no comment count at all, so the stat is omitted rather than
  // shown as a hardcoded zero.
  const hasComments = (photo.CommentCount ?? photo.commentCount) != null;
  const caption = photo.Description || photo.description || '';
  const embedded = !!photo.CreatorUsername;
  const creator = photo.CreatorDisplayName || photo.CreatorUsername || '';
  const roomName = photo.RoomName || '';
  // On Vanilla and Stella the count is the cheer button, as on vanillarec.net.
  const cheerable = photoCheerable(photo);

  let dateStr = '';
  const createdAt = photo.CreatedAt || photo.createdAt;
  if (createdAt) {
    try { dateStr = relativeTime(createdAt); } catch (e) { dateStr = String(createdAt); }
  }

  // Whoever else is in the shot, minus the uploader (already named above).
  const tagged = (photo.TaggedPlayers || [])
    .filter(p => p.userName && p.userName !== photo.CreatorUsername);

  card.innerHTML = `
    <div class="feed-post-header">
      <img class="feed-post-avatar creator-avatar image-loading-placeholder"
           src="${escapeHtml(thumbSrc(photo.CreatorAvatarUrl, avatarWidth(36)) || defaultAvatarUrl(36))}"
           loading="lazy" decoding="async"
           data-fallback="${PLACEHOLDER_AVATAR}" />
      <div class="feed-post-header-text">
        <div class="feed-post-creator creator-name">${escapeHtml(embedded ? creator : 'Loading...')}</div>
        <div class="feed-post-meta">
          <span>in</span>
          <span class="feed-post-room room-link">${escapeHtml(embedded ? roomName : 'Loading...')}</span>
          <span class="feed-post-dot">•</span>
          <span class="feed-post-time">${escapeHtml(dateStr)}</span>
        </div>
      </div>
    </div>
    ${caption ? `<div class="feed-post-description">${escapeHtml(caption)}</div>` : ''}
    <div class="feed-post-image-wrap image-wrap">
      <img class="feed-post-image image-loading-placeholder"
           src="${escapeHtml(photoImageUrl(photo, 800))}"
           loading="lazy" decoding="async"
           data-fallback="./images.png" />
    </div>
    ${tagged.length ? `<div class="feed-post-tagged"><span class="feed-tagged-label">In this photo:</span></div>` : ''}
    <div class="feed-post-footer">
      ${cheerable ? '' : `<span class="feed-post-stat"><span class="cheers-count">${cheers}</span> Cheers</span>`}
      ${hasComments ? `<span class="feed-post-stat"><span class="comments-count">${comments}</span> Comments</span>` : ''}
    </div>
  `;

  card.querySelector('.image-wrap')?.addEventListener('click', () => {
    showPhotoDetails(photo, backToView);
  });

  if (cheerable) card.querySelector('.feed-post-footer')?.prepend(buildCardCheer(photo));

  // Names are attached as elements, not interpolated markup, so a display name
  // containing quotes can't break out of a JS string context.
  const taggedEl = card.querySelector('.feed-post-tagged');
  if (taggedEl) {
    tagged.forEach(p => {
      const link = document.createElement('span');
      link.className = 'feed-tagged-name';
      link.textContent = p.displayName || p.userName;
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        showCreatorProfile(p.userName);
      });
      taggedEl.appendChild(link);
    });
  }

  if (embedded) {
    applyPhotoAttribution(card, {
      creatorName: creator,
      creatorUsername: photo.CreatorUsername,
      roomName,
      avatar: photo.CreatorAvatarUrl
    });
  } else {
    // Resolved in the background so the grid paints immediately.
    (async () => {
      const details = await getPhotoWebDetails(photo.Id || photo.id, photo);
      if (!details?.success) {
        applyPhotoAttribution(card, { creatorName: 'Unknown Creator', roomName: '' });
        return;
      }
      const name = details.creatorUsername || 'Unknown';
      // Prefer the avatar that came with the photo: it is keyed on the
      // uploader's id, whereas a username lookup can land on a different
      // account that happens to match the name.
      const avatar = details.creatorAvatar
        || (name !== 'Unknown' ? (await getUserWebDetails(name))?.avatar : '');
      applyPhotoAttribution(card, {
        creatorName: name,
        creatorUsername: name,
        roomName: details.roomName || '',
        avatar
      });
    })();
  }

  return card;
}

/// "3m ago" / "2h ago", falling back to an absolute date past half a day —
/// the same cutoff vanillarec.net uses, so the two read alike.
function relativeTime(timestamp) {
  const then = new Date(timestamp).getTime();
  if (isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const diffHours = diffMs / 3600000;
  if (diffHours >= 0 && diffHours < 12) {
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(diffHours)}h ago`;
  }
  return new Date(then).toLocaleString();
}

async function loadFeed(append = false, { refresh = false } = {}) {
  const grid = $('feedGrid');
  const empty = $('feedEmptyMsg');
  if (!grid || feedLoading) return;
  // Guard here rather than only at the observer, so no caller can append past
  // the end of the feed and duplicate the last page.
  if (append && !feedHasMore) return;

  feedSequenceId++;
  const seq = feedSequenceId;

  if (!append) {
    feedSkip = 0;
    feedHasMore = false;
    grid.innerHTML = '<div id="feedLoading" class="feed-loading">Loading feed...</div>';
    if (empty) empty.style.display = 'none';
  } else {
    const more = document.createElement('div');
    more.id = 'feedLoading';
    more.className = 'feed-loading';
    more.textContent = 'Loading more...';
    grid.appendChild(more);
  }

  feedLoading = true;
  let res = null;
  try {
    // `refresh` reaches the backend, which holds the recent-photo list briefly
    // so paging on scroll doesn't re-download the pages already on screen.
    // Pressing Refresh has to go past that or it would show the same photos.
    res = await window.radium?.fetchRecentPhotos({ skip: feedSkip, take: feedTake, refresh: refresh && !append });
  } catch (e) {
    console.error('loadFeed error:', e);
  }
  feedLoading = false;

  // A network switch (or a refresh) started a newer load; drop this response.
  if (seq !== feedSequenceId) return;

  $('feedLoading')?.remove();

  if (!res?.success || !res.data?.Results) {
    if (!append) {
      grid.innerHTML = '';
      if (empty) {
        empty.textContent = `Couldn't load the feed: ${res?.error || 'unknown error'}`;
        empty.style.display = 'block';
      }
    }
    feedHasMore = false;
    return;
  }

  const photos = res.data.Results;
  if (!append) grid.innerHTML = '';

  photos.forEach(photo => grid.appendChild(buildPhotoCard(photo, 'feed')));

  feedSkip += photos.length;
  feedHasMore = photos.length === feedTake;

  if (!append && photos.length === 0 && empty) {
    empty.textContent = 'No recent photos.';
    empty.style.display = 'block';
  }

  setupFeedObserver();
}

/// Page in the next batch when the sentinel below the list scrolls into view.
function setupFeedObserver() {
  const sentinel = $('feedSentinel');
  const root = $('feedScroll');
  if (!sentinel || !root) return;
  if (feedObserver) feedObserver.disconnect();

  feedObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && feedHasMore && !feedLoading) {
      loadFeed(true);
    }
  }, {
    root,
    // The sentinel is 1px tall and sits flush with the bottom of the scroller,
    // so with no margin it lands exactly on the root's edge and can report a
    // zero ratio. The margin both fixes that and starts the next page a screen
    // early, so scrolling doesn't stall waiting for it.
    rootMargin: '400px 0px',
    threshold: 0
  });
  feedObserver.observe(sentinel);
}

/// Drop feed state — used when switching networks, since the photos belong to
/// the network that was active when they loaded.
function resetFeed() {
  feedSequenceId++;
  feedSkip = 0;
  feedHasMore = false;
  feedLoading = false;
  if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
  const grid = $('feedGrid');
  if (grid) grid.innerHTML = '';
  const empty = $('feedEmptyMsg');
  if (empty) empty.style.display = 'none';
}

/// Staff roles a network reports for a player, most senior first.
///
/// Read from the API's own booleans rather than a bundled list of names, so it
/// stays correct as staff change. Radium's scraper exposes no equivalent, so
/// this is empty there and nothing renders.
/// Vanilla's owners. The API has no owner flag — the site's own badge list
/// (badgeConfig.js) names them by hand — so this mirrors it: Coach (1), Nilla
/// (2), liam (3). Founders, so it changes about never; update if the site's
/// owner list does.
const VANILLA_OWNER_IDS = new Set([1, 2, 3]);

/// A player's staff roles, most senior first. `key` names both the badge icon
/// file and its CSS class; `short` is the retro text chip; `full` is the label.
function playerRoles(person) {
  if (!person) return [];
  const roles = [];
  // Owner is Vanilla-only: the id list means different people on another
  // network, and the badge art is Vanilla's own.
  if (activeNetwork === 'vanilla' && VANILLA_OWNER_IDS.has(Number(person.id))) {
    roles.push({ key: 'owner', short: 'OWNER', full: 'Owner' });
  }
  if (person.isDeveloper)     roles.push({ key: 'developer',     short: 'DEV',  full: 'Developer' });
  if (person.isModerator)     roles.push({ key: 'moderator',     short: 'MOD',  full: 'Moderator' });
  if (person.isCommunityTeam) roles.push({ key: 'communityTeam', short: 'TEAM', full: 'Community Team' });
  return roles;
}

/// Render a player's roles into `el`, hiding it when they have none.
///
/// Vanilla wears its own badge icons (the bronze marks from its site); every
/// other network keeps the plain coloured text chip, since the icons are
/// Vanilla-branded and mean nothing elsewhere.
function renderPlayerRoles(el, person) {
  if (!el) return;
  const roles = playerRoles(person);
  el.innerHTML = '';
  el.hidden = roles.length === 0;
  const useIcons = activeNetwork === 'vanilla';
  roles.forEach(role => {
    let badge;
    if (useIcons) {
      badge = document.createElement('img');
      badge.className = `role-badge role-icon role-${role.key.toLowerCase()}`;
      badge.src = `assets/badges/${role.key}.svg`;
      badge.alt = role.full;
      badge.draggable = false;
    } else {
      badge = document.createElement('span');
      badge.className = `role-badge role-${role.short.toLowerCase()}`;
      badge.textContent = role.short;
    }
    // A screen-reader name, not a `title`: hover tooltips are off app-wide.
    badge.setAttribute('aria-label', role.full);
    el.appendChild(badge);
  });
}

/// Fill one profile stat tile, hiding it entirely when the network doesn't
/// publish that number.
///
/// An empty value means "this network has no such stat" — Vanilla's player
/// record carries only a follower count, with no friend or visit figure
/// anywhere in its API. Showing those as a blank box implies a real value of
/// zero (or a bug), so the tile is removed and the remaining ones take the
/// space. A dash is different and stays visible: it means the stat exists but
/// the lookup failed.
function setProfileStat(el, value) {
  if (!el) return;
  const tile = el.closest('.profile-stat-item');
  const known = value !== '' && value != null;
  el.textContent = known ? value : '';
  if (tile) tile.hidden = !known;
}

/// The profile's bio: shown in the player's own words, and left out
/// altogether when they wrote none, rather than a box saying so.
function setProfileBio(text) {
  const el = $('peopleDetailBio');
  if (!el) return;
  const bio = String(text ?? '').trim();
  el.textContent = bio;
  const box = el.closest('.profile-bio-box');
  if (box) box.hidden = !bio;
}

/// "Jun 2026" for when an account was made, or '' for none (some old
/// accounts carry a placeholder year 1). English, as the rest of the UI is.
function joinedLabel(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return '';
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/// Backdrop for a profile header.
///
/// Vanilla has no per-user banner — its own site paints every profile with one
/// shared pattern — so the launcher uses that same pattern rather than leaving
/// the header blank. Radium keeps its themed gradient, which a scraped banner
/// then overrides where one exists.
function defaultProfileBanner() {
  if (activeNetwork === 'vanilla') return "url('assets/vanilla-pattern.png')";
  // Stella has no default banner image of its own, so it gets the Stella Home
  // hero: the logo on its maroon glow (style.css, .home-hero-art).
  if (activeNetwork === 'stella') {
    return "url('assets/stella-logo.png'), radial-gradient(ellipse at 50% 30%, #5a1a13 0%, #300c08 55%, #1a0604 100%)";
  }
  return 'linear-gradient(135deg, var(--green-dim), var(--green))';
}

/// `background-size` for [defaultProfileBanner]'s layers: Stella's logo is
/// drawn at a fixed share of the banner's height rather than covering it.
function defaultProfileBannerSize() {
  return activeNetwork === 'stella' ? 'auto 58%, cover' : 'cover';
}

/// Full-resolution avatar for the lightbox.
function personAvatarFullUrl(person) {
  if (person?.AvatarUrl) return person.AvatarUrl;
  const name = person?.profileImage || '';
  if (!name || name === 'DefaultProfileImage') {
    return activeNetwork === 'radium'
      ? `${RADIUM_IMG_BASE}/DefaultProfileImage`
      : PLACEHOLDER_AVATAR;
  }
  return `${RADIUM_IMG_BASE}/${name}`;
}

// DOM shortcuts
const $ = id => document.getElementById(id);

/// What the backdrop field shows while the backdrop is a stored picture — a
/// picked file or a downloaded address. The data: URI itself would be up to
/// 1.4 MB of text in an input, which freezes it.
const SAVED_BACKDROP_LABEL = '(Saved picture)';

function setBgImageUI(val) {
  const el = $('theme-bgImage');
  if (!el) return;
  if (val && val.startsWith('data:image/')) {
    el.dataset.savedPicture = '1';
    el.value = SAVED_BACKDROP_LABEL;
  } else {
    delete el.dataset.savedPicture;
    el.value = val || '';
  }
}

// Formatting utility helpers
function formatBytes(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1048576)     return `${(b/1024).toFixed(1)} KB`;
  if (b < 1073741824)  return `${(b/1048576).toFixed(1)} MB`;
  return `${(b/1073741824).toFixed(2)} GB`;
}
function formatEta(secs) {
  if (secs < 0 || !isFinite(secs)) return '—';
  if (secs < 60)   return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.round(secs%60)}s`;
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
}

// Notification toasts
function toast(msg, type = 'info', ms = 3200) {
  const c = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

// Tab routing switch.
//
// Scoped to the nav itself: `.nav-btn` is also worn by the network switcher and
// its menu options, purely so they inherit each theme's button styling. Those
// carry no data-tab and must not take part in tab routing — or in the
// deactivate sweep below, which would strip the selected network's highlight.
document.querySelectorAll('.sidebar-nav .nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-nav .nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tabName = btn.dataset.tab;
    const p = $('tab-' + tabName);
    if (p) p.classList.add('active');

    // Lazy load data when switching tabs — but only data we don't already have.
    // Coming back to a tab you were just on now shows what was there, which is
    // both instant and where you left off; a page older than LIST_STALE_MS is
    // refreshed underneath the rows rather than in place of them.
    if (tabName === 'rooms') {
      loadFilters();
      if (!listIsFresh(roomsKey(), roomsRenderKey, roomsRenderAt)) loadRooms();
    } else if (tabName === 'people') {
      if (!listIsFresh(peopleKey(), peopleRenderKey, peopleRenderAt, peopleFreshMs)) loadPeople();
      // The table is already rendered, but its height is measured against a
      // panel that was display:none until a moment ago.
      else snapTableRows($('peopleTableContainer'));
    } else if (tabName === 'feed') {
      // Only reload an empty feed, so returning to the tab keeps your place
      // in the list instead of jumping back to the top.
      if (!$('feedGrid')?.children.length) loadFeed();
    } else if (tabName === 'friends') {
      refreshStellaFriends();
    }
  });
});

// Titlebar actions
$('btnMinimize')?.addEventListener('click', () => window.radium?.minimize());
$('btnMaximize')?.addEventListener('click', () => window.radium?.maximize());
$('btnClose')?.addEventListener('click',    () => window.radium?.close());

window.radium?.onWindowMaximizedState((isMaximized) => {
  const btn = $('btnMaximize');
  if (btn) {
    btn.innerHTML = isMaximized ? '❐' : '▢';
    btn.setAttribute('aria-label', isMaximized ? 'Restore' : 'Maximize');
  }
});

// Sidebar logo image load failure fallback
const logoImg = $('sidebarLogo');
if (logoImg) {
  logoImg.addEventListener('error', () => {
    const combo = $('logoCombo');
    if (combo) combo.style.display = 'none';
    const lf = $('logoFallback'); if (lf) lf.style.display = 'flex';
  });
}

// The launcher's own version. Not shown in the sidebar: it is written to the
// LOGS tab at startup and sent with a bug report.
let launcherVersion = '';
async function loadVersion() {
  const v = await window.radium?.getVersion();
  if (v) launcherVersion = v;
}

async function loadConfig() {
  config = (await window.radium?.getConfig()) || {};

  // Defaults
  if (!config.apiUrl)   config.apiUrl   = 'https://api.radie.app/';
  if (!config.playMode) config.playMode = 'screen';

  // `=== true`, not `!== false`: minimize-on-launch is off by default now, so
  // a config that predates the field must read as off rather than on.
  setToggle('tgl-minimizeOnLaunch', config.minimizeOnLaunch === true);
  setToggle('tgl-closeOnLaunch',    config.closeOnLaunch    === true);
  setToggle('tgl-autoUpdate',       config.autoUpdate       !== false);
  setToggle('tgl-disableWarnings',   config.disableWarnings   === true);
  setToggle('tgl-runInBackground',   config.runInBackground   !== false);
  syncLaunchOptionLabel();
  refreshAutostartToggle();
  setToggle('tgl-notifPopups',       config.notifPopups       !== false);
  setToggle('tgl-notifSound',        config.notifSound        !== false);

  // Play mode
  playMode = config.playMode || 'screen';
  setModeUI(playMode);
  updateQsMode();

  // Theme. The backend migrates anything unrecognised — including the removed
  // custom theme — before it gets here, so this is always a skin that ships.
  const activeTheme = AVAILABLE_THEMES.includes(config.theme) ? config.theme : DEFAULT_THEME;
  setValue('cfgTheme', activeTheme);

  // Where Stella's friends list shows.
  applyFriendsView();

  // Liquid Glass, which is now an effect over that skin rather than a mode of
  // a custom theme.
  config.glass = config.glass || {};
  const glassOn = config.glass.enabled === true;
  setToggle('tgl-glassEnabled', glassOn);
  // On unless explicitly switched off, matching GlassSettings::default.
  setToggle('tgl-glassFull', config.glass.fullEffects !== false);
  setGlassTintUI(safeColor(config.glass.tint, DEFAULT_GLASS_TINT));
  setBgImageUI(config.glass.bgImage || '');
  updateGlassControls(glassOn);

  applyTheme(activeTheme);

  // A backdrop saved as an address, from before addresses were downloaded:
  // the page could never load it (see paintableBackdrop). Fetched once now and
  // stored as a picture; if that fails it stays as it is, to try again on the
  // next start, and glass keeps its tint meanwhile.
  const savedBackdrop = String(config.glass.bgImage || '').trim();
  if (savedBackdrop.startsWith('https://')) {
    setGlassBackdropFromUrl(savedBackdrop, { quiet: true });
  }

  // Network last, so the brand and capability gating are applied against a
  // fully-loaded config.
  applyNetworkUI(NETWORKS[config.network] ? config.network : 'radium');

  // Both install rows, not just the active network's — after applyNetworkUI so
  // the ACTIVE tag lands on the row the loaded config actually selected.
  await refreshInstallDirRows();
}

/// Marks the body while Liquid Glass is on; every glass rule hangs off it.
const GLASS_CLASS = 'glass-enabled';
/// Set while a backdrop picture is in use: it swaps the tint field out for the
/// picture in `--lg-backdrop`. See `skins/11-glass.css`.
const GLASS_IMAGE_CLASS = 'glass-has-image';
/// Full glass effects, on by default. Off gives the lighter look for weak GPUs.
const GLASS_FULL_CLASS = 'glass-full';

/// Enable or grey out the controls that only mean something under glass, and
/// grey out Active Skin in the other direction while glass has taken over from
/// it.
///
/// The tint and the backdrop shape the glass surfaces and do nothing without
/// them, so with glass off they are shown but inert — the same "say why"
/// treatment applies to Active Skin once glass is on: picking a different skin
/// would visibly do nothing, since glass repaints every surface itself.
function updateGlassControls(glassOn) {
  const note = $('glassOffNote');
  if (note) note.hidden = glassOn;
  for (const id of ['theme-glassBg', 'btnResetGlassTint', 'theme-bgImage', 'btnBrowseBgFile', 'btnClearBgImage']) {
    const el = $(id);
    if (el) el.disabled = !glassOn;
  }
  $('glassOptions')?.classList.toggle('is-off', !glassOn);

  const skinSelect = $('cfgTheme');
  if (skinSelect) skinSelect.disabled = glassOn;
  $('activeSkinRow')?.classList.toggle('is-off', glassOn);
  const skinNote = $('activeSkinLockNote');
  if (skinNote) skinNote.hidden = !glassOn;
}

/// A CSS colour that is safe to interpolate into a generated stylesheet.
///
/// Everything here ends up inside a `<style>` element, so a value carrying a
/// `;` or a `}` closes the declaration and opens a rule of its own — which in a
/// webview that can reach every backend command is not a cosmetic problem. The
/// colour pickers are `<input type="color">` and hand back `#rrggbb`, but these
/// same values are read straight from config.json at startup, and that file is
/// editable by hand and shared between people swapping themes.
///
/// `glassBg` and `bgImage` were already checked at their own use sites; the
/// eleven palette variables were the ones that weren't.
///
/// Only the four lengths CSS actually defines — #rgb, #rgba, #rrggbb,
/// #rrggbbaa. A looser `{3,8}` would also admit 5 and 7 digits, which are not
/// colours at all and would land in the sheet as a dead declaration; it would
/// also disagree with `is_hex_color` in config.rs, which repairs them. The two
/// validators have to say the same thing or a value accepted here gets
/// rewritten on the next load.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function safeColor(value, fallback) {
  return HEX_COLOR.test(String(value ?? '').trim()) ? String(value).trim() : fallback;
}

/// Every skin that ships. Mirrors `AVAILABLE_THEMES` in config.rs and the
/// `<option>` list in index.html; a Rust test holds the latter two together.
const AVAILABLE_THEMES = [
  'steam-green', 'steam2010', 'win98', 'win95', 'winxp', 'royalenoir',
  'winvista', 'win7', 'macosclassic', 'macosaqua', 'moderndark',
  'modernlight', 'moderngreen', 'blackandwhite', 'blackandwhite-inverted'
];

/// The skin a fresh install starts on.
const DEFAULT_THEME = 'blackandwhite';

/// The class a skin is stamped as on <body>: `theme-<skin>`, except Modern
/// Neon Dark. `theme-moderndark` is Liquid Glass's layout (GLASS_LAYOUT_THEME
/// below) and style.css keeps those rules exactly as glass needs them, so that
/// skin is drawn under `theme-neondark` instead. Mirrored in boot.js.
function skinClass(skin) {
  return 'theme-' + (skin === 'moderndark' ? 'neondark' : skin);
}

/// The layout Liquid Glass is drawn on.
///
/// Glass has always been rounded: the editor locked the style base to "modern"
/// whenever it was switched on, which added this class. Its own rules assume
/// that geometry — the radii, the panel insets, the pill buttons — so it keeps
/// coming along now that glass is a setting in its own right.
const GLASS_LAYOUT_THEME = 'moderndark';

/// Point Liquid Glass at a tint, a backdrop and the full-effects switch.
///
/// The sheet itself is `skins/11-glass.css`, loaded with the other skins and
/// inert until `glass-enabled` is on <body>. Only these three things about it
/// were ever dynamic, so only these three are set here.
///
/// It used to be an ~80 KB template literal built in this file and injected as
/// a <style> on every applyTheme() call — which is once per keystroke in the
/// backdrop URL field. Each one rebuilt the string, re-parsed the whole sheet,
/// and wrote it to localStorage for boot.js with the backdrop's data: URI
/// inlined, up to 1.4 MB of base64 a keypress.
///
/// Glass overrides every colour token itself, which is why it never depended on
/// the custom palette it used to live next to and why it survived that editor's
/// removal unchanged.
///
/// Modelled on Apple's Liquid Glass rather than on generic glassmorphism, and
/// most of the difference is restraint:
///
/// - Glass needs something behind it. Over a flat near-black tint every blur
///   averages to the same grey and the panels read as dull cards, so without an
///   image the tint is spread into a soft field of colour for them to pick up.
/// - The edge is lit rather than bordered: a hairline that is brightest at two
///   opposite corners and fades along the sides, drawn as a masked gradient
///   ring. A uniform 1px white border is what makes glass look like plastic.
/// - Controls are plain capsules with a light rim. The split top-half gloss and
///   the shine sweeping across on hover were Aqua-era tells.
/// - Only the four framing surfaces blur — the sidebar, the status cards, the
///   settings groups and the download panel. Every blur is redone whenever
///   anything near it repaints, which is heavy on integrated GPUs; everything
///   else is tinted, which over this soft backdrop reads nearly the same.
///
/// Returns what was applied, so [`cacheThemeForBoot`] can hand boot.js the same
/// three values to replay before the first paint.
function applyGlassVars(tint, bgImage, fullEffects = false) {
  const safeGlassBg = safeColor(tint, DEFAULT_GLASS_TINT);
  // Only a stored picture is painted. An https:// address is one the CSP
  // refuses to load (img-src names no remote host), and `glass-has-image`
  // over a picture that never arrives left nothing but a faint scrim over a
  // transparent window — the desktop showing through the launcher. An address
  // is downloaded into a data: URI instead (setGlassBackdropFromUrl); until
  // that lands, glass keeps its tint field.
  const safeBgImage = paintableBackdrop(bgImage);

  const style = document.body.style;
  style.setProperty('--lg-tint', safeGlassBg);
  if (safeBgImage) {
    // A complete `url(...)`, because that is what the stylesheet substitutes.
    // `setProperty` does not escape, but `safeBackdrop` has already refused
    // every character that could close the declaration — and a value the
    // engine still cannot parse is dropped rather than reinterpreted.
    style.setProperty('--lg-backdrop', `url("${safeBgImage}")`);
  } else {
    style.removeProperty('--lg-backdrop');
  }
  document.body.classList.toggle(GLASS_IMAGE_CLASS, !!safeBgImage);
  document.body.classList.toggle(GLASS_FULL_CLASS, !!fullEffects);

  return { tint: safeGlassBg, bgImage: safeBgImage, fullEffects: !!fullEffects };
}

/// A backdrop URL that is safe to interpolate into `url('...')`.
///
/// Mirrors `GlassSettings::sanitize` in config.rs: the two shapes the picker
/// and the URL field produce, and no character that could close the
/// declaration and open a rule of its own.
const BACKDROP_FORBIDDEN = /['"(){}\\]/;
/// Whether a string carries a control character.
///
/// Spelled as a code-point test rather than a regex so the range is legible
/// and carries no escape sequences of its own.
function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function safeBackdrop(value) {
  const url = String(value ?? '').trim();
  if (!url) return '';

  const isData = url.startsWith('data:image/');
  if (!isData && !url.startsWith('https://')) return '';
  if (BACKDROP_FORBIDDEN.test(url) || hasControlChars(url)) return '';
  // A data: URI legitimately contains `;` — the `;base64` marker — so it is
  // exempt from that one character. Nothing else may carry it, since outside a
  // data URI a `;` is what ends the declaration.
  if (!isData && url.includes(';')) return '';
  return url;
}

/// A backdrop the page can actually draw: a safe `data:` picture, or ''.
/// Mirrored in boot.js.
function paintableBackdrop(value) {
  const url = safeBackdrop(value);
  return url.startsWith('data:image/') ? url : '';
}

/// Apply a skin, plus Liquid Glass over it when that is switched on.
///
/// Glass is an effect rather than a skin: it repaints every colour token and
/// brings its own layout, so while it is on it stands in for the selected skin
/// entirely. The dropdown keeps that selection for when it is switched off.
function applyTheme(theme) {
  // Strip only the theme classes and the glass marker. This used to whitelist
  // 'animations-enabled' and drop everything else, which silently wiped
  // unrelated state classes on <body> (e.g. 'client-installed', which gates the
  // PLAY button and the Manage Client panel) every time the theme changed.
  const GLASS_MARKERS = [GLASS_CLASS, GLASS_IMAGE_CLASS, GLASS_FULL_CLASS];
  document.body.className = document.body.className
    .split(' ')
    .filter(c => c && !c.startsWith('theme-') && !GLASS_MARKERS.includes(c))
    .join(' ');

  const skin = AVAILABLE_THEMES.includes(theme) ? theme : DEFAULT_THEME;
  const glass = config.glass || {};
  const glassOn = glass.enabled === true;

  if (glassOn) {
    document.body.classList.add('theme-' + GLASS_LAYOUT_THEME, GLASS_CLASS);
  } else {
    document.body.classList.add(skinClass(skin));
  }

  if (glassOn) {
    cacheThemeForBoot(skin, applyGlassVars(glass.tint, glass.bgImage, glass.fullEffects !== false));
  } else {
    // The variables are left on <body> deliberately — they cost nothing while
    // nothing matches `glass-enabled`, and clearing them would make switching
    // glass back on flash the default tint for a frame.
    cacheThemeForBoot(skin, null);
  }

  // Animations are always on; the setting that could turn them off is gone.
  // The class still gates them in the stylesheet, so it is set here — the
  // className rewrite above keeps it, but boot.js may not have run first.
  document.body.classList.add('animations-enabled');
  try {
    // A leftover 'false' from the old setting would otherwise sit in storage.
    localStorage.removeItem('radium-animations');
  } catch (e) {}

  syncTray();
}

/// Remember enough for boot.js to paint the right thing before the first frame.
///
/// Without this the window renders the base stylesheet until the config arrives
/// over IPC and then snaps to the real skin — a visible flash on every start.
///
/// `glass` is what [`applyGlassVars`] applied, or `null` with glass off. What
/// used to be stored here was the whole generated stylesheet — ~80 KB, plus the
/// backdrop's data: URI inlined — rewritten on every applyTheme() call. Now the
/// sheet is a file the webview caches and only these three values travel.
function cacheThemeForBoot(skin, glass) {
  try {
    localStorage.setItem('radium-theme', skin);
    if (glass) {
      localStorage.setItem('radium-glass', JSON.stringify(glass));
    } else {
      localStorage.removeItem('radium-glass');
    }
    // The pre-1.x key, which held the whole generated sheet. Dropped so an
    // upgrade gives back however many hundred kilobytes it was holding.
    localStorage.removeItem('radium-glass-css');
  } catch (e) {
    // Quota, or a webview with storage disabled. The only cost is the flash
    // this exists to avoid, so there is nothing to report.
  }
}

function setValue(id, val) { const el = $(id); if (el) el.value = val; }

function setToggle(id, val) {
  const el = $(id); if (!el) return;
  if (val) el.classList.add('on'); else el.classList.remove('on');
}
function getToggle(id) { return $(id)?.classList.contains('on') ?? false; }

// "Start with Windows" isn't in config.json: the registry entry is the truth,
// so the switch is read from and written to it directly.
async function refreshAutostartToggle() {
  try {
    setToggle('tgl-launchAtStartup', await window.radium.getAutostart());
  } catch (e) {}
}
$('tgl-launchAtStartup')?.addEventListener('click', async () => {
  const el = $('tgl-launchAtStartup');
  if (el.dataset.pending === 'true') return;
  el.dataset.pending = 'true';
  const want = !getToggle('tgl-launchAtStartup');
  setToggle('tgl-launchAtStartup', want);
  try {
    const now = await window.radium.setAutostart(want);
    setToggle('tgl-launchAtStartup', now);
    addLog(now ? 'Radium Launcher will start with Windows' : 'Radium Launcher will no longer start with Windows', 'info');
  } catch (err) {
    setToggle('tgl-launchAtStartup', !want);
    toast(String(err), 'error');
  } finally {
    el.dataset.pending = 'false';
  }
});

// The first time the window is closed into the tray, say so, once — otherwise
// the launcher just seems to have quit.
const TRAY_HINT_KEY = 'radium-tray-hint-shown';
let trayHintShown = false;
window.radium?.onLauncherHidden?.(() => {
  if (trayHintShown) return;
  // Not when the window stepped aside for a game starting ("Hide launcher
  // when game starts"): a topmost card over a game going full screen can
  // knock it out of full screen, which is why notification pop-ups wait for
  // the game too. The hint keeps for the next time the window is closed.
  if (isGameRunning || isGameLaunching) return;
  try {
    if (localStorage.getItem(TRAY_HINT_KEY)) { trayHintShown = true; return; }
    localStorage.setItem(TRAY_HINT_KEY, '1');
  } catch (e) {}
  trayHintShown = true;
  window.radium.desktopNotify([{
    id: 'tray-hint',
    sender: null,
    icon: 'bell',
    app: 'Radium Launcher',
    style: notifPopStyle(),
    parts: [
      { t: 'Still running in the background. ', b: true },
      { t: 'Open it or quit from the tray icon. You can turn this off in Settings.' },
    ],
  }]).catch(() => {});
});

['tgl-minimizeOnLaunch', 'tgl-closeOnLaunch', 'tgl-autoUpdate', 'tgl-disableWarnings',
 'tgl-runInBackground', 'tgl-notifPopups', 'tgl-notifSound'].forEach(id =>
  $(id)?.addEventListener('click', () => {
    $(id).classList.toggle('on');
    // Minimising and hiding on launch are two answers to the same question,
    // so turning one on turns the other off.
    if (getToggle(id)) {
      if (id === 'tgl-minimizeOnLaunch') setToggle('tgl-closeOnLaunch', false);
      if (id === 'tgl-closeOnLaunch') setToggle('tgl-minimizeOnLaunch', false);
    }
    if (id === 'tgl-runInBackground') syncLaunchOptionLabel();
    autoSaveSettings();
  })
);

/// With tray mode on, closing only hides the window, so the launch option
/// says what it will actually do.
function syncLaunchOptionLabel() {
  const label = $('lblCloseOnLaunch');
  if (!label) return;
  label.textContent = getToggle('tgl-runInBackground')
    ? 'Hide launcher when game starts'
    : 'Close launcher when game starts';
}

/// Persist the theme and glass settings without touching anything else.
///
/// Its own saver rather than a call to autoSaveSettings() so a theme change
/// does not sweep up whatever else the settings form happens to be showing.
async function saveThemeSettings() {
  if (!config || Object.keys(config).length === 0) return; // config not loaded yet
  const updated = {
    ...config,
    theme: config.theme,
    // Kept in step with `theme`: nothing sits underneath a skin any more, but
    // the field still exists and the backend repairs a mismatch, so writing a
    // stale value here would just be undone on the next load.
    baselineTheme: config.theme,
    glass: config.glass
  };
  try {
    const ok = await window.radium?.saveConfig(updated);
    if (ok) config = updated;
  } catch (e) {
    console.warn('saveThemeSettings: failed to persist', e);
  }
}

/// Debounced, for the colour picker — it fires `input` continuously while
/// dragging, and each save is an IPC call plus a config.json write.
let _themeSaveTimer = null;
function debouncedSaveThemeSettings() {
  clearTimeout(_themeSaveTimer);
  _themeSaveTimer = setTimeout(saveThemeSettings, 800);
}

$('cfgFriendsView')?.addEventListener('change', () => {
  config.stella = { ...(config.stella || {}), friendsView: $('cfgFriendsView').value || 'home' };
  applyFriendsView();
  autoSaveSettings();
});

$('cfgTheme')?.addEventListener('change', () => {
  config.theme = $('cfgTheme').value || DEFAULT_THEME;
  applyTheme(config.theme);
  saveThemeSettings();
});

$('tgl-glassEnabled')?.addEventListener('click', () => {
  const glassOn = !getToggle('tgl-glassEnabled');
  setToggle('tgl-glassEnabled', glassOn);
  config.glass = { ...(config.glass || {}), enabled: glassOn };
  updateGlassControls(glassOn);
  applyTheme(config.theme);
  saveThemeSettings();
});

// Full glass effects: on by default; off gives the lighter look for weak GPUs. The row is inert while
// glass itself is off (see .ct-body.is-off), and checked here as well so a
// keyboard or scripted click cannot flip it then either.
$('tgl-glassFull')?.addEventListener('click', () => {
  if (!getToggle('tgl-glassEnabled')) return;
  const full = !getToggle('tgl-glassFull');
  setToggle('tgl-glassFull', full);
  config.glass = { ...(config.glass || {}), fullEffects: full };
  applyTheme(config.theme);
  saveThemeSettings();
});

/// The tint a fresh install starts with. Mirrors `GlassSettings::default` in
/// config.rs.
const DEFAULT_GLASS_TINT = '#0b0c14';

// ─── Glass tint picker ──────────────────────────────────────────────────────
// Drawn by the launcher rather than `<input type="color">`, whose popup is
// Chromium's own white dialog and matched none of the skins.
//
// It also used to be slow to drag: every `input` event rebuilt the whole glass
// stylesheet and wrote it to localStorage. Now a drag is read at most once per
// frame, and each frame only sets `--lg-tint` on <body> — which is all the
// sheet (skins/11-glass.css) ever needed from it. The boot cache is written
// once, after the picker closes, so it gets the final colour.

/// Dark tints that suit the glass field: the default, then a spread of hues.
const TINT_PRESETS = ['#0b0c14', '#1b1036', '#0a1d3f', '#06302e', '#0d2a16', '#3b0f22', '#3a2208', '#2a2b31'];

/// Hue is kept separately from the hex so dragging to grey or black and back
/// does not snap the hue slider to red.
const tintState = { h: 0, s: 0, v: 0, dirty: false };

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as [r, g, b]; alpha is ignored.
/// The short forms are legal tints (safeColor accepts them), and reading their
/// first six characters as `rrggbb` put the picker on the wrong colour.
function hexToRgb(hex) {
  let digits = String(hex).replace(/^#/, '');
  if (digits.length <= 4) digits = [...digits.slice(0, 3)].map(c => c + c).join('');
  const n = parseInt(digits.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex(h, s, v) {
  const channel = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return '#' + [channel(5), channel(3), channel(1)].map(c => c.toString(16).padStart(2, '0')).join('');
}

/// `#abc` or `abcdef`, with or without the hash, as `#aabbcc`; null otherwise.
function parseHexInput(raw) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(raw).trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return '#' + digits.toLowerCase();
}

/// Show a tint on the swatch button, without applying it.
function setGlassTintUI(hex) {
  $('theme-glassBg')?.style.setProperty('--swatch', hex);
}

function syncTintStateFromHex(hex) {
  const { h, s, v } = rgbToHsv(...hexToRgb(hex));
  // A grey carries no hue of its own; keep the one the slider is on.
  if (s > 0 && v > 0) tintState.h = h;
  tintState.s = s;
  tintState.v = v;
}

function paintTintPicker(hex, { syncHexField = true } = {}) {
  const picker = $('tintPicker');
  if (!picker) return;
  const { h, s, v } = tintState;
  picker.style.setProperty('--tint-current', hex);
  picker.style.setProperty('--tint-hue-color', `hsl(${h} 100% 50%)`);

  const svThumb = $('tintSvThumb');
  if (svThumb) {
    svThumb.style.left = `${s * 100}%`;
    svThumb.style.top = `${(1 - v) * 100}%`;
  }
  const hueThumb = $('tintHueThumb');
  if (hueThumb) hueThumb.style.left = `${(h / 360) * 100}%`;

  $('tintSv')?.setAttribute('aria-valuetext', hex.toUpperCase());
  $('tintHue')?.setAttribute('aria-valuenow', String(Math.round(h)));
  if (syncHexField && $('tintHex')) $('tintHex').value = hex.toUpperCase();

  for (const chip of $('tintPresets')?.children || []) {
    chip.classList.toggle('active', chip.dataset.value === hex);
  }
}

/// Live preview: cheap enough to run every frame of a drag.
function previewGlassTint(hex) {
  setGlassTintUI(hex);
  if (config.glass?.tint === hex) return;
  config.glass = { ...(config.glass || {}), tint: hex };
  document.body.style.setProperty('--lg-tint', hex);
  tintState.dirty = true;
  debouncedSaveThemeSettings();
}

function applyTintState(opts) {
  const hex = hsvToHex(tintState.h, tintState.s, tintState.v);
  paintTintPicker(hex, opts);
  previewGlassTint(hex);
}

/// Pointer drags on the square and the hue bar. Pointer capture keeps the drag
/// alive when a fast flick leaves the control; the latest position is applied
/// once per animation frame however many events arrive in between.
function bindTintDrag(el, onPoint) {
  if (!el) return;
  let rect = null;
  let last = null;
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (rect && last) onPoint(last, rect);
  };
  const queue = (e) => {
    last = { x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(flush);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    rect = el.getBoundingClientRect();
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    queue(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (el.hasPointerCapture(e.pointerId)) queue(e);
  });
}

bindTintDrag($('tintSv'), (p, r) => {
  tintState.s = clamp01((p.x - r.left) / r.width);
  tintState.v = 1 - clamp01((p.y - r.top) / r.height);
  applyTintState();
});
bindTintDrag($('tintHue'), (p, r) => {
  tintState.h = clamp01((p.x - r.left) / r.width) * 360;
  applyTintState();
});

$('tintSv')?.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.1 : 0.01;
  const moves = { ArrowLeft: ['s', -step], ArrowRight: ['s', step], ArrowDown: ['v', -step], ArrowUp: ['v', step] };
  const move = moves[e.key];
  if (!move) return;
  e.preventDefault();
  tintState[move[0]] = clamp01(tintState[move[0]] + move[1]);
  applyTintState();
});
$('tintHue')?.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1;
  const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
  if (delta === undefined) return;
  e.preventDefault();
  tintState.h = Math.min(360, Math.max(0, tintState.h + delta));
  applyTintState();
});

$('tintHex')?.addEventListener('input', (e) => {
  const hex = parseHexInput(e.target.value);
  if (!hex) return;
  syncTintStateFromHex(hex);
  // The field is left as typed until it is committed.
  paintTintPicker(hex, { syncHexField: false });
  previewGlassTint(hex);
});
$('tintHex')?.addEventListener('change', (e) => {
  e.target.value = safeColor(config.glass?.tint, DEFAULT_GLASS_TINT).toUpperCase();
});
$('tintHex')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    closeTintPicker(true);
  }
});

(function buildTintPresets() {
  const host = $('tintPresets');
  if (!host) return;
  for (const hex of TINT_PRESETS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tint-preset';
    chip.dataset.value = hex;
    chip.style.setProperty('--swatch', hex);
    chip.setAttribute('aria-label', hex.toUpperCase());
    chip.addEventListener('click', () => {
      syncTintStateFromHex(hex);
      paintTintPicker(hex);
      previewGlassTint(hex);
    });
    host.appendChild(chip);
  }
})();

function openTintPicker() {
  const btn = $('theme-glassBg');
  const picker = $('tintPicker');
  if (!btn || !picker || btn.disabled) return;

  const hex = safeColor(config.glass?.tint, DEFAULT_GLASS_TINT);
  syncTintStateFromHex(hex);
  paintTintPicker(hex);

  // Lifted over the next settings group, as an open custom select is.
  picker.closest('.settings-group')?.classList.add('tint-host');
  picker.classList.remove('opens-up');
  showDropdown(picker);

  // Open upward when there is not room below inside the settings scroller.
  const bounds = scrollParentOf(picker.parentElement).getBoundingClientRect();
  const t = btn.getBoundingClientRect();
  const below = bounds.bottom - t.bottom;
  const above = t.top - bounds.top;
  if (picker.offsetHeight + 8 > below && above > below) picker.classList.add('opens-up');

  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('is-open');
  $('tintSv')?.focus({ preventScroll: true });
}

function closeTintPicker(refocus = false) {
  const btn = $('theme-glassBg');
  const picker = $('tintPicker');
  if (!picker || picker.hidden || picker.classList.contains('is-closing')) return;

  hideDropdown(picker);
  btn?.setAttribute('aria-expanded', 'false');
  btn?.classList.remove('is-open');
  if (refocus) btn?.focus();

  // After the exit animation, so the one full pass — which writes the boot
  // cache and saves — does not land on top of it. Skipped if the picker was
  // reopened in the meantime.
  setTimeout(() => {
    if (!picker.hidden) return;
    picker.closest('.settings-group')?.classList.remove('tint-host');
    if (!tintState.dirty) return;
    tintState.dirty = false;
    applyTheme(config.theme);
    clearTimeout(_themeSaveTimer);
    saveThemeSettings();
  }, MENU_EXIT_MS);
}

$('theme-glassBg')?.addEventListener('click', () => {
  if ($('theme-glassBg').getAttribute('aria-expanded') === 'true') closeTintPicker();
  else openTintPicker();
});

// Dismissal on press rather than click: a drag that starts on the square and
// is released outside the picker must not count as a click outside it.
document.addEventListener('pointerdown', (e) => {
  const picker = $('tintPicker');
  if (!picker || picker.hidden) return;
  if (picker.contains(e.target) || $('theme-glassBg')?.contains(e.target)) return;
  closeTintPicker();
}, true);
document.addEventListener('keydown', (e) => {
  const picker = $('tintPicker');
  if (!picker || picker.hidden || e.key !== 'Escape') return;
  e.preventDefault();
  closeTintPicker(true);
});

$('btnResetGlassTint')?.addEventListener('click', () => {
  setGlassTintUI(DEFAULT_GLASS_TINT);
  config.glass = { ...(config.glass || {}), tint: DEFAULT_GLASS_TINT };
  applyTheme(config.theme);
  // Not debounced: a click is one change, and a pending picker save would
  // otherwise land after it and write the old colour back.
  clearTimeout(_themeSaveTimer);
  saveThemeSettings();
});

/// Set the glass backdrop, redraw, and persist.
///
/// Saved through its own command, never with the rest of the config (see
/// saveConfig in the shim). `persistDelay` lets the field wait for typing to
/// stop instead of writing config.json on every keystroke.
let _backdropSaveTimer = null;
/// Bumped by every backdrop change, so an address that finishes downloading
/// after something newer was chosen is dropped instead of saved over it.
let backdropFetchSeq = 0;
function setGlassBackdrop(value, persistDelay = 0) {
  config.glass = { ...(config.glass || {}), bgImage: value };
  // A save of a newer choice wins over an address still downloading.
  backdropFetchSeq++;

  // Live preview is the two CSS variables and nothing else: the sheet is a
  // file now, and the class list hasn't changed, so there is nothing for
  // applyTheme() to redo. The full pass — which writes the boot cache, and the
  // backdrop with it — waits alongside the save: a picked image is a data:
  // URI of up to 1.4 MB, so doing either of those per keystroke was the whole
  // cost when the field saved as you typed.
  const glass = config.glass;
  if (glass.enabled === true) {
    applyGlassVars(glass.tint, glass.bgImage, glass.fullEffects !== false);
  }

  clearTimeout(_backdropSaveTimer);
  _backdropSaveTimer = setTimeout(async () => {
    applyTheme(config.theme);
    try {
      await window.radium?.setGlassBackdrop(value);
    } catch (e) {
      addLog(`Could not save the glass backdrop: ${e}`, 'error');
    }
  }, persistDelay);
}

// ─── Glass backdrop ─────────────────────────────────────────────────────────
// The surface the frosted panels sit over. Optional: with none set, glass
// paints gradients from the tint instead.

/// Largest file the backdrop picker will accept, before downscaling.
const BG_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/// Longest edge the stored backdrop is resized to.
///
/// It is stretched over the window with `background-size: cover`, so anything
/// past a large display's width is detail nobody can see. 2560 covers a
/// maximised launcher on a 4K screen at 150% scaling.
const BG_IMAGE_MAX_EDGE = 2560;

/// Ceiling on the encoded data URI that ends up in config.json.
///
/// This string is stored in the config, interpolated into the generated glass
/// stylesheet, cached in localStorage for the pre-paint replay, and sent back
/// over IPC on every save — and `ensure_config` reads the config on nearly
/// every backend command. A picked 5 MB wallpaper used to become ~6.7 MB of
/// base64 doing all of that, which blew the localStorage quota and silently
/// disabled the boot cache. Re-encoding to fit keeps the whole chain cheap.
const BG_IMAGE_MAX_STORED_BYTES = 1_400_000;

/// Decode a picked file into something a canvas can draw.
///
/// Never through `URL.createObjectURL`: the CSP's `img-src` has no `blob:`, so
/// an `<img>` pointed at a blob URL is refused and fires `error` — which is
/// why every picked file, JPEG included, used to be reported as "not an image".
/// `createImageBitmap` decodes the bytes directly and is not subject to
/// `img-src`; a `data:` URL (which the CSP does allow) covers anything it
/// declines, such as SVG.
async function decodeImageFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // Fall through to the data: URL path.
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return img;
}

/// Downscale and re-encode a picked image to something worth storing.
///
/// Resolves to a JPEG data URI inside [`BG_IMAGE_MAX_STORED_BYTES`], stepping
/// the quality down until it fits. Rejects rather than storing something that
/// cannot be made small enough.
async function prepareBackgroundImage(file) {
  if (file.size > BG_IMAGE_MAX_INPUT_BYTES) {
    throw new Error(`That image is ${formatBytes(file.size)}. Pick one under ${formatBytes(BG_IMAGE_MAX_INPUT_BYTES)}.`);
  }

  let source;
  try {
    source = await decodeImageFile(file);
  } catch (e) {
    throw new Error('That file could not be read as an image.');
  }

  try {
    const width = source.width;
    const height = source.height;
    if (!width || !height) throw new Error('That file could not be read as an image.');

    const scale = Math.min(1, BG_IMAGE_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not process that image.');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    // JPEG throughout: a backdrop sits behind a dark scrim and has no
    // transparency to preserve, and PNG at this size is several times larger.
    for (const quality of [0.82, 0.7, 0.6, 0.5, 0.4]) {
      const encoded = canvas.toDataURL('image/jpeg', quality);
      if (encoded.length <= BG_IMAGE_MAX_STORED_BYTES) return encoded;
    }
    throw new Error('That image is too detailed to store. Try a smaller one.');
  } finally {
    source.close?.();
  }
}

/// Download the picture at `url` and store it the way a picked file is stored.
///
/// The address itself can't be the backdrop: the CSP lets the page load no
/// remote image, so the backend fetches it (`cmd_fetch_glass_backdrop`, HTTPS
/// and public hosts only) and it is downscaled into a data: URI here. Returns
/// whether it was applied. `quiet` skips the toasts, for the one-time upgrade
/// of an address saved before this existed.
async function setGlassBackdropFromUrl(url, { quiet = false } = {}) {
  const seq = ++backdropFetchSeq;
  if (!quiet) toast('Downloading the picture...', 'info', 2500);
  try {
    const bytes = await window.radium.fetchGlassBackdrop(url);
    const data = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
    const encoded = await prepareBackgroundImage(new Blob([data]));
    if (seq !== backdropFetchSeq) return false;
    setBgImageUI(encoded);
    setGlassBackdrop(encoded);
    addLog(`Glass backdrop downloaded from ${url} (${formatBytes(encoded.length)} stored).`, 'ok');
    return true;
  } catch (err) {
    if (seq !== backdropFetchSeq) return false;
    const msg = err?.message || String(err);
    addLog(`Glass backdrop from ${url} not used: ${msg}`, 'warn');
    if (!quiet) toast(msg, 'error', 5000);
    return false;
  }
}

$('theme-bgImage')?.addEventListener('input', (e) => {
  const field = e.target;
  if (field.value !== SAVED_BACKDROP_LABEL) delete field.dataset.savedPicture;
  // Emptied: back to the tint straight away. An address waits until it is
  // committed (Enter, or leaving the field), so a half-typed one isn't
  // downloaded — see `change`.
  if (!field.value.trim()) setGlassBackdrop('', 600);
});

$('theme-bgImage')?.addEventListener('change', (e) => {
  const field = e.target;
  const value = field.value.trim();
  if (!value || field.dataset.savedPicture) return;
  if (paintableBackdrop(value)) {
    // A data: URI pasted in whole. Rare, but it is exactly what gets stored —
    // so it is held to the same ceiling a picked file is shrunk to fit, or a
    // pasted wallpaper would ride along in config.json at full size.
    if (value.length > BG_IMAGE_MAX_STORED_BYTES) {
      toast('That picture is too large to paste. Use Browse to pick the file instead.', 'error', 5000);
      return;
    }
    setBgImageUI(value);
    setGlassBackdrop(value);
    return;
  }
  if (!value.startsWith('https://') || !safeBackdrop(value)) {
    toast('Enter the address of a picture, starting with https://', 'error', 4000);
    return;
  }
  setGlassBackdropFromUrl(value);
});

$('btnBrowseBgFile')?.addEventListener('click', () => {
  const picker = $('theme-bgFilePicker');
  if (picker) picker.value = '';
  picker?.click();
});

$('theme-bgFilePicker')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const encoded = await prepareBackgroundImage(file);
    setBgImageUI(encoded);
    setGlassBackdrop(encoded);
    addLog(`Glass backdrop set (${formatBytes(encoded.length)} stored).`, 'ok');
  } catch (err) {
    toast(err.message || 'Could not use that image.', 'error', 5000);
    addLog(`Glass backdrop rejected: ${err.message}`, 'warn');
  }
});

$('btnClearBgImage')?.addEventListener('click', () => {
  setBgImageUI('');
  if ($('theme-bgFilePicker')) $('theme-bgFilePicker').value = '';
  setGlassBackdrop('');
});

// ─── Auto-save Settings ─────────────────────────────────────────────────────
// Replaces the old manual Save button. Collects the full settings state and
// persists it to config.json. A small indicator in the header gives feedback.

function showAutosaveIndicator(state, text) {
  const el = $('autosaveIndicator');
  if (!el) return;
  el.style.display = '';
  el.className = `autosave-indicator visible ${state}`;
  el.textContent = text;
}

async function autoSaveSettings() {
  if (!config || Object.keys(config).length === 0) return;

  const updated = {
    ...config,
    apiUrl:           config.apiUrl || 'https://api.radie.app/',
    minimizeOnLaunch: getToggle('tgl-minimizeOnLaunch'),
    closeOnLaunch:    getToggle('tgl-closeOnLaunch'),
    autoUpdate:       getToggle('tgl-autoUpdate'),
    disableWarnings:  getToggle('tgl-disableWarnings'),
    runInBackground:  getToggle('tgl-runInBackground'),
    notifPopups:      getToggle('tgl-notifPopups'),
    notifSound:       getToggle('tgl-notifSound'),
    // No `installDir` here on purpose. The install-dir span shows whichever
    // network is active, so copying it into the flat (Radium) field on every
    // autosave silently repointed Radium at the Vanilla folder. The Change /
    // Reset Folder buttons own that setting and save it themselves, into the
    // active network's slot; the `...config` spread carries both slots through
    // untouched.
    playMode,
    // Theme and glass are owned by saveThemeSettings(), which the skin
    // dropdown and the glass controls call directly. The `...config` spread
    // carries the current values through untouched — writing them from this
    // form would let a stale read revert a change made a moment ago.
    network:          activeNetwork
    // No `vanilla` key here either, for the same reason as `installDir`: every
    // field in that sub-object is owned by the Change / Reset Folder buttons or
    // by the backend, so the `...config` spread carries it through untouched.
  };

  showAutosaveIndicator('saving', 'Saving...');

  let ok = false;
  try {
    ok = await window.radium?.saveConfig(updated);
  } catch (e) {
    console.error('autoSaveSettings error:', e);
  }

  if (ok) {
    config = updated;
    showAutosaveIndicator('saved', '✓ Saved');
    addLog('Configuration auto-saved.', 'ok');
    await checkInstall();
  } else {
    showAutosaveIndicator('error', '✕ Save failed');
    addLog('Auto-save failed.', 'error');
  }

  // Fade the indicator out after 2 seconds
  setTimeout(() => {
    const el = $('autosaveIndicator');
    if (el) el.classList.remove('visible');
  }, 2000);
}

// Check client installation state
/// One log line per session about a set-aside folder, not one per autosave.
let orphanedDirReported = false;

/// checkInstall() re-runs on every settings autosave, and its verdict almost
/// never changes between two of them, so each toggle clicked logged the same
/// "Game client found" line again. The log is what a bug report carries —
/// 2,000 lines of it — and a session of settings changes pushed everything
/// else out. Logged when the verdict changes instead: `kind` names which
/// verdict ('client', or 'outdated' beside it), so the two lines an outdated
/// client gets don't take turns being "new".
const lastInstallLog = new Map();
function logInstallState(kind, msg, level) {
  if (lastInstallLog.get(kind) === msg) return;
  lastInstallLog.set(kind, msg);
  addLog(msg, level, 'install');
}

/// The outdated-client dialog, once per client rather than once per
/// checkInstall(): it used to come back on every settings autosave for as long
/// as the client stayed outdated. Keyed by network and build, so switching
/// network, or a new install that is still outdated, asks again.
let outdatedPromptKey = '';

async function checkInstall() {
  let result = null;
  try {
    result = await window.radium?.checkInstall();
  } catch (e) {
    console.error('checkInstall error:', e);
  }
  isInstalled = result?.installed ?? false;
  needsRepair = !isInstalled && !!result?.needsRepair;
  if (result?.patchDir) stellaPatchDir = result.patchDir;
  const qscC = $('qsc-client');
  // Only the active network's row: `result` describes the network checkInstall
  // was called for. The other row is filled by refreshInstallDirRows().
  const activeDirSpan = installDirSpan();

  if (activeDirSpan && result?.clientDir) {
    activeDirSpan.textContent = result.clientDir;
  }

  // The backend renames a client folder aside when it finds one network holding
  // another network's client. Say so once a session — checkInstall() re-runs on
  // every settings autosave, and the folder sticks around until the user deletes it.
  if (result?.orphanedClientDir && !orphanedDirReported) {
    orphanedDirReported = true;
    addLog(`Found a client in the wrong network's folder. Moved it aside to ${result.orphanedClientDir} — you can delete that folder.`, 'warn', 'install');
  }

  if (isInstalled) {
    // Show launch panel, hide download section
    const ds = $('downloadSection'); if (ds) ds.style.display = 'none';
    document.body.classList.add('client-installed');
    const qi = $('qsInstalled'); if (qi) qi.textContent = 'INSTALLED';
    // Reapply the last known update result (if any) instead of flashing back
    // to "Check for Updates" and re-fetching — checkInstall() re-runs on
    // every settings autosave, so re-checking every time would spam requests
    // and flicker the button/card each time it resolves.
    if (qscC) {
      qscC.classList.add('installed');
      qscC.classList.remove('not-installed', 'update-available');
      if (clientUpdateInfo?.hasUpdate) {
        qscC.classList.add('update-available');
        const qi2 = $('qsInstalled'); if (qi2) qi2.textContent = `v${clientUpdateInfo.latestVersion}`;
      }
    }
    setClientUpdateButton(clientUpdateInfo?.hasUpdate ? 'update' : 'check', clientUpdateInfo);
    const verLabel = result?.clientVersion ? `v${result.clientVersion}` : 'unknown version';
    const buildLabel = result?.clientBuild || 'unrecorded build';
    logInstallState('client', `Game client found (${verLabel}, build ${buildLabel}): ${result.exePath || 'client dir'}`, 'ok');

    // Check if the game is already running on startup. Only log the transition:
    // checkInstall() re-runs on every settings autosave, so logging every time
    // filled the log with one line per 800ms while the game was open.
    if (result?.isRunning) {
      const wasRunning = isGameRunning;
      setGameRunning(true);
      if (!wasRunning) addLog('Game is already running.', 'ok', 'game');
    }

    // An outdated client (left over from a previous launcher version) must be
    // re-downloaded to match the new Radium build.
    if (!result?.clientOutdated) lastInstallLog.delete('outdated');
    if (result?.clientOutdated && !result?.isRunning) {
      logInstallState('outdated', `Installed client is outdated — build '${result?.clientBuild || 'unrecorded'}' ≠ required '${result?.requiredBuild || 'unknown'}'. Update required.`, 'warn');
      const promptKey = `${activeNetwork}|${result?.clientBuild || ''}|${result?.exePath || ''}`;
      if (promptKey !== outdatedPromptKey) {
        outdatedPromptKey = promptKey;
        showModal($('clientUpdateModal'));
      }
    } else if (activeNetwork === 'stella') {
      // Stella's client has no version feed; what updates is its patch, which
      // has its own Steam-style UPDATE button. Throttled inside.
      refreshStellaPatch();
    } else if (!result?.isRunning && !clientUpdateAutoChecked) {
      // Live version check against recroom.baby (Steam-style update prompt).
      // Only auto-run this once per session — the manual button handles re-checks.
      clientUpdateAutoChecked = true;
      checkForClientUpdate();
    }
  } else {
    // Show download section, hide launch panel
    const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
    document.body.classList.remove('client-installed');
  // The gear that opens it lives in the installed-only bar and has just
  // disappeared; an open menu would be left hanging over the download CTA.
  closeManageMenu();
    const qi = $('qsInstalled'); if (qi) qi.textContent = 'NOT INSTALLED';
    if (qscC) {
      qscC.classList.add('not-installed');
      qscC.classList.remove('installed', 'update-available');
    }
    setClientUpdateButton('hidden');
    // No client installed — clear any cached update state so a fresh
    // install triggers a real re-check instead of reapplying stale info.
    clientUpdateInfo = null;
    clientUpdateAutoChecked = false;

    // A network that has not shipped a client yet is a different state from
    // "you haven't installed it": there is nothing to install. Say so rather
    // than offering a Download that can only fail.
    if (needsRepair) {
      if (qi) qi.textContent = 'NEEDS REPAIR';
      logInstallState('client', `${networkInfo().label} is installed but missing files, including the game itself. Press REPAIR to check every file and get the missing ones back.`, 'warn');
    } else if (!clientDownloadAvailable()) {
      if (qi) qi.textContent = 'NOT RELEASED';
      logInstallState('client', `${networkInfo().label} has not published a client yet.`, 'info');
    } else if (result?.incomplete) {
      // The launcher closed (or the PC went off) partway through unpacking.
      logInstallState('client', 'The last install stopped before it finished — download the client again.', 'warn');
    } else {
      logInstallState('client', `${networkInfo().label} client not found — download required.`, 'info');
    }
  }

  if (!isInstalled) stellaPatch = null;
  applyStellaPatchUI();
  updateDownloadCta();
}

/// Whether the active network has something the launcher can actually install.
///
/// Vanilla has published no client, so this is false and its hero button opens
/// their download page instead. The install pipeline behind it is complete and
/// keyed on `config.vanilla.clientUrl`; there is deliberately no UI for that
/// field while there is nothing to point it at, so it is set in config.json (or
/// a Settings row is added back) once Vanilla ships a build.
function clientDownloadAvailable() {
  const info = networkInfo();
  if (!info.needsConfiguredDownloadUrl) return true;
  return !!(config?.vanilla?.clientUrl || '').trim();
}

/// Point the hero's DOWNLOAD button at the right thing, and explain it when
/// that thing is a website rather than an install.
function updateDownloadCta() {
  const btn = $('btnDownload');
  const note = $('heroDownloadNote');
  if (needsRepair) {
    if (btn) btn.textContent = '\u2b07 REPAIR';
    if (note) {
      note.style.display = 'block';
      note.textContent = 'Some game files are missing. Repair checks every file and gets back the ones that are gone.';
    }
    return;
  }
  const available = clientDownloadAvailable();
  const info = networkInfo();

  if (btn) {
    btn.textContent = available ? '\u2b07 DOWNLOAD' : `\u2b07 GET ${info.label}`;
  }
  if (note) {
    note.style.display = available ? 'none' : 'block';
    note.textContent = available
      ? ''
      : `${info.label} hasn't released a client yet. This opens their download page.`;
  }
}

// Advance the Download → Extract → Done phase stepper. Steps before the
// active one are marked 'done'; the active one 'active'; later ones idle.
function setDlStep(active) {
  const order = ['download', 'extract', 'done'];
  const activeIdx = order.indexOf(active);
  document.querySelectorAll('#dlSteps .dlp-step').forEach((el) => {
    const idx = order.indexOf(el.dataset.step);
    el.classList.remove('active', 'done');
    if (idx < activeIdx) el.classList.add('done');
    else if (idx === activeIdx) el.classList.add('active');
  });
}

/// Relabel the three steps of the progress panel. Verify Files borrows it,
/// so its steps read Verify / Repair / Done; a download puts them back.
function setDlStepLabels(first = 'Download', second = 'Extract', third = 'Done') {
  const labels = { download: first, extract: second, done: third };
  document.querySelectorAll('#dlSteps .dlp-step').forEach((el) => {
    const idx = el.querySelector('.dlp-step-idx');
    el.replaceChildren(...(idx ? [idx] : []), document.createTextNode(labels[el.dataset.step] || ''));
  });
}

// In-app client download downloader state
// Sync the Download / Pause button labels to the current state.
function updateDlButtons() {
  const dlBtn = $('btnDownload');
  const pauseBtn = $('btnPauseDl');
  if (dlBtn) {
    dlBtn.disabled = isDownloading || isPaused || isCancelling;
    dlBtn.textContent = isCancelling  ? '⬇ CANCELLING...'
                      : clientTask === 'verify' ? '✓ VERIFYING...'
                      : clientTask === 'repair' ? '⬇ REPAIRING...'
                      : isDownloading ? '⬇ DOWNLOADING...'
                      : isPaused      ? '⬇ PAUSED'
                      : needsRepair   ? '⬇ REPAIR'
                      :                 '⬇ DOWNLOAD';
  }
  if (pauseBtn) pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
}

// `opts.resuming` keeps the current bar position instead of snapping back to 0%,
// so continuing a paused/interrupted download doesn't visibly flash to zero.
function setDownloadUI(downloading, opts = {}) {
  isDownloading = downloading;
  if (downloading) { isPaused = false; isCancelling = false; extractEta = null; dlResumable = false; }
  const block = $('dlProgressBlock');
  const pauseBtn = $('btnPauseDl');
  if (downloading) {
    if (block) block.style.display = 'block';
    // Shown once the server is known to let it continue; see updateDlProgress().
    if (pauseBtn) pauseBtn.style.display = 'none';
    setStatLabels('Speed', 'Transferred', 'ETA');
    if (!clientTask) setDlStepLabels();
    setDlStep('download');
    if (!opts.resuming) {
      const fill = $('dlBarFill'); if (fill) { fill.classList.remove('indeterminate'); applyBarFill(fill, 0); }
      const pctEl = $('dlPctLabel'); if (pctEl) pctEl.textContent = '0%';
    }
  } else if (!isPaused) {
    // Fully idle — hide the panel. (A paused download keeps its panel visible;
    // see setPausedUI.)
    if (block) block.style.display = 'none';
  }
  updateDlButtons();
}

// Show the panel frozen in a paused/resumable state. `info` may carry
// { downloaded, total } (e.g. a resume offered on launcher startup) so the bar
// reflects real progress before the download is running again.
function setPausedUI(info = {}) {
  isDownloading = false;
  isPaused = true;
  const block = $('dlProgressBlock');
  if (block) block.style.display = 'block';
  const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = '';
  setStatLabels('Speed', 'Transferred', 'ETA');
  const phaseEl = $('dlPhaseLabel'); if (phaseEl) phaseEl.textContent = 'Paused';
  const speedEl = $('dlSpeedLabel'); if (speedEl) speedEl.textContent = '—';
  const etaEl   = $('dlEtaLabel');   if (etaEl)   etaEl.textContent   = '—';
  if (typeof info.total === 'number' && info.total > 0 && typeof info.downloaded === 'number') {
    const pct = Math.min(99, Math.floor((info.downloaded / info.total) * 100));
    const fill = $('dlBarFill'); if (fill) { fill.classList.remove('indeterminate'); applyBarFill(fill, pct); }
    const pctEl = $('dlPctLabel'); if (pctEl) pctEl.textContent = `${pct}%`;
    const sizeEl = $('dlSizeLabel'); if (sizeEl) sizeEl.textContent = `${formatBytes(info.downloaded)} / ${formatBytes(info.total)}`;
  }
  setDlStep('download');
  updateDlButtons();
}

// The retro-family themes draw the progress bar as discrete blocks, via a
// repeating gradient with a 10px period (8px block + 2px gap). A plain
// percentage width slices the final block mid-cube, so snap the fill to whole
// blocks. Themes that paint a solid bar (the modern family, Vista/7) are
// detected from the computed background and keep the exact percentage.
function applyBarFill(fill, pct) {
  // Must match the repeating-gradient period in .dlp-bar-fill (8px block + 2px gap).
  const SEGMENT_PX = 10;
  if (!fill) return;
  fill.dataset.pct = String(pct);
  const wrap = fill.parentElement;
  const segmented = getComputedStyle(fill).backgroundImage.includes('repeating-linear-gradient');
  if (!segmented || !wrap) { fill.style.width = `${pct}%`; return; }

  const ws = getComputedStyle(wrap);
  const track = wrap.clientWidth - parseFloat(ws.paddingLeft || 0) - parseFloat(ws.paddingRight || 0);
  if (!(track > 0)) { fill.style.width = `${pct}%`; return; }

  // 100% must fill the track exactly, even when it isn't a whole number of
  // blocks, or the bar would stop just short of the end.
  if (pct >= 100) { fill.style.width = '100%'; return; }
  let blocks = Math.floor((track * pct / 100) / SEGMENT_PX);
  if (pct > 0 && blocks < 1) blocks = 1;   // any progress shows at least one block
  fill.style.width = `${blocks * SEGMENT_PX}px`;
}

/// The bar for a download of unknown size (Stella's server sends none). On
/// the block-drawn skins it is a marquee: a run of whole blocks stepping
/// across the track one block at a time, as Windows draws one (see
/// `.dlp-bar-fill.indeterminate.segmented` in style.css). The steps have to
/// land on the block grid, so the track's width in whole blocks is handed to
/// the CSS here — and again on resize, since it is in pixels.
function applyIndeterminateBar(fill) {
  const SEGMENT_PX = 10;   // as in applyBarFill
  const wrap = fill?.parentElement;
  if (!wrap) return;
  const segmented = getComputedStyle(fill).backgroundImage.includes('repeating-linear-gradient');
  fill.classList.toggle('segmented', segmented);
  if (!segmented) return;
  const ws = getComputedStyle(wrap);
  const track = wrap.clientWidth - parseFloat(ws.paddingLeft || 0) - parseFloat(ws.paddingRight || 0);
  if (!(track > 0)) return;
  const blocks = Math.ceil(track / SEGMENT_PX);
  // Set only on a change: a new duration would restart the marquee, and
  // this runs on every progress event.
  const trackPx = `${blocks * SEGMENT_PX}px`;
  if (fill.style.getPropertyValue('--bar-track') !== trackPx) {
    fill.style.setProperty('--bar-track', trackPx);
    fill.style.setProperty('--bar-steps', String(blocks + 8));   // 8: the marquee's own length
  }
}

// A snapped width is in pixels, so it goes stale when the window resizes or a
// theme swaps the bar between segmented and solid. Re-apply on both.
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => {
    const fill = $('dlBarFill');
    if (fill && fill.classList.contains('indeterminate')) {
      applyIndeterminateBar(fill);
    } else if (fill && fill.dataset.pct != null) {
      applyBarFill(fill, Number(fill.dataset.pct));
    }
  });
  const startBarObserver = () => {
    const wrap = $('dlBarFill')?.parentElement;
    if (wrap) ro.observe(wrap);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startBarObserver);
  } else {
    startBarObserver();
  }
}

// Extraction ETA state. The backend reports only done/total entries for this
// phase, so the estimate is derived from the rate entries are being written at.
let extractEta = null;   // { t0, done0 }

// Relabel the three stat cards (they show download stats vs. extraction stats
// depending on the phase).
function setStatLabels(a, b, c) {
  const l1 = $('dlSpeedStatLabel'), l2 = $('dlSizeStatLabel'), l3 = $('dlEtaStatLabel');
  if (l1) l1.textContent = a;
  if (l2) l2.textContent = b;
  if (l3) l3.textContent = c;
}

// Estimate remaining extraction time from the entries-per-second rate observed
// since extraction started. Needs a moment of data before it can say anything.
function extractEtaText(done, totalEntries) {
  if (!(totalEntries > 0)) return 'Working…';
  const now = Date.now();
  // First sample, or the counter went backwards (a new extraction began).
  if (!extractEta || done < extractEta.done0) {
    extractEta = { t0: now, done0: done };
    return 'Estimating…';
  }
  const remaining = totalEntries - done;
  if (remaining <= 0) return '0s';
  const elapsed   = (now - extractEta.t0) / 1000;
  const processed = done - extractEta.done0;
  if (elapsed < 1 || processed <= 0) return 'Estimating…';
  return formatEta(remaining / (processed / elapsed));
}

function updateDlProgress({ phase, pct = 0, downloaded = 0, total = 0, speed = 0, eta = -1, status, entry = '', done = 0, totalEntries = 0, resumable, restarted, pauseRefused }) {
  // Whether this download can be paused and picked up later: the server has
  // to answer byte ranges, and Stella's doesn't. Told once, at the start.
  if (phase === 'download' && typeof resumable === 'boolean') {
    dlResumable = resumable;
    // A pause the backend let go of: put the button back as it was.
    if (pauseRefused) {
      const b = $('btnPauseDl'); if (b) b.textContent = '⏸ Pause';
      toast("This download can't be paused. It's still going.", 'info', 4000);
    }
    if (restarted) {
      addLog(`${networkInfo().label}'s server can't continue a download, so it started again from the beginning.`, 'warn', 'install');
      toast("This server can't resume downloads, so it started over.", 'warn', 5000);
    } else if (!resumable) {
      addLog(`${networkInfo().label}'s server can't continue a paused download, so this one can't be paused.`, 'info', 'install');
    }
  }
  // Paused: freeze the panel at the current progress with a Resume button.
  if (phase === 'paused') {
    setPausedUI({ downloaded, total });
    return;
  }
  // Pure "initializing" ping emitted before the download URL is resolved. It
  // carries no real numbers, so don't let it snap a resumed bar back to 0%.
  if (phase === 'download' && downloaded === 0 && total === 0) {
    setDlStep('download');
    const ph = $('dlPhaseLabel'); if (ph) ph.textContent = 'Downloading...';
    return;
  }

  const fill  = $('dlBarFill');
  const pctEl = $('dlPctLabel');
  const phase_el = $('dlPhaseLabel');
  const speedEl  = $('dlSpeedLabel');
  const sizeEl   = $('dlSizeLabel');
  const etaEl    = $('dlEtaLabel');

  if (fill) {
    if (pct >= 0) {
      fill.classList.remove('indeterminate');
      applyBarFill(fill, pct);
    } else {
      // Unknown total (server sent no Content-Length): show an animated
      // indeterminate bar instead of a full one, which would wrongly read as
      // "download complete".
      fill.classList.add('indeterminate');
      fill.style.width = '';
      applyIndeterminateBar(fill);
    }
  }
  if (pctEl)   pctEl.textContent = pct >= 0 ? `${pct}%` : '—';

  if (phase === 'extract') {
    setDlStep('extract');
    if (phase_el) phase_el.textContent = 'Extracting...';
    // Speed/ETA are meaningless while unzipping — repurpose the three cards to
    // show extraction progress instead of leaving them as empty dashes.
    setStatLabels('Files', 'Current File', 'ETA');
    if (speedEl) speedEl.textContent = totalEntries > 0 ? `${done} / ${totalEntries}` : '—';
    if (sizeEl)  sizeEl.textContent  = entry
      || (status ? status.replace(/^Extracting:\s*/, '') : 'Preparing…');
    if (etaEl)   etaEl.textContent   = extractEtaText(done, totalEntries);
    // Pause applies only during the download phase.
    const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = 'none';
    return;
  }

  if (phase === 'verify' || phase === 'repair') {
    // The first two steps are relabelled for these (see setDlStepLabels):
    // Verify, then Repair — or Download, then Repair, for a repair that
    // downloads the whole client.
    setDlStep(phase === 'verify' ? 'download' : 'extract');
    if (phase_el) phase_el.textContent = phase === 'verify' ? 'Verifying files...' : 'Repairing files...';
    setStatLabels('Files', 'Current File', 'ETA');
    if (speedEl) speedEl.textContent = totalEntries > 0 ? `${done} / ${totalEntries}` : '—';
    if (sizeEl)  sizeEl.textContent  = entry || '—';
    if (etaEl)   etaEl.textContent   = eta >= 0 ? formatEta(eta) : 'Estimating…';
    const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = 'none';
    return;
  }

  if (phase === 'done') {
    setDlStep('done');
    if (phase_el) phase_el.textContent = 'Complete!';
    setStatLabels('Files', 'Current File', 'ETA');
    if (speedEl) speedEl.textContent = totalEntries > 0 ? `${totalEntries} / ${totalEntries}` : '—';
    if (sizeEl)  sizeEl.textContent  = 'Done';
    if (etaEl)   etaEl.textContent   = '0s';
    extractEta = null;
    const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = 'none';
    return;
  }

  setDlStep('download');
  extractEta = null;
  if (phase_el) phase_el.textContent = 'Downloading...';
  setStatLabels('Speed', 'Transferred', 'ETA');
  // A repair's download can't be paused: what it downloads is never kept.
  // Nor can one from a server that can't continue it.
  const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = clientTask || !dlResumable ? 'none' : '';
  if (speedEl)  speedEl.textContent  = speed > 0 ? `${formatBytes(speed)}/s` : '—';
  if (sizeEl)   sizeEl.textContent   = total > 0
    ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
    : formatBytes(downloaded);
  if (etaEl)    etaEl.textContent    = eta >= 0 ? formatEta(eta) : '—';
}

async function runClientDownload({ resuming = false } = {}) {
  if (isDownloading) return;

  // Reveal the download/progress UI. When updating an already-installed client
  // the launch panel is showing and the download section (which holds the
  // progress block) is hidden, so the status would otherwise be invisible.
  const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
  document.body.classList.remove('client-installed');
  // The gear that opens it lives in the installed-only bar and has just
  // disappeared; an open menu would be left hanging over the download CTA.
  closeManageMenu();

  setDownloadUI(true, { resuming });
  if (resuming) {
    addLog('Resuming download...', 'info', 'install');
    toast('Resuming download...', 'info', 2500);
  } else {
    addLog({
      radium: 'Starting download from recroom.baby (downloads page)...',
      vanilla: 'Starting download from the configured Vanilla client URL...',
      // Sent without a length, so the bar can't show a percentage.
      stella: "Starting download from Stella (about 4.7 GB; Stella's server doesn't send the size)...",
    }[activeNetwork] || 'Starting download...', 'info', 'install');
    toast('Download started!', 'info', 2500);
  }

  const dlStart = Date.now();
  let result = null;
  try {
    result = await window.radium?.downloadClient();
  } catch (e) {
    console.error('downloadClient error:', e);
    result = { success: false, error: e.toString() };
  }

  // The backend call has unwound, so its download guard is released and a new
  // download may start again.
  isCancelling = false;

  const elapsed = ((Date.now() - dlStart) / 1000).toFixed(1);
  if (result?.success) {
    setDownloadUI(false);
    addLog(`Download & extraction complete in ${elapsed}s.`, 'ok', 'install');
    addLog(`Exe: ${result.exePath || 'Found in client dir'}`, 'ok', 'install');
    toast(`${networkInfo().label} client installed!`, 'ok', 4000);
    // Stella: the install also fetched the patch, installing it if it was a
    // checked build. Either way the next checkInstall() asks afresh, so a
    // patch still to accept shows up as UPDATE straight away.
    if (activeNetwork === 'stella') {
      stellaPatch = null;
      if (result.patchInstalled) addLog("Stella's patch installed (a checked build).", 'ok', 'install');
    }
    // The download stamped a new client build id / version / ETag directly into
    // config.json. Re-sync our in-memory copy from disk so the next settings
    // autosave (which writes the whole config back) doesn't revert those to the
    // stale values loaded at startup — which would flag the just-installed
    // client as "outdated" and kick off an endless re-download loop.
    config = (await window.radium?.getConfig()) || config;
    // The client just changed — any cached "update available" state is now
    // stale, so force a fresh check next time checkInstall() runs below.
    clientUpdateInfo = null;
    clientUpdateAutoChecked = false;
    await checkInstall();
  } else {
    const err = result?.error || 'Unknown error';
    if (err === 'Paused') {
      // Paused by the user — keep the panel visible and frozen so it can be
      // resumed. The partial file is preserved on disk by the backend.
      isDownloading = false;
      isPaused = true;
      setPausedUI();
      addLog(`Download paused at ${elapsed}s. Click Resume to continue.`, 'info', 'install');
      return; // don't run checkInstall — the download isn't finished or gone
    }
    setDownloadUI(false);
    if (err === 'Cancelled') {
      // User-initiated cancel — the cancel handler already logged/toasted it,
      // so don't also report it as a failure.
      addLog(`Download stopped after ${elapsed}s (cancelled by user).`, 'info', 'install');
    } else {
      addLog(`Download failed after ${elapsed}s: ${err}`, 'error', 'install');
      toast(`Failed: ${err}`, 'error', 5000);
    }
    // Restore the correct panel (e.g. back to the launch panel if still installed).
    await checkInstall();
    // A stall or a dropped connection keeps what arrived, and the error says
    // "Resume to continue" — so show the Resume button it means rather than
    // leaving only a DOWNLOAD that reads as starting over.
    if (err !== 'Cancelled') await offerResumeIfAny({ quiet: true });
  }
}

$('btnDownload')?.addEventListener('click', () => {
  // A damaged install is repaired, not downloaded again from scratch.
  if (needsRepair) {
    runVerifyFiles();
    return;
  }
  // Nothing to install on this network yet — send the user to the source
  // instead of starting a download that would immediately fail.
  if (!clientDownloadAvailable()) {
    const info = networkInfo();
    addLog(`Opening ${info.downloadPage} — no ${info.label} client to install yet.`, 'info', 'install');
    window.radium?.openUrl(info.downloadPage);
    return;
  }
  runClientDownload();
});

// On startup, offer to continue a download that was interrupted last session
// (paused, or the launcher was closed mid-download). The partial file + resume
// metadata persist on disk, so the backend can pick up exactly where it left off.
/// `quiet` leaves out the toast, for a failure that has just shown its own.
async function offerResumeIfAny({ quiet = false } = {}) {
  if (isDownloading || isPaused || isInstalled) return;
  let info = null;
  try {
    info = await window.radium?.resumableDownloadInfo();
  } catch (e) {
    console.error('resumableDownloadInfo error:', e);
    return;
  }
  if (!info?.resumable) return;

  const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
  document.body.classList.remove('client-installed');
  // The gear that opens it lives in the installed-only bar and has just
  // disappeared; an open menu would be left hanging over the download CTA.
  closeManageMenu();
  setPausedUI({ downloaded: info.downloaded, total: info.total });

  const pctTxt = info.total > 0 ? ` (${Math.floor((info.downloaded / info.total) * 100)}%)` : '';
  addLog(`Found an interrupted download${pctTxt}. Click Resume to continue.`, 'info', 'install');
  if (!quiet) toast('Resume your interrupted download', 'info', 4500);
}

// ─── Outdated-client (post-launcher-update) prompt ──────────────────────────
const clientUpdateModal = $('clientUpdateModal');
const closeClientUpdateModal = () => hideModal(clientUpdateModal);
$('clientUpdateLaterBtn')?.addEventListener('click', closeClientUpdateModal);
$('clientUpdateModalClose')?.addEventListener('click', closeClientUpdateModal);
$('clientUpdateModal')?.addEventListener('click', (e) => { if (e.target === clientUpdateModal) closeClientUpdateModal(); });
$('clientUpdateNowBtn')?.addEventListener('click', () => {
  closeClientUpdateModal();
  switchTab('home');
  runClientDownload();
});

// ─── Live client version update (Steam-style "Update Available" prompt) ────
let clientUpdateInfo = null;
// checkInstall() re-runs after every settings autosave, game state change,
// etc. — track whether we've already done the network-based version check
// this session so we only reapply cached state (no flicker) instead of
// re-fetching and resetting the button/card on every call.
let clientUpdateAutoChecked = false;

function formatPatchNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return '(No patch notes available.)';
  return notes
    .map((n) => {
      const header = n.date ? `${n.version} — ${n.date}` : n.version;
      const bullets = (n.notes || []).map((item) => `• ${item}`).join('\n');
      return bullets ? `${header}\n${bullets}` : header;
    })
    .join('\n\n');
}

// Manual update button embedded in the "Client Status" quick-stat card.
// States: 'hidden' (no client installed), 'check' (installed, no known
// update — click to re-check), 'checking' (check in progress),
// 'update' (update available — click to install it).
/// Drive the Check for Updates row in the gear menu.
///
/// It lives in that menu rather than in the Client Status tile, where it used
/// to share a line with the status value. That tile is one equal third of the
/// stats row, so the button never reliably fitted beside the value — there was
/// a whole `fitUpdateLabel()` routine picking the longest of three wordings
/// that would fit at the current window width, re-run on every resize. A menu
/// row is as wide as the menu, so the full wording simply fits and all of that
/// is gone.
///
/// Hidden through the attribute, not an inline `display`: the menu's layout
/// rule forces `display: flex !important`, which an inline style cannot beat.
function setClientUpdateButton(state, info) {
  const btn = $('btnClientUpdateAction');
  if (!btn) return;
  if (state === 'hidden') {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.disabled = state === 'checking';

  // The row is an icon plus a label, so only the label is rewritten — setting
  // textContent here would drop the icon with it.
  const label = btn.querySelector('span');
  if (state === 'checking') {
    if (label) label.textContent = 'Checking...';
    btn.dataset.mode = 'checking';
  } else if (state === 'update') {
    if (label) label.textContent = 'Install Update';
    btn.dataset.mode = 'update';
  } else {
    if (label) label.textContent = 'Check for Updates';
    btn.dataset.mode = 'check';
  }
}

$('btnClientUpdateAction')?.addEventListener('click', () => {
  const btn = $('btnClientUpdateAction');
  if (btn?.dataset.mode === 'update') {
    switchTab('home');
    runClientDownload();
    return;
  }
  if (btn?.dataset.mode === 'checking') return;
  if (activeNetwork === 'stella') {
    refreshStellaPatch({ manual: true });
    return;
  }
  setClientUpdateButton('checking');
  toast('Checking for client updates...', 'info', 2000);
  checkForClientUpdate(true);
});

function showClientVersionUpdateModal(info) {
  clientUpdateInfo = info;
  const cv = $('clientUpdateCurrentVer'); if (cv) cv.textContent = info.versionKnown ? `v${info.installedVersion}` : 'Unknown';
  const lv = $('clientUpdateLatestVer'); if (lv) lv.textContent = `v${info.latestVersion}`;
  const notes = $('clientUpdateNotes');
  if (notes) {
    let preface = '';
    if (!info.versionKnown) {
      preface = `Your installed client's version couldn't be confirmed (it was installed before update tracking was added). Updating now will sync it to the latest build and enable accurate update checks going forward.\n\n`;
    } else if (info.sameVersionRebuilt) {
      preface = `The site rebuilt v${info.latestVersion} without changing the version number — your download doesn't match the current build fingerprint.\n\n`;
    }
    notes.textContent = preface + formatPatchNotes(info.patchNotes);
  }
  const status = $('clientUpdateStatus'); if (status) status.style.display = 'none';
  const nowBtn = $('clientVersionUpdateNowBtn');
  if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = '⬇ Update Now'; }
  showModal($('clientVersionUpdateModal'));

  const qscC = $('qsc-client');
  if (qscC) qscC.classList.add('update-available');
  const qi = $('qsInstalled'); if (qi) qi.textContent = `v${info.latestVersion}`;
  setClientUpdateButton('update', info);
}

const closeClientVersionUpdateModal = () => hideModal($('clientVersionUpdateModal'));
$('clientVersionUpdateLaterBtn')?.addEventListener('click', closeClientVersionUpdateModal);
$('clientVersionUpdateModalClose')?.addEventListener('click', closeClientVersionUpdateModal);
$('clientVersionUpdateModal')?.addEventListener('click', (e) => { if (e.target === $('clientVersionUpdateModal')) closeClientVersionUpdateModal(); });
$('clientVersionUpdateNowBtn')?.addEventListener('click', () => {
  closeClientVersionUpdateModal();
  switchTab('home');
  runClientDownload();
});

async function checkForClientUpdate(manual = false) {
  try {
    const info = await window.radium?.checkClientUpdate();
    if (!info?.success) {
      const reason = info?.error || 'Unknown error';
      if (manual) { addLog(`Client update check failed: ${reason}`, 'error', 'install'); toast(`Update check failed: ${reason}`, 'error', 4000); }
      setClientUpdateButton('check');
      return;
    }
    if (!info.hasUpdate) {
      const curLabel = info.versionKnown ? `v${info.installedVersion}` : 'unknown version';
      if (manual) { addLog(`Client is up to date (${curLabel}, latest v${info.latestVersion || '—'}).`, 'ok', 'install'); toast('Client is up to date.', 'ok', 3000); }
      setClientUpdateButton('check');
      return;
    }
    const fromLabel = info.versionKnown ? `v${info.installedVersion}` : 'unknown version';
    const changeNote = info.sameVersionRebuilt ? ' (same version, new build detected)' : '';
    addLog(`Client update available: ${fromLabel} → v${info.latestVersion}${changeNote}`, 'warn', 'install');
    toast('Client update available!', 'ok', 4000);
    showClientVersionUpdateModal(info);
  } catch (e) {
    console.error('checkClientUpdate error:', e);
    if (manual) toast('Update check failed.', 'error', 3000);
    setClientUpdateButton('check');
  }
}

// ─── Stella patch UPDATE (Steam-style) ─────────────────────────────────────
// Stella's client is patched at launch by a small DLL that changes far more
// often than the client. A new build of it is offered the way Steam offers a
// game update: a blue UPDATE button in PLAY's place with an "UPDATE QUEUED /
// 0% Complete" readout, rather than the launcher-update dialog, so it is never
// mistaken for an update to the launcher. Pressing it is what accepts that
// build; the backend then injects only a patch matching what was accepted.

/// How often an installed Stella client is re-checked for a new patch while
/// the launcher stays open.
const STELLA_PATCH_RECHECK_MS = 3 * 60 * 60 * 1000;
let stellaPatchCheckedAt = 0;
let stellaPatchCheckSeq = 0;

function stellaUpdateNeeded() {
  return activeNetwork === 'stella' && isInstalled
    && (stellaPatchUpdating || stellaPatch?.updateAvailable === true);
}

function setStellaUpdateProgress(title, pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const t = $('stellaUpdateTitle'); if (t) t.textContent = title;
  const p = $('stellaUpdatePct'); if (p) p.textContent = `${clamped}% Complete`;
  const f = $('stellaUpdateFill'); if (f) f.style.width = `${clamped}%`;
}

/// Swap PLAY for UPDATE (or back) to match the last patch check.
function applyStellaPatchUI() {
  const needed = stellaUpdateNeeded();
  document.body.classList.toggle('stella-update-needed', needed);
  document.body.classList.toggle('stella-updating', needed && stellaPatchUpdating);
  const btn = $('btnStellaUpdate');
  if (btn) btn.disabled = stellaPatchUpdating;
  if (!stellaPatchUpdating) {
    // Steam says QUEUED for an update waiting on you and REQUIRED when the
    // game can't run without it; a missing patch is the second.
    setStellaUpdateProgress(stellaPatch?.installed ? 'UPDATE QUEUED' : 'UPDATE REQUIRED', 0);
  }
}

/// Ask whether Stella's patch needs installing or has a new build. Automatic
/// checks are throttled; a manual one (Check for Updates) always runs.
async function refreshStellaPatch({ manual = false } = {}) {
  if (activeNetwork !== 'stella' || !isInstalled || stellaPatchUpdating) return;
  if (!manual && stellaPatch && Date.now() - stellaPatchCheckedAt < STELLA_PATCH_RECHECK_MS) {
    applyStellaPatchUI();
    return;
  }
  const seq = ++stellaPatchCheckSeq;
  if (manual) setClientUpdateButton('checking');
  let status = null;
  try {
    status = await window.radium?.stellaPatchStatus();
  } catch (e) {
    status = { success: false, error: String(e) };
  }
  // A switch away, or a newer check, while this one was in flight.
  if (seq !== stellaPatchCheckSeq || activeNetwork !== 'stella') return;
  stellaPatchCheckedAt = Date.now();
  stellaPatch = status;
  if (isInstalled) setClientUpdateButton('check');
  applyStellaPatchUI();

  if (!status?.success) {
    const reason = status?.error || 'Unknown error';
    addLog(`Couldn't check for a Stella update: ${reason}`, 'warn', 'install');
    if (manual) toast(`Update check failed: ${reason}`, 'error', 4000);
  } else if (status.updateAvailable) {
    addLog(status.installed
      ? `Stella has an update (patch ${status.latestSha256.slice(0, 12)}…). Press UPDATE on Home to install it.`
      : 'Stella needs its patch before it can be played. Press UPDATE on Home to install it.', 'warn', 'install');
    if (manual) toast('Stella has an update.', 'ok', 3000);
  } else if (manual) {
    addLog('Stella is up to date.', 'ok', 'install');
    toast('Stella is up to date.', 'ok', 3000);
  }
}

async function runStellaPatchUpdate() {
  if (stellaPatchUpdating || activeNetwork !== 'stella') return;
  if (isGameRunning || isGameLaunching) {
    toast('Close the game before updating.', 'warn', 4000);
    return;
  }
  stellaPatchUpdating = true;
  applyStellaPatchUI();
  setStellaUpdateProgress('UPDATING', 0);
  addLog('Updating Stella...', 'info', 'install');

  let result = null;
  try {
    result = await window.radium?.stellaUpdatePatch();
  } catch (e) {
    result = { success: false, error: String(e) };
  }
  stellaPatchUpdating = false;

  if (result?.success) {
    stellaPatch = {
      ...(stellaPatch || {}),
      success: true,
      installed: true,
      updateAvailable: false,
      installedSha256: result.sha256,
      latestSha256: result.sha256,
    };
    stellaPatchCheckedAt = Date.now();
    // The backend recorded the accepted build in config.json; keep the next
    // settings autosave from carrying a stale copy (it preserves the field
    // anyway, but the in-memory config should say what is on disk).
    config = (await window.radium?.getConfig()) || config;
    addLog(`Stella updated (patch ${String(result.sha256).slice(0, 12)}…${result.pinned ? ', a checked build' : ''}).`, 'ok', 'install');
    toast('Stella is up to date.', 'ok', 3000);
  } else {
    const err = result?.error || 'Unknown error';
    addLog(`Stella update failed: ${err}`, 'error', 'install');
    toast(`Update failed: ${err}`, 'error', 5000);
  }
  applyStellaPatchUI();
}

$('btnStellaUpdate')?.addEventListener('click', () => runStellaPatchUpdate());

window.radium?.onStellaPatchProgress((p) => {
  if (!stellaPatchUpdating || !p) return;
  if (p.phase === 'download') setStellaUpdateProgress('UPDATING', p.pct || 0);
  else if (p.phase === 'install') setStellaUpdateProgress('INSTALLING', p.pct || 99);
  else if (p.phase === 'done') setStellaUpdateProgress('INSTALLING', 100);
});

// A launcher left open for days still finds a new patch.
setInterval(() => { refreshStellaPatch(); }, STELLA_PATCH_RECHECK_MS);

$('btnCancelDl')?.addEventListener('click', () => {
  const wasPaused = isPaused;
  const wasActive = isDownloading;
  window.radium?.cancelDownload();
  isPaused = false;
  if (wasActive) {
    // The backend is still mid-chunk and won't release its download guard
    // until it unwinds. Hold the panel in a "cancelling" state so Download
    // can't be re-clicked into a rejection; runClientDownload() clears this
    // as soon as the in-flight call actually settles.
    isCancelling = true;
    isDownloading = false;
    const phaseEl = $('dlPhaseLabel'); if (phaseEl) phaseEl.textContent = 'Cancelling...';
    const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = 'none';
    updateDlButtons();
  } else {
    setDownloadUI(false);
  }
  const what = clientTask === 'verify' ? 'File check' : clientTask === 'repair' ? 'Repair' : 'Download';
  addLog(`${what} cancelled.`, 'info', 'install');
  toast(`${what} cancelled.`, 'info');
  // A cancelled *active* download's checkInstall() runs when its promise
  // rejects; a cancelled *paused* download has no pending promise, so restore
  // the view here.
  if (wasPaused) checkInstall();
});

// Pause / Resume toggle.
$('btnPauseDl')?.addEventListener('click', () => {
  // Hidden for a download that can't be continued, and a press that lands
  // anyway does nothing: the backend lets it go and the download carries on.
  if (!isPaused && !dlResumable) return;
  if (isPaused) {
    // Resume — re-invoke the download, which continues from the .part file
    // (whether it was paused this session or left over from a previous run).
    runClientDownload({ resuming: true });
  } else if (isDownloading) {
    // Pause — the backend stops the loop and keeps the partial file. The UI
    // flips to the paused state when the 'paused' event / Paused result lands;
    // update the label now so the click feels responsive.
    window.radium?.pauseDownload();
    addLog('Pausing download...', 'info', 'install');
    const b = $('btnPauseDl'); if (b) b.textContent = '▶ Resume';
  }
});

// Reinstall logic with Modal
const reinstallModal = $('reinstallModal');
const closeReinstallModal = () => hideModal(reinstallModal);
$('reinstallCancelBtn')?.addEventListener('click', closeReinstallModal);
$('reinstallModalClose')?.addEventListener('click', closeReinstallModal);
$('reinstallModal')?.addEventListener('click', (e) => {
  if (e.target === reinstallModal) {
    closeReinstallModal();
  }
});

$('btnReinstall')?.addEventListener('click', () => {
  if (isDownloading) {
    toast('Download already in progress.', 'error');
    return;
  }
  if (isGameRunning) {
    toast('Cannot reinstall while the game is running.', 'error');
    return;
  }
  // Show the current install directory in the modal so the user can confirm
  const dirSpan = $('reinstallModalInstallDir');
  if (dirSpan) {
    dirSpan.textContent = shownInstallDir();
  }
  showModal(reinstallModal);
});

$('reinstallConfirmBtn')?.addEventListener('click', () => {
  closeReinstallModal();
  const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
  document.body.classList.remove('client-installed');
  // The gear that opens it lives in the installed-only bar and has just
  // disappeared; an open menu would be left hanging over the download CTA.
  closeManageMenu();
  isInstalled = false;
  addLog('Reinstall initiated.', 'info', 'install');
  toast('Starting reinstall...', 'info');
  $('btnDownload')?.click();
});

// ─── Verify Files ────────────────────────────────────────────────────────────
// Steam's "Verify integrity of game files". Every installed file is read back
// and checked against the size and CRC-32 its zip recorded at install, and
// the ones that fail are fetched again (verify.rs). It borrows the download
// panel and `isDownloading`, so everything a download blocks, it blocks too.

const verifyModal = $('verifyModal');
let verifyModalAnswer = null;

/// Ask a Verify Files question. Resolves true for the confirm button and
/// false for anything else that closes the dialog.
function askVerify({ title, lead, text, confirm = 'OK', cancel = 'Cancel' }) {
  $('verifyModalTitle').textContent = title;
  $('verifyModalLead').textContent = lead;
  $('verifyModalText').textContent = text;
  $('verifyModalConfirm').textContent = confirm;
  $('verifyModalCancel').textContent = cancel;
  verifyModalAnswer?.(false);
  showModal(verifyModal);
  return new Promise((resolve) => { verifyModalAnswer = resolve; });
}
function answerVerify(yes) {
  const answer = verifyModalAnswer;
  verifyModalAnswer = null;
  hideModal(verifyModal);
  answer?.(yes);
}
$('verifyModalConfirm')?.addEventListener('click', () => answerVerify(true));
$('verifyModalCancel')?.addEventListener('click', () => answerVerify(false));
$('verifyModalClose')?.addEventListener('click', () => answerVerify(false));
verifyModal?.addEventListener('click', (e) => { if (e.target === verifyModal) answerVerify(false); });

/// Put the download panel up for a check or a repair, its steps named `steps`.
function beginClientTask(kind, steps) {
  clientTask = kind;
  const ds = $('downloadSection'); if (ds) ds.style.display = 'flex';
  document.body.classList.remove('client-installed');
  // The gear that opens it lives in the installed-only bar, which is going.
  closeManageMenu();
  setDlStepLabels(...steps);
  setDownloadUI(true);
  const phaseEl = $('dlPhaseLabel');
  if (phaseEl) phaseEl.textContent = kind === 'verify' ? 'Verifying files...' : 'Repairing files...';
  setStatLabels('Files', 'Current File', 'ETA');
  for (const id of ['dlSpeedLabel', 'dlSizeLabel', 'dlEtaLabel']) { const el = $(id); if (el) el.textContent = '—'; }
}

/// Take the panel down again, and show the client as it now is.
async function endClientTask() {
  clientTask = null;
  isCancelling = false;
  setDownloadUI(false);
  setDlStepLabels();
  await checkInstall();
}

const VERIFY_PROBLEMS = { missing: 'missing', size: 'wrong size', content: 'changed', unreadable: "can't be read" };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function runVerifyFiles() {
  if (isDownloading || isPaused || isCancelling) {
    toast('Finish or cancel the current download first.', 'warn', 4000);
    return;
  }
  if (isGameRunning || isGameLaunching) {
    toast('Close the game before verifying its files.', 'warn', 4000);
    return;
  }
  const label = networkInfo().label;
  beginClientTask('verify', ['Verify', 'Repair', 'Done']);
  addLog(`Verifying ${label} game files...`, 'info', 'install');
  const started = Date.now();
  let result;
  try {
    result = await window.radium?.verifyClient();
  } catch (e) {
    result = { status: 'error', error: String(e) };
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (result?.status === 'ok') {
    addLog(`All ${result.checked} files validated in ${secs}s.`, 'ok', 'install');
    toast(`All ${result.checked} files successfully validated.`, 'ok', 5000);
    await endClientTask();
    return;
  }
  if (result?.status === 'cancelled') {
    addLog(`File check stopped after ${secs}s.`, 'info', 'install');
    await endClientTask();
    return;
  }
  if (result?.status === 'no-manifest') {
    await endClientTask();
    addLog(`This ${label} install has no file list to verify against; it predates Verify Files.`, 'warn', 'install');
    const reinstall = await askVerify({
      title: 'VERIFY FILES',
      lead: `This ${label} install has no file list to check against.`,
      text: "The launcher records every file's checksum when it installs a client, and this one was "
          + 'installed before it did. Reinstall once (the client is downloaded again) and Verify Files '
          + 'works from then on.',
      confirm: 'Reinstall',
      cancel: 'Not now',
    });
    // The question above was the confirmation, so straight to the reinstall.
    if (reinstall) $('reinstallConfirmBtn')?.click();
    return;
  }
  if (result?.status !== 'damaged') {
    const err = result?.error || 'Unknown error';
    addLog(`File check failed: ${err}`, 'error', 'install');
    toast(`File check failed: ${err}`, 'error', 5000);
    await endClientTask();
    return;
  }

  const damaged = result.damaged || [];
  addLog(`${damaged.length} of ${result.checked} files failed to validate (${formatBytes(result.damagedBytes || 0)}):`, 'warn', 'install');
  for (const f of damaged.slice(0, 20)) addLog(`  ${f.path}: ${VERIFY_PROBLEMS[f.problem] || f.problem}`, 'warn', 'install');
  if (damaged.length > 20) addLog(`  ...and ${damaged.length - 20} more.`, 'warn', 'install');
  toast(`${plural(damaged.length, 'file')} failed to validate and will be reacquired.`, 'warn', 5000);
  await runRepair(damaged.length);
}

/// Fetch again the files the check just failed. Single files where the
/// server allows it; otherwise, once asked, the whole client, taking only
/// those files from it.
async function runRepair(count) {
  const label = networkInfo().label;
  clientTask = 'repair';
  updateDlButtons();
  setDlStep('extract');
  const phaseEl = $('dlPhaseLabel'); if (phaseEl) phaseEl.textContent = 'Repairing files...';
  let r;
  try {
    r = await window.radium?.repairClient(false);
  } catch (e) {
    r = { success: false, error: String(e) };
  }

  if (r?.needsFullDownload) {
    await endClientTask();
    const size = r.total ? formatBytes(r.total) : (activeNetwork === 'stella' ? 'about 4.7 GB' : 'the whole client');
    // Either way the repair reads the client only as far as the last damaged
    // file. With the files' places in the zip recorded at install, how far
    // that is is known up front; without, it is found on the way.
    const text = r.needed
      ? `${label}'s server can't send single files, so the repair reads the client from the start and stops `
        + `once it has the damaged ones: about ${formatBytes(r.needed)} of ${size}. Only those files are replaced.`
      : `${label}'s server can't send single files, so the repair reads the client from the start and stops `
        + `once it has the damaged ones. This install doesn't record where they are in the ${size} download, `
        + "so how much that is shows as it goes, and it's all of it only if one is near the end. "
        + 'Only those files are replaced.';
    const go = await askVerify({
      title: 'REPAIR FILES',
      lead: `${plural(count, 'file')} failed to validate.`,
      text,
      confirm: r.needed ? `Download ${formatBytes(r.needed)} and repair` : 'Repair',
    });
    if (!go) {
      addLog('Repair skipped. Run Verify Files again to repair.', 'info', 'install');
      return;
    }
    beginClientTask('repair', ['Download', 'Repair', 'Done']);
    addLog(r.needed
      ? `Reading the first ${formatBytes(r.needed)} of the ${label} client to repair ${plural(count, 'file')}...`
      : `Reading the ${label} client from the start, as far as needed, to repair ${plural(count, 'file')}...`, 'info', 'install');
    try {
      r = await window.radium?.repairClient(true);
    } catch (e) {
      r = { success: false, error: String(e) };
    }
  }

  if (r?.success) {
    addLog(`Repaired ${plural(r.repaired, 'file')}.`, 'ok', 'install');
    toast(`Repaired ${plural(r.repaired, 'file')}. ${label} is ready to play.`, 'ok', 5000);
  } else if (r?.error === 'Cancelled') {
    addLog('Repair stopped; the damaged files were left as they were. Run Verify Files to try again.', 'info', 'install');
  } else {
    const err = r?.error || 'Unknown error';
    addLog(`Repair failed: ${err}`, 'error', 'install');
    toast(`Repair failed: ${err}`, 'error', 6000);
  }
  await endClientTask();
}

$('btnVerifyFiles')?.addEventListener('click', () => {
  closeManageMenu();
  runVerifyFiles();
});

// Stop Game logic with Modal
const stopGameModal = $('stopGameModal');
const closeStopGameModal = () => hideModal(stopGameModal);
$('stopGameCancelBtn')?.addEventListener('click', closeStopGameModal);
$('stopGameModalClose')?.addEventListener('click', closeStopGameModal);
$('stopGameConfirmBtn')?.addEventListener('click', async () => {
  closeStopGameModal();
  addLog('User confirmed stop game request. Killing game process...', 'info', 'game');
  toast(`Stopping ${networkInfo().label}...`, 'info', 2000);
  await window.radium?.killGame();
  setGameRunning(false);
});
$('stopGameModal')?.addEventListener('click', (e) => {
  if (e.target === stopGameModal) {
    closeStopGameModal();
  }
});
function showStopGameModal() {
  showModal(stopGameModal);
}

// Uninstall logic with Modal
const uninstallModal = $('uninstallModal');
const closeUninstallModal = () => hideModal(uninstallModal);
$('uninstallCancelBtn')?.addEventListener('click', closeUninstallModal);
$('uninstallModalClose')?.addEventListener('click', closeUninstallModal);

$('btnUninstall')?.addEventListener('click', () => {
  if (isGameRunning) {
    toast('Cannot uninstall while the game is running.', 'error');
    return;
  }
  showModal(uninstallModal);
});

$('uninstallConfirmBtn')?.addEventListener('click', async () => {
  closeUninstallModal();
  addLog('Uninstalling client...', 'info', 'install');
  toast('Uninstalling...', 'info');

  const result = await window.radium?.uninstallClient();
  if (result?.success) {
    addLog('Client uninstalled successfully.', 'ok', 'install');
    toast(`${networkInfo().label} client uninstalled.`, 'ok');
    await loadConfig();
    await checkInstall();
  } else {
    const err = result?.error || 'Unknown error';
    addLog(`Uninstall failed: ${err}`, 'error', 'install');
    toast(`Uninstall failed: ${err}`, 'error');
  }
});

// Open client folder button
$('btnOpenFolder')?.addEventListener('click', async () => {
  addLog('Opening client folder...', 'info', 'install');
  const ok = await window.radium?.openClientFolder();
  if (ok) {
    toast('Client folder opened!', 'ok');
  } else {
    toast('Failed to open client folder (does it exist?).', 'error');
  }
});

/// Open / change / reset act on the network named by the clicked button, not
/// on the active one — that is what lets Vanilla's folder be set while Radium
/// is selected, and the other way round.
function installRowNetwork(btn, attr) {
  const name = btn.getAttribute(attr);
  return NETWORKS[name] ? name : activeNetwork;
}

/// A folder change only invalidates launcher state when it moved the client
/// the launcher is currently pointed at.
async function afterInstallDirChange(network) {
  if (network !== activeNetwork) return;
  // The client at this new location may be a different install entirely — any
  // cached update-check result is meaningless here, so force a fresh check.
  clientUpdateInfo = null;
  clientUpdateAutoChecked = false;
  await checkInstall();
}

document.querySelectorAll('[data-open-folder]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const network = installRowNetwork(btn, 'data-open-folder');
    const label = networkInfo(network).label;
    addLog(`Opening ${label} client folder from settings...`, 'info', 'install');
    const ok = await window.radium?.openClientFolder(network);
    if (ok) {
      toast(`${label} client folder opened!`, 'ok');
    } else {
      toast(`Failed to open the ${label} client folder (does it exist?).`, 'error');
    }
  });
});

document.querySelectorAll('[data-change-folder]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const network = installRowNetwork(btn, 'data-change-folder');
    const label = networkInfo(network).label;
    addLog(`Selecting ${label} install directory...`, 'info', 'install');
    const newDir = await window.radium?.selectFolder(network);
    if (!newDir) {
      addLog(`${label} install directory selection cancelled.`, 'info', 'install');
      return;
    }
    // The backend refuses to let both networks resolve to one folder, or to
    // one inside the other — they install different games from different
    // sources, so a shared folder means each download overwrites the other's
    // client, and the install check (which searches beneath the folder) finds
    // the other network's game in a folder that holds it. It silently clears
    // the colliding entry on the next config read, so catch it here instead
    // and leave the user's existing setting alone.
    // The client goes in the network's own subfolder of the pick, which is
    // what gets checked and shown. The pick itself is what gets saved.
    let clientDir = newDir;
    try {
      clientDir = (await window.radium?.resolveClientDir(network, newDir)) || newDir;
    } catch (e) {
      console.error('resolveClientDir error:', e);
    }
    const clash = overlappingInstallDir(network, clientDir);
    if (clash) {
      const otherLabel = networkInfo(clash.network).label;
      const why = normDir(clash.dir) === normDir(clientDir) ? 'is already' : 'overlaps';
      toast(`That folder ${why} ${otherLabel}'s install location. Pick a different one.`, 'error', 4000);
      addLog(`Rejected ${label} install directory: ${clientDir} ${why} ${otherLabel}'s (${clash.dir}).`, 'warn', 'install');
      return;
    }

    const span = installDirSpan(network);
    if (!span) return;
    span.textContent = clientDir;
    setConfigInstallDir(newDir, network);
    const ok = await window.radium?.saveConfig(config);
    if (ok) {
      toast(`${label} install location updated and saved!`, 'ok');
      addLog(`Selected and saved ${label} install directory: ${clientDir}`, 'info', 'install');
    } else {
      toast(`Failed to save the ${label} install location.`, 'error');
    }
    await afterInstallDirChange(network);
  });
});

document.querySelectorAll('[data-reset-folder]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const network = installRowNetwork(btn, 'data-reset-folder');
    const label = networkInfo(network).label;
    addLog(`Resetting ${label} install directory...`, 'info', 'install');
    const defaultDir = await window.radium?.getDefaultClientDir(network);
    if (!defaultDir) return;
    const span = installDirSpan(network);
    if (!span) return;
    span.textContent = defaultDir;
    // Stored as "" rather than the resolved path: an empty slot means "use
    // this network's default", so a reset keeps tracking the default instead
    // of pinning a literal path a later network switch could misapply.
    setConfigInstallDir('', network);
    const ok = await window.radium?.saveConfig(config);
    if (ok) {
      toast(`${label} install location reset and saved!`, 'ok');
      addLog(`Reset and saved ${label} install directory: ${defaultDir}`, 'info', 'install');
    } else {
      toast(`Failed to save the reset ${label} location.`, 'error');
    }
    await afterInstallDirChange(network);
  });
});

// Exclude AV Warning Modal Actions
function showExcludeAvModal() {
  showModal($('excludeAvModal'));
}

function hideExcludeAvModal() {
  hideModal($('excludeAvModal'));
  launchAfterExclusion = false; // Reset whenever the modal is hidden
  isGameLaunching = false;
}

$('excludeAvModalClose')?.addEventListener('click', hideExcludeAvModal);
$('btnExcludeAvCancel')?.addEventListener('click', hideExcludeAvModal);
$('btnExcludeAvAnyway')?.addEventListener('click', async () => {
  hideModal($('excludeAvModal'));
  launchAfterExclusion = false; // Reset since we are launching now anyway
  await proceedAfterAvCheck();
});
$('excludeAvModal')?.addEventListener('click', (e) => {
  if (e.target === $('excludeAvModal')) {
    hideExcludeAvModal();
  }
});

/// Set the Exclude AV menu row's label without touching the rest of the row.
///
/// The button holds an icon and a <span> for its text. Assigning its
/// textContent, which every caller used to do, replaced both with bare text —
/// so after the config loaded the row lost its icon and its text fell out of
/// line with the other rows in the manage menu.
function setExcludeAvLabel(excluded) {
  const btn = $('btnExcludeAv');
  if (!btn) return;
  const label = excluded ? 'UNExclude AV' : 'Exclude AV';
  const span = btn.querySelector('span');
  if (span) span.textContent = label;
  else btn.textContent = label;
}

async function executeExcludeAv() {
  const btn = $('btnExcludeAv');
  if (!btn) return;
  addLog('Requesting Windows Defender exclusion for client folder...', 'info', 'game');
  toast('Please approve the Administrator prompt...', 'info');
  const result = await window.radium?.addDefenderExclusion();
  if (result && result.success) {
    setAvExcluded(true);
    await window.radium?.saveConfig(config);
    setExcludeAvLabel(true);
    toast('Defender exclusion added!', 'ok');
    addLog('Exclusion successfully added to Windows Defender.', 'ok', 'game');
    
    // Check if we need to proceed to Smart App Control and Steam check and launch
    if (launchAfterExclusion) {
      launchAfterExclusion = false;
      await proceedAfterAvCheck();
    }
  } else {
    const err = result?.error || 'UAC elevation cancelled or failed';
    toast('Failed to add exclusion.', 'error');
    addLog(`Exclusion failed: ${err}`, 'error', 'game');
    launchAfterExclusion = false;
    isGameLaunching = false;
  }
}

$('btnExcludeAvConfirm')?.addEventListener('click', () => {
  // Set display directly to avoid resetting launchAfterExclusion inside hideExcludeAvModal
  hideModal($('excludeAvModal'));
  executeExcludeAv();
});

/// Every folder an antivirus has to leave alone for the active network: the
/// client folder, plus Stella's patch folder (the same pair the Defender
/// exclusion covers; see `exclusion_dirs` in defender.rs).
function avExclusionFolders() {
  const folders = [shownInstallDir()];
  if (activeNetwork === 'stella' && stellaPatchDir) folders.push(stellaPatchDir);
  return folders.filter(Boolean);
}

// Third-Party AV Warning Modal Actions
function showThirdPartyAvModal(thirdPartyAvs) {
  const m = $('thirdPartyAvModal');
  if (!m) return;

  const avNames = $('detectedAvNames');
  if (avNames) {
    // Dedup names defensively (the backend already dedups).
    avNames.textContent = [...new Set(thirdPartyAvs.map(av => av.name))].join(', ');
  }

  const folders = avExclusionFolders();
  const clientPathCode = $('tpClientFolderPath');
  if (clientPathCode) {
    clientPathCode.textContent = folders.join('\n');
  }
  const intro = $('tpFolderIntro');
  if (intro) {
    const label = networkInfo().label;
    intro.textContent = folders.length > 1
      ? `both ${label} folders below (the game, and the patch it needs)`
      : `the ${label} client folder`;
  }

  // The primary button doubles as "continue to launch" (from the Play flow) and
  // "acknowledge" (from the manual Exclude AV button). Only say "Launch Anyway"
  // when a launch is actually pending.
  const anywayBtn = $('btnThirdPartyAvAnyway');
  if (anywayBtn) anywayBtn.textContent = launchAfterExclusion ? 'Launch Anyway' : 'OK, Got It';

  // Reflect the saved "don't warn again on launch" choice.
  const dontWarn = $('tpDontWarnAgain');
  if (dontWarn) dontWarn.checked = config.thirdPartyAvAcknowledged === true;

  showModal(m);
}

function hideThirdPartyAvModal() {
  hideModal($('thirdPartyAvModal'));
  launchAfterExclusion = false; // Reset whenever the modal is hidden
  isGameLaunching = false;
}

$('thirdPartyAvModalClose')?.addEventListener('click', hideThirdPartyAvModal);
$('btnThirdPartyAvCancel')?.addEventListener('click', hideThirdPartyAvModal);

$('btnCopyTpPath')?.addEventListener('click', async () => {
  const folders = avExclusionFolders();
  if (folders.length) {
    try {
      await navigator.clipboard.writeText(folders.join('\n'));
      toast(folders.length > 1 ? 'Folder paths copied!' : 'Client folder path copied!', 'ok');
    } catch (e) {
      toast('Failed to copy path.', 'error');
    }
  }
});

$('btnThirdPartyAvOpenFolder')?.addEventListener('click', async () => {
  const ok = await window.radium?.openClientFolder();
  if (ok) {
    toast('Client folder opened!', 'ok');
  } else {
    toast('Failed to open folder.', 'error');
  }
});

$('btnThirdPartyAvAnyway')?.addEventListener('click', async () => {
  hideModal($('thirdPartyAvModal'));

  // Persist only the "don't warn again on launch" choice. We intentionally do
  // NOT set defenderExcluded — a third-party AV can't be auto-excluded, so the
  // Exclude AV button must stay "Exclude AV" (guidance-only), never flip to
  // "UNExclude AV" and never trigger a Defender removal.
  const dontWarn = $('tpDontWarnAgain');
  config.thirdPartyAvAcknowledged = !!(dontWarn && dontWarn.checked);
  await window.radium?.saveConfig(config);

  addLog(config.thirdPartyAvAcknowledged
    ? 'Third-party AV acknowledged — launch warning disabled.'
    : 'Third-party AV warning dismissed.', 'info', 'game');

  if (launchAfterExclusion) {
    launchAfterExclusion = false;
    await proceedAfterAvCheck();
  }
});

$('thirdPartyAvModal')?.addEventListener('click', (e) => {
  if (e.target === $('thirdPartyAvModal')) {
    hideThirdPartyAvModal();
  }
});

$('btnExcludeAv')?.addEventListener('click', async () => {
  const btn = $('btnExcludeAv');
  if (!btn) return;

  const isCurrentlyExcluded = avExcluded();

  if (isCurrentlyExcluded) {
    // The "excluded" flag covers two different situations:
    //  • a real Windows Defender exclusion was added (Defender-only machine), or
    //  • a third-party AV was merely acknowledged (nothing was added to Defender).
    // Only the first case has a Defender exclusion to remove. For a third-party
    // AV there is nothing to Remove-MpPreference, so skip the pointless UAC
    // prompt and just clear the acknowledgement locally.
    let avs = [];
    try {
      avs = await window.radium?.detectAntivirus() || [];
    } catch (e) {
      console.error('detectAntivirus error:', e);
    }
    const hasThirdParty = avs.some(av => !av.isDefender);

    if (hasThirdParty) {
      setAvExcluded(false);
      await window.radium?.saveConfig(config);
      setExcludeAvLabel(false);
      toast('AV acknowledgement cleared.', 'ok');
      addLog('Third-party AV acknowledgement cleared (no Defender exclusion to remove).', 'info', 'game');
      return;
    }

    addLog('Requesting Windows Defender exclusion removal for client folder...', 'info', 'game');
    toast('Please approve the Administrator prompt...', 'info');
    const result = await window.radium?.removeDefenderExclusion();
    if (result && result.success) {
      setAvExcluded(false);
      await window.radium?.saveConfig(config);
      setExcludeAvLabel(false);
      toast('Defender exclusion removed!', 'ok');
      addLog('Exclusion successfully removed from Windows Defender.', 'ok', 'game');
    } else {
      const err = result?.error || 'UAC elevation cancelled or failed';
      toast('Failed to remove exclusion.', 'error');
      addLog(`Exclusion removal failed: ${err}`, 'error', 'game');
    }
  } else {
    // Detect third party AV
    const avs = await window.radium?.detectAntivirus() || [];
    const thirdPartyAvs = avs.filter(av => !av.isDefender);
    if (thirdPartyAvs.length > 0) {
      showThirdPartyAvModal(thirdPartyAvs);
    } else {
      executeExcludeAv();
    }
  }
});

// Play mode configuration
function setModeUI(mode) {
  $('modeScreen')?.classList.toggle('active', mode === 'screen');
  $('modeVR')?.classList.toggle('active',     mode === 'vr');
  const wrap = document.querySelector('.mode-toggle-wrap');
  if (wrap) {
    wrap.classList.toggle('vr-active', mode === 'vr');
  }
}

function updateQsMode() {
  // Mode display placeholder for future quick stats card
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    playMode = btn.dataset.mode;
    config.playMode = playMode;
    setModeUI(playMode);
    updateQsMode();
    window.radium?.saveConfig(config);
    toast(`Mode: ${playMode.toUpperCase()}`, 'info', 1500);
    addLog(`Play mode set to ${playMode}.`, 'info', 'game');
  });
});

// Periodically ping server and update status labels
async function checkServerStatus(silent = false) {
  // Radium's API host is user-configurable; Vanilla's is fixed. The CDN check
  // is Radium's download host, so it is only meaningful there.
  const isRadium = activeNetwork === 'radium';
  const apiUrl = isRadium
    ? (config.apiUrl || 'https://api.radie.app/')
    : { vanilla: 'https://api.vanillarec.net', stella: 'https://api.stellaonline.org' }[activeNetwork];
  const cdnUrl = 'https://cdn.recroomarchive.org';

  // Immediately show CHECKING... in quick stats while pings are in-flight
  const qsS = $('qsStatus');
  if (qsS) qsS.textContent = 'CHECKING...';

  if (!silent) addLog('Checking server status...', 'info', 'server');

  // Run both pings in parallel — max wait is 5s instead of 10s
  let apiResult, cdnResult;
  try {
    [apiResult, cdnResult] = await Promise.all([
      window.radium?.pingServer(apiUrl),
      isRadium ? window.radium?.pingServer(cdnUrl) : Promise.resolve(null),
    ]);
  } catch (e) {
    console.error('pingServer error:', e);
  }

  const apiOnline = apiResult?.online ?? false;
  // Tri-state: null means "not applicable to this network", which the bug
  // reporter renders differently from a real offline.
  const cdnOnline = isRadium ? (cdnResult?.online ?? false) : null;
  lastServerStatus = { apiOnline, cdnOnline };

  // Quick stats card on home tab
  if (qsS) qsS.textContent = apiOnline ? 'ONLINE' : 'OFFLINE';
  const qscS = $('qsc-status');
  if (qscS) {
    qscS.classList.toggle('online',  apiOnline);
    qscS.classList.toggle('offline', !apiOnline);
  }

  if (!silent) {
    // A server being unreachable is a status, not a launcher error — log it as a
    // warning so genuine errors stay distinct in the log.
    addLog(`API Gateway (${apiUrl}): ${apiOnline ? 'ONLINE' : 'OFFLINE'}`, apiOnline ? 'ok' : 'warn', 'server');
    if (isRadium) {
      addLog(`CDN Server (${cdnUrl}): ${cdnOnline ? 'ONLINE' : 'OFFLINE'}`, cdnOnline ? 'ok' : 'warn', 'server');
    }
  }
}

// Periodically fetch player count and update stats card
/// While Stella's count is still settling, it is asked for again sooner than
/// the minute-long poll.
let playerCountRetry = null;
/// Bumped by every count asked for, so an answer that arrives after a newer
/// question — the network switched while a slow API was being asked — is
/// dropped rather than painted over the newer one.
let playerCountSeq = 0;

async function updatePlayerCount(silent = false) {
  const qsPlayers = $('qsPlayers');
  const qscPlayers = $('qsc-players');
  if (!qsPlayers) return;
  clearTimeout(playerCountRetry);
  const seq = ++playerCountSeq;
  if (!silent) {
    qsPlayers.textContent = 'LOADING...';
    addLog('Fetching online player count...', 'info', 'server');
  }

  try {
    const result = await window.radium?.getPlayerCount();
    if (seq !== playerCountSeq) return;
    // Stella isn't counting while the launcher is hidden or minimized: keep
    // the card as it was until the window is back (see stella_api::in_use).
    if (activeNetwork === 'stella' && result?.idle) return;
    // Stella's count comes from its live presence (stella_hub.rs), which has
    // states the other networks' counts don't.
    if (activeNetwork === 'stella' && result && !result.success && (result.counting || result.paused || result.signedOut)) {
      qscPlayers?.classList.remove('online', 'offline');
      if (result.counting) {
        // A floor that rises as players are heard from; settled after a
        // minute, when the "+" goes. Stella reports each player every half
        // minute or so.
        qsPlayers.textContent = result.soFar > 0 ? `${result.soFar}+` : 'COUNTING...';
        // Not while hidden: the count isn't kept then, and coming back on
        // screen asks again anyway.
        playerCountRetry = setTimeout(() => { if (!document.hidden) updatePlayerCount(true); }, 10000);
      } else if (result.paused) {
        // One sign-in at a time can listen for players, and the game is
        // using it; this comes back when the game closes.
        qsPlayers.textContent = 'PAUSED';
      } else {
        qsPlayers.textContent = 'LOG IN';
      }
      return;
    }
    if (result?.unsupported) {
      // Stella publishes no player count: say so, rather than OFFLINE.
      qsPlayers.textContent = 'N/A';
      qscPlayers?.classList.remove('online', 'offline');
      if (!silent) addLog(`${networkInfo().label} doesn't publish a player count.`, 'info', 'server');
    } else if (result && result.success) {
      qsPlayers.textContent = result.count;
      if (qscPlayers) {
        qscPlayers.classList.add('online');
        qscPlayers.classList.remove('offline');
      }
      if (!silent) addLog(`Players online: ${result.count}`, 'ok', 'server');
    } else {
      qsPlayers.textContent = 'OFFLINE';
      if (qscPlayers) {
        qscPlayers.classList.add('offline');
        qscPlayers.classList.remove('online');
      }
      if (!silent) addLog(`Failed to fetch player count: ${result?.error || 'Unknown error'}`, 'error', 'server');
    }
  } catch (err) {
    if (seq !== playerCountSeq) return;
    qsPlayers.textContent = 'OFFLINE';
    if (qscPlayers) {
      qscPlayers.classList.add('offline');
      qscPlayers.classList.remove('online');
    }
    if (!silent) addLog(`Failed to fetch player count: ${err?.message || err}`, 'error', 'server');
  }
}

// Game execution and process monitoring
function setGameRunning(running) {
  isGameRunning = running;
  if (running) {
    isGameLaunching = false;
    revealOnModal = false;
  }
  syncTray();
  const btn = $('btnPlay');
  if (running) {
    btn?.classList.add('running');
    const pt = $('playText'); if (pt) pt.textContent = 'STOP';
    const pi = $('playIcon'); if (pi) pi.textContent = '■';
  } else {
    btn?.classList.remove('running');
    const pt = $('playText'); if (pt) pt.textContent = 'PLAY';
    const pi = $('playIcon'); if (pi) pi.textContent = '▶';
  }
}

// Steam Modal actions
function showSteamModal() {
  showModal($('steamModal'));
}

function hideSteamModal(cancelLaunch = true) {
  hideModal($('steamModal'));
  if (cancelLaunch) isGameLaunching = false;
}

$('steamModalClose')?.addEventListener('click', () => hideSteamModal(true));
$('steamModal')?.addEventListener('click', (e) => {
  if (e.target === $('steamModal')) {
    hideSteamModal(true);
  }
});

// Final gate before launching: make sure the required Rec Room Steam app
// (steam://install/92) is installed. If it already is, this is invisible.
async function executeLaunch() {
  // Codename Gordon is what the older clients lean on for Steam; Stella's
  // 2024 client doesn't need it.
  if (config.disableWarnings !== true && activeNetwork !== 'stella') {
    let installed = true;
    try {
      installed = await window.radium?.checkRequiredSteamApp();
    } catch (e) { /* on error, don't block launch */ }
    if (installed === false) {
      addLog('Required Rec Room Steam app (steam://install/92) is not installed. Prompting user...', 'info', 'game');
      showSteamAppModal();
      return;
    }
  }
  await doLaunch();
}

function showSteamAppModal() {
  showModal($('steamAppModal'));
}
function hideSteamAppModal(cancelLaunch = true) {
  hideModal($('steamAppModal'));
  if (cancelLaunch) isGameLaunching = false;
}
$('steamAppModalClose')?.addEventListener('click', () => hideSteamAppModal(true));
$('steamAppCancelBtn')?.addEventListener('click', () => hideSteamAppModal(true));
$('steamAppModal')?.addEventListener('click', (e) => {
  if (e.target === $('steamAppModal')) hideSteamAppModal(true);
});
$('steamAppInstallBtn')?.addEventListener('click', () => {
  addLog('Opening Steam to install the required app...', 'info', 'game');
  toast('Opening Steam to install…', 'info', 3000);
  window.radium?.openUrl('steam://install/92');
  hideSteamAppModal(true);
});
$('steamAppAnywayBtn')?.addEventListener('click', () => {
  hideSteamAppModal(false);
  doLaunch();
});

/// Where the next launch goes on Stella, used up by that launch: a friend
/// (`{ id, name }`, from their JOIN; with `ask`, one in a private room, who is
/// sent a join request once the game is in) or a room (`{ room, name }`, from
/// the room's PLAY). See joinStellaFriend() and playStellaRoom().
let pendingJoin = null;

async function doLaunch() {
  setGameRunning(true);
  const join = activeNetwork === 'stella' ? pendingJoin : null;
  pendingJoin = null;
  addLog(join ? `Launching game to join ${join.name}...` : 'Launching game...', 'info', 'game');
  toast(join ? `Launching ${networkInfo().label} to join ${join.name}...` : `Launching ${networkInfo().label}...`, 'info', 2000);

  let result = null;
  try {
    // Only what launch_game reads (the shim adds `network`). Spreading the
    // whole config also sent the glass backdrop — up to 1.4 MB — on every PLAY.
    result = await window.radium?.launchGame({
      playMode,
      gameExePath: config.gameExePath || '',
      minimizeOnLaunch: config.minimizeOnLaunch === true,
      closeOnLaunch: config.closeOnLaunch === true,
      joinPlayerId: join?.ask ? null : (join?.id ?? null),
      joinRoomName: join?.room ?? null,
      requestJoinPlayerId: join?.ask ? join.id : null,
    });
  } catch (e) {
    console.error('launchGame error:', e);
    result = { success: false, error: e.toString() };
  }

  isGameLaunching = false;
  if (!result?.success) {
    setGameRunning(false);
    const err = result?.error || 'Unknown error';
    addLog(`Launch failed: ${err}`, 'error', 'game');
    toast(`Launch failed: ${err}`, 'error', 5000);
  } else {
    // .bat launches report no PID (the cmd.exe wrapper's PID is meaningless).
    const pidPart = (result.pid !== null && result.pid !== undefined) ? ` (PID ${result.pid})` : '';
    addLog(`Game running${pidPart} — mode: ${playMode}`, 'ok', 'game');
    toast(`${networkInfo().label} launched in ${playMode.toUpperCase()} mode!`, 'ok');
    // launch_game has already hidden the window (tray mode) or quit; this
    // only logs it. It also used to close the window again a second later,
    // which in tray mode was a second hide, and a second "launcher hidden"
    // for the page to react to.
    if (config.closeOnLaunch === true) {
      addLog(config.runInBackground !== false
        ? 'Launcher set to step aside on game start. Hidden to the tray.'
        : 'Launcher configured to exit on game start. Exiting...', 'info', 'game');
    }
  }
}

$('steamAnywayBtn')?.addEventListener('click', () => {
  hideSteamModal(false);
  executeLaunch();
});

$('steamLaunchBtn')?.addEventListener('click', async () => {
  hideSteamModal(false);
  addLog('Launching Steam...', 'info', 'game');
  toast('Launching Steam...', 'info', 2000);
  window.radium?.openUrl('steam://');
  
  // Wait 3 seconds to let Steam start initializing before starting the game
  addLog('Waiting for Steam to start (3s)...', 'info', 'game');
  setTimeout(() => {
    executeLaunch();
  }, 3000);
});

async function checkSteamAndLaunch() {
  addLog('Checking if Steam is running...', 'info', 'game');
  const steamRunning = await window.radium?.checkSteam();

  if (steamRunning) {
    addLog('Steam is running.', 'ok', 'game');
    executeLaunch();
  } else {
    if (config.disableWarnings === true) {
      addLog('Steam is not running. Warning skipped (disabled by user).', 'info', 'game');
      executeLaunch();
    } else {
      addLog('Steam is not running. Prompting user...', 'info', 'game');
      showSteamModal();
    }
  }
}

async function proceedAfterAvCheck() {
  await checkSacAndLaunch();
}

// Launch-time antivirus check: offer to exclude the client folder from
// Windows Defender (or warn about a third-party AV) before launching, so the
// game's patched files aren't quarantined. Flows into the Smart App Control
// check, then the Steam check, then the actual launch.
async function checkAvAndLaunch() {
  if (config.disableWarnings === true) {
    addLog('AV exclusion check skipped (disabled by user).', 'info', 'game');
    await proceedAfterAvCheck();
    return;
  }

  let avs = [];
  try {
    avs = await window.radium?.detectAntivirus() || [];
  } catch (e) {
    console.error('detectAntivirus error:', e);
  }

  const thirdPartyAvs = avs.filter(av => !av.isDefender);
  if (thirdPartyAvs.length > 0) {
    // Third-party AV can't be auto-excluded — only a manual folder exclusion in
    // the AV itself helps. Warn (with a manual guide) unless the user opted out.
    if (config.thirdPartyAvAcknowledged === true) {
      addLog('Third-party AV present; launch warning suppressed by user.', 'info', 'game');
      await proceedAfterAvCheck();
      return;
    }
    addLog('Third-party antivirus detected. Prompting user...', 'info', 'game');
    launchAfterExclusion = true;
    showThirdPartyAvModal(thirdPartyAvs);
    return;
  }

  // Windows Defender path — this one CAN be auto-excluded.
  if (avExcluded()) {
    await proceedAfterAvCheck();
    return;
  }
  if (avs.some(av => av.isDefender)) {
    addLog('Windows Defender active and folder not excluded. Prompting user...', 'info', 'game');
    launchAfterExclusion = true;
    showExcludeAvModal();
    return;
  }

  // No antivirus detected — nothing to exclude.
  addLog('No antivirus requiring exclusion detected.', 'ok', 'game');
  await proceedAfterAvCheck();
}

// ── Press feedback that survives a quick click ───────────────────────────
// `:active` only lasts while the button is held. A fast click lets go within a
// frame or two, before the press transition has moved at all, so the big
// buttons seemed to ignore the click. `.is-pressed` holds the same press styles
// (every skin lists it beside :active) for at least PRESS_MIN_MS.

const PRESS_MIN_MS = 170;
const PRESSABLE = '.btn-play, .btn-download-big, .room-play-btn';
const pressTimers = new WeakMap();

function holdPressed(btn, heldSince) {
  clearTimeout(pressTimers.get(btn));
  btn.classList.add('is-pressed');
  return () => {
    const left = Math.max(0, PRESS_MIN_MS - (performance.now() - heldSince));
    pressTimers.set(btn, setTimeout(() => btn.classList.remove('is-pressed'), left));
  };
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const btn = e.target.closest?.(PRESSABLE);
  if (!btn || btn.disabled) return;
  const release = holdPressed(btn, performance.now());
  const done = () => {
    window.removeEventListener('pointerup', done);
    window.removeEventListener('pointercancel', done);
    release();
  };
  window.addEventListener('pointerup', done);
  window.addEventListener('pointercancel', done);
});

// Enter / Space fire `click` with no pointer at all (detail is 0).
document.addEventListener('click', (e) => {
  if (e.detail !== 0) return;
  const btn = e.target.closest?.(PRESSABLE);
  if (btn && !btn.disabled) holdPressed(btn, performance.now())();
});

$('btnPlay')?.addEventListener('click', async () => {
  if (isGameRunning) {
    showStopGameModal();
    return;
  }
  if (isGameLaunching || !isInstalled) return;
  if (stellaUpdateNeeded()) return;
  isGameLaunching = true;
  pendingJoin = null;

  // Full pre-launch safety chain: AV exclusion → Smart App Control → Steam →
  // launch.
  await checkAvAndLaunch();
});

/// Start Stella with `target` as where it goes (see pendingJoin), through the
/// same checks PLAY runs. `what` names it in the messages.
function launchStellaInto(target, what) {
  if (isGameRunning) {
    toast(`Stella is already running. Go to ${what} from the game.`, 'info', 5000);
    return;
  }
  if (isGameLaunching) return;
  if (!isInstalled) {
    toast('Download Stella first, from Home.', 'info');
    return;
  }
  if (stellaUpdateNeeded()) {
    toast("Stella's patch needs an update first. Press UPDATE on Home.", 'info', 5000);
    return;
  }
  isGameLaunching = true;
  pendingJoin = target;
  checkAvAndLaunch();
}

/// A room's PLAY on Stella: start the game in that room (`+roomname:`).
function playStellaRoom(room) {
  const name = String(room?.Name || '').replace(/^\^/, '');
  if (!name) return;
  launchStellaInto({ room: name, name: `^${name}` }, `^${name}`);
}

/// A friend's JOIN: start Stella straight into their room, through the same
/// checks PLAY runs. The game does the joining (`+join:<id>`, as Steam's "Join
/// Game" does), so whether they can be joined is the server's call.
///
/// One thing can be known first: whether the copy of the room they are in is
/// full. Stella then answers the game with "Room Full" and it lands the player
/// in their dorm, so that is asked before starting (see stella_join_check) and,
/// when it is full, a warning offers their own copy of the room instead.
let joinCheckBusy = false;
async function joinStellaFriend(friend) {
  if (activeNetwork !== 'stella' || !friend?.id) return;
  const name = friend.displayName || friend.userName || 'your friend';
  const go = () => launchStellaInto({ id: friend.id, name }, name);
  // Invited: a plain JOIN gets in, private room or not (see stellaInvites).
  if (stellaInvitedBy(friend.id)) {
    go();
    return;
  }
  if (friend.private) {
    askToJoinStellaFriend(friend, name);
    return;
  }
  // Nothing will start (launchStellaInto says why), so there's nothing to check.
  if (isGameRunning || isGameLaunching || !isInstalled || stellaUpdateNeeded() || joinCheckBusy) {
    if (!joinCheckBusy) go();
    return;
  }
  joinCheckBusy = true;
  let check = null;
  try {
    // A slow answer isn't worth holding the JOIN for: it goes ahead unchecked.
    check = await Promise.race([
      window.radium.stellaJoinCheck(friend.id, friend.roomId),
      sleep(5000).then(() => null)
    ]);
  } catch (e) {}
  joinCheckBusy = false;
  if (activeNetwork !== 'stella') return;
  if (check?.known && check.full) {
    showRoomFullModal(friend, name, check);
    return;
  }
  go();
}

/// A friend in a private copy of a room can't be joined outright: Stella
/// answers the game "Room does not exist". So JOIN asks them instead, as the
/// game's "Request to Join" does, and their game answers with an invite.
/// With the game closed the invite comes to the launcher's own hub
/// connection and pops up with a JOIN of its own (showStellaInvite); once
/// invited, a plain JOIN gets in. If the hub can't be reached, nothing could
/// hear the invite, so Stella starts into the dorm and the launcher asks once
/// the game is in (stella_api::request_join_after_launch, answered as
/// onStellaJoinRequest), and the invite shows up in the game. With the game
/// already open, the request goes now and the invite shows up there.
async function askToJoinStellaFriend(friend, name) {
  if (isGameRunning) {
    try {
      await window.radium.stellaRequestJoin(friend.id);
      stellaJoinAsked(name);
    } catch (e) {
      stellaJoinNotAsked(name, e);
    }
    return;
  }
  // The game couldn't start to use an invite (launchStellaInto says why).
  if (isGameLaunching || !isInstalled || stellaUpdateNeeded()) {
    launchStellaInto({ id: friend.id, name }, name);
    return;
  }
  if (joinCheckBusy) return;
  joinCheckBusy = true;
  let res = null;
  let err = null;
  try {
    res = await window.radium.stellaAskToJoin(friend.id);
  } catch (e) {
    err = e;
  }
  joinCheckBusy = false;
  if (activeNetwork !== 'stella') return;
  if (err) {
    stellaJoinNotAsked(name, err);
    return;
  }
  if (res?.sent) {
    addLog(`Sent ${name} a join request.`, 'ok', 'game');
    toast(`Asked ${name} to let you in. Their invite will pop up here.`, 'ok', 6000);
    stellaAsked.set(Number(friend.id), Date.now());
    setTimeout(() => {
      if (!stellaAsked.has(Number(friend.id)) || stellaInvitedBy(friend.id)) return;
      stellaAsked.delete(Number(friend.id));
      toast(`${name} hasn't answered your join request.`, 'info', 5000);
    }, ASK_ANSWER_MS);
    return;
  }
  // A launcher that quits as the game starts can't wait for it to land; and
  // without an invite, `+join:` would only meet "Room does not exist".
  const quitsOnLaunch = config.closeOnLaunch === true && config.runInBackground === false;
  launchStellaInto(quitsOnLaunch ? { name } : { id: friend.id, name, ask: true }, name);
}

// Invites ─────────────────────────────────────────────────────────────────

/// When each player last invited the signed-in one, by id. An invite lets a
/// plain JOIN into that friend's room even when it's private (the user found,
/// 2026-10-04). How long one lasts on Stella isn't known, so it counts for
/// INVITE_FRESH_MS; past that, JOIN asks again.
const stellaInvites = new Map();
const INVITE_FRESH_MS = 10 * 60 * 1000;
/// Join requests waiting for an answer, by friend id, and how long one may.
const stellaAsked = new Map();
const ASK_ANSWER_MS = 45 * 1000;

/// Invites in Stella's notification list count from when they were sent, so
/// one that came while the launcher wasn't listening still lets JOIN in.
function noteStellaInvites(items) {
  for (const n of items) {
    if (n.type !== 6 || !n.senderId) continue;
    const at = Date.parse(n.sentTime || '');
    const id = Number(n.senderId);
    if (!isNaN(at) && at > (stellaInvites.get(id) || 0)) stellaInvites.set(id, at);
  }
}

function stellaInvitedBy(id) {
  const at = stellaInvites.get(Number(id));
  return at != null && Date.now() - at < INVITE_FRESH_MS;
}

/// An invite heard on the hub (with the game closed: the game hears its own).
function showStellaInvite(invite) {
  const id = Number(invite?.fromPlayerId);
  if (!id || activeNetwork !== 'stella') return;
  stellaInvites.set(id, Date.now());
  const answered = stellaAsked.delete(id);
  const friend = stellaFriendsById.get(id);
  const name = friend?.displayName || friend?.userName || 'A player';
  const room = String(invite.roomName || '');
  const where = !room ? 'their room' : /'s Dorm$/.test(room) ? room : `^${room}`;
  addLog(`${name} invited you to join them in ${where}.`, 'info', 'game');
  // Shown whatever the pop-up setting when it answers the player's own JOIN:
  // they are waiting for it.
  const prefs = notifPrefs();
  if (!prefs.popups && !answered) {
    toast(`${name} invited you to join them in ${where}. Press JOIN on their row to go.`, 'info', 8000);
    return;
  }
  window.radium.desktopNotify([{
    id: `stella-invite:${id}`,
    sender: null,
    icon: null,
    avatar: friend?.AvatarUrl ? thumbSrc(friend.AvatarUrl, avatarWidth(40)) : PLACEHOLDER_AVATAR,
    app: 'Stella',
    parts: [{ t: name, b: true }, { t: ` invited you to join them in ${where}.` }],
    action: 'JOIN',
    style: notifPopStyle(),
  }]).catch(() => {});
  if (prefs.sound) playNotifChime();
  refreshStellaFriends();
}
window.radium?.onStellaInvite?.(showStellaInvite);

/// JOIN on an invite's pop-up.
async function joinFromStellaInvite(id) {
  if (activeNetwork !== 'stella') {
    await setNetwork('stella');
    if (activeNetwork !== 'stella') return;
  }
  const friend = stellaFriendsById.get(Number(id));
  const name = friend?.displayName || friend?.userName || 'your friend';
  launchStellaInto({ id: Number(id), name }, name);
}

function stellaJoinAsked(name) {
  addLog(`Sent ${name} a join request.`, 'ok', 'game');
  toast(`Asked ${name} to let you in. Their invite will show up in the game.`, 'ok', 6000);
}

function stellaJoinNotAsked(name, err) {
  const why = String(err).trim().replace(/([^.!?])$/, '$1.');
  addLog(`Couldn't send ${name} a join request: ${why}`, 'error', 'game');
  toast(`Couldn't ask ${name} to let you in: ${why} You can still ask from the game's friends list.`, 'error', 7000);
}

window.radium?.onStellaJoinRequest?.((res) => {
  const friend = stellaFriendsById.get(Number(res?.playerId));
  const name = friend?.displayName || friend?.userName || 'your friend';
  if (res?.ok) stellaJoinAsked(name);
  else stellaJoinNotAsked(name, res?.error || 'Unknown error.');
});

/// The friend JOIN is waiting on this warning: `{ friend, name, room }`.
let roomFullJoin = null;

function showRoomFullModal(friend, name, check) {
  const room = String(friend.roomName || '').replace(/^[\^@]/, '');
  // Only a plain room name can be started into (`+roomname:`), so a dorm
  // ("abod124's Dorm") has no "play it yourself" button.
  const playable = /^[A-Za-z0-9_-]+$/.test(room);
  roomFullJoin = { friend, name, room: playable ? room : '' };
  $('roomFullTitle').textContent = `${name}'s room is full`;
  $('roomFullText').textContent = room
    ? `Their ${playable ? `^${room} room` : room} already has ${check.players} players, its limit. Stella will turn you away and send you to your dorm.`
    : `The room they're in already has ${check.players} players, its limit. Stella will turn you away and send you to your dorm.`;
  const play = $('roomFullPlayBtn');
  play.hidden = !playable;
  if (playable) play.textContent = `Play ^${room}`;
  play.setAttribute('aria-label', playable ? `Start Stella in your own ^${room} room` : '');
  showModal($('roomFullModal'));
}

function hideRoomFullModal() {
  roomFullJoin = null;
  hideModal($('roomFullModal'));
}
$('roomFullModalClose')?.addEventListener('click', hideRoomFullModal);
$('roomFullCancelBtn')?.addEventListener('click', hideRoomFullModal);
$('roomFullModal')?.addEventListener('click', (e) => {
  if (e.target === $('roomFullModal')) hideRoomFullModal();
});
$('roomFullAnywayBtn')?.addEventListener('click', () => {
  const job = roomFullJoin;
  hideRoomFullModal();
  if (job) launchStellaInto({ id: job.friend.id, name: job.name }, job.name);
});
$('roomFullPlayBtn')?.addEventListener('click', () => {
  const job = roomFullJoin;
  hideRoomFullModal();
  if (job?.room) playStellaRoom({ Name: job.room });
});

// Tray menu ────────────────────────────────────────────────────────────────
// The tray's Play entry launches without opening the window, like Steam's
// game entries. If the launch then needs the user (a warning, the Steam
// check), the first dialog it opens brings the window up.

/// Tell the tray menu which network is active, whether the game is running
/// (its Play entry reads "Play Radium" / "Play Vanilla" / "Stop Game"), and
/// what the current skin's menus look like.
function syncTray() {
  window.radium?.setTrayState(activeNetwork, isGameRunning, trayMenuStyle()).catch(() => {});
}

/// Only the inset layers of a `box-shadow`: the bevels the retro skins draw
/// their edges with. The drop shadow is left out of the tray menu and the
/// notification pop-up, which sit straight on the desktop.
function insetShadows(shadow) {
  const layers = (shadow || '').split(/,(?![^(]*\))/).map(s => s.trim()).filter(s => /\binset\b/.test(s));
  return layers.length ? layers.join(', ') : 'none';
}

/// What a menu looks like under the current skin, for the tray menu's window
/// to copy (traymenu.css). Measured from the Manage Client menu, which is in
/// the page, hidden, whatever tab is showing — so it follows every skin and
/// Liquid Glass. Hover can't be measured, so it comes from the skin's tokens,
/// with a tint of the text colour where a look sets none.
function trayMenuStyle() {
  const menu = $('manageMenu');
  const row = menu?.querySelector('.manage-item:not(.danger)');
  const sep = menu?.querySelector('.manage-sep');
  if (!menu || !row) return null;
  const box = getComputedStyle(menu);
  const item = getComputedStyle(row);
  const token = (name, fallback) => item.getPropertyValue(name).trim() || fallback;
  const side = (s, edge) => `${s[`border${edge}Width`]} ${s[`border${edge}Style`]} ${s[`border${edge}Color`]}`;
  const fg = item.color;
  const style = {
    'bg': box.backgroundColor,
    'bg-image': box.backgroundImage,
    'border': side(box, 'Top'),
    'radius': box.borderTopLeftRadius,
    'shadow': insetShadows(box.boxShadow),
    'pad': box.padding,
    'fg': fg,
    'font': item.fontFamily,
    'size': item.fontSize,
    'weight': item.fontWeight,
    'item-pad': item.padding,
    'item-radius': item.borderTopLeftRadius,
    'hover-bg': token('--item-hover-bg', `color-mix(in srgb, ${fg} 14%, transparent)`),
    'hover-fg': token('--item-hover-fg', fg),
    'sel-weight': token('--item-sel-weight', '700'),
    'sel-bg': token('--item-sel-bg', 'transparent'),
    'sel-fg': token('--item-sel-fg', fg),
    // Opens the way the skin's own menus do: the retro skins set no
    // entrance (`--menu-in: none`) and pop their menus up instantly.
    motion: document.body.classList.contains('animations-enabled') && token('--menu-in', '') !== 'none',
    glass: document.body.classList.contains('glass-enabled'),
  };
  if (sep) {
    const s = getComputedStyle(sep);
    Object.assign(style, {
      'sep-top': side(s, 'Top'),
      'sep-bottom': side(s, 'Bottom'),
      'sep-shadow': s.boxShadow,
      'sep-bg': s.backgroundColor,
      'sep-height': s.height,
      'sep-margin': s.margin,
    });
  }
  return style;
}

function playFromTray() {
  const btn = $('btnPlay');
  // Anything but a plain launch needs the window: the stop confirmation, a
  // missing install, a download in the way.
  if (isGameRunning || !isInstalled || isDownloading || isPaused || !btn || btn.disabled
      || stellaUpdateNeeded()) {
    window.radium?.showLauncher();
    switchTab('home');
    if (isGameRunning) btn?.click();
    return;
  }
  if (isGameLaunching) return;
  revealOnModal = true;
  clearTimeout(revealOnModalTimer);
  // A launch that fails without a dialog must not leave a later, unrelated
  // dialog popping the window open.
  revealOnModalTimer = setTimeout(() => { revealOnModal = false; }, 60000);
  btn.click();
}

window.radium?.onTrayAction?.(async ({ action, value }) => {
  if (action === 'play') { pendingJoin = null; playFromTray(); }
  else if (action === 'tab') switchTab(value);
  else if (action === 'network') {
    // Switching network from the tray leaves the window where it is — the menu
    // treats those rows as a selection and stays open. The exception is a
    // switch setNetwork() refuses (mid-download, or with the game running):
    // it says why in a toast, which is no use behind a hidden window, so that
    // is the one case worth bringing the launcher forward for.
    await setNetwork(value);
    if (activeNetwork !== value) window.radium?.showLauncher();
  }
});

function showSacModal() {
  showModal($('sacModal'));
}

function hideSacModal(cancelLaunch = true) {
  hideModal($('sacModal'));
  if (cancelLaunch) isGameLaunching = false;
}

$('sacModalClose')?.addEventListener('click', () => hideSacModal(true));
$('sacAnywayBtn')?.addEventListener('click', async () => {
  hideSacModal(false);
  sacWarnedThisSession = true;
  await checkSteamAndLaunch();
});
$('sacSettingsBtn')?.addEventListener('click', async () => {
  hideSacModal(false);
  sacWarnedThisSession = true;
  window.radium?.openUrl('windowsdefender://appbrowser');
  await checkSteamAndLaunch();
});
$('sacModal')?.addEventListener('click', (e) => {
  if (e.target === $('sacModal')) {
    hideSacModal(true);
  }
});

async function checkSacAndLaunch() {
  addLog('Checking Smart App Control status...', 'info', 'game');
  const sac = await window.radium?.checkSmartAppControl();
  if (sac && sac.enabled && !sacWarnedThisSession) {
    if (config.disableWarnings === true) {
      addLog('Smart App Control is active. Warning skipped (disabled by user).', 'info', 'game');
      await checkSteamAndLaunch();
    } else {
      addLog('Smart App Control is active. Prompting user...', 'info', 'game');
      showSacModal();
    }
  } else {
    if (sac && sac.enabled) {
      addLog('Smart App Control is active (previously acknowledged this session).', 'info', 'game');
    } else {
      addLog('Smart App Control is not active.', 'ok', 'game');
    }
    await checkSteamAndLaunch();
  }
}


window.radium?.onGameState((data) => {
  if (data.running === false) {
    setGameRunning(false);
    const code = data.exitCode !== undefined ? ` (exit ${data.exitCode})` : '';
    addLog(`Game closed${code}`, 'info', 'game');
    toast('Game closed.', 'info', 2000);
  } else if (data.running === true) {
    setGameRunning(true);
  }
  if (data.error) {
    addLog(`Error: ${data.error}`, 'error', 'game');
    toast(`Error: ${data.error}`, 'error', 4000);
  }
});

window.radium?.onDownloadProgress(updateDlProgress);

// Auto-update: check for a newer launcher release on GitHub
let updateInfo = null;

function showUpdateModal(info) {
  updateInfo = info;
  const ucv = $('updateCurrentVer'); if (ucv) ucv.textContent = `v${info.currentVersion}`;
  const ulv = $('updateLatestVer'); if (ulv) ulv.textContent = info.latestVersion;
  const un = $('updateNotes'); if (un) un.textContent = info.releaseNotes || '(No release notes provided.)';
  const status = $('updateStatus');
  if (status) status.style.display = 'none';
  const nowBtn = $('updateNowBtn');
  if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = '⬇ Update Now'; }
  showModal($('updateModal'));
}

function hideUpdateModal() {
  hideModal($('updateModal'));
}

$('updateModalClose')?.addEventListener('click', hideUpdateModal);
$('updateLaterBtn')?.addEventListener('click', hideUpdateModal);

$('updateNowBtn')?.addEventListener('click', async () => {
  if (!updateInfo?.downloadUrl) {
    // No direct download — open the release page in browser
    window.radium?.openUrl(updateInfo?.releaseUrl || 'https://github.com/abod124-sudo/Radium-Launcher/releases/latest');
    hideUpdateModal();
    return;
  }
  const nowBtn = $('updateNowBtn');
  const status = $('updateStatus');
  if (nowBtn) { nowBtn.disabled = true; nowBtn.textContent = '⬇ Downloading...'; }
  if (status) { status.style.display = 'block'; status.style.color = ''; status.textContent = 'Downloading update, please wait...'; }
  addLog(`Downloading update ${updateInfo.latestVersion}...`, 'info', 'update');

  // Desktop shortcut placement is always on now — the opt-out checkbox was removed.
  // Every failure comes back as a rejection (a bad digest, a network error), so
  // it is caught here: left to reject, the button stayed on "Downloading..."
  // for good.
  let result;
  try {
    result = await window.radium?.downloadUpdate(updateInfo.downloadUrl, true);
  } catch (e) {
    result = { success: false, error: String(e) };
  }
  if (result?.success) {
    if (status) status.textContent = 'Update downloaded! Launching installer...';
    addLog('Launcher update started — restarting.', 'ok', 'update');
    // App will quit shortly from main process
  } else {
    const err = result?.error || 'Unknown error';
    if (status) { status.textContent = `Error: ${err}`; status.style.color = '#ff6666'; }
    if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = '⬇ Update Now'; }
    addLog(`Update failed: ${err}`, 'error', 'update');
    toast(`Update failed: ${err}`, 'error', 5000);
  }
});
/// The launcher lives in the tray between play sessions, often for days, so
/// one check at startup — which, started with Windows, is usually before the
/// network is up — could leave it never hearing about a release. It checks
/// again every so often, and soon after a check that couldn't reach GitHub.
const LAUNCHER_UPDATE_RECHECK_MS = 12 * 60 * 60 * 1000;
const LAUNCHER_UPDATE_RETRY_MS = 15 * 60 * 1000;
let launcherUpdateTimer = null;
/// The release already offered this session. A later automatic check that
/// finds the same one leaves the user's "Later" alone.
let offeredLauncherVersion = null;

function scheduleLauncherUpdateCheck(ms) {
  clearTimeout(launcherUpdateTimer);
  launcherUpdateTimer = setTimeout(checkForLauncherUpdate, ms);
}

async function checkForLauncherUpdate() {
  scheduleLauncherUpdateCheck(LAUNCHER_UPDATE_RECHECK_MS);
  // Only check if autoUpdate is enabled in settings
  if (config.autoUpdate === false) return;
  addLog('Checking for launcher updates...', 'info', 'update');
  try {
    const info = await window.radium?.checkForUpdate();
    if (!info) return;
    if (info.error) {
      addLog(`Update check failed: ${info.error}`, 'info', 'update');
      scheduleLauncherUpdateCheck(LAUNCHER_UPDATE_RETRY_MS);
      return;
    }
    if (info.hasUpdate) {
      if (offeredLauncherVersion === info.latestVersion) return;
      offeredLauncherVersion = info.latestVersion;
      addLog(`New version available: ${info.latestVersion} (current: v${info.currentVersion})`, 'ok', 'update');
      toast('Update available!', 'ok', 5000);
      showUpdateModal(info);
    } else {
      addLog(`Launcher is up to date (v${info.currentVersion}).`, 'info', 'update');
    }
  } catch (e) {
    addLog(`Update check error: ${e?.message || e}`, 'info', 'update');
    scheduleLauncherUpdateCheck(LAUNCHER_UPDATE_RETRY_MS);
  }
}

$('btnCheckUpdates')?.addEventListener('click', async () => {
  const btn = $('btnCheckUpdates');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const resultEl = $('updateCheckResult');
  if (resultEl) {
    resultEl.textContent = 'Checking...';
    resultEl.className = 'test-result';
  }
  addLog('Manual launcher update check initiated.', 'info', 'update');
  toast('Checking for updates...', 'info', 2000);
  
  try {
    const info = await window.radium?.checkForUpdate();
    if (!info) {
      if (resultEl) {
        resultEl.textContent = '✕ No response';
        resultEl.className = 'test-result error';
      }
      toast('Update check failed.', 'error');
      return;
    }
    if (info.error) {
      if (resultEl) {
        resultEl.textContent = '✕ Error';
        resultEl.className = 'test-result error';
      }
      addLog(`Update check failed: ${info.error}`, 'info', 'update');
      toast('Update check failed.', 'error');
      return;
    }
    if (info.hasUpdate) {
      if (resultEl) {
        resultEl.textContent = '✓ Update available!';
        resultEl.className = 'test-result ok';
      }
      offeredLauncherVersion = info.latestVersion;
      addLog(`New version available: ${info.latestVersion} (current: v${info.currentVersion})`, 'ok', 'update');
      toast('Update available!', 'ok', 5000);
      showUpdateModal(info);
    } else {
      if (resultEl) {
        resultEl.textContent = '✓ Up to date';
        resultEl.className = 'test-result ok';
      }
      addLog(`Launcher is up to date (v${info.currentVersion}).`, 'info', 'update');
      toast('Launcher is up to date.', 'ok');
    }
  } catch (e) {
    if (resultEl) {
      resultEl.textContent = '✕ Error';
      resultEl.className = 'test-result error';
    }
    addLog(`Update check error: ${e.message}`, 'info', 'update');
    toast('Update check error.', 'error');
  } finally {
    btn.disabled = false;
  }
});

// Launcher entrypoint initialization
// ── Network switcher ─────────────────────────────────────────────────────

/// Apply everything that is purely presentational about a network. Split out
/// from setNetwork() so startup can brand the UI without triggering a reload
/// of data that init() is about to fetch anyway.
function applyNetworkUI(name) {
  activeNetwork = NETWORKS[name] ? name : 'radium';
  const info = networkInfo();

  for (const name of Object.keys(NETWORKS)) {
    document.body.classList.toggle(`network-${name}`, activeNetwork === name);
  }
  document.body.classList.toggle('network-no-social', info.hasSocial === false);
  // The UPDATE button is Stella's; another network never inherits it.
  applyStellaPatchUI();
  // Who is signed in to Stella, and their friends. Deferred: at startup this
  // runs before the account section of this file has been evaluated. Leaving
  // Stella closes the friends connection, and the backend is told first
  // whether Stella is in use, so these calls may sign in.
  syncStellaInUse();
  if (activeNetwork === 'stella') {
    setTimeout(() => { refreshStellaAuth(); refreshStellaFriends(); }, 0);
  } else {
    window.radium?.stellaFriendsStop?.().catch(() => {});
  }
  // Mirrored so the pre-paint bootstrap in index.html can brand the window
  // before CSS loads on the next launch.
  try { localStorage.setItem('radium-network', activeNetwork); } catch (e) {}

  const nameEl = $('networkName');
  if (nameEl) nameEl.textContent = info.label;

  const logoEl = $('sidebarLogo');
  if (logoEl) logoEl.src = info.logo;

  document.querySelectorAll('#networkMenu .network-option').forEach(opt => {
    const selected = opt.dataset.network === activeNetwork;
    opt.setAttribute('aria-selected', String(selected));
    // `active` is the class every theme already styles as "this is the current
    // one", so the selected network is highlighted the same way the current
    // tab is, in whichever skin is applied.
    opt.classList.toggle('active', selected);
  });

  // The exclusion is per network, as the folder it names is.
  setExcludeAvLabel(avExcluded());
  updateDownloadCta();
  syncTray();
}

/// Mark the switcher as just-changed for one animation.
///
/// Only on a real switch, not on the startup branding pass, so the sidebar
/// doesn't flash every launch. The class is removed when the animation ends
/// (and on a timer as a backstop, since `animationend` never fires when the
/// active theme defines no animation for it) so a second switch replays it.
function pulseNetworkSwitcher() {
  const btn = $('networkSwitcher');
  if (!btn) return;

  btn.classList.remove('network-just-switched');
  // Forces the class removal to take effect before it is re-added, otherwise
  // the browser coalesces both into no change at all and nothing replays.
  void btn.offsetWidth;
  btn.classList.add('network-just-switched');

  const clear = () => btn.classList.remove('network-just-switched');
  btn.addEventListener('animationend', clear, { once: true });
  setTimeout(clear, 1200);
}

function closeNetworkMenu() {
  const menu = $('networkMenu');
  const btn = $('networkSwitcher');
  hideDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('active');
  }
}

function openNetworkMenu() {
  const menu = $('networkMenu');
  const btn = $('networkSwitcher');
  showDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'true');
    // Borrows the current-tab look while open, which every theme already
    // defines for `.nav-btn.active`.
    btn.classList.add('active');
  }
  menu?.querySelector('.network-option.active')?.focus();
}

/// Switch networks: rebrand, persist, and reload everything that is
/// network-scoped.
async function setNetwork(name) {
  if (!NETWORKS[name] || name === activeNetwork) {
    closeNetworkMenu();
    return;
  }

  // A download and a running game are both single-instance globals bound to one
  // client, so switching underneath them would leave the UI describing a client
  // it is no longer pointing at.
  if (isDownloading || isPaused) {
    toast(clientTask
      ? 'Finish or cancel the file check before switching networks.'
      : 'Finish or cancel the current download before switching networks.', 'warn', 4000);
    closeNetworkMenu();
    return;
  }
  if (isGameRunning || isGameLaunching) {
    toast('Close the game before switching networks.', 'warn', 4000);
    closeNetworkMenu();
    return;
  }

  closeNetworkMenu();
  applyNetworkUI(name);
  pulseNetworkSwitcher();
  addLog(`Switched network to ${networkInfo().label} (${networkInfo().site}).`, 'ok');

  // Persist. Written directly rather than through autoSaveSettings() so the
  // switch survives even if the user never touches the settings form.
  config.network = activeNetwork;
  try {
    await window.radium?.saveConfig({ ...config, network: activeNetwork });
  } catch (e) {
    console.error('saveConfig (network) error:', e);
  }

  // Drop everything scoped to the previous network. Bumping the sequence ids
  // makes the existing race guards discard any responses still in flight.
  roomsSequenceId++;
  peopleSequenceId++;
  roomsSkip = 0;
  peopleSkip = 0;
  activeRoomsTag = '';
  activeRoomsSort = 0;
  // The highlight follows, or the old network's sort stays lit (and Most
  // Players, which is Stella's, would be lit while hidden).
  document.querySelectorAll('#roomsSortList .sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === '0'));
  roomsSearchQuery = '';
  peopleSearchQuery = '';
  setValue('roomsSearch', '');
  setValue('peopleSearch', '');
  hideRoomDetails();
  hidePlayerDetails();
  resetFeed();

  // Rooms and People are rendered per network, so drop what the old one left
  // on screen. Without this the reload below would dim the previous network's
  // rows and leave them readable while the new network's list downloads.
  roomsRenderKey = '';
  peopleRenderKey = '';
  filtersRenderKey = '';
  const roomsGridEl = $('roomsGrid');
  if (roomsGridEl) {
    roomsGridEl.innerHTML = '';
    delete roomsGridEl.dataset.listPlaceholder;
    endListLoad(roomsGridEl);
  }
  const peopleBodyEl = $('peopleListBody');
  if (peopleBodyEl) {
    peopleBodyEl.innerHTML = '';
    delete peopleBodyEl.dataset.listPlaceholder;
    endListLoad(peopleBodyEl);
  }

  // Cached client-update state belongs to the old network's client.
  clientUpdateInfo = null;
  clientUpdateAutoChecked = false;
  // And the install verdicts logged for it: the new network's are news.
  lastInstallLog.clear();

  // These caches are keyed by username / photo id alone, which is only unique
  // *within* a network — the same name is a different person on each. Without
  // this, opening a profile on one network then the same name on the other
  // serves the first network's stats.
  userWebDetailsCache.clear();
  photoWebDetailsCache.clear();

  await checkInstall();
  checkServerStatus(true);
  updatePlayerCount(true);

  // Only refetch a list the user is actually looking at.
  const openTab = document.querySelector('.tab-panel.active')?.id;
  if ((openTab === 'tab-rooms' || openTab === 'tab-people') && networkInfo().hasSocial === false) {
    // Their nav buttons just disappeared (Stella); don't strand the user there.
    switchTab('home');
  } else if (openTab === 'tab-rooms') {
    loadFilters();
    loadRooms();
  } else if (openTab === 'tab-people') {
    loadPeople();
  } else if (openTab === 'tab-feed') {
    // FEED only exists on networks that publish one; leaving the user parked
    // on a tab whose nav button just disappeared would strand them.
    if (networkInfo().hasPhotoFeed) loadFeed(false, { refresh: true });
    else switchTab('home');
  } else if (openTab === 'tab-friends' && activeNetwork !== 'stella') {
    // Likewise FRIENDS, which is Stella's.
    switchTab('home');
  }

  // Warm the new network's bulk sets now, while the user is reading whatever
  // tab they're on, rather than on the click that opens Rooms or People.
  window.radium?.prefetchNetworkData();
}

$('networkSwitcher')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const expanded = $('networkSwitcher')?.getAttribute('aria-expanded') === 'true';
  if (expanded) closeNetworkMenu(); else openNetworkMenu();
});

document.querySelectorAll('#networkMenu .network-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    setNetwork(opt.dataset.network);
  });
});


// ── Dropdown show/hide ───────────────────────────────────────────────────
// Shared by the two dropdowns in the launcher: the gear on the hero and the
// network switcher in the sidebar.

/// How long a menu's exit animation is given before the element is hidden.
/// Must match the `manageMenuOut` / `networkMenuLift` durations in style.css.
const MENU_EXIT_MS = 140;

/// Per-menu counter, bumped by every show and every hide, so a hide that is
/// still waiting out its animation can tell whether it is still the current
/// one. Keyed by element rather than by id so both menus share one mechanism.
const menuCloseTokens = new WeakMap();

/// Hide a dropdown, letting its exit animation play first where there is one.
///
/// `hidden` removes the element outright, so a close cannot be animated by CSS
/// alone — the element has to stay in the layout until the animation is done.
/// It is marked `.is-closing`, which is what the exit keyframes hang off, and
/// hidden once that has had its time.
function hideDropdown(menu) {
  if (!menu || menu.hidden) return;

  const token = (menuCloseTokens.get(menu) || 0) + 1;
  menuCloseTokens.set(menu, token);

  const finish = () => {
    // Reopening during the exit bumps the token, so this timer belongs to a
    // close the user has already undone and must not hide anything.
    if (menuCloseTokens.get(menu) !== token) return;
    menu.classList.remove('is-closing');
    menu.hidden = true;
  };

  menu.classList.add('is-closing');

  // The retro skins have no exit animation, and neither does anyone whose
  // system asks for reduced motion; waiting on a timer for them would only make
  // dismissal feel sluggish. getAnimations() flushes pending style, so the
  // class added a line above is already accounted for.
  const animating =
    typeof menu.getAnimations === 'function' && menu.getAnimations().length > 0;
  if (!animating) {
    finish();
    return;
  }

  // A timer rather than an `animationend` listener: a minimised or hidden
  // window pauses animations, and that event would never arrive — leaving the
  // menu stuck open on screen the next time the window was restored.
  setTimeout(finish, MENU_EXIT_MS);
}

/// Show a dropdown, cancelling any exit still in flight.
function showDropdown(menu) {
  if (!menu) return;
  menuCloseTokens.set(menu, (menuCloseTokens.get(menu) || 0) + 1);
  menu.classList.remove('is-closing');
  menu.hidden = false;
}

// ── Dialog show/hide ─────────────────────────────────────────────────────
// Every warning and confirmation dialog goes through these two, so a skin
// that animates dialogs out (the modern family, Liquid Glass) gets to play
// the exit, and the rest close instantly as they always did.

/// How long a dialog's exit animation is given before it is hidden. Must match
/// the exit durations in skins/04-modern.css and skins/11-glass.css.
const MODAL_EXIT_MS = 180;

/// Per-dialog counter, bumped by every show and hide, so a close still waiting
/// out its animation can tell it has been superseded by a reopen.
const modalCloseTokens = new WeakMap();

/// Show a dialog, cancelling any close still in flight.
function showModal(modal) {
  if (!modal) return;
  if (revealOnModal) {
    revealOnModal = false;
    window.radium?.showLauncher();
  }
  modalCloseTokens.set(modal, (modalCloseTokens.get(modal) || 0) + 1);
  modal.classList.remove('is-closing');
  modal.style.display = 'flex';
}

/// Hide a dialog, letting its exit animation play first where there is one.
///
/// `display: none` removes the dialog outright, so it is marked `.is-closing`
/// (which the exit keyframes hang off) and hidden once that has had its time.
/// Only the overlay's own animations are checked: the exit is declared there,
/// and a dialog can hold unrelated endless animations (a throbbing default
/// button, a loading placeholder) that must not make every close wait.
/// `onHidden` runs once it is really gone — not if it was reopened meanwhile.
function hideModal(modal, onHidden) {
  if (!modal) return;
  const token = (modalCloseTokens.get(modal) || 0) + 1;
  modalCloseTokens.set(modal, token);

  const finish = () => {
    if (modalCloseTokens.get(modal) !== token) return;
    modal.classList.remove('is-closing');
    modal.style.display = 'none';
    onHidden?.();
  };

  if (getComputedStyle(modal).display === 'none') { finish(); return; }

  modal.classList.add('is-closing');
  const animating =
    typeof modal.getAnimations === 'function' && modal.getAnimations().length > 0;
  if (!animating) { finish(); return; }
  // A timer, not animationend: see hideDropdown() for why.
  setTimeout(finish, MODAL_EXIT_MS);
}

// ── Manage-client menu ───────────────────────────────────────────────────
// The gear on the hero. Modelled on the network switcher above, down to the
// aria-expanded flag and the two ways out, so both dropdowns in the launcher
// behave the same.

function closeManageMenu() {
  const menu = $('manageMenu');
  const btn = $('btnManageClient');
  hideDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('active');
  }
}

function openManageMenu() {
  const menu = $('manageMenu');
  const btn = $('btnManageClient');
  showDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'true');
    // Borrows the current-tab look while open, as the network switcher does.
    btn.classList.add('active');
  }
  menu?.querySelector('button')?.focus();
}

$('btnManageClient')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const expanded = $('btnManageClient')?.getAttribute('aria-expanded') === 'true';
  if (expanded) closeManageMenu(); else openManageMenu();
});

// Every item starts something that takes over the screen — a folder, a modal, a
// re-download — so the menu closes behind the click rather than lingering over
// whatever it opened. Registered in the capture phase so it runs before each
// button's own handler, which may replace the button or navigate away.
$('manageMenu')?.addEventListener('click', (e) => {
  if (e.target.closest('button')) closeManageMenu();
}, true);

// Dismissal: anywhere outside, or Escape. Mirrors the network menu below.
document.addEventListener('click', (e) => {
  const menu = $('manageMenu');
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target) || $('btnManageClient')?.contains(e.target)) return;
  closeManageMenu();
});
document.addEventListener('keydown', (e) => {
  const menu = $('manageMenu');
  if (!menu || menu.hidden || e.key !== 'Escape') return;
  closeManageMenu();
  $('btnManageClient')?.focus();
});

// Dismissal: anywhere outside, or Escape.
document.addEventListener('click', (e) => {
  const menu = $('networkMenu');
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target) || $('networkSwitcher')?.contains(e.target)) return;
  closeNetworkMenu();
});
document.addEventListener('keydown', (e) => {
  const menu = $('networkMenu');
  if (!menu || menu.hidden) return;
  if (e.key === 'Escape') {
    closeNetworkMenu();
    $('networkSwitcher')?.focus();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const opts = Array.from(menu.querySelectorAll('.network-option'));
    const idx = opts.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? (idx + 1) % opts.length
      : (idx - 1 + opts.length) % opts.length;
    opts[next]?.focus();
  }
});

// ── Vanilla account ──────────────────────────────────────────────────────
// Sign-in happens on Vanilla's own page in a separate window (see
// vanilla_auth.rs). Nothing here ever sees the password or the session; the
// backend hands over a display name, an avatar and a token count.

let vanillaPlayer = null;
/// Stella's signed-in account (a people row), or null. See the Stella account
/// section below; declared here because fitAccountName reads it.
let stellaPlayer = null;

/// Fit a long name into the account button: first a smaller face on one line
/// (down to 12px), then two lines, then 11px on two lines, and only after
/// that an ellipsis. Re-run whenever the name, the skin or the sidebar's width
/// changes, since each skin sets its own face and size.
function fitAccountName() {
  fitOneAccountName($('vanillaAccountName'), vanillaPlayer);
  fitOneAccountName($('stellaAccountName'), stellaPlayer);
}

function fitOneAccountName(name, player) {
  if (!name) return;
  name.style.fontSize = '';
  name.classList.remove('two-lines');
  if (!player || !name.clientWidth) return;

  const wide = () => name.scrollWidth > name.clientWidth + 0.5;
  const tall = () => name.scrollHeight > name.clientHeight + 0.5;
  let size = parseFloat(getComputedStyle(name).fontSize) || 14;
  while (wide() && size > 12) {
    size = Math.max(12, size - 0.5);
    name.style.fontSize = `${size}px`;
  }
  if (!wide()) return;
  name.classList.add('two-lines');
  if (tall()) name.style.fontSize = '11px';
}
if (window.ResizeObserver) {
  for (const id of ['vanillaAccountName', 'stellaAccountName']) {
    const nameEl = document.getElementById(id);
    if (nameEl) new ResizeObserver(() => fitAccountName()).observe(nameEl);
  }
}
// A skin switch changes the face without resizing the box.
new MutationObserver(() => requestAnimationFrame(fitAccountName))
  .observe(document.body, { attributes: true, attributeFilter: ['class'] });

function renderVanillaAccount() {
  const name = $('vanillaAccountName');
  const avatar = $('vanillaAccountAvatar');
  const btn = $('vanillaAccountBtn');
  const bell = $('vanillaNotifsBtn');
  if (!name || !avatar || !btn) return;

  if (vanillaPlayer) {
    const handle = vanillaPlayer.userName || vanillaPlayer.displayName || 'account';
    name.textContent = vanillaPlayer.displayName || handle;
    const shown = vanillaPlayer.displayName && vanillaPlayer.displayName !== handle
      ? `${vanillaPlayer.displayName} (@${handle})` : `@${handle}`;
    btn.setAttribute('aria-label', `Signed in to Vanilla as ${shown}`);
    avatar.dataset.fallback = PLACEHOLDER_AVATAR;
    avatar.src = vanillaPlayer.AvatarUrl
      ? thumbSrc(vanillaPlayer.AvatarUrl, avatarWidth(28))
      : defaultAvatarUrl(28);
    avatar.hidden = false;
    btn.setAttribute('aria-haspopup', 'menu');
    $('vanillaAccountFullName').textContent = `@${handle}`;
    // The display name too, when it isn't just the username.
    const display = $('vanillaAccountDisplay');
    if (display) {
      const differs = vanillaPlayer.displayName && vanillaPlayer.displayName !== handle;
      display.textContent = differs ? vanillaPlayer.displayName : '';
      display.hidden = !differs;
    }
    if (bell) bell.hidden = false;
    fitAccountName();
  } else {
    name.textContent = 'LOG IN';
    fitAccountName();
    btn.setAttribute('aria-label', 'Sign in with your Vanilla account');
    avatar.hidden = true;
    avatar.removeAttribute('src');
    btn.removeAttribute('aria-haspopup');
    $('vanillaAccountTokens').textContent = '';
    if (bell) bell.hidden = true;
    resetNotifs(notifSources.vanilla);
    closeAccountMenu();
  }
}

/// Token balance and notifications, fetched after sign-in. Neither is worth an
/// error message of its own: an expired session is reported through the auth
/// event, and anything else just leaves them blank.
async function refreshVanillaExtras() {
  if (!vanillaPlayer) return;
  try {
    const acct = await window.radium.vanillaAccount();
    $('vanillaAccountTokens').textContent = `${Number(acct.tokens || 0).toLocaleString()} tokens`;
  } catch (e) {}
  loadVanillaNotifications();
}

/// A saved session Vanilla couldn't be asked about yet, retried until it
/// answers either way.
///
/// Started with Windows, the launcher is usually up before the network is,
/// so the startup check failed, the account button said LOG IN, and nothing
/// asked again that session: no notifications and no pop-ups until the
/// launcher was restarted, although the session was fine all along.
let authRetryTimer = null;
let authRetryDelay = 0;
const AUTH_RETRY_MAX_MS = 5 * 60 * 1000;

async function recheckVanillaAuth() {
  clearTimeout(authRetryTimer);
  authRetryTimer = null;
  try {
    applyVanillaAuth(await window.radium.vanillaAuthStatus());
  } catch (e) {
    scheduleAuthRetry();
  }
}

function scheduleAuthRetry() {
  clearTimeout(authRetryTimer);
  authRetryDelay = Math.min(authRetryDelay ? authRetryDelay * 2 : 15000, AUTH_RETRY_MAX_MS);
  authRetryTimer = setTimeout(recheckVanillaAuth, authRetryDelay);
}

// Back online: ask now rather than at the end of the current wait.
window.addEventListener('online', () => {
  if (authRetryTimer) recheckVanillaAuth();
});

function applyVanillaAuth(state) {
  const was = vanillaPlayer;
  vanillaPlayer = state && state.authenticated && state.player ? state.player : null;
  if (!vanillaPlayer && state?.hasSession) {
    scheduleAuthRetry();
  } else {
    clearTimeout(authRetryTimer);
    authRetryTimer = null;
    authRetryDelay = 0;
  }
  renderVanillaAccount();

  // Cheer and subscribe buttons on whatever is open reflect the new account.
  if (was?.id !== vanillaPlayer?.id) {
    cheeredPhotoIds = null;
    resetNotifs(notifSources.vanilla);
    refreshSocialButtons();
  }

  if (vanillaPlayer) {
    if (!was) addLog(`Signed in to Vanilla as @${vanillaPlayer.userName}`, 'ok', 'account');
    refreshVanillaExtras();
    return;
  }
  if (state && state.error && !state.hasSession) {
    toast(`Vanilla sign-in failed: ${state.error}`, 'error');
  }
  if (was) {
    const expired = state && state.reason === 'expired';
    addLog(expired ? 'Vanilla session expired, signed out' : 'Signed out of Vanilla', 'info', 'account');
    if (expired) toast('Your Vanilla session expired. Please sign in again.', 'info');
  }
}

function closeAccountMenu() {
  const btn = $('vanillaAccountBtn');
  hideDropdown($('vanillaAccountMenu'));
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('is-open');
  }
}

function openAccountMenu() {
  closeNotifPanel();
  const menu = $('vanillaAccountMenu');
  const btn = $('vanillaAccountBtn');
  showDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-open');
  }
  menu?.querySelector('.network-option')?.focus();
}

$('vanillaAccountBtn')?.addEventListener('click', async () => {
  if (vanillaPlayer) {
    const menu = $('vanillaAccountMenu');
    if (menu && !menu.hidden) closeAccountMenu(); else openAccountMenu();
    return;
  }
  // Opens Vanilla's sign-in window; the result arrives as `vanilla-auth-changed`.
  try {
    await window.radium.vanillaLogin();
  } catch (err) {
    toast(String(err), 'error');
  }
});

$('vanillaProfileBtn')?.addEventListener('click', () => {
  closeAccountMenu();
  if (vanillaPlayer?.userName) showCreatorProfile(vanillaPlayer.userName);
});
$('vanillaLogoutBtn')?.addEventListener('click', async () => {
  closeAccountMenu();
  try {
    await window.radium.vanillaLogout();
  } catch (e) {
    toast(String(e), 'error');
  }
});

// ── Stella account ───────────────────────────────────────────────────────
// Stella has no password sign-in: the backend signs in with the player's Steam
// account (stella_api.rs), and this shows which Stella account that is. LOG
// OUT is remembered by the backend across restarts; until LOG IN, Rooms and
// People offer a sign-in instead of signing in on their own.

/// The error every Stella API call answers while logged out
/// (`stella_api::SIGNED_OUT_ERROR`).
const STELLA_SIGNED_OUT = 'Signed out of Stella.';
/// What a sign-in answers when Steam isn't running
/// (`stella_api::STEAM_NOT_RUNNING`).
const STEAM_NOT_RUNNING = "Steam isn't running.";
/// What a sign-in answers while the launcher is hidden or minimized, or Stella
/// isn't picked (`stella_api::NOT_IN_USE`).
const STELLA_NOT_IN_USE = 'Stella signs in when you open it.';
let stellaAuthPending = false;
/// Why the last sign-in failed, if it did.
let stellaAuthError = '';

function renderStellaAccount() {
  const name = $('stellaAccountName');
  const avatar = $('stellaAccountAvatar');
  const btn = $('stellaAccountBtn');
  if (!name || !avatar || !btn) return;

  if (stellaPlayer) {
    const handle = stellaPlayer.userName || stellaPlayer.displayName || 'account';
    name.textContent = stellaPlayer.displayName || handle;
    const differs = stellaPlayer.displayName && stellaPlayer.displayName !== handle;
    btn.setAttribute('aria-label', `Signed in to Stella as ${differs ? `${stellaPlayer.displayName} (@${handle})` : `@${handle}`}`);
    avatar.dataset.fallback = PLACEHOLDER_AVATAR;
    avatar.src = stellaPlayer.AvatarUrl
      ? thumbSrc(stellaPlayer.AvatarUrl, avatarWidth(28))
      : PLACEHOLDER_AVATAR;
    avatar.hidden = false;
    btn.setAttribute('aria-haspopup', 'menu');
    $('stellaAccountFullName').textContent = `@${handle}`;
    const display = $('stellaAccountDisplay');
    if (display) {
      display.textContent = differs ? stellaPlayer.displayName : '';
      display.hidden = !differs;
    }
    if ($('stellaNotifsBtn')) $('stellaNotifsBtn').hidden = false;
  } else {
    if ($('stellaNotifsBtn')) $('stellaNotifsBtn').hidden = true;
    name.textContent = stellaAuthPending ? 'SIGNING IN…' : 'LOG IN';
    btn.setAttribute('aria-label', 'Sign in to Stella with your Steam account');
    avatar.hidden = true;
    avatar.removeAttribute('src');
    btn.removeAttribute('aria-haspopup');
    closeStellaAccountMenu();
  }
  fitAccountName();
}

/// Rooms and People belong to whoever is signed in (or to nobody): reload the
/// one on screen, and close a detail view the old account opened.
function reloadStellaLists() {
  if (activeNetwork !== 'stella') return;
  roomsRenderKey = '';
  peopleRenderKey = '';
  filtersRenderKey = '';
  userWebDetailsCache.clear();
  const openTab = document.querySelector('.tab-panel.active')?.id;
  if (openTab === 'tab-rooms') {
    hideRoomDetails();
    loadFilters();
    loadRooms();
  } else if (openTab === 'tab-people') {
    hidePlayerDetails();
    loadPeople();
  }
}

function applyStellaAuth(player) {
  const was = stellaPlayer;
  stellaPlayer = player || null;
  // Another account's (or nobody's) tokens.
  if (was?.id !== stellaPlayer?.id) $('stellaAccountTokens').textContent = '';
  renderStellaAccount();
  refreshStellaFriends();
  if (was?.id === stellaPlayer?.id) return;
  // An open room's cheer and favorite tiles, and the photo cheers on screen,
  // belong to the account.
  stellaCheerKnown = new Map();
  refreshSocialButtons();
  resetNotifs(notifSources.stella);
  if (stellaPlayer) loadNotifications(notifSources.stella);
  if (stellaPlayer) addLog(`Signed in to Stella as @${stellaPlayer.userName}`, 'ok', 'account');
  else if (was) addLog('Signed out of Stella', 'info', 'account');
  reloadStellaLists();
}

/// Ask the backend who is signed in. Unless the user logged out, this signs in
/// with Steam (a second or two), so the button says so meanwhile. A failure
/// (Steam not running, say) just leaves LOG IN; pressing it says why.
async function refreshStellaAuth() {
  if (activeNetwork !== 'stella' || stellaPlayer || stellaAuthPending) return;
  stellaAuthPending = true;
  renderStellaAccount();
  let state = null;
  try {
    state = await window.radium.stellaAuthStatus();
  } catch (e) {}
  stellaAuthPending = false;
  stellaAuthError = state?.authenticated ? '' : (state?.error || '');
  applyStellaAuth(state?.authenticated ? state.player : null);
}

async function stellaSignIn() {
  if (stellaAuthPending) return;
  stellaAuthPending = true;
  renderStellaAccount();
  try {
    const player = await window.radium.stellaLogin();
    stellaAuthPending = false;
    stellaAuthError = '';
    applyStellaAuth(player);
  } catch (e) {
    stellaAuthPending = false;
    stellaAuthError = String(e);
    renderStellaAccount();
    // Signed out stays cleared: the next list load tries again, and shows
    // the real reason (Steam not running) rather than a sign-in prompt.
    reloadStellaLists();
    toast(stellaAuthError === STEAM_NOT_RUNNING
      ? "Steam isn't running. Start Steam, then try again."
      : `Stella sign-in failed: ${e}`, 'error', 6000);
  }
}

/// Back on screen on Stella, from the tray or from being minimized: the
/// backend let Stella go meanwhile (see stella_api::in_use), so sign in if that
/// waited for it, and bring the friends, the player count and an open online
/// list back up to date. Also how Steam started while the launcher sat waiting
/// for it gets picked up: the user had to leave the window to start it.
function resumeStella() {
  syncStellaInUse();
  if (document.hidden || activeNetwork !== 'stella') return;
  // Only a sign-in that was waiting (for the window, or for Steam to start)
  // is tried again here: one that failed for good would otherwise start the
  // Steam API on every switch back to the window.
  if (!stellaPlayer && ['', STELLA_NOT_IN_USE, STEAM_NOT_RUNNING].includes(stellaAuthError)) refreshStellaAuth();
  refreshStellaFriends();
  updatePlayerCount(true);
  if (document.getElementById('tab-people')?.classList.contains('active') && !peopleSearchQuery
      && !listIsFresh(peopleKey(), peopleRenderKey, peopleRenderAt, peopleFreshMs)) {
    loadPeople();
  }
}

// A window hidden in the tray still reports its page visible, so `focus`
// (which a window brought back from the tray or the taskbar gets) is the
// signal that matters; `visibilitychange` covers a start hidden in the tray.
document.addEventListener('visibilitychange', resumeStella);
window.addEventListener('focus', resumeStella);

function closeStellaAccountMenu() {
  const btn = $('stellaAccountBtn');
  const menu = $('stellaAccountMenu');
  if (menu && !menu.hidden) hideDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('is-open');
  }
}

/// The token count in the account menu, asked for each time the menu opens
/// (tokens change while playing). The last count stays up meanwhile, and stays
/// if Stella can't be asked.
async function refreshStellaTokens() {
  const asked = stellaPlayer?.id;
  if (!asked) return;
  try {
    const tokens = await window.radium.stellaTokens();
    if (stellaPlayer?.id !== asked) return;
    $('stellaAccountTokens').textContent = `${Number(tokens).toLocaleString()} ${tokens === 1 ? 'token' : 'tokens'}`;
  } catch (e) {}
}

function openStellaAccountMenu() {
  const menu = $('stellaAccountMenu');
  const btn = $('stellaAccountBtn');
  refreshStellaTokens();
  showDropdown(menu);
  if (btn) {
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-open');
  }
  menu?.querySelector('.network-option')?.focus();
}

$('stellaAccountBtn')?.addEventListener('click', () => {
  if (stellaPlayer) {
    const menu = $('stellaAccountMenu');
    if (menu && !menu.hidden) closeStellaAccountMenu(); else openStellaAccountMenu();
    return;
  }
  stellaSignIn();
});

$('stellaProfileBtn')?.addEventListener('click', () => {
  closeStellaAccountMenu();
  if (!stellaPlayer) return;
  showCreatorProfile(stellaPlayer.userName, {
    id: stellaPlayer.id,
    displayName: stellaPlayer.displayName,
    avatarUrl: stellaPlayer.AvatarUrl
  });
});

$('stellaLogoutBtn')?.addEventListener('click', async () => {
  closeStellaAccountMenu();
  try {
    await window.radium.stellaLogout();
  } catch (e) {
    toast(String(e), 'error');
    return;
  }
  applyStellaAuth(null);
});

// ── Stella friends (Home card) ───────────────────────────────────────────
// The backend keeps a live connection to Stella's notification hub while this
// is showing and reports each friend as online (with their room), offline, or
// still "checking" in the first minute, before their first update could have
// arrived. See stella_hub.rs.

let stellaFriendsQueued = null;
/// Your Stella friends by account id, as the friends card last had them: how
/// a profile knows to offer JOIN (see applyStellaPresence()).
let stellaFriendsById = new Map();

/// Where the friends list shows (Settings → FRIENDS): "home", "tab" or
/// "hidden". Anything else, including unset, is Home.
function friendsView() {
  const v = config?.stella?.friendsView;
  return v === 'tab' || v === 'hidden' ? v : 'home';
}

function applyFriendsView() {
  const view = friendsView();
  for (const v of ['home', 'tab', 'hidden']) {
    document.body.classList.toggle(`friends-view-${v}`, view === v);
  }
  setValue('cfgFriendsView', view);
  // Its nav button just went away: don't leave the user on a tab they can't
  // see the button for.
  if (view !== 'tab' && document.getElementById('tab-friends')?.classList.contains('active')) {
    switchTab('home');
  }
  // Deferred: at startup this runs from loadConfig, possibly before the
  // account section of this file (stellaPlayer) has been evaluated.
  setTimeout(refreshStellaFriends, 0);
}

async function refreshStellaFriends() {
  if (activeNetwork !== 'stella') return;
  // Hidden: no list to fill, so no reason to hold the friends connection
  // open for it. (A profile page still starts it for its own status.)
  if (friendsView() === 'hidden') return;
  if (!stellaPlayer) {
    renderStellaFriends(null);
    return;
  }
  let res;
  try {
    res = await window.radium.stellaFriends();
  } catch (e) {
    res = { success: false, error: String(e) };
  }
  if (activeNetwork !== 'stella' || !stellaPlayer) return;
  renderStellaFriends(res);
}

/// Coalesces a burst of presence events into one redraw.
function queueStellaFriends() {
  clearTimeout(stellaFriendsQueued);
  stellaFriendsQueued = setTimeout(refreshStellaFriends, 250);
}

function friendStatusText(f) {
  if (f.status === 'checking') return 'Checking…';
  if (f.status === 'paused') return 'Shown in game';
  // Not heard from, and the friends connection is down (it keeps retrying).
  if (f.status === 'unknown') return 'Status unknown';
  if (f.status !== 'online') return 'Offline';
  if (f.roomName) return f.private ? `In ${f.roomName} · private` : `In ${f.roomName}`;
  if (f.private) return 'In a private room';
  return 'Online';
}

/// Fill both places the list can show: the Home card and the FRIENDS tab.
/// Only one is visible at a time, and keeping both current means switching
/// the setting shows a full list straight away.
function renderStellaFriends(res) {
  if (res?.success && res.loaded) {
    stellaFriendsById = new Map((res.friends || []).map(f => [Number(f.id), f]));
  }
  renderStellaFriendsInto($('stellaFriendsList'), $('stellaFriendsCount'), res);
  renderStellaFriendsInto($('stellaFriendsTabList'), $('stellaFriendsTabCount'), res);
}

function renderStellaFriendsInto(list, count, res) {
  if (!list || !count) return;
  const note = (text) => {
    const el = document.createElement('div');
    el.className = 'home-friends-note';
    el.textContent = text;
    list.replaceChildren(el);
  };

  if (!stellaPlayer) {
    count.textContent = '';
    note(stellaAuthPending ? 'Signing in…' : 'Log in to Stella to see your friends.');
    return;
  }
  if (!res?.success) {
    count.textContent = '';
    note(res?.error || "Couldn't load your friends.");
    return;
  }
  if (!res.loaded) {
    count.textContent = '';
    note(res.error || 'Loading friends…');
    return;
  }
  const friends = res.friends || [];
  if (friends.length === 0) {
    count.textContent = '';
    note("No friends yet. Add some in game and they'll show up here.");
    return;
  }

  const online = friends.filter(f => f.status === 'online').length;
  // Paused: one sign-in at a time can watch friends, and the game is using
  // it. It picks up again when the game closes.
  count.textContent = res.paused ? 'Paused while you play'
    : (!res.connected && res.error ? 'Reconnecting…' : `${online} online`);

  list.replaceChildren(...friends.map(f => {
    const row = document.createElement('div');
    row.className = `home-friend is-${f.status}`;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'home-friend-main';
    const name = f.displayName || f.userName || 'Player';

    const pic = document.createElement('span');
    pic.className = 'home-friend-pic';
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.dataset.fallback = PLACEHOLDER_AVATAR;
    img.src = f.AvatarUrl ? thumbSrc(f.AvatarUrl, avatarWidth(28)) : PLACEHOLDER_AVATAR;
    const dot = document.createElement('span');
    dot.className = 'home-friend-dot';
    pic.append(img, dot);

    const text = document.createElement('span');
    text.className = 'home-friend-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'home-friend-name';
    nameEl.textContent = name;
    const sub = document.createElement('span');
    sub.className = 'home-friend-sub';
    sub.textContent = friendStatusText(f);
    text.append(nameEl, sub);

    main.append(pic, text);
    main.addEventListener('click', () => showCreatorProfile(f.userName, {
      id: f.id,
      displayName: f.displayName,
      avatarUrl: f.AvatarUrl
    }));
    row.append(main);

    // Only someone online can be joined.
    if (f.status === 'online') {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'btn-refresh home-friend-join';
      join.textContent = 'JOIN';
      join.setAttribute('aria-label', f.private && !stellaInvitedBy(f.id) ? `Ask ${name} to let you into their private room` : `Start Stella and join ${name}`);
      join.addEventListener('click', () => joinStellaFriend(f));
      row.append(join);
    }
    return row;
  }));
}

window.radium?.onStellaFriends?.(queueStellaFriends);
// "Checking…" turns into "Offline", and a friend gone quiet into offline, by
// time passing rather than by an event, so the card is redrawn now and then.
setInterval(() => {
  if (activeNetwork === 'stella' && stellaPlayer && !document.hidden) refreshStellaFriends();
}, 20000);

// The LOG IN button a signed-out Rooms or People list shows.
document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-stella-login]')) stellaSignIn();
  if (e.target.closest?.('[data-stella-retry]')) {
    reloadStellaLists();
    refreshStellaAuth();
  }
});

document.addEventListener('click', (e) => {
  const menu = $('stellaAccountMenu');
  if (menu && !menu.hidden && !menu.contains(e.target) && !$('stellaAccountBtn')?.contains(e.target)) {
    closeStellaAccountMenu();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('stellaAccountMenu')?.hidden) {
    closeStellaAccountMenu();
    $('stellaAccountBtn')?.focus();
  }
});

// ── Vanilla notifications ────────────────────────────────────────────────
// A panel off the bell next to the account button, laid out like the one on
// vanillarec.net. Vanilla and Stella each have their own list and bell (in
// their account slots); the one panel shows whichever bell opened it. Neither
// keeps read state on its side (Vanilla's website keeps it in the browser),
// so neither does this: which ones have been seen is a per-account list in
// localStorage.

/// Each network's notifications. Stella's are the game's messages, with the
/// same type numbers as Vanilla's (both are Rec Room's): see
/// stella_api::stella_notifications.
const notifSources = {
  vanilla: {
    net: 'vanilla', label: 'Vanilla', items: [], loading: false,
    /// Ids already seen for the signed-in account; `null` until its first
    /// load, which only records a baseline (see announceNewNotifs).
    announced: null,
    bell: 'vanillaNotifsBtn', badge: 'vanillaNotifBadge',
    player: () => vanillaPlayer,
    fetch: () => window.radium.vanillaNotifications(),
  },
  stella: {
    net: 'stella', label: 'Stella', items: [], loading: false, announced: null,
    bell: 'stellaNotifsBtn', badge: 'stellaNotifBadge',
    player: () => stellaPlayer,
    fetch: () => window.radium.stellaNotifications(),
  },
};
/// The list the panel shows: the bell that last opened it.
let panelSource = notifSources.vanilla;

/// Wording per notification type, matching the website. `{s}` is the sender
/// and `{m}` a free-text message; both are inserted as text, never markup.
const VANILLA_NOTIF_TEXT = {
  1: '{s} declined your game invite.',
  2: 'Failed to join game.',
  3: 'Party switched activity.',
  4: '{s} sent you a friend request. Accept in-game.',
  5: 'A vote to kick was initiated.',
  6: '{s} invited you to play.',
  7: 'Party switched activity.',
  10: '{s} requested an invite to join you.',
  11: '{s} declined your invite request.',
  20: '{s} is now online.',
  30: '{s}: {m}',
  40: '{s} accepted your friend request.',
  50: '{s} cheered you.',
  51: 'An anonymous player cheered you.',
  60: 'You were added as a room co-owner.',
  61: 'You were removed as a room co-owner.',
  62: '{s} invited you to be a room co-owner.',
  70: '{s} published a new room.',
  80: '{s} is attending your event.',
  81: '{s} invited you to an event.',
  90: '{s} invited you to join a club.',
  91: '{s} joined your club.',
  100: 'Coach: {m}',
};

/// Types that aren't from a person, shown with an icon instead of an avatar.
const VANILLA_SYSTEM_NOTIFS = new Set([2, 3, 5, 7, 51, 60, 61, 100]);

const READ_NOTIFS_CAP = 500;

function readNotifsKey(src) {
  const player = src.player();
  return player ? `radium-${src.net}-read-notifs-${player.id}` : null;
}

function readNotifIds(src) {
  const key = readNotifsKey(src);
  if (!key) return new Set();
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

function markNotifsRead(src, ids) {
  const key = readNotifsKey(src);
  if (!key || !ids.length) return;
  const seen = readNotifIds(src);
  ids.forEach(id => seen.add(String(id)));
  try {
    localStorage.setItem(key, JSON.stringify([...seen].slice(-READ_NOTIFS_CAP)));
  } catch (e) {}
}

function unreadNotifs(src) {
  const seen = readNotifIds(src);
  return src.items.filter(n => n.id != null && !seen.has(String(n.id)));
}

function setNotifBadge(src) {
  const badge = $(src.badge);
  if (!badge) return;
  const count = unreadNotifs(src).length;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count || '');
  $(src.bell)?.setAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications');
}
function setVanillaBadge() { setNotifBadge(notifSources.vanilla); }

async function loadNotifications(src) {
  const player = src.player();
  if (!player || src.loading) return;
  src.loading = true;
  const panelOpen = () => !$('vanillaNotifsPanel')?.hidden && panelSource === src;
  try {
    const list = await src.fetch();
    if (src.player()?.id !== player.id) return;
    src.items = Array.isArray(list) ? list : [];
    if (src.net === 'stella') noteStellaInvites(src.items);
    setNotifBadge(src);
    announceNewNotifs(src, src.items);
    if (panelOpen()) renderNotifPanel();
  } catch (e) {
    if (panelOpen()) renderNotifPanel(String(e));
  } finally {
    src.loading = false;
  }
}
function loadVanillaNotifications() { return loadNotifications(notifSources.vanilla); }

/// A signed-in account changed: its list (and what was announced) is gone.
function resetNotifs(src) {
  src.items = [];
  src.announced = null;
  setNotifBadge(src);
  if (panelSource === src) closeNotifPanel();
}

function formatNotifTime(iso) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

/// A Stella room as the game names it: "^RecCenter", or a dorm as it is.
function stellaRoomLabel(room) {
  room = String(room || '');
  if (!room) return 'their room';
  return /'s Dorm$/.test(room) ? room : `^${room}`;
}

/// The message as parts (`{ t, b }`, b for bold), the sender's name in bold.
/// Inserted as text, never markup, both here and in the desktop pop-up.
function notifParts(n) {
  // Stella's invites carry the room's name.
  const invite = n.type === 6 && n.message;
  const template = invite ? '{s} invited you to join them in {m}.'
    : VANILLA_NOTIF_TEXT[n.type] || 'New notification from {s}.';
  return template.split(/(\{s\}|\{m\})/).filter(Boolean).map(part =>
    part === '{s}' ? { t: n.senderDisplay || n.senderName || 'A player', b: true }
      : part === '{m}' ? { t: invite ? stellaRoomLabel(n.message) : (n.message || '') }
      : { t: part });
}

function notifMessage(n) {
  const frag = document.createDocumentFragment();
  for (const part of notifParts(n)) {
    if (part.b) {
      const b = document.createElement('strong');
      b.textContent = part.t;
      frag.appendChild(b);
    } else {
      frag.appendChild(document.createTextNode(part.t));
    }
  }
  return frag;
}

/// The sender's picture, or an icon for notifications no person sent.
function notifAvatar(n, size) {
  if (VANILLA_SYSTEM_NOTIFS.has(n.type) || !n.senderId) {
    const icon = document.createElement('span');
    icon.className = 'notif-avatar notif-avatar-system';
    const glyph = document.createElement('span');
    glyph.className = `vn-icon ${n.type === 51 ? 'vn-icon-thumb' : 'vn-icon-info'}`;
    icon.appendChild(glyph);
    return icon;
  }
  const img = document.createElement('img');
  img.className = 'notif-avatar';
  img.alt = '';
  img.loading = 'lazy';
  // A picture that fails to load gets the placeholder, as every other avatar
  // does, rather than the webview's broken-image mark.
  img.dataset.fallback = PLACEHOLDER_AVATAR;
  img.src = n.senderAvatar ? thumbSrc(n.senderAvatar, avatarWidth(size)) : PLACEHOLDER_AVATAR;
  return img;
}

/// A Stella invite that can still be used: JOIN on it starts Stella there.
function joinableStellaInvite(src, n) {
  return src.net === 'stella' && n.type === 6 && n.senderId && stellaInvitedBy(n.senderId);
}

function notifRow(src, n, unread) {
  const join = joinableStellaInvite(src, n);
  const clickable = join || n.senderName;
  const row = document.createElement(clickable ? 'button' : 'div');
  row.className = 'notif-item';
  if (clickable) row.type = 'button';
  row.classList.toggle('unread', unread);
  row.appendChild(notifAvatar(n, 32));

  const body = document.createElement('span');
  body.className = 'notif-body';
  const text = document.createElement('span');
  text.className = 'notif-text';
  text.appendChild(notifMessage(n));
  const time = document.createElement('span');
  time.className = 'notif-time';
  time.textContent = formatNotifTime(n.sentTime);
  body.append(text, time);
  row.appendChild(body);

  if (join) {
    // The whole row joins; this only says so.
    const chip = document.createElement('span');
    chip.className = 'notif-join';
    chip.textContent = 'JOIN';
    chip.setAttribute('aria-hidden', 'true');
    row.appendChild(chip);
    row.setAttribute('aria-label', `Join ${n.senderDisplay || n.senderName || 'them'} in ${stellaRoomLabel(n.message)}`);
    row.addEventListener('click', () => {
      closeNotifPanel();
      joinFromStellaInvite(n.senderId);
    });
  } else if (n.senderName) {
    row.addEventListener('click', () => {
      closeNotifPanel();
      // Stella opens a profile by id rather than by searching the name.
      if (src.net === 'stella') {
        showCreatorProfile(n.senderName, { id: n.senderId, displayName: n.senderDisplay, avatarUrl: n.senderAvatar });
      } else {
        showCreatorProfile(n.senderName);
      }
    });
  }
  return row;
}

function notifState(message, loading = false) {
  const el = document.createElement('div');
  el.className = 'notif-empty';
  if (!loading) {
    const icon = document.createElement('span');
    icon.className = 'vn-icon vn-icon-bell notif-empty-icon';
    el.appendChild(icon);
  }
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  return el;
}

function renderNotifPanel(error) {
  const src = panelSource;
  const list = $('vanillaNotifsList');
  if (!list) return;
  const unread = unreadNotifs(src);
  const mark = $('vanillaNotifsMarkRead');
  if (mark) mark.disabled = unread.length === 0;

  if (error && !src.items.length) {
    list.replaceChildren(notifState(error));
    return;
  }
  if (!src.items.length) {
    list.replaceChildren(src.loading ? notifState('Loading…', true) : notifState('No new notifications'));
    return;
  }
  // Unread first, then newest first, as on the website.
  const unreadIds = new Set(unread.map(n => String(n.id)));
  const sorted = [...src.items].sort((a, b) => {
    const au = unreadIds.has(String(a.id)), bu = unreadIds.has(String(b.id));
    if (au !== bu) return au ? -1 : 1;
    return String(b.sentTime || '').localeCompare(String(a.sentTime || ''));
  });
  list.replaceChildren(...sorted.map(n => notifRow(src, n, unreadIds.has(String(n.id)))));
}

/// Place the panel beside the sidebar, bottom-aligned with the bell, and no
/// taller than the room above it (the title bar included).
function positionNotifPanel() {
  const panel = $('vanillaNotifsPanel');
  const bell = $(panelSource.bell);
  const sidebar = document.querySelector('.sidebar');
  if (!panel || !bell || !sidebar) return;
  const gap = 10;
  const bellBox = bell.getBoundingClientRect();
  const titlebar = $('titlebar')?.getBoundingClientRect().bottom || 0;
  panel.style.left = `${Math.round(sidebar.getBoundingClientRect().right + gap)}px`;
  panel.style.bottom = `${Math.max(gap, Math.round(window.innerHeight - bellBox.bottom))}px`;
  panel.style.maxHeight = `${Math.max(200, Math.min(460, Math.round(bellBox.bottom - titlebar - gap)))}px`;
}

function openNotifPanel(src = panelSource) {
  closeAccountMenu();
  closeStellaAccountMenu();
  if (panelSource !== src) closeNotifPanel();
  panelSource = src;
  const panel = $('vanillaNotifsPanel');
  const bell = $(src.bell);
  if (!panel) return;
  positionNotifPanel();
  renderNotifPanel();
  showDropdown(panel);
  bell?.setAttribute('aria-expanded', 'true');
  bell?.classList.add('is-open');
  loadNotifications(src);
}

/// Closing counts everything that was on show as seen, like the website.
function closeNotifPanel() {
  const panel = $('vanillaNotifsPanel');
  if (!panel || panel.hidden) return;
  const src = panelSource;
  markNotifsRead(src, src.items.map(n => n.id).filter(id => id != null));
  setNotifBadge(src);
  hideDropdown(panel);
  const bell = $(src.bell);
  bell?.setAttribute('aria-expanded', 'false');
  bell?.classList.remove('is-open');
}

for (const src of Object.values(notifSources)) {
  $(src.bell)?.addEventListener('click', () => {
    const panel = $('vanillaNotifsPanel');
    if (panel && !panel.hidden && panelSource === src) closeNotifPanel(); else openNotifPanel(src);
  });
}

$('vanillaNotifsMarkRead')?.addEventListener('click', () => {
  const src = panelSource;
  markNotifsRead(src, src.items.map(n => n.id).filter(id => id != null));
  setNotifBadge(src);
  renderNotifPanel();
});

window.addEventListener('resize', () => {
  if (!$('vanillaNotifsPanel')?.hidden) positionNotifPanel();
});

// Check for new ones every minute while signed in, so pop-ups arrive close to
// when the notification did. One small request each. While the launcher is
// minimised it only keeps checking if pop-ups are on. Stella's also come
// over its live hub the moment they are sent (onStellaMessage).
setInterval(() => {
  if (document.hidden && !notifPrefs().popups) return;
  for (const src of Object.values(notifSources)) {
    if (src.player()) loadNotifications(src);
  }
}, 60 * 1000);
window.radium?.onStellaMessage?.(() => loadNotifications(notifSources.stella));

// ── Notification pop-ups ─────────────────────────────────────────────────
// Steam-style cards for notifications that arrive while the launcher is
// running, always in their own window in the corner of the screen (see
// desktop_notify.rs), never inside the launcher. What was already there at
// sign-in is not announced.

const NOTIF_POP_MAX = 3;

function announceNewNotifs(src, list) {
  const withIds = list.filter(n => n.id != null);
  if (!src.announced) {
    src.announced = new Set(withIds.map(n => String(n.id)));
    return;
  }
  const fresh = withIds.filter(n => !src.announced.has(String(n.id)));
  fresh.forEach(n => src.announced.add(String(n.id)));

  // Announced whichever network the launcher is showing. These belong to the
  // signed-in account, and while another network was selected they used to
  // be marked as announced without ever popping up — and the bell that would
  // have shown them is hidden there. Opening one switches to its network.
  if (!fresh.length) return;
  const seen = readNotifIds(src);
  const show = fresh
    .filter(n => !seen.has(String(n.id)))
    // A Stella invite has popped up already, with its JOIN (showStellaInvite).
    .filter(n => !(src.net === 'stella' && n.type === 6))
    .sort((a, b) => String(a.sentTime || '').localeCompare(String(b.sentTime || '')));
  if (show.length) deliverNotifPops(src, show);
}

function notifPrefs() {
  return {
    popups: config?.notifPopups !== false,
    sound: config?.notifSound !== false,
  };
}

/// Show new notifications in the desktop pop-up, and play the chime once for
/// the batch. Skipped while the game is running (a topmost window over a
/// full-screen game can knock it out of full screen), and while the launcher
/// is in front with its notification list open, which already shows them.
function deliverNotifPops(src, list, { force = false } = {}) {
  const prefs = notifPrefs();
  if (!force) {
    if (!prefs.popups || isGameRunning) return;
    const listOpen = !$('vanillaNotifsPanel')?.hidden && panelSource === src;
    if (listOpen && document.hasFocus()) return;
  }

  // At most NOTIF_POP_MAX cards: the newest, led by an "N more" card.
  const items = list.length > NOTIF_POP_MAX
    ? [{ more: list.length - (NOTIF_POP_MAX - 1) }, ...list.slice(-(NOTIF_POP_MAX - 1))]
    : list;

  const style = notifPopStyle();
  window.radium.desktopNotify(items.map(it => desktopCard(src, it, style))).catch(() => {});
  if (prefs.sound) playNotifChime();
}

/// A card for the desktop pop-up: plain data, rendered there as text. Its id
/// says whose notification it is (`notif:<network>:<id>`), for when it's clicked.
function desktopCard(src, it, style) {
  if (it.more) {
    return { id: null, sender: null, icon: 'bell', app: src.label, style,
             parts: [{ t: `${it.more} more new notifications` }] };
  }
  const n = it;
  const system = VANILLA_SYSTEM_NOTIFS.has(n.type) || !n.senderId;
  return {
    id: n.id != null ? `notif:${src.net}:${n.id}` : null,
    sender: n.senderName || null,
    icon: system ? (n.type === 51 ? 'thumb' : 'info') : null,
    // Always the account's network, whichever is showing, so never Radium's
    // default picture; the placeholder rather than nothing, which the pop-up
    // used to fill with the Radium logo.
    avatar: system ? '' : (n.senderAvatar ? thumbSrc(n.senderAvatar, avatarWidth(40)) : PLACEHOLDER_AVATAR),
    app: src.label,
    parts: notifParts(n),
    style,
  };
}

/// What a pop-up card looks like under the current skin (the `.notif-pop`
/// rules in style.css, applied to a hidden probe), for the desktop window to
/// copy — so it matches whatever theme, or Liquid Glass, is on.
function notifPopStyle() {
  const host = $('toastContainer');
  if (!host) return null;
  const probe = document.createElement('div');
  probe.className = 'network-menu notif-pop';
  probe.style.cssText = 'visibility:hidden;animation:none';
  const avatar = document.createElement('span');
  avatar.className = 'notif-avatar';
  const app = document.createElement('span');
  app.className = 'notif-pop-app';
  const text = document.createElement('span');
  text.className = 'notif-pop-text';
  const name = document.createElement('strong');
  text.appendChild(name);
  probe.append(avatar, app, text);
  host.appendChild(probe);
  const box = getComputedStyle(probe);
  const style = {
    'bg': box.backgroundColor,
    'bg-image': box.backgroundImage,
    'border': `${box.borderTopWidth} ${box.borderTopStyle} ${box.borderTopColor}`,
    'radius': box.borderTopLeftRadius,
    'shadow': insetShadows(box.boxShadow),
    'fg': getComputedStyle(text).color,
    'muted': getComputedStyle(app).color,
    'accent': getComputedStyle(name).color,
    'font': getComputedStyle(text).fontFamily,
    'system-bg': `color-mix(in srgb, ${getComputedStyle(text).color} 12%, transparent)`,
    'avatar-radius': getComputedStyle(avatar).borderTopLeftRadius,
    motion: document.body.classList.contains('animations-enabled'),
    retro: isRetroSkin(),
    // Liquid Glass: the pop-up window asks Windows for real blur behind it.
    glass: document.body.classList.contains('glass-enabled'),
  };
  probe.remove();
  return style;
}

// ── The chime ────────────────────────────────────────────────────────────
// Two soft sine notes, synthesised, so there's no sound file to ship. The
// audio context is created on the first click anywhere: a page may not start
// sound before the user has interacted with it.

let chimeCtx = null;
function ensureChimeCtx() {
  try {
    if (!chimeCtx) chimeCtx = new AudioContext();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
  } catch (e) {}
}
document.addEventListener('pointerdown', ensureChimeCtx, { once: true, capture: true });

let lastChimeAt = 0;
function playNotifChime() {
  const now = performance.now();
  if (now - lastChimeAt < 1500) return;
  lastChimeAt = now;
  ensureChimeCtx();
  if (!chimeCtx) return;
  try {
    const t = chimeCtx.currentTime + 0.01;
    [[880, 0], [1318.5, 0.1]].forEach(([freq, delay]) => {
      const osc = chimeCtx.createOscillator();
      const gain = chimeCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.4);
      osc.connect(gain).connect(chimeCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.45);
    });
  } catch (e) {}
}

// A desktop card was clicked: the launcher has already been brought forward.
window.radium?.onDesktopNotifOpen?.(async (card) => {
  if (card?.id === 'tray-hint') return;
  const invite = /^stella-invite:(\d+)$/.exec(String(card?.id ?? ''));
  if (invite) {
    joinFromStellaInvite(invite[1]);
    return;
  }
  const own = /^notif:(vanilla|stella):(.+)$/.exec(String(card?.id ?? ''));
  // The pop-up hands back only the id and sender, so an id-less card ("N
  // more") is taken as Vanilla's.
  const src = notifSources[own?.[1] || 'vanilla'];
  if (own) {
    markNotifsRead(src, [own[2]]);
    setNotifBadge(src);
  }
  // Profiles and the notification list are the network's own. setNetwork()
  // refuses (and says why) during a download or while the game runs; the
  // launcher is already in front, so that is where it stops.
  if (activeNetwork !== src.net) {
    await setNetwork(src.net);
    if (activeNetwork !== src.net) return;
  }
  const n = own && src.items.find(x => String(x.id) === own[2]);
  if (src.net === 'stella' && n?.senderId) {
    showCreatorProfile(n.senderName, { id: n.senderId, displayName: n.senderDisplay, avatarUrl: n.senderAvatar });
  } else if (card?.sender) {
    showCreatorProfile(String(card.sender));
  } else if (src.player()) {
    openNotifPanel(src);
  }
});

// Settings → Send a test pop-up.
$('btnTestNotif')?.addEventListener('click', () => {
  deliverNotifPops(notifSources.vanilla, [{
    id: null,
    type: 4,
    senderId: vanillaPlayer?.id || 1,
    senderName: vanillaPlayer?.userName || 'Coach',
    senderAvatar: vanillaPlayer?.AvatarUrl || '',
    sentTime: new Date().toISOString(),
  }], { force: true });
});

/// The retro skins, whose desktop pop-up slides up like Steam's old one
/// instead of fading in. Everything except the modern family and Liquid Glass.
const MODERN_SKIN_CLASSES = ['theme-neondark', 'theme-modernlight', 'theme-moderngreen',
                             'theme-blackandwhite', 'theme-blackandwhite-inverted'];
function isRetroSkin() {
  const cl = document.body.classList;
  return !cl.contains('glass-enabled') && !MODERN_SKIN_CLASSES.some(c => cl.contains(c));
}

document.addEventListener('click', (e) => {
  const menu = $('vanillaAccountMenu');
  if (menu && !menu.hidden && !menu.contains(e.target) && !$('vanillaAccountBtn')?.contains(e.target)) {
    closeAccountMenu();
  }
  const panel = $('vanillaNotifsPanel');
  if (panel && !panel.hidden && !panel.contains(e.target) && !$(panelSource.bell)?.contains(e.target)) {
    closeNotifPanel();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('vanillaAccountMenu')?.hidden) {
    closeAccountMenu();
    $('vanillaAccountBtn')?.focus();
  }
  if (!$('vanillaNotifsPanel')?.hidden) {
    closeNotifPanel();
    $(panelSource.bell)?.focus();
  }
});

// ── Vanilla cheers, subscriptions and Play ───────────────────────────────
// All of these act as the signed-in account, so each one offers the sign-in
// window instead when nobody is signed in.

/// The room, photo and player whose detail views are open, so their buttons
/// can be repainted when the account changes.
let socialRoom = null;
let socialPhoto = null;
let socialPerson = null;
/// Ids (as strings) of photos the account has cheered; `null` until fetched.
let cheeredPhotoIds = null;
/// The Play request in progress, if any: `{ roomId, cancelled, label }`.
let roomJoin = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function requireStellaLogin(what) {
  if (stellaPlayer) return true;
  toast(`Log in to Stella to ${what}.`, 'info');
  stellaSignIn();
  return false;
}

function requireVanillaLogin(what) {
  if (vanillaPlayer) return true;
  toast(`Sign in to Vanilla to ${what}.`, 'info');
  window.radium.vanillaLogin().catch(e => toast(String(e), 'error'));
  return false;
}

/// Cheer tiles: pressed state only; the icon and count stay as they are.
function setCheerPressed(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  // aria-pressed already says whether it is cheered; no `title` tooltip.
  if (btn.classList.contains('card-cheer')) btn.setAttribute('aria-label', `${btn.querySelector('.cheers-count')?.textContent || 0} cheers`);
}

/// Cheer tiles are only buttons on Vanilla and Stella; on Radium they are
/// plain stats.
function setCheerEnabled(btn, enabled) {
  if (!btn) return;
  btn.disabled = !enabled;
  if (!enabled) {
    setCheerPressed(btn, false);
  }
}

function bumpCount(el, delta) {
  // Only plain counts ("1,234"); an abbreviated or missing one is left alone.
  const text = String(el?.textContent ?? '').trim();
  if (!/^[\d,]+$/.test(text)) return;
  el.textContent = Math.max(0, parseInt(text.replace(/,/g, ''), 10) + delta).toLocaleString();
}

// Room cheer ─────────────────────────────────────────────────────────────

async function paintRoomCheer(room) {
  const btn = $('roomsDetailCheerBtn');
  const fav = $('roomsDetailFavoriteBtn');
  const stella = activeNetwork === 'stella';
  setCheerEnabled(btn, !!room);
  setCheerPressed(btn, false);
  // Favorite is Stella's only; there it takes the cheer tile's look too.
  fav?.classList.toggle('cheer-stat', stella);
  setCheerEnabled(fav, stella && !!room);
  setCheerPressed(fav, false);
  if (!btn || !room) return;
  if (stella) {
    if (!stellaPlayer) return;
    try {
      const state = await window.radium.stellaRoomInteraction(room.RoomId);
      if (socialRoom === room) {
        setCheerPressed(btn, !!state.cheered);
        setCheerPressed(fav, !!state.favorited);
      }
    } catch (e) {}
    return;
  }
  if (!vanillaPlayer) return;
  try {
    const on = await window.radium.vanillaRoomCheered(room.RoomId);
    if (socialRoom === room) setCheerPressed(btn, on);
  } catch (e) {}
}

/// Stella: cheer or favorite the open room from its tile. The tile and count
/// change at once and are put back if Stella says no.
async function toggleStellaRoom(btn, kind, countEl) {
  const room = socialRoom;
  if (!room || btn.dataset.pending === 'true') return;
  if (!requireStellaLogin(kind === 'cheer' ? 'cheer rooms' : 'favorite rooms')) return;
  const next = btn.getAttribute('aria-pressed') !== 'true';
  btn.dataset.pending = 'true';
  setCheerPressed(btn, next);
  bumpCount(countEl, next ? 1 : -1);
  try {
    const state = await window.radium.stellaSetRoomInteraction(room.RoomId, kind, next);
    const now = kind === 'cheer' ? !!state.cheered : !!state.favorited;
    // Stella's answer is the truth; it can differ if the tile was stale.
    if (socialRoom === room && now !== next) {
      setCheerPressed(btn, now);
      bumpCount(countEl, now ? 1 : -1);
    }
  } catch (err) {
    if (socialRoom === room) {
      setCheerPressed(btn, !next);
      bumpCount(countEl, next ? -1 : 1);
    }
    toast(`Couldn't update ${kind === 'cheer' ? 'cheer' : 'favorite'}: ${err}`, 'error');
  } finally {
    btn.dataset.pending = 'false';
  }
}

$('roomsDetailFavoriteBtn')?.addEventListener('click', (e) => {
  if (activeNetwork !== 'stella') return;
  toggleStellaRoom(e.currentTarget, 'favorite', $('roomsDetailFavorites'));
});

$('roomsDetailCheerBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (activeNetwork === 'stella') {
    toggleStellaRoom(btn, 'cheer', $('roomsDetailCheers'));
    return;
  }
  const room = socialRoom;
  if (!room || btn.dataset.pending === 'true') return;
  if (!requireVanillaLogin('cheer rooms')) return;

  const next = btn.getAttribute('aria-pressed') !== 'true';
  btn.dataset.pending = 'true';
  setCheerPressed(btn, next);
  bumpCount($('roomsDetailCheers'), next ? 1 : -1);
  try {
    await window.radium.vanillaSetRoomCheer(room.RoomId, next);
  } catch (err) {
    if (socialRoom === room) {
      setCheerPressed(btn, !next);
      bumpCount($('roomsDetailCheers'), next ? -1 : 1);
    }
    toast(`Couldn't update cheer: ${err}`, 'error');
  } finally {
    btn.dataset.pending = 'false';
  }
});

// Photo cheer ────────────────────────────────────────────────────────────
// The same photo can be on screen more than once (a feed card, a room's
// grid, the detail view), so every control for it is kept in step through
// `data-photo-id`, and one toggle at a time is allowed per photo.

let cheeredPhotosLoad = null;
const photoCheerPending = new Set();

const photoIdOf = photo => String(photo?.Id ?? photo?.id ?? '');

/// Whether a photo gets a cheer button: Vanilla and Stella can cheer photos.
const photoCheerable = photo =>
  (activeNetwork === 'vanilla' || activeNetwork === 'stella') && (photo?.Id ?? photo?.id) != null;

/// Stella: photo id → cheered, for the signed-in account. Stella has no list
/// of everything an account has cheered, only a per-photo check, so the
/// photos on screen are asked about together (see stellaPhotoCheered).
let stellaCheerKnown = new Map();
let stellaCheerBatch = null;

/// Whether the Stella account has cheered photo `id`. Every photo asked about
/// in the same moment (a page of cards) goes in one request.
function stellaPhotoCheered(id) {
  if (!stellaPlayer) return Promise.resolve(false);
  if (stellaCheerKnown.has(id)) return Promise.resolve(stellaCheerKnown.get(id));
  if (!stellaCheerBatch) {
    const account = stellaPlayer.id;
    const batch = { ids: new Set() };
    batch.done = sleep(0)
      .then(() => {
        if (stellaCheerBatch === batch) stellaCheerBatch = null;
        return window.radium.stellaCheeredPhotos([...batch.ids]);
      })
      .then(cheered => {
        if (stellaPlayer?.id !== account) return;
        const on = new Set(cheered.map(String));
        for (const i of batch.ids) stellaCheerKnown.set(i, on.has(i));
      })
      .catch(() => {});
    stellaCheerBatch = batch;
  }
  stellaCheerBatch.ids.add(id);
  return stellaCheerBatch.done.then(() => !!stellaCheerKnown.get(id));
}

/// Whether the signed-in account has cheered photo `id`, on either network.
async function photoCheered(id) {
  if (activeNetwork === 'stella') return stellaPhotoCheered(id);
  const set = await cheeredPhotoSet();
  return !!set && set.has(id);
}

/// The account's cheered photo ids, fetched once and shared by every card.
function cheeredPhotoSet() {
  if (!vanillaPlayer) return Promise.resolve(null);
  if (cheeredPhotoIds) return Promise.resolve(cheeredPhotoIds);
  if (!cheeredPhotosLoad) {
    const account = vanillaPlayer.id;
    cheeredPhotosLoad = window.radium.vanillaCheeredPhotos()
      .then(list => {
        if (vanillaPlayer?.id !== account) return null;
        cheeredPhotoIds = new Set(list);
        return cheeredPhotoIds;
      })
      .catch(() => null)
      .finally(() => { cheeredPhotosLoad = null; });
  }
  return cheeredPhotosLoad;
}

/// Every cheer control for one photo: its cards, and the detail view if open.
function photoCheerControls(id) {
  const controls = [...document.querySelectorAll('.card-cheer')].filter(el => el.dataset.photoId === id);
  const detail = $('photoDetailCheerBtn');
  if (detail && socialPhoto && photoIdOf(socialPhoto) === id) controls.push(detail);
  return controls;
}

function showPhotoCheer(id, cheered, count) {
  for (const btn of photoCheerControls(id)) {
    if (count != null) {
      const el = btn.querySelector('.cheers-count, #photoDetailCheers');
      if (el) el.textContent = Number(count).toLocaleString();
    }
    setCheerPressed(btn, cheered);
  }
}

async function togglePhotoCheer(photo) {
  const id = photoIdOf(photo);
  if (!id || photoCheerPending.has(id)) return;
  if (activeNetwork === 'stella') {
    toggleStellaPhotoCheer(photo, id);
    return;
  }
  if (!requireVanillaLogin('cheer photos')) return;

  photoCheerPending.add(id);
  try {
    // Vanilla toggles and reports the result, so nothing is guessed here.
    const res = await window.radium.vanillaTogglePhotoCheer(id);
    if (cheeredPhotoIds) {
      if (res.cheered) cheeredPhotoIds.add(id); else cheeredPhotoIds.delete(id);
    }
    if (res.cheerCount != null) photo.CheerCount = res.cheerCount;
    showPhotoCheer(id, res.cheered, res.cheerCount);
  } catch (err) {
    toast(`Couldn't update cheer: ${err}`, 'error');
  } finally {
    photoCheerPending.delete(id);
  }
}

/// Stella sets a cheer rather than toggling it, and answers with nothing, so
/// the new state comes from the one known before and the count is moved here.
async function toggleStellaPhotoCheer(photo, id) {
  if (!requireStellaLogin('cheer photos')) return;
  photoCheerPending.add(id);
  try {
    const next = !(await stellaPhotoCheered(id));
    await window.radium.stellaSetPhotoCheer(id, next);
    stellaCheerKnown.set(id, next);
    const count = Math.max(0, (Number(photo.CheerCount ?? photo.cheerCount) || 0) + (next ? 1 : -1));
    photo.CheerCount = count;
    showPhotoCheer(id, next, count);
  } catch (err) {
    // Most likely cheered or un-cheered somewhere else (the game) meanwhile:
    // ask again, so the button shows what Stella has.
    stellaCheerKnown.delete(id);
    showPhotoCheer(id, await stellaPhotoCheered(id));
    toast(`Couldn't update cheer: ${err}`, 'error');
  } finally {
    photoCheerPending.delete(id);
  }
}

/// The thumbs-up pill in a photo card's footer.
function buildCardCheer(photo) {
  const id = photoIdOf(photo);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-cheer';
  btn.dataset.photoId = id;

  const icon = document.createElement('span');
  icon.className = 'vn-icon vn-icon-thumb cheer-icon';
  icon.setAttribute('aria-hidden', 'true');
  const count = document.createElement('span');
  count.className = 'cheers-count';
  count.textContent = (Number(photo.CheerCount ?? photo.cheerCount) || 0).toLocaleString();
  btn.append(icon, count);

  setCheerPressed(btn, false);
  paintCardCheer(btn);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePhotoCheer(photo);
  });
  return btn;
}

async function paintCardCheer(btn) {
  setCheerPressed(btn, await photoCheered(btn.dataset.photoId));
}

async function paintPhotoCheer(photo) {
  const btn = $('photoDetailCheerBtn');
  setCheerEnabled(btn, !!photo);
  setCheerPressed(btn, false);
  if (!btn || !photo) return;
  const cheered = await photoCheered(photoIdOf(photo));
  if (socialPhoto === photo) setCheerPressed(btn, cheered);
}

$('photoDetailCheerBtn')?.addEventListener('click', () => {
  if (socialPhoto) togglePhotoCheer(socialPhoto);
});

// Subscribe ──────────────────────────────────────────────────────────────

function setSubscribed(btn, on) {
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? 'SUBSCRIBED' : 'SUBSCRIBE';
  // Filled while it is an invitation, quiet once it's done — as on the site.
  btn.classList.toggle('modal-btn-primary', !on);
  btn.classList.toggle('modal-btn-secondary', on);
}

async function paintSubscribe(person) {
  const btn = $('peopleDetailSubscribeBtn');
  if (!btn) return;
  setSubscribed(btn, false);
  const id = Number(person?.id);
  // Hidden on your own profile and on rows without a real id.
  btn.hidden = !person || !id || id === vanillaPlayer?.id;
  if (btn.hidden || !vanillaPlayer) return;
  try {
    const on = await window.radium.vanillaSubscribed(id);
    if (socialPerson === person) setSubscribed(btn, on);
  } catch (e) {}
}

$('peopleDetailSubscribeBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const person = socialPerson;
  const id = Number(person?.id);
  if (!id || btn.dataset.pending === 'true') return;
  if (!requireVanillaLogin('subscribe to players')) return;

  const next = btn.getAttribute('aria-pressed') !== 'true';
  btn.dataset.pending = 'true';
  setSubscribed(btn, next);
  bumpCount($('peopleDetailSubscribers'), next ? 1 : -1);
  try {
    await window.radium.vanillaSetSubscribed(id, next);
  } catch (err) {
    if (socialPerson === person) {
      setSubscribed(btn, !next);
      bumpCount($('peopleDetailSubscribers'), next ? -1 : 1);
    }
    toast(`Couldn't update subscription: ${err}`, 'error');
  } finally {
    btn.dataset.pending = 'false';
  }
});

// Play (join a room) ─────────────────────────────────────────────────────

/// How long Play keeps retrying while the game starts and the player signs in.
const JOIN_WAIT_MS = 3 * 60 * 1000;
const JOIN_RETRY_MS = 5000;

function paintPlayButton() {
  const btn = $('roomsDetailPlay');
  if (!btn) return;
  const waiting = roomJoin && socialRoom && roomJoin.roomId === socialRoom.RoomId;
  const label = btn.querySelector('.room-play-label') || btn;
  label.textContent = waiting ? roomJoin.label : '▶ PLAY';
  btn.classList.toggle('is-busy', !!waiting);
  btn.setAttribute('aria-label', waiting ? 'Cancel joining this room' : 'Join this room in the game');
}

function setJoinLabel(job, label) {
  job.label = label;
  if (roomJoin === job) paintPlayButton();
}

/// Start the game through the same checks the Home Play button runs.
function startGameForJoin() {
  if (isGameRunning || isGameLaunching || !isInstalled) return;
  isGameLaunching = true;
  checkAvAndLaunch();
}

const normRoom = s => String(s ?? '').toLowerCase().replace('^', '').trim();

/// After Vanilla accepts the join, watch `/me` until the game is in the room.
async function confirmJoined(job, room) {
  const until = Date.now() + 30000;
  while (!job.cancelled && Date.now() < until) {
    try {
      const cur = await window.radium.vanillaCurrentRoom();
      if (cur && (normRoom(cur.id) === normRoom(room.RoomId) || normRoom(cur.name) === normRoom(room.Name))) {
        return true;
      }
    } catch (e) {}
    await sleep(1500);
  }
  return false;
}

async function playRoom(room) {
  const job = { roomId: room.RoomId, cancelled: false, label: 'JOINING…' };
  roomJoin = job;
  paintPlayButton();
  const roomName = room.Name || 'the room';
  let prompted = false;
  const deadline = Date.now() + JOIN_WAIT_MS;

  try {
    while (!job.cancelled) {
      let res;
      try {
        res = await window.radium.vanillaJoinRoom(room.RoomId);
      } catch (err) {
        toast(`Couldn't join: ${err}`, 'error');
        return;
      }
      if (job.cancelled) return;

      if (res.success) {
        setJoinLabel(job, 'JOINING…');
        addLog(`Vanilla is sending your game to ^${roomName}`, 'info', 'game');
        if (await confirmJoined(job, room)) {
          toast(`Joined ^${roomName}`, 'ok');
          addLog(`Joined ^${roomName}`, 'ok', 'game');
          setJoinLabel(job, '✓ JOINED');
          await sleep(2000);
        } else if (!job.cancelled) {
          toast(`Sent to ^${roomName}. Check your game.`, 'info');
        }
        return;
      }

      if (!res.notOnline) {
        toast(res.message || `Vanilla couldn't join ^${roomName}.`, 'error');
        return;
      }

      // The game isn't running, or isn't signed in yet. Start it once, then
      // keep asking until the player is in, or time runs out.
      if (!prompted) {
        prompted = true;
        if (!isGameRunning) {
          if (!isInstalled) {
            toast('Install the Vanilla client first.', 'error');
            return;
          }
          toast('Starting the game. Sign in to your Vanilla account in-game and you will join automatically.', 'info', 7000);
          startGameForJoin();
        } else {
          toast('Sign in to your Vanilla account in-game. You will join automatically.', 'info', 7000);
        }
      }
      if (Date.now() > deadline) {
        toast('Gave up waiting for the game. Press Play again once you are signed in in-game.', 'error', 6000);
        return;
      }
      setJoinLabel(job, 'WAITING FOR GAME…');
      await sleep(JOIN_RETRY_MS);
    }
  } finally {
    if (roomJoin === job) roomJoin = null;
    paintPlayButton();
  }
}

$('roomsDetailPlay')?.addEventListener('click', () => {
  const room = socialRoom;
  if (!room || !room.RoomId) return;
  if (activeNetwork === 'stella') {
    playStellaRoom(room);
    return;
  }
  // A second click on the room already joining cancels it.
  if (roomJoin && roomJoin.roomId === room.RoomId) {
    roomJoin.cancelled = true;
    roomJoin = null;
    paintPlayButton();
    return;
  }
  if (!requireVanillaLogin('join rooms')) return;
  // Only one join at a time: a new room replaces the old request.
  if (roomJoin) roomJoin.cancelled = true;
  playRoom(room);
});

// Entry points from the detail views ────────────────────────────────────

function setupRoomSocial(room) {
  socialRoom = (activeNetwork === 'vanilla' || activeNetwork === 'stella') && room?.RoomId ? room : null;
  paintPlayButton();
  paintRoomCheer(socialRoom);
}

function setupPhotoSocial(photo) {
  socialPhoto = photoCheerable(photo) ? photo : null;
  paintPhotoCheer(socialPhoto);
}

function setupPersonSocial(person) {
  socialPerson = activeNetwork === 'vanilla' ? person : null;
  paintSubscribe(socialPerson);
}

function refreshSocialButtons() {
  document.querySelectorAll('.card-cheer').forEach(btn => {
    setCheerPressed(btn, false);
    paintCardCheer(btn);
  });
  if (socialRoom) paintRoomCheer(socialRoom);
  if (socialPhoto) paintPhotoCheer(socialPhoto);
  if (socialPerson) paintSubscribe(socialPerson);
}

(async () => {
  if (!window.radium?.onVanillaAuth) return;
  await window.radium.onVanillaAuth(applyVanillaAuth);
  try {
    applyVanillaAuth(await window.radium.vanillaAuthStatus());
  } catch (e) {}
})();

// ── Custom selects ───────────────────────────────────────────────────────
// Every <select class="cfg-input"> is rebuilt as a button and a menu — see the
// .cselect rules in style.css for why. The native <select> is kept, hidden, as
// the source of truth: the existing code goes on reading .value, listening for
// `change` and toggling .disabled on it, and the custom control follows along.

/// The trigger, label and menu built for each enhanced select.
const cselectParts = new WeakMap();

/// The select whose menu is open. One at a time, like the other dropdowns.
let openCselect = null;

/// The nearest ancestor that scrolls vertically — the box an open menu is
/// clipped by — or <body> when nothing between does.
function scrollParentOf(el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.body;
}

function enhanceSelects() {
  document.querySelectorAll('select.cfg-input').forEach(enhanceSelect);
}

function enhanceSelect(select) {
  if (cselectParts.has(select)) return;

  const wrap = document.createElement('div');
  wrap.className = 'cselect';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cfg-input cselect-trigger';
  // Inline sizing in the markup was written for the control that is drawn.
  const inline = select.getAttribute('style');
  if (inline) trigger.setAttribute('style', inline);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const label = document.createElement('span');
  label.className = 'cselect-label';
  const caret = document.createElement('span');
  caret.className = 'cselect-caret';
  caret.setAttribute('aria-hidden', 'true');
  trigger.append(label, caret);

  const menu = document.createElement('div');
  menu.className = 'cselect-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  if (select.id) {
    menu.id = `${select.id}-menu`;
    trigger.setAttribute('aria-controls', menu.id);
    // The <label for> still names the hidden select; let it name the button.
    const lbl = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    if (lbl) {
      if (!lbl.id) lbl.id = `${select.id}-label`;
      trigger.setAttribute('aria-labelledby', lbl.id);
    }
  }

  for (const opt of select.options) {
    const item = document.createElement('button');
    item.type = 'button';
    // .nav-btn so every skin paints the rows as it paints its nav rows.
    item.className = 'nav-btn cselect-option';
    item.setAttribute('role', 'option');
    item.dataset.value = opt.value;
    item.textContent = opt.textContent;
    item.addEventListener('click', () => chooseCselectOption(select, opt.value));
    menu.appendChild(item);
  }

  select.parentNode.insertBefore(wrap, select);
  wrap.append(select, trigger, menu);
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  cselectParts.set(select, { wrap, trigger, label, menu });

  // setValue() and anything else assigning .value fire no event, so the
  // assignment itself is intercepted to keep the label in step.
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return native.get.call(this); },
    set(v) { native.set.call(this, v); syncCselect(this); },
  });
  select.addEventListener('change', () => syncCselect(select));
  // .disabled reflects to the attribute, which is what the bug-report
  // cooldown and the glass lock on Active Skin both toggle.
  new MutationObserver(() => syncCselect(select))
    .observe(select, { attributes: true, attributeFilter: ['disabled'] });

  trigger.addEventListener('click', () => {
    if (openCselect === select) closeCselect(); else openCselectMenu(select);
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openCselectMenu(select);
    }
  });

  syncCselect(select);
}

function syncCselect(select) {
  const parts = cselectParts.get(select);
  if (!parts) return;
  const current = select.options[select.selectedIndex];
  parts.label.textContent = current ? current.textContent : '';
  parts.trigger.disabled = select.disabled;
  for (const item of parts.menu.children) {
    const on = item.dataset.value === select.value;
    item.classList.toggle('active', on);
    item.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (select.disabled && openCselect === select) closeCselect();
}

function chooseCselectOption(select, value) {
  const changed = select.value !== value;
  select.value = value;
  closeCselect(true);
  if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
}

function openCselectMenu(select) {
  const parts = cselectParts.get(select);
  if (!parts || select.disabled) return;
  if (openCselect && openCselect !== select) closeCselect();
  openCselect = select;

  parts.wrap.closest('.settings-group')?.classList.add('cselect-host');
  parts.menu.classList.remove('opens-up');
  showDropdown(parts.menu);

  // Open upward when the menu would run past the bottom of whatever clips it
  // and there is more room above — the bug-report selects are the last thing
  // on Settings. Measured against the nearest ancestor that actually scrolls:
  // on Settings that is .settings-body, not the tab, whose rect also takes in
  // the page title the menu cannot draw over.
  const bounds = scrollParentOf(parts.wrap).getBoundingClientRect();
  const t = parts.trigger.getBoundingClientRect();
  const below = bounds.bottom - t.bottom;
  const above = t.top - bounds.top;
  if (parts.menu.offsetHeight + 4 > below && above > below) {
    parts.menu.classList.add('opens-up');
  }

  parts.trigger.setAttribute('aria-expanded', 'true');
  parts.trigger.classList.add('is-open');

  // Scrolled by hand rather than scrollIntoView(), which would also scroll the
  // Settings tab behind the menu.
  const selected = parts.menu.querySelector('.cselect-option.active') || parts.menu.firstElementChild;
  if (selected) {
    parts.menu.scrollTop = selected.offsetTop - (parts.menu.clientHeight - selected.offsetHeight) / 2;
    selected.focus({ preventScroll: true });
  }
}

function closeCselect(refocus = false) {
  const select = openCselect;
  if (!select) return;
  openCselect = null;
  const parts = cselectParts.get(select);
  hideDropdown(parts.menu);
  parts.trigger.setAttribute('aria-expanded', 'false');
  parts.trigger.classList.remove('is-open');
  // Held until the exit animation is over, so the closing menu is not dropped
  // under the next group mid-fade. Skipped if it reopened in the meantime.
  setTimeout(() => {
    if (openCselect !== select) parts.wrap.closest('.settings-group')?.classList.remove('cselect-host');
  }, MENU_EXIT_MS);
  if (refocus) parts.trigger.focus();
}

document.addEventListener('click', (e) => {
  if (!openCselect) return;
  if (cselectParts.get(openCselect).wrap.contains(e.target)) return;
  closeCselect();
});
document.addEventListener('keydown', (e) => {
  if (!openCselect) return;
  const items = Array.from(cselectParts.get(openCselect).menu.children);
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCselect(true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
    items[next]?.focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
  } else if (e.key === 'Tab') {
    closeCselect();
  }
});

enhanceSelects();
// ── end custom selects ──

async function init() {
  addLog('Radium Launcher started.', 'ok');
  await loadVersion();
  await loadConfig();

  // Launcher/session identity up front so an exported log is self-describing.
  addLog(`Launcher version: v${launcherVersion || 'unknown'} | platform: ${navigator.platform || 'unknown'}`, 'info');

  // Check for launcher updates first on startup (run in background, do not block initialization)
  checkForLauncherUpdate();

  addLog(`Network: ${networkInfo().label} (${networkInfo().site})`, 'info');
  addLog(`API: ${config.apiUrl}`, 'info');
  addLog(`Install dir: ${shownInstallDir()}`, 'info');

  // Check install first (determines which panel to show)
  await checkInstall();

  // If a download was interrupted last session, offer to resume it.
  await offerResumeIfAny();

  // Check server on startup (show results in log), then silently every 60s —
  // but only while the window is on screen. Both of these paint the Home tab's
  // quick-stats card and nothing else, so polling them behind a hidden window
  // is two requests a minute for numbers nobody can see, for however long the
  // launcher sits in the tray between play sessions. The notification poll
  // below already works this way; these did not.
  //
  // A hidden window is skipped rather than having its timer cleared, so the
  // tick that follows the window coming back is at most a minute away, and the
  // `visibilitychange` handler refreshes it at once so the card is never stale
  // on the frame it is shown.
  await checkServerStatus(false);
  const serverPollInterval = setInterval(() => {
    if (!document.hidden) checkServerStatus(true);
  }, 60_000);

  // Check player count on startup (show results in log), then silently every 60s
  await updatePlayerCount(false);
  const playerPollInterval = setInterval(() => {
    if (!document.hidden) updatePlayerCount(true);
  }, 60_000);

  // Back on screen: bring the card up to date now rather than on the next tick.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkServerStatus(true);
    updatePlayerCount(true);
  });

  // Clear the polls if the window is closed
  window.addEventListener('beforeunload', () => {
    clearInterval(serverPollInterval);
    clearInterval(playerPollInterval);
  });

  // With startup done and nothing else competing for the connection, start
  // downloading the lists Rooms and People are going to want. Last, and
  // awaited by nothing: on Vanilla these are megabytes, and the point is that
  // they arrive while the user is still on Home rather than on the click that
  // opens the tab.
  //
  // Not while the launcher has started hidden in the tray, which with "start
  // with Windows" on is every sign-in: on Vanilla that was a 5 MB download
  // parsed into ~50 MB of player records for a window nobody had opened, which
  // the backend then dropped again after fifteen idle minutes. The first time
  // the window is shown does it instead.
  if (document.hidden) {
    const prefetchWhenShown = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', prefetchWhenShown);
      window.radium?.prefetchNetworkData();
    };
    document.addEventListener('visibilitychange', prefetchWhenShown);
  } else {
    window.radium?.prefetchNetworkData();
  }

  // Disable default context menu
  document.addEventListener('contextmenu', e => e.preventDefault());
}

init().catch(err => {
  addLog(`Init error: ${err.message}`, 'error');
  console.error(err);
});

// Native Rooms & People Loading Controller
let roomsSkip = 0;
const roomsTake = 12;
let activeRoomsTag = '';
let activeRoomsSort = 0;
let roomsSearchQuery = '';
let roomsSequenceId = 0;

let peopleSkip = 0;
const peopleTake = 15;
let peopleSearchQuery = '';
let peopleSequenceId = 0;

// What the Rooms grid, People table and Filters rail are currently showing, and
// when. Opening a tab used to refetch unconditionally: the list blanked to
// "Loading...", the identical page came back over the identical round-trips, and
// the view you had just been reading rebuilt itself in front of you. A list is
// now refetched only when the query behind it changed, or when what is on screen
// has aged past LIST_STALE_MS.
let roomsRenderKey = '';
let roomsRenderAt = 0;
let peopleRenderKey = '';
let peopleRenderAt = 0;
let filtersRenderKey = '';

/// How old a rendered list may be before reopening its tab refreshes it.
const LIST_STALE_MS = 5 * 60 * 1000;

/// Everything that decides what a page of rooms contains. Two renders with the
/// same key are the same page, so the second one is not worth fetching.
function roomsKey() {
  return JSON.stringify([activeNetwork, roomsSkip, activeRoomsSort, roomsSearchQuery, activeRoomsTag]);
}

function peopleKey() {
  return JSON.stringify([activeNetwork, peopleSkip, peopleSearchQuery]);
}

/// How long the People list on screen stays fresh: Stella's list of who is
/// online, and in which room, ages faster than a search.
let peopleFreshMs = LIST_STALE_MS;
const ONLINE_LIST_STALE_MS = 60 * 1000;

function listIsFresh(key, renderedKey, renderedAt, maxAge = LIST_STALE_MS) {
  return key === renderedKey && Date.now() - renderedAt < maxAge;
}

/// Put a list into its loading state, showing the placeholder only when there
/// is nothing worth keeping on screen.
///
/// Blanking a populated list on every page click and every keystroke of a
/// search is most of why paging felt slow even when the data arrived quickly:
/// what people were reading vanished first, and the layout collapsed with it.
/// Dimming the rows that are there keeps the page still, and they are replaced
/// the moment the new ones land.
///
/// `data-list-placeholder` marks a container whose only content is a loading
/// line, an empty-state or an error — nothing a reader would mind losing, so
/// those are replaced rather than dimmed.
function beginListLoad(el, placeholder) {
  if (!el) return;
  if (!el.children.length || el.dataset.listPlaceholder === '1') {
    el.innerHTML = placeholder;
    el.dataset.listPlaceholder = '1';
  }
  el.classList.add('is-refreshing');
}

function endListLoad(el) {
  el?.classList.remove('is-refreshing');
}

/// Text for a pagination readout.
///
/// `totalKnown === false` means the backend is paging a source that never
/// reports its size (Vanilla enumerates its player roster, and its list
/// endpoints cap rows without saying how many were withheld). Printing
/// "of N" there produces a total that grows every time you press Next, so the
/// page number is shown on its own instead of quoting a number that moves.
function pageLabel(skip, take, total, totalKnown) {
  const currentPage = Math.floor(skip / take) + 1;
  if (totalKnown === false) return `Page ${currentPage}`;
  const totalPages = Math.ceil(total / take);
  return `Page ${currentPage} of ${Math.max(1, totalPages)}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadFilters() {
  const listEl = $('roomsFiltersList');
  if (!listEl) return;

  // The rail's contents depend on nothing but the network — on Vanilla it is a
  // tally over the whole cached room set — so once it is built, reopening the
  // tab has nothing to learn by building it again.
  if (filtersRenderKey === activeNetwork && listEl.children.length) return;

  listEl.innerHTML = '<div style="font-size: 10px; color: var(--text-muted); padding: 4px;">Loading filters...</div>';
  
  const res = await window.radium?.fetchFilters();
  if (res && res.success && res.data) {
    const pinned = res.data.PinnedFilters || [];
    const popular = res.data.PopularFilters || [];
    
    // De-duplicate tags
    const allTags = Array.from(new Set(['all', ...pinned, ...popular]));
    
    listEl.innerHTML = '';
    allTags.forEach(tag => {
      const btn = document.createElement('button');
      btn.className = 'filter-btn';
      if (tag === 'all') {
        btn.textContent = 'All Rooms';
        if (!activeRoomsTag) btn.classList.add('active');
      } else {
        btn.textContent = tag;
        if (activeRoomsTag === tag) btn.classList.add('active');
      }
      
      btn.addEventListener('click', () => {
        document.querySelectorAll('#roomsFiltersList .filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeRoomsTag = (tag === 'all') ? '' : tag;
        // Mirror of the search handler: on Vanilla the two share one field, so
        // picking a tag clears whatever was typed.
        if (!networkInfo().hasFilters && activeRoomsTag && roomsSearchQuery) {
          roomsSearchQuery = '';
          setValue('roomsSearch', '');
        }
        roomsSkip = 0;
        loadRooms();
      });
      listEl.appendChild(btn);
    });
    filtersRenderKey = activeNetwork;
  } else {
    // Left unset so the next visit retries rather than caching the failure.
    filtersRenderKey = '';
    // Signed out of Stella, or no Steam: the rooms list beside this says so.
    listEl.innerHTML = res?.error === STELLA_SIGNED_OUT || res?.error === STEAM_NOT_RUNNING
      ? ''
      : '<div style="font-size: 10px; color: var(--text-muted); text-align: center; padding: 4px;">Error loading filters</div>';
  }
}

/// What a failed Rooms or People load shows. Signed out of Stella isn't an
/// error, so it gets a way to sign in instead.
function listErrorHtml(res, what) {
  if (res?.error === STELLA_SIGNED_OUT) {
    return `Log in to Stella to see ${what}.<br><button type="button" class="btn-refresh stella-login-prompt" data-stella-login>LOG IN WITH STEAM</button>`;
  }
  if (String(res?.error || '').startsWith("Couldn't reach Stella")) {
    return `${escapeHtml(res.error)}<br><button type="button" class="btn-refresh stella-login-prompt" data-stella-retry>TRY AGAIN</button>`;
  }
  if (res?.error === STEAM_NOT_RUNNING) {
    // Lets the window's focus handler retry once Steam is up.
    stellaAuthError = STEAM_NOT_RUNNING;
    return `Start Steam to see ${what}. Stella signs in with your Steam account.<br><button type="button" class="btn-refresh stella-login-prompt" data-stella-retry>TRY AGAIN</button>`;
  }
  return `Error: ${escapeHtml(res?.error || `Failed to fetch ${what}`)}`;
}

async function loadRooms() {
  const gridEl = $('roomsGrid');
  const emptyEl = $('roomsEmptyMsg');
  if (!gridEl) return;
  
  roomsSequenceId++;
  const currentSeq = roomsSequenceId;
  const key = roomsKey();
  
  beginListLoad(gridEl, '<div style="grid-column: 1 / -1; text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Loading rooms...</div>');
  emptyEl?.classList.add('hidden');
  
  const res = await window.radium?.fetchRooms({
    skip: roomsSkip,
    take: roomsTake,
    sortBy: activeRoomsSort,
    query: roomsSearchQuery,
    tag: activeRoomsTag
  });
  
  if (currentSeq !== roomsSequenceId) return;
  endListLoad(gridEl);
  
  if (res && res.success && res.data) {
    // Signed in on the way (Steam was started after the startup check).
    if (activeNetwork === 'stella' && !stellaPlayer) refreshStellaAuth();
    const rooms = res.data.Results || [];
    const total = res.data.TotalResults || 0;
    roomsRenderKey = key;
    roomsRenderAt = Date.now();
    
    gridEl.innerHTML = '';
    if (rooms.length === 0) {
      gridEl.dataset.listPlaceholder = '1';
      // Most Players lists only rooms with someone in them, so an empty page
      // there means nobody is playing in one, not a search that missed.
      if (emptyEl) {
        emptyEl.textContent = activeRoomsSort === 5 && !roomsSearchQuery
          ? 'Nobody is in any of these rooms right now.'
          : 'No rooms matched your search.';
      }
      emptyEl?.classList.remove('hidden');
    } else {
      delete gridEl.dataset.listPlaceholder;
      rooms.forEach(room => {
        // The grid is 2 columns, 3 on a wide window, so a card reaches about
        // 550 CSS px maximised — 480 was an upscale before the pixel ratio was
        // even applied.
        const thumbUrl = roomThumbUrl(room, 560);
        
        const card = document.createElement('div');
        card.className = 'room-card';
        card.onclick = () => {
          showRoomDetails(room);
        };
        const roomName = room.Name || room.name || 'Unknown Room';
        const creatorUsername = room.CreatorUsername || room.creatorUsername || 'Unknown';
        card.innerHTML = `
          <img class="room-card-image image-loading-placeholder" loading="lazy" decoding="async" data-fallback="./images.png" src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(roomName)}" />
          ${liveBadgeHtml(room)}
          <div class="room-card-name">${escapeHtml(roomName)}</div>
          <div class="room-card-creator">by ${escapeHtml(creatorUsername)}</div>
        `;
        // Attach the creator click via a closure rather than inline onclick so a
        // username containing quotes can't break out of the JS-string context.
        const creatorEl = card.querySelector('.room-card-creator');
        if (creatorEl) {
          creatorEl.addEventListener('click', (e) => {
            e.stopPropagation();
            showCreatorProfile(creatorUsername, {
              id: room.CreatorPlayerId ?? room.CreatorAccountId ?? null,
              displayName: room.CreatorUsername,
              avatarUrl: room.CreatorAvatarUrl
            });
          });
        }
        gridEl.appendChild(card);
      });
    }
    
    // Pagination text & buttons state
    const txtPage = $('txtRoomsPage');
    if (txtPage) {
      txtPage.textContent = pageLabel(roomsSkip, roomsTake, total, res.data.TotalKnown);
    }
    
    const btnPrev = $('btnRoomsPrev');
    const btnNext = $('btnRoomsNext');
    if (btnPrev) btnPrev.disabled = (roomsSkip === 0);
    if (btnNext) btnNext.disabled = (roomsSkip + roomsTake >= total);
  } else {
    // Escaped: this string can carry text straight from a remote API (an error
    // object's message, or a prefix of an unparseable response body), and
    // unescaped markup here reaches a webview that can call every backend
    // command.
    // Cleared so the next visit retries instead of treating the error as the
    // rendered page.
    roomsRenderKey = '';
    gridEl.dataset.listPlaceholder = '1';
    gridEl.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">${listErrorHtml(res, 'rooms')}</div>`;
    const txtPage = $('txtRoomsPage');
    if (txtPage) txtPage.textContent = 'Page 1 of 1';
    const btnPrev = $('btnRoomsPrev');
    const btnNext = $('btnRoomsNext');
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
  }
}

/// Snap a scrollable table's visible height to a whole number of rows.
///
/// `#peopleTableContainer` is `flex: 1`, so its height is whatever the window
/// leaves over after the search bar and pagination row — never a clean
/// multiple of one table row's height. At most window sizes that lands the
/// container boundary in the middle of the last row: neither fully shown nor
/// fully hidden, which reads as a rendering bug rather than "scroll for more."
/// Capping the container just below its natural height, at the nearest whole
/// row, leaves a little blank space beneath the table instead — normal for a
/// native list view, and a row is never shown chopped in half.
///
/// Safe to call with zero or one rows: with nothing to measure it leaves the
/// container's height alone.
function snapTableRows(container) {
  if (!container) return;
  const thead = container.querySelector('thead');
  const firstRow = container.querySelector('tbody tr');
  if (!thead || !firstRow) return;

  // Clear any earlier cap first, so a page with fewer rows (or a window that
  // just grew) is measured against the container's real available space
  // rather than a stale, shorter one from the last snap.
  container.style.maxHeight = '';
  const available = container.clientHeight;

  const headH = thead.getBoundingClientRect().height;
  const rowH = firstRow.getBoundingClientRect().height;
  if (!(rowH > 0) || available <= headH) return;

  const rows = Math.floor((available - headH) / rowH);
  // An oddly short window should still show whatever partial content it can
  // rather than the list collapsing to nothing.
  if (rows < 1) return;

  // `max-height` constrains the border box (the global reset puts every
  // element on box-sizing: border-box), while `clientHeight` above measured
  // the content box. Several skins redraw this container with their own
  // border, so the gap between the two is read back from the element rather
  // than assumed — a hardcoded border width would have undercounted on any
  // skin that draws it thicker, clipping the last row by the difference
  // instead of the many rows' worth this was meant to fix.
  const cs = getComputedStyle(container);
  const frame = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
              + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

  container.style.maxHeight = Math.ceil(headH + rows * rowH + frame) + 'px';
}

// Re-snap on resize, not just on load: the row count is fixed once rendered,
// but the available height changes as the window does. Only while People is
// the visible tab — recomputing against a `display:none` panel would measure
// zero and clear the cap for no reason, and the People tab re-snaps itself
// anyway the next time it is opened.
let _peopleResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_peopleResizeTimer);
  _peopleResizeTimer = setTimeout(() => {
    if (document.getElementById('tab-people')?.classList.contains('active')) {
      snapTableRows($('peopleTableContainer'));
    }
  }, 150);
});

/// Where a Stella player is, for People's Room column: blank unless online.
function stellaWhere(person) {
  if (person.isOnline !== true) return '';
  if (person.roomName) return person.roomPrivate ? `${person.roomName} · private` : person.roomName;
  return person.roomPrivate ? 'A private room' : '';
}

/// Asks again while Stella's online list is still filling in (see
/// stella_api::browse_online's `partial`).
let peopleRefill = null;

async function loadPeople() {
  const bodyEl = $('peopleListBody');
  if (!bodyEl) return;
  clearTimeout(peopleRefill);

  peopleSequenceId++;
  const currentSeq = peopleSequenceId;
  const key = peopleKey();
  
  beginListLoad(bodyEl, '<tr><td colspan="5" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Loading players...</td></tr>');
  
  const res = await window.radium?.fetchPeople({
    skip: peopleSkip,
    take: peopleTake,
    query: peopleSearchQuery
  });
  
  if (currentSeq !== peopleSequenceId) return;
  endListLoad(bodyEl);
  
  if (res && res.success && res.data) {
    // Signed in on the way (Steam was started after the startup check).
    if (activeNetwork === 'stella' && !stellaPlayer) refreshStellaAuth();
    const people = res.data.Results || [];
    const total = res.data.TotalResults || 0;
    peopleRenderKey = key;
    peopleRenderAt = Date.now();
    peopleFreshMs = activeNetwork === 'stella' && !peopleSearchQuery ? ONLINE_LIST_STALE_MS : LIST_STALE_MS;
    
    // Stella's online list is still filling in: ask again shortly, unless the
    // user has moved on to a search, another page or another tab by then.
    if (res.partial && !peopleSearchQuery && peopleSkip === 0) {
      peopleRefill = setTimeout(() => {
        if (currentSeq === peopleSequenceId && peopleKey() === key && !document.hidden
            && document.getElementById('tab-people')?.classList.contains('active')) {
          loadPeople();
        }
      }, 10000);
    }

    bodyEl.innerHTML = '';
    if (people.length === 0) {
      bodyEl.dataset.listPlaceholder = '1';
      // The backend's reason when it gave one (Stella's online list); an empty
      // box on a network with no browse list isn't a failed search either.
      const message = res.note
        ? escapeHtml(res.note)
        : (!peopleSearchQuery && networkInfo().hasPeopleBrowse === false
          ? 'Search for a player by name.'
          : 'No players found.');
      bodyEl.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">${message}</td></tr>`;
    } else {
      delete bodyEl.dataset.listPlaceholder;
      people.forEach(person => {
        const avatarUrl = personAvatarUrl(person, 24);
        const fallbackAvatar = defaultAvatarUrl(24);
        // Vanilla publishes no presence, so `isOnline` arrives as null and the
        // dot stays neutral rather than asserting a definite "offline".
        const presence = person.isOnline == null
          ? { cls: 'unknown', title: 'Presence unknown' }
          : (person.isOnline ? { cls: 'online', title: 'Online' } : { cls: 'offline', title: 'Offline' });
        
        const row = document.createElement('tr');
        row.onclick = () => {
          showPlayerDetails(person);
        };
        row.innerHTML = `
          <td>
            <img class="people-avatar image-loading-placeholder" loading="lazy" decoding="async" data-fallback="${escapeHtml(fallbackAvatar)}" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(person.userName)}" />
          </td>
          <td class="people-name-cell">
            <span class="status-dot ${presence.cls}" role="img" aria-label="${presence.title}"></span>
            ${escapeHtml(person.displayName || person.userName)}
          </td>
          <td class="people-username-cell">
            <span class="username-row"><span class="text-link">@${escapeHtml(person.userName)}</span><span class="profile-roles inline-roles"></span></span>
          </td>
          <td class="people-level-col">${person.level != null ? escapeHtml(String(person.level)) : ''}</td>
          <td class="network-only-stella people-room-cell">${escapeHtml(stellaWhere(person))}</td>
          <td class="people-bio-col" style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(person.bio || '')}
          </td>
        `;
        // Built after innerHTML so the pills are real elements rather than
        // interpolated markup.
        renderPlayerRoles(row.querySelector('.inline-roles'), person);
        bodyEl.appendChild(row);
      });
    }

    // Pagination text & buttons state
    const txtPage = $('txtPeoplePage');
    if (txtPage) {
      txtPage.textContent = pageLabel(peopleSkip, peopleTake, total, res.data.TotalKnown);
    }
    
    const btnPrev = $('btnPeoplePrev');
    const btnNext = $('btnPeopleNext');
    if (btnPrev) btnPrev.disabled = (peopleSkip === 0);
    if (btnNext) btnNext.disabled = (peopleSkip + peopleTake >= total);
  } else {
    // Escaped for the same reason as the rooms error above.
    peopleRenderKey = '';
    bodyEl.dataset.listPlaceholder = '1';
    bodyEl.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">${listErrorHtml(res, 'players')}</td></tr>`;
    const txtPage = $('txtPeoplePage');
    if (txtPage) txtPage.textContent = 'Page 1 of 1';
    const btnPrev = $('btnPeoplePrev');
    const btnNext = $('btnPeopleNext');
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
  }

  // The row count just changed (a new page, a search, a first load), so the
  // last row's fit against the container's height needs rechecking every time.
  snapTableRows($('peopleTableContainer'));
}

// Wired here rather than beside loadFeed(): the `$` helper is declared further
// down this file, so a top-level call up there hits its temporal dead zone.
$('btnFeedRefresh')?.addEventListener('click', () => loadFeed(false, { refresh: true }));

// Event listeners for Rooms search / sort / pagination
let roomsSearchTimeout;
$('roomsSearch')?.addEventListener('input', (e) => {
  clearTimeout(roomsSearchTimeout);
  roomsSearchTimeout = setTimeout(() => {
    roomsSearchQuery = e.target.value.trim();
    // Vanilla filters by tag through the same search field it matches names
    // with, and a multi-term query matches nothing there — so a typed search
    // replaces the tag rather than narrowing it. Radium filters server-side and
    // can hold both at once.
    if (!networkInfo().hasFilters && roomsSearchQuery) clearRoomsTag();
    roomsSkip = 0;
    loadRooms();
  }, 300);
});

/// Drop the active tag filter and un-highlight it in the rail.
function clearRoomsTag() {
  if (!activeRoomsTag) return;
  activeRoomsTag = '';
  document.querySelectorAll('#roomsFiltersList .filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#roomsFiltersList .filter-btn')?.classList.add('active'); // "All Rooms"
}

$('btnRoomsPrev')?.addEventListener('click', () => {
  if (roomsSkip >= roomsTake) {
    roomsSkip -= roomsTake;
    loadRooms();
  }
});
$('btnRoomsNext')?.addEventListener('click', () => {
  roomsSkip += roomsTake;
  loadRooms();
});

document.querySelectorAll('#roomsSortList .sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#roomsSortList .sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeRoomsSort = parseInt(btn.dataset.sort) || 0;
    roomsSkip = 0;
    loadRooms();
  });
});

// Event listeners for People search / pagination
let peopleSearchTimeout;
$('peopleSearch')?.addEventListener('input', (e) => {
  clearTimeout(peopleSearchTimeout);
  peopleSearchTimeout = setTimeout(() => {
    peopleSearchQuery = e.target.value.trim();
    peopleSkip = 0;
    loadPeople();
  }, 300);
});

$('btnPeoplePrev')?.addEventListener('click', () => {
  if (peopleSkip >= peopleTake) {
    peopleSkip -= peopleTake;
    loadPeople();
  }
});
$('btnPeopleNext')?.addEventListener('click', () => {
  peopleSkip += peopleTake;
  loadPeople();
});

// Native Detail View Helpers
function switchTab(tabName) {
  const btn = $('nav-' + tabName);
  if (btn) {
    btn.click();
  }
}

/// Bumped by every profile lookup by name, so of two clicked in quick
/// succession the one clicked last is the one shown — not whichever lookup
/// happened to come back last.
let creatorLookupSeq = 0;

/// `creator`, when given, is the id/displayName/avatar a room or photo row
/// already carried for this person. It is used to build the profile directly,
/// skipping the by-name search below: the id is exact, and it saves a request.
async function showCreatorProfile(username, creator = null) {
  if (!username && !(creator && creator.id != null)) return;
  const seq = ++creatorLookupSeq;
  let person = null;

  if (creator && creator.id != null) {
    person = {
      id: creator.id,
      userName: username || creator.userName || '',
      displayName: creator.displayName || username || '',
      // An absolute URL the row already resolved; personAvatarUrl prefers it.
      AvatarUrl: creator.avatarUrl || '',
      profileImage: '',
      isOnline: null,
      bio: ''
    };
  }

  try {
    if (!person) {
      const res = await window.radium?.fetchPeople({ query: username });
      if (seq !== creatorLookupSeq) return;
      if (res && res.success && res.data && res.data.Results) {
        // A row can come back without a username; that one just isn't a match.
        person = res.data.Results.find(p => String(p.userName || '').toLowerCase() === username.toLowerCase());
        if (!person && res.data.Results.length > 0) {
          person = res.data.Results[0];
        }
      }
    }
  } catch (err) {
    console.error("Error fetching creator profile:", err);
  }
  if (seq !== creatorLookupSeq) return;
  if (!person) {
    person = {
      id: null,
      userName: username,
      displayName: username,
      profileImage: 'DefaultProfileImage',
      // Unknown, not offline: the lookup failed, and on a network with no
      // presence at all (Vanilla) "OFFLINE" would be a claim nobody made.
      isOnline: null,
      bio: ''
    };
  }
  switchTab('people');
  showPlayerDetails(person);
}

// Scraped Web Details Cache
const photoWebDetailsCache = new Map();
const userWebDetailsCache = new Map();

/// Attribution for a photo: who took it and where.
///
/// Radium has to scrape this from the photo's web page, one request per photo.
/// Vanilla's feed already embeds the uploader and room on every row (and has no
/// per-photo detail endpoint to scrape anyway), so when the photo object
/// carries them the answer is already in hand — passing `photo` avoids a
/// pointless round trip on Radium and is the only way it resolves on Vanilla.
async function getPhotoWebDetails(photoId, photo) {
  // Keyed on the uploader specifically: a row carrying only a room name would
  // otherwise short-circuit into an "Unknown Creator" card on Radium, where the
  // scrape is the only source of attribution.
  if (photo?.CreatorUsername) {
    return {
      success: true,
      creatorUsername: photo.CreatorUsername,
      roomName: photo.RoomName || '',
      creatorAvatar: photo.CreatorAvatarUrl || ''
    };
  }
  if (photoWebDetailsCache.has(photoId)) {
    return photoWebDetailsCache.get(photoId);
  }
  const res = await window.radium?.fetchPhotoWebDetails(photoId);
  if (res && res.success) {
    if (photoWebDetailsCache.size >= 200) {
      const oldestKey = photoWebDetailsCache.keys().next().value;
      if (oldestKey !== undefined) photoWebDetailsCache.delete(oldestKey);
    }
    photoWebDetailsCache.set(photoId, res);
  }
  return res;
}

async function getUserWebDetails(username, accountId = null) {
  // Stella resolves by account id, so a row with an id but no username is
  // still lookupable. Cache by id when present.
  if (!username && accountId == null) return null;
  const key = accountId != null ? `#${accountId}` : username.toLowerCase();
  if (userWebDetailsCache.has(key)) {
    return userWebDetailsCache.get(key);
  }
  const res = await window.radium?.fetchUserWebDetails(username || '', accountId);
  if (res && res.success) {
    if (userWebDetailsCache.size >= 200) {
      const oldestKey = userWebDetailsCache.keys().next().value;
      if (oldestKey !== undefined) userWebDetailsCache.delete(oldestKey);
    }
    userWebDetailsCache.set(key, res);
  }
  return res;
}

// Photos pagination state
let roomPhotosFeedSkip = 0;
// A room's photos are found by scanning the network-wide feed and filtering by
// room id — neither network exposes a per-room photo endpoint. Each scanned page
// costs a request (two on Vanilla, which resolves photo creators in a batch),
// and because Vanilla has no `skip` the backend re-fetches everything before the
// requested window, so deep pages get quadratically more expensive. Fewer, larger
// pages cover the same ground for half the round trips.
const roomPhotosFeedTake = 60;
const ROOM_PHOTO_MAX_PAGES = 3;
let currentRoomId = null;
let currentRoomPhotosCount = 0;
let roomPhotosHasMore = false;
let roomPhotosLoading = false;
let roomPhotosTotalPagesSearched = 0;

let playerPhotosSkip = 0;
const playerPhotosTake = 10;
let currentPlayerId = null;
let playerPhotosHasMore = false;
let playerPhotosLoading = false;

// Feeds pagination state
let playerFeedsSkip = 0;
const playerFeedsTake = 10;
let currentPlayerFeedsId = null;
let playerFeedsHasMore = false;
let playerFeedsLoading = false;

// Rooms pagination state
let playerRoomsSkip = 0;
const playerRoomsTake = 20;
let currentPlayerRoomsUserId = null;
let playerRoomsHasMore = false;
let playerRoomsLoading = false;

let currentBackToView = null;

// Bumped each time a detail view opens or closes. Each view fills in from
// lookups that can take a second or more, so a view opened after another had
// the first one's stats, bio and photos written over it when those arrived
// late. A lookup that finds the number moved on drops its result.
let roomDetailSeq = 0;
let playerDetailSeq = 0;
let photoDetailSeq = 0;

// IntersectionObserver instances
let roomPhotoObserver = null;
let playerPhotoObserver = null;
let playerFeedsObserver = null;
let playerRoomsObserver = null;

function setupRoomPhotoObserver() {
  if (roomPhotoObserver) roomPhotoObserver.disconnect();
  const sentinel = $('roomsDetailPhotosSentinel');
  if (!sentinel) return;
  roomPhotoObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && roomPhotosHasMore && !roomPhotosLoading && currentRoomId) {
      roomPhotosFeedSkip += roomPhotosFeedTake;
      loadRoomPhotos(currentRoomId, true);
    }
  }, { threshold: 0.1 });
  roomPhotoObserver.observe(sentinel);
}

function setupPlayerPhotoObserver() {
  if (playerPhotoObserver) playerPhotoObserver.disconnect();
  const sentinel = $('peopleDetailPhotosSentinel');
  if (!sentinel) return;
  playerPhotoObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && playerPhotosHasMore && !playerPhotosLoading && currentPlayerId) {
      playerPhotosSkip += playerPhotosTake;
      loadPlayerPhotos(currentPlayerId, true);
    }
  }, { threshold: 0.1 });
  playerPhotoObserver.observe(sentinel);
}

function setupPlayerFeedsObserver() {
  if (playerFeedsObserver) playerFeedsObserver.disconnect();
  const sentinel = $('peopleDetailFeedsSentinel');
  if (!sentinel) return;
  playerFeedsObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && playerFeedsHasMore && !playerFeedsLoading && currentPlayerFeedsId) {
      playerFeedsSkip += playerFeedsTake;
      loadPlayerFeeds(currentPlayerFeedsId, true);
    }
  }, { threshold: 0.1 });
  playerFeedsObserver.observe(sentinel);
}

function setupPlayerRoomsObserver() {
  if (playerRoomsObserver) playerRoomsObserver.disconnect();
  const sentinel = $('peopleDetailRoomsSentinel');
  if (!sentinel) return;
  playerRoomsObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && playerRoomsHasMore && !playerRoomsLoading && currentPlayerRoomsUserId) {
      playerRoomsSkip += playerRoomsTake;
      loadPlayerRooms(currentPlayerRoomsUserId, true);
    }
  }, { threshold: 0.1 });
  playerRoomsObserver.observe(sentinel);
}

/// Bumped by every fresh room-photo load. A room opened while the previous
/// one's scan was still paging through the feed used to find the scan's
/// "loading" flag up and give up, so it showed no photos of its own — and the
/// old scan then wrote the previous room's photos into its grid.
let roomPhotosSeq = 0;

async function loadRoomPhotos(roomId, append = false) {
  const photosGrid = $('roomsDetailPhotosGrid');
  const photosEmpty = $('roomsDetailPhotosEmpty');
  if (!photosGrid) return;
  // Only a scroll-triggered page waits its turn; a new room starts over.
  if (append && roomPhotosLoading) return;
  const seq = append ? roomPhotosSeq : ++roomPhotosSeq;

  // Reset pages searched so infinite scroll can continue
  roomPhotosTotalPagesSearched = 0;

  if (!append) {
    roomPhotosFeedSkip = 0;
    currentRoomPhotosCount = 0;
    roomPhotosHasMore = false;
    photosGrid.innerHTML = '<div id="roomPhotosLoading" style="text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted);">Loading photos...</div>';
    if (photosEmpty) photosEmpty.style.display = 'none';
  } else {
    const loadingEl = document.createElement('div');
    loadingEl.id = 'roomPhotosLoading';
    loadingEl.style.cssText = 'text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted);';
    loadingEl.textContent = 'Loading more...';
    photosGrid.appendChild(loadingEl);
  }
  
  currentRoomId = roomId;
  roomPhotosLoading = true;

  // Networks with a direct per-room photo endpoint (Stella) use it. Others
  // answer `unsupported` and fall through to the network-wide feed scan below.
  {
    const directSkip = append ? roomPhotosFeedSkip : 0;
    const direct = await window.radium?.fetchRoomPhotos({ roomId, skip: directSkip, take: roomPhotosFeedTake });
    if (seq !== roomPhotosSeq) return;
    if (direct && direct.success) {
      const results = (direct.data && direct.data.Results) || [];
      if (!append && currentRoomPhotosCount === 0) photosGrid.innerHTML = '';
      const loadEl = $('roomPhotosLoading');
      if (loadEl) loadEl.remove();
      results.forEach(photo => { currentRoomPhotosCount++; photosGrid.appendChild(buildPhotoCard(photo, 'rooms-detail')); });
      roomPhotosFeedSkip = directSkip + roomPhotosFeedTake;
      roomPhotosHasMore = results.length >= roomPhotosFeedTake;
      roomPhotosLoading = false;
      if (photosEmpty) {
        if (currentRoomPhotosCount === 0) { photosEmpty.textContent = 'No photos yet.'; photosEmpty.style.display = 'block'; }
        else { photosEmpty.style.display = 'none'; }
      }
      setupRoomPhotoObserver();
      return;
    }
    // Not supported on this network: fall through to the feed scan.
  }

  let resultsLength = 0;
  let hasFailed = false;
  let pagesSearched = 0;
  let matchedInBatch = 0;
  
  while (true) {
    pagesSearched++;
    roomPhotosTotalPagesSearched++;
    const res = await window.radium?.fetchRecentPhotos({ skip: roomPhotosFeedSkip, take: roomPhotosFeedTake });
    // Another room took over the grid while this page was on its way.
    if (seq !== roomPhotosSeq) return;
    if (res && res.success && res.data && res.data.Results) {
      const results = res.data.Results || [];
      resultsLength = results.length;
      
      const matched = results.filter(p => (p.RoomId || p.roomId) === roomId);
      if (matched.length > 0) {
        if (!append && currentRoomPhotosCount === 0) {
          photosGrid.innerHTML = '';
        }
        const loadEl = $('roomPhotosLoading');
        if (loadEl) loadEl.remove();
        matched.forEach(photo => {
          currentRoomPhotosCount++;
          matchedInBatch++;
          
          photosGrid.appendChild(buildPhotoCard(photo, 'rooms-detail'));
        });
      }
      
      if (resultsLength < roomPhotosFeedTake) {
        roomPhotosHasMore = false;
        break;
      }
      if (matched.length > 0) {
        roomPhotosFeedSkip += roomPhotosFeedTake;
        roomPhotosHasMore = (roomPhotosTotalPagesSearched < ROOM_PHOTO_MAX_PAGES);
        break;
      }
      if (roomPhotosTotalPagesSearched >= ROOM_PHOTO_MAX_PAGES) {
        roomPhotosHasMore = false;
        break;
      }
      roomPhotosFeedSkip += roomPhotosFeedTake;
    } else {
      hasFailed = true;
      break;
    }
  }
  
  roomPhotosLoading = false;
  
  const loadingEl = $('roomPhotosLoading');
  if (loadingEl) loadingEl.remove();
  
  if (hasFailed) {
    if (!append) {
      photosGrid.innerHTML = '';
      if (photosEmpty) { photosEmpty.textContent = 'Error loading photos.'; photosEmpty.style.display = 'block'; }
    }
    return;
  }
  
  if (!append && currentRoomPhotosCount === 0) {
    if (photosEmpty) photosEmpty.style.display = 'block';
  } else {
    if (photosEmpty) photosEmpty.style.display = 'none';
  }

  // Re-observe sentinel for next scroll trigger
  setupRoomPhotoObserver();
}

async function loadPlayerPhotos(userId, append = false) {
  const photosGrid = $('peopleDetailPhotosGrid');
  const photosEmpty = $('peopleDetailPhotosEmpty');
  if (!photosGrid) return;
  if (playerPhotosLoading) return;
  
  if (!userId) {
    photosGrid.innerHTML = '';
    if (photosEmpty) photosEmpty.style.display = 'block';
    playerPhotosHasMore = false;
    return;
  }
  
  if (!append) {
    playerPhotosSkip = 0;
    playerPhotosHasMore = false;
    photosGrid.innerHTML = '<div id="playerPhotosLoading" class="profile-grid-note" style="text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted);">Loading photos...</div>';
    if (photosEmpty) photosEmpty.style.display = 'none';
  } else {
    const loadingEl = document.createElement('div');
    loadingEl.id = 'playerPhotosLoading';
    // Across the whole grid, not in one thumbnail's cell.
    loadingEl.className = 'profile-grid-note';
    loadingEl.style.cssText = 'text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted); width: 100%;';
    loadingEl.textContent = 'Loading more...';
    photosGrid.appendChild(loadingEl);
  }
  
  currentPlayerId = userId;
  playerPhotosLoading = true;
  
  const res = await window.radium?.fetchUserPhotos({ userId, skip: playerPhotosSkip, take: playerPhotosTake });
  // A different profile was opened while these were on their way; they are
  // not its photos. Its own load owns the grid and the loading flag.
  if (currentPlayerId !== userId) return;
  const loadingEl = $('playerPhotosLoading');
  if (loadingEl) loadingEl.remove();
  playerPhotosLoading = false;
  
  if (res && res.success && res.data && res.data.Results) {
    const photos = res.data.Results || [];
    
    if (!append) photosGrid.innerHTML = '';
    
    photos.forEach(photo => {
      photosGrid.appendChild(buildPhotoTile(photo, 'people-detail'));
    });

    const totalInGrid = photosGrid.querySelectorAll('.profile-photo-tile').length;
    if (totalInGrid === 0 && !append) {
      if (photosEmpty) photosEmpty.style.display = 'block';
    } else {
      if (photosEmpty) photosEmpty.style.display = 'none';
    }
    
    const totalCount = res.data.TotalResults;
    if (totalCount !== undefined) {
      playerPhotosHasMore = totalInGrid < totalCount;
    } else {
      playerPhotosHasMore = photos.length === playerPhotosTake;
    }
 
    // Re-observe sentinel for next scroll trigger
    setupPlayerPhotoObserver();
  } else {
    if (!append) {
      photosGrid.innerHTML = '';
      if (photosEmpty) { photosEmpty.textContent = 'Error loading photos.'; photosEmpty.style.display = 'block'; }
    }
    playerPhotosHasMore = false;
  }
}


async function showRoomByName(roomName) {
  if (!roomName) return;
  addLog(`Looking up room "${roomName}"...`, 'info', 'server');
  // A search, not a lookup: results come back in the active sort (most
  // cheered first on Vanilla), and any room whose description mentions the
  // name matches too. So take a page and prefer the room actually called that.
  const res = await window.radium?.fetchRooms({ query: roomName, take: 24 });
  const results = res?.success ? (res.data?.Results || []) : [];
  if (results.length > 0) {
    const wanted = roomName.trim().toLowerCase();
    const room = results.find(r => String(r.Name || r.name || '').trim().toLowerCase() === wanted)
      || results[0];
    switchTab('rooms');
    showRoomDetails(room);
  } else {
    toast(`Could not find room "${roomName}"`, 'error');
  }
}

async function showPhotoDetails(photo, backToView) {
  if (!photo) return;
  const photoId = photo.Id || photo.id;
  if (!photoId) return;

  currentBackToView = backToView;
  const seq = ++photoDetailSeq;
  
  // Switch to photo detail panel
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  $('tab-photo-detail')?.classList.add('active');
  
  // Render initial photo fields we have
  const imgEl = $('photoDetailImage');
  if (imgEl) {
    imgEl.classList.add('image-loading-placeholder');
    imgEl.onload = () => imgEl.classList.remove('image-loading-placeholder');
    imgEl.onerror = () => { imgEl.src = './images.png'; imgEl.classList.remove('image-loading-placeholder'); imgEl.onerror = null; };
    imgEl.src = photoImageUrl(photo, 1000);
  }

  // The page shows the photo scaled to fit; the lightbox is how you actually
  // look at it. Assigned rather than added, so reopening the panel doesn't
  // stack a listener per visit.
  const imgWrapEl = document.querySelector('.photo-detail-img-wrap');
  if (imgWrapEl) {
    // Through the thumbnail proxy like every other image, at a width that
    // leaves the picture full-screen sharp (1920 CSS px, scaled by the
    // display's pixel ratio and then capped at the proxy's own 2048). This
    // used to go straight to the origin, which meant the one URL in the app
    // that reached an arbitrary host was the one the user clicked — and it
    // was the reason `img-src` had to allow the whole of `https:`. It also
    // re-downloaded the photo on every open; now it is cached like the rest.
    imgWrapEl.onclick = () => showLightbox(photoImageUrl(photo, 1920), {
      title: 'PHOTO',
      alt: photo.caption || 'Photo',
      // The already-loaded page copy, so a failed full-size fetch still shows
      // the picture rather than an empty frame.
      fallbackSrc: $('photoDetailImage')?.src
    });
  }

  const captionEl = $('photoDetailCaption');
  if (captionEl) {
    captionEl.textContent = photo.Description || photo.description || 'No description.';
  }

  const cheersEl = $('photoDetailCheers');
  if (cheersEl) cheersEl.textContent = photo.CheerCount || photo.cheerCount || '0';
  setupPhotoSocial(photo);

  // Comments, only where the network has them. Vanilla reports no count at
  // all, and a hardcoded "0 COMMENTS" would read as "nobody commented" rather
  // than "this network has no comments" — the same rule the feed card follows.
  const commentCount = photo.CommentCount ?? photo.commentCount;
  const commentsStatEl = $('photoDetailCommentsStat');
  if (commentsStatEl) {
    commentsStatEl.hidden = commentCount == null;
    const commentsEl = $('photoDetailComments');
    if (commentsEl) commentsEl.textContent = Number(commentCount) || 0;
  }

  // Everyone else in the shot, matching the feed card. Names are attached as
  // elements rather than interpolated markup so a display name containing
  // quotes can't break out of a string context.
  const taggedBoxEl = $('photoDetailTaggedBox');
  const taggedEl = $('photoDetailTagged');
  if (taggedBoxEl && taggedEl) {
    const tagged = (photo.TaggedPlayers || [])
      .filter(p => p.userName && p.userName !== photo.CreatorUsername);
    taggedEl.innerHTML = '';
    taggedBoxEl.hidden = tagged.length === 0;
    tagged.forEach(p => {
      const link = document.createElement('span');
      link.className = 'photo-detail-tagged-name';
      link.textContent = p.displayName || p.userName;
      link.addEventListener('click', () => showCreatorProfile(p.userName));
      taggedEl.appendChild(link);
    });
  }

  const createdEl = $('photoDetailCreatedAt');
  if (createdEl) {
    createdEl.textContent = '—';
    const createdAt = photo.CreatedAt || photo.createdAt;
    if (createdAt) {
      try {
        createdEl.textContent = new Date(createdAt).toLocaleString();
      } catch (e) {
        createdEl.textContent = createdAt;
      }
    }
  }
  
  // Reset scraped elements
  const creatorNameEl = $('photoDetailCreatorName');
  if (creatorNameEl) creatorNameEl.textContent = 'Loading...';
  const creatorHandleEl = $('photoDetailCreatorHandle');
  if (creatorHandleEl) creatorHandleEl.textContent = '@...';
  const creatorAvatarEl = $('photoDetailCreatorAvatar');
  if (creatorAvatarEl) {
    creatorAvatarEl.classList.add('image-loading-placeholder');
    // Re-armed on every visit: the shared handler consumes `data-fallback` the
    // first time an image fails, so a panel opened twice would otherwise have
    // no fallback left the second time.
    creatorAvatarEl.dataset.fallback = PLACEHOLDER_AVATAR;
    creatorAvatarEl.src = defaultAvatarUrl(32);
  }
  const roomLinkEl = $('photoDetailRoomLink');
  if (roomLinkEl) roomLinkEl.hidden = true;
  const noRoomEl = $('photoDetailNoRoom');
  if (noRoomEl) noRoomEl.hidden = false;
  const creatorLinkEl = $('photoDetailCreatorLink');
  if (creatorLinkEl) creatorLinkEl.onclick = null;
  
  // Fetch scraped details from photo webpage
  const res = await getPhotoWebDetails(photoId, photo);
  if (seq !== photoDetailSeq) return;
  if (res && res.success) {
    const creatorUsername = res.creatorUsername || '';
    const roomName = res.roomName || '';
    
    if (creatorUsername) {
      if (creatorNameEl) creatorNameEl.textContent = creatorUsername;
      if (creatorHandleEl) creatorHandleEl.textContent = `@${creatorUsername}`;
      if (creatorLinkEl) {
        creatorLinkEl.onclick = (e) => {
          e.stopPropagation();
          showCreatorProfile(creatorUsername);
        };
      }
      // fetch avatar of user in background
      const avatarSrc = res.creatorAvatar || (await getUserWebDetails(creatorUsername))?.avatar;
      if (seq !== photoDetailSeq) return;
      if (avatarSrc && creatorAvatarEl) {
        creatorAvatarEl.classList.add('image-loading-placeholder');
        creatorAvatarEl.dataset.fallback = PLACEHOLDER_AVATAR;
        creatorAvatarEl.src = thumbSrc(avatarSrc, avatarWidth(32));
      } else if (creatorAvatarEl) {
        creatorAvatarEl.classList.remove('image-loading-placeholder');
      }
    } else {
      if (creatorNameEl) creatorNameEl.textContent = 'Unknown Creator';
      if (creatorAvatarEl) creatorAvatarEl.classList.remove('image-loading-placeholder');
    }
    
    if (roomName && roomName.toLowerCase() !== 'none') {
      const roomNameEl = $('photoDetailRoomName');
      if (roomNameEl) roomNameEl.textContent = roomName;
      if (roomLinkEl) {
        roomLinkEl.hidden = false;
        roomLinkEl.onclick = (e) => {
          e.stopPropagation();
          showRoomByName(roomName);
        };
      }
      if (noRoomEl) noRoomEl.hidden = true;
    }
  } else {
    if (creatorNameEl) creatorNameEl.textContent = 'Unknown';
    if (creatorAvatarEl) creatorAvatarEl.classList.remove('image-loading-placeholder');
  }
}

/// Where the photo detail's Back button returns to, keyed by the view that
/// opened the photo. Every grid passes its own key to `buildPhotoCard()`.
///
/// A map rather than a chain of `if`s because the chain had no entry for the
/// FEED tab, so backing out of a feed photo dropped the user on Home. A key
/// that isn't listed here still falls back to Home — but adding a photo grid
/// now means adding a line here, in one obvious place.
const PHOTO_BACK_TARGETS = {
  'feed':          { tab: 'feed' },
  'rooms-detail':  { tab: 'rooms',  list: 'roomsListView',  detail: 'roomsDetailView' },
  'people-detail': { tab: 'people', list: 'peopleListView', detail: 'peopleDetailView' }
};

$('btnPhotoDetailBack')?.addEventListener('click', () => {
  socialPhoto = null;
  photoDetailSeq++;
  $('tab-photo-detail').classList.remove('active');

  const target = PHOTO_BACK_TARGETS[currentBackToView];
  if (!target) {
    switchTab('home');
    return;
  }

  switchTab(target.tab);

  // Tabs that show a list and a detail pane need the detail put back, since
  // switching tabs alone would land on the list the user had already left.
  const list = target.list && $(target.list);
  const detail = target.detail && $(target.detail);
  if (list && detail) {
    list.classList.add('hidden');
    detail.classList.remove('hidden');
  }
});



/// The "● 7" corner badge on a room card: players in the room right now, in
/// public and private copies of it together (the split is in its accessible
/// name; no hover tooltips). Only Stella's rows carry the counts, and an empty
/// room gets no badge.
function liveBadgeHtml(room) {
  const pub = Number(room?.LivePlayers) || 0;
  const priv = Number(room?.PrivatePlayers) || 0;
  const n = pub + priv;
  if (n <= 0) return '';
  const label = priv > 0
    ? `${n} in this room now: ${pub} in public, ${priv} in private`
    : `${n} ${n === 1 ? 'player' : 'players'} in this room now`;
  return `<span class="room-live-badge" role="img" aria-label="${label}"><span class="room-live-dot" aria-hidden="true"></span>${n}</span>`;
}

/// "7 playing now · 3 in private" under the room's name. `players` (public
/// copies) null hides it; `priv` null or 0 leaves the private part off.
function setRoomLive(players, priv = null) {
  const el = $('roomsDetailLive');
  if (!el) return;
  const known = Number.isFinite(players) && players >= 0;
  el.hidden = !known;
  if (!known) return;
  const p = Number.isFinite(priv) ? priv : 0;
  el.classList.toggle('is-empty', players + p === 0);
  let text;
  if (players + p === 0) text = 'Nobody here right now';
  else if (p === 0) text = `${players} playing now`;
  else if (players === 0) text = `${p} playing now · all in private`;
  else text = `${players} playing now · ${p} in private`;
  el.lastChild.textContent = text;
}

async function showRoomDetails(room) {
  const list = $('roomsListView');
  const detail = $('roomsDetailView');
  if (!list || !detail) return;
  const seq = ++roomDetailSeq;

  // What the list row knew, then a fresh count: the page may have sat open.
  setRoomLive(activeNetwork === 'stella' ? (room.LivePlayers ?? null) : null, room.PrivatePlayers ?? null);
  if (activeNetwork === 'stella' && (room.RoomId || room.roomId)) {
    window.radium?.stellaRoomPlayers(room.RoomId || room.roomId)
      .then(r => { if (seq === roomDetailSeq && r?.players != null) setRoomLive(r.players, r.private); })
      .catch(() => {});
  }
  
  const thumbUrl = roomThumbUrl(room, 720);
  
  const imgEl = $('roomsDetailImage');
  if (imgEl) {
    imgEl.classList.add('image-loading-placeholder');
    imgEl.src = thumbUrl;
    imgEl.onerror = () => { imgEl.src = './images.png'; imgEl.classList.remove('image-loading-placeholder'); imgEl.onerror = null; };
  }
  
  const roomName = room.Name || room.name || 'Unknown Room';
  const nameEl = $('roomsDetailName');
  if (nameEl) nameEl.textContent = roomName;
  
  const creatorUsername = room.CreatorUsername || room.creatorUsername || 'Coach';
  const creatorNameEl = $('roomsDetailCreatorName');
  if (creatorNameEl) creatorNameEl.textContent = creatorUsername;
  
  const creatorHandleEl = $('roomsDetailCreatorHandle');
  if (creatorHandleEl) creatorHandleEl.textContent = `@${creatorUsername}`;
  
  const creatorLinkEl = $('roomsDetailCreatorLink');
  if (creatorLinkEl) {
    creatorLinkEl.onclick = async (e) => {
      e.stopPropagation();
      await showCreatorProfile(creatorUsername, {
        id: room.CreatorPlayerId ?? room.CreatorAccountId ?? null,
        displayName: creatorUsername,
        avatarUrl: room.CreatorAvatarUrl
      });
      hideRoomDetails();
    };
  }

  const creatorAvatarEl = $('roomsDetailCreatorAvatar');
  if (creatorAvatarEl) {
    creatorAvatarEl.classList.add('image-loading-placeholder');
    // Re-armed on every visit, as on the photo screen: the shared handler
    // uses the fallback up the first time a picture fails.
    creatorAvatarEl.dataset.fallback = PLACEHOLDER_AVATAR;
    // A row that resolved its creator (Stella, Vanilla) carries the picture
    // already. Stella has no room page to look it up from below, so without
    // this it would stay on the placeholder.
    creatorAvatarEl.src = room.CreatorAvatarUrl
      ? thumbSrc(room.CreatorAvatarUrl, avatarWidth(32))
      : defaultAvatarUrl(32);
  }

  const roomId = room.RoomId || room.roomId || '—';
  const idEl = $('roomsDetailId');
  if (idEl) idEl.textContent = roomId;
  
  const createdAt = room.CreatedAt || room.createdAt;
  const createdEl = $('roomsDetailCreatedAt');
  if (createdEl) {
    if (createdAt) {
      try {
        createdEl.textContent = new Date(createdAt).toLocaleString();
      } catch (e) {
        createdEl.textContent = createdAt;
      }
    } else {
      createdEl.textContent = '—';
    }
  }

  // Paint whatever the row already carried, so the stats are correct on the
  // first frame instead of showing "..." until a page scrape returns. The
  // lookup below still runs — it is the only source for the description and
  // the creator avatar — and refreshes these if it has fresher numbers.
  const cheersEl = $('roomsDetailCheers');
  const favsEl = $('roomsDetailFavorites');
  const visitsEl = $('roomsDetailVisits');
  const known = roomStatsFromRow(room);
  if (cheersEl) cheersEl.textContent = known ? known.cheers : '...';
  if (favsEl) favsEl.textContent = known?.favorites ?? '...';
  if (visitsEl) visitsEl.textContent = known ? known.visits : '...';
  const descEl = $('roomsDetailDescription');
  if (descEl) {
    descEl.textContent = room.Description || room.description || 'Loading details from web...';
  }
  
  const roomsPhotosGrid = $('roomsDetailPhotosGrid');
  const roomsPhotosEmpty = $('roomsDetailPhotosEmpty');
  if (roomsPhotosGrid) roomsPhotosGrid.innerHTML = '';
  if (roomsPhotosEmpty) roomsPhotosEmpty.style.display = 'none';

  list.classList.add('hidden');
  detail.classList.remove('hidden');
  setupRoomSocial(room);

  // Load scraped web details asynchronously (handle both PascalCase and camelCase APIs)
  const webDetails = await getRoomWebDetails(room.Name || room.name || '');
  if (seq !== roomDetailSeq) return;
  if (webDetails && webDetails.success) {
    if (cheersEl && webDetails.cheers) cheersEl.textContent = webDetails.cheers;
    if (favsEl && webDetails.favorites) favsEl.textContent = webDetails.favorites;
    if (visitsEl && webDetails.visits) visitsEl.textContent = webDetails.visits;
    if (descEl && webDetails.description) descEl.textContent = webDetails.description;
    if (webDetails.creatorAvatar && creatorAvatarEl) {
      creatorAvatarEl.classList.add('image-loading-placeholder');
      creatorAvatarEl.dataset.fallback = PLACEHOLDER_AVATAR;
      creatorAvatarEl.src = thumbSrc(webDetails.creatorAvatar, avatarWidth(32));
    } else if (creatorAvatarEl) {
      creatorAvatarEl.classList.remove('image-loading-placeholder');
    }
  }

  // Anything the row didn't carry and the lookup didn't fill stays unknown
  // rather than sitting on the "..." placeholder forever.
  for (const el of [cheersEl, favsEl, visitsEl]) {
    if (el && el.textContent === '...') el.textContent = '—';
  }
  if (descEl && descEl.textContent === 'Loading details from web...') {
    descEl.textContent = 'No description available.';
  }
  if (creatorAvatarEl) creatorAvatarEl.classList.remove('image-loading-placeholder');

  // Load room photos
  loadRoomPhotos(room.RoomId || room.roomId);
}

function hideRoomDetails() {
  // A Play request already under way carries on; only the view is closed.
  socialRoom = null;
  roomDetailSeq++;
  const list = $('roomsListView');
  const detail = $('roomsDetailView');
  if (list && detail) {
    detail.classList.add('hidden');
    list.classList.remove('hidden');
  }
}

async function showPlayerDetails(person) {
  const list = $('peopleListView');
  const detail = $('peopleDetailView');
  if (!list || !detail) return;
  const seq = ++playerDetailSeq;
  
  const avatarUrl = personAvatarUrl(person, 80);
  
  const avatarEl = $('peopleDetailAvatar');
  if (avatarEl) {
    avatarEl.classList.add('image-loading-placeholder');
    avatarEl.onload = () => { avatarEl.classList.remove('image-loading-placeholder'); avatarEl.onload = null; };
    avatarEl.src = avatarUrl;
    avatarEl.onerror = () => { avatarEl.src = PLACEHOLDER_AVATAR; avatarEl.classList.remove('image-loading-placeholder'); avatarEl.onerror = null; };
    avatarEl.style.cursor = 'pointer';
    avatarEl.onclick = () => {
      // Proxied for the same reason as the photo lightbox above. 512 is well
      // over the box this is drawn in, so nothing visible is lost.
      showLightbox(thumbSrc(personAvatarFullUrl(person), 512), {
        title: 'PROFILE IMAGE',
        alt: `${person.displayName || person.userName} profile image`,
        fallbackSrc: avatarEl.src
      });
    };
  }
  
  const nameEl = $('peopleDetailDisplayName');
  if (nameEl) nameEl.textContent = person.displayName || person.userName || 'Unknown Player';
  
  const userEl = $('peopleDetailUsername');
  if (userEl) userEl.textContent = `@${person.userName || ''}`;

  renderPlayerRoles($('peopleDetailRoles'), person);

  const aboutLabelEl = $('peopleDetailAboutLabel');
  if (aboutLabelEl) aboutLabelEl.textContent = `About ${person.displayName || person.userName || 'Player'}`;
  
  // Level is on the row itself where the list had it, so it needs no lookup.
  // Stella's profile lookup carries it too, for a profile opened from
  // somewhere with no level (a friend, a room's creator), so there it waits
  // for that. Absent (Radium, or a record without one) hides the tile.
  const levelEl = $('peopleDetailLevel');
  setProfileStat(levelEl, person.level ?? (activeNetwork === 'stella' ? '...' : ''));

  const friendsEl = $('peopleDetailFriends');
  const subsEl = $('peopleDetailSubscribers');
  const visitsEl = $('peopleDetailVisits');
  // Only show a loading placeholder for stats this network actually publishes.
  // Vanilla has a subscriber count and nothing else — no friends, no visits —
  // so flashing those tiles as "..." only to hide them a moment later is the
  // jump the user sees on opening a profile. Radium's scraped profile has all
  // three. `webDetails` fills the real values (or '' to hide) once it lands.
  // Only Radium publishes friends and visit counts. Vanilla and Stella expose
  // a subscriber count and nothing else, so those tiles stay hidden rather than
  // flashing "..." and then vanishing.
  const hasFriendsStat = activeNetwork === 'radium';
  const hasVisitsStat  = activeNetwork === 'radium';
  setProfileStat(friendsEl, hasFriendsStat ? '...' : '');
  setProfileStat(subsEl, '...');
  setProfileStat(visitsEl, hasVisitsStat ? '...' : '');
  // Only Stella says when an account was made; filled from the lookup.
  const joinedEl = $('peopleDetailJoined');
  setProfileStat(joinedEl, '');
  // Hidden until the lookup brings one, so a missing bio never flashes in.
  setProfileBio('');
  // Shown by applyStellaPresence() for a friend who is online.
  const joinBtn = $('peopleDetailJoinBtn');
  if (joinBtn) joinBtn.hidden = true;

  const dotEl = $('peopleDetailStatusDot');
  const labelEl = $('peopleDetailStatusLabel');
  const activityEl = $('peopleDetailActivityBadge');
  
  // `isOnline` is null on networks with no presence API (Vanilla), which is
  // distinct from a known-offline false.
  const isOnline = person.isOnline;
  const presenceUnknown = isOnline == null;
  if (dotEl) {
    dotEl.className = `status-dot ${presenceUnknown ? 'unknown' : (isOnline ? 'online' : 'offline')}`;
  }
  if (labelEl) {
    labelEl.textContent = presenceUnknown ? 'STATUS UNKNOWN' : (isOnline ? 'ONLINE' : 'OFFLINE');
  }
  if (activityEl) {
    activityEl.style.display = 'none';
    activityEl.textContent = '';
  }
  
  const bannerEl = $('peopleDetailBanner');
  if (bannerEl) {
    bannerEl.style.backgroundImage = defaultProfileBanner();
    bannerEl.style.backgroundSize = defaultProfileBannerSize();
    bannerEl.style.backgroundPosition = 'center';
    bannerEl.style.backgroundRepeat = 'no-repeat';
  }

  const peoplePhotosGrid = $('peopleDetailPhotosGrid');
  const peoplePhotosEmpty = $('peopleDetailPhotosEmpty');
  if (peoplePhotosGrid) peoplePhotosGrid.innerHTML = '';
  if (peoplePhotosEmpty) peoplePhotosEmpty.style.display = 'none';
  // The previous profile's lists stop being this view's now, not after the
  // lookup below: one of them landing meanwhile would fill this cleared grid.
  currentPlayerId = null;
  currentPlayerFeedsId = null;
  currentPlayerRoomsUserId = null;

  list.classList.add('hidden');
  detail.classList.remove('hidden');
  setupPersonSocial(person);

  // Load scraped web details asynchronously
  let webDetails = null;
  try {
    webDetails = await getUserWebDetails(person.userName, person.id);
  } catch (err) {
    console.error("Error loading web details for user:", err);
  }
  // A newer profile was opened (or this one closed) while that ran. Its own
  // call sets up the tabs and loads its photos; this one must not.
  if (seq !== playerDetailSeq) return;
  if (webDetails && webDetails.success) {
    setProfileStat(friendsEl, webDetails.friends);
    setProfileStat(subsEl, webDetails.subscribers);
    setProfileStat(visitsEl, webDetails.visits);
    if (activeNetwork === 'stella') setProfileStat(levelEl, webDetails.level ?? person.level ?? '');
    setProfileStat(joinedEl, joinedLabel(webDetails.createdAt));
    setProfileBio(webDetails.bio);
    // A profile opened from a room/photo row may have had no avatar on the row
    // (e.g. the row's creator lookup came back thin). The details carry the real
    // one, so fill it in now — through the thumbnail cache like every picture.
    if (webDetails.avatar && avatarEl) {
      const resolved = thumbSrc(webDetails.avatar, avatarWidth(80));
      if (resolved && resolved.startsWith(THUMB_BASE)) avatarEl.src = resolved;
    }
    // Through the thumbnail cache like every other remote picture. Set as the
    // bare scraped URL it could never load — the CSP's img-src doesn't allow
    // remote hosts — and whatever the page's markup held went into the style
    // unescaped. Only the proxied form is used: it is URL-encoded, so it holds
    // no quote to end the url("...") early.
    const banner = webDetails.banner ? thumbSrc(webDetails.banner, 1000) : '';
    // Layered over the default, which then shows if the picture fails.
    if (bannerEl && banner && banner.startsWith(THUMB_BASE)) {
      bannerEl.style.backgroundImage = `url("${banner}"), ${defaultProfileBanner()}`;
      bannerEl.style.backgroundSize = `cover, ${defaultProfileBannerSize()}`;
    }
    
    // Live update status if scrape has it
    if (webDetails.status) {
      const isOnlineScraped = webDetails.status !== 'OFFLINE';
      if (dotEl) dotEl.className = `status-dot ${isOnlineScraped ? 'online' : 'offline'}`;
      if (labelEl) labelEl.textContent = isOnlineScraped ? 'ONLINE' : 'OFFLINE';

      // Anything else is the room they're in ("^RECCENTER"), said the way
      // Stella's status reads: "In ^RECCENTER".
      if (webDetails.status !== 'ONLINE' && webDetails.status !== 'OFFLINE') {
        if (activityEl) {
          activityEl.style.display = 'inline-flex';
          activityEl.textContent = `In ${webDetails.status}`;
        }
      }
    } else {
      // If no status was scraped, fall back to person.isOnline (still tri-state).
      if (dotEl) dotEl.className = `status-dot ${presenceUnknown ? 'unknown' : (person.isOnline ? 'online' : 'offline')}`;
      if (labelEl) labelEl.textContent = presenceUnknown ? 'STATUS UNKNOWN' : (person.isOnline ? 'ONLINE' : 'OFFLINE');
    }
  } else {
    // The lookup failed, which is different from the stat not existing: the
    // number is real on this network, we just don't have it right now. A stat
    // the network doesn't have stays hidden rather than showing a dash.
    // (Presence on Stella is filled in separately, below.)
    setProfileStat(friendsEl, hasFriendsStat ? '—' : '');
    setProfileStat(subsEl, '—');
    setProfileStat(visitsEl, hasVisitsStat ? '—' : '');
    if (activeNetwork === 'stella') setProfileStat(levelEl, person.level ?? '—');
    setProfileBio(person.bio);
  }

  // Stella's presence comes from its live hub, not the profile lookup.
  if (activeNetwork === 'stella' && person.id != null) applyStellaPresence(person.id, seq);

  // Disconnect existing observers and reset pagination states
  if (playerPhotoObserver) playerPhotoObserver.disconnect();
  if (playerFeedsObserver) playerFeedsObserver.disconnect();
  if (playerRoomsObserver) playerRoomsObserver.disconnect();

  playerPhotosSkip = 0;
  playerPhotosHasMore = false;
  playerPhotosLoading = false;

  playerFeedsSkip = 0;
  playerFeedsHasMore = false;
  playerFeedsLoading = false;

  playerRoomsSkip = 0;
  playerRoomsHasMore = false;
  playerRoomsLoading = false;

  // Tab switching logic
  const tabs = [
    { btn: $('tabBtnPeoplePhotos'), sec: $('peopleDetailPhotosSection') },
    { btn: $('tabBtnPeopleFeeds'), sec: $('peopleDetailFeedsSection') },
    { btn: $('tabBtnPeopleRooms'), sec: $('peopleDetailRoomsSection') }
  ];
  
  // FEEDS only where the network publishes an activity feed (Radium); on the
  // others it could only ever be empty.
  if (tabs[1].btn) tabs[1].btn.hidden = networkInfo().hasFeed === false;

  tabs.forEach(t => {
    if (t.btn) {
      // The active tab's look is each skin's `.profile-tab-btn.active`; inline
      // colours set here used to override it with one green for every skin.
      t.btn.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          t.btn.click();
        }
      };
      t.btn.onclick = () => {
        tabs.forEach(other => {
          if (other.btn) {
            other.btn.classList.remove('active');
            other.btn.setAttribute('aria-selected', 'false');
          }
          if (other.sec) other.sec.style.display = 'none';
        });
        t.btn.classList.add('active');
        t.btn.setAttribute('aria-selected', 'true');
        if (t.sec) t.sec.style.display = 'block';
        
        // Trigger observer layouts and lazy load data on tab switch
        if (t.btn.id === 'tabBtnPeoplePhotos') {
          if (currentPlayerId !== person.id) {
            loadPlayerPhotos(person.id);
          }
          setupPlayerPhotoObserver();
        } else if (t.btn.id === 'tabBtnPeopleFeeds') {
          if (currentPlayerFeedsId !== person.id) {
            loadPlayerFeeds(person.id);
          }
          setupPlayerFeedsObserver();
        } else if (t.btn.id === 'tabBtnPeopleRooms') {
          if (currentPlayerRoomsUserId !== person.id) {
            loadPlayerRooms(person.id);
          }
          setupPlayerRoomsObserver();
        }
      };
    }
  });
  
  // Reset active user trackers to guarantee correct lazy loading
  currentPlayerId = null;
  currentPlayerFeedsId = null;
  currentPlayerRoomsUserId = null;

  // Reset tabs to Photos active by default
  if (tabs[0].btn) tabs[0].btn.click();
}

/// Online / offline, and the room, on a Stella profile — what the game shows
/// for that player. Right after the hub connects a player not yet heard from
/// is still "checking", so it asks again a few times before settling.
async function applyStellaPresence(playerId, seq, tries = 0) {
  let p;
  try {
    p = await window.radium.stellaPresence(playerId);
  } catch (e) {
    return;
  }
  if (seq !== playerDetailSeq) return;
  const dotEl = $('peopleDetailStatusDot');
  const labelEl = $('peopleDetailStatusLabel');
  const activityEl = $('peopleDetailActivityBadge');
  const setBadge = (text) => {
    if (!activityEl) return;
    activityEl.textContent = text;
    activityEl.style.display = text ? 'inline-flex' : 'none';
  };
  // JOIN, for a friend who is online — as from the friends card. The card
  // may not have loaded yet (or be set to hidden), so ask for the list once.
  const joinBtn = $('peopleDetailJoinBtn');
  if (joinBtn) joinBtn.hidden = true;
  if (p?.status === 'online' && joinBtn) {
    if (!stellaFriendsById.size) {
      try {
        const res = await window.radium.stellaFriends();
        if (res?.success && res.loaded) stellaFriendsById = new Map((res.friends || []).map(f => [Number(f.id), f]));
      } catch (e) {}
      if (seq !== playerDetailSeq) return;
    }
    const listed = stellaFriendsById.get(Number(playerId));
    // Where they are comes from this page's presence, fresher than the list's.
    const friend = listed && { ...listed, private: !!p.private, roomId: p.roomId, roomName: p.roomName };
    if (friend) {
      const name = friend.displayName || friend.userName || 'your friend';
      joinBtn.setAttribute('aria-label', friend.private && !stellaInvitedBy(friend.id) ? `Ask ${name} to let you into their private room` : `Start Stella and join ${name}`);
      joinBtn.onclick = () => joinStellaFriend(friend);
      joinBtn.hidden = false;
    }
  }
  if (p?.status === 'online') {
    if (dotEl) dotEl.className = 'status-dot online';
    if (labelEl) labelEl.textContent = 'ONLINE';
    setBadge(p.roomName ? `In ${p.roomName}${p.private ? ' · private' : ''}` : (p.private ? 'In a private room' : ''));
  } else if (p?.status === 'offline') {
    if (dotEl) dotEl.className = 'status-dot offline';
    if (labelEl) labelEl.textContent = 'OFFLINE';
    setBadge('');
  } else if (p?.status === 'checking') {
    if (dotEl) dotEl.className = 'status-dot unknown';
    if (labelEl) labelEl.textContent = 'CHECKING…';
    if (tries < 20) setTimeout(() => applyStellaPresence(playerId, seq, tries + 1), 5000);
  } else if (p?.status === 'paused') {
    // The game holds Stella's presence connection while it runs; see
    // stella_hub.rs. Asked again so it fills in once the game closes.
    if (dotEl) dotEl.className = 'status-dot unknown';
    if (labelEl) labelEl.textContent = 'SHOWN IN GAME';
    setBadge('');
    setTimeout(() => applyStellaPresence(playerId, seq, 0), 10000);
  }
  // "unknown" (hub unreachable) leaves STATUS UNKNOWN as it is.
}

async function loadPlayerFeeds(userId, append = false) {
  const grid = $('peopleDetailFeedsGrid');
  const empty = $('peopleDetailFeedsEmpty');
  if (!grid) return;
  if (playerFeedsLoading) return;
  
  if (!userId) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    playerFeedsHasMore = false;
    return;
  }
  
  if (!append) {
    playerFeedsSkip = 0;
    playerFeedsHasMore = false;
    grid.innerHTML = '<div id="playerFeedsLoading" style="text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted);">Loading feeds...</div>';
    if (empty) empty.style.display = 'none';
  } else {
    const loadingEl = document.createElement('div');
    loadingEl.id = 'playerFeedsLoading';
    loadingEl.style.cssText = 'text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted); width: 100%;';
    loadingEl.textContent = 'Loading more...';
    grid.appendChild(loadingEl);
  }
  
  currentPlayerFeedsId = userId;
  playerFeedsLoading = true;
  
  const res = await window.radium?.fetchUserFeed({ userId, skip: playerFeedsSkip, take: playerFeedsTake });
  // Another profile took over meanwhile; see loadPlayerPhotos().
  if (currentPlayerFeedsId !== userId) return;
  const loadingEl = $('playerFeedsLoading');
  if (loadingEl) loadingEl.remove();
  playerFeedsLoading = false;
  
  if (res && res.success && res.data && res.data.Results) {
    const feeds = res.data.Results || [];
    
    if (!append) grid.innerHTML = '';
    
    feeds.forEach(photo => {
      grid.appendChild(buildPhotoCard(photo, 'people-detail'));
    });
    
    const totalInGrid = grid.querySelectorAll('.feed-post-card').length;
    if (totalInGrid === 0 && !append) {
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
    }
    
    playerFeedsHasMore = feeds.length === playerFeedsTake;
    
    setupPlayerFeedsObserver();
  } else {
    if (!append) {
      grid.innerHTML = '';
      if (empty) { empty.textContent = 'Error loading feed.'; empty.style.display = 'block'; }
    }
    playerFeedsHasMore = false;
  }
}

async function loadPlayerRooms(userId, append = false) {
  const grid = $('peopleDetailRoomsGrid');
  const empty = $('peopleDetailRoomsEmpty');
  if (!grid) return;
  if (playerRoomsLoading) return;
  
  if (!userId) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    playerRoomsHasMore = false;
    return;
  }
  
  if (!append) {
    playerRoomsSkip = 0;
    playerRoomsHasMore = false;
    grid.innerHTML = '<div id="playerRoomsLoading" style="grid-column: 1 / -1; text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Loading rooms...</div>';
    if (empty) empty.style.display = 'none';
  } else {
    const loadingEl = document.createElement('div');
    loadingEl.id = 'playerRoomsLoading';
    loadingEl.style.cssText = 'grid-column: 1 / -1; text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted);';
    loadingEl.textContent = 'Loading more...';
    grid.appendChild(loadingEl);
  }
  
  currentPlayerRoomsUserId = userId;
  playerRoomsLoading = true;
  
  const res = await window.radium?.fetchUserRooms({ userId, skip: playerRoomsSkip, take: playerRoomsTake });
  // Another profile took over meanwhile; see loadPlayerPhotos().
  if (currentPlayerRoomsUserId !== userId) return;
  const loadingEl = $('playerRoomsLoading');
  if (loadingEl) loadingEl.remove();
  playerRoomsLoading = false;
  
  if (res && res.success && res.data && res.data.Results) {
    const rooms = res.data.Results || [];
    
    if (!append) grid.innerHTML = '';
    
    rooms.forEach(room => {
      const roomCard = document.createElement('div');
      roomCard.className = 'room-card';
      const imgUrl = roomThumbUrl(room, 400);
      const roomName = room.Name || room.name || 'Unknown Room';
      const creatorUsername = room.CreatorUsername || room.creatorUsername || 'Unknown';
      roomCard.innerHTML = `
        <img class="room-card-image image-loading-placeholder" loading="lazy" decoding="async" src="${escapeHtml(imgUrl)}" data-fallback="./images.png" alt="${escapeHtml(roomName)}" />
        ${liveBadgeHtml(room)}
        <div class="room-card-name">${escapeHtml(roomName)}</div>
        <div class="room-card-creator">by ${escapeHtml(creatorUsername)}</div>
        <div class="room-card-stats">
          <span>Cheers: <span class="room-card-cheers">...</span></span>
          <span>Visits: <span class="room-card-visits">...</span></span>
        </div>
      `;
      // Attach the creator click via a closure rather than inline onclick so a
      // username containing quotes can't break out of the JS-string context.
      const creatorEl = roomCard.querySelector('.room-card-creator');
      if (creatorEl) {
        creatorEl.addEventListener('click', (e) => {
          e.stopPropagation();
          showCreatorProfile(creatorUsername);
        });
      }
      roomCard.onclick = () => {
        switchTab('rooms');
        showRoomDetails(room);
      };
      grid.appendChild(roomCard);

      // Stats come off the row when the API sent them, which it does for both
      // networks. Every card used to fire fetchRoomWebDetails instead — on
      // Radium that is a GET of the full room page plus five regexes, so a
      // page of twelve cards was twelve HTML documents fetched for two numbers
      // that had already arrived with the list. The scrape is still here as a
      // fallback for a row that genuinely carries no counts.
      const cheerEl = roomCard.querySelector('.room-card-cheers');
      const visitEl = roomCard.querySelector('.room-card-visits');
      const known = roomStatsFromRow(room);
      if (known) {
        if (cheerEl) cheerEl.textContent = known.cheers;
        if (visitEl) visitEl.textContent = known.visits;
      } else {
        (async () => {
          const details = await getRoomWebDetails(roomName);
          const ok = details && details.success;
          if (cheerEl) cheerEl.textContent = ok ? (details.cheers || '0') : '—';
          if (visitEl) visitEl.textContent = ok ? (details.visits || '0') : '—';
        })();
      }
    });
    
    const totalInGrid = grid.querySelectorAll('.room-card').length;
    if (totalInGrid === 0 && !append) {
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
    }
    
    playerRoomsHasMore = rooms.length === playerRoomsTake;
    
    setupPlayerRoomsObserver();
  } else {
    if (!append) {
      grid.innerHTML = '';
      if (empty) { empty.textContent = 'Error loading rooms.'; empty.style.display = 'block'; }
    }
    playerRoomsHasMore = false;
  }
}

function hidePlayerDetails() {
  socialPerson = null;
  playerDetailSeq++;
  const list = $('peopleListView');
  const detail = $('peopleDetailView');
  if (list && detail) {
    detail.classList.add('hidden');
    list.classList.remove('hidden');
  }
  if (playerPhotoObserver) playerPhotoObserver.disconnect();
  if (playerFeedsObserver) playerFeedsObserver.disconnect();
  if (playerRoomsObserver) playerRoomsObserver.disconnect();
}

$('btnRoomsBack')?.addEventListener('click', hideRoomDetails);
$('btnPeopleBack')?.addEventListener('click', hidePlayerDetails);

// Image Lightbox Modal
const lightboxModal = $('lightboxModal');
const lightboxImage = $('lightboxImage');
const lightboxCloseBtn = $('lightboxCloseBtn');

/// Open the image preview.
///
/// `opts.title` names what is on screen — the box is shared between a player's
/// avatar and a full-size photo, and it used to be hard-labelled "PROFILE IMAGE
/// PREVIEW" for both, so opening a room photo announced it as somebody's
/// profile picture.
///
/// `opts.fallbackSrc` is the smaller copy to drop back to if the full-size URL
/// fails. That used to be hard-wired to the player-detail avatar, which is the
/// wrong picture entirely when the thing being previewed is a photo — and on
/// the photo screen it would swap in whichever profile happened to be loaded.
function showLightbox(src, opts = {}) {
  if (!lightboxModal || !lightboxImage) return;

  const titleEl = $('lightboxTitle');
  if (titleEl) titleEl.textContent = opts.title || 'IMAGE PREVIEW';
  lightboxImage.alt = opts.alt || opts.title || 'Full size preview';

  lightboxImage.classList.add('image-loading-placeholder');
  lightboxImage.onload = () => lightboxImage.classList.remove('image-loading-placeholder');
  lightboxImage.onerror = () => {
    lightboxImage.onerror = null;
    const fallback = opts.fallbackSrc;
    if (fallback && lightboxImage.src !== fallback) {
      lightboxImage.src = fallback;
    } else {
      lightboxImage.classList.remove('image-loading-placeholder');
    }
  };
  lightboxImage.src = src;
  showModal(lightboxModal);
  lightboxCloseBtn?.focus();
}

function hideLightbox() {
  if (!lightboxModal) return;
  // Drop the picture so a large one is not held in memory behind a closed
  // dialog, and so reopening never shows the previous image for a frame.
  // After the exit animation, so the picture does not vanish mid-fade.
  hideModal(lightboxModal, () => {
    if (lightboxImage) {
      lightboxImage.onload = null;
      lightboxImage.onerror = null;
      lightboxImage.src = 'data:,';
    }
  });
}

function lightboxIsOpen() {
  // A lightbox playing its exit animation is already closed as far as the
  // keyboard handlers are concerned.
  return !!lightboxModal && lightboxModal.style.display !== 'none'
    && !lightboxModal.classList.contains('is-closing');
}

lightboxCloseBtn?.addEventListener('click', hideLightbox);
lightboxModal?.addEventListener('click', (e) => {
  if (e.target === lightboxModal) {
    hideLightbox();
  }
});
// Esc closes it, the way every other dialog on the desktop does. Bound on the
// document because focus sits on the close button, not the overlay.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightboxIsOpen()) {
    e.preventDefault();
    hideLightbox();
  }
});

// Clear image placeholders for images that loaded from cache (where the inline
// onload may not fire). A MutationObserver reacts only when nodes are actually
// added, instead of polling the whole DOM every 500ms forever. Kept outside
// setupBugReporter so it installs even if the bug-report UI is absent.
(function setupImagePlaceholderObserver() {
  const clearIfLoaded = (el) => {
    if (el.tagName === 'IMG' && el.complete && el.src && el.src !== 'data:,') {
      el.classList.remove('image-loading-placeholder');
    }
  };
  const imgPlaceholderObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('image-loading-placeholder')) clearIfLoaded(node);
        node.querySelectorAll?.('.image-loading-placeholder').forEach(clearIfLoaded);
      }
    }
  });
  imgPlaceholderObserver.observe(document.body, { childList: true, subtree: true });
})();

