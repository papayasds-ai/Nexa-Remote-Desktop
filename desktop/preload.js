'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nexa', {
  canHost: process.platform === 'win32',   // input injection helper is Windows-only; other OSes are viewer-only
  input: cmd => ipcRenderer.send('nx-input', String(cmd)),
  focus: () => ipcRenderer.send('nx-focus'),
  otaInstall: o => ipcRenderer.invoke('nx-ota-install', o),
  otaApply: () => ipcRenderer.send('nx-ota-apply'),
  onDownload: f => ipcRenderer.on('nx-dl-progress', (_e, p) => f(p)),
  secret: {
    available: process.platform === 'win32',
    get: () => ipcRenderer.invoke('nx-secret-get'),
    set: v => ipcRenderer.invoke('nx-secret-set', v)
  },
  power: o => ipcRenderer.invoke('nx-power', o),
  nativeVersion: () => ipcRenderer.invoke('nx-native-version'),
  nativeInstall: o => ipcRenderer.invoke('nx-native-install', o),
  // saved-PC passwords: encrypted with the Windows account key (DPAPI), only readable by this app window
  vault: { get: () => ipcRenderer.invoke('nx-vault-get'), set: v => ipcRenderer.invoke('nx-vault-set', v) },
  // run as administrator (so mouse/keyboard also reach Task Manager, installers, other admin windows)
  admin: o => ipcRenderer.invoke('nx-admin', o || {}),
  // file transfer to this PC (saved in Downloads\NexaDesk Received)
  fileOpen: o => ipcRenderer.invoke('nx-file-open', o),
  fileWrite: (id, bytes) => ipcRenderer.invoke('nx-file-write', id, bytes),
  fileClose: (id, ok) => ipcRenderer.invoke('nx-file-close', id, ok)
});
