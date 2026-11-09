'use strict'
/*
 * Context-isolated bridge between the renderer and `controller.cjs`.
 * The renderer never sees Node or Electron APIs, only these calls.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rokuDesktop', {
  isElectron: true,
  getState: () => ipcRenderer.invoke('state:snapshot'),
  revealToken: () => ipcRenderer.invoke('config:reveal-token'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  refreshDevices: () => ipcRenderer.invoke('devices:refresh'),
  startAnc: () => ipcRenderer.invoke('anc:start'),
  stopAnc: () => ipcRenderer.invoke('anc:stop'),
  runSelfTest: () => ipcRenderer.invoke('anc:selftest'),
  startBridge: () => ipcRenderer.invoke('bridge:start'),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  scanRokuDevices: () => ipcRenderer.invoke('roku:scan'),
  pingServer: (options) => ipcRenderer.invoke('ping:run', options || {}),
  recentLogs: () => ipcRenderer.invoke('logs:recent'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state:update', listener)
    return () => ipcRenderer.removeListener('state:update', listener)
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry)
    ipcRenderer.on('log:line', listener)
    return () => ipcRenderer.removeListener('log:line', listener)
  },
})
