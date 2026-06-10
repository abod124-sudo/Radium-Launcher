// ─── Tauri v2 Compatibility Shim ───────────────────────────────────────────────
// Recreates the window.radium API from the Electron preload bridge using Tauri APIs.
// This allows the rest of app.js to remain unchanged.
(function setupTauriShim() {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { open } = window.__TAURI__.shell;

  const appWindow = getCurrentWindow();

  window.radium = {
    // Window controls
    minimize: () => appWindow.minimize(),
    maximize: () => appWindow.toggleMaximize(),
    close:    () => appWindow.close(),

    // Config
    getConfig:  ()    => invoke('cmd_get_config'),
    saveConfig: (cfg) => invoke('cmd_save_config', { config: cfg }),

    // Server
    pingServer:     (url) => invoke('ping_server', { url }),
    getPlayerCount: ()    => invoke('get_player_count'),
    addDefenderExclusion:    () => invoke('add_defender_exclusion'),
    removeDefenderExclusion: () => invoke('remove_defender_exclusion'),

    // Install
    checkInstall: () => invoke('check_install'),

    // Download
    downloadClient:  () => invoke('download_client'),
    cancelDownload:  () => invoke('cancel_download'),
    uninstallClient: () => invoke('uninstall_client'),
    openClientFolder: () => invoke('open_client_folder'),
    selectFolder:     () => invoke('select_folder'),
    getDefaultClientDir: () => invoke('get_default_client_dir'),
    restoreDll:          () => invoke('restore_dll'),
    onDownloadProgress: (cb) => {
      listen('download-progress', (event) => cb(event.payload));
    },

    // Game
    launchGame: (cfg) => invoke('launch_game', { config: cfg }),
    killGame:   ()    => invoke('kill_game'),
    onGameState: (cb) => {
      listen('game-state', (event) => cb(event.payload));
    },

    // Misc
    openUrl:    (url)  => open(url),
    getVersion: ()     => invoke('get_version'),
    checkSteam: ()     => invoke('check_steam'),
    checkSmartAppControl: () => invoke('check_smart_app_control'),

    // Auto-update
    checkForUpdate:  ()            => invoke('check_for_update'),
    downloadUpdate:  (downloadUrl) => invoke('download_update', { url: downloadUrl }),

    // Data Fetching
    fetchRooms:           (args) => invoke('fetch_rooms', { args }),
    fetchPeople:          (args) => invoke('fetch_people', { args }),
    fetchFilters:         ()     => invoke('fetch_filters'),
    fetchRoomWebDetails:  (name) => invoke('fetch_room_web_details', { name: String(name) }),
    fetchUserWebDetails:  (name) => invoke('fetch_user_web_details', { name: String(name) }),
    fetchUserPhotos:      (args) => invoke('fetch_user_photos', { args }),
    fetchUserRooms:       (args) => invoke('fetch_user_rooms', { args }),
    fetchUserFeed:        (args) => invoke('fetch_user_feed', { args }),
    fetchRecentPhotos:    (args) => invoke('fetch_recent_photos', { args }),
    fetchPhotoWebDetails: (photoId) => invoke('fetch_photo_web_details', { photoId: String(photoId) }),
    fetchPhotoComments:   (photoId) => invoke('fetch_photo_comments', { photoId: String(photoId) }),

    // Log URL events
    onLogUrl: (cb) => {
      listen('log-url', (event) => cb(event.payload));
    },

    // Window state events
    onWindowMaximizedState: (cb) => {
      listen('window-maximized-state', (event) => cb(event.payload));
    },

    // Debug
    debugExec:  (mode) => invoke('cmd_debug_exec', { mode }),
    debugPaths: ()     => invoke('cmd_debug_paths'),

    // Bug Reporter
    submitBugReport: (description, logs) => invoke('submit_bug_report', { description, logs }),
  };
})();

// App state variables
let config                = {};
let isGameRunning         = false;
let isDownloading         = false;
let isInstalled           = false;
let playMode              = 'screen';
let launchAfterExclusion  = false;
let sacWarnedThisSession  = false;

// Unbounded log buffer — captures every log entry for bug reports.
// The DOM viewer is capped at 120 for performance; this buffer has no cap.
const fullLogBuffer = [];

// DOM shortcuts
const $ = id => document.getElementById(id);

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

// Append log entry to list
function addLog(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;

  // Always push to the full unbounded buffer (used by bug reports)
  fullLogBuffer.push(line);

  // Also render in the DOM viewer (capped at 120 entries for performance)
  const out = $('logOutput');
  if (!out) return;
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = line;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
  while (out.children.length > 120) out.removeChild(out.firstChild);
}

// Tab routing switch
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tabName = btn.dataset.tab;
    const p = $('tab-' + tabName);
    if (p) p.classList.add('active');

    // Lazy load data when switching tabs
    if (tabName === 'rooms') {
      loadFilters();
      loadRooms();
    } else if (tabName === 'people') {
      loadPeople();
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
async function loadVersion() {
  const v = await window.radium?.getVersion();
  if (v) $('versionTag').textContent = `v${v}`;
}

// Load and save local settings config
async function loadConfig() {
  config = (await window.radium?.getConfig()) || {};

  // Defaults
  if (!config.apiUrl)   config.apiUrl   = 'https://api.radie.app/';
  if (!config.playMode) config.playMode = 'screen';

  setValue('cfgApiUrl', config.apiUrl);
  setValue('cfgLaunchOptions', config.launchOptions || '');

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
  setValue('cfgTheme', activeTheme);
  applyTheme(activeTheme);

  // Defender Exclusion State
  const btnExcludeAv = $('btnExcludeAv');
  if (btnExcludeAv) {
    btnExcludeAv.textContent = config.defenderExcluded ? 'UNExclude AV' : 'Exclude AV';
  }
}

function applyTheme(theme) {
  document.body.className = document.body.className.split(' ').filter(c => c === 'animations-enabled').join(' ');
  if (theme && theme !== 'steam-green') {
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
  })
);

$('cfgTheme')?.addEventListener('change', () => {
  const selectedTheme = $('cfgTheme').value;
  applyTheme(selectedTheme);
});

