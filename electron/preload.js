const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radium', {
  // Window
  minimize: ()       => ipcRenderer.send('win-minimize'),
  close:    ()       => ipcRenderer.send('win-close'),
  maximize: ()       => ipcRenderer.send('win-maximize'),

  // Config
  getConfig:  ()     => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg)  => ipcRenderer.invoke('save-config', cfg),

  // Server
  pingServer: (url)  => ipcRenderer.invoke('ping-server', url),
  getPlayerCount: () => ipcRenderer.invoke('get-player-count'),
  addDefenderExclusion: () => ipcRenderer.invoke('add-defender-exclusion'),
  removeDefenderExclusion: () => ipcRenderer.invoke('remove-defender-exclusion'),

  // Install check
  checkInstall: ()   => ipcRenderer.invoke('check-install'),

  // Download
  downloadClient: () => ipcRenderer.invoke('download-client'),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  uninstallClient: () => ipcRenderer.invoke('uninstall-client'),
  openClientFolder: () => ipcRenderer.invoke('open-client-folder'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getDefaultClientDir: () => ipcRenderer.invoke('get-default-client-dir'),
  onDownloadProgress: (cb) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (_e, data) => cb(data));
  },

  // Game lifecycle
  launchGame: (cfg)  => ipcRenderer.invoke('launch-game', cfg),
  killGame:   ()     => ipcRenderer.invoke('kill-game'),
  onGameState:(cb)   => {
    ipcRenderer.removeAllListeners('game-state');
    ipcRenderer.on('game-state', (_e, data) => cb(data));
  },

  // Misc
  openUrl:    (url)  => ipcRenderer.send('open-url', url),
  getVersion: ()     => ipcRenderer.invoke('get-version'),
  checkSteam: ()     => ipcRenderer.invoke('check-steam'),
  checkSmartAppControl: () => ipcRenderer.invoke('check-smart-app-control'),

  // Auto-update
  checkForUpdate:  ()            => ipcRenderer.invoke('check-for-update'),
  downloadUpdate:  (downloadUrl) => ipcRenderer.invoke('download-update', downloadUrl),

  // Data Fetching
  fetchRooms: (args) => ipcRenderer.invoke('fetch-rooms', args),
  fetchPeople: (args) => ipcRenderer.invoke('fetch-people', args),
  fetchFilters: () => ipcRenderer.invoke('fetch-filters'),
  fetchRoomWebDetails: (name) => ipcRenderer.invoke('fetch-room-web-details', name),
  fetchUserWebDetails: (name) => ipcRenderer.invoke('fetch-user-web-details', name),
  fetchUserPhotos: (args) => ipcRenderer.invoke('fetch-user-photos', args),
  fetchRecentPhotos: (args) => ipcRenderer.invoke('fetch-recent-photos', args),
  fetchPhotoWebDetails: (photoId) => ipcRenderer.invoke('fetch-photo-web-details', photoId),
  fetchPhotoComments: (photoId) => ipcRenderer.invoke('fetch-photo-comments', photoId),
  onLogUrl: (cb) => {
    ipcRenderer.removeAllListeners('log-url');
    ipcRenderer.on('log-url', (_e, url) => cb(url));
  },
  onWindowMaximizedState: (cb) => {
    ipcRenderer.removeAllListeners('window-maximized-state');
    ipcRenderer.on('window-maximized-state', (_e, state) => cb(state));
  },

  // Debug helpers (visible in DevTools console)
  debugExec:  (mode) => ipcRenderer.invoke('debug-exec', mode),
  debugPaths: ()     => ipcRenderer.invoke('debug-paths'),
});
