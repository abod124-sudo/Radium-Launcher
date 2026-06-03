const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radium', {
  // Window
  minimize: ()       => ipcRenderer.send('win-minimize'),
  close:    ()       => ipcRenderer.send('win-close'),

  // Config
  getConfig:  ()     => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg)  => ipcRenderer.invoke('save-config', cfg),

  // Server
  pingServer: (url)  => ipcRenderer.invoke('ping-server', url),

  // Install check
  checkInstall: ()   => ipcRenderer.invoke('check-install'),

  // Download
  downloadClient: () => ipcRenderer.invoke('download-client'),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  uninstallClient: () => ipcRenderer.invoke('uninstall-client'),
  onDownloadProgress: (cb) => {
    ipcRenderer.on('download-progress', (_e, data) => cb(data));
  },

  // Game lifecycle
  launchGame: (cfg)  => ipcRenderer.invoke('launch-game', cfg),
  killGame:   ()     => ipcRenderer.invoke('kill-game'),
  onGameState:(cb)   => {
    ipcRenderer.on('game-state', (_e, data) => cb(data));
  },

  // Misc
  openUrl:    (url)  => ipcRenderer.send('open-url', url),
  getVersion: ()     => ipcRenderer.invoke('get-version'),

  // Auto-update
  checkForUpdate:  ()            => ipcRenderer.invoke('check-for-update'),
  downloadUpdate:  (downloadUrl) => ipcRenderer.invoke('download-update', downloadUrl),

  // Debug helpers (visible in DevTools console)
  debugExec:  (mode) => ipcRenderer.invoke('debug-exec', mode),
  debugPaths: ()     => ipcRenderer.invoke('debug-paths'),
});
