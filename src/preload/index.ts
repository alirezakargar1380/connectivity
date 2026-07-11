import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getProxy: () => ipcRenderer.invoke("proxy"),
  getProxyServer: () => ipcRenderer.invoke("proxy-server"),
  getVpn: () => ipcRenderer.invoke("vpn"),
  getDns: () => ipcRenderer.invoke("dns"),
  sendDeleteDns: (interfaceName: string) => ipcRenderer.invoke("delete-dns", interfaceName),
  isConnected: () => ipcRenderer.invoke("is-connected"),
  checkInternet: () => ipcRenderer.invoke('check-internet'),
  startMonitoring: (interval: number) => ipcRenderer.invoke('start-monitoring', interval),
  stopMonitoring: () => ipcRenderer.invoke('stop-monitoring'),
  getConnectionInfo: () => ipcRenderer.invoke('get-connection-info'),
  onInternetStatus: (callback: (data: any) => void) => {
    ipcRenderer.on('internet-status', (event, data) => callback(data));
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
