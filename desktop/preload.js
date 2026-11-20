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
  nativeInstall: o => ipcRenderer.invoke('nx-native-install', o)
});
