const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(`launcher:${name}`, ...args);
contextBridge.exposeInMainWorld('launcher', {
  settings: invoke('settings'),
  saveFeed: invoke('saveFeed'),
  chooseFolder: invoke('chooseFolder'),
  check: invoke('check'),
  update: invoke('update'),
  play: invoke('play'),
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('launcher:state', listener);
    return () => ipcRenderer.removeListener('launcher:state', listener);
  },
});
