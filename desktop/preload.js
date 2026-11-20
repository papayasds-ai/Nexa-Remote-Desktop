'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nexa', {
  canHost: process.platform === 'win32',   // input injection helper is Windows-only; other OSes are viewer-only
  input: cmd => ipcRenderer.send('nx-input', String(cmd)),
  focus: () => ipcRenderer.send('nx-focus'),
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
  fileOpen: o => ipcRenderer.sendSync('nx-file-open', o),
  fileChunk: (id, buf) => ipcRenderer.send('nx-file-chunk', String(id), new Uint8Array(buf)),
  fileClose: (id, ok) => ipcRenderer.invoke('nx-file-close', String(id), !!ok),
  nativeStage: o => ipcRenderer.invoke('nx-native-stage', o),
  nativeInstall: o => ipcRenderer.invoke('nx-native-install', o)
});