// Save
$('btnSaveSettings')?.addEventListener('click', async () => {
  const selectedTheme = $('cfgTheme')?.value || 'steam-green';
  const customDir = $('cfgInstallDir')?.textContent.trim() || '';
  const updated = {
    ...config,
    apiUrl:           config.apiUrl || 'https://api.radie.app/',
    minimizeOnLaunch: getToggle('tgl-minimizeOnLaunch'),
    closeOnLaunch:    getToggle('tgl-closeOnLaunch'),
    autoUpdate:       getToggle('tgl-autoUpdate'),
    enableAnimations: getToggle('tgl-enableAnimations'),
    disableWarnings:  getToggle('tgl-disableWarnings'),
    installDir:       customDir,
    playMode,
    theme:            selectedTheme,
    launchOptions:    $('cfgLaunchOptions')?.value.trim() || '',
  };
  applyTheme(selectedTheme);
  const ok = await window.radium?.saveConfig(updated);
  if (ok) {
    config = updated;
    toast('Settings saved!', 'ok');
    addLog('Configuration saved.', 'ok');
    await checkInstall();
  } else {
    toast('Failed to save.', 'error');
  }
});

// Check client installation state
async function checkInstall() {
  const result = await window.radium?.checkInstall();
  isInstalled = result?.installed ?? false;
  const qscC = $('qsc-client');
  const installDirSpan = $('cfgInstallDir');

  if (installDirSpan && result?.clientDir) {
    installDirSpan.textContent = result.clientDir;
  }

  if (isInstalled) {
    // Show launch panel, hide download section
    $('downloadSection').style.display = 'none';
    $('launchPanel').style.display     = 'flex';
    $('qsInstalled').textContent       = 'INSTALLED';
    if (qscC) {
      qscC.classList.add('installed');
      qscC.classList.remove('not-installed');
    }
    addLog('Game client found: ' + (result.exePath || 'client dir'), 'ok');
    
    // Check if the game is already running on startup
    if (result?.isRunning) {
      setGameRunning(true);
      addLog('Game is already running.', 'ok');
    }
  } else {
    // Show download section, hide launch panel
    $('downloadSection').style.display = 'flex';
    $('launchPanel').style.display     = 'none';
    $('qsInstalled').textContent       = 'NOT INSTALLED';
    if (qscC) {
      qscC.classList.add('not-installed');
      qscC.classList.remove('installed');
    }
    addLog('Game client not found — download required.', 'info');
  }
}

// In-app client download downloader state
function setDownloadUI(downloading) {
  isDownloading = downloading;
  const btn = $('btnDownload');
  const block = $('dlProgressBlock');
  if (downloading) {
    if (btn)   { btn.disabled = true; btn.textContent = '⬇ DOWNLOADING...'; }
    if (block) block.style.display = 'block';
  } else {
    if (btn)   { btn.disabled = false; btn.textContent = '⬇ DOWNLOAD'; }
    if (block) block.style.display = 'none';
  }
}

function updateDlProgress({ phase, pct = 0, downloaded = 0, total = 0, speed = 0, eta = -1, status }) {
  const fill  = $('dlBarFill');
  const pctEl = $('dlPctLabel');
  const phase_el = $('dlPhaseLabel');
  const speedEl  = $('dlSpeedLabel');
  const sizeEl   = $('dlSizeLabel');
  const etaEl    = $('dlEtaLabel');

  if (fill)    fill.style.width = pct >= 0 ? `${pct}%` : '100%';
  if (pctEl)   pctEl.textContent = pct >= 0 ? `${pct}%` : '—';

  if (phase === 'extract') {
    if (phase_el) phase_el.textContent = 'Extracting...';
    if (speedEl)  speedEl.textContent  = '';
    if (sizeEl)   sizeEl.textContent   = status || 'Please wait...';
    if (etaEl)    etaEl.textContent    = '';
    return;
  }

  if (phase === 'done') {
    if (phase_el) phase_el.textContent = 'Complete!';
    return;
  }

  if (phase_el) phase_el.textContent = 'Downloading...';
  if (speedEl)  speedEl.textContent  = speed > 0 ? `${formatBytes(speed)}/s` : '—';
  if (sizeEl)   sizeEl.textContent   = total > 0
    ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
    : formatBytes(downloaded);
  if (etaEl)    etaEl.textContent    = eta >= 0 ? `ETA ${formatEta(eta)}` : '—';
}

$('btnDownload')?.addEventListener('click', async () => {
  if (isDownloading) return;
  setDownloadUI(true);
  addLog('Starting download from cdn.recroomarchive.org...', 'info');
  toast('Download started!', 'info', 2500);

  const result = await window.radium?.downloadClient();

  if (result?.success) {
    setDownloadUI(false);
    addLog('Download & extraction complete!', 'ok');
    addLog(`Exe: ${result.exePath || 'Found in client dir'}`, 'ok');
    toast('Radium client installed!', 'ok', 4000);
    await checkInstall();
  } else {
    setDownloadUI(false);
    const err = result?.error || 'Unknown error';
    addLog(`Download failed: ${err}`, 'error');
    toast(`Failed: ${err}`, 'error', 5000);
  }
});

$('btnCancelDl')?.addEventListener('click', () => {
  window.radium?.cancelDownload();
  setDownloadUI(false);
  addLog('Download cancelled.', 'info');
  toast('Download cancelled.', 'info');
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
    const currentDir = $('cfgInstallDir')?.textContent.trim() || config.installDir || '%APPDATA%\\com.radium.launcher\\client';
    dirSpan.textContent = currentDir;
  }
  if (reinstallModal) reinstallModal.style.display = 'flex';
});

$('reinstallConfirmBtn')?.addEventListener('click', () => {
  closeReinstallModal();
  $('downloadSection').style.display = 'flex';
  $('launchPanel').style.display     = 'none';
  isInstalled = false;
  addLog('Reinstall initiated.', 'info');
  toast('Starting reinstall...', 'info');
  $('btnDownload')?.click();
});

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

$('btnOpenFolderSettings')?.addEventListener('click', async () => {
  addLog('Opening client folder from settings...', 'info');
  const ok = await window.radium?.openClientFolder();
  if (ok) {
    toast('Client folder opened!', 'ok');
  } else {
    toast('Failed to open client folder (does it exist?).', 'error');
  }
});

$('btnChangeFolder')?.addEventListener('click', async () => {
  addLog('Selecting install directory...', 'info');
  const newDir = await window.radium?.selectFolder();
  if (newDir) {
    const span = $('cfgInstallDir');
    if (span) {
      span.textContent = newDir;
      config.installDir = newDir;
      const ok = await window.radium?.saveConfig(config);
      if (ok) {
        toast('Install location updated and saved!', 'ok');
        addLog(`Selected and saved install directory: ${newDir}`, 'info');
      } else {
        toast('Failed to save install location.', 'error');
      }
      await checkInstall();
    }
  } else {
    addLog('Install directory selection cancelled.', 'info');
  }
});

