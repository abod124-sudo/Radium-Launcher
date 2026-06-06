const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const { spawn, exec, execFile } = require('child_process');
const os     = require('os');
const extract = require('extract-zip');

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
const CLIENT_ZIP  = path.join(USER_DATA, 'client.zip');

const DOWNLOAD_URL = 'https://cdn.recroomarchive.org/radium/game-client/production/toukeh24kq6w2v4lndyc4z0pblvfyj75/windows/client.zip';

const DEFAULT_CONFIG = {
  apiUrl:           'https://api.radie.app/',
  gameExePath:      '',          // auto-set after install
  playMode:         'screen',    // 'screen' | 'vr'
  minimizeOnLaunch: true,
  autoUpdate:       true,
  installDir:       '',          // Custom install dir (empty = default)
};

function getClientDir(cfg) {
  const c = cfg || ensureConfig();
  return c.installDir || path.join(USER_DATA, 'client');
}

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
  } catch {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch {}
    return { ...DEFAULT_CONFIG };
  }
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

// Helper to log HTTP Requests to renderer process
function logUrlToRenderer(url) {
  console.log(`[HTTP Request] ${url}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-url', url);
  }
}

// Helper to download files (handles HTTP redirects and tracks download speed/ETA)
const clientDownloadState = { req: null, aborted: false };
const updateDownloadState = { req: null, aborted: false };

function doDownload(url, destPath, onProgress, cancelState) {
  logUrlToRenderer(url);
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
        const pct     = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : -1;
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
let isGameRunningState = false;
let launchGraceTicks = 0;
let mainWindow  = null;
let gameMonitorInterval = null;

function startGameMonitor() {
  if (gameMonitorInterval) return;
  gameMonitorInterval = setInterval(async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const running = await checkGameRunning();
      
      if (launchGraceTicks > 0) {
        launchGraceTicks--;
        if (running) {
          launchGraceTicks = 0;
          if (!isGameRunningState) {
            isGameRunningState = true;
            mainWindow?.webContents.send('game-state', { running: true });
          }
        }
        return;
      }
      
      if (running !== isGameRunningState) {
        isGameRunningState = running;
        mainWindow?.webContents.send('game-state', { running });
      }
    } catch {}
  }, 2000);
}

function stopGameMonitor() {
  if (gameMonitorInterval) {
    clearInterval(gameMonitorInterval);
    gameMonitorInterval = null;
  }
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
    logUrlToRenderer('https://api.radie.app/api/players/v1/online');
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

// Add Windows Defender exclusion for client folder
function addDefenderExclusion() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, error: 'Only supported on Windows.' });
  }
  return new Promise((resolve) => {
    const clientDir = getClientDir();
    const escapedPath = clientDir.replace(/'/g, "''").replace(/\$/g, '`$');
    const psPath = getPowershellPath();
    const psCommand = `Start-Process '${psPath}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command "Add-MpPreference -ExclusionPath ''${escapedPath}''"' -Verb RunAs`;
    
    execFile(psPath, ['-NoProfile', '-Command', psCommand], (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

// Remove Windows Defender exclusion for client folder
function removeDefenderExclusion() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, error: 'Only supported on Windows.' });
  }
  return new Promise((resolve) => {
    const clientDir = getClientDir();
    const escapedPath = clientDir.replace(/'/g, "''").replace(/\$/g, '`$');
    const psPath = getPowershellPath();
    const psCommand = `Start-Process '${psPath}' -ArgumentList '-NoProfile -WindowStyle Hidden -Command "Remove-MpPreference -ExclusionPath ''${escapedPath}''"' -Verb RunAs`;
    
    execFile(psPath, ['-NoProfile', '-Command', psCommand], (err) => {
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
    width: 1000, height: 650,
    minWidth: 900, minHeight: 550,
    resizable: true,
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
      webviewTag:       true,
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized-state', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized-state', false);
  });
}

app.whenReady().then(() => {
  createWindow();
  startGameMonitor();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  stopGameMonitor();
  clientDownloadState.aborted = true;
  if (clientDownloadState.req) try { clientDownloadState.req.destroy(); } catch {}
  updateDownloadState.aborted = true;
  if (updateDownloadState.req) try { updateDownloadState.req.destroy(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

// IPC actions called from renderer script
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});
ipcMain.on('win-close', () => {
  stopGameMonitor();
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
ipcMain.handle('check-smart-app-control', () => {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ enabled: false, state: -1 });
    exec('reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy /v VerifiedAndReputablePolicyState', (err, stdout) => {
      if (err) return resolve({ enabled: false, error: err.message });
      const match = stdout.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+(0x[0-9a-fA-F]+|[0-9]+)/);
      if (match) {
        const val = parseInt(match[1]);
        resolve({ enabled: val === 1 || val === 2, state: val });
      } else {
        resolve({ enabled: false, state: -1 });
      }
    });
  });
});

function httpsGetText(urlStr) {
  logUrlToRenderer(urlStr);
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Radium-Launcher',
        'Accept': 'text/html,application/xhtml+xml,application/json'
      },
      timeout: 10000
    };
    const req = https.get(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const resolvedUrl = new URL(res.headers.location, urlStr).toString();
        return httpsGetText(resolvedUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${parsed.hostname}`));
      }
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function httpsGetJson(urlStr) {
  const text = await httpsGetText(urlStr);
  return JSON.parse(text);
}

function unescapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function resolveUrl(urlStr, baseUrl = 'https://www.radie.app') {
  if (!urlStr) return '';
  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
    return urlStr;
  }
  if (urlStr.startsWith('//')) {
    return 'https:' + urlStr;
  }
  try {
    return new URL(urlStr, baseUrl).toString();
  } catch (e) {
    return urlStr;
  }
}

