'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('psnApi', {
  start: (config) => ipcRenderer.invoke('psn:start', config),
  stop: () => ipcRenderer.invoke('psn:stop'),
  updateConfig: (config) => ipcRenderer.invoke('psn:updateConfig', config),
  getConfig: () => ipcRenderer.invoke('psn:getConfig'),
  listInterfaces: () => ipcRenderer.invoke('psn:listInterfaces'),
  onTrackers: (cb) => ipcRenderer.on('psn:trackers', (_evt, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('psn:status', (_evt, msg) => cb(msg)),
  onError: (cb) => ipcRenderer.on('psn:error', (_evt, msg) => cb(msg)),
});
