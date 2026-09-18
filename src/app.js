// ─── Uncaught fault capture ───────────────────────────────────────────────────
// Registered before anything else in this file. Startup is when the launcher is
// most likely to break (missing runtime, bad config, denied permissions), and a
// failure there used to leave no trace at all — the bug report would arrive
// describing a dead launcher with an empty log. `var` is deliberate: it has no
// temporal dead zone, so these are usable this early.
var startupFaults = [];          // faults raised before the log helpers exist
var seenFaults    = new Set();

function recordFault(label, message, where) {
  // Deduped: a fault inside a render or polling loop would otherwise flood the
  // buffer and push out the history that explains it.
  const key = `${label}|${message}|${where || ''}`;
  if (seenFaults.has(key)) return;
  if (seenFaults.size > 50) seenFaults.clear();
  seenFaults.add(key);

  const text = `${label}: ${message}${where ? ` (${where})` : ''}`;
  try {
    // Normal path once the logging helpers have initialised.
    addLog(text, 'error');
  } catch {
    // Thrown only when this fires before those are ready, which is exactly the
    // startup case worth capturing. Keep it for the bug report instead.
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    startupFaults.push(`[${ts}] [ERROR] ${text}  <during startup>`);
  }
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
  }
};

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
  return (network === 'vanilla' ? config.vanilla?.installDir : config.installDir) || '';
}

/// Placeholder for the log/modal text before checkInstall() has resolved the
/// real path. Per-network, since the two default to different folders.
function defaultInstallDirHint(network = activeNetwork) {
  return network === 'vanilla'
    ? '%APPDATA%\\com.radium.launcher\\client-vanilla'
    : '%APPDATA%\\com.radium.launcher\\client';
}

function setConfigInstallDir(dir, network = activeNetwork) {
  if (!config) return;
  if (network === 'vanilla') {
    config.vanilla = { ...(config.vanilla || {}), installDir: dir };
  } else {
    config.installDir = dir;
  }
}

