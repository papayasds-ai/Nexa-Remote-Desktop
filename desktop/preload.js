'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nexa', {
  canHost: process.platform === 'win32',   // input injection helper is Windows-only; other OSes are viewer-only
  input: cmd => ipcRenderer.send('nx-input', String(cmd)),
  hostSession: (peerId, controlAllowed) => ipcRenderer.send('nx-host-session', peerId, !!controlAllowed),
  manageAdmins: () => ipcRenderer.invoke('nx-manage-admins'),
  focus: () => ipcRenderer.send('nx-focus'),
  clipRead: () => ipcRenderer.invoke('nx-clip-read'),   // clipboard text, readable while the window is in the background (auto clipboard sync)
  warm: () => ipcRenderer.send('nx-warm'),
  otaInstall: o => ipcRenderer.invoke('nx-ota-install', o),
  onProgress: f => ipcRenderer.on('nx-progress', (_e, o) => f(o)),
  otaApply: () => ipcRenderer.send('nx-ota-apply'),
  secret: {
    available: process.platform === 'win32',
    get: () => ipcRenderer.invoke('nx-secret-get'),
    set: v => ipcRenderer.invoke('nx-secret-set', v)
  },
  power: o => ipcRenderer.invoke('nx-power', o),
  nativeVersion: () => ipcRenderer.invoke('nx-native-version'),
  nativeStage: o => ipcRenderer.invoke('nx-native-stage', o),
  nativeInstall: o => ipcRenderer.invoke('nx-native-install', o)
});