$('btnResetFolder')?.addEventListener('click', async () => {
  addLog('Resetting install directory...', 'info');
  const defaultDir = await window.radium?.getDefaultClientDir();
  if (defaultDir) {
    const span = $('cfgInstallDir');
    if (span) {
      span.textContent = defaultDir;
      config.installDir = defaultDir;
      const ok = await window.radium?.saveConfig(config);
      if (ok) {
        toast('Install location reset and saved!', 'ok');
        addLog(`Reset and saved install directory: ${defaultDir}`, 'info');
      } else {
        toast('Failed to save reset location.', 'error');
      }
      await checkInstall();
    }
  }
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
  }
}

$('btnExcludeAvConfirm')?.addEventListener('click', () => {
  // Set display directly to avoid resetting launchAfterExclusion inside hideExcludeAvModal
  const m = $('excludeAvModal');
  if (m) m.style.display = 'none';
  executeExcludeAv();
});

$('btnExcludeAv')?.addEventListener('click', async () => {
  const btn = $('btnExcludeAv');
  if (!btn) return;

  const isCurrentlyExcluded = config.defenderExcluded === true;

  if (isCurrentlyExcluded) {
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
    showExcludeAvModal();
  }
});

// Play mode configuration
function setModeUI(mode) {
  $('modeScreen')?.classList.toggle('active', mode === 'screen');
  $('modeVR')?.classList.toggle('active',     mode === 'vr');
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
  const apiUrl = config.apiUrl || 'https://api.radie.app/';
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
      window.radium?.pingServer(cdnUrl),
    ]);
  } catch (e) {
    console.error('pingServer error:', e);
  }

  const apiOnline = apiResult?.online ?? false;
  const cdnOnline = cdnResult?.online ?? false;

  // Quick stats card on home tab
  if (qsS) qsS.textContent = apiOnline ? 'ONLINE' : 'OFFLINE';
  const qscS = $('qsc-status');
  if (qscS) {
    qscS.classList.toggle('online',  apiOnline);
    qscS.classList.toggle('offline', !apiOnline);
  }

  if (!silent) {
    addLog(`API Gateway (${apiUrl}): ${apiOnline ? 'ONLINE' : 'OFFLINE'}`, apiOnline ? 'ok' : 'error');
    addLog(`CDN Server (${cdnUrl}): ${cdnOnline ? 'ONLINE' : 'OFFLINE'}`, cdnOnline ? 'ok' : 'error');
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
  const btn = $('btnPlay');
  if (running) {
    btn?.classList.add('running');
    const pt = $('playText'); if (pt) pt.textContent = 'RUNNING';
    const ps = $('playStatus'); if (ps) ps.style.display = 'flex';
  } else {
    btn?.classList.remove('running');
    const pt = $('playText'); if (pt) pt.textContent = 'PLAY';
    const ps = $('playStatus'); if (ps) ps.style.display = 'none';
  }
}

// Steam Modal actions
function showSteamModal() {
  const m = $('steamModal');
  if (m) m.style.display = 'flex';
}

function hideSteamModal() {
  const m = $('steamModal');
  if (m) m.style.display = 'none';
}

$('steamModalClose')?.addEventListener('click', hideSteamModal);
$('steamModal')?.addEventListener('click', (e) => {
  if (e.target === $('steamModal')) {
    hideSteamModal();
  }
});

async function executeLaunch() {
  setGameRunning(true);
  addLog('Launching game...', 'info');
  toast('Launching Radium...', 'info', 2000);

  const result = await window.radium?.launchGame({ ...config, playMode });

  if (!result?.success) {
    setGameRunning(false);
    const err = result?.error || 'Unknown error';
    addLog(`Launch failed: ${err}`, 'error');
    toast(`Launch failed: ${err}`, 'error', 5000);
  } else {
    addLog(`Game running (PID ${result.pid}) — mode: ${playMode}`, 'ok');
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
  hideSteamModal();
  executeLaunch();
});

$('steamLaunchBtn')?.addEventListener('click', async () => {
  hideSteamModal();
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

$('btnPlay')?.addEventListener('click', async () => {
  if (isGameRunning || !isInstalled) return;

  const isCurrentlyExcluded = config.defenderExcluded === true;

  if (!isCurrentlyExcluded) {
    if (config.disableWarnings === true) {
      addLog('Antivirus exclusion not set. Warning skipped (disabled by user).', 'info');
      await proceedAfterAvCheck();
    } else {
      addLog('Antivirus exclusion not set. Prompting user...', 'info');
      launchAfterExclusion = true;
      showExcludeAvModal();
    }
  } else {
    await proceedAfterAvCheck();
  }
});

function showSacModal() {
  const m = $('sacModal');
  if (m) m.style.display = 'flex';
}

function hideSacModal() {
  const m = $('sacModal');
  if (m) m.style.display = 'none';
}

function showDllMissingModal() {
  const m = $('dllMissingModal');
  if (m) m.style.display = 'flex';
}

function hideDllMissingModal() {
  const m = $('dllMissingModal');
  if (m) m.style.display = 'none';
}

$('dllMissingModalClose')?.addEventListener('click', hideDllMissingModal);
$('dllMissingModal')?.addEventListener('click', (e) => {
  if (e.target === $('dllMissingModal')) {
    hideDllMissingModal();
  }
});

$('dllLaunchAnywayBtn')?.addEventListener('click', async () => {
  hideDllMissingModal();
  await checkSacAndLaunch();
});

$('dllRestoreBtn')?.addEventListener('click', async () => {
  hideDllMissingModal();
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
    }
  } catch (err) {
    if (restoreBtn) restoreBtn.disabled = false;
    toast(`Error: ${err}`, 'error');
    addLog(`Error restoring DLL: ${err}`, 'error');
  }
});

