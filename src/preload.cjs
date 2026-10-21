const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(`launcher:${name}`, ...args);
contextBridge.exposeInMainWorld('launcher', {
  settings: invoke('settings'),
  saveFeed: invoke('saveFeed'),
  resetFeed: invoke('resetFeed'),
  saveAccessKey: invoke('saveAccessKey'),
  clearAccessKey: invoke('clearAccessKey'),
  chooseFolder: invoke('chooseFolder'),
  openFolder: invoke('openFolder'),
  check: invoke('check'),
  update: invoke('update'),
  repair: invoke('repair'),
  play: invoke('play'),
  gameOptions: invoke('gameOptions'),
  saveGameOptions: invoke('saveGameOptions'),
  resetGameOptions: invoke('resetGameOptions'),
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('launcher:state', listener);
    return () => ipcRenderer.removeListener('launcher:state', listener);
  },
});
