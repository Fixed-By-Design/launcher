const { contextBridge, ipcRenderer } = require('electron')
const invoke = name => (...args) => ipcRenderer.invoke('ui-test:action', name, args)
contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('ui-test:state'),
  discordLogin: invoke('discordLogin'),
  openDiscordLogin: invoke('openDiscordLogin'),
  cancelOperation: invoke('cancelOperation'),
  logout: invoke('logout'),
  refresh: invoke('refresh'),
  microsoftLogin: invoke('microsoftLogin'),
  microsoftLogout: invoke('microsoftLogout'),
  openMicrosoftLogin: invoke('openMicrosoftLogin'),
  copyDeviceCode: invoke('copyDeviceCode'),
  install: invoke('install'),
  play: invoke('play'),
  setMemory: invoke('setMemory'),
  openFolder: invoke('openFolder'),
  openLogs: invoke('openLogs'),
  openReleaseNotes: invoke('openReleaseNotes'),
  applyUpdate: invoke('applyUpdate'),
  checkUpdate: invoke('checkUpdate'),
  onState: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('ui-test:state', listener)
    return () => ipcRenderer.removeListener('ui-test:state', listener)
  },
})
