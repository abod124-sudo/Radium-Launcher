// App state variables
let config         = {};
let isGameRunning  = false;
let isDownloading  = false;
let isInstalled    = false;
let playMode       = 'screen';

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
let toastTimer = null;
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
  if (!config.apiUrl)   config.apiUrl   = 'https://ns.radie.app';
  if (!config.playMode) config.playMode = 'screen';

  setValue('cfgApiUrl', config.apiUrl);
  setValue('cfgExePath', config.gameExePath || '');

  setToggle('tgl-minimizeOnLaunch', config.minimizeOnLaunch !== false);
  setToggle('tgl-autoUpdate',       config.autoUpdate       !== false);

  // Play mode
  playMode = config.playMode || 'screen';
  setModeUI(playMode);
  updateQsMode();

  // Theme
  const activeTheme = config.theme || 'steam-green';
  setValue('cfgTheme', activeTheme);
  applyTheme(activeTheme);
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
    apiUrl:           $('cfgApiUrl')?.value.trim() || 'https://ns.radie.app',
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
    const exePath = result.exePath || '';
    $('launchPathDisplay').textContent = exePath || 'Installed';
    $('cfgExePath').value              = exePath;
    config.gameExePath                 = exePath;
    $('qsInstalled').textContent       = 'INSTALLED';
    if (qscC) {
      qscC.classList.add('installed');
      qscC.classList.remove('not-installed');
    }
    addLog('Game client found: ' + (exePath || 'client dir'), 'ok');
  } else {
    // Show download section, hide launch panel
    $('downloadSection').style.display = 'block';
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

  if (fill)    fill.style.width = `${pct}%`;
  if (pctEl)   pctEl.textContent = `${pct}%`;

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
  $('downloadSection').style.display = 'block';
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
    await checkInstall();
  } else {
    const err = result?.error || 'Unknown error';
    addLog(`Uninstall failed: ${err}`, 'error');
    toast(`Uninstall failed: ${err}`, 'error');
  }
});

// Play mode configuration
function setModeUI(mode) {
  $('modeScreen')?.classList.toggle('active', mode === 'screen');
  $('modeVR')?.classList.toggle('active',     mode === 'vr');
}

function updateQsMode() {
  const el = $('qsMode');
  if (el) el.textContent = playMode === 'vr' ? 'VR MODE' : 'SCREEN MODE';
  const qscM = $('qsc-mode');
  if (qscM) {
    if (playMode === 'vr') {
      qscM.classList.add('mode-vr');
      qscM.classList.remove('mode-screen');
    } else {
      qscM.classList.add('mode-screen');
      qscM.classList.remove('mode-vr');
    }
  }
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
  const apiUrl = config.apiUrl || 'https://ns.radie.app';
  const apiResult = await window.radium?.pingServer(apiUrl);
  const apiOnline  = apiResult?.online ?? false;

  // Ping the game download CDN separately
  const cdnUrl = 'https://cdn.recroomarchive.org';
  const cdnResult = await window.radium?.pingServer(cdnUrl);
  const cdnOnline = cdnResult?.online ?? false;

  // Quick stats
  const qsS = $('qsStatus'); if (qsS) qsS.textContent = apiOnline ? 'ONLINE' : 'OFFLINE';
  const qscS = $('qsc-status');
  if (qscS) {
    if (apiOnline) {
      qscS.classList.add('online');
      qscS.classList.remove('offline');
    } else {
      qscS.classList.add('offline');
      qscS.classList.remove('online');
    }
  }

  // Status tab cards
  updateCard('sc-api',    apiOnline);
  updateCard('sc-ws',     apiOnline);
  updateCard('sc-assets', cdnOnline);

  // Dynamically update host text on status cards based on current settings
  try {
    const apiHost = new URL(apiUrl).hostname;
    const scApiLabel = document.querySelector('#sc-api .sc-label');
    if (scApiLabel) scApiLabel.textContent = `REST API · ${apiHost}`;

    const scWsLabel = document.querySelector('#sc-ws .sc-label');
    if (scWsLabel) scWsLabel.textContent = `Realtime Gateway · ${apiHost}`;
  } catch (e) {}

  if (!silent) {
    addLog(`API Gateway (${apiUrl}): ${apiOnline ? 'ONLINE' : 'OFFLINE'}`, apiOnline ? 'ok' : 'error');
    addLog(`CDN Server (${cdnUrl}): ${cdnOnline ? 'ONLINE' : 'OFFLINE'}`, cdnOnline ? 'ok' : 'error');
  }
}

function updateCard(id, online) {
  const card = $(id); if (!card) return;
  card.className = 'status-card ' + (online ? 'online' : 'offline');
  // Update the state label inside the card
  const ids = { 'sc-api': 'sc-api-state', 'sc-ws': 'sc-ws-state', 'sc-assets': 'sc-assets-state' };
  const stateEl = $(ids[id]); if (stateEl) stateEl.textContent = online ? 'ONLINE' : 'OFFLINE';
}

$('btnRefreshStatus')?.addEventListener('click', () => {
  checkServerStatus(false);
  toast('Refreshing...', 'info', 1200);
});

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

$('btnPlay')?.addEventListener('click', async () => {
  if (isGameRunning || !isInstalled) return;
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

// Launcher entrypoint initialization
async function init() {
  addLog('Radium Launcher started.', 'ok');
  await loadVersion();
  await loadConfig();
  addLog(`API: ${config.apiUrl}`, 'info');
  addLog(`Install dir: %APPDATA%\\radium-launcher\\client`, 'info');

  // Check install first (determines which panel to show)
  await checkInstall();

  // Then ping server
  await checkServerStatus(true);

  // Auto-refresh every 30s
  setInterval(() => checkServerStatus(true), 30_000);
}

init().catch(err => {
  addLog(`Init error: ${err.message}`, 'error');
  console.error(err);
});