$('sacModalClose')?.addEventListener('click', hideSacModal);
$('sacAnywayBtn')?.addEventListener('click', async () => {
  hideSacModal();
  sacWarnedThisSession = true;
  await checkSteamAndLaunch();
});
$('sacSettingsBtn')?.addEventListener('click', async () => {
  hideSacModal();
  sacWarnedThisSession = true;
  window.radium?.openUrl('windowsdefender://appbrowser');
  await checkSteamAndLaunch();
});
$('sacModal')?.addEventListener('click', (e) => {
  if (e.target === $('sacModal')) {
    hideSacModal();
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

$('btnKill')?.addEventListener('click', async () => {
  await window.radium?.killGame();
  setGameRunning(false);
  addLog('Game stopped.', 'info');
  toast('Game stopped.', 'info');
});

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
  $('updateCurrentVer').textContent = `v${info.currentVersion}`;
  $('updateLatestVer').textContent  = info.latestVersion;
  $('updateNotes').textContent      = info.releaseNotes || '(No release notes provided.)';
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

  const result = await window.radium?.downloadUpdate(updateInfo.downloadUrl);
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
  if (btn.disabled) return;
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
async function init() {
  addLog('Radium Launcher started.', 'ok');
  await loadVersion();
  await loadConfig();

  // Check for launcher updates first on startup (run in background, do not block initialization)
  checkForLauncherUpdate();

  addLog(`API: ${config.apiUrl}`, 'info');
  addLog(`Install dir: ${config?.installDir || '%APPDATA%\\com.radium.launcher\\client'}`, 'info');

  // Check install first (determines which panel to show)
  await checkInstall();

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

  // Disable default context menu
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Bind IPC log url notifications
  window.radium?.onLogUrl((url) => {
    addLog(`HTTP Request: ${url}`, 'info');
  });

  // Global fix for Chromium/WebView2 scroll-trapping over overflow:hidden/auto elements
  document.addEventListener('wheel', (e) => {
    let target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      return;
    }
    let scrollContainer = null;
    let hasTrappingElement = false;
    let current = target;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight;
      if (isScrollable) {
        scrollContainer = current;
        break;
      }
      const overflow = style.overflow;
      const overflowX = style.overflowX;
      const isOverflowHidden = overflow === 'hidden' || overflowX === 'hidden' || overflowY === 'hidden';
      const isOverflowScrollOrAuto = overflowY === 'auto' || overflowY === 'scroll' || overflowX === 'auto' || overflowX === 'scroll';
      if (isOverflowHidden || (isOverflowScrollOrAuto && !isScrollable)) {
        hasTrappingElement = true;
      }
      current = current.parentElement;
    }
    if (scrollContainer && hasTrappingElement) {
      scrollContainer.scrollTop += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
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

let peopleSkip = 0;
const peopleTake = 15;
let peopleSearchQuery = '';

function escapeHtml(str) {
  if (!str) return '';
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
        roomsSkip = 0;
        loadRooms();
      });
      listEl.appendChild(btn);
    });
  } else {
    listEl.innerHTML = '<div style="font-size: 10px; color: var(--text-muted); text-align: center; padding: 4px;">Error loading filters</div>';
  }
}

async function loadRooms() {
  const gridEl = $('roomsGrid');
  const emptyEl = $('roomsEmptyMsg');
  if (!gridEl) return;
  
  gridEl.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Loading rooms...</div>';
  emptyEl?.classList.add('hidden');
  
  const res = await window.radium?.fetchRooms({
    skip: roomsSkip,
    take: roomsTake,
    sortBy: activeRoomsSort,
    query: roomsSearchQuery,
    tag: activeRoomsTag
  });
  
  if (res && res.success && res.data) {
    const rooms = res.data.Results || [];
    const total = res.data.TotalResults || 0;
    
    gridEl.innerHTML = '';
    if (rooms.length === 0) {
      emptyEl?.classList.remove('hidden');
    } else {
      rooms.forEach(room => {
        const imgName = room.ImageName || room.imageName || '';
        const thumbUrl = imgName ? `https://img.radie.app/${imgName}?width=480` : './images.png';
        
        const card = document.createElement('div');
        card.className = 'room-card';
        card.onclick = () => {
          showRoomDetails(room);
        };
        const roomName = room.Name || room.name || 'Unknown Room';
        const creatorUsername = room.CreatorUsername || room.creatorUsername || 'Unknown';
        card.innerHTML = `
          <img class="room-card-image image-loading-placeholder" src="${thumbUrl}" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./images.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" alt="${escapeHtml(roomName)}" />
          <div class="room-card-name" title="${escapeHtml(roomName)}">${escapeHtml(roomName)}</div>
          <div class="room-card-creator" onclick="event.stopPropagation(); showCreatorProfile('${escapeHtml(creatorUsername)}')" title="View creator's profile">by ${escapeHtml(creatorUsername)}</div>
        `;
        gridEl.appendChild(card);
      });
    }
    
    // Pagination text & buttons state
    const totalPages = Math.ceil(total / roomsTake);
    const currentPage = Math.floor(roomsSkip / roomsTake) + 1;
    const txtPage = $('txtRoomsPage');
    if (txtPage) {
      txtPage.textContent = `Page ${currentPage} of ${Math.max(1, totalPages)}`;
    }
    
    const btnPrev = $('btnRoomsPrev');
    const btnNext = $('btnRoomsNext');
    if (btnPrev) btnPrev.disabled = (roomsSkip === 0);
    if (btnNext) btnNext.disabled = (roomsSkip + roomsTake >= total);
  } else {
    gridEl.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Error: ${res?.error || 'Failed to fetch rooms'}</div>`;
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

async function loadPeople() {
  const bodyEl = $('peopleListBody');
  if (!bodyEl) return;
  
  bodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Loading players...</td></tr>';
  
  const res = await window.radium?.fetchPeople({
    skip: peopleSkip,
    take: peopleTake,
    query: peopleSearchQuery
  });
  
  if (res && res.success && res.data) {
    const people = res.data.Results || [];
    const total = res.data.TotalResults || 0;
    
    bodyEl.innerHTML = '';
    if (people.length === 0) {
      bodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">No players found.</td></tr>';
    } else {
      people.forEach(person => {
        const profileImg = person.profileImage || '';
        const isDefault = !profileImg || profileImg === 'DefaultProfileImage';
        const avatarUrl = isDefault ? 'https://img.radie.app/DefaultProfileImage?width=50&cropSquare=1' : `https://img.radie.app/${profileImg}?width=50&cropSquare=1`;
        
        const row = document.createElement('tr');
        row.onclick = () => {
          showPlayerDetails(person);
        };
        row.innerHTML = `
          <td>
            <img class="people-avatar image-loading-placeholder" src="${avatarUrl}" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='https://img.radie.app/DefaultProfileImage?width=50&cropSquare=1'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" alt="${escapeHtml(person.userName)}" />
          </td>
          <td>
            <span class="status-dot ${person.isOnline ? 'online' : 'offline'}" title="${person.isOnline ? 'Online' : 'Offline'}"></span>
            ${escapeHtml(person.displayName || person.userName)}
          </td>
          <td>
            <a href="#" class="text-link" onclick="return false;">
              @${escapeHtml(person.userName)}
            </a>
          </td>
          <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(person.bio || '')}">
            ${escapeHtml(person.bio || '')}
          </td>
        `;
        bodyEl.appendChild(row);
      });
    }
    
    // Pagination text & buttons state
    const totalPages = Math.ceil(total / peopleTake);
    const currentPage = Math.floor(peopleSkip / peopleTake) + 1;
    const txtPage = $('txtPeoplePage');
    if (txtPage) {
      txtPage.textContent = `Page ${currentPage} of ${Math.max(1, totalPages)}`;
    }
    
    const btnPrev = $('btnPeoplePrev');
    const btnNext = $('btnPeopleNext');
    if (btnPrev) btnPrev.disabled = (peopleSkip === 0);
    if (btnNext) btnNext.disabled = (peopleSkip + peopleTake >= total);
  } else {
    bodyEl.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 20px; font-size: 11px; color: var(--text-muted);">Error: ${res?.error || 'Failed to fetch players'}</td></tr>`;
    const btnPrev = $('btnPeoplePrev');
    const btnNext = $('btnPeopleNext');
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
  }
}

