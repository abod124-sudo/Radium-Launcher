// App state variables
let config                = {};
let isGameRunning         = false;
let isDownloading         = false;
let isInstalled           = false;
let playMode              = 'screen';
let launchAfterExclusion  = false;

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
  const out = $('logOutput');
  if (!out) return;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `[${ts}] ${msg}`;
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
    const p = $('tab-' + btn.dataset.tab);
    if (p) p.classList.add('active');
  });
});

// Titlebar actions
$('btnMinimize')?.addEventListener('click', () => window.radium?.minimize());
$('btnClose')?.addEventListener('click',    () => window.radium?.close());

// Sidebar logo image load failure fallback
const logoImg = $('sidebarLogo');
if (logoImg) {
  logoImg.addEventListener('error', () => {
    const combo = $('logoCombo');
    if (combo) combo.style.display = 'none';
    $('logoFallback').style.display = 'flex';
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
  setValue('cfgExePath', config.gameExePath || '');

  setToggle('tgl-minimizeOnLaunch', config.minimizeOnLaunch !== false);
  setToggle('tgl-autoUpdate',       config.autoUpdate       !== false);

  // Play mode
  playMode = config.playMode || 'screen';
  setModeUI(playMode);
  updateQsMode();
  updateSettingsLaunchScript();

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
  document.body.className = '';
  if (theme && theme !== 'steam-green') {
    document.body.classList.add('theme-' + theme);
  }
}

function setValue(id, val) { const el = $(id); if (el) el.value = val; }

function setToggle(id, val) {
  const el = $(id); if (!el) return;
  if (val) el.classList.add('on'); else el.classList.remove('on');
}
function getToggle(id) { return $(id)?.classList.contains('on') ?? false; }

['tgl-minimizeOnLaunch', 'tgl-autoUpdate'].forEach(id =>
  $(id)?.addEventListener('click', () => $(id).classList.toggle('on'))
);

$('cfgTheme')?.addEventListener('change', () => {
  applyTheme($('cfgTheme').value);
});

// Save
$('btnSaveSettings')?.addEventListener('click', async () => {
  const selectedTheme = $('cfgTheme')?.value || 'steam-green';
  const updated = {
    ...config,
    apiUrl:           $('cfgApiUrl')?.value.trim() || 'https://api.radie.app/',
    minimizeOnLaunch: getToggle('tgl-minimizeOnLaunch'),
    autoUpdate:       getToggle('tgl-autoUpdate'),
    playMode,
    theme:            selectedTheme,
  };
  applyTheme(selectedTheme);
  const ok = await window.radium?.saveConfig(updated);
  if (ok) {
    config = updated;
    toast('Settings saved!', 'ok');
    addLog('Configuration saved.', 'ok');
  } else {
    toast('Failed to save.', 'error');
  }
});

// Test server
$('btnTestServer')?.addEventListener('click', async () => {
  const url = $('cfgApiUrl')?.value.trim() || config.apiUrl;
  if (!url) { toast('Enter an API URL first.', 'error'); return; }
  const tr = $('testResult');
  tr.textContent = 'Testing...'; tr.className = 'test-result';
  const result = await window.radium?.pingServer(url);
  if (result?.online) {
    tr.textContent = '✓ Online';
    tr.className = 'test-result ok';
    toast('Online!', 'ok');
  } else {
    tr.textContent = '✕ Offline or unreachable';
    tr.className = 'test-result error';
    toast('Server unreachable.', 'error');
  }
});

// Check client installation state
async function checkInstall() {
  const result = await window.radium?.checkInstall();
  isInstalled = result?.installed ?? false;
  const qscC = $('qsc-client');

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

// Reinstall button
$('btnReinstall')?.addEventListener('click', () => {
  if (isDownloading) {
    toast('Download already in progress.', 'error');
    return;
  }
  if (isGameRunning) {
    toast('Cannot reinstall while the game is running.', 'error');
    return;
  }
  $('downloadSection').style.display = 'flex';
  $('launchPanel').style.display     = 'none';
  isInstalled = false;
  addLog('Reinstall initiated.', 'info');
  toast('Starting reinstall...', 'info');
  $('btnDownload')?.click();
});

// Uninstall button
$('btnUninstall')?.addEventListener('click', async () => {
  if (isGameRunning) {
    toast('Cannot uninstall while the game is running.', 'error');
    return;
  }
  const confirmed = confirm('Are you sure you want to uninstall the Radium client? This will delete all downloaded game files.');
  if (!confirmed) return;

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

// Exclude AV Modal Actions
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
  await checkSteamAndLaunch();
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
    
    // Check if we need to proceed to Steam check and launch
    if (launchAfterExclusion) {
      launchAfterExclusion = false;
      await checkSteamAndLaunch();
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

function updateSettingsLaunchScript() {
  const exePathInput = $('cfgExePath');
  if (!exePathInput) return;
  const currentPath = exePathInput.value;
  if (!currentPath) return;

  const isVr = playMode === 'vr';
  const targetFilename = isVr ? 'RecRoom_VR.bat' : 'RecRoom_ScreenMode.bat';
  
  const lastSlashIndex = Math.max(currentPath.lastIndexOf('\\'), currentPath.lastIndexOf('/'));
  if (lastSlashIndex !== -1) {
    const dir = currentPath.substring(0, lastSlashIndex);
    const slash = currentPath.includes('\\') ? '\\' : '/';
    exePathInput.value = `${dir}${slash}${targetFilename}`;
  }
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    playMode = btn.dataset.mode;
    config.playMode = playMode;
    setModeUI(playMode);
    updateQsMode();
    updateSettingsLaunchScript();
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
    addLog('Steam is not running. Prompting user...', 'info');
    showSteamModal();
  }
}

$('btnPlay')?.addEventListener('click', async () => {
  if (isGameRunning || !isInstalled) return;

  const isCurrentlyExcluded = config.defenderExcluded === true;

  if (!isCurrentlyExcluded) {
    addLog('Antivirus exclusion not set. Prompting user...', 'info');
    launchAfterExclusion = true;
    showExcludeAvModal();
  } else {
    await checkSteamAndLaunch();
  }
});

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
  $('updateModal').style.display = 'flex';
}

function hideUpdateModal() {
  $('updateModal').style.display = 'none';
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
      toast(`Update available: ${info.latestVersion}!`, 'ok', 5000);
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
  addLog(`Install dir: %APPDATA%\\radium-launcher\\client`, 'info');

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
}

init().catch(err => {
  addLog(`Init error: ${err.message}`, 'error');
  console.error(err);
});
