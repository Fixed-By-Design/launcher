import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherApi, LauncherState } from '../shared/contracts.js'
const api: LauncherApi = {
  state: () => ipcRenderer.invoke('launcher:state'),
  discordLogin: () => ipcRenderer.invoke('launcher:discord-login'),
  openDiscordLogin: () => ipcRenderer.invoke('launcher:discord-open'),
  cancelOperation: () => ipcRenderer.invoke('launcher:cancel-operation'),
  logout: () => ipcRenderer.invoke('launcher:logout'),
  refresh: () => ipcRenderer.invoke('launcher:refresh'),
  microsoftLogin: () => ipcRenderer.invoke('launcher:microsoft-login'),
  microsoftLogout: () => ipcRenderer.invoke('launcher:microsoft-logout'),
  openMicrosoftLogin: () => ipcRenderer.invoke('launcher:microsoft-open'),
  copyDeviceCode: () => ipcRenderer.invoke('launcher:device-copy'),
  install: () => ipcRenderer.invoke('launcher:install'),
  play: () => ipcRenderer.invoke('launcher:play'),
  setMemory: value => ipcRenderer.invoke('launcher:memory', value),
  openFolder: () => ipcRenderer.invoke('launcher:folder'),
  openLogs: () => ipcRenderer.invoke('launcher:logs'),
  openReleaseNotes: () => ipcRenderer.invoke('launcher:release-notes'),
  applyUpdate: () => ipcRenderer.invoke('launcher:update'),
  checkUpdate: () => ipcRenderer.invoke('launcher:check-update'),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: LauncherState) => callback(state)
    ipcRenderer.on('launcher:state', listener)
    return () => ipcRenderer.removeListener('launcher:state', listener)
  },
}
contextBridge.exposeInMainWorld('launcher', api)
