import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * Preload script — the only bridge between the privileged main process and the
 * sandboxed renderer. Everything the UI is allowed to ask the OS to do is
 * exposed here as a small, explicit, typed API surface (and nothing else).
 */

export interface OpenedFile {
  path: string
  name: string
  text: string
}

const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  /** True only under the headless screenshot harness (FFE_CAPTURE set). */
  captureMode: Boolean(process.env['FFE_CAPTURE']),
  /** Prompt the user for a Tinker file; resolves to its contents, or null if cancelled. */
  openStructure: (): Promise<OpenedFile | null> => ipcRenderer.invoke('structure:open'),
  /** Download a structure from an online database (pubchem | nci | pdb). */
  download: (
    source: string,
    query: string
  ): Promise<{ text: string; format: 'sdf' | 'pdb'; name: string }> =>
    ipcRenderer.invoke('structure:download', source, query),
  /** Subscribe to native-menu actions (open / loadExample / close). Returns an unsubscribe fn. */
  onMenu: (callback: (action: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, action: string): void => callback(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  }
}

export type FFEApi = typeof api

contextBridge.exposeInMainWorld('ffe', api)