/// The Settings path span for a network. Both rows exist at once, so every
/// read and write of a displayed path has to name which network it means.
function installDirSpan(network = activeNetwork) {
  return $(network === 'vanilla' ? 'cfgInstallDirVanilla' : 'cfgInstallDirRadium');
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
/// resolved default comes straight from the backend — the same path its
/// download would use.
async function refreshInstallDirRows() {
  for (const network of Object.keys(NETWORKS)) {
    const span = installDirSpan(network);
    if (!span) continue;
    let dir = configInstallDir(network);
    if (!dir) {
      try {
        dir = await window.radium?.getDefaultClientDir(network);
      } catch (e) {
        console.error('getDefaultClientDir error:', e);
      }
    }
    span.textContent = dir || defaultInstallDirHint(network);
  }
}

/// Mirrors `norm_dir` in config.rs: install paths reach the UI from the folder
/// picker, config.json and the backend's own resolver, which disagree on
/// separators and casing.
function normDir(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/// The other network's currently resolved folder, as Settings is showing it.
function otherNetworkInstallDir(network) {
  const other = network === 'vanilla' ? 'radium' : 'vanilla';
  return installDirSpan(other)?.textContent.trim() || configInstallDir(other) || '';
}

/// `cfg` without `glass.bgImage`. See saveConfig in the shim below.
function withoutBackdrop(cfg) {
  if (!cfg || !cfg.glass || !('bgImage' in cfg.glass)) return cfg;
  const { bgImage, ...glass } = cfg.glass;
  return { ...cfg, glass };
}

(function setupTauriShim() {
  const { invoke } = window.__TAURI__.core;
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

    // Server. Every command below takes the active network so the backend can
    // route to the right API without the call sites having to care.
    pingServer:     (url) => invoke('ping_server', { url }),
    getPlayerCount: ()    => invoke('get_player_count', { network: activeNetwork }),
    addDefenderExclusion:    () => invoke('add_defender_exclusion'),
    removeDefenderExclusion: () => invoke('remove_defender_exclusion'),
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
    // These three take an explicit network: Settings lists both networks'
    // install folders at once, so it has to address the inactive one too.
    openClientFolder: (network = activeNetwork) => invoke('open_client_folder', { network }),
    selectFolder:     (network = activeNetwork) => invoke('select_folder', { network }),
    getDefaultClientDir: (network = activeNetwork) => invoke('get_default_client_dir', { network }),
    onDownloadProgress: async (cb) => {
      if (unlistenMap['download-progress']) unlistenMap['download-progress']();
      unlistenMap['download-progress'] = await listen('download-progress', (event) => cb(event.payload));
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

    // Auto-update
    checkForUpdate:  ()                            => invoke('check_for_update'),
    // `digest` is the `sha256:<hex>` GitHub publishes for the release asset.
    // The backend refuses to run an installer whose bytes don't match it.
    downloadUpdate:  (downloadUrl, placeOnDesktop, digest) =>
      invoke('download_update', { url: downloadUrl, placeOnDesktop: !!placeOnDesktop, digest: digest || null }),

    // Data Fetching
    fetchRooms:           (args) => invoke('fetch_rooms', { args: { ...args, network: activeNetwork } }),
    fetchPeople:          (args) => invoke('fetch_people', { args: { ...args, network: activeNetwork } }),
    fetchFilters:         ()     => invoke('fetch_filters', { network: activeNetwork }),
    fetchRoomWebDetails:  (name) => invoke('fetch_room_web_details', { name: String(name), network: activeNetwork }),
    fetchUserWebDetails:  (name) => invoke('fetch_user_web_details', { name: String(name), network: activeNetwork }),
    fetchUserPhotos:      (args) => invoke('fetch_user_photos', { args: { ...args, network: activeNetwork } }),
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

    // Desktop notification pop-up (a separate always-on-top window).
    desktopNotify:     (cards) => invoke('desktop_notify', { cards }),
    onDesktopNotifOpen: async (cb) => {
      if (unlistenMap['desktop-notif-open']) unlistenMap['desktop-notif-open']();
      unlistenMap['desktop-notif-open'] = await listen('desktop-notif-open', (event) => cb(event.payload));
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

    // Bug Reporter
    submitBugReport: (description, logs, category, severity, diagnostics) =>
      invoke('submit_bug_report', { description, logs, category, severity, diagnostics }),
  };
})();

// App state variables
let config                = {};
let isGameRunning         = false;
let isGameLaunching       = false;
let isDownloading         = false;
// Cancel requested, but the backend loop only aborts at its next chunk and
// holds a global "download in progress" guard until it exits. Re-enabling
// Download before then makes the next click fail with "A download is already
// in progress.", so the button stays disabled through this window.
let isCancelling          = false;
let isPaused              = false;
let isInstalled           = false;
let playMode              = 'screen';
let launchAfterExclusion  = false;
let sacWarnedThisSession  = false;
// Last-known reachability from checkServerStatus(), surfaced in bug reports.
// null = not checked yet this session.
let lastServerStatus      = { apiOnline: null, cdnOnline: null };

// Capped log buffer — captures up to 2000 log entries for bug reports.
// The DOM viewer is capped at 120 for performance.
const fullLogBuffer = [];

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

/// Build one feed card from a photo row.
///
/// The single renderer behind the FEED tab, a room's photos, a player's photos
/// and a player's feed — those four used to carry four copies of this markup.
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
  // On Vanilla the count is the cheer button, as on vanillarec.net.
  const vanillaCheers = activeNetwork === 'vanilla' && (photo.Id ?? photo.id) != null;

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
      ${vanillaCheers ? '' : `<span class="feed-post-stat"><span class="cheers-count">${cheers}</span> Cheers</span>`}
      ${hasComments ? `<span class="feed-post-stat"><span class="comments-count">${comments}</span> Comments</span>` : ''}
    </div>
  `;

  card.querySelector('.image-wrap')?.addEventListener('click', () => {
    showPhotoDetails(photo, backToView);
  });

  if (vanillaCheers) card.querySelector('.feed-post-footer')?.prepend(buildCardCheer(photo));

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

/// Backdrop for a profile header.
///
/// Vanilla has no per-user banner — its own site paints every profile with one
/// shared pattern — so the launcher uses that same pattern rather than leaving
/// the header blank. Radium keeps its themed gradient, which a scraped banner
/// then overrides where one exists.
function defaultProfileBanner() {
  return activeNetwork === 'vanilla'
    ? "url('assets/vanilla-pattern.png')"
    : 'linear-gradient(135deg, var(--green-dim), var(--green))';
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

// Background Image Helper (prevent base64 string from freezing text inputs)
function setBgImageUI(val) {
  const el = $('theme-bgImage');
  if (!el) return;
  if (val && val.startsWith('data:image/')) {
    el.dataset.localBase64 = val;
    el.value = '(Local File Selected)';
  } else {
    delete el.dataset.localBase64;
    el.value = val || '';
  }
}

function getBgImageUI() {
  const el = $('theme-bgImage');
  if (!el) return '';
  if (el.value === '(Local File Selected)' && el.dataset.localBase64) {
    return el.dataset.localBase64;
  }
  return el.value;
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

// Severity levels. The label is stamped into the plain-text line so that
// copied/exported logs (e.g. pasted into a bug report) carry severity without
// relying on colour; the key doubles as the CSS class for the coloured viewer.
const LOG_LEVELS = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERROR' };

// Append log entry to list
function addLog(msg, type = 'info') {
  const level = LOG_LEVELS[type] ? type : 'info';
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  // Pad the tag to a fixed width so the message column stays aligned in the
  // monospaced viewer and in exported text. "[ERROR]" is the widest at 7 chars.
  const tag = `[${LOG_LEVELS[level]}]`.padEnd(8);
  const line = `[${ts}] ${tag}${msg}`;

  // Push to the full log buffer (capped at 2000 to prevent memory leaks)
  fullLogBuffer.push(line);
  if (fullLogBuffer.length > 2000) {
    fullLogBuffer.shift();
  }

  // Also render in the DOM viewer (capped at 120 entries for performance)
  const out = $('logOutput');
  if (!out) return;
  const el = document.createElement('div');
  el.className = `log-entry ${level}`;
  // Built from spans rather than the padded `line`. The padding in `line` is
  // literal spaces, which only line up under a monospaced face — and a font
  // pack can point --font-mono at a proportional one, which loses the column
  // the padEnd above exists to create. Fixed-width spans keep it square in
  // every pack. `line` keeps its padding for fullLogBuffer, which is exported
  // to a plain text file where spaces are the only alignment available.
  const tsEl = document.createElement('span');
  tsEl.className = 'log-ts';
  tsEl.textContent = `[${ts}]`;
  const tagEl = document.createElement('span');
  tagEl.className = 'log-tag';
  tagEl.textContent = `[${LOG_LEVELS[level]}]`;
  const msgEl = document.createElement('span');
  msgEl.className = 'log-msg';
  msgEl.textContent = msg;
  el.append(tsEl, tagEl, msgEl);
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
  while (out.children.length > 120) out.removeChild(out.firstChild);
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
      if (!listIsFresh(peopleKey(), peopleRenderKey, peopleRenderAt)) loadPeople();
      // The table is already rendered, but its height is measured against a
      // panel that was display:none until a moment ago.
      else snapTableRows($('peopleTableContainer'));
    } else if (tabName === 'feed') {
      // Only reload an empty feed, so returning to the tab keeps your place
      // in the list instead of jumping back to the top.
      if (!$('feedGrid')?.children.length) loadFeed();
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

  // Defender Exclusion State
  const btnExcludeAv = $('btnExcludeAv');
  if (btnExcludeAv) {
    setExcludeAvLabel(config.defenderExcluded);
  }

  // Network last, so the brand and capability gating are applied against a
  // fully-loaded config.
  applyNetworkUI(config.network === 'vanilla' ? 'vanilla' : 'radium');

  // Both install rows, not just the active network's — after applyNetworkUI so
  // the ACTIVE tag lands on the row the loaded config actually selected.
  await refreshInstallDirRows();
}

/// The custom palette is written as its own <style>, separate from the bulk of
/// the generated theme CSS.
///
/// Dragging a colour picker fires `input` continuously, and each one used to
/// rebuild and re-parse the whole ~25 KB custom stylesheet — measured at ~2.3 ms
/// of parsing per event against ~0.13 ms for the palette alone, before any of
/// the repainting that a full sheet swap also forces. That is what made the
/// pickers feel sticky, and worst under Liquid Glass, where every panel carries
/// Marks the body while Liquid Glass is on; every glass rule hangs off it.
const GLASS_CLASS = 'glass-enabled';
/// The generated glass stylesheet, and the copy boot.js injects from cache
/// before the first paint.
const GLASS_STYLE_ID = 'glass-style';
const GLASS_BOOT_STYLE_ID = 'glass-boot-style';

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

/// The Liquid Glass stylesheet, built for one tint and one optional backdrop.
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
/// Every selector opens with `:root body.glass-enabled`. That is one class more
/// specific than the moderndark rules glass is layered over — several of which
/// already carry a pseudo-class and `!important` — and this sheet is appended
/// after style.css, so a tie still lands on glass.
function glassCss(tint, bgImage, fullEffects = false) {
  const safeGlassBg = safeColor(tint, '#0b0c14');
  const safeBgImage = safeBackdrop(bgImage);
  const G = ':root body.glass-enabled';

  // With an image the veil stays light: the picture is the point, and the
  // panels already carry their own dark body for legibility. Without one, the
  // tint is mixed into Apple's system hues rather than replaced by them, so a
  // red tint still gives a red field.
  const backdrop = safeBgImage
    ? `linear-gradient(rgba(0, 0, 0, 0.22), rgba(0, 0, 0, 0.22)), url('${safeBgImage}') center / cover no-repeat`
    : `radial-gradient(70% 80% at 6% 4%, color-mix(in oklab, var(--lg-tint) 38%, #5e5ce6) 0%, transparent 72%),
          radial-gradient(64% 76% at 98% 2%, color-mix(in oklab, var(--lg-tint) 40%, #0a84ff) 0%, transparent 72%),
          radial-gradient(56% 60% at 58% 52%, color-mix(in oklab, var(--lg-tint) 58%, #5856d6) 0%, transparent 74%),
          radial-gradient(78% 78% at 92% 106%, color-mix(in oklab, var(--lg-tint) 38%, #bf5af2) 0%, transparent 72%),
          radial-gradient(68% 70% at 2% 102%, color-mix(in oklab, var(--lg-tint) 42%, #30b0c7) 0%, transparent 72%),
          linear-gradient(160deg, color-mix(in oklab, var(--lg-tint) 78%, #2c2c6e), var(--lg-tint))`;

  return `
        /* The tint, as a property rather than baked into the gradients, so
           the picker can preview a drag by setting it on <body> instead of
           rebuilding this sheet every frame. Registered as non-inherited so
           that change restyles <body> alone, not every element under it. */
        @property --lg-tint {
          syntax: '<color>';
          inherits: false;
          initial-value: #0b0c14;
        }

        /* ── Tokens ───────────────────────────────────────────────────── */
        ${G} {
          --lg-tint: ${safeGlassBg};
          /* Not \`background-attachment: fixed\`. <body> never scrolls, so
             fixed bought nothing — and a fixed background is repainted on the
             main thread whenever anything above it changes, so a hover
             transition in the sidebar redrew the whole backdrop and every blur
             on top of it, every frame. */
          background: ${backdrop} !important;
          /* Sized from the border edge and never tiled. By default a
             background is laid out in the padding box but painted under the
             border too, and repeats to fill it — so <body>'s 1px border showed
             the far side of the gradient wrapped round: a bright pink and
             purple line down the left and across the top of the window. */
          background-origin: border-box !important;
          background-repeat: no-repeat !important;

          /* The shared palette, restated for glass. --bg-dark stays
             transparent: base rules use it as "the surface behind this", and
             behind every glass surface is the backdrop. */
          --bg-dark: transparent !important;
          --bg-main: transparent !important;
          --bg-panel: rgba(255, 255, 255, 0.06) !important;
          --bg-btn: rgba(255, 255, 255, 0.10) !important;
          --border-light: rgba(255, 255, 255, 0.14) !important;
          --border-dark: rgba(255, 255, 255, 0.08) !important;
          --green: #ffffff !important;
          --green-dim: rgba(235, 235, 245, 0.6) !important;
          --text: #ffffff !important;
          --text-muted: rgba(235, 235, 245, 0.6) !important;
          --status-online: #30d158 !important;

          --lg-accent: #0a84ff;
          --lg-positive: #30d158;
          --lg-danger: #ff453a;
          --lg-ease: cubic-bezier(0.22, 1, 0.36, 1);
          --lg-spring: cubic-bezier(0.34, 1.4, 0.64, 1);

          /* A frosted surface: light pooled at the top-left where the glass
             is thickest, over a faint dark body that keeps white text legible
             when a bright part of the backdrop sits behind it. */
          --lg-frost-fill:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.10), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
            rgba(18, 20, 30, 0.30);
          /* An unfrosted surface: the same light, with more body standing in
             for the blur. */
          --lg-fill:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
            rgba(16, 18, 30, 0.52);
          /* Popovers float over content rather than the backdrop, so they
             need enough body to hide what they cover without a blur. */
          --lg-fill-popover:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.10), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)),
            rgba(28, 30, 42, 0.95);
          --lg-blur: blur(16px) saturate(170%);
          /* The specular edge: brightest along the top and left, where the
             light comes from, with a faint hairline all round. Inset shadows
             rather than a masked gradient ring, so it is anti-aliased on every
             renderer and costs no layer of its own. */
          --lg-rim-shadow:
            inset 1px 1px 0 rgba(255, 255, 255, 0.34),
            inset -1px -1px 0 rgba(255, 255, 255, 0.12),
            inset 0 0 0 1px rgba(255, 255, 255, 0.07);
          /* Light gathering along the bottom inside edge — what the eye reads
             as thickness — then a soft contact shadow. */
          --lg-shadow:
            inset 0 -14px 28px -22px rgba(255, 255, 255, 0.22),
            0 1px 1px rgba(0, 0, 0, 0.10),
            0 14px 34px -14px rgba(0, 0, 0, 0.50);
          /* Scrolling surfaces cannot host the ring: an absolutely positioned
             pseudo-element inside a scroller scrolls away with the content. */
          /* An even hairline, not the offset top highlight the ring-less
             surfaces used to carry. \`inset 0 1px 0\` only shows along the
             straight run of a rounded top edge and thins to nothing round the
             corners, so on the Filters and Sort By cards it read as a flat
             white bar laid across the top, stopping short of both corners —
             over a list scrolling underneath it, at that. */
          --lg-shadow-scroll:
            inset 0 0 0 1px rgba(255, 255, 255, 0.11),
            0 14px 34px -14px rgba(0, 0, 0, 0.50);
          --lg-control: rgba(255, 255, 255, 0.10);
          --lg-control-hover: rgba(255, 255, 255, 0.17);
          --lg-control-rim:
            inset 0 1px 0 rgba(255, 255, 255, 0.26),
            inset 0 0 0 1px rgba(255, 255, 255, 0.07);
        }

        /* ── Window chrome ────────────────────────────────────────────── */
        ${G} .titlebar {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          backdrop-filter: none !important;
          border-radius: 0 !important;
        }
        ${G} .titlebar-app-name {
          font-family: var(--font-ui) !important;
          font-size: 11px !important;
          font-weight: 600 !important;
          letter-spacing: 1.4px !important;
          color: rgba(255, 255, 255, 0.55) !important;
          text-shadow: none !important;
        }
        ${G} .titlebar-controls {
          display: flex !important;
          gap: 8px !important;
          align-items: center !important;
          margin-right: 8px !important;
        }
        ${G} .tb-ctrl {
          width: 12px !important;
          height: 12px !important;
          aspect-ratio: 1 / 1 !important;
          padding: 0 !important;
          margin: 0 !important;
          border: none !important;
          border-radius: 50% !important;
          box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.28) !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          color: transparent !important;
          font-size: 8px !important;
        }
        ${G} .tb-ctrl:hover { color: rgba(0, 0, 0, 0.6) !important; }
        ${G} .tb-ctrl.min { order: 1 !important; background: #febc2e !important; }
        ${G} .tb-ctrl.max { order: 2 !important; background: #28c840 !important; }
        ${G} .tb-ctrl.cls { order: 3 !important; background: #ff5f57 !important; }

        ${G} .app-layout,
        ${G} .main-content {
          background: transparent !important;
        }
        ${G} .main-content {
          padding: 2px 14px 12px 14px !important;
        }

        ${G} ::-webkit-scrollbar {
          width: 10px !important;
          height: 10px !important;
          background: transparent !important;
        }
        ${G} ::-webkit-scrollbar-track,
        ${G} ::-webkit-scrollbar-corner {
          background: transparent !important;
        }
        ${G} ::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.22) !important;
          background-clip: padding-box !important;
          border: 3px solid transparent !important;
          border-radius: 999px !important;
        }
        ${G} ::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.36) !important;
          background-clip: padding-box !important;
        }

        /* ── Glass surfaces ───────────────────────────────────────────── */
        ${G} .sidebar,
        ${G} .qs-card,
        ${G} .settings-group,
        ${G} .download-section,
        ${G} .native-grid-container,
        ${G} .native-table-container,
        ${G} #roomsSidebar > div,
        ${G} .native-search-bar input,
        ${G} [id$="DetailView"] > .bevel-inset,
        ${G} #tab-photo-detail > .bevel-inset,
        ${G} .log-output {
          background: var(--lg-fill) !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          border: none !important;
          border-radius: 22px !important;
          box-shadow: var(--lg-shadow) !important;
        }
        ${G} .native-grid-container,
        ${G} .native-table-container,
        ${G} #roomsSidebar > div,
        ${G} [id$="DetailView"] > .bevel-inset,
        ${G} #tab-photo-detail > .bevel-inset,
        ${G} .log-output {
          box-shadow: var(--lg-shadow-scroll) !important;
        }
        ${G} .network-menu,
        ${G} .manage-menu,
        ${G} .modal-box,
        ${G} .toast {
          background: var(--lg-fill-popover) !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          border: none !important;
          box-shadow:
            inset 0 -14px 28px -22px rgba(255, 255, 255, 0.2),
            0 24px 60px -18px rgba(0, 0, 0, 0.65),
            0 2px 6px rgba(0, 0, 0, 0.2) !important;
        }
        ${G} .network-menu,
        ${G} .manage-menu { border-radius: 18px !important; }
        ${G} .modal-box { border-radius: 26px !important; }
        ${G} .toast { border-radius: 14px !important; }

        /* The specular edge. Positioned only where the element isn't already:
           the two menus are absolutely placed and must stay that way. */
        ${G} .sidebar,
        ${G} .qs-card,
        ${G} .settings-group,
        ${G} .download-section,
        ${G} .modal-box,
        ${G} .toast {
          position: relative !important;
        }
        ${G} .sidebar::before,
        ${G} .qs-card::before,
        ${G} .settings-group::before,
        ${G} .download-section::before,
        ${G} .modal-box::before,
        ${G} .toast::before,
        ${G} .network-menu::before,
        ${G} .manage-menu::before,
        ${G} .home-hero::before {
          content: '' !important;
          display: block !important;
          position: absolute !important;
          inset: 0 !important;
          width: auto !important;
          height: auto !important;
          padding: 0 !important;
          border-radius: inherit !important;
          background: none !important;
          box-shadow: var(--lg-rim-shadow) !important;
          -webkit-mask: none !important;
          mask: none !important;
          pointer-events: none !important;
          opacity: 1 !important;
          transform: none !important;
          animation: none !important;
        }

        /* ── Sidebar ──────────────────────────────────────────────────── */
        /* Floats inset from the window edge instead of docking against it. */
        ${G} .sidebar {
          margin: 2px 0 12px 12px !important;
          padding: 12px 10px !important;
          border-radius: 24px !important;
        }
        ${G} .sidebar-logo,
        ${G} .sidebar-footer {
          border: none !important;
        }
        ${G} .sidebar-logo {
          padding-bottom: 6px !important;
          margin-bottom: 8px !important;
        }
        ${G} .sidebar-nav { gap: 2px !important; }

        /* Every .nav-btn starts neutral: the sidebar rows, the network picker,
           its options and the hero gear all wear the class, and moderndark
           paints it a purple gradient. */
        ${G} .nav-btn {
          background: transparent !important;
          border: none !important;
          border-radius: 12px !important;
          box-shadow: none !important;
          color: #ffffff !important;
          text-shadow: none !important;
          backdrop-filter: none !important;
          transition:
            background-color 0.25s var(--lg-ease),
            color 0.2s var(--lg-ease),
            transform 0.4s var(--lg-spring) !important;
        }
        ${G} .nav-btn:hover {
          background: rgba(255, 255, 255, 0.08) !important;
          transform: none !important;
        }
        ${G} .nav-btn:active { transform: scale(0.97) !important; }
        ${G} .nav-btn.active {
          background: rgba(255, 255, 255, 0.16) !important;
          box-shadow:
            var(--lg-control-rim),
            0 4px 14px -6px rgba(0, 0, 0, 0.45) !important;
          color: #ffffff !important;
        }

        /* Sentence case, from labels written in capitals in the markup. */
        ${G} .sidebar-nav .nav-btn {
          width: 100% !important;
          margin: 0 !important;
          padding: 8px 12px !important;
          font-family: var(--font-ui) !important;
          font-size: 13px !important;
          font-weight: 500 !important;
          letter-spacing: 0 !important;
          text-transform: lowercase !important;
          color: rgba(255, 255, 255, 0.78) !important;
        }
        ${G} .sidebar-nav .nav-btn::first-letter { text-transform: uppercase !important; }
        ${G} .sidebar-nav .nav-btn:hover,
        ${G} .sidebar-nav .nav-btn.active { color: #ffffff !important; }
        ${G} .sidebar-nav .nav-btn.active { font-weight: 600 !important; }

        /* No browser focus ring. Chromium draws its own white double ring
           round a focused button, and the tab switch leaves the clicked row
           focused — so the active item wore a hard white outline that
           flickered as the pointer moved over its neighbours. Keyboard focus
           still shows, as the same wash a hover gives. */
        ${G} .nav-btn:focus,
        ${G} .filter-btn:focus,
        ${G} .sort-btn:focus {
          outline: none !important;
        }
        ${G} .nav-btn:focus-visible:not(.active),
        ${G} .filter-btn:focus-visible:not(.active),
        ${G} .sort-btn:focus-visible:not(.active) {
          background: rgba(255, 255, 255, 0.08) !important;
        }

        /* The tab entrance: a rise, with no fade. Opacity below 1 on an
           ancestor makes it the root every backdrop-filter inside it samples
           from, so while moderndark's fade ran the cards frosted an empty,
           transparent layer and only picked up the backdrop when it finished
           — they came in hollow and then snapped. Holding it with
           \`forwards\` would only keep them hollow for good. Doubled class to
           outrank the four-class rule it replaces. */
        ${G}.glass-enabled .tab-panel.active,
        ${G}.glass-enabled #roomsDetailView:not(.hidden) {
          animation: glassTabIn 0.4s var(--lg-ease) !important;
        }
        @keyframes glassTabIn {
          from { transform: translateY(8px); }
        }

        /* ── Menus ────────────────────────────────────────────────────── */
        ${G} .network-menu .nav-btn,
        ${G} .manage-menu .manage-item {
          background: transparent !important;
          border: none !important;
          border-radius: 10px !important;
          box-shadow: none !important;
          color: #ffffff !important;
          font-weight: 500 !important;
          text-shadow: none !important;
          transform: none !important;
        }
        ${G} .network-menu .nav-btn:hover,
        ${G} .manage-menu .manage-item:hover {
          background: rgba(255, 255, 255, 0.12) !important;
        }
        ${G} .manage-menu .manage-item.danger { color: #ff6961 !important; }
        ${G} .manage-menu .manage-item.danger:hover { background: rgba(255, 69, 58, 0.16) !important; }
        ${G} .manage-sep { background: rgba(255, 255, 255, 0.10) !important; }

        /* The gear's manage menu: a solid popover, lit like the cards. At 95%
           it still let the status card underneath read through, and in the
           app's window that card — a separate GPU layer, for its frost — came
           through clearly. So the body is solid, and the hero wrap that holds
           the menu is lifted above the status cards outright. The rim is inset
           shadows here, so the generic ring on ::before is dropped. */
        ${G} .home-hero-wrap { z-index: 5 !important; }
        ${G} .manage-menu {
          background:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
            #1e2030 !important;
          border: none !important;
          border-radius: 16px !important;
          min-width: 214px !important;
          margin-top: 6px !important;
          padding: 6px !important;
          gap: 2px !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            inset 0 0 0 1px rgba(255, 255, 255, 0.09),
            0 24px 60px -18px rgba(0, 0, 0, 0.65),
            0 2px 6px rgba(0, 0, 0, 0.2) !important;
        }
        ${G} .manage-menu::before { display: none !important; }
        ${G} #manageMenu .manage-item {
          gap: 11px !important;
          padding: 8px 12px !important;
          border-radius: 10px !important;
          font-family: var(--font-ui) !important;
          font-size: 13px !important;
          font-weight: 500 !important;
          letter-spacing: 0 !important;
          color: rgba(255, 255, 255, 0.92) !important;
          transition: background-color 0.18s var(--lg-ease), color 0.18s var(--lg-ease) !important;
        }
        ${G} #manageMenu .manage-item svg {
          width: 16px !important;
          height: 16px !important;
          opacity: 0.75 !important;
        }
        ${G} #manageMenu .manage-item:hover,
        ${G} #manageMenu .manage-item:focus-visible {
          background: rgba(255, 255, 255, 0.12) !important;
          color: #ffffff !important;
        }
        ${G} #manageMenu .manage-item:hover svg,
        ${G} #manageMenu .manage-item:focus-visible svg { opacity: 1 !important; }
        ${G} #manageMenu .manage-item.danger { color: #ff6961 !important; }
        ${G} #manageMenu .manage-item.danger:hover,
        ${G} #manageMenu .manage-item.danger:focus-visible {
          background: rgba(255, 69, 58, 0.18) !important;
          color: #ff7a73 !important;
        }
        ${G} #manageMenu .manage-sep {
          height: 1px !important;
          border: none !important;
          margin: 4px 8px !important;
          background: rgba(255, 255, 255, 0.10) !important;
        }

        /* The network menu opens inside the sidebar, and the sidebar is itself
           a backdrop-filter — Chromium does not blur a backdrop-filter nested
           inside another one, so this menu's frost never happened and the
           66% popover tint left Home, Rooms and People reading straight
           through it. It gets a solid body instead, lit the same way — even
           at 97% the nav labels still ghosted through. */
        ${G} .network-menu {
          background:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
            #1e2030 !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          padding: 6px !important;
          gap: 2px !important;
        }
        ${G} .network-menu .network-option {
          gap: 10px !important;
          padding: 8px 10px !important;
          margin: 0 !important;
        }
        ${G} .network-menu .network-option.active {
          background: rgba(255, 255, 255, 0.14) !important;
          box-shadow: var(--lg-control-rim) !important;
        }
        ${G} .network-option-icon {
          width: 28px !important;
          height: 28px !important;
          border: none !important;
          border-radius: 7px !important;
        }
        /* Custom selects. The same solid popover as the network menu, for the
           same reason: they open inside a settings group, which is itself a
           backdrop-filter, so a blur here would never happen. The menu
           scrolls, so its edge light is an inset shadow rather than the ring,
           which would scroll away with the rows. */
        ${G} .cselect-menu {
          background:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
            #1e2030 !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          border: none !important;
          border-radius: 14px !important;
          padding: 6px !important;
          gap: 2px !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            inset 0 0 0 1px rgba(255, 255, 255, 0.09),
            0 24px 60px -18px rgba(0, 0, 0, 0.65),
            0 2px 6px rgba(0, 0, 0, 0.2) !important;
        }
        ${G} .cselect-menu::-webkit-scrollbar-track { margin: 10px 0 !important; }
        ${G} .cselect-menu .cselect-option {
          margin: 0 !important;
          padding: 7px 10px !important;
          border-radius: 9px !important;
          font-family: var(--font-ui) !important;
          font-size: 12.5px !important;
          font-weight: 500 !important;
          letter-spacing: 0 !important;
          text-transform: none !important;
        }
        ${G} .cselect-menu .cselect-option.active {
          background: rgba(255, 255, 255, 0.14) !important;
          box-shadow: var(--lg-control-rim) !important;
          font-weight: 600 !important;
        }
        ${G} .cselect-trigger {
          font-family: var(--font-ui) !important;
          font-size: 12px !important;
          padding: 0 12px !important;
        }
        ${G} .cselect-trigger.is-open {
          background: rgba(255, 255, 255, 0.10) !important;
          box-shadow:
            inset 0 0 0 1px rgba(10, 132, 255, 0.95),
            inset 0 0 0 3px rgba(10, 132, 255, 0.28) !important;
        }
        ${G}.animations-enabled .cselect-menu:not([hidden]) {
          animation: networkMenuDrop 0.2s var(--lg-ease);
          transform-origin: top center;
        }
        ${G}.animations-enabled .cselect-menu.opens-up:not([hidden]) {
          transform-origin: bottom center;
        }
        ${G}.animations-enabled .cselect-menu.is-closing {
          animation: networkMenuLift 0.14s ease-in forwards;
        }

        /* Size comes from the base rule, shared by every skin. */
        ${G} .network-option-name {
          font-family: var(--font-ui) !important;
          font-weight: 600 !important;
          letter-spacing: 0.3px !important;
        }
        /* No ✓ on the current network: its row is already lit (the active
           background and rim above), and the tick read as cheap. */
        ${G} .network-option-check { display: none !important; }

        /* ── Tabs ─────────────────────────────────────────────────────── */
        /* Panels no longer wrap the whole tab in one more slab of glass: the
           cards inside are the surfaces, and glass on glass only muddies. The
           padding leaves the cards' shadows room inside the scroll clip. */
        ${G} .tab-panel {
          background: transparent !important;
          border: none !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          backdrop-filter: none !important;
          box-sizing: border-box !important;
          /* Widened into .main-content's 14px side padding, with that much
             more padding of its own, so the content sits exactly where it did
             but the clip edge moves out to where a card's shadow has faded.
             At 2px from the cards, the shadows (which reach ~20px sideways)
             ended in a hard vertical line down both sides. \`width: auto\` so
             the column's stretch alignment can take the negative margins. */
          width: auto !important;
          margin: 0 -14px !important;
          padding: 2px 20px 16px 16px !important;
        }
        ${G} #tab-rooms,
        ${G} #tab-people {
          padding: 2px 16px 4px 16px !important;
        }

        /* Never let a glass surface sit flush against the edge that clips
           it. Where a backdrop-filter's bottom edge lands exactly on its
           scroller's clip edge, Chromium intersects the two and loses the
           border-radius — the frost is drawn as a square behind the rounded
           card, a second corner at both bottom corners. So the scrollers
           that end on a glass surface keep a margin of their own:
           .settings-body is what actually scrolls on Settings (the tab around
           it does not), and the detail views clip their glass well flush. */
        ${G} #tab-settings { padding-bottom: 0 !important; }
        /* The same widening one level in, into the tab's (now wider) padding,
           because on Settings this is the box that clips — on all four sides,
           since the first group sat flush against its top edge too. */
        ${G} .settings-body {
          margin: -6px -20px 0 -16px !important;
          padding: 6px 24px 16px 16px !important;
        }

        /* The Rooms and People list views, the Rooms sidebar and the two
           detail views all clipped with overflow, and the glass inside each
           filled it edge to edge — the Filters and Sort By cards, the room
           grid, the People table, the detail wells. None of them needs the
           clip: every child that can outgrow them already scrolls on its own,
           so they stop clipping and there is no edge left to sit flush on.
           (Found by walking every view for backdrop-filter surfaces touching
           an ancestor's clip, rather than one screenshot at a time.) */
        ${G} #roomsListView,
        ${G} #roomsListView > .flex-1,
        ${G} #roomsSidebar,
        ${G} #peopleListView,
        ${G} #roomsDetailView,
        ${G} #peopleDetailView {
          overflow: visible !important;
        }
        ${G} #roomsDetailView,
        ${G} #peopleDetailView {
          padding-bottom: 6px !important;
        }
        ${G} .panel-header {
          border: none !important;
          background: transparent !important;
          padding: 6px 4px 10px !important;
        }
        ${G} .panel-header h2 {
          font-family: var(--font-ui) !important;
          font-size: 24px !important;
          font-weight: 700 !important;
          letter-spacing: -0.3px !important;
          color: #ffffff !important;
          text-shadow: none !important;
          text-transform: lowercase !important;
        }
        ${G} .panel-header h2::first-letter { text-transform: uppercase !important; }

        /* ── Buttons ──────────────────────────────────────────────────── */
        ${G} .btn-refresh,
        ${G} .btn-save,
        ${G} .btn-test-server,
        ${G} .btn-cancel-dl,
        ${G} .btn-kill,
        ${G} .btn-open-folder,
        ${G} .btn-reinstall,
        ${G} .btn-uninstall,
        ${G} .btn-exclude-av,
        ${G} .modal-btn,
        ${G} .launch-secondary-actions button {
          background: var(--lg-control) !important;
          border: none !important;
          border-radius: 999px !important;
          box-shadow: var(--lg-control-rim), 0 1px 2px rgba(0, 0, 0, 0.14) !important;
          color: #ffffff !important;
          font-family: var(--font-ui) !important;
          font-weight: 600 !important;
          letter-spacing: 0.1px !important;
          text-shadow: none !important;
          backdrop-filter: none !important;
          transition:
            background-color 0.2s var(--lg-ease),
            box-shadow 0.2s var(--lg-ease),
            transform 0.4s var(--lg-spring) !important;
        }
        ${G} .btn-refresh:hover,
        ${G} .btn-save:hover,
        ${G} .btn-test-server:hover,
        ${G} .btn-cancel-dl:hover,
        ${G} .btn-kill:hover,
        ${G} .btn-open-folder:hover,
        ${G} .btn-reinstall:hover,
        ${G} .btn-uninstall:hover,
        ${G} .btn-exclude-av:hover,
        ${G} .modal-btn:hover,
        ${G} .launch-secondary-actions button:hover {
          background: var(--lg-control-hover) !important;
          transform: none !important;
        }
        ${G} .btn-refresh:active,
        ${G} .btn-save:active,
        ${G} .btn-test-server:active,
        ${G} .btn-cancel-dl:active,
        ${G} .btn-kill:active,
        ${G} .btn-open-folder:active,
        ${G} .btn-reinstall:active,
        ${G} .btn-uninstall:active,
        ${G} .btn-exclude-av:active,
        ${G} .modal-btn:active,
        ${G} .launch-secondary-actions button:active {
          background: rgba(255, 255, 255, 0.07) !important;
          transform: scale(0.96) !important;
        }
        /* Disabled buttons do nothing on hover or press, and keep the plain
           arrow. moderndark gives them \`cursor: not-allowed\`, which on
           Windows is a small circle — over a dimmed Previous on page 1 it
           read as a stray white dot on the button. */
        ${G} button:disabled,
        ${G} button:disabled:hover,
        ${G} button:disabled:active {
          cursor: default !important;
          transform: none !important;
          filter: none !important;
        }
        /* Dimmed with colour, not opacity, and the same in every state.
           moderndark fades a disabled button to opacity 0.4, which gives it a
           compositing layer of its own; in the app's window that layer drew a
           stray dot at the capsule's left tip, where Previous sits flush
           against the list view's clip edge. (Never reproduced in headless
           Chromium — this removes the cause rather than a symptom seen.) */
        ${G} :is(.btn-refresh, .btn-save, .btn-test-server, .btn-cancel-dl, .btn-kill,
                 .btn-open-folder, .btn-reinstall, .btn-uninstall, .btn-exclude-av,
                 .modal-btn:not(.modal-btn-primary), .launch-secondary-actions button):disabled {
          opacity: 1 !important;
          background: rgba(255, 255, 255, 0.04) !important;
          color: rgba(255, 255, 255, 0.35) !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
        }
        /* And off that clip edge: 2px either side keeps Previous and Next from
           touching the edges of the list view that clips them. */
        ${G} .native-pagination {
          padding-left: 2px !important;
          padding-right: 2px !important;
        }

        ${G} .modal-btn-primary {
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0)),
            var(--lg-accent) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.35),
            0 6px 18px -6px rgba(10, 132, 255, 0.6) !important;
        }
        ${G} .modal-btn-primary.modal-btn-danger {
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0)),
            var(--lg-danger) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.3),
            0 6px 18px -6px rgba(255, 69, 58, 0.55) !important;
        }
        ${G} .modal-btn-primary:hover { filter: brightness(1.08) !important; }

        /* The primary action: a clear-glass rounded rectangle, milky enough
           to read as frosted, lit softly from the top with a crisp rim.

           Deliberately one plain box. It used to carry a real frost — a
           masked backdrop-filter on ::after, cut round from six gradient
           tiles — and on the GPU that layer came apart at the corners and
           ends: broken edges and stray white dots, worse under a scale. A
           rounded box with inset shadows is drawn cleanly by every renderer,
           and it is what makes the motion below safe to run.

           The fill never changes: background-color and background-image are
           fixed and neither is transitioned, which is what keeps hover from
           flashing. The hover highlight is ::before fading in over it, behind
           the label (\`isolation\` keeps its negative z-index inside). */
        ${G} .btn-play,
        ${G} .btn-download-big {
          position: relative !important;
          isolation: isolate !important;
          background-color: rgba(255, 255, 255, 0.14) !important;
          background-image:
            linear-gradient(180deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.04) 55%, rgba(255, 255, 255, 0.09) 100%) !important;
          color: #ffffff !important;
          border: none !important;
          border-radius: 14px !important;
          padding: 0 26px !important;
          font-family: var(--font-ui) !important;
          font-weight: 600 !important;
          text-shadow: 0 1px 1px rgba(0, 0, 0, 0.3) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.6),
            inset 0 -1px 0 rgba(255, 255, 255, 0.14),
            inset 0 0 0 1px rgba(255, 255, 255, 0.16),
            0 8px 24px -10px rgba(0, 0, 0, 0.6) !important;
          transition:
            box-shadow 0.3s var(--lg-ease),
            transform 0.5s var(--lg-spring) !important;
        }
        ${G} .btn-play::before,
        ${G} .btn-download-big::before {
          content: '' !important;
          position: absolute !important;
          inset: 1px !important;
          z-index: -1 !important;
          border-radius: 13px !important;
          pointer-events: none !important;
          background: radial-gradient(120% 100% at 50% 0%, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0) 65%) !important;
          opacity: 0 !important;
          transition: opacity 0.3s var(--lg-ease) !important;
        }
        /* Hover lifts and grows a touch on the spring, the highlight fades in
           and the rim brightens with a soft glow. */
        ${G} .btn-play:hover,
        ${G} .btn-download-big:hover {
          transform: translateY(-1px) scale(1.03) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.8),
            inset 0 -1px 0 rgba(255, 255, 255, 0.2),
            inset 0 0 0 1px rgba(255, 255, 255, 0.26),
            0 0 26px -6px rgba(255, 255, 255, 0.32),
            0 14px 30px -12px rgba(0, 0, 0, 0.65) !important;
        }
        ${G} .btn-play:hover::before,
        ${G} .btn-download-big:hover::before {
          opacity: 1 !important;
        }
        /* Pressed sinks quickly; release springs back through the base
           transition. Beats every skin's own :active scale. */
        ${G} .btn-play:is(:active, .is-pressed),
        ${G} .btn-download-big:is(:active, .is-pressed) {
          transform: scale(0.97) !important;
          transition:
            box-shadow 0.12s var(--lg-ease),
            transform 0.12s var(--lg-ease) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.5),
            inset 0 0 0 1px rgba(255, 255, 255, 0.18),
            0 4px 14px -8px rgba(0, 0, 0, 0.6) !important;
        }
        ${G} .btn-play:is(:active, .is-pressed)::before,
        ${G} .btn-download-big:is(:active, .is-pressed)::before {
          opacity: 0.45 !important;
        }
        ${G} .btn-play .play-text,
        ${G} .btn-download-big {
          letter-spacing: 1px !important;
        }
        /* Running: the same glass, tinted red. Its colour is fixed across hover
           too, so a running button cannot flash either. */
        ${G} .btn-play.running,
        ${G} .btn-play.running:hover,
        ${G} .btn-play.running:is(:active, .is-pressed) {
          background-color: rgba(255, 69, 58, 0.45) !important;
          color: #ffffff !important;
        }
        ${G} .btn-play.running {
          box-shadow:
            inset 0 1px 0 rgba(255, 210, 206, 0.6),
            inset 0 0 0 1px rgba(255, 150, 140, 0.24),
            0 8px 24px -10px rgba(255, 69, 58, 0.6) !important;
        }
        ${G} .btn-play.running:hover {
          box-shadow:
            inset 0 1px 0 rgba(255, 220, 216, 0.8),
            inset 0 0 0 1px rgba(255, 160, 150, 0.32),
            0 0 26px -6px rgba(255, 69, 58, 0.45),
            0 14px 30px -12px rgba(255, 69, 58, 0.6) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          ${G} .btn-play,
          ${G} .btn-download-big,
          ${G} .btn-play:hover,
          ${G} .btn-download-big:hover,
          ${G} .btn-play:is(:active, .is-pressed),
          ${G} .btn-download-big:is(:active, .is-pressed) {
            transform: none !important;
          }
        }

        /* ── Home ─────────────────────────────────────────────────────── */
        ${G} .home-hero {
          border: none !important;
          border-radius: 26px !important;
          box-shadow: 0 18px 44px -20px rgba(0, 0, 0, 0.7) !important;
        }
        ${G} .home-hero::before { z-index: 4 !important; }
        /* A soft scrim rather than a slab of black. It used to carry a
           progressive blur as well, but that was a full-width live blur
           clipped to the hero's rounded corners — expensive, and aliased at
           the bottom corners on the GPU. */
        ${G} .home-hero-bar {
          z-index: 1 !important;
          background: linear-gradient(180deg,
            rgba(0, 0, 0, 0) 0%,
            rgba(0, 0, 0, 0.3) 40%,
            rgba(0, 0, 0, 0.62) 100%) !important;
        }
        ${G} .hero-mode-label {
          font-family: var(--font-ui) !important;
          font-size: 10px !important;
          font-weight: 600 !important;
          letter-spacing: 0.6px !important;
          color: rgba(255, 255, 255, 0.72) !important;
        }

        /* Segmented control: a clear track with a lens that glides between
           the two segments and overshoots slightly as it lands. */
        ${G} .mode-toggle-wrap {
          position: relative !important;
          z-index: 1 !important;
          display: inline-flex !important;
          gap: 4px !important;
          padding: 3px !important;
          background: rgba(118, 118, 128, 0.32) !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          border: none !important;
          border-radius: 999px !important;
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.10),
            inset 0 1px 2px rgba(0, 0, 0, 0.2) !important;
        }
        ${G} .mode-btn {
          position: relative !important;
          z-index: 2 !important;
          width: 80px !important;
          padding: 6px 0 !important;
          text-align: center !important;
          background: transparent !important;
          border: none !important;
          border-radius: 999px !important;
          box-shadow: none !important;
          color: rgba(255, 255, 255, 0.7) !important;
          font-family: var(--font-ui) !important;
          font-size: 11px !important;
          font-weight: 600 !important;
          letter-spacing: 0.4px !important;
          transition: color 0.25s var(--lg-ease) !important;
        }
        ${G} .mode-btn:hover:not(.active) {
          color: #ffffff !important;
          background: transparent !important;
        }
        ${G} .mode-btn.active {
          color: #ffffff !important;
          background: transparent !important;
          box-shadow: none !important;
        }
        ${G} .mode-slider {
          display: block !important;
          position: absolute !important;
          top: 3px !important;
          bottom: 3px !important;
          left: 3px !important;
          width: 80px !important;
          z-index: 1 !important;
          border-radius: 999px !important;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.2)) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.5),
            inset 0 0 0 1px rgba(255, 255, 255, 0.14),
            0 3px 10px -2px rgba(0, 0, 0, 0.4) !important;
          transition: transform 0.5s var(--lg-spring) !important;
        }

        ${G} #btnManageClient,
        ${G} #btnManageClient[aria-expanded="false"]:hover,
        ${G} #btnManageClient[aria-expanded="false"]:focus-visible {
          width: 40px !important;
          height: 40px !important;
          border-radius: 50% !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          background: rgba(255, 255, 255, 0.16) !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.3),
            inset 0 0 0 1px rgba(255, 255, 255, 0.1),
            0 6px 18px -8px rgba(0, 0, 0, 0.6) !important;
          color: #ffffff !important;
        }
        ${G} #btnManageClient[aria-expanded="false"]:hover,
        ${G} #btnManageClient.active {
          background: rgba(255, 255, 255, 0.24) !important;
        }

        ${G} .quick-stats { gap: 12px !important; }
        ${G} .qs-card {
          border-radius: 20px !important;
          padding: 12px 16px !important;
          gap: 4px !important;
          transition: transform 0.4s var(--lg-spring) !important;
        }
        ${G} .qs-label {
          font-family: var(--font-ui) !important;
          font-size: 11px !important;
          font-weight: 500 !important;
          letter-spacing: 0.1px !important;
          text-transform: none !important;
          color: var(--text-muted) !important;
        }
        ${G} .qs-value {
          font-family: var(--font-ui) !important;
          font-size: 16px !important;
          font-weight: 600 !important;
          letter-spacing: -0.1px !important;
          color: #ffffff !important;
        }
        ${G} .qs-icon-indicator {
          width: 8px !important;
          height: 8px !important;
          border-radius: 50% !important;
          background: rgba(255, 255, 255, 0.28) !important;
          box-shadow: none !important;
        }
        ${G} .qs-card.online .qs-icon-indicator,
        ${G} .qs-card.installed .qs-icon-indicator {
          background: var(--lg-positive) !important;
          box-shadow: 0 0 10px rgba(48, 209, 88, 0.8) !important;
        }
        ${G} .qs-card.offline .qs-icon-indicator {
          background: var(--lg-danger) !important;
          box-shadow: 0 0 10px rgba(255, 69, 58, 0.8) !important;
        }
        ${G} .qs-card.not-installed .qs-icon-indicator {
          background: #ffd60a !important;
          box-shadow: 0 0 10px rgba(255, 214, 10, 0.7) !important;
        }

        /* ── Download progress ────────────────────────────────────────── */
        ${G} .dl-progress-block { border-radius: 22px !important; }
        ${G} .dlp-phase,
        ${G} .dlp-pct,
        ${G} .dlp-stat-val { color: #ffffff !important; }
        ${G} .dlp-stat-label { color: var(--text-muted) !important; }
        ${G} .dlp-dot {
          background: var(--lg-accent) !important;
          border-radius: 50% !important;
          box-shadow: 0 0 10px rgba(10, 132, 255, 0.9) !important;
          animation: dlp-pulse 1s ease-in-out infinite !important;
        }
        ${G} .dlp-bar-wrap {
          background: rgba(255, 255, 255, 0.10) !important;
          border: none !important;
          border-radius: 999px !important;
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25) !important;
        }
        ${G} .dlp-bar-fill {
          background: linear-gradient(90deg, var(--lg-accent), #64d2ff) !important;
          border-radius: 999px !important;
          box-shadow: 0 0 12px rgba(10, 132, 255, 0.55) !important;
        }
        ${G} .dlp-step,
        ${G} .dlp-stat {
          background: rgba(255, 255, 255, 0.06) !important;
          border: none !important;
          border-radius: 12px !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
        }
        ${G} .dlp-step { opacity: 0.6 !important; }
        ${G} .dlp-step.active,
        ${G} .dlp-step.done { opacity: 1 !important; }
        ${G} .dlp-step.active {
          color: #ffffff !important;
          background: rgba(255, 255, 255, 0.14) !important;
          box-shadow: var(--lg-control-rim) !important;
        }
        ${G} .dlp-step.done { color: rgba(255, 255, 255, 0.85) !important; }
        ${G} .dlp-step-idx {
          background: rgba(255, 255, 255, 0.16) !important;
          color: rgba(255, 255, 255, 0.85) !important;
          border: none !important;
          border-radius: 50% !important;
        }
        ${G} .dlp-step.active .dlp-step-idx {
          background: #ffffff !important;
          color: #0b0c10 !important;
        }
        ${G} .dlp-step.done .dlp-step-idx {
          background: rgba(255, 255, 255, 0.65) !important;
          color: #0b0c10 !important;
        }

        /* ── Settings ─────────────────────────────────────────────────── */
        ${G} .settings-group {
          border-radius: 22px !important;
          padding: 16px 18px !important;
          gap: 10px !important;
        }
        ${G} .sg-title {
          font-family: var(--font-ui) !important;
          font-size: 11px !important;
          font-weight: 600 !important;
          letter-spacing: 0.6px !important;
          color: var(--text-muted) !important;
          border: none !important;
          padding: 0 0 2px !important;
        }
        ${G} .sg-row label,
        ${G} .sg-toggle-row > span {
          font-size: 12.5px !important;
          font-weight: 500 !important;
          color: #ffffff !important;
        }
        ${G} .sg-toggle-row + .sg-toggle-row {
          border-top: 1px solid rgba(255, 255, 255, 0.07) !important;
          padding-top: 8px !important;
        }
        ${G} .sg-hint {
          font-size: 11px !important;
          color: rgba(235, 235, 245, 0.5) !important;
        }

        ${G} .cfg-input,
        ${G} .cfg-select,
        ${G} .cfg-path-display,
        ${G} select,
        ${G} input[type="text"],
        ${G} input[type="number"],
        ${G} textarea {
          background: rgba(255, 255, 255, 0.07) !important;
          border: none !important;
          border-radius: 10px !important;
          color: #ffffff !important;
          min-height: 30px !important;
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.08),
            inset 0 1px 2px rgba(0, 0, 0, 0.18) !important;
          backdrop-filter: none !important;
          outline: none !important;
          transition: background-color 0.2s var(--lg-ease), box-shadow 0.2s var(--lg-ease) !important;
        }
        ${G} .cfg-input:not(select),
        ${G} input[type="text"],
        ${G} input[type="number"],
        ${G} textarea {
          padding: 6px 12px !important;
        }
        ${G} .cfg-path-display {
          display: flex !important;
          align-items: center !important;
          padding: 0 12px !important;
        }
        ${G} .cfg-input:focus,
        ${G} .cfg-select:focus,
        ${G} select:focus,
        ${G} input[type="text"]:focus,
        ${G} input[type="number"]:focus,
        ${G} textarea:focus {
          background: rgba(255, 255, 255, 0.10) !important;
          box-shadow:
            inset 0 0 0 1px rgba(10, 132, 255, 0.9),
            0 0 0 3px rgba(10, 132, 255, 0.32) !important;
        }
        ${G} ::placeholder { color: rgba(235, 235, 245, 0.35) !important; }
        ${G} select option {
          background: #1f2029 !important;
          color: #ffffff !important;
        }

        /* Switches, sized and sprung like iOS. Pressing stretches the knob
           toward where it is about to travel. */
        ${G} .toggle-wrap {
          position: relative !important;
          flex-shrink: 0 !important;
          width: 42px !important;
          height: 24px !important;
          border: none !important;
          border-radius: 999px !important;
          background: rgba(120, 120, 128, 0.36) !important;
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.06),
            inset 0 1px 2px rgba(0, 0, 0, 0.2) !important;
          transition: background-color 0.25s var(--lg-ease) !important;
        }
        ${G} .tgl-knob {
          top: 2px !important;
          left: 2px !important;
          width: 20px !important;
          height: 20px !important;
          border: none !important;
          border-radius: 999px !important;
          background: #ffffff !important;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3), 0 0 0 0.5px rgba(0, 0, 0, 0.04) !important;
          transform: none !important;
          transition: transform 0.4s var(--lg-spring), width 0.2s var(--lg-ease) !important;
        }
        ${G} .toggle-wrap:active .tgl-knob { width: 25px !important; }
        ${G} .toggle-wrap.on { background: var(--lg-positive) !important; }
        ${G} .toggle-wrap.on .tgl-knob {
          background: #ffffff !important;
          transform: translateX(18px) !important;
        }
        ${G} .toggle-wrap.on:active .tgl-knob { transform: translateX(13px) !important; }

        /* Wider than the base 170px: the roomier glass chip otherwise cut
           "Glass Tint" down to "Glass ...". */
        ${G} .ct-swatches {
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)) !important;
        }
        ${G} .ct-swatch {
          background: rgba(255, 255, 255, 0.06) !important;
          border: none !important;
          border-radius: 12px !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07) !important;
          padding: 6px 10px !important;
        }

        /* Tint picker. A solid popover like the custom selects, and for the
           same reason: it opens inside a settings group, which is already a
           backdrop-filter, so a blur here would never draw. No blur also
           keeps it clear of the small-element blur artifacts. */
        ${G} .tint-swatch {
          width: 22px !important;
          height: 22px !important;
          border: none !important;
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.28),
            0 1px 3px rgba(0, 0, 0, 0.35) !important;
          transition: transform 0.25s var(--lg-spring), box-shadow 0.2s var(--lg-ease) !important;
        }
        ${G} .tint-swatch:not(:disabled):hover { transform: scale(1.1) !important; }
        ${G} .tint-swatch.is-open {
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.28),
            0 0 0 2px rgba(10, 132, 255, 0.95),
            0 0 0 5px rgba(10, 132, 255, 0.28) !important;
        }
        ${G} .tint-picker {
          width: 244px !important;
          padding: 12px !important;
          gap: 12px !important;
          background:
            radial-gradient(130% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 52%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015)),
            #1e2030 !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          border: none !important;
          border-radius: 18px !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            inset 0 0 0 1px rgba(255, 255, 255, 0.09),
            0 24px 60px -18px rgba(0, 0, 0, 0.65),
            0 2px 6px rgba(0, 0, 0, 0.2) !important;
        }
        ${G} .tint-sv {
          height: 140px !important;
          border-radius: 10px !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.10) !important;
        }
        ${G} .tint-hue {
          height: 14px !important;
          border-radius: 999px !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14) !important;
        }
        ${G} .tint-sv-thumb,
        ${G} .tint-hue-thumb {
          width: 18px !important;
          height: 18px !important;
          border: 3px solid #ffffff !important;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18), 0 3px 8px rgba(0, 0, 0, 0.45) !important;
        }
        ${G} .tint-hue-thumb { width: 20px !important; height: 20px !important; }
        ${G} .tint-sv:focus-visible,
        ${G} .tint-hue:focus-visible {
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.14),
            0 0 0 2px rgba(10, 132, 255, 0.9) !important;
        }
        ${G} .tint-picker .tint-hex {
          height: 30px !important;
          padding: 0 12px !important;
          border-radius: 999px !important;
          font-family: var(--font-mono) !important;
          font-size: 12px !important;
          letter-spacing: 0.5px !important;
        }
        ${G} .tint-preset {
          width: 22px !important;
          height: 22px !important;
          border: none !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22) !important;
          transition: transform 0.25s var(--lg-spring), box-shadow 0.2s var(--lg-ease) !important;
        }
        ${G} .tint-preset:hover { transform: scale(1.12) !important; }
        ${G} .tint-preset.active {
          box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.22),
            0 0 0 2px #1e2030,
            0 0 0 3.5px rgba(255, 255, 255, 0.85) !important;
        }
        /* The same drop and lift as the custom selects. */
        ${G}.animations-enabled .tint-picker:not([hidden]) {
          animation: networkMenuDrop 0.2s var(--lg-ease);
          transform-origin: top left;
        }
        ${G}.animations-enabled .tint-picker.opens-up:not([hidden]) {
          transform-origin: bottom left;
        }
        ${G}.animations-enabled .tint-picker.is-closing {
          animation: networkMenuLift 0.14s ease-in forwards;
        }

        /* ── Rooms and People ─────────────────────────────────────────── */
        ${G} #roomsSidebar > div {
          border-radius: 18px !important;
          padding: 10px !important;
        }
        ${G} .native-search-bar input {
          border-radius: 999px !important;
          padding: 8px 16px !important;
          font-size: 12px !important;
        }
        /* Everything drawn inside the field. The search bars sit in the
           Rooms and People list views, which clip to their own box, so any
           shadow or focus ring outside the input was cut off down both sides. */
        /* Even hairline, for the same reason as --lg-shadow-scroll: an
           offset top highlight on a pill is a flat bar between its ends. */
        ${G} .native-search-bar input {
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12) !important;
        }
        ${G} .native-search-bar input:focus {
          box-shadow:
            inset 0 0 0 1px rgba(10, 132, 255, 0.95),
            inset 0 0 0 3px rgba(10, 132, 255, 0.28) !important;
        }

        /* Scrollbars are not clipped to border-radius, so in these rounded
           scrollers the bar ran square into the corners. The track stops
           short of them; in the People table it also starts below the
           sticky header instead of running over it. */
        ${G} .native-grid-container::-webkit-scrollbar-track,
        ${G} #roomsSidebar > div::-webkit-scrollbar-track,
        ${G} [id$="DetailView"] > .bevel-inset::-webkit-scrollbar-track,
        ${G} #tab-photo-detail > .bevel-inset::-webkit-scrollbar-track,
        ${G} .log-output::-webkit-scrollbar-track {
          margin: 14px 0 !important;
        }
        ${G} .native-table-container::-webkit-scrollbar-track {
          margin: 30px 0 14px !important;
        }
        ${G} .native-grid-container {
          padding: 10px !important;
        }

        ${G} .filter-btn,
        ${G} .sort-btn {
          width: 100% !important;
          text-align: left !important;
          background: transparent !important;
          border: none !important;
          border-radius: 10px !important;
          box-shadow: none !important;
          color: rgba(255, 255, 255, 0.75) !important;
          padding: 6px 10px !important;
          font-family: var(--font-ui) !important;
          font-size: 12px !important;
          font-weight: 500 !important;
          letter-spacing: 0 !important;
          text-transform: none !important;
          transition: background-color 0.2s var(--lg-ease), color 0.2s var(--lg-ease) !important;
        }
        ${G} .filter-btn:hover,
        ${G} .sort-btn:hover {
          background: rgba(255, 255, 255, 0.08) !important;
          color: #ffffff !important;
        }
        ${G} .filter-btn.active,
        ${G} .sort-btn.active {
          background: rgba(255, 255, 255, 0.16) !important;
          box-shadow: var(--lg-control-rim) !important;
          color: #ffffff !important;
          font-weight: 600 !important;
        }

        ${G} .room-card {
          background: rgba(255, 255, 255, 0.06) !important;
          border: none !important;
          border-radius: 16px !important;
          padding: 8px !important;
          box-shadow:
            var(--lg-control-rim),
            0 6px 18px -10px rgba(0, 0, 0, 0.5) !important;
          transition:
            background-color 0.2s var(--lg-ease),
            transform 0.45s var(--lg-spring),
            box-shadow 0.25s var(--lg-ease) !important;
        }
        /* Doubled class: moderndark's animated hover is itself four classes
           deep, one more than this sheet's usual prefix. */
        ${G}.glass-enabled .room-card:hover {
          background: rgba(255, 255, 255, 0.11) !important;
          transform: translateY(-2px) !important;
          box-shadow:
            var(--lg-control-rim),
            0 12px 26px -12px rgba(0, 0, 0, 0.6) !important;
        }
        ${G}.glass-enabled .nav-btn:hover { transform: none !important; }
        ${G} .room-card-image { border-radius: 12px !important; border: none !important; }
        ${G} .room-card-name {
          font-family: var(--font-ui) !important;
          font-size: 13px !important;
          font-weight: 600 !important;
          color: #ffffff !important;
        }
        ${G} .room-card-creator,
        ${G} .room-card-stats { color: var(--text-muted) !important; }

        /* The header row only spans the table, which stops at the scrollbar
           gutter — so it ended short of the container's right edge and left a
           lighter notch over the scrollbar in the top-right corner. The same
           colour is painted as a band across the whole top of the container,
           gutter included, at the header's exact height; both are solid so
           the two meet without a seam. The band is a plain background, which
           stays put while the rows scroll. */
        ${G} .native-table-container.bevel-inset {
          background:
            linear-gradient(#1c1e2c, #1c1e2c) top left / 100% 30px no-repeat,
            var(--lg-fill) !important;
        }
        ${G} .native-table th {
          background: #1c1e2c !important;
          height: 30px !important;
          box-sizing: border-box !important;
          border: none !important;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
          color: var(--text-muted) !important;
          font-family: var(--font-ui) !important;
          font-size: 11px !important;
          font-weight: 600 !important;
        }
        ${G} .native-table td {
          background: transparent !important;
          border: none !important;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
          font-size: 12px !important;
        }
        ${G} .native-table tr:hover td { background: rgba(255, 255, 255, 0.06) !important; }

        /* The room card's lower half — the stats and the Created bar — paints
           its own --bg-panel. On an opaque skin that is the card's colour and
           disappears; under glass --bg-panel is a white wash, so it stacked on
           the card's own fill and laid a lighter band across the bottom with a
           hard edge where the top half ends. The card already has a fill.
           The player card's stats-and-bio half does exactly the same. */
        ${G} .room-card-footer,
        ${G} .profile-body-content {
          background: transparent !important;
        }

        /* Inner wells inside the detail views: tinted, not blurred again. */
        ${G} .bevel-inset,
        ${G} .bevel-outset {
          background: rgba(255, 255, 255, 0.05) !important;
          border: none !important;
          border-radius: 16px !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.10),
            inset 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
        }
        ${G} [id$="DetailView"] > .bevel-inset,
        ${G} #tab-photo-detail > .bevel-inset {
          background: var(--lg-fill) !important;
          border-radius: 22px !important;
        }
        ${G} .native-grid-container.bevel-inset {
          background: var(--lg-fill) !important;
        }

        ${G} .log-output {
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0)),
            rgba(8, 10, 16, 0.45) !important;
          border-radius: 18px !important;
        }

        /* ── Modals and toasts ────────────────────────────────────────── */
        ${G} .modal-overlay {
          /* A dim, not a blur: a full-window blur is the single most
             expensive thing glass could draw, for a moment of decoration. */
          background: rgba(0, 0, 0, 0.45) !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
        }
        ${G} .modal-titlebar,
        ${G} .modal-footer {
          background: transparent !important;
          border: none !important;
        }
        ${G} .modal-titlebar { padding: 14px 16px 4px 20px !important; }
        ${G} .modal-footer { padding: 10px 18px 16px !important; gap: 8px !important; }
        ${G} .modal-title {
          font-family: var(--font-ui) !important;
          font-size: 12px !important;
          font-weight: 600 !important;
          letter-spacing: 0.6px !important;
          color: #ffffff !important;
          text-shadow: none !important;
        }
        ${G} .modal-close-btn {
          width: 24px !important;
          height: 24px !important;
          padding: 0 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          background: rgba(255, 255, 255, 0.12) !important;
          border: none !important;
          border-radius: 50% !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06) !important;
          color: rgba(255, 255, 255, 0.8) !important;
          font-size: 11px !important;
          transition: background-color 0.2s var(--lg-ease) !important;
        }
        ${G} .modal-close-btn:hover { background: rgba(255, 255, 255, 0.22) !important; }

        /* Dialogs spring in and ease out. Only the dimmer fades, and the box
           is a solid popover fill with no blur of its own, so nothing
           frosted is ever faded or scaled (the thing that broke into
           artefacts on the user's GPU). The exit is timed by MODAL_EXIT_MS
           in hideModal(), which adds .is-closing. */
        ${G} .modal-overlay { animation: glassOverlayIn 0.22s var(--lg-ease) !important; }
        ${G} .modal-box { animation: glassModalIn 0.42s var(--lg-spring) !important; }
        ${G} .modal-overlay.is-closing { animation: glassOverlayOut 0.18s ease-in forwards !important; }
        ${G} .modal-overlay.is-closing .modal-box { animation: glassModalOut 0.18s ease-in forwards !important; }
        /* Popups stay on their own compositing layer while open. Otherwise
           the layer an entrance animation creates is dropped when it ends,
           and text drawn at a fractional position (a flex-centred dialog of
           odd height, 125% scaling) is redrawn snapped to the pixel grid —
           a half-pixel jump up as every popup settles. None of these carry
           a blur, so the held layer is the kind proven clean on the user's
           GPU; the frosted toasts are left out. */
        ${G} :is(.modal-box, .network-menu, .manage-menu, .cselect-menu, .tint-picker) {
          will-change: transform;
        }
        @keyframes glassOverlayIn  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes glassOverlayOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes glassModalIn {
          from { opacity: 0; transform: translateY(16px) scale(0.96); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes glassModalOut {
          from { opacity: 1; transform: none; }
          to   { opacity: 0; transform: translateY(8px) scale(0.97); }
        }
        @media (prefers-reduced-motion: reduce) {
          ${G} .modal-overlay,
          ${G} .modal-box,
          ${G} .modal-overlay.is-closing,
          ${G} .modal-overlay.is-closing .modal-box { animation: none !important; }
        }

        /* ── Notifications ──────────────────────────────────────────────
           Frosted glass. Without a blur, whatever sat under a stack (room
           titles, the pagination) read straight through the text.

           The frost is on ::before, behind the label, and its edge is covered
           rather than masked: a blur clipped to a rounded rect stair-steps on
           the GPU, and the masked tiles that avoid that came apart on the
           similarly small PLAY button. So the layer is clipped plainly by
           border-radius, and \`outline\` — which paints above everything in the
           toast and is drawn as a smooth stroke — lies over that clip edge.

           The card never fades: an ancestor below full opacity cuts a
           backdrop-filter off from what is behind it, so a fading toast would
           arrive unfrosted and snap. It slides in from past the window edge
           and back out instead, translate only — no scale, which is what
           resampled the PLAY button's frost. The status light is ::after. */
        ${G} .toast-container {
          bottom: 16px !important;
          right: 16px !important;
          gap: 8px !important;
          align-items: flex-end !important;
        }
        ${G} .toast {
          position: relative !important;
          min-width: 180px !important;
          max-width: 340px !important;
          padding: 11px 18px 11px 36px !important;
          border: none !important;
          border-radius: 18px !important;
          isolation: isolate !important;
          background: transparent !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          outline: 1.5px solid rgba(255, 255, 255, 0.26) !important;
          outline-offset: -1.5px !important;
          color: #ffffff !important;
          font-family: var(--font-ui) !important;
          font-size: 12.5px !important;
          font-weight: 600 !important;
          line-height: 1.35 !important;
          letter-spacing: 0 !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45) !important;
          box-shadow:
            0 14px 34px -12px rgba(0, 0, 0, 0.55),
            0 2px 6px rgba(0, 0, 0, 0.18) !important;
          /* Leaving: slide back out past the edge, inside toast()'s 300ms. */
          opacity: 1 !important;
          transform: translateX(calc(100% + 32px)) !important;
          transition: transform 0.26s cubic-bezier(0.5, 0, 0.75, 0) !important;
        }
        /* Arriving: spring in from the right. */
        ${G} .toast.show {
          opacity: 1 !important;
          transform: none !important;
          transition: transform 0.55s var(--lg-spring) !important;
        }
        /* The frosted body. The top highlight and lower glow are gradients in
           its own fill, since an inset shadow on the toast would paint under
           this layer. */
        ${G} .toast::before {
          content: '' !important;
          display: block !important;
          position: absolute !important;
          inset: 0 !important;
          z-index: -1 !important;
          border-radius: inherit !important;
          pointer-events: none !important;
          box-shadow: none !important;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0.04) 50%, rgba(255, 255, 255, 0.10) 100%),
            rgba(20, 22, 34, 0.38) !important;
          backdrop-filter: blur(18px) saturate(180%) !important;
          -webkit-backdrop-filter: blur(18px) saturate(180%) !important;
        }
        ${G} .toast::after {
          content: '' !important;
          position: absolute !important;
          left: 16px !important;
          top: 50% !important;
          width: 8px !important;
          height: 8px !important;
          margin-top: -4px !important;
          border-radius: 50% !important;
          background: #0a84ff !important;
          box-shadow: 0 0 10px rgba(10, 132, 255, 0.9) !important;
          pointer-events: none !important;
        }
        ${G} .toast.ok::after {
          background: #30d158 !important;
          box-shadow: 0 0 10px rgba(48, 209, 88, 0.9) !important;
        }
        ${G} .toast.error::after {
          background: #ff453a !important;
          box-shadow: 0 0 10px rgba(255, 69, 58, 0.9) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          /* No slide: shown in place, gone in place. */
          ${G} .toast { transform: none !important; visibility: hidden !important; transition: none !important; }
          ${G} .toast.show { visibility: visible !important; }
        }
        /* ── Frosted surfaces ───────────────────────────────────────────
           The frost lives on an ::after behind the content, and its rounded
           corners come from the mask, not from border-radius. When Chromium
           draws on the GPU — as the app's window does — it clips a
           backdrop-filter to a rounded rect without anti-aliasing, so a
           radius-clipped blur ended every corner in a staircase. Here the
           blur layer is a plain rectangle, cut round by radial gradients with
           a 1px soft edge, which every renderer draws smooth. The soft edge is
           centred on the outline rather than just inside it: inside, it halved
           the outermost pixel round each corner, which is where a 1px edge
           line sits, so the line showed full strength along the straight
           edges and faded on the curves — a flat white bar across the top. --lg-r is the
           radius each mask is cut to, matching the surface's border-radius.
           \`isolation\` gives the layer a stacking context to sit behind the
           content in, without the z-index that would override .cselect-host
           lifting a group over its neighbours. */
        ${G} .sidebar { --lg-r: 24px; }
        ${G} .qs-card { --lg-r: 20px; }
        ${G} .settings-group,
        ${G} .download-section { --lg-r: 22px; }
        ${G} .sidebar,
        ${G} .qs-card,
        ${G} .settings-group,
        ${G} .download-section {
          background: transparent !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          isolation: isolate !important;
        }
        /* The progress panel clips its content by default, and a rounded clip
           around the frost layer would bring the staircase straight back. */
        ${G} .download-section { overflow: visible !important; }
        ${G} .sidebar::after,
        ${G} .qs-card::after,
        ${G} .settings-group::after,
        ${G} .download-section::after {
          content: '' !important;
          display: block !important;
          position: absolute !important;
          inset: 0 !important;
          border-radius: 0 !important;
          z-index: -1 !important;
          pointer-events: none !important;
          background: var(--lg-frost-fill) !important;
          backdrop-filter: var(--lg-blur) !important;
          -webkit-backdrop-filter: var(--lg-blur) !important;
          -webkit-mask:
            radial-gradient(circle at 100% 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top right / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 100% 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom right / var(--lg-r) var(--lg-r) no-repeat,
            linear-gradient(#000 0 0) center / calc(100% - 2 * var(--lg-r) + 2px) 100% no-repeat,
            linear-gradient(#000 0 0) center / 100% calc(100% - 2 * var(--lg-r) + 2px) no-repeat !important;
          mask:
            radial-gradient(circle at 100% 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top right / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 100% 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom right / var(--lg-r) var(--lg-r) no-repeat,
            linear-gradient(#000 0 0) center / calc(100% - 2 * var(--lg-r) + 2px) 100% no-repeat,
            linear-gradient(#000 0 0) center / 100% calc(100% - 2 * var(--lg-r) + 2px) no-repeat !important;
        }

${fullEffects ? `
        /* ── Full glass effects ─────────────────────────────────────────
           On by default; switched off from Settings → Liquid Glass. Stronger
           frost on the framing surfaces, the content wells frosted as well,
           and a blur behind popups. Switching it off is for older integrated
           GPUs, which feel every extra blur being redone whenever anything
           near it repaints.

           The wells scroll, so they cannot carry the frost on an ::after the
           way the framing surfaces do; they take the corner-shaped mask on
           themselves instead, which keeps their corners anti-aliased and
           costs only the outer part of their shadow. The search bars, the
           play-mode track and the gear stay tinted: their radius follows
           their height, which a fixed corner mask cannot. */
        ${G} { --lg-blur: blur(24px) saturate(185%); }
        ${G} .native-grid-container,
        ${G} .native-table-container,
        ${G} [id$="DetailView"] > .bevel-inset,
        ${G} #tab-photo-detail > .bevel-inset { --lg-r: 22px; }
        ${G} #roomsSidebar > div,
        ${G} .log-output { --lg-r: 18px; }
        ${G} .native-grid-container,
        ${G} .native-table-container,
        ${G} #roomsSidebar > div,
        ${G} [id$="DetailView"] > .bevel-inset,
        ${G} #tab-photo-detail > .bevel-inset,
        ${G} .log-output {
          /* The lighter tint the frosted surfaces use: with a blur behind
             them, the wells no longer need the extra body. */
          --lg-fill: var(--lg-frost-fill);
          backdrop-filter: var(--lg-blur) !important;
          -webkit-backdrop-filter: var(--lg-blur) !important;
          -webkit-mask:
            radial-gradient(circle at 100% 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top right / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 100% 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom right / var(--lg-r) var(--lg-r) no-repeat,
            linear-gradient(#000 0 0) center / calc(100% - 2 * var(--lg-r) + 2px) 100% no-repeat,
            linear-gradient(#000 0 0) center / 100% calc(100% - 2 * var(--lg-r) + 2px) no-repeat !important;
          mask:
            radial-gradient(circle at 100% 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 100%, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) top right / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 100% 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom left / var(--lg-r) var(--lg-r) no-repeat,
            radial-gradient(circle at 0 0, #000 calc(var(--lg-r) - 0.5px), transparent calc(var(--lg-r) + 0.5px)) bottom right / var(--lg-r) var(--lg-r) no-repeat,
            linear-gradient(#000 0 0) center / calc(100% - 2 * var(--lg-r) + 2px) 100% no-repeat,
            linear-gradient(#000 0 0) center / 100% calc(100% - 2 * var(--lg-r) + 2px) no-repeat !important;
        }
        /* Full-window and square, so no corner to alias. */
        ${G} .modal-overlay {
          background: rgba(0, 0, 0, 0.3) !important;
          backdrop-filter: blur(6px) !important;
          -webkit-backdrop-filter: blur(6px) !important;
        }
` : ''}
      `;
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
  document.body.className = document.body.className
    .split(' ')
    .filter(c => c && !c.startsWith('theme-') && c !== GLASS_CLASS)
    .join(' ');

  document.getElementById(GLASS_STYLE_ID)?.remove();
  // A tint picker drag previews through this inline property; the sheet built
  // below carries the same colour, so the override is no longer needed.
  document.body.style.removeProperty('--lg-tint');
  // The pre-paint cache boot.js injects. Dropped here so the real stylesheet
  // replaces it rather than stacking on top of it.
  document.getElementById(GLASS_BOOT_STYLE_ID)?.remove();

  const skin = AVAILABLE_THEMES.includes(theme) ? theme : DEFAULT_THEME;
  const glass = config.glass || {};
  const glassOn = glass.enabled === true;

  if (glassOn) {
    document.body.classList.add('theme-' + GLASS_LAYOUT_THEME, GLASS_CLASS);
  } else {
    document.body.classList.add(skinClass(skin));
  }

  if (glassOn) {
    const css = glassCss(glass.tint, glass.bgImage, glass.fullEffects !== false);
    const style = document.createElement('style');
    style.id = GLASS_STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
    cacheThemeForBoot(skin, css);
  } else {
    cacheThemeForBoot(skin, '');
  }

  // Animations are always on; the setting that could turn them off is gone.
  // The class still gates them in the stylesheet, so it is set here — the
  // className rewrite above keeps it, but boot.js may not have run first.
  document.body.classList.add('animations-enabled');
  try {
    // A leftover 'false' from the old setting would otherwise sit in storage.
    localStorage.removeItem('radium-animations');
  } catch (e) {}
}

/// Remember enough for boot.js to paint the right thing before the first frame.
///
/// Without this the window renders the base stylesheet until the config arrives
/// over IPC and then snaps to the real skin — a visible flash on every start.
/// Glass is the expensive case, so its generated sheet is cached verbatim.
function cacheThemeForBoot(skin, css) {
  try {
    localStorage.setItem('radium-theme', skin);
    localStorage.setItem('radium-glass-css', css);
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
// frame, and each frame only sets `--lg-tint` on <body> (see glassCss()). The
// sheet is rebuilt once, after the picker closes, so the boot cache gets the
// final colour.

/// Dark tints that suit the glass field: the default, then a spread of hues.
const TINT_PRESETS = ['#0b0c14', '#1b1036', '#0a1d3f', '#06302e', '#0d2a16', '#3b0f22', '#3a2208', '#2a2b31'];

/// Hue is kept separately from the hex so dragging to grey or black and back
/// does not snap the hue slider to red.
const tintState = { h: 0, s: 0, v: 0, dirty: false };

const clamp01 = (n) => Math.min(1, Math.max(0, n));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
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

  // After the exit animation, so the one full stylesheet rebuild does not land
  // on top of it. Skipped if the picker was reopened in the meantime.
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
/// saveConfig in the shim). `persistDelay` lets the URL field wait for typing
/// to stop instead of writing config.json on every keystroke.
let _backdropSaveTimer = null;
function setGlassBackdrop(value, persistDelay = 0) {
  config.glass = { ...(config.glass || {}), bgImage: value };
  applyTheme(config.theme);
  clearTimeout(_backdropSaveTimer);
  _backdropSaveTimer = setTimeout(async () => {
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

$('theme-bgImage')?.addEventListener('input', (e) => {
  if (e.target.value !== '(Local File Selected)') {
    delete e.target.dataset.localBase64;
  }
  setGlassBackdrop(getBgImageUI(), 600);
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

async function checkInstall() {
  let result = null;
  try {
    result = await window.radium?.checkInstall();
  } catch (e) {
    console.error('checkInstall error:', e);
  }
  isInstalled = result?.installed ?? false;
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
    addLog(`Found a client in the wrong network's folder. Moved it aside to ${result.orphanedClientDir} — you can delete that folder.`, 'warn');
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
    addLog(`Game client found (${verLabel}, build ${buildLabel}): ${result.exePath || 'client dir'}`, 'ok');

    // Check if the game is already running on startup. Only log the transition:
    // checkInstall() re-runs on every settings autosave, so logging every time
    // filled the log with one line per 800ms while the game was open.
    if (result?.isRunning) {
      const wasRunning = isGameRunning;
      setGameRunning(true);
      if (!wasRunning) addLog('Game is already running.', 'ok');
    }

    // An outdated client (left over from a previous launcher version) must be
    // re-downloaded to match the new Radium build.
    if (result?.clientOutdated && !result?.isRunning) {
      addLog(`Installed client is outdated — build '${result?.clientBuild || 'unrecorded'}' ≠ required '${result?.requiredBuild || 'unknown'}'. Update required.`, 'warn');
      showModal($('clientUpdateModal'));
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
    if (!clientDownloadAvailable()) {
      if (qi) qi.textContent = 'NOT RELEASED';
      addLog(`${networkInfo().label} has not published a client yet.`, 'info');
    } else {
      addLog('Game client not found — download required.', 'info');
    }
  }

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

// In-app client download downloader state
// Sync the Download / Pause button labels to the current state.
function updateDlButtons() {
  const dlBtn = $('btnDownload');
  const pauseBtn = $('btnPauseDl');
  if (dlBtn) {
    dlBtn.disabled = isDownloading || isPaused || isCancelling;
    dlBtn.textContent = isCancelling  ? '⬇ CANCELLING...'
                      : isDownloading ? '⬇ DOWNLOADING...'
                      : isPaused      ? '⬇ PAUSED'
                      :                 '⬇ DOWNLOAD';
  }
  if (pauseBtn) pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
}

// `opts.resuming` keeps the current bar position instead of snapping back to 0%,
// so continuing a paused/interrupted download doesn't visibly flash to zero.
function setDownloadUI(downloading, opts = {}) {
  isDownloading = downloading;
  if (downloading) { isPaused = false; isCancelling = false; extractEta = null; }
  const block = $('dlProgressBlock');
  const pauseBtn = $('btnPauseDl');
  if (downloading) {
    if (block) block.style.display = 'block';
    if (pauseBtn) pauseBtn.style.display = '';
    setStatLabels('Speed', 'Transferred', 'ETA');
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

// A snapped width is in pixels, so it goes stale when the window resizes or a
// theme swaps the bar between segmented and solid. Re-apply on both.
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => {
    const fill = $('dlBarFill');
    if (fill && !fill.classList.contains('indeterminate') && fill.dataset.pct != null) {
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

function updateDlProgress({ phase, pct = 0, downloaded = 0, total = 0, speed = 0, eta = -1, status, entry = '', done = 0, totalEntries = 0 }) {
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
  const pauseBtn = $('btnPauseDl'); if (pauseBtn) pauseBtn.style.display = '';
  if (speedEl)  speedEl.textContent  = speed > 0 ? `${formatBytes(speed)}/s` : '—';
  if (sizeEl)   sizeEl.textContent   = total > 0
    ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
    : formatBytes(downloaded);
  if (etaEl)    etaEl.textContent    = eta >= 0 ? `ETA ${formatEta(eta)}` : '—';
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
    addLog('Resuming download...', 'info');
    toast('Resuming download...', 'info', 2500);
  } else {
    addLog(activeNetwork === 'radium'
      ? 'Starting download from recroom.baby (downloads page)...'
      : 'Starting download from the configured Vanilla client URL...', 'info');
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
    addLog(`Download & extraction complete in ${elapsed}s.`, 'ok');
    addLog(`Exe: ${result.exePath || 'Found in client dir'}`, 'ok');
    toast(`${networkInfo().label} client installed!`, 'ok', 4000);
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
      addLog(`Download paused at ${elapsed}s. Click Resume to continue.`, 'info');
      return; // don't run checkInstall — the download isn't finished or gone
    }
    setDownloadUI(false);
    if (err === 'Cancelled') {
      // User-initiated cancel — the cancel handler already logged/toasted it,
      // so don't also report it as a failure.
      addLog(`Download stopped after ${elapsed}s (cancelled by user).`, 'info');
    } else {
      addLog(`Download failed after ${elapsed}s: ${err}`, 'error');
      toast(`Failed: ${err}`, 'error', 5000);
    }
    // Restore the correct panel (e.g. back to the launch panel if still installed).
    await checkInstall();
  }
}

$('btnDownload')?.addEventListener('click', () => {
  // Nothing to install on this network yet — send the user to the source
  // instead of starting a download that would immediately fail.
  if (!clientDownloadAvailable()) {
    const info = networkInfo();
    addLog(`Opening ${info.downloadPage} — no ${info.label} client to install yet.`, 'info');
    window.radium?.openUrl(info.downloadPage);
    return;
  }
  runClientDownload();
});

// On startup, offer to continue a download that was interrupted last session
// (paused, or the launcher was closed mid-download). The partial file + resume
// metadata persist on disk, so the backend can pick up exactly where it left off.
async function offerResumeIfAny() {
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
  addLog(`Found an interrupted download${pctTxt}. Click Resume to continue.`, 'info');
  toast('Resume your interrupted download', 'info', 4500);
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
      if (manual) { addLog(`Client update check failed: ${reason}`, 'error'); toast(`Update check failed: ${reason}`, 'error', 4000); }
      setClientUpdateButton('check');
      return;
    }
    if (!info.hasUpdate) {
      const curLabel = info.versionKnown ? `v${info.installedVersion}` : 'unknown version';
      if (manual) { addLog(`Client is up to date (${curLabel}, latest v${info.latestVersion || '—'}).`, 'ok'); toast('Client is up to date.', 'ok', 3000); }
      setClientUpdateButton('check');
      return;
    }
    const fromLabel = info.versionKnown ? `v${info.installedVersion}` : 'unknown version';
    const changeNote = info.sameVersionRebuilt ? ' (same version, new build detected)' : '';
    addLog(`Client update available: ${fromLabel} → v${info.latestVersion}${changeNote}`, 'warn');
    toast('Client update available!', 'ok', 4000);
    showClientVersionUpdateModal(info);
  } catch (e) {
    console.error('checkClientUpdate error:', e);
    if (manual) toast('Update check failed.', 'error', 3000);
    setClientUpdateButton('check');
  }
}

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
  addLog('Download cancelled.', 'info');
  toast('Download cancelled.', 'info');
  // A cancelled *active* download's checkInstall() runs when its promise
  // rejects; a cancelled *paused* download has no pending promise, so restore
  // the view here.
  if (wasPaused) checkInstall();
});

// Pause / Resume toggle.
$('btnPauseDl')?.addEventListener('click', () => {
  if (isPaused) {
    // Resume — re-invoke the download, which continues from the .part file
    // (whether it was paused this session or left over from a previous run).
    runClientDownload({ resuming: true });
  } else if (isDownloading) {
    // Pause — the backend stops the loop and keeps the partial file. The UI
    // flips to the paused state when the 'paused' event / Paused result lands;
    // update the label now so the click feels responsive.
    window.radium?.pauseDownload();
    addLog('Pausing download...', 'info');
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
  addLog('Reinstall initiated.', 'info');
  toast('Starting reinstall...', 'info');
  $('btnDownload')?.click();
});

// Stop Game logic with Modal
const stopGameModal = $('stopGameModal');
const closeStopGameModal = () => hideModal(stopGameModal);
$('stopGameCancelBtn')?.addEventListener('click', closeStopGameModal);
$('stopGameModalClose')?.addEventListener('click', closeStopGameModal);
$('stopGameConfirmBtn')?.addEventListener('click', async () => {
  closeStopGameModal();
  addLog('User confirmed stop game request. Killing game process...', 'info');
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
  addLog('Uninstalling client...', 'info');
  toast('Uninstalling...', 'info');

  const result = await window.radium?.uninstallClient();
  if (result?.success) {
    addLog('Client uninstalled successfully.', 'ok');
    toast(`${networkInfo().label} client uninstalled.`, 'ok');
    await loadConfig();
    await checkInstall();
  } else {
    const err = result?.error || 'Unknown error';
    addLog(`Uninstall failed: ${err}`, 'error');
    toast(`Uninstall failed: ${err}`, 'error');
  }
});

// Open client folder button
$('btnOpenFolder')?.addEventListener('click', async () => {
  addLog('Opening client folder...', 'info');
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
    addLog(`Opening ${label} client folder from settings...`, 'info');
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
    addLog(`Selecting ${label} install directory...`, 'info');
    const newDir = await window.radium?.selectFolder(network);
    if (!newDir) {
      addLog(`${label} install directory selection cancelled.`, 'info');
      return;
    }
    // The backend refuses to let both networks resolve to one folder — they
    // install different games from different sources, so a shared folder means
    // each download overwrites the other's client. It silently clears the
    // colliding entry on the next config read, so catch it here instead and
    // leave the user's existing setting alone.
    const other = otherNetworkInstallDir(network);
    if (other && normDir(other) === normDir(newDir)) {
      const otherLabel = networkInfo(network === 'vanilla' ? 'radium' : 'vanilla').label;
      toast(`That folder is already ${otherLabel}'s install location. Pick a different one.`, 'error', 4000);
      addLog(`Rejected ${label} install directory: ${newDir} is already ${otherLabel}'s.`, 'warn');
      return;
    }

    const span = installDirSpan(network);
    if (!span) return;
    span.textContent = newDir;
    setConfigInstallDir(newDir, network);
    const ok = await window.radium?.saveConfig(config);
    if (ok) {
      toast(`${label} install location updated and saved!`, 'ok');
      addLog(`Selected and saved ${label} install directory: ${newDir}`, 'info');
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
    addLog(`Resetting ${label} install directory...`, 'info');
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
      addLog(`Reset and saved ${label} install directory: ${defaultDir}`, 'info');
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
  addLog('Requesting Windows Defender exclusion for client folder...', 'info');
  toast('Please approve the Administrator prompt...', 'info');
  const result = await window.radium?.addDefenderExclusion();
  if (result && result.success) {
    config.defenderExcluded = true;
    await window.radium?.saveConfig(config);
    setExcludeAvLabel(true);
    toast('Defender exclusion added!', 'ok');
    addLog('Exclusion successfully added to Windows Defender.', 'ok');
    
    // Check if we need to proceed to Smart App Control and Steam check and launch
    if (launchAfterExclusion) {
      launchAfterExclusion = false;
      await proceedAfterAvCheck();
    }
  } else {
    const err = result?.error || 'UAC elevation cancelled or failed';
    toast('Failed to add exclusion.', 'error');
    addLog(`Exclusion failed: ${err}`, 'error');
    launchAfterExclusion = false;
    isGameLaunching = false;
  }
}

$('btnExcludeAvConfirm')?.addEventListener('click', () => {
  // Set display directly to avoid resetting launchAfterExclusion inside hideExcludeAvModal
  hideModal($('excludeAvModal'));
  executeExcludeAv();
});

// Third-Party AV Warning Modal Actions
function showThirdPartyAvModal(thirdPartyAvs) {
  const m = $('thirdPartyAvModal');
  if (!m) return;

  const avNames = $('detectedAvNames');
  if (avNames) {
    // Dedup names defensively (the backend already dedups).
    avNames.textContent = [...new Set(thirdPartyAvs.map(av => av.name))].join(', ');
  }

  const clientPathCode = $('tpClientFolderPath');
  if (clientPathCode) {
    clientPathCode.textContent = shownInstallDir();
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
  const clientPath = shownInstallDir();
  if (clientPath) {
    try {
      await navigator.clipboard.writeText(clientPath);
      toast('Client folder path copied!', 'ok');
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
    : 'Third-party AV warning dismissed.', 'info');

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

  const isCurrentlyExcluded = config.defenderExcluded === true;

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
      config.defenderExcluded = false;
      await window.radium?.saveConfig(config);
      setExcludeAvLabel(false);
      toast('AV acknowledgement cleared.', 'ok');
      addLog('Third-party AV acknowledgement cleared (no Defender exclusion to remove).', 'info');
      return;
    }

    addLog('Requesting Windows Defender exclusion removal for client folder...', 'info');
    toast('Please approve the Administrator prompt...', 'info');
    const result = await window.radium?.removeDefenderExclusion();
    if (result && result.success) {
      config.defenderExcluded = false;
      await window.radium?.saveConfig(config);
      setExcludeAvLabel(false);
      toast('Defender exclusion removed!', 'ok');
      addLog('Exclusion successfully removed from Windows Defender.', 'ok');
    } else {
      const err = result?.error || 'UAC elevation cancelled or failed';
      toast('Failed to remove exclusion.', 'error');
      addLog(`Exclusion removal failed: ${err}`, 'error');
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
    addLog(`Play mode set to ${playMode}.`, 'info');
  });
});

// Periodically ping server and update status labels
async function checkServerStatus(silent = false) {
  // Radium's API host is user-configurable; Vanilla's is fixed. The CDN check
  // is Radium's download host, so it is only meaningful there.
  const isRadium = activeNetwork === 'radium';
  const apiUrl = isRadium
    ? (config.apiUrl || 'https://api.radie.app/')
    : 'https://api.vanillarec.net';
  const cdnUrl = 'https://cdn.recroomarchive.org';

  // Immediately show CHECKING... in quick stats while pings are in-flight
  const qsS = $('qsStatus');
  if (qsS) qsS.textContent = 'CHECKING...';

  if (!silent) addLog('Checking server status...', 'info');

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
    addLog(`API Gateway (${apiUrl}): ${apiOnline ? 'ONLINE' : 'OFFLINE'}`, apiOnline ? 'ok' : 'warn');
    if (isRadium) {
      addLog(`CDN Server (${cdnUrl}): ${cdnOnline ? 'ONLINE' : 'OFFLINE'}`, cdnOnline ? 'ok' : 'warn');
    }
  }
}

// Periodically fetch player count and update stats card
async function updatePlayerCount(silent = false) {
  const qsPlayers = $('qsPlayers');
  const qscPlayers = $('qsc-players');
  if (!qsPlayers) return;
  if (!silent) {
    qsPlayers.textContent = 'LOADING...';
    addLog('Fetching online player count...', 'info');
  }

  try {
    const result = await window.radium?.getPlayerCount();
    if (result && result.success) {
      qsPlayers.textContent = result.count;
      if (qscPlayers) {
        qscPlayers.classList.add('online');
        qscPlayers.classList.remove('offline');
      }
      if (!silent) addLog(`Players online: ${result.count}`, 'ok');
    } else {
      qsPlayers.textContent = 'OFFLINE';
      if (qscPlayers) {
        qscPlayers.classList.add('offline');
        qscPlayers.classList.remove('online');
      }
      if (!silent) addLog(`Failed to fetch player count: ${result?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    qsPlayers.textContent = 'OFFLINE';
    if (qscPlayers) {
      qscPlayers.classList.add('offline');
      qscPlayers.classList.remove('online');
    }
    if (!silent) addLog(`Failed to fetch player count: ${err.message}`, 'error');
  }
}

// Game execution and process monitoring
function setGameRunning(running) {
  isGameRunning = running;
  if (running) {
    isGameLaunching = false;
  }
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
  if (config.disableWarnings !== true) {
    let installed = true;
    try {
      installed = await window.radium?.checkRequiredSteamApp();
    } catch (e) { /* on error, don't block launch */ }
    if (installed === false) {
      addLog('Required Rec Room Steam app (steam://install/92) is not installed. Prompting user...', 'info');
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
  addLog('Opening Steam to install the required app...', 'info');
  toast('Opening Steam to install…', 'info', 3000);
  window.radium?.openUrl('steam://install/92');
  hideSteamAppModal(true);
});
$('steamAppAnywayBtn')?.addEventListener('click', () => {
  hideSteamAppModal(false);
  doLaunch();
});

async function doLaunch() {
  setGameRunning(true);
  addLog('Launching game...', 'info');
  toast(`Launching ${networkInfo().label}...`, 'info', 2000);

  let result = null;
  try {
    // Only what launch_game reads (the shim adds `network`). Spreading the
    // whole config also sent the glass backdrop — up to 1.4 MB — on every PLAY.
    result = await window.radium?.launchGame({
      playMode,
      gameExePath: config.gameExePath || '',
      minimizeOnLaunch: config.minimizeOnLaunch === true,
      closeOnLaunch: config.closeOnLaunch === true,
    });
  } catch (e) {
    console.error('launchGame error:', e);
    result = { success: false, error: e.toString() };
  }

  isGameLaunching = false;
  if (!result?.success) {
    setGameRunning(false);
    const err = result?.error || 'Unknown error';
    addLog(`Launch failed: ${err}`, 'error');
    toast(`Launch failed: ${err}`, 'error', 5000);
  } else {
    // .bat launches report no PID (the cmd.exe wrapper's PID is meaningless).
    const pidPart = (result.pid !== null && result.pid !== undefined) ? ` (PID ${result.pid})` : '';
    addLog(`Game running${pidPart} — mode: ${playMode}`, 'ok');
    toast(`${networkInfo().label} launched in ${playMode.toUpperCase()} mode!`, 'ok');
    if (config.closeOnLaunch === true) {
      addLog(config.runInBackground !== false
        ? 'Launcher set to step aside on game start. Hiding to the tray...'
        : 'Launcher configured to exit on game start. Exiting...', 'info');
      setTimeout(() => {
        window.radium?.close();
      }, 1000);
    }
  }
}

$('steamAnywayBtn')?.addEventListener('click', () => {
  hideSteamModal(false);
  executeLaunch();
});

$('steamLaunchBtn')?.addEventListener('click', async () => {
  hideSteamModal(false);
  addLog('Launching Steam...', 'info');
  toast('Launching Steam...', 'info', 2000);
  window.radium?.openUrl('steam://');
  
  // Wait 3 seconds to let Steam start initializing before starting the game
  addLog('Waiting for Steam to start (3s)...', 'info');
  setTimeout(() => {
    executeLaunch();
  }, 3000);
});

async function checkSteamAndLaunch() {
  addLog('Checking if Steam is running...', 'info');
  const steamRunning = await window.radium?.checkSteam();

  if (steamRunning) {
    addLog('Steam is running.', 'ok');
    executeLaunch();
  } else {
    if (config.disableWarnings === true) {
      addLog('Steam is not running. Warning skipped (disabled by user).', 'info');
      executeLaunch();
    } else {
      addLog('Steam is not running. Prompting user...', 'info');
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
    addLog('AV exclusion check skipped (disabled by user).', 'info');
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
      addLog('Third-party AV present; launch warning suppressed by user.', 'info');
      await proceedAfterAvCheck();
      return;
    }
    addLog('Third-party antivirus detected. Prompting user...', 'info');
    launchAfterExclusion = true;
    showThirdPartyAvModal(thirdPartyAvs);
    return;
  }

  // Windows Defender path — this one CAN be auto-excluded.
  if (config.defenderExcluded === true) {
    await proceedAfterAvCheck();
    return;
  }
  if (avs.some(av => av.isDefender)) {
    addLog('Windows Defender active and folder not excluded. Prompting user...', 'info');
    launchAfterExclusion = true;
    showExcludeAvModal();
    return;
  }

  // No antivirus detected — nothing to exclude.
  addLog('No antivirus requiring exclusion detected.', 'ok');
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
  isGameLaunching = true;

  // Full pre-launch safety chain: AV exclusion → Smart App Control → Steam →
  // launch.
  await checkAvAndLaunch();
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
  addLog('Checking Smart App Control status...', 'info');
  const sac = await window.radium?.checkSmartAppControl();
  if (sac && sac.enabled && !sacWarnedThisSession) {
    if (config.disableWarnings === true) {
      addLog('Smart App Control is active. Warning skipped (disabled by user).', 'info');
      await checkSteamAndLaunch();
    } else {
      addLog('Smart App Control is active. Prompting user...', 'info');
      showSacModal();
    }
  } else {
    if (sac && sac.enabled) {
      addLog('Smart App Control is active (previously acknowledged this session).', 'info');
    } else {
      addLog('Smart App Control is not active.', 'ok');
    }
    await checkSteamAndLaunch();
  }
}


window.radium?.onGameState((data) => {
  if (data.running === false) {
    setGameRunning(false);
    const code = data.exitCode !== undefined ? ` (exit ${data.exitCode})` : '';
    addLog(`Game closed${code}`, 'info');
    toast('Game closed.', 'info', 2000);
  } else if (data.running === true) {
    setGameRunning(true);
  }
  if (data.error) {
    addLog(`Error: ${data.error}`, 'error');
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
  addLog(`Downloading update ${updateInfo.latestVersion}...`, 'info');

  // Desktop shortcut placement is always on now — the opt-out checkbox was removed.
  const result = await window.radium?.downloadUpdate(
    updateInfo.downloadUrl,
    true,
    updateInfo.downloadDigest
  );
  if (result?.success) {
    if (status) status.textContent = 'Update downloaded! Launching installer...';
    addLog('Launcher update started — restarting.', 'ok');
    // App will quit shortly from main process
  } else {
    const err = result?.error || 'Unknown error';
    if (status) { status.textContent = `Error: ${err}`; status.style.color = '#ff6666'; }
    if (nowBtn) { nowBtn.disabled = false; nowBtn.textContent = '⬇ Update Now'; }
    addLog(`Update failed: ${err}`, 'error');
    toast(`Update failed: ${err}`, 'error', 5000);
  }
});
async function checkForLauncherUpdate() {
  // Only check if autoUpdate is enabled in settings
  if (config.autoUpdate === false) return;
  addLog('Checking for launcher updates...', 'info');
  try {
    const info = await window.radium?.checkForUpdate();
    if (!info) return;
    if (info.error) {
      addLog(`Update check failed: ${info.error}`, 'info');
      return;
    }
    if (info.hasUpdate) {
      addLog(`New version available: ${info.latestVersion} (current: v${info.currentVersion})`, 'ok');
      toast('Update available!', 'ok', 5000);
      showUpdateModal(info);
    } else {
      addLog(`Launcher is up to date (v${info.currentVersion}).`, 'info');
    }
  } catch (e) {
    addLog(`Update check error: ${e.message}`, 'info');
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
  addLog('Manual launcher update check initiated.', 'info');
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
      addLog(`Update check failed: ${info.error}`, 'info');
      toast('Update check failed.', 'error');
      return;
    }
    if (info.hasUpdate) {
      if (resultEl) {
        resultEl.textContent = '✓ Update available!';
        resultEl.className = 'test-result ok';
      }
      addLog(`New version available: ${info.latestVersion} (current: v${info.currentVersion})`, 'ok');
      toast('Update available!', 'ok', 5000);
      showUpdateModal(info);
    } else {
      if (resultEl) {
        resultEl.textContent = '✓ Up to date';
        resultEl.className = 'test-result ok';
      }
      addLog(`Launcher is up to date (v${info.currentVersion}).`, 'info');
      toast('Launcher is up to date.', 'ok');
    }
  } catch (e) {
    if (resultEl) {
      resultEl.textContent = '✕ Error';
      resultEl.className = 'test-result error';
    }
    addLog(`Update check error: ${e.message}`, 'info');
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

  document.body.classList.toggle('network-vanilla', activeNetwork === 'vanilla');
  document.body.classList.toggle('network-radium', activeNetwork === 'radium');
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

  updateDownloadCta();
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
    toast('Finish or cancel the current download before switching networks.', 'warn', 4000);
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
  if (openTab === 'tab-rooms') {
    loadFilters();
    loadRooms();
  } else if (openTab === 'tab-people') {
    loadPeople();
  } else if (openTab === 'tab-feed') {
    // FEED only exists on networks that publish one; leaving the user parked
    // on a tab whose nav button just disappeared would strand them.
    if (networkInfo().hasPhotoFeed) loadFeed(false, { refresh: true });
    else switchTab('home');
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
/// the exit durations in skins/04-modern.css and glassCss().
const MODAL_EXIT_MS = 180;

/// Per-dialog counter, bumped by every show and hide, so a close still waiting
/// out its animation can tell it has been superseded by a reopen.
const modalCloseTokens = new WeakMap();

/// Show a dialog, cancelling any close still in flight.
function showModal(modal) {
  if (!modal) return;
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

/// Fit a long name into the account button: first a smaller face on one line
/// (down to 12px), then two lines, then 11px on two lines, and only after
/// that an ellipsis. Re-run whenever the name, the skin or the sidebar's width
/// changes, since each skin sets its own face and size.
function fitAccountName() {
  const name = $('vanillaAccountName');
  if (!name) return;
  name.style.fontSize = '';
  name.classList.remove('two-lines');
  if (!vanillaPlayer || !name.clientWidth) return;

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
  const nameEl = document.getElementById('vanillaAccountName');
  if (nameEl) new ResizeObserver(() => fitAccountName()).observe(nameEl);
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
    vanillaNotifs = [];
    setVanillaBadge();
    closeAccountMenu();
    closeNotifPanel();
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

function applyVanillaAuth(state) {
  const was = vanillaPlayer;
  vanillaPlayer = state && state.authenticated && state.player ? state.player : null;
  renderVanillaAccount();

  // Cheer and subscribe buttons on whatever is open reflect the new account.
  if (was?.id !== vanillaPlayer?.id) {
    cheeredPhotoIds = null;
    announcedNotifIds = null;
    refreshSocialButtons();
  }

  if (vanillaPlayer) {
    if (!was) addLog(`Signed in to Vanilla as @${vanillaPlayer.userName}`, 'ok');
    refreshVanillaExtras();
    return;
  }
  if (state && state.error && !state.hasSession) {
    toast(`Vanilla sign-in failed: ${state.error}`, 'error');
  }
  if (was) {
    const expired = state && state.reason === 'expired';
    addLog(expired ? 'Vanilla session expired, signed out' : 'Signed out of Vanilla', 'info');
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

// ── Vanilla notifications ────────────────────────────────────────────────
// A panel off the bell next to the account button, laid out like the one on
// vanillarec.net. Vanilla keeps no read state on its side (its website keeps
// it in the browser), so neither does this: which ones have been seen is a
// per-account list in localStorage.

let vanillaNotifs = [];
let notifsLoading = false;

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

function readNotifsKey() {
  return vanillaPlayer ? `radium-vanilla-read-notifs-${vanillaPlayer.id}` : null;
}

function readNotifIds() {
  const key = readNotifsKey();
  if (!key) return new Set();
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

function markNotifsRead(ids) {
  const key = readNotifsKey();
  if (!key || !ids.length) return;
  const seen = readNotifIds();
  ids.forEach(id => seen.add(String(id)));
  try {
    localStorage.setItem(key, JSON.stringify([...seen].slice(-READ_NOTIFS_CAP)));
  } catch (e) {}
}

function unreadNotifs() {
  const seen = readNotifIds();
  return vanillaNotifs.filter(n => n.id != null && !seen.has(String(n.id)));
}

function setVanillaBadge() {
  const badge = $('vanillaNotifBadge');
  if (!badge) return;
  const count = unreadNotifs().length;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count || '');
  $('vanillaNotifsBtn')?.setAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications');
}

async function loadVanillaNotifications() {
  if (!vanillaPlayer || notifsLoading) return;
  notifsLoading = true;
  try {
    const account = vanillaPlayer.id;
    const list = await window.radium.vanillaNotifications();
    if (vanillaPlayer?.id !== account) return;
    vanillaNotifs = Array.isArray(list) ? list : [];
    setVanillaBadge();
    announceNewNotifs(vanillaNotifs);
    if (!$('vanillaNotifsPanel')?.hidden) renderNotifPanel();
  } catch (e) {
    if (!$('vanillaNotifsPanel')?.hidden) renderNotifPanel(String(e));
  } finally {
    notifsLoading = false;
  }
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

/// The message as text nodes, with the sender's name in bold.
function notifMessage(n) {
  const template = VANILLA_NOTIF_TEXT[n.type] || 'New notification from {s}.';
  const frag = document.createDocumentFragment();
  for (const part of template.split(/(\{s\}|\{m\})/)) {
    if (part === '{s}') {
      const b = document.createElement('strong');
      b.textContent = n.senderName || 'A player';
      frag.appendChild(b);
    } else if (part === '{m}') {
      frag.appendChild(document.createTextNode(n.message || ''));
    } else if (part) {
      frag.appendChild(document.createTextNode(part));
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
  img.src = n.senderAvatar ? thumbSrc(n.senderAvatar, avatarWidth(size)) : PLACEHOLDER_AVATAR;
  return img;
}

function notifRow(n, unread) {
  const row = document.createElement(n.senderName ? 'button' : 'div');
  row.className = 'notif-item';
  if (n.senderName) row.type = 'button';
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

  if (n.senderName) {
    row.addEventListener('click', () => {
      closeNotifPanel();
      showCreatorProfile(n.senderName);
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
  const list = $('vanillaNotifsList');
  if (!list) return;
  const unread = unreadNotifs();
  const mark = $('vanillaNotifsMarkRead');
  if (mark) mark.disabled = unread.length === 0;

  if (error && !vanillaNotifs.length) {
    list.replaceChildren(notifState(error));
    return;
  }
  if (!vanillaNotifs.length) {
    list.replaceChildren(notifsLoading ? notifState('Loading…', true) : notifState('No new notifications'));
    return;
  }
  // Unread first, then newest first, as on the website.
  const unreadIds = new Set(unread.map(n => String(n.id)));
  const sorted = [...vanillaNotifs].sort((a, b) => {
    const au = unreadIds.has(String(a.id)), bu = unreadIds.has(String(b.id));
    if (au !== bu) return au ? -1 : 1;
    return String(b.sentTime || '').localeCompare(String(a.sentTime || ''));
  });
  list.replaceChildren(...sorted.map(n => notifRow(n, unreadIds.has(String(n.id)))));
}

/// Place the panel beside the sidebar, bottom-aligned with the bell, and no
/// taller than the room above it (the title bar included).
function positionNotifPanel() {
  const panel = $('vanillaNotifsPanel');
  const bell = $('vanillaNotifsBtn');
  const sidebar = document.querySelector('.sidebar');
  if (!panel || !bell || !sidebar) return;
  const gap = 10;
  const bellBox = bell.getBoundingClientRect();
  const titlebar = $('titlebar')?.getBoundingClientRect().bottom || 0;
  panel.style.left = `${Math.round(sidebar.getBoundingClientRect().right + gap)}px`;
  panel.style.bottom = `${Math.max(gap, Math.round(window.innerHeight - bellBox.bottom))}px`;
  panel.style.maxHeight = `${Math.max(200, Math.min(460, Math.round(bellBox.bottom - titlebar - gap)))}px`;
}

function openNotifPanel() {
  closeAccountMenu();
  const panel = $('vanillaNotifsPanel');
  const bell = $('vanillaNotifsBtn');
  if (!panel) return;
  positionNotifPanel();
  renderNotifPanel();
  showDropdown(panel);
  bell?.setAttribute('aria-expanded', 'true');
  bell?.classList.add('is-open');
  loadVanillaNotifications();
}

/// Closing counts everything that was on show as seen, like the website.
function closeNotifPanel() {
  const panel = $('vanillaNotifsPanel');
  if (!panel || panel.hidden) return;
  markNotifsRead(vanillaNotifs.map(n => n.id).filter(id => id != null));
  setVanillaBadge();
  hideDropdown(panel);
  const bell = $('vanillaNotifsBtn');
  bell?.setAttribute('aria-expanded', 'false');
  bell?.classList.remove('is-open');
}

$('vanillaNotifsBtn')?.addEventListener('click', () => {
  const panel = $('vanillaNotifsPanel');
  if (panel && !panel.hidden) closeNotifPanel(); else openNotifPanel();
});

$('vanillaNotifsMarkRead')?.addEventListener('click', () => {
  markNotifsRead(vanillaNotifs.map(n => n.id).filter(id => id != null));
  setVanillaBadge();
  renderNotifPanel();
});

window.addEventListener('resize', () => {
  if (!$('vanillaNotifsPanel')?.hidden) positionNotifPanel();
});

// Check for new ones every minute while signed in, so pop-ups arrive close to
// when the notification did. One small request. While the launcher is
// minimised it only keeps checking if pop-ups are on.
setInterval(() => {
  if (!vanillaPlayer) return;
  if (document.hidden && !notifPrefs().popups) return;
  loadVanillaNotifications();
}, 60 * 1000);

// ── Notification pop-ups ─────────────────────────────────────────────────
// Steam-style cards for notifications that arrive while the launcher is
// running, always in their own window in the corner of the screen (see
// desktop_notify.rs), never inside the launcher. What was already there at
// sign-in is not announced.

/// Ids already seen for the signed-in account; `null` until its first load,
/// which only records a baseline.
let announcedNotifIds = null;
const NOTIF_POP_MAX = 3;

function announceNewNotifs(list) {
  const withIds = list.filter(n => n.id != null);
  if (!announcedNotifIds) {
    announcedNotifIds = new Set(withIds.map(n => String(n.id)));
    return;
  }
  const fresh = withIds.filter(n => !announcedNotifIds.has(String(n.id)));
  fresh.forEach(n => announcedNotifIds.add(String(n.id)));

  // Announced whichever network the launcher is showing. These belong to the
  // signed-in Vanilla account, and while Radium was selected they used to be
  // marked as announced without ever popping up — and the bell that would
  // have shown them is hidden on Radium. Opening one switches to Vanilla.
  if (!fresh.length) return;
  const seen = readNotifIds();
  const show = fresh
    .filter(n => !seen.has(String(n.id)))
    .sort((a, b) => String(a.sentTime || '').localeCompare(String(b.sentTime || '')));
  if (show.length) deliverNotifPops(show);
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
function deliverNotifPops(list, { force = false } = {}) {
  const prefs = notifPrefs();
  if (!force) {
    if (!prefs.popups || isGameRunning) return;
    const listOpen = !$('vanillaNotifsPanel')?.hidden;
    if (listOpen && document.hasFocus()) return;
  }

  // At most NOTIF_POP_MAX cards: the newest, led by an "N more" card.
  const items = list.length > NOTIF_POP_MAX
    ? [{ more: list.length - (NOTIF_POP_MAX - 1) }, ...list.slice(-(NOTIF_POP_MAX - 1))]
    : list;

  const style = notifPopStyle();
  window.radium.desktopNotify(items.map(it => desktopCard(it, style))).catch(() => {});
  if (prefs.sound) playNotifChime();
}

/// A card for the desktop pop-up: plain data, rendered there as text.
function desktopCard(it, style) {
  if (it.more) {
    return { id: null, sender: null, icon: 'bell', app: 'Vanilla', style,
             parts: [{ t: `${it.more} more new notifications` }] };
  }
  const n = it;
  const system = VANILLA_SYSTEM_NOTIFS.has(n.type) || !n.senderId;
  const template = VANILLA_NOTIF_TEXT[n.type] || 'New notification from {s}.';
  const parts = template.split(/(\{s\}|\{m\})/).filter(Boolean).map(part =>
    part === '{s}' ? { t: n.senderName || 'A player', b: true }
      : part === '{m}' ? { t: n.message || '' }
      : { t: part });
  return {
    id: n.id ?? null,
    sender: n.senderName || null,
    icon: system ? (n.type === 51 ? 'thumb' : 'info') : null,
    // Always Vanilla's, whichever network is showing, so never Radium's
    // default picture; the placeholder rather than nothing, which the pop-up
    // used to fill with the Radium logo.
    avatar: system ? '' : (n.senderAvatar ? thumbSrc(n.senderAvatar, avatarWidth(40)) : PLACEHOLDER_AVATAR),
    app: 'Vanilla',
    parts,
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
    'shadow': box.boxShadow,
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
  if (card?.id != null) {
    markNotifsRead([card.id]);
    setVanillaBadge();
  }
  // Profiles and the notification list are Vanilla's. setNetwork() refuses
  // (and says why) during a download or while the game runs; the launcher is
  // already in front, so that is where it stops.
  if (activeNetwork !== 'vanilla') {
    await setNetwork('vanilla');
    if (activeNetwork !== 'vanilla') return;
  }
  if (card?.sender) showCreatorProfile(String(card.sender));
  else if (vanillaPlayer) openNotifPanel();
});

// Settings → Send a test pop-up.
$('btnTestNotif')?.addEventListener('click', () => {
  deliverNotifPops([{
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
  if (panel && !panel.hidden && !panel.contains(e.target) && !$('vanillaNotifsBtn')?.contains(e.target)) {
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
    $('vanillaNotifsBtn')?.focus();
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

/// Cheer tiles are only buttons on Vanilla; elsewhere they are plain stats.
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
  setCheerEnabled(btn, !!room);
  setCheerPressed(btn, false);
  if (!btn || !room || !vanillaPlayer) return;
  try {
    const on = await window.radium.vanillaRoomCheered(room.RoomId);
    if (socialRoom === room) setCheerPressed(btn, on);
  } catch (e) {}
}

$('roomsDetailCheerBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
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
  const set = await cheeredPhotoSet();
  setCheerPressed(btn, !!set && set.has(btn.dataset.photoId));
}

async function paintPhotoCheer(photo) {
  const btn = $('photoDetailCheerBtn');
  setCheerEnabled(btn, !!photo);
  setCheerPressed(btn, false);
  if (!btn || !photo) return;
  const set = await cheeredPhotoSet();
  if (socialPhoto === photo) setCheerPressed(btn, !!set && set.has(photoIdOf(photo)));
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
        addLog(`Vanilla is sending your game to ^${roomName}`, 'info');
        if (await confirmJoined(job, room)) {
          toast(`Joined ^${roomName}`, 'ok');
          addLog(`Joined ^${roomName}`, 'ok');
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
  socialRoom = activeNetwork === 'vanilla' && room?.RoomId ? room : null;
  paintPlayButton();
  paintRoomCheer(socialRoom);
}

function setupPhotoSocial(photo) {
  socialPhoto = activeNetwork === 'vanilla' && (photo?.Id ?? photo?.id) != null ? photo : null;
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
  addLog(`Install dir: ${configInstallDir() || defaultInstallDirHint()}`, 'info');

  // Check install first (determines which panel to show)
  await checkInstall();

  // If a download was interrupted last session, offer to resume it.
  await offerResumeIfAny();

  // Check server on startup (show results in log), then silently every 60s
  await checkServerStatus(false);
  const serverPollInterval = setInterval(() => checkServerStatus(true), 60_000);

  // Check player count on startup (show results in log), then silently every 60s
  await updatePlayerCount(false);
  const playerPollInterval = setInterval(() => updatePlayerCount(true), 60_000);

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
  window.radium?.prefetchNetworkData();

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

function listIsFresh(key, renderedKey, renderedAt) {
  return key === renderedKey && Date.now() - renderedAt < LIST_STALE_MS;
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
    listEl.innerHTML = '<div style="font-size: 10px; color: var(--text-muted); text-align: center; padding: 4px;">Error loading filters</div>';
  }
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
    const rooms = res.data.Results || [];
    const total = res.data.TotalResults || 0;
    roomsRenderKey = key;
    roomsRenderAt = Date.now();
    
    gridEl.innerHTML = '';
    if (rooms.length === 0) {
      gridEl.dataset.listPlaceholder = '1';
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
          <div class="room-card-name">${escapeHtml(roomName)}</div>
          <div class="room-card-creator">by ${escapeHtml(creatorUsername)}</div>
        `;
        // Attach the creator click via a closure rather than inline onclick so a
        // username containing quotes can't break out of the JS-string context.
        const creatorEl = card.querySelector('.room-card-creator');
        if (creatorEl) {
          creatorEl.addEventListener('click', (e) => {
            e.stopPropagation();
            showCreatorProfile(creatorUsername);
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
    gridEl.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Error: ${escapeHtml(res?.error || 'Failed to fetch rooms')}</div>`;
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

async function loadPeople() {
  const bodyEl = $('peopleListBody');
  if (!bodyEl) return;
  
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
    const people = res.data.Results || [];
    const total = res.data.TotalResults || 0;
    peopleRenderKey = key;
    peopleRenderAt = Date.now();
    
    bodyEl.innerHTML = '';
    if (people.length === 0) {
      bodyEl.dataset.listPlaceholder = '1';
      bodyEl.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">No players found.</td></tr>';
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
          <td>
            <span class="status-dot ${presence.cls}" role="img" aria-label="${presence.title}"></span>
            ${escapeHtml(person.displayName || person.userName)}
          </td>
          <td class="people-username-cell">
            <span class="username-row"><span class="text-link">@${escapeHtml(person.userName)}</span><span class="profile-roles inline-roles"></span></span>
          </td>
          <td class="network-only-vanilla">${person.level != null ? escapeHtml(String(person.level)) : ''}</td>
          <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
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
    bodyEl.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Error: ${escapeHtml(res?.error || 'Failed to fetch players')}</td></tr>`;
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

async function showCreatorProfile(username) {
  if (!username) return;
  let person = null;
  try {
    const res = await window.radium?.fetchPeople({ query: username });
    if (res && res.success && res.data && res.data.Results) {
      person = res.data.Results.find(p => p.userName.toLowerCase() === username.toLowerCase());
      if (!person && res.data.Results.length > 0) {
        person = res.data.Results[0];
      }
    }
  } catch (err) {
    console.error("Error fetching creator profile:", err);
  }
  if (!person) {
    person = {
      id: null,
      userName: username,
      displayName: username,
      profileImage: 'DefaultProfileImage',
      isOnline: false,
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

async function getUserWebDetails(username) {
  if (!username) return null;
  const key = username.toLowerCase();
  if (userWebDetailsCache.has(key)) {
    return userWebDetailsCache.get(key);
  }
  const res = await window.radium?.fetchUserWebDetails(username);
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

async function loadRoomPhotos(roomId, append = false) {
  const photosGrid = $('roomsDetailPhotosGrid');
  const photosEmpty = $('roomsDetailPhotosEmpty');
  if (!photosGrid) return;
  if (roomPhotosLoading) return;
  
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
  
  let resultsLength = 0;
  let hasFailed = false;
  let pagesSearched = 0;
  let matchedInBatch = 0;
  
  while (true) {
    pagesSearched++;
    roomPhotosTotalPagesSearched++;
    const res = await window.radium?.fetchRecentPhotos({ skip: roomPhotosFeedSkip, take: roomPhotosFeedTake });
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
    photosGrid.innerHTML = '<div id="playerPhotosLoading" style="text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted);">Loading photos...</div>';
    if (photosEmpty) photosEmpty.style.display = 'none';
  } else {
    const loadingEl = document.createElement('div');
    loadingEl.id = 'playerPhotosLoading';
    loadingEl.style.cssText = 'text-align: center; padding: 10px; font-size: 11px; color: var(--text-muted); width: 100%;';
    loadingEl.textContent = 'Loading more...';
    photosGrid.appendChild(loadingEl);
  }
  
  currentPlayerId = userId;
  playerPhotosLoading = true;
  
  const res = await window.radium?.fetchUserPhotos({ userId, skip: playerPhotosSkip, take: playerPhotosTake });
  const loadingEl = $('playerPhotosLoading');
  if (loadingEl) loadingEl.remove();
  playerPhotosLoading = false;
  
  if (res && res.success && res.data && res.data.Results) {
    const photos = res.data.Results || [];
    
    if (!append) photosGrid.innerHTML = '';
    
    photos.forEach(photo => {
      photosGrid.appendChild(buildPhotoCard(photo, 'people-detail'));
    });
    
    const totalInGrid = photosGrid.querySelectorAll('.feed-post-card').length;
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
  addLog(`Looking up room "${roomName}"...`, 'info');
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
    // The one image the user has deliberately opened goes straight to the
    // origin: the thumbnail cache exists to stop a grid pulling megabytes it
    // draws at 200 px, not to downscale a photo someone asked to look at.
    imgWrapEl.onclick = () => showLightbox(photoSourceUrl(photo, 1920), {
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



async function showRoomDetails(room) {
  const list = $('roomsListView');
  const detail = $('roomsDetailView');
  if (!list || !detail) return;
  const seq = ++roomDetailSeq;
  
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
      await showCreatorProfile(creatorUsername);
      hideRoomDetails();
    };
  }

  const creatorAvatarEl = $('roomsDetailCreatorAvatar');
  if (creatorAvatarEl) {
    creatorAvatarEl.classList.add('image-loading-placeholder');
    creatorAvatarEl.src = defaultAvatarUrl(32);
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
      showLightbox(personAvatarFullUrl(person), {
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
  
  // Level is on the row itself, so unlike the stats below it needs no lookup.
  // Absent (Radium, or a record without one) hides the tile.
  setProfileStat($('peopleDetailLevel'), person.level ?? '');

  const friendsEl = $('peopleDetailFriends');
  const subsEl = $('peopleDetailSubscribers');
  const visitsEl = $('peopleDetailVisits');
  // Only show a loading placeholder for stats this network actually publishes.
  // Vanilla has a subscriber count and nothing else — no friends, no visits —
  // so flashing those tiles as "..." only to hide them a moment later is the
  // jump the user sees on opening a profile. Radium's scraped profile has all
  // three. `webDetails` fills the real values (or '' to hide) once it lands.
  const hasFriendsStat = activeNetwork !== 'vanilla';
  const hasVisitsStat  = activeNetwork !== 'vanilla';
  setProfileStat(friendsEl, hasFriendsStat ? '...' : '');
  setProfileStat(subsEl, '...');
  setProfileStat(visitsEl, hasVisitsStat ? '...' : '');
  const bioEl = $('peopleDetailBio');
  if (bioEl) bioEl.textContent = 'Loading bio from web...';
  
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
    bannerEl.style.backgroundSize = 'cover';
    bannerEl.style.backgroundPosition = 'center';
  }

  const peoplePhotosGrid = $('peopleDetailPhotosGrid');
  const peoplePhotosEmpty = $('peopleDetailPhotosEmpty');
  if (peoplePhotosGrid) peoplePhotosGrid.innerHTML = '';
  if (peoplePhotosEmpty) peoplePhotosEmpty.style.display = 'none';

  list.classList.add('hidden');
  detail.classList.remove('hidden');
  setupPersonSocial(person);

  // Load scraped web details asynchronously
  let webDetails = null;
  try {
    webDetails = await getUserWebDetails(person.userName);
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
    if (bioEl) bioEl.textContent = webDetails.bio || 'This user has not setup a bio yet.';
    if (webDetails.banner && bannerEl) {
      bannerEl.style.backgroundImage = `url("${webDetails.banner}")`;
    }
    
    // Live update status if scrape has it
    if (webDetails.status) {
      const isOnlineScraped = webDetails.status !== 'OFFLINE';
      if (dotEl) dotEl.className = `status-dot ${isOnlineScraped ? 'online' : 'offline'}`;
      if (labelEl) labelEl.textContent = isOnlineScraped ? 'ONLINE' : 'OFFLINE';

      if (webDetails.status !== 'ONLINE' && webDetails.status !== 'OFFLINE') {
        if (activityEl) {
          activityEl.style.display = 'inline-flex';
          activityEl.textContent = webDetails.status;
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
    setProfileStat(friendsEl, hasFriendsStat ? '—' : '');
    setProfileStat(subsEl, '—');
    setProfileStat(visitsEl, hasVisitsStat ? '—' : '');
    if (bioEl) bioEl.textContent = person.bio || 'This user has not setup a bio yet.';
  }

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
  
  tabs.forEach(t => {
    if (t.btn) {
      t.btn.onclick = () => {
        tabs.forEach(other => {
          if (other.btn) {
            other.btn.classList.remove('active');
            other.btn.style.borderBottom = 'none';
            other.btn.style.color = 'var(--text-muted)';
          }
          if (other.sec) other.sec.style.display = 'none';
        });
        t.btn.classList.add('active');
        t.btn.style.borderBottom = '2px solid var(--green)';
        t.btn.style.color = 'var(--green)';
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

// Bug Reporter event handler
(function setupBugReporter() {
  const btnSubmit = $('btnSubmitBugReport');
  const txtReport = $('bugReportText');
  const lblStatus = $('bugReportStatus');

  if (!btnSubmit || !txtReport || !lblStatus) return;

  let cooldownTimer = null;
  let cooldownTimeLeft = 0;

  function setStatus(text, type = 'info') {
    lblStatus.textContent = text;
    if (type === 'error') {
      lblStatus.style.color = '#ff4444'; // Error red matching theme toast.error
    } else if (type === 'success' || type === 'ok') {
      lblStatus.style.color = 'var(--green)'; // Success green
    } else {
      lblStatus.style.color = 'var(--text-muted)';
    }
  }

  function startCooldown(seconds) {
    cooldownTimeLeft = seconds;
    btnSubmit.disabled = true;
    txtReport.disabled = true;
    const categorySel = $('bugReportCategory');
    const severitySel = $('bugReportSeverity');
    if (categorySel) categorySel.disabled = true;
    if (severitySel) severitySel.disabled = true;
    setStatus('');
    
    if (cooldownTimer) clearInterval(cooldownTimer);
    
    cooldownTimer = setInterval(() => {
      cooldownTimeLeft--;
      if (cooldownTimeLeft <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        btnSubmit.disabled = false;
        txtReport.disabled = false;
        if (categorySel) categorySel.disabled = false;
        if (severitySel) severitySel.disabled = false;
        btnSubmit.textContent = 'SUBMIT BUG REPORT';
      } else {
        btnSubmit.textContent = `COOLDOWN (${cooldownTimeLeft}s)`;
      }
    }, 1000);
  }

  btnSubmit.addEventListener('click', async () => {
    const bugText = txtReport.value.trim();
    const categorySel = $('bugReportCategory');
    const severitySel = $('bugReportSeverity');
    const category = categorySel ? categorySel.value : 'general';
    const severity = severitySel ? severitySel.value : 'medium';
    
    // 1. Length validation (frontend check)
    if (bugText.length < 10) {
      toast('Description is too short. Minimum 10 characters required.', 'error');
      setStatus('Description too short (min 10 chars).', 'error');
      return;
    }
    if (bugText.length > 1500) {
      toast('Description is too long. Maximum 1500 characters allowed.', 'error');
      setStatus('Description too long (max 1500 chars).', 'error');
      return;
    }

    // 2. Disable inputs & show loading state
    btnSubmit.disabled = true;
    txtReport.disabled = true;
    if (categorySel) categorySel.disabled = true;
    if (severitySel) severitySel.disabled = true;
    btnSubmit.textContent = 'SUBMITTING...';
    setStatus('Submitting report to Discord...', 'info');

    // Use the full unbounded log buffer (not the capped DOM viewer)
    // This ensures early startup logs are always included in bug reports.
    // Faults raised before the logger existed are prepended — they precede
    // everything else chronologically and are usually the actual cause.
    const fullLogs = [...startupFaults, ...fullLogBuffer].join('\n');

    const diagnostics = {
      launcherVersion: launcherVersion ? `v${launcherVersion}` : 'unknown',
      isInstalled: isInstalled,
      isGameRunning: isGameRunning,
      isDownloading: isDownloading,
      // A single "downloading" bool couldn't distinguish a stalled download
      // from a paused or cancelling one — states a report is most likely to be
      // filed during. Reported as one field so the phase is unambiguous.
      downloadState: isCancelling  ? 'cancelling'
                   : isPaused      ? 'paused'
                   : isDownloading ? 'downloading'
                   :                 'idle',
      // How many errors the session logged, so triage can tell "one glitch"
      // from "everything is failing" without reading the whole attachment.
      errorCount: startupFaults.length
        + fullLogBuffer.reduce((n, l) => n + (l.includes('[ERROR]') ? 1 : 0), 0),
      // Last-known server reachability (null if not yet checked this session).
      // The client build/version/outdated fields are read authoritatively from
      // config on the backend, so they aren't duplicated here.
      apiOnline: lastServerStatus.apiOnline,
      cdnOnline: lastServerStatus.cdnOnline
    };

    try {
      // 3. Invoke Tauri backend command
      const responseMessage = await window.radium?.submitBugReport(bugText, fullLogs, category, severity, diagnostics);
      
      // 4. Handle success
      toast(responseMessage || 'Bug report submitted successfully! Thank you.', 'ok');
      setStatus('Submitted successfully!', 'ok');
      txtReport.value = ''; // Clear report text
      
      // 5. Start cooldown (60 seconds)
      startCooldown(60);
    } catch (err) {
      // 6. Handle error
      const errMsg = String(err || 'Failed to submit bug report.');
      toast(errMsg, 'error');
      setStatus(errMsg, 'error');
      btnSubmit.disabled = false;
      txtReport.disabled = false;
      if (categorySel) categorySel.disabled = false;
      if (severitySel) severitySel.disabled = false;
      btnSubmit.textContent = 'SUBMIT BUG REPORT';
    }
  });
})();

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

