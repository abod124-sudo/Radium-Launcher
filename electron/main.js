const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const { spawn, exec } = require('child_process');
const os     = require('os');

function getPowershellPath() {
  if (process.platform !== 'win32') return 'powershell';
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(psPath) ? psPath : 'powershell';
}


const GITHUB_OWNER = 'abod124-sudo';
const GITHUB_REPO  = 'Radium-Launcher';

// Client folders and paths under local AppData
const USER_DATA  = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const CLIENT_DIR  = path.join(USER_DATA, 'client');
const CLIENT_ZIP  = path.join(USER_DATA, 'client.zip');

const DOWNLOAD_URL = 'https://cdn.recroomarchive.org/radium/game-client/production/toukeh24kq6w2v4lndyc4z0pblvfyj75/windows/client.zip';

const DEFAULT_CONFIG = {
  apiUrl:           'https://api.radie.app/',
  gameExePath:      '',          // auto-set after install
  playMode:         'screen',    // 'screen' | 'vr'
  minimizeOnLaunch: true,
  autoUpdate:       true,
};

// Config management helper functions
function ensureConfig() {
  if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved && (saved.apiUrl === 'https://ns.radie.app' || saved.apiUrl === 'https://ns.radie.app/')) {
      saved.apiUrl = 'https://api.radie.app/';
      saveConfig(saved);
    }
    return { ...DEFAULT_CONFIG, ...saved };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── Find bat after extraction ────────────────────────────────────────────────
function findBatIn(dir, name, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  // Match exact name
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase())
      return path.join(dir, e.name);
  }
  // Recurse into subdirs
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findBatIn(path.join(dir, e.name), name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Helper to download files (handles HTTP redirects and tracks download speed/ETA)
const clientDownloadState = { req: null, aborted: false };
const updateDownloadState = { req: null, aborted: false };

function doDownload(url, destPath, onProgress, cancelState) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (cancelState) cancelState.req = null;
        res.resume();
        const resolvedUrl = new URL(res.headers.location, url).toString();
        return doDownload(resolvedUrl, destPath, onProgress, cancelState)
          .then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const total     = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded  = 0;
      const startTime = Date.now();
      const stream    = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        if (cancelState && cancelState.aborted) { req.destroy(); stream.destroy(); return; }
        downloaded += chunk.length;
        stream.write(chunk);

        const elapsed = (Date.now() - startTime) / 1000 || 0.001;
        const speed   = downloaded / elapsed;                 // bytes/s
        const pct     = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
        const eta     = total > 0 && speed > 0 ? Math.round((total - downloaded) / speed) : -1;
        onProgress({ downloaded, total, pct, speed, eta });
      });

      res.on('end', () => {
        stream.end(() => {
          if (cancelState && cancelState.aborted) { reject(new Error('Cancelled')); return; }
          resolve();
        });
      });

      res.on('error', (e) => { stream.destroy(); reject(e); });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

    if (cancelState) {
      if (cancelState.aborted) {
        req.destroy();
        reject(new Error('Cancelled'));
        return;
      }
      cancelState.req = req;
    }
  });
}

function checkGameRunning() {
  return new Promise((res) => {
    exec('tasklist /NH /FI "IMAGENAME eq RecRoom.exe"', (err, stdout) => {
      res(!!(stdout && stdout.toLowerCase().includes('recroom.exe')));
    });
  });
}

function checkSteamRunning() {
  return new Promise((res) => {
    exec('tasklist /NH /FI "IMAGENAME eq steam.exe"', (err, stdout) => {
      res(!!(stdout && stdout.toLowerCase().includes('steam.exe')));
    });
  });
}

// Monitor running game process in background
let gameProcess = null;
let gameMonitor = null;
let mainWindow  = null;
let gameStartChecks = 0;
const MAX_START_CHECKS = 8; // 16 seconds max startup grace period