// Event listeners for Rooms search / sort / pagination
let roomsSearchTimeout;
$('roomsSearch')?.addEventListener('input', (e) => {
  clearTimeout(roomsSearchTimeout);
  roomsSearchTimeout = setTimeout(() => {
    roomsSearchQuery = e.target.value.trim();
    roomsSkip = 0;
    loadRooms();
  }, 300);
});

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

async function getPhotoWebDetails(photoId) {
  if (photoWebDetailsCache.has(photoId)) {
    return photoWebDetailsCache.get(photoId);
  }
  const res = await window.radium?.fetchPhotoWebDetails(photoId);
  if (res && res.success) {
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
    userWebDetailsCache.set(key, res);
  }
  return res;
}

// Photos pagination state
let roomPhotosFeedSkip = 0;
const roomPhotosFeedTake = 30;
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
  
  if (!append) {
    roomPhotosFeedSkip = 0;
    currentRoomPhotosCount = 0;
    roomPhotosHasMore = false;
    roomPhotosTotalPagesSearched = 0;
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
          
          // Create Feed Post Card
          const card = document.createElement('div');
          card.className = 'feed-post-card';
          
          const photoId = photo.Id || photo.id;
          const cheers = photo.CheerCount || photo.cheerCount || 0;
          const comments = photo.CommentCount || photo.commentCount || 0;
          const captionText = photo.Description || photo.description || '';
          
          let dateStr = '';
          const createdAt = photo.CreatedAt || photo.createdAt;
          if (createdAt) {
            try {
              dateStr = new Date(createdAt).toLocaleString();
            } catch (e) {
              dateStr = createdAt;
            }
          }
          
          const imgName = photo.ImageName || photo.imageName || '';
          
          card.innerHTML = `
            <div class="feed-post-header">
              <img class="feed-post-avatar creator-avatar image-loading-placeholder" src="https://img.radie.app/DefaultProfileImage?width=96&cropSquare=1" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./logo.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" />
              <div class="feed-post-header-text">
                <div class="feed-post-creator creator-name">Loading...</div>
                <div class="feed-post-meta">
                  <span>in</span>
                  <span class="feed-post-room room-link">Loading...</span>
                  <span class="feed-post-dot">•</span>
                  <span class="feed-post-time">${dateStr}</span>
                </div>
              </div>
            </div>
            ${captionText ? `<div class="feed-post-description">${escapeHtml(captionText)}</div>` : ''}
            <div class="feed-post-image-wrap image-wrap">
              <img class="feed-post-image image-loading-placeholder" src="${imgName ? `https://img.radie.app/${imgName}?width=480` : './images.png'}" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./images.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" />
            </div>
            <div class="feed-post-footer">
              <span class="feed-post-stat"><span class="cheers-count">${cheers}</span> Cheers</span>
              <span class="feed-post-stat"><span class="comments-count">${comments}</span> Comments</span>
            </div>
          `;
          
          // Hook up clicks
          const imgWrap = card.querySelector('.image-wrap');
          if (imgWrap) {
            imgWrap.onclick = () => showPhotoDetails(photo, 'rooms-detail');
          }
          
          photosGrid.appendChild(card);
          
          // Asynchronously fetch photo web details in background
          (async () => {
            const details = await getPhotoWebDetails(photoId);
            if (details && details.success) {
              const creatorName = details.creatorUsername || 'Unknown';
              const roomName = details.roomName || '';
              
              const creatorEl = card.querySelector('.creator-name');
              if (creatorEl) {
                creatorEl.textContent = creatorName;
                creatorEl.onclick = (e) => {
                  e.stopPropagation();
                  showCreatorProfile(creatorName);
                };
              }
              
              const roomEl = card.querySelector('.room-link');
              if (roomEl) {
                if (roomName && roomName.toLowerCase() !== 'none') {
                  roomEl.textContent = roomName;
                  roomEl.onclick = (e) => {
                    e.stopPropagation();
                    showRoomByName(roomName);
                  };
                } else {
                  roomEl.previousElementSibling?.remove(); // remove 'in'
                  roomEl.remove();
                }
              }
              
              // Asynchronously fetch creator avatar in background
              if (creatorName && creatorName !== 'Unknown') {
                const userDetails = await getUserWebDetails(creatorName);
                if (userDetails && userDetails.success && userDetails.avatar) {
                  const avatarEl = card.querySelector('.creator-avatar');
                  if (avatarEl) {
                    avatarEl.classList.add('image-loading-placeholder');
                    avatarEl.src = userDetails.avatar;
                  }
                }
              }
            } else {
              const creatorEl = card.querySelector('.creator-name');
              if (creatorEl) creatorEl.textContent = 'Unknown Creator';
              const roomEl = card.querySelector('.room-link');
              if (roomEl) {
                roomEl.previousElementSibling?.remove();
                roomEl.remove();
              }
            }
          })();
        });
      }
      
      if (resultsLength < roomPhotosFeedTake) {
        roomPhotosHasMore = false;
        break;
      }
      if (matched.length > 0) {
        roomPhotosFeedSkip += roomPhotosFeedTake;
        roomPhotosHasMore = (roomPhotosTotalPagesSearched < 6);
        break;
      }
      if (roomPhotosTotalPagesSearched >= 6) {
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
      // Create Feed Post Card
      const card = document.createElement('div');
      card.className = 'feed-post-card';
      
      const photoId = photo.Id || photo.id;
      const cheers = photo.CheerCount || photo.cheerCount || 0;
      const comments = photo.CommentCount || photo.commentCount || 0;
      const captionText = photo.Description || photo.description || '';
      
      let dateStr = '';
      const createdAt = photo.CreatedAt || photo.createdAt;
      if (createdAt) {
        try {
          dateStr = new Date(createdAt).toLocaleString();
        } catch (e) {
          dateStr = createdAt;
        }
      }
      
      const imgName = photo.ImageName || photo.imageName || '';
      
      card.innerHTML = `
        <div class="feed-post-header">
          <img class="feed-post-avatar creator-avatar image-loading-placeholder" src="https://img.radie.app/DefaultProfileImage?width=96&cropSquare=1" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./logo.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" />
          <div class="feed-post-header-text">
            <div class="feed-post-creator creator-name">Loading...</div>
            <div class="feed-post-meta">
              <span>in</span>
              <span class="feed-post-room room-link">Loading...</span>
              <span class="feed-post-dot">•</span>
              <span class="feed-post-time">${dateStr}</span>
            </div>
          </div>
        </div>
        ${captionText ? `<div class="feed-post-description">${escapeHtml(captionText)}</div>` : ''}
        <div class="feed-post-image-wrap image-wrap">
          <img class="feed-post-image image-loading-placeholder" src="${imgName ? `https://img.radie.app/${imgName}?width=480` : './images.png'}" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./images.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" />
        </div>
        <div class="feed-post-footer">
          <span class="feed-post-stat"><span class="cheers-count">${cheers}</span> Cheers</span>
          <span class="feed-post-stat"><span class="comments-count">${comments}</span> Comments</span>
        </div>
      `;
      
      // Hook up clicks
      const imgWrap = card.querySelector('.image-wrap');
      if (imgWrap) {
        imgWrap.onclick = () => showPhotoDetails(photo, 'people-detail');
      }
      
      photosGrid.appendChild(card);
      
      // Asynchronously fetch photo web details in background
      (async () => {
        const details = await getPhotoWebDetails(photoId);
        if (details && details.success) {
          const creatorName = details.creatorUsername || 'Unknown';
          const roomName = details.roomName || '';
          
          const creatorEl = card.querySelector('.creator-name');
          if (creatorEl) {
            creatorEl.textContent = creatorName;
            creatorEl.onclick = (e) => {
              e.stopPropagation();
              showCreatorProfile(creatorName);
            };
          }
          
          const roomEl = card.querySelector('.room-link');
          if (roomEl) {
            if (roomName && roomName.toLowerCase() !== 'none') {
              roomEl.textContent = roomName;
              roomEl.onclick = (e) => {
                e.stopPropagation();
                showRoomByName(roomName);
              };
            } else {
              roomEl.previousElementSibling?.remove(); // remove 'in'
              roomEl.remove();
            }
          }
          
          // Asynchronously fetch creator avatar in background
          if (creatorName && creatorName !== 'Unknown') {
            const userDetails = await getUserWebDetails(creatorName);
            if (userDetails && userDetails.success && userDetails.avatar) {
              const avatarEl = card.querySelector('.creator-avatar');
              if (avatarEl) {
                avatarEl.classList.add('image-loading-placeholder');
                avatarEl.src = userDetails.avatar;
              }
            }
          }
        } else {
          const creatorEl = card.querySelector('.creator-name');
          if (creatorEl) creatorEl.textContent = 'Unknown Creator';
          const roomEl = card.querySelector('.room-link');
          if (roomEl) {
            roomEl.previousElementSibling?.remove();
            roomEl.remove();
          }
        }
      })();
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
  $('tab-photo-detail').classList.add('active');
  
  // Render initial photo fields we have
  const imgEl = $('photoDetailImage');
  if (imgEl) {
    imgEl.classList.add('image-loading-placeholder');
    const imgName = photo.ImageName || photo.imageName || '';
    imgEl.src = imgName ? `https://img.radie.app/${imgName}?width=720` : './images.png';
    imgEl.onload = () => imgEl.classList.remove('image-loading-placeholder');
    imgEl.onerror = () => { imgEl.src = './images.png'; imgEl.classList.remove('image-loading-placeholder'); imgEl.onerror = null; };
  }
  
  const captionEl = $('photoDetailCaption');
  if (captionEl) {
    captionEl.textContent = photo.Description || photo.description || 'No description.';
  }
  
  const cheersEl = $('photoDetailCheers');
  if (cheersEl) cheersEl.textContent = photo.CheerCount || photo.cheerCount || '0';
  
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
    creatorAvatarEl.src = 'https://img.radie.app/DefaultProfileImage?width=34&cropSquare=1';
  }
  const roomLinkEl = $('photoDetailRoomLink');
  if (roomLinkEl) roomLinkEl.style.display = 'none';
  const noRoomEl = $('photoDetailNoRoom');
  if (noRoomEl) noRoomEl.style.display = 'block';
  const creatorLinkEl = $('photoDetailCreatorLink');
  if (creatorLinkEl) creatorLinkEl.onclick = null;
  
  // Fetch scraped details from photo webpage
  const res = await getPhotoWebDetails(photoId);
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
      const userWeb = await getUserWebDetails(creatorUsername);
      if (userWeb && userWeb.success && userWeb.avatar && creatorAvatarEl) {
        creatorAvatarEl.classList.add('image-loading-placeholder');
        creatorAvatarEl.src = userWeb.avatar;
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
        roomLinkEl.style.display = 'block';
        roomLinkEl.onclick = (e) => {
          e.stopPropagation();
          showRoomByName(roomName);
        };
      }
      if (noRoomEl) noRoomEl.style.display = 'none';
    }
  } else {
    if (creatorNameEl) creatorNameEl.textContent = 'Unknown';
    if (creatorAvatarEl) creatorAvatarEl.classList.remove('image-loading-placeholder');
  }
}

