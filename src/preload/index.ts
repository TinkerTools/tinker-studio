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
  /** Force-field .prm contents auto-located from a sibling .key (structure opens only). */
  prmText?: string
  prmName?: string
  /** Sibling Tinker .key file auto-located on open (name + contents). */
  keyName?: string
  keyText?: string
}

export interface AppSettings {
  tinkerDir?: string
}

export interface JobRunRequest {
  jobId: string
  program: string
  structurePath: string
  extraArgs?: string[]
  stdin?: string
}

export interface JobRunResult {
  ok: boolean
  commandLine?: string
  error?: string
}

export interface JobOutput {
  jobId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface JobExit {
  jobId: string
  code: number | null
  error?: string
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
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    chooseTinkerDir: (): Promise<AppSettings> => ipcRenderer.invoke('settings:chooseTinkerDir')
  },
  job: {
    run: (req: JobRunRequest): Promise<JobRunResult> => ipcRenderer.invoke('job:run', req),
    cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke('job:cancel', jobId),
    /** After a job finishes, fetch the coordinate file Tinker produced (or null). */
    collectResult: (
      structurePath: string,
      since: number
    ): Promise<{ name: string; path: string; text: string } | null> =>
      ipcRenderer.invoke('job:collectResult', { structurePath, since }),
    onOutput: (cb: (o: JobOutput) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, o: JobOutput): void => cb(o)
      ipcRenderer.on('job:output', listener)
      return () => ipcRenderer.removeListener('job:output', listener)
    },
    onExit: (cb: (e: JobExit) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, x: JobExit): void => cb(x)
      ipcRenderer.on('job:exit', listener)
      return () => ipcRenderer.removeListener('job:exit', listener)
    }
  },
  /** Enable/disable the File ▸ Save Structure As ▸ PDB menu item. */
  setPdbExportEnabled: (enabled: boolean): void =>
    ipcRenderer.send('menu:pdbExportEnabled', enabled),
  /** Save text (e.g. a .key file) to a user-chosen path; resolves to the path or null. */
  saveTextFile: (suggestedName: string, contents: string): Promise<string | null> =>
    ipcRenderer.invoke('file:saveText', { suggestedName, contents }),
  /** Open a text file (optionally restricted by extension filters); resolves to its path/name/contents, or null. */
  openTextFile: (
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<OpenedFile | null> => ipcRenderer.invoke('file:openText', filters)
}

export type FFEApi = typeof api

contextBridge.exposeInMainWorld('ffe', api)