function startGameMonitor() {
  if (gameMonitor) return;
  gameStartChecks = 0;
  gameMonitor = setInterval(() => {
    exec('tasklist /NH /FI "IMAGENAME eq RecRoom.exe"', (err, stdout) => {
      const running = stdout && stdout.toLowerCase().includes('recroom.exe');
      if (gameStartChecks < MAX_START_CHECKS) {
        gameStartChecks++;
        if (running) {
          gameStartChecks = MAX_START_CHECKS; // Locked in, process found
        }
        return;
      }
      if (!running) {
        gameProcess = null;
        mainWindow?.webContents.send('game-state', { running: false });
        clearInterval(gameMonitor);
        gameMonitor = null;
      }
    });
  }, 2000);
}

// Simple server ping check (runs on HTTP GET /health or /)
function pingServer(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ online: false, latency: -1 }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    // Determine path based on domain target
    const isApi = parsed.hostname.includes('radie') || parsed.hostname.includes('radium') || parsed.port;
    const requestPath = isApi ? '/health' : '/';
    const req = lib.get(
      { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: requestPath, timeout: 5000 },
      (res) => {
        resolve({ online: res.statusCode < 500, latency: Date.now() - start, status: res.statusCode });
        res.resume();
      }
    );
    req.on('error', () => resolve({ online: false, latency: -1 }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, latency: -1 }); });
  });
}

