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
    ? '%APPDATA%\com.radium.launcher\client-vanilla'
    : '%APPDATA%\com.radium.launcher\client';
}

function setConfigInstallDir(dir, network = activeNetwork) {
  if (!config) return;
  if (network === 'vanilla') {
    config.vanilla = { ...(config.vanilla || {}), installDir: dir };
  } else {
    config.installDir = dir;
  }
}

/// Launch options are per-network for the same reason install directories are:
/// the two are different client builds that take different flags. Radium's live
/// on the flat `config.launchOptions`, Vanilla's on
/// `config.vanilla.launchOptions`.
function configLaunchOptions(network = activeNetwork) {
  if (!config) return '';
  return (network === 'vanilla' ? config.vanilla?.launchOptions : config.launchOptions) || '';
}

/// The Settings input for a network's launch options. Both rows exist at once,
/// so every read and write has to name which network it means.
function launchOptionsInput(network = activeNetwork) {
  return $(network === 'vanilla' ? 'cfgLaunchOptionsVanilla' : 'cfgLaunchOptionsRadium');
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

    // Config
    getConfig:  ()    => invoke('cmd_get_config'),
    saveConfig: (cfg) => invoke('cmd_save_config', { config: cfg }),

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
    restoreDll:          () => invoke('restore_dll'),
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
    downloadUpdate:  (downloadUrl, placeOnDesktop) => invoke('download_update', { url: downloadUrl, placeOnDesktop: !!placeOnDesktop }),

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

    // Window state events
    onWindowMaximizedState: async (cb) => {
      if (unlistenMap['window-maximized-state']) unlistenMap['window-maximized-state']();
      unlistenMap['window-maximized-state'] = await listen('window-maximized-state', (event) => cb(event.payload));
    },

    // Debug
    debugExec:  (mode) => invoke('cmd_debug_exec', { mode }),
    debugPaths: ()     => invoke('cmd_debug_paths'),

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

/// Placeholder avatar for a network. Radium has a real DefaultProfileImage on
/// its CDN; Vanilla has no such asset, so fall back to the bundled image.
function defaultAvatarUrl(width) {
  if (activeNetwork !== 'radium') return './images.png';
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
           data-fallback="./images.png" />
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
      <span class="feed-post-stat"><span class="cheers-count">${cheers}</span> Cheers</span>
      ${hasComments ? `<span class="feed-post-stat"><span class="comments-count">${comments}</span> Comments</span>` : ''}
    </div>
  `;

  card.querySelector('.image-wrap')?.addEventListener('click', () => {
    showPhotoDetails(photo, backToView);
  });

  // Names are attached as elements, not interpolated markup, so a display name
  // containing quotes can't break out of a JS string context.
  const taggedEl = card.querySelector('.feed-post-tagged');
  if (taggedEl) {
    tagged.forEach(p => {
      const link = document.createElement('span');
      link.className = 'feed-tagged-name';
      link.textContent = p.displayName || p.userName;
      link.title = `@${p.userName}`;
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
function playerRoles(person) {
  if (!person) return [];
  const roles = [];
  if (person.isDeveloper)     roles.push({ short: 'DEV',  full: 'Developer' });
  if (person.isModerator)     roles.push({ short: 'MOD',  full: 'Moderator' });
  if (person.isCommunityTeam) roles.push({ short: 'TEAM', full: 'Community Team' });
  return roles;
}

/// Render a player's roles into `el`, hiding it when they have none.
function renderPlayerRoles(el, person) {
  if (!el) return;
  const roles = playerRoles(person);
  el.innerHTML = '';
  el.hidden = roles.length === 0;
  roles.forEach(role => {
    const pill = document.createElement('span');
    pill.className = `role-badge role-${role.short.toLowerCase()}`;
    pill.textContent = role.short;
    pill.title = role.full;
    el.appendChild(pill);
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
      : './images.png';
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
    btn.title = isMaximized ? 'Restore' : 'Maximize';
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

// Fetch version tag
let launcherVersion = '';
async function loadVersion() {
  const v = await window.radium?.getVersion();
  if (v) launcherVersion = v;
  const el = $('versionTag');
  if (el && v) el.textContent = `v${v}`;
}

/// Show or hide the custom theme editor.
///
/// A class, not an inline display: the editor lays its sections out with
/// flex, and writing `display: block` onto it from JS would collapse that.
function setCustomThemeEditorOpen(open) {
  $('customThemeGroup')?.classList.toggle('is-open', open);
}

// Helper to force modern style base and lock choices/color pickers when glass theme is active
// Remembers the style base that was selected before glass forced "modern", so
// toggling glass off restores the user's original Retro/Modern choice instead
// of silently persisting "modern".
let _styleBaseBeforeGlass = null;
function updateStyleBaseLocks(glassEnabled) {
  const modernRadio = $('styleBaseModern');
  const retroRadio = $('styleBaseRetro');
  const templateSelect = $('themeTemplateSelect');
  // The glass background picker stays editable while glass is on — it's the one
  // color that's specifically relevant in glass mode.
  const colorInputs = document.querySelectorAll('.theme-color-input:not(#theme-glassBg)');

  // Say why. Half the editor dimming with no explanation is the single most
  // confusing thing this panel did.
  const lockNote = $('glassLockNote');
  if (lockNote) lockNote.hidden = !glassEnabled;

  if (glassEnabled) {
    // Capture the current selection once, before it gets overridden below.
    if (modernRadio && !modernRadio.disabled) {
      _styleBaseBeforeGlass = modernRadio.checked ? 'modern' : 'retro';
    }
    if (modernRadio) {
      modernRadio.checked = true;
      modernRadio.disabled = true;
      const lbl = modernRadio.closest('label');
      if (lbl) { lbl.style.opacity = '0.5'; lbl.style.cursor = 'not-allowed'; }
    }
    if (retroRadio) {
      retroRadio.checked = false;
      retroRadio.disabled = true;
      const lbl = retroRadio.closest('label');
      if (lbl) { lbl.style.opacity = '0.5'; lbl.style.cursor = 'not-allowed'; }
    }
    if (templateSelect) {
      templateSelect.disabled = true;
      const parent = templateSelect.closest('div');
      if (parent) { parent.style.opacity = '0.5'; parent.style.pointerEvents = 'none'; }
    }
    colorInputs.forEach(input => {
      input.disabled = true;
      const parent = input.closest('div');
      if (parent) { parent.style.opacity = '0.4'; parent.style.pointerEvents = 'none'; }
    });
  } else {
    // Restore the selection glass mode overrode (only when we actually
    // captured one — a plain unlock during config load must not clobber the
    // radios that were just set from the saved config).
    if (_styleBaseBeforeGlass !== null && modernRadio && retroRadio && modernRadio.disabled) {
      modernRadio.checked = _styleBaseBeforeGlass === 'modern';
      retroRadio.checked = _styleBaseBeforeGlass === 'retro';
      _styleBaseBeforeGlass = null;
    }
    if (modernRadio) {
      modernRadio.disabled = false;
      const lbl = modernRadio.closest('label');
      if (lbl) { lbl.style.opacity = '1'; lbl.style.cursor = 'pointer'; }
    }
    if (retroRadio) {
      retroRadio.disabled = false;
      const lbl = retroRadio.closest('label');
      if (lbl) { lbl.style.opacity = '1'; lbl.style.cursor = 'pointer'; }
    }
    if (templateSelect) {
      templateSelect.disabled = false;
      const parent = templateSelect.closest('div');
      if (parent) { parent.style.opacity = '1'; parent.style.pointerEvents = 'auto'; }
    }
    colorInputs.forEach(input => {
      input.disabled = false;
      const parent = input.closest('div');
      if (parent) { parent.style.opacity = '1'; parent.style.pointerEvents = 'auto'; }
    });
  }
}

// Load and save local settings config
async function loadConfig() {
  config = (await window.radium?.getConfig()) || {};

  // Defaults
  if (!config.apiUrl)   config.apiUrl   = 'https://api.radie.app/';
  if (!config.playMode) config.playMode = 'screen';

  setValue('cfgLaunchOptionsRadium', configLaunchOptions('radium'));
  setValue('cfgLaunchOptionsVanilla', configLaunchOptions('vanilla'));

  setToggle('tgl-minimizeOnLaunch', config.minimizeOnLaunch !== false);
  setToggle('tgl-closeOnLaunch',    config.closeOnLaunch    === true);
  setToggle('tgl-autoUpdate',       config.autoUpdate       !== false);
  setToggle('tgl-enableAnimations', config.enableAnimations !== false);
  setToggle('tgl-disableWarnings',   config.disableWarnings   === true);

  // Play mode
  playMode = config.playMode || 'screen';
  setModeUI(playMode);
  updateQsMode();

  // Theme
  const activeTheme = config.theme || 'steam-green';
  const customOn = activeTheme === 'custom';
  
  // Set Custom Theme toggle and groups
  setToggle('tgl-customTheme', customOn);
  setCustomThemeEditorOpen(customOn);
  
  const cfgThemeSelect = $('cfgTheme');
  if (cfgThemeSelect) {
    cfgThemeSelect.value = customOn ? (config.baselineTheme || 'steam-green') : activeTheme;
    cfgThemeSelect.disabled = customOn;
    const parent = cfgThemeSelect.closest('div');
    if (parent) {
      parent.style.opacity = customOn ? '0.5' : '1';
      parent.style.pointerEvents = customOn ? 'none' : 'auto';
    }
  }

  // Load custom colors if customTheme exists in config
  if (config.customTheme) {
    const colors = config.customTheme;
    if ($('theme-bgDark')) $('theme-bgDark').value = colors.bgDark || '#21281e';
    if ($('theme-bgMain')) $('theme-bgMain').value = colors.bgMain || '#384232';
    if ($('theme-bgPanel')) $('theme-bgPanel').value = colors.bgPanel || '#4b5845';
    if ($('theme-bgBtn')) $('theme-bgBtn').value = colors.bgBtn || '#5e6d56';
    if ($('theme-borderLight')) $('theme-borderLight').value = colors.borderLight || '#829478';
    if ($('theme-borderDark')) $('theme-borderDark').value = colors.borderDark || '#1b2118';
    if ($('theme-green')) $('theme-green').value = colors.green || '#00ff00';
    if ($('theme-greenDim')) $('theme-greenDim').value = colors.greenDim || '#7ca969';
    if ($('theme-text')) $('theme-text').value = colors.text || '#d4e0ce';
    if ($('theme-textMuted')) $('theme-textMuted').value = colors.textMuted || '#8da082';
    if ($('theme-statusOnline')) $('theme-statusOnline').value = colors.statusOnline || '#00ff00';
    if ($('theme-glassBg')) $('theme-glassBg').value = colors.glassBg || '#0b0c14';

    setBgImageUI(colors.bgImage);
    const glassOn = colors.glassEnabled === true;
    setToggle('tgl-glassEnabled', glassOn);
    updateStyleBaseLocks(glassOn);
    if (!glassOn) {
      const styleBase = colors.styleBase || 'retro';
      if (styleBase === 'modern') {
        if ($('styleBaseModern')) $('styleBaseModern').checked = true;
      } else {
        if ($('styleBaseRetro')) $('styleBaseRetro').checked = true;
      }
    }
  }

  applyTheme(activeTheme);

  // Font pack. Order against applyTheme does not matter — each rebuilds
  // body.className filtering only its own prefix, so neither can wipe the
  // other. Read back from applyFont so an unknown value in config.json falls
  // back to 'default' in the dropdown too, not just on <body>.
  const activeFont = applyFont(config.font || 'default');
  setValue('cfgFont', activeFont);

  // Defender Exclusion State
  const btnExcludeAv = $('btnExcludeAv');
  if (btnExcludeAv) {
    btnExcludeAv.textContent = config.defenderExcluded ? 'UNExclude AV' : 'Exclude AV';
  }

  // Network last, so the brand and capability gating are applied against a
  // fully-loaded config.
  applyNetworkUI(config.network === 'vanilla' ? 'vanilla' : 'radium');

  // Both install rows, not just the active network's — after applyNetworkUI so
  // the ACTIVE tag lands on the row the loaded config actually selected.
  await refreshInstallDirRows();
}

// Every font pack the Font dropdown can select. Keeping the list here (rather
// than reading the <option> values) means applyFont can reject a stale or
// hand-edited config value instead of stamping a junk class onto <body>.
const FONT_PACKS = ['default', 'ios', 'minecraft', 'radium'];

// Swaps the `font-*` class on <body>. Each pack re-points --font-ui and
// --font-mono in style.css; 'default' just removes the class and lets the
// active skin's own faces show through.
function applyFont(font) {
  const pack = FONT_PACKS.includes(font) ? font : 'default';

  document.body.className = document.body.className
    .split(' ')
    .filter(c => c && !c.startsWith('font-'))
    .join(' ');

  if (pack !== 'default') document.body.classList.add('font-' + pack);

  // Mirrored to localStorage for boot.js, which replays it before first paint.
  // Without this the pack can only land after the getConfig() IPC resolves, so
  // the window paints in the theme's stock face and then reflows — the packs
  // change body font-size and eight readout sizes, so the jump is visible.
  try {
    localStorage.setItem('radium-font', pack);
  } catch (e) {}

  return pack;
}

/// The custom palette is written as its own <style>, separate from the bulk of
/// the generated theme CSS.
///
/// Dragging a colour picker fires `input` continuously, and each one used to
/// rebuild and re-parse the whole ~25 KB custom stylesheet — measured at ~2.3 ms
/// of parsing per event against ~0.13 ms for the palette alone, before any of
/// the repainting that a full sheet swap also forces. That is what made the
/// pickers feel sticky, and worst under Liquid Glass, where every panel carries
/// a backdrop-filter that has to be re-run.
///
/// Only the eleven custom properties change while dragging; everything else in
/// the sheet is fixed for a given style base / glass / background image. So the
/// palette gets its own element that a colour change can rewrite on its own.
const CUSTOM_VARS_STYLE_ID = 'custom-theme-vars';
/// The stylesheet boot.js injects from cache before the first paint.
const CUSTOM_BOOT_STYLE_ID = 'custom-theme-boot';
let _customVarsFrame = 0;

function customThemeVarsCss(colors) {
  return `body.theme-custom {
  --bg-dark: ${colors.bgDark};
  --bg-main: ${colors.bgMain};
  --bg-panel: ${colors.bgPanel};
  --bg-btn: ${colors.bgBtn};
  --border-light: ${colors.borderLight};
  --border-dark: ${colors.borderDark};
  --green: ${colors.green};
  --green-dim: ${colors.greenDim};
  --text: ${colors.text};
  --text-muted: ${colors.textMuted};
  --status-online: ${colors.statusOnline};
}`;
}

/// Create or update the palette sheet.
///
/// Inserted before the main custom sheet, because that one redefines the same
/// variables for glass mode at equal specificity — document order is what
/// decides the winner, so the palette has to stay above it exactly as it did
/// when both lived in one string.
function writeCustomThemeVars(colors) {
  // Drop any queued live-preview frame: it closes over an older palette, and
  // landing after this write would put those colours back.
  cancelAnimationFrame(_customVarsFrame);
  _customVarsFrame = 0;

  let el = document.getElementById(CUSTOM_VARS_STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CUSTOM_VARS_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = customThemeVarsCss(colors);
  try {
    localStorage.setItem('radium-custom-vars', el.textContent);
  } catch (e) {}
  return el;
}

/// Live-preview a palette change without rebuilding the whole stylesheet.
///
/// Coalesced onto an animation frame: a drag can fire several `input` events
/// between two paints, and only the last one is worth applying.
///
/// Returns false when there is no palette sheet to update — the theme is not
/// custom, or has not been applied yet — so the caller can fall back to a full
/// applyTheme().
function applyCustomThemeColors(colors) {
  if (!document.getElementById(CUSTOM_VARS_STYLE_ID)) return false;
  cancelAnimationFrame(_customVarsFrame);
  _customVarsFrame = requestAnimationFrame(() => writeCustomThemeVars(colors));
  return true;
}

function applyTheme(theme) {
  // Strip only the theme classes. This used to whitelist 'animations-enabled'
  // and drop everything else, which silently wiped unrelated state classes on
  // <body> (e.g. 'client-installed', which gates the PLAY button and the
  // Manage Client panel) every time the theme changed.
  document.body.className = document.body.className
    .split(' ')
    .filter(c => c && !c.startsWith('theme-'))
    .join(' ');

  // Remove existing custom style block if any
  const existingStyle = document.getElementById('custom-theme-style');
  if (existingStyle) existingStyle.remove();
  document.getElementById(CUSTOM_VARS_STYLE_ID)?.remove();
  // The pre-paint cache boot.js injects. Dropped here so the real stylesheet
  // replaces it rather than stacking on top of it.
  document.getElementById(CUSTOM_BOOT_STYLE_ID)?.remove();

  if (theme === 'custom') {
    document.body.classList.add('theme-custom');
    const colors = config.customTheme || {
      bgDark:      '#21281e',
      bgMain:      '#384232',
      bgPanel:     '#4b5845',
      bgBtn:       '#5e6d56',
      borderLight: '#829478',
      borderDark:  '#1b2118',
      green:        '#00ff00',
      greenDim:    '#7ca969',
      text:         '#d4e0ce',
      textMuted:   '#8da082',
      statusOnline:'#00ff00',
      styleBase:   'retro',
      bgImage:     '',
      glassEnabled:false
    };
    
    const styleBase = colors.styleBase || 'retro';
    document.body.classList.add('theme-custom-' + styleBase);

    // Modern borrows theme-moderndark, which really does carry the rounded
    // layout that style.css's base rules don't.
    //
    // Retro borrows nothing. It used to add theme-win98 "for structural rules",
    // but that skin defines almost no structure — it is colours, two dither
    // background-images and a set of Win9x literals (#ffffff wells, a #000080
    // toggle, a #dfdcd4 dithered scrollbar track). style.css's own rules are
    // already the retro layout, fully variable-driven: theme-steam-green has
    // no rules at all, it *is* the base stylesheet. So borrowing win98 added
    // nothing but its palette, which then fought the user's — a theme copied
    // from Steam 2003 Green came out looking like Win98, and the scrollbar kept
    // Win98's white dither over any colour chosen for it.
    if (styleBase === 'modern') {
      document.body.classList.add('theme-moderndark');
    }

    if (colors.glassEnabled) {
      document.body.classList.add('theme-custom-glass');
    }

    // The palette lives in its own stylesheet so that dragging a colour picker
    // rewrites ~400 bytes instead of re-parsing the ~25 KB below it on every
    // input event. See applyCustomThemeColors().
    writeCustomThemeVars(colors);

    let css = `
      body.theme-custom .titlebar {
        background: var(--bg-dark) !important;
        border-bottom: 2px solid var(--border-dark) !important;
      }
      body.theme-custom .titlebar-app-name {
        color: var(--green) !important;
      }

      /* Force custom button background on modern/retro layouts when not in glass mode */
      body.theme-custom:not(.theme-custom-glass) .btn-download-big,
      body.theme-custom:not(.theme-custom-glass) .btn-play,
      body.theme-custom:not(.theme-custom-glass) .btn-refresh,
      body.theme-custom:not(.theme-custom-glass) .btn-save,
      body.theme-custom:not(.theme-custom-glass) .btn-test-server,
      body.theme-custom:not(.theme-custom-glass) .btn-cancel-dl,
      body.theme-custom:not(.theme-custom-glass) .btn-open-folder,
      body.theme-custom:not(.theme-custom-glass) .btn-reinstall,
      body.theme-custom:not(.theme-custom-glass) .btn-uninstall,
      body.theme-custom:not(.theme-custom-glass) .btn-kill,
      body.theme-custom:not(.theme-custom-glass) .modal-btn,
      body.theme-custom:not(.theme-custom-glass) .btn-exclude-av,
      body.theme-custom:not(.theme-custom-glass) .filter-btn,
      body.theme-custom:not(.theme-custom-glass) .sort-btn,
      body.theme-custom:not(.theme-custom-glass) .nav-btn.active,
      body.theme-custom:not(.theme-custom-glass) .launch-secondary-actions button {
        background: var(--bg-btn) !important;
        color: var(--text) !important;
        border-color: var(--border-light) !important;
        box-shadow: none !important;
      }

      body.theme-custom:not(.theme-custom-glass) .btn-download-big:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-play:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-refresh:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-save:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-test-server:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-cancel-dl:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-open-folder:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-reinstall:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-uninstall:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-kill:hover,
      body.theme-custom:not(.theme-custom-glass) .modal-btn:hover,
      body.theme-custom:not(.theme-custom-glass) .btn-exclude-av:hover,
      body.theme-custom:not(.theme-custom-glass) .filter-btn:hover,
      body.theme-custom:not(.theme-custom-glass) .sort-btn:hover,
      body.theme-custom:not(.theme-custom-glass) .nav-btn:hover:not(.active),
      body.theme-custom:not(.theme-custom-glass) .launch-secondary-actions button:hover {
        background: color-mix(in srgb, var(--bg-btn) 80%, var(--text)) !important;
        color: var(--text) !important;
        border-color: var(--green) !important;
      }
    `;

    // 0. Repaint what the *base* stylesheet hardcodes.
    //
    // Retro no longer borrows a skin, so Win98's literals are gone at the
    // source. What is left is style.css's own chrome gradient, which predates
    // theming: both title bars are drawn with a fixed dark-to-panel green.
    // Retro mirrors that stylesheet exactly now, so it wants the same gradient
    // rebuilt from the palette — a flat fill was the last thing that still
    // read as "not the skin I copied". Modern borrows theme-moderndark, whose
    // title bar is flat, so it keeps the flat fill set above.
    if (styleBase === 'retro') {
      css += `
        body.theme-custom.theme-custom-retro .titlebar,
        body.theme-custom.theme-custom-retro .modal-titlebar {
          background: linear-gradient(90deg, var(--border-dark), var(--bg-panel)) !important;
          border-bottom: 2px solid var(--border-dark) !important;
        }
      `;
    } else {
      css += `
        body.theme-custom .modal-titlebar {
          background: var(--bg-dark) !important;
          border-bottom: 2px solid var(--border-dark) !important;
        }
        /* The modern skins paint the switch knob a literal white, which
           disappears on a light custom palette. */
        body.theme-custom.theme-custom-modern .tgl-knob {
          background: var(--text-muted) !important;
        }
        body.theme-custom.theme-custom-modern .toggle-wrap.on .tgl-knob {
          background: var(--green) !important;
        }
      `;
    }

    // 1. Layout-specific overrides (font matching)
    if (styleBase === 'modern') {
      const avatarBgStart = encodeURIComponent(colors.bgDark);
      const avatarBgEnd = encodeURIComponent(colors.bgMain);

      css += `
        body.theme-custom-modern, body.theme-custom-modern * {
          font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif !important;
        }
        /* No image placeholder: none here on purpose. It used to be a copy of
           the same play-button SVG the built-in skins carried, baked with this
           theme's two darkest colours. The shared rule in style.css paints it
           from --bg-dark / --text-muted instead, which this theme also defines,
           so a custom theme now gets a placeholder that matches it for free. */
        body.theme-custom-modern .creator-avatar[src="./logo.png"],
        body.theme-custom-modern .feed-post-avatar[src="./logo.png"],
        body.theme-custom-modern .people-avatar[src="./logo.png"],
        body.theme-custom-modern .creator-avatar[src="logo.png"],
        body.theme-custom-modern .feed-post-avatar[src="logo.png"],
        body.theme-custom-modern .people-avatar[src="logo.png"] {
          content: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='${avatarBgStart}'/%3E%3Cstop offset='100%25' stop-color='${avatarBgEnd}'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23g)'/%3E%3Ccircle cx='48' cy='38' r='18' fill='rgba(255,255,255,0.3)'/%3E%3Cpath d='M48 62c-15 0-26 8-26 14v4h52v-4c0-6-11-14-26-14z' fill='rgba(255,255,255,0.3)'/%3E%3C/svg%3E") !important;
        }
      `;
    }

    let safeBgImage = '';
    if (colors.bgImage) {
      if (colors.bgImage.startsWith('data:image/') && !/['"()\{\}\\]/.test(colors.bgImage)) {
        safeBgImage = colors.bgImage;
      } else if ((colors.bgImage.startsWith('http://') || colors.bgImage.startsWith('https://')) && !/['";()\{\}\\]/.test(colors.bgImage)) {
        safeBgImage = colors.bgImage;
      }
    }

    // 2. Background image transparent overrides (always transparent main-content and translucent sidebar)
    if (safeBgImage) {
      css += `
        body.theme-custom {
          background: linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45)), url('${safeBgImage}') no-repeat center center fixed !important;
          background-size: cover !important;
        }
        body.theme-custom .app-layout {
          background: transparent !important;
        }
        body.theme-custom .main-content {
          background: transparent !important;
        }
        body.theme-custom .sidebar {
          background: color-mix(in srgb, var(--bg-panel) 80%, transparent) !important;
        }
      `;
    }

    // 3. Apple-style Liquid Glass overrides - MUST COME LAST to override modern layout solid styles
    if (colors.glassEnabled) {
      // Sanitize the user-chosen glass background colour (hex only) to keep it
      // safe to interpolate into the generated stylesheet.
      const safeGlassBg = /^#[0-9a-fA-F]{3,8}$/.test(colors.glassBg || '') ? colors.glassBg : '#0b0c14';
      css += `
        /* Clean, highly-transparent Apple "Liquid Glass" surfaces */
        body.theme-custom-glass {
          background: ${safeBgImage ? `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4)), url('${safeBgImage}') no-repeat center center fixed !important` : `
            radial-gradient(135% 135% at 14% -10%, color-mix(in srgb, ${safeGlassBg} 62%, #ffffff 38%), transparent 56%),
            radial-gradient(130% 130% at 100% 8%, color-mix(in srgb, ${safeGlassBg} 70%, #8ab4ff 30%), transparent 55%),
            radial-gradient(140% 140% at 92% 108%, color-mix(in srgb, ${safeGlassBg} 72%, #000000 28%), transparent 60%),
            ${safeGlassBg} !important`};
          background-size: cover !important;
          background-attachment: fixed !important;

          /* Neutralize baseline colors (Steam Green, etc.) at the token/variable level */
          --bg-dark: transparent !important;
          --bg-main: transparent !important;
          --bg-panel: rgba(255, 255, 255, 0.05) !important;
          --bg-btn: rgba(255, 255, 255, 0.08) !important;
          --border-light: rgba(255, 255, 255, 0.2) !important;
          --border-dark: rgba(0, 0, 0, 0.15) !important;
          --green: #ffffff !important;
          --green-dim: rgba(255, 255, 255, 0.6) !important;
          --text: #ffffff !important;
          --text-muted: rgba(255, 255, 255, 0.5) !important;
          --status-online: #ffffff !important;
        }
        body.theme-custom-glass .titlebar {
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%) !important;
          backdrop-filter: blur(28px) saturate(180%) brightness(1.08) !important;
          -webkit-backdrop-filter: blur(28px) saturate(180%) brightness(1.08) !important;
          border-bottom: 1px solid rgba(255, 255, 255, 0.18) !important;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.32) !important;
          border-radius: 0 !important;
        }

        body.theme-custom-glass .app-layout,
        body.theme-custom-glass .main-content {
          background: transparent !important;
        }

        body.theme-custom-glass .panel-header {
          border-bottom: 1px solid rgba(255, 255, 255, 0.15) !important;
        }

        body.theme-custom-glass .sidebar-logo {
          border-bottom: 1px solid rgba(255, 255, 255, 0.15) !important;
        }

        /* The network dropdown is a popup: it has to hide what it covers.
           It takes its fill from --bg-panel, which glass redefines to
           rgba(255,255,255,0.05) — so under this theme it turned into a
           near-invisible sheet with the ROOMS and PEOPLE buttons reading
           straight through it. Blur alone would not fix that; high-contrast
           text stays legible through a blur. It needs an actual fill, so this
           mixes one from the theme's own glass colour and keeps the frost
           behind it. */
        body.theme-custom-glass .network-menu {
          background: color-mix(in srgb, ${safeGlassBg} 86%, #ffffff 14%) !important;
          backdrop-filter: blur(24px) saturate(180%) !important;
          -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
          border: 1px solid rgba(255, 255, 255, 0.18) !important;
          border-radius: 14px !important;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55) !important;
        }

        /* Transparent scrollbar under custom glass theme */
        body.theme-custom-glass .tab-panel {
          box-sizing: border-box !important;
        }
        body.theme-custom-glass .tab-panel:not(#tab-rooms):not(#tab-people) {
          padding: 14px 16px 10px 24px !important;
        }
        body.theme-custom-glass #tab-rooms,
        body.theme-custom-glass #tab-people {
          padding: 14px 14px 10px 14px !important;
        }
        body.theme-custom-glass ::-webkit-scrollbar {
          background: transparent !important;
          width: 8px !important;
        }
        body.theme-custom-glass ::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.18) !important;
          border-radius: 4px !important;
        }
        body.theme-custom-glass ::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.3) !important;
        }

        /* Force single border pixel thickness on status cards to restore rounded corners */
        body.theme-custom-glass .qs-card {
          border-left: 1px solid rgba(255, 255, 255, 0.30) !important;
        }

        /* Contrast fix for mode switches across all custom theme configurations */
        body.theme-custom .mode-btn.active {
          color: var(--bg-dark) !important;
        }

        /* Glassmorphic mode toggle wrapper and action buttons */
        body.theme-custom-glass .mode-toggle-wrap {
          position: relative !important;
          z-index: 1 !important;
          background: rgba(0, 0, 0, 0.25) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          border-radius: 20px !important;
          padding: 3px !important;
          display: inline-flex !important;
          gap: 4px !important;
          box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.4) !important;
        }
        html body.theme-custom-glass .mode-btn {
          position: relative !important;
          z-index: 2 !important;
          width: 80px !important;
          text-align: center !important;
          border-radius: 16px !important;
          border: none !important;
          background: transparent !important;
          color: rgba(255, 255, 255, 0.6) !important;
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
          padding: 6px 0 !important;
          font-size: 10px !important;
          font-weight: 700 !important;
        }
        html body.theme-custom-glass .mode-btn.active {
          background: transparent !important;
          color: #ffffff !important;
          box-shadow: none !important;
        }
        html body.theme-custom-glass .mode-btn:hover:not(.active) {
          color: #ffffff !important;
          background: rgba(255, 255, 255, 0.05) !important;
          border-radius: 16px !important;
        }
        body.theme-custom-glass .mode-slider {
          display: block !important;
          position: absolute !important;
          top: 3px !important;
          bottom: 3px !important;
          left: 3px !important;
          width: 80px !important;
          border-radius: 16px !important;
          background: rgba(255, 255, 255, 0.2) !important;
          box-shadow: 
            inset 0 1px 0 rgba(255, 255, 255, 0.3),
            0 2px 8px rgba(255, 255, 255, 0.1) !important;
          transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
          z-index: 1 !important;
        }

        html body.theme-custom-glass .version-tag {
          background: rgba(255, 255, 255, 0.05) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          border-radius: 8px !important;
          color: #ffffff !important;
          box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.1) !important;
          backdrop-filter: blur(5px) !important;
        }

        body.theme-custom-glass.theme-custom-modern .bevel-outset,
        body.theme-custom-glass.theme-custom-modern .launch-panel,
        body.theme-custom-glass.theme-custom-modern .download-section,
        body.theme-custom-glass.theme-custom-modern .qs-card,
        body.theme-custom-glass.theme-custom-modern .log-output,
        body.theme-custom-glass.theme-custom-modern .settings-group,
        body.theme-custom-glass.theme-custom-modern .modal-box,
        body.theme-custom-glass.theme-custom-modern .tab-panel {
          border-radius: 18px !important;
        }

        body.theme-custom-glass .bevel-outset,
        body.theme-custom-glass .bevel-inset,
        body.theme-custom-glass .launch-panel,
        body.theme-custom-glass .download-section,
        body.theme-custom-glass .qs-card,
        body.theme-custom-glass .log-output,
        body.theme-custom-glass .settings-group,
        body.theme-custom-glass .modal-box,
        body.theme-custom-glass .tab-panel {
          position: relative !important;
          /* Thin, highly-transparent tint so the background colour reads through cleanly */
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.035) 45%, rgba(255, 255, 255, 0.012) 100%) !important;
          /* Clean, smooth frost — no grain. Saturation/brightness make it pick up colour. */
          backdrop-filter: blur(32px) saturate(185%) brightness(1.08) !important;
          -webkit-backdrop-filter: blur(32px) saturate(185%) brightness(1.08) !important;
          border: 1px solid rgba(255, 255, 255, 0.14) !important;
          border-radius: 26px !important;
          box-shadow:
            /* crisp specular rim along the lit (top) edge */
            inset 0 1px 0.5px rgba(255, 255, 255, 0.75),
            inset 0 0 0 1px rgba(255, 255, 255, 0.05),
            /* soft inner glow from the top = glass thickness */
            inset 0 18px 40px -30px rgba(255, 255, 255, 0.5),
            /* darker inner shade at the bottom edge = depth */
            inset 0 -1px 0.5px rgba(0, 0, 0, 0.22),
            inset 0 -16px 32px -30px rgba(0, 0, 0, 0.35),
            /* layered contact shadow so the panel floats */
            0 2px 8px -3px rgba(0, 0, 0, 0.45),
            0 16px 40px -14px rgba(0, 0, 0, 0.55) !important;
        }

        /* Specular sheen layer — the light catching the curved top of the glass.
           Limited to non-scrolling panels so it never sits over scrolled content. */
        body.theme-custom-glass .launch-panel::after,
        body.theme-custom-glass .download-section::after,
        body.theme-custom-glass .qs-card::after,
        body.theme-custom-glass .settings-group::after,
        body.theme-custom-glass .modal-box::after {
          content: '' !important;
          position: absolute !important;
          inset: 0 !important;
          border-radius: inherit !important;
          pointer-events: none !important;
          z-index: 0 !important;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.18) 0%, rgba(255, 255, 255, 0.03) 14%, transparent 32%),
            radial-gradient(120% 70% at 18% -20%, rgba(255, 255, 255, 0.14), transparent 50%) !important;
          mix-blend-mode: screen !important;
        }
        /* Keep real content above the sheen layer. */
        body.theme-custom-glass .launch-panel > *,
        body.theme-custom-glass .download-section > *,
        body.theme-custom-glass .qs-card > *,
        body.theme-custom-glass .settings-group > *,
        body.theme-custom-glass .modal-box > * {
          position: relative !important;
          z-index: 1 !important;
        }

        /* ── Download progress panel — glass treatment ─────────────────
           The base rules colour the phase-step badges with var(--bg-dark)
           for the number, but glass sets --bg-dark to transparent, which
           makes the active/done step numbers invisible. Restyle the whole
           progress panel with explicit glass tokens instead. */
        body.theme-custom-glass .dl-progress-block {
          background: rgba(255, 255, 255, 0.045) !important;
          border: 1px solid rgba(255, 255, 255, 0.14) !important;
          border-radius: 16px !important;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28) !important;
        }
        body.theme-custom-glass .dlp-phase { color: #ffffff !important; }
        body.theme-custom-glass .dlp-pct { color: #ffffff !important; }
        body.theme-custom-glass .dlp-dot {
          background: #ffffff !important;
          border-radius: 50% !important;
          box-shadow: 0 0 9px rgba(255, 255, 255, 0.85) !important;
          animation: dlp-pulse 1s ease-in-out infinite !important;
        }
        body.theme-custom-glass .dlp-bar-wrap {
          background: rgba(0, 0, 0, 0.22) !important;
          border: 1px solid rgba(255, 255, 255, 0.14) !important;
          border-radius: 8px !important;
        }
        /* Smooth liquid fill instead of the retro dashed bar */
        body.theme-custom-glass .dlp-bar-fill {
          background: linear-gradient(90deg, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.65)) !important;
          border-radius: 6px !important;
          box-shadow: 0 0 10px rgba(255, 255, 255, 0.4) !important;
        }
        body.theme-custom-glass .dlp-step,
        body.theme-custom-glass .dlp-stat {
          background: rgba(255, 255, 255, 0.06) !important;
          border: 1px solid rgba(255, 255, 255, 0.12) !important;
          border-radius: 10px !important;
        }
        body.theme-custom-glass .dlp-step { opacity: 0.6 !important; }
        body.theme-custom-glass .dlp-step.active,
        body.theme-custom-glass .dlp-step.done { opacity: 1 !important; }
        body.theme-custom-glass .dlp-step.active {
          color: #ffffff !important;
          background: rgba(255, 255, 255, 0.13) !important;
          border-color: rgba(255, 255, 255, 0.4) !important;
        }
        body.theme-custom-glass .dlp-step.done { color: rgba(255, 255, 255, 0.85) !important; }
        body.theme-custom-glass .dlp-step-idx {
          background: rgba(255, 255, 255, 0.16) !important;
          color: rgba(255, 255, 255, 0.85) !important;
          border: 1px solid rgba(255, 255, 255, 0.22) !important;
        }
        body.theme-custom-glass .dlp-step.active .dlp-step-idx {
          background: #ffffff !important;
          color: #1c2a44 !important;
          border-color: #ffffff !important;
        }
        body.theme-custom-glass .dlp-step.done .dlp-step-idx {
          background: rgba(255, 255, 255, 0.6) !important;
          color: #1c2a44 !important;
          border-color: rgba(255, 255, 255, 0.6) !important;
        }
        body.theme-custom-glass .dlp-stat-label { color: rgba(255, 255, 255, 0.55) !important; }
        body.theme-custom-glass .dlp-stat-val { color: #ffffff !important; }

        /* Docked Sidebar Glass Override (no double border/corners against window edge) */
        body.theme-custom-glass .sidebar {
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.025) 100%) !important;
          backdrop-filter: blur(28px) saturate(180%) brightness(1.08) !important;
          -webkit-backdrop-filter: blur(28px) saturate(180%) brightness(1.08) !important;
          border: none !important;
          border-right: 1px solid rgba(255, 255, 255, 0.18) !important;
          border-radius: 0 !important;
          box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.12), 4px 0 24px -8px rgba(0, 0, 0, 0.4) !important;
        }

        /* Glassmorphic input controls inside panels */
        html body.theme-custom-glass .cfg-input,
        html body.theme-custom-glass .cfg-select,
        html body.theme-custom-glass select,
        html body.theme-custom-glass input[type="text"],
        html body.theme-custom-glass input[type="number"],
        html body.theme-custom-glass textarea {
          background: rgba(0, 0, 0, 0.25) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          border-radius: 8px !important;
          color: #ffffff !important;
          box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.4) !important;
          backdrop-filter: blur(5px) !important;
          transition: all 0.2s ease !important;
        }
        html body.theme-custom-glass select option {
          background: #16181f !important;
          color: #ffffff !important;
        }
        html body.theme-custom-glass .cfg-input:focus,
        html body.theme-custom-glass .cfg-select:focus,
        html body.theme-custom-glass select:focus,
        html body.theme-custom-glass input[type="text"]:focus,
        html body.theme-custom-glass input[type="number"]:focus,
        html body.theme-custom-glass textarea:focus {
          border-color: rgba(255, 255, 255, 0.4) !important;
          box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.4), 0 0 8px rgba(255, 255, 255, 0.2) !important;
          outline: none !important;
        }

        /* Console log output translucent overlay */
        body.theme-custom-glass .log-output {
          background: rgba(0, 0, 0, 0.35) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.5) !important;
          backdrop-filter: blur(10px) !important;
        }

        /* Small titlebar traffic-light buttons */
        body.theme-custom-glass .titlebar-controls {
          display: flex !important;
          gap: 6px !important;
          align-items: center !important;
          margin-right: 8px !important;
        }
        body.theme-custom-glass .tb-ctrl {
          border-radius: 50% !important;
          aspect-ratio: 1/1 !important;
          width: 12px !important;
          height: 12px !important;
          padding: 0 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          margin: 0 !important;
        }
        body.theme-custom-glass .tb-ctrl.cls {
          order: 3 !important;
        }
        body.theme-custom-glass .tb-ctrl.min {
          order: 1 !important;
        }
        body.theme-custom-glass .tb-ctrl.max {
          order: 2 !important;
        }

        /* Glassmorphic buttons styling: 3D jelly/liquid capsule look */
        html body.theme-custom-glass .btn-download-big,
        html body.theme-custom-glass .btn-play,
        html body.theme-custom-glass .btn-refresh,
        html body.theme-custom-glass .btn-save,
        html body.theme-custom-glass .btn-test-server,
        html body.theme-custom-glass .btn-cancel-dl,
        html body.theme-custom-glass .btn-kill,
        html body.theme-custom-glass .btn-open-folder,
        html body.theme-custom-glass .btn-reinstall,
        html body.theme-custom-glass .btn-uninstall,
        html body.theme-custom-glass .modal-btn,
        html body.theme-custom-glass .nav-btn,
        html body.theme-custom-glass .btn-exclude-av,
        html body.theme-custom-glass .filter-btn,
        html body.theme-custom-glass .sort-btn,
        html body.theme-custom-glass .launch-secondary-actions button {
          border-radius: 30px !important;
          background: 
            linear-gradient(to bottom, 
              rgba(255, 255, 255, 0.2) 0%, 
              rgba(255, 255, 255, 0.05) 48%, 
              rgba(0, 0, 0, 0.08) 50%, 
              rgba(0, 0, 0, 0.03) 52%, 
              rgba(255, 255, 255, 0.1) 100%
            ),
            rgba(255, 255, 255, 0.03) !important;
          backdrop-filter: blur(20px) saturate(160%) !important;
          -webkit-backdrop-filter: blur(20px) saturate(160%) !important;
          border: 1px solid rgba(255, 255, 255, 0.25) !important;
          box-shadow: 
            0 0 0 1.5px rgba(255, 255, 255, 0.08),
            inset 0 0 0 1px rgba(255, 255, 255, 0.15),
            inset 0 1.5px 0 rgba(255, 255, 255, 0.45), 
            inset 0 -1.5px 0 rgba(0, 0, 0, 0.1), 
            0 4px 12px 0 rgba(0, 0, 0, 0.15) !important;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1) !important;
          color: #ffffff !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3) !important;
          font-weight: 700 !important;
          letter-spacing: 0.3px !important;
        }

        /* Action buttons hover states: hyper-glossy and glowing */
        html body.theme-custom-glass .btn-download-big:hover,
        html body.theme-custom-glass .btn-play:hover,
        html body.theme-custom-glass .btn-refresh:hover,
        html body.theme-custom-glass .btn-save:hover,
        html body.theme-custom-glass .btn-test-server:hover,
        html body.theme-custom-glass .btn-cancel-dl:hover,
        html body.theme-custom-glass .btn-kill:hover,
        html body.theme-custom-glass .btn-open-folder:hover,
        html body.theme-custom-glass .btn-reinstall:hover,
        html body.theme-custom-glass .btn-uninstall:hover,
        html body.theme-custom-glass .modal-btn:hover,
        html body.theme-custom-glass .nav-btn:hover,
        html body.theme-custom-glass .btn-exclude-av:hover,
        html body.theme-custom-glass .filter-btn:hover,
        html body.theme-custom-glass .sort-btn:hover,
        html body.theme-custom-glass .launch-secondary-actions button:hover {
          background: 
            linear-gradient(to bottom, 
              rgba(255, 255, 255, 0.45) 0%, 
              rgba(255, 255, 255, 0.15) 48%, 
              rgba(0, 0, 0, 0.05) 50%, 
              rgba(0, 0, 0, 0.01) 52%, 
              rgba(255, 255, 255, 0.2) 100%
            ),
            rgba(255, 255, 255, 0.08) !important;
          border-color: rgba(255, 255, 255, 0.4) !important;
          box-shadow: 
            0 0 0 1.5px rgba(255, 255, 255, 0.12),
            inset 0 0 0 1px rgba(255, 255, 255, 0.2),
            inset 0 1.5px 0 rgba(255, 255, 255, 0.55),
            inset 0 -1px 0 rgba(0, 0, 0, 0.05),
            0 0 15px rgba(255, 255, 255, 0.1),
            0 6px 16px rgba(0, 0, 0, 0.2) !important;
          transform: translateY(-1.5px) scale(1.01) !important;
        }

        /* Action buttons active press (visual depress) */
        html body.theme-custom-glass .btn-download-big:active,
        html body.theme-custom-glass .btn-play:active,
        html body.theme-custom-glass .btn-refresh:active,
        html body.theme-custom-glass .btn-save:active,
        html body.theme-custom-glass .btn-test-server:active,
        html body.theme-custom-glass .btn-cancel-dl:active,
        html body.theme-custom-glass .btn-kill:active,
        html body.theme-custom-glass .btn-open-folder:active,
        html body.theme-custom-glass .btn-reinstall:active,
        html body.theme-custom-glass .btn-uninstall:active,
        html body.theme-custom-glass .modal-btn:active,
        html body.theme-custom-glass .nav-btn:active,
        html body.theme-custom-glass .btn-exclude-av:active,
        html body.theme-custom-glass .filter-btn:active,
        html body.theme-custom-glass .sort-btn:active,
        html body.theme-custom-glass .launch-secondary-actions button:active {
          background: 
            linear-gradient(to bottom, 
              rgba(0, 0, 0, 0.1) 0%, 
              rgba(0, 0, 0, 0.03) 48%, 
              rgba(255, 255, 255, 0.03) 50%, 
              rgba(255, 255, 255, 0.1) 100%
            ),
            rgba(255, 255, 255, 0.02) !important;
          box-shadow: 
            0 0 0 1.5px rgba(255, 255, 255, 0.08),
            inset 0 0 0 1px rgba(255, 255, 255, 0.1),
            inset 2.5px 6px rgba(0, 0, 0, 0.35),
            inset 0 -1px 0 rgba(255, 255, 255, 0.05),
            0 2px 4px rgba(0, 0, 0, 0.1) !important;
          transform: translateY(1px) scale(0.98) !important;
        }

        /* Sidebar Navigation, filter & sort buttons */
        html body.theme-custom-glass .nav-btn {
          margin: 4px 0 !important;
          padding: 8px 12px !important;
          box-sizing: border-box !important;
          width: 100% !important;
        }
        html body.theme-custom-glass .nav-btn.active,
        html body.theme-custom-glass .filter-btn.active,
        html body.theme-custom-glass .sort-btn.active {
          background: 
            linear-gradient(to bottom, 
              rgba(255, 255, 255, 0.35) 0%, 
              rgba(255, 255, 255, 0.1) 48%, 
              rgba(0, 0, 0, 0.08) 50%, 
              rgba(255, 255, 255, 0.15) 100%
            ),
            rgba(255, 255, 255, 0.12) !important;
          border-color: rgba(255, 255, 255, 0.45) !important;
          box-shadow: 
            0 0 0 1.5px rgba(255, 255, 255, 0.15),
            inset 0 0 0 1px rgba(255, 255, 255, 0.3),
            inset 0 1.5px 0 rgba(255, 255, 255, 0.55),
            inset 0 -1.5px 0 rgba(0, 0, 0, 0.15),
            0 0 15px rgba(255, 255, 255, 0.15),
            0 4px 12px 0 rgba(0, 0, 0, 0.20) !important;
          font-weight: bold !important;
          color: #ffffff !important;
        }

        /* Premium specular "shine sweep" that glides across buttons on hover */
        html body.theme-custom-glass .btn-download-big,
        html body.theme-custom-glass .btn-play,
        html body.theme-custom-glass .btn-refresh,
        html body.theme-custom-glass .btn-save,
        html body.theme-custom-glass .btn-test-server,
        html body.theme-custom-glass .modal-btn,
        html body.theme-custom-glass .nav-btn,
        html body.theme-custom-glass .btn-exclude-av {
          position: relative !important;
          overflow: hidden !important;
        }
        html body.theme-custom-glass .btn-download-big::after,
        html body.theme-custom-glass .btn-play::after,
        html body.theme-custom-glass .btn-refresh::after,
        html body.theme-custom-glass .btn-save::after,
        html body.theme-custom-glass .btn-test-server::after,
        html body.theme-custom-glass .modal-btn::after,
        html body.theme-custom-glass .nav-btn::after,
        html body.theme-custom-glass .btn-exclude-av::after {
          content: '' !important;
          position: absolute !important;
          top: 0 !important;
          left: -160% !important;
          width: 55% !important;
          height: 100% !important;
          background: linear-gradient(100deg, transparent 0%, rgba(255, 255, 255, 0.45) 50%, transparent 100%) !important;
          transform: skewX(-22deg) !important;
          transition: left 0.65s cubic-bezier(0.22, 1, 0.36, 1) !important;
          pointer-events: none !important;
          z-index: 3 !important;
        }
        html body.theme-custom-glass .btn-download-big:hover::after,
        html body.theme-custom-glass .btn-play:hover::after,
        html body.theme-custom-glass .btn-refresh:hover::after,
        html body.theme-custom-glass .btn-save:hover::after,
        html body.theme-custom-glass .btn-test-server:hover::after,
        html body.theme-custom-glass .modal-btn:hover::after,
        html body.theme-custom-glass .nav-btn:hover::after,
        html body.theme-custom-glass .btn-exclude-av:hover::after {
          left: 160% !important;
        }
      `;
    }

    // Cached for the next launch. boot.js replays both this and the palette
    // before the first paint; without them a custom theme renders as bare
    // `theme-custom`, which has no rules of its own and so falls through to
    // the :root defaults — the Steam 2003 Green palette. That was the skin
    // flashing up for a moment on every start.
    try {
      localStorage.setItem('radium-custom-css', css);
      localStorage.setItem(
        'radium-custom-classes',
        document.body.className.split(' ').filter(c => c.startsWith('theme-')).join(' ')
      );
    } catch (e) {}

    const style = document.createElement('style');
    style.id = 'custom-theme-style';
    style.textContent = css;
    document.head.appendChild(style);
  } else if (theme && theme !== 'steam-green') {
    document.body.classList.add('theme-' + theme);
  }

  const anims = getToggle('tgl-enableAnimations');
  if (anims) {
    document.body.classList.add('animations-enabled');
  }
  try {
    localStorage.setItem('radium-theme', theme || 'steam-green');
    localStorage.setItem('radium-animations', anims ? 'true' : 'false');
  } catch (e) {}
}

function setValue(id, val) { const el = $(id); if (el) el.value = val; }

function setToggle(id, val) {
  const el = $(id); if (!el) return;
  if (val) el.classList.add('on'); else el.classList.remove('on');
}
function getToggle(id) { return $(id)?.classList.contains('on') ?? false; }

['tgl-minimizeOnLaunch', 'tgl-closeOnLaunch', 'tgl-autoUpdate', 'tgl-enableAnimations', 'tgl-disableWarnings'].forEach(id =>
  $(id)?.addEventListener('click', () => {
    $(id).classList.toggle('on');
    if (id === 'tgl-enableAnimations') {
      const enabled = $(id).classList.contains('on');
      if (enabled) {
        document.body.classList.add('animations-enabled');
      } else {
        document.body.classList.remove('animations-enabled');
      }
      try {
        localStorage.setItem('radium-animations', enabled ? 'true' : 'false');
      } catch (e) {}
    }
    autoSaveSettings();
  })
);

// Auto-saves only the theme-related fields without touching other settings.
// Called whenever the theme changes so the choice survives restarts without
// the user needing to click "Save Settings".
async function autoSaveTheme(newTheme, customColors) {
  if (!config || Object.keys(config).length === 0) return; // config not loaded yet
  const updated = {
    ...config,
    theme:         newTheme,
    baselineTheme: customColors ? (config.baselineTheme || 'steam-green') : newTheme,
    customTheme:   customColors || config.customTheme,
  };
  try {
    const ok = await window.radium?.saveConfig(updated);
    if (ok) config = updated;
  } catch (e) {
    console.warn('autoSaveTheme: failed to persist', e);
  }
}

// Debounced variant for high-frequency sources (color pickers fire 'input'
// continuously while dragging — each save is an IPC call + a config.json
// write, so persisting on every tick would hammer the disk).
let _themeSaveTimer = null;
function debouncedAutoSaveTheme(newTheme, customColors) {
  clearTimeout(_themeSaveTimer);
  _themeSaveTimer = setTimeout(() => autoSaveTheme(newTheme, customColors), 800);
}

$('cfgTheme')?.addEventListener('change', () => {
  const selectedTheme = $('cfgTheme').value;
  applyTheme(selectedTheme);
  autoSaveTheme(selectedTheme, null);
});

// Persists just the font pack, same shape as autoSaveTheme: the choice
// should survive a restart without the user hitting "Save Settings".
async function autoSaveFont(newFont) {
  if (!config || Object.keys(config).length === 0) return; // config not loaded yet
  try {
    const ok = await window.radium?.saveConfig({ ...config, font: newFont });
    if (ok) {
      // Merge onto whatever `config` holds *now*, not onto the snapshot taken
      // before the await. Three functions write the whole config (this one,
      // autoSaveTheme, autoSaveSettings); assigning a pre-await snapshot would
      // roll back any field a save that resolved in the meantime had set.
      config = { ...config, font: newFont };
    } else {
      // A `false` return is a validation refusal from cmd_save_config, not an
      // exception, so the catch below never sees it. Say so — the pack is
      // applied to the DOM either way, and staying silent means the user finds
      // out only when it reverts on the next launch.
      console.warn('autoSaveFont: backend rejected the config write');
      reportFontSaveFailure();
    }
  } catch (e) {
    console.warn('autoSaveFont: failed to persist', e);
    reportFontSaveFailure();
  }
}

// Mirrors how autoSaveSettings reports a failed write: a line in the Logs tab
// so it is discoverable after the fact, and an indicator that fades rather
// than sticking on screen.
function reportFontSaveFailure() {
  addLog('Font change could not be saved — it will revert on restart.', 'error');
  showAutosaveIndicator('error', '✕ Font not saved');
  setTimeout(() => {
    const el = $('autosaveIndicator');
    if (el) el.classList.remove('visible');
  }, 2000);
}

$('cfgFont')?.addEventListener('change', () => {
  const selectedFont = applyFont($('cfgFont').value);
  autoSaveFont(selectedFont);
});

$('tgl-customTheme')?.addEventListener('click', () => {
  const customOn = !getToggle('tgl-customTheme');
  setToggle('tgl-customTheme', customOn);
  
  setCustomThemeEditorOpen(customOn);

  const cfgThemeSelect = $('cfgTheme');
  if (cfgThemeSelect) {
    cfgThemeSelect.disabled = customOn;
    const parent = cfgThemeSelect.closest('div');
    if (parent) {
      parent.style.opacity = customOn ? '0.5' : '1';
      parent.style.pointerEvents = customOn ? 'none' : 'auto';
    }
  }

  if (customOn) {
    updateCustomThemeFromUI();
    // persisting happens inside updateCustomThemeFromUI (debounced)
  } else {
    const selectedTheme = $('cfgTheme').value || 'steam-green';
    applyTheme(selectedTheme);
    autoSaveTheme(selectedTheme, null);
  }
});

/// Rebuild the custom theme from the editor controls.
///
/// `colorsOnly` marks the changes that touch nothing but the eleven palette
/// variables — i.e. the colour pickers. Those take the cheap path that rewrites
/// only the palette sheet. Anything structural (style base, Liquid Glass, a
/// background image, loading a template) still rebuilds the whole stylesheet,
/// because those change the rules themselves and not just their inputs.
function updateCustomThemeFromUI(colorsOnly = false) {
  const isModern = $('styleBaseModern')?.checked === true;
  const customColors = {
    bgDark:       $('theme-bgDark')?.value || '#21281e',
    bgMain:       $('theme-bgMain')?.value || '#384232',
    bgPanel:      $('theme-bgPanel')?.value || '#4b5845',
    bgBtn:        $('theme-bgBtn')?.value || '#5e6d56',
    borderLight:  $('theme-borderLight')?.value || '#829478',
    borderDark:   $('theme-borderDark')?.value || '#1b2118',
    green:         $('theme-green')?.value || '#00ff00',
    greenDim:     $('theme-greenDim')?.value || '#7ca969',
    text:         $('theme-text')?.value || '#d4e0ce',
    textMuted:    $('theme-textMuted')?.value || '#8da082',
    statusOnline: $('theme-statusOnline')?.value || '#00ff00',
    styleBase:    isModern ? 'modern' : 'retro',
    bgImage:      getBgImageUI(),
    glassEnabled: getToggle('tgl-glassEnabled'),
    glassBg:      $('theme-glassBg')?.value || '#0b0c14'
  };
  config.customTheme = customColors;
  config.baselineTheme = $('cfgTheme')?.value || 'steam-green';
  // Live preview is immediate either way; only the persist is debounced.
  // applyCustomThemeColors returns false if there is no palette sheet yet
  // (custom theme not applied), in which case the full build has to run.
  if (!colorsOnly || !applyCustomThemeColors(customColors)) {
    applyTheme('custom');
  }
  debouncedAutoSaveTheme('custom', customColors);
}

const THEME_PRESETS = {
  'steam-green': {
    bgDark:      '#21281e',
    bgMain:      '#384232',
    bgPanel:     '#4b5845',
    bgBtn:       '#5e6d56',
    borderLight: '#829478',
    borderDark:  '#1b2118',
    green:        '#00ff00',
    greenDim:    '#7ca969',
    text:         '#d4e0ce',
    textMuted:   '#8da082',
    statusOnline:'#00ff00'
  },
  'win98': {
    bgDark:      '#ffffff',
    bgMain:      '#d4d0c8',
    bgPanel:     '#d4d0c8',
    bgBtn:       '#d4d0c8',
    borderLight: '#ffffff',
    borderDark:  '#808080',
    green:        '#000080',
    greenDim:    '#404040',
    text:         '#000000',
    textMuted:   '#555555',
    statusOnline:'#008000'
  },
  'win95': {
    bgDark:      '#008080',
    bgMain:      '#c0c0c0',
    bgPanel:     '#c0c0c0',
    bgBtn:       '#c0c0c0',
    borderLight: '#ffffff',
    borderDark:  '#808080',
    green:       '#000080',
    greenDim:    '#000000',
    text:        '#000000',
    textMuted:   '#555555',
    statusOnline:'#008000'
  },
  'winxp': {
    bgDark:      '#ffffff',
    bgMain:      '#d8e4f8',
    bgPanel:     '#ece9d8',
    bgBtn:       '#ece9d8',
    borderLight: '#ffffff',
    borderDark:  '#aca899',
    green:        '#0054e3',
    greenDim:    '#7a96df',
    text:         '#000000',
    textMuted:   '#555555',
    statusOnline:'#008000'
  },
  'royalenoir': {
    bgDark:      '#1c1c1c',
    bgMain:      '#2b2b2b',
    bgPanel:     '#3a3a3a',
    bgBtn:       '#4c4c4c',
    borderLight: '#606060',
    borderDark:  '#141414',
    green:       '#3b93ff',
    greenDim:    '#5285e9',
    text:        '#ffffff',
    textMuted:   '#b0b0b0',
    statusOnline:'#00d000'
  },
  'winvista': {
    bgDark:      '#e2e8f0',
    bgMain:      '#1f2d3d',
    bgPanel:     '#e2e8f0',
    bgBtn:       '#f1f5f9',
    borderLight: '#ffffff',
    borderDark:  '#708090',
    green:       '#0055cc',
    greenDim:    '#004488',
    text:        '#1a2a3a',
    textMuted:   '#3b4d5e',
    statusOnline:'#008000'
  },
  'win7': {
    bgDark:      '#f0f3f7',
    bgMain:      '#edf2f8',
    bgPanel:     '#ffffff',
    bgBtn:       '#f2f6fa',
    borderLight: '#dbe4f0',
    borderDark:  '#a3b8cc',
    green:       '#1068c8',
    greenDim:    '#0a4b96',
    text:        '#000000',
    textMuted:   '#555555',
    statusOnline:'#0a8a0a'
  },
  'macosclassic': {
    bgDark:      '#dddddd',
    bgMain:      '#cccccc',
    bgPanel:     '#cccccc',
    bgBtn:       '#e2e2e2',
    borderLight: '#ffffff',
    borderDark:  '#949494',
    green:       '#000000',
    greenDim:    '#4c4c4c',
    text:        '#000000',
    textMuted:   '#505050',
    statusOnline:'#007a00'
  },
  'moderndark': {
    bgDark:      '#0d0f12',
    bgMain:      '#161a22',
    bgPanel:     '#212630',
    bgBtn:       '#2d3342',
    borderLight: '#3d4559',
    borderDark:  '#08090a',
    green:        '#00f0ff',
    greenDim:    '#009bb3',
    text:         '#e2e8f0',
    textMuted:   '#8a99ad',
    statusOnline:'#10b981'
  },
  'modernlight': {
    bgDark:      '#f1f5f9',
    bgMain:      '#f8fafc',
    bgPanel:     '#ffffff',
    bgBtn:       '#f1f5f9',
    borderLight: '#e2e8f0',
    borderDark:  '#cbd5e1',
    green:        '#3b82f6',
    greenDim:    '#60a5fa',
    text:         '#0f172a',
    textMuted:   '#64748b',
    statusOnline:'#10b981'
  },
  'moderngreen': {
    bgDark:      '#070b07',
    bgMain:      '#0d140d',
    bgPanel:     '#131e13',
    bgBtn:       '#10b981',
    borderLight: '#223322',
    borderDark:  '#050705',
    green:       '#10b981',
    greenDim:    '#34d399',
    text:        '#f0fdf4',
    textMuted:   '#4ade80',
    statusOnline:'#10b981'
  },
  'blackandwhite': {
    bgDark:      '#050505',
    bgMain:      '#0d0d0d',
    bgPanel:     '#141414',
    bgBtn:       '#ffffff',
    borderLight: '#262626',
    borderDark:  '#090909',
    green:       '#ffffff',
    greenDim:    '#bbbbbb',
    text:        '#ffffff',
    textMuted:   '#888888',
    statusOnline:'#ffffff'
  },
  'steam2010': {
    bgDark:      '#2b2b2b',
    bgMain:      '#3a3a3a',
    bgPanel:     '#46494d',
    bgBtn:       '#54585d',
    borderLight: '#5a5d61',
    borderDark:  '#1d1d1d',
    green:       '#8ab4cf',
    greenDim:    '#6c93ab',
    text:        '#d6d6d6',
    textMuted:   '#8a8a8a',
    statusOnline:'#8bc34a'
  },
  'macosaqua': {
    bgDark:      '#d9d9d9',
    bgMain:      '#ececec',
    bgPanel:     '#ffffff',
    bgBtn:       '#f2f2f2',
    borderLight: '#ffffff',
    borderDark:  '#9b9b9b',
    green:       '#1f6feb',
    greenDim:    '#2a6fd0',
    text:        '#1a1a1a',
    textMuted:   '#666666',
    statusOnline:'#28c840'
  },
  'recroom': {
    bgDark:      '#ffe9c6',
    bgMain:      '#ffdfb0',
    bgPanel:     '#fff6e6',
    bgBtn:       '#ffffff',
    borderLight: '#ffffff',
    borderDark:  '#c9963f',
    green:       '#ff7a1a',
    greenDim:    '#e8650a',
    text:        '#3a2a14',
    textMuted:   '#8a6a3a',
    statusOnline:'#33ab43'
  }
};

$('themeTemplateSelect')?.addEventListener('change', () => {
  const presetKey = $('themeTemplateSelect').value;
  const colors = THEME_PRESETS[presetKey];
  if (colors) {
    const keys = ['bgDark', 'bgMain', 'bgPanel', 'bgBtn', 'borderLight', 'borderDark', 'green', 'greenDim', 'text', 'textMuted', 'statusOnline'];
    keys.forEach(k => {
      const el = $('theme-' + k);
      if (el) el.value = colors[k];
    });

    const isModern = presetKey.startsWith('modern');
    if (isModern) {
      if ($('styleBaseModern')) $('styleBaseModern').checked = true;
    } else {
      if ($('styleBaseRetro')) $('styleBaseRetro').checked = true;
    }
    updateStyleBaseLocks(getToggle('tgl-glassEnabled'));

    updateCustomThemeFromUI();

    // Snap back to the placeholder. This copies a palette once; it does not
    // track anything. Leaving the skin's name selected made it look like the
    // theme still *was* that skin, which stopped being true the moment the
    // next colour was changed.
    const label = $('themeTemplateSelect').selectedOptions[0]?.textContent || 'Template';
    $('themeTemplateSelect').value = '';
    toast(`Copied the ${label} colours — edit any of them below.`, 'ok');
  }
});

// Bind color pickers input events for live preview
['theme-bgDark', 'theme-bgMain', 'theme-bgPanel', 'theme-bgBtn', 'theme-borderLight', 'theme-borderDark', 'theme-green', 'theme-greenDim', 'theme-text', 'theme-textMuted', 'theme-statusOnline', 'theme-glassBg'].forEach(id => {
  $(id)?.addEventListener('input', () => {
    if (getToggle('tgl-customTheme')) {
      updateCustomThemeFromUI(true);
    }
  });
});

$('styleBaseRetro')?.addEventListener('change', () => {
  if (getToggle('tgl-customTheme')) updateCustomThemeFromUI();
});
$('styleBaseModern')?.addEventListener('change', () => {
  if (getToggle('tgl-customTheme')) updateCustomThemeFromUI();
});

// Category 4: Background & Glass event listeners
$('theme-bgImage')?.addEventListener('input', (e) => {
  if (e.target.value !== '(Local File Selected)') {
    delete e.target.dataset.localBase64;
  }
  if (getToggle('tgl-customTheme')) {
    updateCustomThemeFromUI();
  }
});

$('btnBrowseBgFile')?.addEventListener('click', () => {
  const picker = $('theme-bgFilePicker');
  if (picker) picker.value = '';
  picker?.click();
});

$('theme-bgFilePicker')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const base64 = event.target.result;
    setBgImageUI(base64);
    if (getToggle('tgl-customTheme')) {
      updateCustomThemeFromUI();
    }
  };
  reader.readAsDataURL(file);
});

$('btnClearBgImage')?.addEventListener('click', () => {
  setBgImageUI('');
  if ($('theme-bgFilePicker')) $('theme-bgFilePicker').value = '';
  if (getToggle('tgl-customTheme')) {
    updateCustomThemeFromUI();
  }
});

$('tgl-glassEnabled')?.addEventListener('click', () => {
  $('tgl-glassEnabled').classList.toggle('on');
  updateStyleBaseLocks(getToggle('tgl-glassEnabled'));
  if (getToggle('tgl-customTheme')) {
    updateCustomThemeFromUI();
  }
});

// Export theme
$('btnExportTheme')?.addEventListener('click', async () => {
  const isModern = $('styleBaseModern')?.checked === true;
  const customColors = {
    bgDark:       $('theme-bgDark')?.value || '#21281e',
    bgMain:       $('theme-bgMain')?.value || '#384232',
    bgPanel:      $('theme-bgPanel')?.value || '#4b5845',
    bgBtn:        $('theme-bgBtn')?.value || '#5e6d56',
    borderLight:  $('theme-borderLight')?.value || '#829478',
    borderDark:   $('theme-borderDark')?.value || '#1b2118',
    green:         $('theme-green')?.value || '#00ff00',
    greenDim:     $('theme-greenDim')?.value || '#7ca969',
    text:         $('theme-text')?.value || '#d4e0ce',
    textMuted:    $('theme-textMuted')?.value || '#8da082',
    statusOnline: $('theme-statusOnline')?.value || '#00ff00',
    styleBase:    isModern ? 'modern' : 'retro',
    bgImage:      getBgImageUI(),
    glassEnabled: getToggle('tgl-glassEnabled'),
    glassBg:      $('theme-glassBg')?.value || '#0b0c14'
  };
  try {
    const jsonStr = JSON.stringify(customColors, null, 2);
    await navigator.clipboard.writeText(jsonStr);
    toast('Custom theme JSON copied to clipboard!', 'ok');
  } catch (e) {
    toast('Failed to export theme.', 'error');
  }
});

// Import theme
$('btnImportTheme')?.addEventListener('click', async () => {
  const input = prompt('Paste custom theme JSON here:');
  if (!input) return;

  try {
    const colors = JSON.parse(input);
    const keys = ['bgDark', 'bgMain', 'bgPanel', 'bgBtn', 'borderLight', 'borderDark', 'green', 'greenDim', 'text', 'textMuted', 'statusOnline'];
    
    // Quick validation
    let valid = true;
    keys.forEach(k => {
      if (!colors[k] || typeof colors[k] !== 'string' || !colors[k].startsWith('#')) {
        valid = false;
      }
    });

    if (!valid) {
      toast('Invalid theme colors format.', 'error');
      return;
    }

    // Set values to inputs
    keys.forEach(k => {
      const el = $('theme-' + k);
      if (el) el.value = colors[k];
    });

    if ($('theme-glassBg') && colors.glassBg) $('theme-glassBg').value = colors.glassBg;

    setBgImageUI(colors.bgImage);
    const glassOn = colors.glassEnabled === true;
    setToggle('tgl-glassEnabled', glassOn);
    updateStyleBaseLocks(glassOn);

    let styleBase = colors.styleBase || 'retro';
    if (glassOn) {
      styleBase = 'modern';
    } else {
      if (styleBase === 'modern') {
        if ($('styleBaseModern')) $('styleBaseModern').checked = true;
      } else {
        if ($('styleBaseRetro')) $('styleBaseRetro').checked = true;
      }
    }

    // Save and apply preview
    config.customTheme = { ...colors, styleBase, bgImage: colors.bgImage || '', glassEnabled: glassOn };
    updateCustomThemeFromUI();
    toast('Theme imported successfully! Click Save to persist.', 'ok');
  } catch (e) {
    toast('Failed to parse theme JSON.', 'error');
  }
});

// Reset custom theme
const resetThemeModal = $('resetThemeModal');
const closeResetThemeModal = () => { if (resetThemeModal) resetThemeModal.style.display = 'none'; };
$('resetThemeCancelBtn')?.addEventListener('click', closeResetThemeModal);
$('resetThemeModalClose')?.addEventListener('click', closeResetThemeModal);
$('resetThemeModal')?.addEventListener('click', (e) => {
  if (e.target === resetThemeModal) closeResetThemeModal();
});

$('btnResetTheme')?.addEventListener('click', () => {
  if (resetThemeModal) resetThemeModal.style.display = 'flex';
});

$('resetThemeConfirmBtn')?.addEventListener('click', async () => {
  closeResetThemeModal();

  const defaults = {
    bgDark:       '#21281e',
    bgMain:       '#384232',
    bgPanel:      '#4b5845',
    bgBtn:        '#5e6d56',
    borderLight:  '#829478',
    borderDark:   '#1b2118',
    green:         '#00ff00',
    greenDim:     '#7ca969',
    text:         '#d4e0ce',
    textMuted:    '#8da082',
    statusOnline: '#00ff00',
    styleBase:    'retro',
    bgImage:      '',
    glassEnabled: false,
    glassBg:      '#0b0c14'
  };

  // Set values to inputs
  setValue('theme-glassBg', defaults.glassBg);
  setValue('theme-bgDark', defaults.bgDark);
  setValue('theme-bgMain', defaults.bgMain);
  setValue('theme-bgPanel', defaults.bgPanel);
  setValue('theme-bgBtn', defaults.bgBtn);
  setValue('theme-borderLight', defaults.borderLight);
  setValue('theme-borderDark', defaults.borderDark);
  setValue('theme-green', defaults.green);
  setValue('theme-greenDim', defaults.greenDim);
  setValue('theme-text', defaults.text);
  setValue('theme-textMuted', defaults.textMuted);
  setValue('theme-statusOnline', defaults.statusOnline);

  setBgImageUI('');
  if ($('theme-bgFilePicker')) $('theme-bgFilePicker').value = '';
  setToggle('tgl-glassEnabled', false);
  updateStyleBaseLocks(false);
  
  // Reset custom theme toggle and groups
  setToggle('tgl-customTheme', false);
  setCustomThemeEditorOpen(false);

  const cfgThemeSelect = $('cfgTheme');
  if (cfgThemeSelect) {
    cfgThemeSelect.value = 'steam-green';
    cfgThemeSelect.disabled = false;
    const parent = cfgThemeSelect.closest('div');
    if (parent) {
      parent.style.opacity = '1';
      parent.style.pointerEvents = 'auto';
    }
  }

  if ($('styleBaseRetro')) $('styleBaseRetro').checked = true;
  if ($('styleBaseModern')) $('styleBaseModern').checked = false;
  if ($('themeTemplateSelect')) $('themeTemplateSelect').value = '';

  config.customTheme = defaults;
  config.theme = 'steam-green';
  config.baselineTheme = 'steam-green';
  applyTheme('steam-green');
  
  try {
    await window.radium?.saveConfig(config);
    toast('Custom theme reset to default!', 'ok');
  } catch (e) {
    toast('Theme reset locally, failed to persist config.', 'error');
  }
});

// Save
// ─── Auto-save Settings ─────────────────────────────────────────────────────
// Replaces the old manual Save button. Collects the full settings state and
// persists it to config.json. A small indicator in the header gives feedback.

let _autoSaveTimer = null;

function showAutosaveIndicator(state, text) {
  const el = $('autosaveIndicator');
  if (!el) return;
  el.style.display = '';
  el.className = `autosave-indicator visible ${state}`;
  el.textContent = text;
}

async function autoSaveSettings() {
  if (!config || Object.keys(config).length === 0) return;

  const customActive  = getToggle('tgl-customTheme');
  const selectedTheme = $('cfgTheme')?.value || 'steam-green';
  const saveTheme     = customActive ? 'custom' : selectedTheme;
  const isModern      = $('styleBaseModern')?.checked === true;

  const customColors = {
    bgDark:       $('theme-bgDark')?.value || '#21281e',
    bgMain:       $('theme-bgMain')?.value || '#384232',
    bgPanel:      $('theme-bgPanel')?.value || '#4b5845',
    bgBtn:        $('theme-bgBtn')?.value || '#5e6d56',
    borderLight:  $('theme-borderLight')?.value || '#829478',
    borderDark:   $('theme-borderDark')?.value || '#1b2118',
    green:        $('theme-green')?.value || '#00ff00',
    greenDim:     $('theme-greenDim')?.value || '#7ca969',
    text:         $('theme-text')?.value || '#d4e0ce',
    textMuted:    $('theme-textMuted')?.value || '#8da082',
    statusOnline: $('theme-statusOnline')?.value || '#00ff00',
    styleBase:    isModern ? 'modern' : 'retro',
    bgImage:      getBgImageUI(),
    glassEnabled: getToggle('tgl-glassEnabled'),
    glassBg:      $('theme-glassBg')?.value || '#0b0c14'
  };

  const updated = {
    ...config,
    apiUrl:           config.apiUrl || 'https://api.radie.app/',
    minimizeOnLaunch: getToggle('tgl-minimizeOnLaunch'),
    closeOnLaunch:    getToggle('tgl-closeOnLaunch'),
    autoUpdate:       getToggle('tgl-autoUpdate'),
    enableAnimations: getToggle('tgl-enableAnimations'),
    disableWarnings:  getToggle('tgl-disableWarnings'),
    // No `installDir` here on purpose. The install-dir span shows whichever
    // network is active, so copying it into the flat (Radium) field on every
    // autosave silently repointed Radium at the Vanilla folder. The Change /
    // Reset Folder buttons own that setting and save it themselves, into the
    // active network's slot; the `...config` spread carries both slots through
    // untouched.
    playMode,
    theme:            saveTheme,
    baselineTheme:    selectedTheme,
    font:             $('cfgFont')?.value || 'default',
    launchOptions:    launchOptionsInput('radium')?.value.trim() || '',
    customTheme:      customColors,
    network:          activeNetwork,
    // Spread through rather than replaced: the install fields in here are owned
    // by the Change / Reset Folder buttons and the backend, and this form must
    // not clobber them. Launch options are the one thing in it this form does
    // own, so that key — and only that key — is overwritten.
    vanilla: {
      ...(config.vanilla || {}),
      launchOptions: launchOptionsInput('vanilla')?.value.trim() || ''
    }
  };

  config.customTheme  = customColors;
  config.baselineTheme = selectedTheme;

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

// Debounce helper for text inputs — waits 800ms after the user stops typing
function debounceAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(autoSaveSettings, 800);
}

// Wire up text inputs. Both networks' launch options, so editing the inactive
// network's row saves the same way the active one's does.
$('cfgLaunchOptionsRadium')?.addEventListener('input', debounceAutoSave);
$('cfgLaunchOptionsVanilla')?.addEventListener('input', debounceAutoSave);


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
      const m = $('clientUpdateModal');
      if (m) m.style.display = 'flex';
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
    btn.title = available
      ? `Download the ${info.label} client`
      : `Open ${info.downloadPage}`;
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
const closeClientUpdateModal = () => { if (clientUpdateModal) clientUpdateModal.style.display = 'none'; };
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
  const m = $('clientVersionUpdateModal'); if (m) m.style.display = 'flex';

  const qscC = $('qsc-client');
  if (qscC) qscC.classList.add('update-available');
  const qi = $('qsInstalled'); if (qi) qi.textContent = `v${info.latestVersion}`;
  setClientUpdateButton('update', info);
}

const closeClientVersionUpdateModal = () => { const m = $('clientVersionUpdateModal'); if (m) m.style.display = 'none'; };
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
const closeReinstallModal = () => { if (reinstallModal) reinstallModal.style.display = 'none'; };
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
  if (reinstallModal) reinstallModal.style.display = 'flex';
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
const closeStopGameModal = () => { if (stopGameModal) stopGameModal.style.display = 'none'; };
$('stopGameCancelBtn')?.addEventListener('click', closeStopGameModal);
$('stopGameModalClose')?.addEventListener('click', closeStopGameModal);
$('stopGameConfirmBtn')?.addEventListener('click', async () => {
  closeStopGameModal();
  addLog('User confirmed stop game request. Killing game process...', 'info');
  toast('Stopping Radium...', 'info', 2000);
  await window.radium?.killGame();
  setGameRunning(false);
});
$('stopGameModal')?.addEventListener('click', (e) => {
  if (e.target === stopGameModal) {
    closeStopGameModal();
  }
});
function showStopGameModal() {
  if (stopGameModal) stopGameModal.style.display = 'flex';
}

// Uninstall logic with Modal
const uninstallModal = $('uninstallModal');
const closeUninstallModal = () => { if(uninstallModal) uninstallModal.style.display = 'none'; };
$('uninstallCancelBtn')?.addEventListener('click', closeUninstallModal);
$('uninstallModalClose')?.addEventListener('click', closeUninstallModal);

$('btnUninstall')?.addEventListener('click', () => {
  if (isGameRunning) {
    toast('Cannot uninstall while the game is running.', 'error');
    return;
  }
  if (uninstallModal) uninstallModal.style.display = 'flex';
});

$('uninstallConfirmBtn')?.addEventListener('click', async () => {
  closeUninstallModal();
  addLog('Uninstalling client...', 'info');
  toast('Uninstalling...', 'info');

  const result = await window.radium?.uninstallClient();
  if (result?.success) {
    addLog('Client uninstalled successfully.', 'ok');
    toast('Radium client uninstalled.', 'ok');
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
  const m = $('excludeAvModal');
  if (m) m.style.display = 'flex';
}

function hideExcludeAvModal() {
  const m = $('excludeAvModal');
  if (m) m.style.display = 'none';
  launchAfterExclusion = false; // Reset whenever the modal is hidden
  isGameLaunching = false;
}

$('excludeAvModalClose')?.addEventListener('click', hideExcludeAvModal);
$('btnExcludeAvCancel')?.addEventListener('click', hideExcludeAvModal);
$('btnExcludeAvAnyway')?.addEventListener('click', async () => {
  const m = $('excludeAvModal');
  if (m) m.style.display = 'none';
  launchAfterExclusion = false; // Reset since we are launching now anyway
  await proceedAfterAvCheck();
});
$('excludeAvModal')?.addEventListener('click', (e) => {
  if (e.target === $('excludeAvModal')) {
    hideExcludeAvModal();
  }
});

async function executeExcludeAv() {
  const btn = $('btnExcludeAv');
  if (!btn) return;
  addLog('Requesting Windows Defender exclusion for client folder...', 'info');
  toast('Please approve the Administrator prompt...', 'info');
  const result = await window.radium?.addDefenderExclusion();
  if (result && result.success) {
    config.defenderExcluded = true;
    await window.radium?.saveConfig(config);
    btn.textContent = 'UNExclude AV';
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
  const m = $('excludeAvModal');
  if (m) m.style.display = 'none';
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

  m.style.display = 'flex';
}

function hideThirdPartyAvModal() {
  const m = $('thirdPartyAvModal');
  if (m) m.style.display = 'none';
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
  const m = $('thirdPartyAvModal');
  if (m) m.style.display = 'none';

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
      btn.textContent = 'Exclude AV';
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
      btn.textContent = 'Exclude AV';
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
  const m = $('steamModal');
  if (m) m.style.display = 'flex';
}

function hideSteamModal(cancelLaunch = true) {
  const m = $('steamModal');
  if (m) m.style.display = 'none';
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
  const m = $('steamAppModal');
  if (m) m.style.display = 'flex';
}
function hideSteamAppModal(cancelLaunch = true) {
  const m = $('steamAppModal');
  if (m) m.style.display = 'none';
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
  toast('Launching Radium...', 'info', 2000);

  let result = null;
  try {
    result = await window.radium?.launchGame({ ...config, playMode });
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
    toast(`Radium launched in ${playMode.toUpperCase()} mode!`, 'ok');
    if (config.closeOnLaunch === true) {
      addLog('Launcher configured to exit on game start. Exiting...', 'info');
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
  // Verify DLL first
  const status = await window.radium?.checkInstall();
  if (status && status.dllMissing) {
    if (config.disableWarnings === true) {
      addLog('Radeon.Core.BasePatch.dll is missing. Warning skipped (disabled by user).', 'info');
      await checkSacAndLaunch();
    } else {
      addLog('Radeon.Core.BasePatch.dll is missing. Prompting user...', 'info');
      showDllMissingModal();
    }
    return;
  }

  await checkSacAndLaunch();
}

// Launch-time antivirus check: offer to exclude the client folder from
// Windows Defender (or warn about a third-party AV) before launching, so the
// game's patched files aren't quarantined. Flows into the DLL check, then the
// Smart App Control check, then the Steam check, then the actual launch.
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

$('btnPlay')?.addEventListener('click', async () => {
  if (isGameRunning) {
    showStopGameModal();
    return;
  }
  if (isGameLaunching || !isInstalled) return;
  isGameLaunching = true;

  // Full pre-launch safety chain: AV exclusion → DLL restore → Smart App
  // Control → Steam → launch.
  await checkAvAndLaunch();
});

function showSacModal() {
  const m = $('sacModal');
  if (m) m.style.display = 'flex';
}

function hideSacModal(cancelLaunch = true) {
  const m = $('sacModal');
  if (m) m.style.display = 'none';
  if (cancelLaunch) isGameLaunching = false;
}

function showDllMissingModal() {
  const m = $('dllMissingModal');
  if (m) m.style.display = 'flex';
}

function hideDllMissingModal(cancelLaunch = true) {
  const m = $('dllMissingModal');
  if (m) m.style.display = 'none';
  if (cancelLaunch) isGameLaunching = false;
}

$('dllMissingModalClose')?.addEventListener('click', () => hideDllMissingModal(true));
$('dllMissingModal')?.addEventListener('click', (e) => {
  if (e.target === $('dllMissingModal')) {
    hideDllMissingModal(true);
  }
});

$('dllLaunchAnywayBtn')?.addEventListener('click', async () => {
  hideDllMissingModal(false);
  await checkSacAndLaunch();
});

$('dllRestoreBtn')?.addEventListener('click', async () => {
  hideDllMissingModal(false);
  addLog('Restoring Radeon.Core.BasePatch.dll...', 'info');
  toast('Restoring patch file...', 'info', 3000);
  
  const restoreBtn = $('dllRestoreBtn');
  if (restoreBtn) restoreBtn.disabled = true;

  try {
    const res = await window.radium?.restoreDll();
    if (restoreBtn) restoreBtn.disabled = false;

    if (res?.success) {
      toast('DLL restored successfully!', 'ok');
      addLog('Patch file Radeon.Core.BasePatch.dll successfully restored.', 'ok');
      
      await checkSacAndLaunch();
    } else {
      toast('Failed to restore DLL.', 'error');
      addLog('Failed to restore patch DLL.', 'error');
      isGameLaunching = false;
    }
  } catch (err) {
    if (restoreBtn) restoreBtn.disabled = false;
    toast(`Error: ${err}`, 'error');
    addLog(`Error restoring DLL: ${err}`, 'error');
    isGameLaunching = false;
  }
});

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
  const m = $('updateModal'); if (m) m.style.display = 'flex';
}

function hideUpdateModal() {
  const m = $('updateModal'); if (m) m.style.display = 'none';
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
  const result = await window.radium?.downloadUpdate(updateInfo.downloadUrl, true);
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

  // The retro skins have no exit animation and neither does anyone with the
  // animations setting off; waiting on a timer for them would only make
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
          <div class="room-card-name" title="${escapeHtml(roomName)}">${escapeHtml(roomName)}</div>
          <div class="room-card-creator" title="View creator's profile">by ${escapeHtml(creatorUsername)}</div>
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
    // object's message, or a prefix of an unparseable response body), and the
    // CSP allows inline handlers — so unescaped it is a script-injection path
    // into a webview that can reach every backend command.
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

window.filterByCreator = function(username) {
  const searchInput = $('roomsSearch');
  if (searchInput) {
    searchInput.value = username;
    roomsSearchQuery = username;
    roomsSkip = 0;
    loadRooms();
  }
};

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
  
  beginListLoad(bodyEl, '<tr><td colspan="4" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Loading players...</td></tr>');
  
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
      bodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">No players found.</td></tr>';
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
            <span class="status-dot ${presence.cls}" title="${presence.title}"></span>
            ${escapeHtml(person.displayName || person.userName)}
          </td>
          <td class="people-username-cell">
            <span class="username-row"><span class="text-link" title="@${escapeHtml(person.userName)}">@${escapeHtml(person.userName)}</span><span class="profile-roles inline-roles"></span></span>
          </td>
          <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(person.bio || '')}">
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
    bodyEl.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Error: ${escapeHtml(res?.error || 'Failed to fetch players')}</td></tr>`;
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
  const res = await window.radium?.fetchRooms({ query: roomName, take: 1 });
  if (res && res.success && res.data && res.data.Results && res.data.Results.length > 0) {
    const room = res.data.Results[0];
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
      link.title = `@${p.userName}`;
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
    creatorAvatarEl.dataset.fallback = './images.png';
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
      if (avatarSrc && creatorAvatarEl) {
        creatorAvatarEl.classList.add('image-loading-placeholder');
        creatorAvatarEl.dataset.fallback = './images.png';
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

  const cheersEl = $('roomsDetailCheers');
  if (cheersEl) cheersEl.textContent = '...';
  const favsEl = $('roomsDetailFavorites');
  if (favsEl) favsEl.textContent = '...';
  const visitsEl = $('roomsDetailVisits');
  if (visitsEl) visitsEl.textContent = '...';
  const descEl = $('roomsDetailDescription');
  if (descEl) descEl.textContent = 'Loading details from web...';
  
  const roomsPhotosGrid = $('roomsDetailPhotosGrid');
  const roomsPhotosEmpty = $('roomsDetailPhotosEmpty');
  if (roomsPhotosGrid) roomsPhotosGrid.innerHTML = '';
  if (roomsPhotosEmpty) roomsPhotosEmpty.style.display = 'none';

  list.classList.add('hidden');
  detail.classList.remove('hidden');

  // Load scraped web details asynchronously (handle both PascalCase and camelCase APIs)
  const webDetails = await window.radium?.fetchRoomWebDetails(room.Name || room.name || '');
  if (webDetails && webDetails.success) {
    if (cheersEl) cheersEl.textContent = webDetails.cheers;
    if (favsEl) favsEl.textContent = webDetails.favorites;
    if (visitsEl) visitsEl.textContent = webDetails.visits;
    if (descEl) descEl.textContent = webDetails.description || 'No description available.';
    if (webDetails.creatorAvatar && creatorAvatarEl) {
      creatorAvatarEl.classList.add('image-loading-placeholder');
      creatorAvatarEl.src = thumbSrc(webDetails.creatorAvatar, avatarWidth(32));
    } else if (creatorAvatarEl) {
      creatorAvatarEl.classList.remove('image-loading-placeholder');
    }
  } else {
    if (cheersEl) cheersEl.textContent = '—';
    if (favsEl) favsEl.textContent = '—';
    if (visitsEl) visitsEl.textContent = '—';
    if (descEl) descEl.textContent = 'A Radium community room.';
    if (creatorAvatarEl) creatorAvatarEl.classList.remove('image-loading-placeholder');
  }

  // Load room photos
  loadRoomPhotos(room.RoomId || room.roomId);
}

function hideRoomDetails() {
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
  
  const avatarUrl = personAvatarUrl(person, 80);
  
  const avatarEl = $('peopleDetailAvatar');
  if (avatarEl) {
    avatarEl.classList.add('image-loading-placeholder');
    avatarEl.onload = () => { avatarEl.classList.remove('image-loading-placeholder'); avatarEl.onload = null; };
    avatarEl.src = avatarUrl;
    avatarEl.onerror = () => { avatarEl.src = './logo.png'; avatarEl.classList.remove('image-loading-placeholder'); avatarEl.onerror = null; };
    avatarEl.style.cursor = 'pointer';
    avatarEl.title = 'Click to view full size';
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
  
  const friendsEl = $('peopleDetailFriends');
  const subsEl = $('peopleDetailSubscribers');
  const visitsEl = $('peopleDetailVisits');
  // Show all three while loading; whichever the network can't fill is hidden
  // once the answer arrives.
  [friendsEl, subsEl, visitsEl].forEach(el => setProfileStat(el, '...'));
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

  // Load scraped web details asynchronously
  let webDetails = null;
  try {
    webDetails = await getUserWebDetails(person.userName);
  } catch (err) {
    console.error("Error loading web details for user:", err);
  }
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
    // numbers are real on this network, we just don't have them right now.
    setProfileStat(friendsEl, '—');
    setProfileStat(subsEl, '—');
    setProfileStat(visitsEl, '—');
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
        <div class="room-card-name" title="${escapeHtml(roomName)}">${escapeHtml(roomName)}</div>
        <div class="room-card-creator" title="View creator's profile">by ${escapeHtml(creatorUsername)}</div>
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

      // Asynchronously fetch actual statistics in the background
      (async () => {
        const details = await window.radium?.fetchRoomWebDetails(roomName);
        if (details && details.success) {
          const cheerEl = roomCard.querySelector('.room-card-cheers');
          const visitEl = roomCard.querySelector('.room-card-visits');
          if (cheerEl) cheerEl.textContent = details.cheers || '0';
          if (visitEl) visitEl.textContent = details.visits || '0';
        } else {
          const cheerEl = roomCard.querySelector('.room-card-cheers');
          const visitEl = roomCard.querySelector('.room-card-visits');
          if (cheerEl) cheerEl.textContent = '—';
          if (visitEl) visitEl.textContent = '—';
        }
      })();
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
  lightboxModal.style.display = 'flex';
  lightboxCloseBtn?.focus();
}

function hideLightbox() {
  if (!lightboxModal) return;
  lightboxModal.style.display = 'none';
  // Drop the picture so a large one is not held in memory behind a closed
  // dialog, and so reopening never shows the previous image for a frame.
  if (lightboxImage) {
    lightboxImage.onload = null;
    lightboxImage.onerror = null;
    lightboxImage.src = 'data:,';
  }
}

function lightboxIsOpen() {
  return !!lightboxModal && lightboxModal.style.display !== 'none';
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
      launcherVersion: $('versionTag')?.textContent || 'unknown',
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

