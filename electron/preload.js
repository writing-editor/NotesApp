// electron/preload.js
//
// Runs in an isolated world with access to a trimmed-down subset of Node/
// Electron APIs, exposed to the renderer (the exact same client.js/index.html
// from AppCode/public — unmodified) via contextBridge. The web UI doesn't
// currently call any of this, but it's here so a future "Open Vault Folder"
// button inside the app itself can trigger the native dialog instead of only
// being reachable from the menu bar.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('manuscriptDesktop', {
  isElectron: true,
  openVaultDialog: () => ipcRenderer.invoke('open-vault-dialog'),
  notifyVaultChanged: (vaultPath) => ipcRenderer.invoke('notify-vault-changed', vaultPath),
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winMaximizeToggle: () => ipcRenderer.invoke('win-maximize-toggle'),
  winClose: () => ipcRenderer.invoke('win-close'),
});