$('btnPhotoDetailBack')?.addEventListener('click', () => {
  $('tab-photo-detail').classList.remove('active');
  
  if (currentBackToView === 'rooms-detail') {
    switchTab('rooms');
    const list = $('roomsListView');
    const detail = $('roomsDetailView');
    if (list && detail) {
      list.classList.add('hidden');
      detail.classList.remove('hidden');
    }
  } else if (currentBackToView === 'people-detail') {
    switchTab('people');
    const list = $('peopleListView');
    const detail = $('peopleDetailView');
    if (list && detail) {
      list.classList.add('hidden');
      detail.classList.remove('hidden');
    }
  } else {
    switchTab('home');
  }
});



async function showRoomDetails(room) {
  const list = $('roomsListView');
  const detail = $('roomsDetailView');
  if (!list || !detail) return;
  
  const imgName = room.ImageName || room.imageName || '';
  const thumbUrl = imgName ? `https://img.radie.app/${imgName}?width=720` : './images.png';
  
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
    creatorAvatarEl.src = 'https://img.radie.app/DefaultProfileImage?width=34&cropSquare=1';
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

  // Load scraped web details asynchronously
  const webDetails = await window.radium?.fetchRoomWebDetails(room.Name);
  if (webDetails && webDetails.success) {
    if (cheersEl) cheersEl.textContent = webDetails.cheers;
    if (favsEl) favsEl.textContent = webDetails.favorites;
    if (visitsEl) visitsEl.textContent = webDetails.visits;
    if (descEl) descEl.textContent = webDetails.description || 'No description available.';
    if (webDetails.creatorAvatar && creatorAvatarEl) {
      creatorAvatarEl.classList.add('image-loading-placeholder');
      creatorAvatarEl.src = webDetails.creatorAvatar;
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
  
  const profileImg = person.profileImage || '';
  const isDefault = !profileImg || profileImg === 'DefaultProfileImage';
  const avatarUrl = isDefault ? 'https://img.radie.app/DefaultProfileImage?width=96&cropSquare=1' : `https://img.radie.app/${profileImg}?width=96&cropSquare=1`;
  
  const avatarEl = $('peopleDetailAvatar');
  if (avatarEl) {
    avatarEl.classList.add('image-loading-placeholder');
    avatarEl.onload = () => { avatarEl.classList.remove('image-loading-placeholder'); avatarEl.onload = null; };
    avatarEl.src = avatarUrl;
    avatarEl.onerror = () => { avatarEl.src = './logo.png'; avatarEl.classList.remove('image-loading-placeholder'); avatarEl.onerror = null; };
    avatarEl.style.cursor = 'pointer';
    avatarEl.title = 'Click to view full size';
    avatarEl.onclick = () => {
      const fullUrl = isDefault ? 'https://img.radie.app/DefaultProfileImage' : `https://img.radie.app/${profileImg}`;
      showLightbox(fullUrl);
    };
  }
  
  const nameEl = $('peopleDetailDisplayName');
  if (nameEl) nameEl.textContent = person.displayName || person.userName || 'Unknown Player';
  
  const userEl = $('peopleDetailUsername');
  if (userEl) userEl.textContent = `@${person.userName || ''}`;

  const aboutLabelEl = $('peopleDetailAboutLabel');
  if (aboutLabelEl) aboutLabelEl.textContent = `About ${person.displayName || person.userName || 'Player'}`;
  
  const friendsEl = $('peopleDetailFriends');
  if (friendsEl) friendsEl.textContent = '...';
  const subsEl = $('peopleDetailSubscribers');
  if (subsEl) subsEl.textContent = '...';
  const visitsEl = $('peopleDetailVisits');
  if (visitsEl) visitsEl.textContent = '...';
  const bioEl = $('peopleDetailBio');
  if (bioEl) bioEl.textContent = 'Loading bio from web...';
  
  const dotEl = $('peopleDetailStatusDot');
  const labelEl = $('peopleDetailStatusLabel');
  const activityEl = $('peopleDetailActivityBadge');
  
  const isOnline = person.isOnline;
  if (dotEl) {
    dotEl.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
  }
  if (labelEl) {
    labelEl.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
  }
  if (activityEl) {
    activityEl.style.display = 'none';
    activityEl.textContent = '';
  }
  
  const bannerEl = $('peopleDetailBanner');
  if (bannerEl) {
    bannerEl.style.backgroundImage = 'linear-gradient(135deg, var(--green-dim), var(--green))';
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
    if (friendsEl) friendsEl.textContent = webDetails.friends;
    if (subsEl) subsEl.textContent = webDetails.subscribers;
    if (visitsEl) visitsEl.textContent = webDetails.visits;
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
      // If no status was scraped, fallback to person.isOnline
      if (dotEl) dotEl.className = `status-dot ${person.isOnline ? 'online' : 'offline'}`;
      if (labelEl) labelEl.textContent = person.isOnline ? 'ONLINE' : 'OFFLINE';
    }
  } else {
    if (friendsEl) friendsEl.textContent = '—';
    if (subsEl) subsEl.textContent = '—';
    if (visitsEl) visitsEl.textContent = '—';
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
        
        // Trigger observer layouts on tab switch
        if (t.btn.id === 'tabBtnPeoplePhotos') {
          setupPlayerPhotoObserver();
        } else if (t.btn.id === 'tabBtnPeopleFeeds') {
          setupPlayerFeedsObserver();
        } else if (t.btn.id === 'tabBtnPeopleRooms') {
          setupPlayerRoomsObserver();
        }
      };
    }
  });
  
  // Reset tabs to Photos active by default
  if (tabs[0].btn) tabs[0].btn.click();

  // Load player data for all tabs
  loadPlayerPhotos(person.id);
  loadPlayerFeeds(person.id);
  loadPlayerRooms(person.id);
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
      // Create Feed Post Card
      const card = document.createElement('div');
      card.className = 'feed-post-card';
      
      const photoId = photo.Id || photo.id;
      const cheers = photo.CheerCount || photo.cheerCount || 0;
      const comments = photo.CommentCount || photo.commentCount || 0;
      const captionText = photo.Description || photo.description || '';
      
      let dateStr = '';
      const createdAt = photo.CreatedAt || photo.createdAt;
      if (createdAt) {
        try {
          dateStr = new Date(createdAt).toLocaleString();
        } catch (e) {
          dateStr = createdAt;
        }
      }
      
      const imgName = photo.ImageName || photo.imageName || '';
      
      card.innerHTML = `
        <div class="feed-post-header">
          <img class="feed-post-avatar creator-avatar image-loading-placeholder" src="https://img.radie.app/DefaultProfileImage?width=96&cropSquare=1" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./logo.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" />
          <div class="feed-post-header-text">
            <div class="feed-post-creator creator-name">Loading...</div>
            <div class="feed-post-meta">
              <span>in</span>
              <span class="feed-post-room room-link">Loading...</span>
              <span class="feed-post-dot">•</span>
              <span class="feed-post-time">${dateStr}</span>
            </div>
          </div>
        </div>
        ${captionText ? `<div class="feed-post-description">${escapeHtml(captionText)}</div>` : ''}
        <div class="feed-post-image-wrap image-wrap">
          <img class="feed-post-image image-loading-placeholder" src="${imgName ? `https://img.radie.app/${imgName}?width=480` : './images.png'}" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./images.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" />
        </div>
        <div class="feed-post-footer">
          <span class="feed-post-stat"><span class="cheers-count">${cheers}</span> Cheers</span>
          <span class="feed-post-stat"><span class="comments-count">${comments}</span> Comments</span>
        </div>
      `;
      
      // Hook up clicks
      const imgWrap = card.querySelector('.image-wrap');
      if (imgWrap) {
        imgWrap.onclick = () => showPhotoDetails(photo, 'people-detail');
      }
      
      grid.appendChild(card);
      
      // Asynchronously fetch photo web details in background
      (async () => {
        const details = await getPhotoWebDetails(photoId);
        if (details && details.success) {
          const creatorName = details.creatorUsername || 'Unknown';
          const roomName = details.roomName || '';
          
          const creatorEl = card.querySelector('.creator-name');
          if (creatorEl) {
            creatorEl.textContent = creatorName;
            creatorEl.onclick = (e) => {
              e.stopPropagation();
              showCreatorProfile(creatorName);
            };
          }
          
          const roomEl = card.querySelector('.room-link');
          if (roomEl) {
            if (roomName && roomName.toLowerCase() !== 'none') {
              roomEl.textContent = roomName;
              roomEl.onclick = (e) => {
                e.stopPropagation();
                showRoomByName(roomName);
              };
            } else {
              roomEl.previousElementSibling?.remove(); // remove 'in'
              roomEl.remove();
            }
          }
          
          // Asynchronously fetch creator avatar in background
          if (creatorName && creatorName !== 'Unknown') {
            const userDetails = await getUserWebDetails(creatorName);
            if (userDetails && userDetails.success && userDetails.avatar) {
              const avatarEl = card.querySelector('.creator-avatar');
              if (avatarEl) {
                avatarEl.classList.add('image-loading-placeholder');
                avatarEl.src = userDetails.avatar;
              }
            }
          }
        } else {
          const creatorEl = card.querySelector('.creator-name');
          if (creatorEl) creatorEl.textContent = 'Unknown Creator';
          const roomEl = card.querySelector('.room-link');
          if (roomEl) {
            roomEl.previousElementSibling?.remove();
            roomEl.remove();
          }
        }
      })();
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
      const imgName = room.ImageName || room.imageName || '';
      const imgUrl = imgName ? `https://img.radie.app/${imgName}?width=400` : './images.png';
      const roomName = room.Name || room.name || 'Unknown Room';
      const creatorUsername = room.CreatorUsername || room.creatorUsername || 'Unknown';
      roomCard.innerHTML = `
        <img class="room-card-image image-loading-placeholder" src="${imgUrl}" onload="this.classList.remove('image-loading-placeholder');" onerror="this.src='./images.png'; this.classList.remove('image-loading-placeholder'); this.onerror=null;" alt="${escapeHtml(roomName)}" />
        <div class="room-card-name" title="${escapeHtml(roomName)}">${escapeHtml(roomName)}</div>
        <div class="room-card-creator" onclick="event.stopPropagation(); showCreatorProfile('${escapeHtml(creatorUsername)}')" title="View creator's profile">by ${escapeHtml(creatorUsername)}</div>
        <div class="room-card-stats">
          <span>Cheers: <span class="room-card-cheers">...</span></span>
          <span>Visits: <span class="room-card-visits">...</span></span>
        </div>
      `;
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

