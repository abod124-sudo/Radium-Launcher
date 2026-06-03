const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const { spawn, exec } = require('child_process');
const os     = require('os');

// Client folders and paths under local AppData
const USER_DATA  = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const CLIENT_DIR  = path.join(USER_DATA, 'client');
const CLIENT_ZIP  = path.join(USER_DATA, 'client.zip');

const DOWNLOAD_URL = 'https://cdn.recroomarchive.org/radium/game-client/production/toukeh24kq6w2v4lndyc4z0pblvfyj75/windows/client.zip';

const DEFAULT_CONFIG = {
  apiUrl:           'https://ns.radie.app',
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
let downloadReq  = null;
let downloadAborted = false;

function doDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        downloadReq = null;
        res.resume();
        return doDownload(res.headers.location, destPath, onProgress)
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
        if (downloadAborted) { req.destroy(); stream.destroy(); return; }
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
          if (downloadAborted) { reject(new Error('Cancelled')); return; }
          resolve();
        });
      });

      res.on('error', (e) => { stream.destroy(); reject(e); });
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    downloadReq = req;
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

// Main app window setup
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 550,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0D0D0C',
    title: 'Radium Launcher',
    icon: path.join(__dirname, '..', 'logo.png'),
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
  downloadAborted = true;
  if (downloadReq) try { downloadReq.destroy(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// IPC actions called from renderer script
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-close',    () => { downloadAborted = true; if (gameProcess) gameProcess.kill(); app.quit(); });

ipcMain.handle('get-config',  ()      => ensureConfig());
ipcMain.handle('save-config', (_e, c) => { saveConfig(c); return true; });
ipcMain.handle('ping-server', (_e, u) => pingServer(u));
ipcMain.handle('get-version', ()      => app.getVersion());

// Check if client is installed
ipcMain.handle('check-install', () => {
  const cfg = ensureConfig();
  const exePath = cfg.gameExePath || findBatIn(CLIENT_DIR, 'RecRoom_ScreenMode.bat') || '';
  const installed = exePath !== '' && fs.existsSync(exePath);
  return { installed, exePath, clientDir: CLIENT_DIR };
});

// Download + extract client
ipcMain.handle('download-client', async (event) => {
  downloadAborted = false;

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
    });

    if (downloadAborted) return { success: false, error: 'Cancelled' };

    // Phase 2: Extract
    progress({ phase: 'extract', pct: 100, status: 'Extracting...' });
    if (fs.existsSync(CLIENT_DIR)) {
      try { fs.rmSync(CLIENT_DIR, { recursive: true, force: true }); } catch {}
    }
    fs.mkdirSync(CLIENT_DIR, { recursive: true });

    await new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${CLIENT_ZIP}' -DestinationPath '${CLIENT_DIR}' -Force"`;
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
  try {
    if (fs.existsSync(CLIENT_DIR)) {
      fs.rmSync(CLIENT_DIR, { recursive: true, force: true });
    }
    const cfg = ensureConfig();
    cfg.gameExePath = '';
    saveConfig(cfg);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Cancel download
ipcMain.on('cancel-download', () => {
  downloadAborted = true;
  if (downloadReq) { try { downloadReq.destroy(); } catch {} downloadReq = null; }
});

// Launch game
ipcMain.handle('launch-game', async (_e, cfg) => {
  console.log('[launch-game] called, cfg:', JSON.stringify(cfg));

  // Check if RecRoom.exe is already running
  const isRunning = await new Promise((res) => {
    exec('tasklist /NH /FI "IMAGENAME eq RecRoom.exe"', (err, stdout) => {
      res(stdout && stdout.toLowerCase().includes('recroom.exe'));
    });
  });
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

  // Save resolved batPath to config
  const updatedCfg = ensureConfig();
  updatedCfg.gameExePath = path.join(CLIENT_DIR, 'RecRoom_ScreenMode.bat');
  saveConfig(updatedCfg);

  return new Promise((resolve) => {
    // exec runs the bat and waits for it to finish (bat exits immediately after `start`)
    const child = exec(`"${batPath}"`, { cwd: batDir }, (err) => {
      if (err) {
        console.error('[launch-game] exec error:', err.message);
        // Don't treat this as failure — the bat exits fast after `start`
      }
    });

    child.on('error', (err) => {
      console.error('[launch-game] child error:', err.message);
      resolve({ success: false, error: err.message });
    });

    // Give the bat a moment to fire off RecRoom.exe, then report success
    setTimeout(() => {
      console.log('[launch-game] bat launched, reporting success');
      gameProcess = { pid: child.pid };
      startGameMonitor();
      mainWindow?.webContents.send('game-state', { running: true });
      if (cfg.minimizeOnLaunch) mainWindow?.minimize();
      resolve({ success: true, pid: child.pid });
    }, 800);
  });
});

// Kill game
ipcMain.handle('kill-game', () => {
  exec('taskkill /F /IM RecRoom.exe', () => {});
  gameProcess = null;
  return true;
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