ipcMain.handle('fetch-room-web-details', async (_event, name) => {
  const url = `https://www.radie.app/room/${encodeURIComponent(name)}`;
  try {
    const html = await httpsGetText(url);
    const cheersMatch = html.match(/<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)<\/p>\s*<p class="text-\[10px\]">CHEERS<\/p>/i);
    const favsMatch = html.match(/<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)<\/p>\s*<p class="text-\[10px\]">FAVORITES<\/p>/i);
    const visitsMatch = html.match(/<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)<\/p>\s*<p class="text-\[10px\]">VISITS<\/p>/i);
    const descMatch = html.match(/<\/a>\s*<p>([\s\S]*?)<\/p>\s*<div class="flex border-\[#ccc\] border-t/i);
    const creatorAvatarMatch = html.match(/href="\/user\/[^"]+"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/i);
    
    return {
      success: true,
      cheers: cheersMatch ? cheersMatch[1] : '0',
      favorites: favsMatch ? favsMatch[1] : '0',
      visits: visitsMatch ? visitsMatch[1] : '0',
      description: descMatch ? unescapeHtml(descMatch[1].trim()) : '',
      creatorAvatar: creatorAvatarMatch ? resolveUrl(unescapeHtml(creatorAvatarMatch[1])) : ''
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-user-web-details', async (_event, name) => {
  const url = `https://www.radie.app/user/${encodeURIComponent(name)}`;
  try {
    const html = await httpsGetText(url);
    const friendsMatch = html.match(/<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)<\/p>\s*<p class="text-\[10px\]">FRIENDS<\/p>/i);
    const subsMatch = html.match(/<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)<\/p>\s*<p class="text-\[10px\]">SUBSCRIBERS<\/p>/i);
    const visitsMatch = html.match(/<p class="font-bold text-\[14px\]!"[^>]*>([\d,]+)<\/p>\s*<p class="text-\[10px\]">VISITS<\/p>/i);
    const statusMatch = html.match(/\[(ONLINE|OFFLINE)\]/i);
    const bioMatch = html.match(/<p class="whitespace-pre-wrap text-\[12px\]">([\s\S]*?)<\/p>/i);
    const bannerMatch = html.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
    const avatarMatch = html.match(/w-18\.75[\s\S]*?<img[^>]*src="([^"]+)"/i);
    
    return {
      success: true,
      friends: friendsMatch ? friendsMatch[1] : '0',
      subscribers: subsMatch ? subsMatch[1] : '0',
      visits: visitsMatch ? visitsMatch[1] : '0',
      status: statusMatch ? statusMatch[1].toUpperCase() : 'OFFLINE',
      bio: bioMatch ? unescapeHtml(bioMatch[1].trim()) : '',
      banner: bannerMatch ? resolveUrl(unescapeHtml(bannerMatch[1])) : '',
      avatar: avatarMatch ? resolveUrl(unescapeHtml(avatarMatch[1])) : ''
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-user-photos', async (_event, args) => {
  let userId = '';
  let skip = 0;
  let take = 40;
  if (typeof args === 'string') {
    userId = args;
  } else if (args && typeof args === 'object') {
    userId = args.userId || '';
    skip = args.skip || 0;
    take = args.take || 40;
  }
  const url = `https://launcher.radie.app/api/user/v1/${encodeURIComponent(userId)}/photos?skip=${skip}&take=${take}`;
  try {
    const data = await httpsGetJson(url);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-recent-photos', async (_event, args) => {
  let skip = 0;
  let take = 100;
  if (args && typeof args === 'object') {
    skip = args.skip || 0;
    take = args.take || 100;
  }
  const url = `https://launcher.radie.app/api/photos/v1/feed?skip=${skip}&take=${take}`;
  try {
    const data = await httpsGetJson(url);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-photo-web-details', async (_event, photoId) => {
  const url = `https://www.radie.app/photo/${encodeURIComponent(photoId)}`;
  try {
    const html = await httpsGetText(url);
    const userMatch = html.match(/href="\/user\/([^"\s?]+)"/i);
    const roomMatch = html.match(/href="\/room\/([^"\s?]+)"/i);
    
    return {
      success: true,
      creatorUsername: userMatch ? userMatch[1] : '',
      roomName: roomMatch ? roomMatch[1] : ''
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-photo-comments', async (_event, photoId) => {
  // Try the most likely API patterns for comments
  const urlsToTry = [
    `https://launcher.radie.app/api/photos/v1/${encodeURIComponent(photoId)}/comments?skip=0&take=20`,
    `https://launcher.radie.app/api/comments/v1?photoId=${encodeURIComponent(photoId)}&skip=0&take=20`,
    `https://api.radie.app/api/photos/v1/${encodeURIComponent(photoId)}/comments?skip=0&take=20`,
  ];
  for (const url of urlsToTry) {
    try {
      const data = await httpsGetJson(url);
      // Accepts both array result and {Results:[...]} shape
      const comments = Array.isArray(data) ? data : (data.Results || data.comments || []);
      return { success: true, comments };
    } catch (err) {
      if (err.message && err.message.includes('404')) continue;
      return { success: false, error: err.message, comments: [] };
    }
  }
  return { success: false, error: 'Comments not available', comments: [] };
});



ipcMain.handle('fetch-rooms', async (_event, args) => {
  const { skip = 0, take = 20, sortBy = 0, query = '', tag = '' } = args || {};
  let url = `https://launcher.radie.app/api/rooms/v1/?skip=${skip}&take=${take}&sortBy=${sortBy}`;
  if (query) url += `&query=${encodeURIComponent(query)}`;
  if (tag) url += `&tag=${encodeURIComponent(tag)}`;
  try {
    const data = await httpsGetJson(url);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-people', async (_event, args) => {
  const { skip = 0, take = 15, query = '' } = args || {};
  let url = `https://launcher.radie.app/api/user/v1?skip=${skip}&take=${take}`;
  if (query) url += `&query=${encodeURIComponent(query)}`;
  try {
    const data = await httpsGetJson(url);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fetch-filters', async () => {
  const url = 'https://api.radie.app/api/rooms/v1/filters';
  try {
    const data = await httpsGetJson(url);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Check if client is installed
ipcMain.handle('check-install', async () => {
  const cfg = ensureConfig();
  const clientDir = getClientDir(cfg);
  let exePath = cfg.gameExePath || '';
  if (exePath) {
    const relative = path.relative(clientDir, exePath);
    const isInside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!isInside || !fs.existsSync(exePath)) {
      exePath = '';
    }
  }
  if (!exePath) {
    exePath = findBatIn(clientDir, 'RecRoom_ScreenMode.bat') || '';
  }
  const installed = exePath !== '' && fs.existsSync(exePath);
  const isRunning = isGameRunningState;
  return { installed, exePath, clientDir, isRunning };
});

// Download + extract client
ipcMain.handle('download-client', async (event) => {
  const isRunning = await checkGameRunning();
  if (isRunning) return { success: false, error: 'Cannot download or install while the game is running.' };

  clientDownloadState.aborted = false;
  clientDownloadState.req = null;

  const clientDir = getClientDir();

  // Ensure dirs exist
  if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
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
    progress({ phase: 'extract', pct: 0, status: 'Preparing extraction...' });
    if (fs.existsSync(clientDir)) {
      try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch {}
    }
    fs.mkdirSync(clientDir, { recursive: true });

    let extractedCount = 0;
    let lastPercent = -1;
    let lastProgressTime = 0;

    await extract(CLIENT_ZIP, {
      dir: clientDir,
      onEntry: (entry, zipfile) => {
        extractedCount++;
        const pct = Math.round((extractedCount / zipfile.entryCount) * 100);
        const now = Date.now();
        if (pct !== lastPercent || now - lastProgressTime > 150) {
          lastPercent = pct;
          lastProgressTime = now;
          progress({ phase: 'extract', pct, status: `Extracting: ${entry.fileName} (${extractedCount}/${zipfile.entryCount})` });
        }
      }
    });

    // Cleanup zip
    try { fs.unlinkSync(CLIENT_ZIP); } catch {}

    // Find bat
    const batPath = findBatIn(clientDir, 'RecRoom_ScreenMode.bat') || '';

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
    try { if (fs.existsSync(clientDir)) fs.rmSync(clientDir, { recursive: true, force: true }); } catch {}
    return { success: false, error: err.message };
  }
});

// Uninstall client (removes files & resets config path)
ipcMain.handle('uninstall-client', async () => {
  const isRunning = await checkGameRunning();
  if (isRunning) return { success: false, error: 'Cannot uninstall while the game is running.' };

  try {
    const clientDir = getClientDir();
    if (fs.existsSync(clientDir)) {
      fs.rmSync(clientDir, { recursive: true, force: true });
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

  const clientDir = getClientDir(cfg);

  // Build the direct bat path from clientDir
  const directBatPath = path.join(clientDir, batName);
  let batPath = '';

  if (fs.existsSync(directBatPath)) {
    batPath = directBatPath;
    console.log('[launch-game] found bat directly in clientDir:', batPath);
  } else if (cfg.gameExePath && fs.existsSync(path.join(path.dirname(cfg.gameExePath), batName))) {
    batPath = path.join(path.dirname(cfg.gameExePath), batName);
    console.log('[launch-game] found bat via gameExePath sibling:', batPath);
  } else {
    batPath = findBatIn(clientDir, batName) || '';
    console.log('[launch-game] findBatIn result:', batPath);
  }

  if (!batPath) {
    const msg = `Launch file not found: ${batName}\nLooked in: ${clientDir}\n\nPlease download the client first.`;
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

  console.log('[launch-game] launching natively: hasExe =', hasExe);

  return new Promise((resolve) => {
    let child;
    try {
      if (hasExe) {
        child = spawn('cmd.exe', ['/c', 'start', '""', exePath, playModeArg], {
          cwd: batDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
      } else {
        child = spawn('cmd.exe', ['/c', 'start', '""', batPath], {
          cwd: batDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
      }
    } catch (spawnErr) {
      console.error('[launch-game] Spawn error:', spawnErr);
      resolve({ success: false, error: spawnErr.message });
      return;
    }

    if (!child || !child.pid) {
      console.error('[launch-game] Spawned child has invalid PID:', child);
      resolve({ success: false, error: 'Failed to start game process.' });
      return;
    }

    child.unref();

    console.log('[launch-game] launched successfully, PID:', child.pid);
    gameProcess = { pid: child.pid };
    launchGraceTicks = 8;
    isGameRunningState = true;
    mainWindow?.webContents.send('game-state', { running: true });
    if (cfg.minimizeOnLaunch) mainWindow?.minimize();
    resolve({ success: true, pid: child.pid });
  });
});

// Kill game
ipcMain.handle('kill-game', () => {
  exec('taskkill /F /IM RecRoom.exe', () => {});
  gameProcess = null;
  isGameRunningState = false;
  return true;
});

// Open client folder
ipcMain.handle('open-client-folder', () => {
  const clientDir = getClientDir();
  if (fs.existsSync(clientDir)) {
    shell.openPath(clientDir);
    return true;
  }
  return false;
});

// Debug: directly exec a bat file — call from DevTools: window.radium.debugExec('screen')
ipcMain.handle('debug-exec', (_e, mode) => {
  const batName = mode === 'vr' ? 'RecRoom_VR.bat' : 'RecRoom_ScreenMode.bat';
  const clientDir = getClientDir();
  const batPath = path.join(clientDir, batName);
  const exists = fs.existsSync(batPath);
  console.log('[debug-exec] batPath:', batPath, '  exists:', exists);
  console.log('[debug-exec] clientDir:', clientDir);
  if (!exists) return { ok: false, msg: `Not found: ${batPath}` };
  return new Promise((resolve) => {
    exec(`"${batPath}"`, { cwd: clientDir }, (err, stdout, stderr) => {
      console.log('[debug-exec] done. err:', err?.message, 'stdout:', stdout, 'stderr:', stderr);
      resolve({ ok: !err, err: err?.message, stdout, stderr });
    });
  });
});

// Debug: check all paths
ipcMain.handle('debug-paths', () => {
  const clientDir = getClientDir();
  const screenBat = path.join(clientDir, 'RecRoom_ScreenMode.bat');
  const vrBat     = path.join(clientDir, 'RecRoom_VR.bat');
  const exe       = path.join(clientDir, 'RecRoom.exe');
  return {
    CLIENT_DIR: clientDir,
    USER_DATA,
    screenBat,  screenBatExists: fs.existsSync(screenBat),
    vrBat,      vrBatExists:     fs.existsSync(vrBat),
    exe,        exeExists:       fs.existsSync(exe),
  };
});

// Select install folder dialog
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Radium Client Install Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

// Get default client directory
ipcMain.handle('get-default-client-dir', () => {
  return path.join(app.getPath('userData'), 'client');
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
  logUrlToRenderer(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
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
