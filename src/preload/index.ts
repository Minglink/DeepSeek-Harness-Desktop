import { contextBridge, ipcRenderer } from 'electron'
import type { DshPluginInstallPayload } from '../main/protocol.ts'

export interface DshDesktopAPI {
  getPendingPayload: () => Promise<DshPluginInstallPayload>
  onPluginInstallRequest: (callback: (payload: DshPluginInstallPayload) => void) => () => void
  confirmInstall: (payload: DshPluginInstallPayload) => Promise<{ success: boolean; message: string }>
  cancelInstall: (id: string) => void
  onInstallProgress: (callback: (progress: { status: string; message: string; percent?: number }) => void) => () => void
  closeDialog: () => void
}

const api: DshDesktopAPI = {
  getPendingPayload: () => ipcRenderer.invoke('plugin:get-pending-payload'),
  onPluginInstallRequest: (callback) => {
    const handler = (_event: any, payload: DshPluginInstallPayload) => callback(payload)
    ipcRenderer.on('plugin:install-request', handler)
    return () => ipcRenderer.removeListener('plugin:install-request', handler)
  },
  confirmInstall: (payload) => {
    return ipcRenderer.invoke('plugin:confirm-install', payload)
  },
  cancelInstall: (id) => {
    ipcRenderer.send('plugin:cancel-install', id)
  },
  onInstallProgress: (callback) => {
    const handler = (_event: any, progress: any) => callback(progress)
    ipcRenderer.on('plugin:install-progress', handler)
    return () => ipcRenderer.removeListener('plugin:install-progress', handler)
  },
  closeDialog: () => {
    ipcRenderer.send('dialog:close')
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