// Fetch player count from the API
async function getPlayerCount() {
  let timeoutId;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds timeout

    const res = await fetch('https://api.radie.app/api/players/v1/online', {
      headers: { 'User-Agent': 'Radium-Launcher' },
      signal: controller.signal
    });

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    if (data && typeof data.count === 'number') {
      return { success: true, count: data.count };
    } else {
      return { success: false, error: 'Invalid response format' };
    }
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'Timeout' : err.message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Add Windows Defender exclusion for BepInEx dll
function addDefenderExclusion() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, error: 'Only supported on Windows.' });
  }
  return new Promise((resolve) => {
    const targetDllPath = path.join(CLIENT_DIR, 'BepInEx', 'plugins', 'Radeon.Core.BasePatch.dll');
    const escapedPath = targetDllPath.replace(/'/g, "''").replace(/\$/g, '`$');
    const psPath = getPowershellPath();
    const psCommand = `Start-Process '${psPath}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command "Add-MpPreference -ExclusionPath ''${escapedPath}''"' -Verb RunAs`;
    
    exec(`"${psPath}" -NoProfile -Command "${psCommand}"`, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

// Remove Windows Defender exclusion for BepInEx dll
function removeDefenderExclusion() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, error: 'Only supported on Windows.' });
  }
  return new Promise((resolve) => {
    const targetDllPath = path.join(CLIENT_DIR, 'BepInEx', 'plugins', 'Radeon.Core.BasePatch.dll');
    const escapedPath = targetDllPath.replace(/'/g, "''").replace(/\$/g, '`$');
    const psPath = getPowershellPath();
    const psCommand = `Start-Process '${psPath}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command "Remove-MpPreference -ExclusionPath ''${escapedPath}''"' -Verb RunAs`;
    
    exec(`"${psPath}" -NoProfile -Command "${psCommand}"`, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}



// Main app window setup
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 550,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0D0D0C',
    title: 'Radium Launcher',
    icon: process.platform === 'win32'
      ? path.join(__dirname, '..', 'icon.ico')
      : path.join(__dirname, '..', 'logo.png'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  clientDownloadState.aborted = true;
  if (clientDownloadState.req) try { clientDownloadState.req.destroy(); } catch {}
  updateDownloadState.aborted = true;
  if (updateDownloadState.req) try { updateDownloadState.req.destroy(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// IPC actions called from renderer script
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-close', () => {
  clientDownloadState.aborted = true;
  if (clientDownloadState.req) { try { clientDownloadState.req.destroy(); } catch {} }
  updateDownloadState.aborted = true;
  if (updateDownloadState.req) { try { updateDownloadState.req.destroy(); } catch {} }
  app.quit();
});

ipcMain.handle('get-config',  ()      => ensureConfig());
ipcMain.handle('save-config', (_e, c) => { saveConfig(c); return true; });
ipcMain.handle('ping-server', (_e, u) => pingServer(u));
ipcMain.handle('get-player-count', () => getPlayerCount());
ipcMain.handle('add-defender-exclusion', () => addDefenderExclusion());
ipcMain.handle('remove-defender-exclusion', () => removeDefenderExclusion());
ipcMain.handle('get-version', ()      => app.getVersion());
ipcMain.handle('check-steam', ()      => checkSteamRunning());

// Check if client is installed
ipcMain.handle('check-install', async () => {
  const cfg = ensureConfig();
  const exePath = cfg.gameExePath || findBatIn(CLIENT_DIR, 'RecRoom_ScreenMode.bat') || '';
  const installed = exePath !== '' && fs.existsSync(exePath);
  const isRunning = await checkGameRunning();
  if (isRunning) {
    startGameMonitor();
  }
  return { installed, exePath, clientDir: CLIENT_DIR, isRunning };
});

// Download + extract client
ipcMain.handle('download-client', async (event) => {
  const isRunning = await checkGameRunning();
  if (isRunning) return { success: false, error: 'Cannot download or install while the game is running.' };

  clientDownloadState.aborted = false;
  clientDownloadState.req = null;

  // Ensure dirs exist
  if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
  if (fs.existsSync(CLIENT_ZIP)) { try { fs.unlinkSync(CLIENT_ZIP); } catch {} }

  // Send progress helper
  const progress = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('download-progress', data);
  };

  try {
    // Phase 1: Download
    progress({ phase: 'download', pct: 0, downloaded: 0, total: 0, speed: 0, eta: -1 });
    await doDownload(DOWNLOAD_URL, CLIENT_ZIP, (p) => {
      progress({ phase: 'download', ...p });
    }, clientDownloadState);

    if (clientDownloadState.aborted) return { success: false, error: 'Cancelled' };

    // Phase 2: Extract
    progress({ phase: 'extract', pct: 100, status: 'Extracting...' });
    if (fs.existsSync(CLIENT_DIR)) {
      try { fs.rmSync(CLIENT_DIR, { recursive: true, force: true }); } catch {}
    }
    fs.mkdirSync(CLIENT_DIR, { recursive: true });

    await new Promise((resolve, reject) => {
      const zipEscaped = CLIENT_ZIP.replace(/'/g, "''");
      const dirEscaped = CLIENT_DIR.replace(/'/g, "''");
      const psPath = getPowershellPath();
      const cmd = `"${psPath}" -NoProfile -Command "Expand-Archive -LiteralPath '${zipEscaped}' -DestinationPath '${dirEscaped}' -Force"`;
      exec(cmd, { timeout: 120000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    // Cleanup zip
    try { fs.unlinkSync(CLIENT_ZIP); } catch {}

    // Find bat
    const batPath = findBatIn(CLIENT_DIR, 'RecRoom_ScreenMode.bat') || '';

    // Save bat path to config
    if (batPath) {
      const cfg = ensureConfig();
      cfg.gameExePath = batPath;
      saveConfig(cfg);
    }

    progress({ phase: 'done', pct: 100 });
    return { success: true, exePath: batPath };

  } catch (err) {
    try { if (fs.existsSync(CLIENT_ZIP)) fs.unlinkSync(CLIENT_ZIP); } catch {}
    return { success: false, error: err.message };
  }
});

// Uninstall client (removes files & resets config path)
ipcMain.handle('uninstall-client', async () => {
  const isRunning = await checkGameRunning();
  if (isRunning) return { success: false, error: 'Cannot uninstall while the game is running.' };

  try {
    if (fs.existsSync(CLIENT_DIR)) {
      fs.rmSync(CLIENT_DIR, { recursive: true, force: true });
    }
    const cfg = ensureConfig();
    cfg.gameExePath = '';
    cfg.defenderExcluded = false;
    saveConfig(cfg);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Cancel download
ipcMain.on('cancel-download', () => {
  clientDownloadState.aborted = true;
  if (clientDownloadState.req) {
    try { clientDownloadState.req.destroy(); } catch {}
    clientDownloadState.req = null;
  }
});

// Launch game
ipcMain.handle('launch-game', async (_e, cfg) => {
  console.log('[launch-game] called, cfg:', JSON.stringify(cfg));

  // Check if RecRoom.exe is already running
  const isRunning = await checkGameRunning();
  if (isRunning) return { success: false, error: 'Game already running.' };

  const batName = cfg.playMode === 'vr' ? 'RecRoom_VR.bat' : 'RecRoom_ScreenMode.bat';
  console.log('[launch-game] batName:', batName);

  // Build the direct bat path from CLIENT_DIR — always use the known location
  const directBatPath = path.join(CLIENT_DIR, batName);
  let batPath = '';

  if (fs.existsSync(directBatPath)) {
    batPath = directBatPath;
    console.log('[launch-game] found bat directly in CLIENT_DIR:', batPath);
  } else if (cfg.gameExePath && fs.existsSync(path.join(path.dirname(cfg.gameExePath), batName))) {
    batPath = path.join(path.dirname(cfg.gameExePath), batName);
    console.log('[launch-game] found bat via gameExePath sibling:', batPath);
  } else {
    batPath = findBatIn(CLIENT_DIR, batName) || '';
    console.log('[launch-game] findBatIn result:', batPath);
  }

  if (!batPath) {
    const msg = `Launch file not found: ${batName}\nLooked in: ${CLIENT_DIR}\n\nPlease download the client first.`;
    console.error('[launch-game]', msg);
    return { success: false, error: msg };
  }

  const batDir = path.dirname(batPath);
  console.log('[launch-game] launching:', batPath, '  cwd:', batDir);

  // Save the actual resolved bat path (not always the screen bat)
  const updatedCfg = ensureConfig();
  updatedCfg.gameExePath = batPath;
  saveConfig(updatedCfg);

  const exePath = path.join(batDir, 'RecRoom.exe');
  const playModeArg = cfg.playMode === 'vr' ? '+mode:vr' : '+mode:screen';
  const hasExe = fs.existsSync(exePath);

  const escapedExePath = exePath.replace(/'/g, "''").replace(/"/g, '\\"');
  const escapedBatDir = batDir.replace(/'/g, "''");
  const escapedBatPath = batPath.replace(/'/g, "''").replace(/"/g, '\\"');

  const commandLineStr = hasExe
    ? `\\"${escapedExePath}\\" ${playModeArg}`
    : `cmd.exe /c \\"${escapedBatPath}\\"`;

  const psPath = getPowershellPath();
  const psCommand = `"${psPath}" -NoProfile -Command "(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLineStr}'; CurrentDirectory = '${escapedBatDir}' }).ProcessId"`;

  console.log('[launch-game] launching via WMI:', psCommand);

  return new Promise((resolve) => {
    exec(psCommand, (err, stdout, stderr) => {
      if (err) {
        console.error('[launch-game] WMI launch error:', err.message, stderr);
        resolve({ success: false, error: err.message });
        return;
      }

      const pid = parseInt(stdout.trim(), 10);
      if (isNaN(pid) || pid <= 0) {
        console.error('[launch-game] WMI invalid PID output:', stdout);
        resolve({ success: false, error: 'Failed to start game process.' });
        return;
      }

      console.log('[launch-game] launched successfully, PID:', pid);
      gameProcess = { pid };
      startGameMonitor();
      mainWindow?.webContents.send('game-state', { running: true });
      if (cfg.minimizeOnLaunch) mainWindow?.minimize();
      resolve({ success: true, pid });
    });
  });
});

// Kill game
ipcMain.handle('kill-game', () => {
  exec('taskkill /F /IM RecRoom.exe', () => {});
  gameProcess = null;
  return true;
});

// Open client folder
ipcMain.handle('open-client-folder', () => {
  if (fs.existsSync(CLIENT_DIR)) {
    shell.openPath(CLIENT_DIR);
    return true;
  }
  return false;
});

// Debug: directly exec a bat file — call from DevTools: window.radium.debugExec('screen')
ipcMain.handle('debug-exec', (_e, mode) => {
  const batName = mode === 'vr' ? 'RecRoom_VR.bat' : 'RecRoom_ScreenMode.bat';
  const batPath = path.join(CLIENT_DIR, batName);
  const exists = fs.existsSync(batPath);
  console.log('[debug-exec] batPath:', batPath, '  exists:', exists);
  console.log('[debug-exec] CLIENT_DIR:', CLIENT_DIR);
  if (!exists) return { ok: false, msg: `Not found: ${batPath}` };
  return new Promise((resolve) => {
    exec(`"${batPath}"`, { cwd: CLIENT_DIR }, (err, stdout, stderr) => {
      console.log('[debug-exec] done. err:', err?.message, 'stdout:', stdout, 'stderr:', stderr);
      resolve({ ok: !err, err: err?.message, stdout, stderr });
    });
  });
});

// Debug: check all paths
ipcMain.handle('debug-paths', () => {
  const screenBat = path.join(CLIENT_DIR, 'RecRoom_ScreenMode.bat');
  const vrBat     = path.join(CLIENT_DIR, 'RecRoom_VR.bat');
  const exe       = path.join(CLIENT_DIR, 'RecRoom.exe');
  return {
    CLIENT_DIR,
    USER_DATA,
    screenBat,  screenBatExists: fs.existsSync(screenBat),
    vrBat,      vrBatExists:     fs.existsSync(vrBat),
    exe,        exeExists:       fs.existsSync(exe),
  };
});

ipcMain.on('open-url', (_e, url) => shell.openExternal(url));

// ─── Auto-update: check latest GitHub release ────────────────────────────────
function semverGt(a, b) {
  // Returns true if version a > version b
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

ipcMain.handle('check-for-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'Radium-Launcher-Updater' }
    };
    const req = https.get(options, (res) => {
      if (res.statusCode !== 200) {
        resolve({ hasUpdate: false, error: `GitHub API returned HTTP ${res.statusCode}` });
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const latestTag = data.tag_name || '';
          const currentVer = app.getVersion();
          const isNewer = semverGt(latestTag, currentVer);
          // Find the setup exe asset
          const asset = (data.assets || []).find(a =>
            a.name && a.name.toLowerCase().includes('setup') && a.name.endsWith('.exe')
          );
          resolve({
            hasUpdate: isNewer,
            currentVersion: currentVer,
            latestVersion:  latestTag,
            releaseUrl: data.html_url || '',
            downloadUrl: asset ? asset.browser_download_url : '',
            releaseNotes: data.body || ''
          });
        } catch (e) {
          resolve({ hasUpdate: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ hasUpdate: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, error: 'Timeout' }); });
    req.setTimeout(10000);
  });
});

ipcMain.handle('download-update', async (_e, downloadUrl) => {
  if (!downloadUrl) return { success: false, error: 'No download URL' };
  const tmpPath = path.join(os.tmpdir(), 'RadiumLauncherSetup_update.exe');
  try {
    updateDownloadState.aborted = false;
    updateDownloadState.req = null;
    await doDownload(downloadUrl, tmpPath, () => {}, updateDownloadState);
    // Spawn the installer detached so it outlives this process
    const child = spawn(tmpPath, [], {
      detached: true,
      stdio:    'ignore'
    });
    child.on('error', (err) => {
      console.error('Failed to start update installer:', err);
    });
    child.unref();
    // Give the installer a moment to start, then quit the launcher
    setTimeout(() => app.quit(), 1500);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
