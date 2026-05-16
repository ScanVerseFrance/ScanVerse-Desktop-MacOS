/**
 * Preload for the update modal (src/update-ui/index.html).
 *
 * Exposes a small `window.updater` object so the renderer can talk to
 * the main process without nodeIntegration. Single-purpose so we don't
 * leak the full app preload (`window.scanverse`) into a UI window that
 * has no need for Discord RPC or scan stuff.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  // Push from main → renderer
  onInfo: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('update:info', handler);
    return () => ipcRenderer.off('update:info', handler);
  },
  onProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.off('update:progress', handler);
  },

  // Pull from renderer → main
  getInfo:  () => ipcRenderer.invoke('update:get-info'),
  download: () => ipcRenderer.invoke('update:download'),
  apply:    () => ipcRenderer.send('update:apply'),
  close:    () => ipcRenderer.send('update:close'),
  openInBrowser: () => ipcRenderer.send('update:open-release'),
});
