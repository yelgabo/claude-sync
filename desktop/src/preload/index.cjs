const { contextBridge, ipcRenderer } = require('electron');

const api = {
  status: () => ipcRenderer.invoke('app:status'),
  signup: (email, password) => ipcRenderer.invoke('auth:signup', { email, password }),
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  registerDevice: (name) => ipcRenderer.invoke('device:register', { name }),
  vaultInit: (passphrase) => ipcRenderer.invoke('vault:init', { passphrase }),
  vaultUnlock: (passphrase, remember) => ipcRenderer.invoke('vault:unlock', { passphrase, remember }),
  vaultLock: () => ipcRenderer.invoke('vault:lock'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  listFiles: () => ipcRenderer.invoke('files:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  onSyncState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('sync-state', listener);
    return () => ipcRenderer.removeListener('sync-state', listener);
  },
};

contextBridge.exposeInMainWorld('claudeSync', api);