function showLightbox(src) {
  if (lightboxModal && lightboxImage) {
    lightboxImage.classList.add('image-loading-placeholder');
    lightboxImage.src = src;
    lightboxImage.onload = () => lightboxImage.classList.remove('image-loading-placeholder');
    lightboxImage.onerror = () => {
      const avatarEl = $('peopleDetailAvatar');
      if (avatarEl && lightboxImage.src !== avatarEl.src) {
        lightboxImage.src = avatarEl.src;
      } else {
        lightboxImage.classList.remove('image-loading-placeholder');
      }
      lightboxImage.onerror = null;
    };
    lightboxModal.style.display = 'flex';
  }
}

function hideLightbox() {
  if (lightboxModal) {
    lightboxModal.style.display = 'none';
  }
}

lightboxCloseBtn?.addEventListener('click', hideLightbox);
lightboxModal?.addEventListener('click', (e) => {
  if (e.target === lightboxModal) {
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
    setStatus('');
    
    if (cooldownTimer) clearInterval(cooldownTimer);
    
    cooldownTimer = setInterval(() => {
      cooldownTimeLeft--;
      if (cooldownTimeLeft <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        btnSubmit.disabled = false;
        txtReport.disabled = false;
        btnSubmit.textContent = 'SUBMIT BUG REPORT';
      } else {
        btnSubmit.textContent = `COOLDOWN (${cooldownTimeLeft}s)`;
      }
    }, 1000);
  }

  btnSubmit.addEventListener('click', async () => {
    const bugText = txtReport.value.trim();
    
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
    btnSubmit.textContent = 'SUBMITTING...';
    setStatus('Submitting report to Discord...', 'info');

    // Use the full unbounded log buffer (not the capped DOM viewer)
    // This ensures early startup logs are always included in bug reports.
    const fullLogs = fullLogBuffer.join('\n');

    try {
      // 3. Invoke Tauri backend command
      const responseMessage = await window.radium.submitBugReport(bugText, fullLogs);
      
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
      btnSubmit.textContent = 'SUBMIT BUG REPORT';
    }
  });
})();

