import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ClusterProfile,
  ClusterKind,
  RemoteJobRecord,
  RemoteJobState,
  RemoteSubmitRequest
} from '../main/remote/types'

/**
 * An action the detached Jobs window forwards back to the main window (which owns
 * local job state and the 3D viewer): remove a finished local job, or load a
 * remote job's live/result structure into the viewer.
 */
export type JobsAction =
  | { type: 'clear'; id: string }
  | { type: 'viewLive'; job: RemoteJobRecord }
  | { type: 'openResult'; job: RemoteJobRecord }

/**
 * Context the main window publishes to the detached Modeling Commands window. Just
 * the fields that window reads: a lightweight active-system summary (its full
 * MolecularSystem model lives in the renderer and can't be imported here), the
 * Tinker directory, and the configured clusters.
 */
export interface CommandsContext {
  system: { name: string; fileType: string; hasKey: boolean } | null
  tinkerDir?: string
  clusters: ClusterProfile[]
}

/** A local run forwarded from the Commands window to the main window. */
export interface CommandsRunReq {
  program: string
  stdin: string
  watch: boolean
  requiresStructure: boolean
  loadResult?: 'xyz' | 'pdb'
}

/** A remote submit forwarded from the Commands window, correlated by `reqId`. */
export interface CommandsSubmitMsg {
  reqId: number
  /** SubmitRemote options (typed in the renderer); passed through opaquely here. */
  opts: unknown
}

// Re-export the remote data model so the renderer can type the config UI through
// the single window.tinker surface (env.d.ts already imports TinkerApi from here).
export type { ClusterProfile, ClusterKind, RemoteJobRecord, RemoteJobState, RemoteSubmitRequest }

/** Result of opening a remote trajectory for streamed playback. */
export interface RemoteTrajectoryOpened {
  trajId: string
  frameCount: number
  natoms: number
  kind: 'arc' | 'dcd'
  firstFrameText?: string
}

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
  /** Sibling Tinker .seq file auto-located on open (name + contents). */
  seqName?: string
  seqText?: string
  /** Path of a sibling .dcd trajectory (same stem), if one exists next to an .xyz. */
  dcdPath?: string
  /** True for a .arc file: text is empty; open it lazily via the trajectory API. */
  arc?: boolean
}

/** Result of attaching a .dcd trajectory to a structure. */
export interface DcdOpened {
  ok: boolean
  trajId?: string
  frameCount?: number
  name?: string
  reason?: string
}

export interface TrajectoryOpened {
  trajId: string
  /** 0 while the background index is still being built. */
  frameCount: number
  /** Instant rough total frame count from file size (refined by indexing). */
  estimate: number
  /** First frame's text, for parsing the shared topology. */
  firstFrameText: string
}

export interface TrajectoryProgress {
  trajId: string
  /** Frames indexed (and scrubbable) so far. */
  frameCount: number
  /** True on the final update — frameCount is now exact. */
  done: boolean
}

export interface AppSettings {
  tinkerDir?: string
  /** True if Tinker executables resolve under the configured directory. */
  hasExecutables?: boolean
  /** True if Tinker's bundled basic.prm was found under the configured directory. */
  hasBasicPrm?: boolean
}

export interface JobRunRequest {
  jobId: string
  program: string
  structurePath: string
  extraArgs?: string[]
  stdin?: string
  /** When set, stream the coordinate files the program writes for live display. */
  watch?: 'dynamics' | 'minimize' | null
  /** The system's attached .key contents, used to build a temp key when watching. */
  keyText?: string
}

export interface JobLive {
  jobId: string
  /** 'append' = one new frame (text is one coordinate set); 'replace' = full .arc. */
  mode: 'append' | 'replace'
  text: string
}

/**
 * A live dynamics run's growing .arc is indexed on disk and served as a normal
 * streamed trajectory; this just reports the current frame count so the renderer
 * can follow along and scrub it through the windowed frame path.
 */
export interface JobLiveArc {
  jobId: string
  trajId: string
  frameCount: number
}

export interface JobLiveEnd {
  jobId: string
  kind: 'dynamics' | 'minimize'
  /** Name of the final/result file Tinker produced, if any. */
  resultName?: string
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
  /** True only under the headless screenshot harness (TINKER_STUDIO_CAPTURE set). */
  captureMode: Boolean(process.env['TINKER_STUDIO_CAPTURE']),
  /** Capture harness: open the molecule builder with a demo molecule instead of the example. */
  captureBuilder: Boolean(process.env['TINKER_STUDIO_CAPTURE_BUILDER']),
  /** Prompt the user for a Tinker file; resolves to its contents, or null if cancelled. */
  openStructure: (): Promise<OpenedFile | null> => ipcRenderer.invoke('structure:open'),
  /** Bundled example structure filenames for the Load Example menu/UI. */
  listSamples: (): Promise<string[]> => ipcRenderer.invoke('samples:list'),
  /** Load a bundled example by filename; same shape as openStructure. */
  openSample: (name: string): Promise<OpenedFile | null> =>
    ipcRenderer.invoke('samples:open', name),
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
    /**
     * Write a path-less system to a scratch structure file in its native format
     * (`ext` = 'xyz' | 'pdb' | 'mol' | …); resolves to the file path. The key is
     * written and passed to the program separately by `run` (which -k's it).
     */
    prepareStructure: (name: string, ext: string, text: string): Promise<string> =>
      ipcRenderer.invoke('job:prepareStructure', name, ext, text),
    /** After a job finishes, fetch the coordinate file Tinker produced (or null). */
    collectResult: (
      structurePath: string,
      since: number
    ): Promise<{ name: string; path: string; text: string } | null> =>
      ipcRenderer.invoke('job:collectResult', { structurePath, since }),
    /** Fetch a converter's output written next to its input as `<stem>.<ext>`. */
    collectNamed: (
      inputPath: string,
      ext: string,
      since: number
    ): Promise<{ name: string; path: string; text: string } | null> =>
      ipcRenderer.invoke('job:collectNamed', { inputPath, ext, since }),
    onOutput: (cb: (o: JobOutput) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, o: JobOutput): void => cb(o)
      ipcRenderer.on('job:output', listener)
      return () => ipcRenderer.removeListener('job:output', listener)
    },
    onExit: (cb: (e: JobExit) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, x: JobExit): void => cb(x)
      ipcRenderer.on('job:exit', listener)
      return () => ipcRenderer.removeListener('job:exit', listener)
    },
    onLive: (cb: (m: JobLive) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, m: JobLive): void => cb(m)
      ipcRenderer.on('job:live', listener)
      return () => ipcRenderer.removeListener('job:live', listener)
    },
    onLiveArc: (cb: (m: JobLiveArc) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, m: JobLiveArc): void => cb(m)
      ipcRenderer.on('job:liveArc', listener)
      return () => ipcRenderer.removeListener('job:liveArc', listener)
    },
    onLiveEnd: (cb: (m: JobLiveEnd) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, m: JobLiveEnd): void => cb(m)
      ipcRenderer.on('job:liveEnd', listener)
      return () => ipcRenderer.removeListener('job:liveEnd', listener)
    }
  },
  /**
   * Detachable Jobs window. The panel lives in its own OS window; the main window
   * owns local job state and publishes it here, and the Jobs window forwards the
   * few actions that must run in the main window (viewer loads, local-job removal).
   */
  jobsWindow: {
    /** Open (or focus) the Jobs window, optionally selecting a remote job by id. */
    open: (selectId?: string | null): void => ipcRenderer.send('jobs:open', selectId ?? null),
    /**
     * Main window → Jobs window: publish the current local job list. Typed as
     * `unknown[]` here because the JobRecord model lives in the renderer (which
     * this preload/main project can't import); the renderer casts on receipt.
     */
    publishLocal: (jobs: unknown[]): void => ipcRenderer.send('jobs:publishLocal', jobs),
    /** Jobs window: ask main to (re)send the current local jobs + selection on mount. */
    requestState: (): void => ipcRenderer.send('jobs:requestState'),
    /** Jobs window: subscribe to the main window's local job list. Returns an unsubscribe fn. */
    onLocalJobs: (cb: (jobs: unknown[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, jobs: unknown[]): void => cb(jobs)
      ipcRenderer.on('jobs:localJobs', listener)
      return () => ipcRenderer.removeListener('jobs:localJobs', listener)
    },
    /** Jobs window: subscribe to a remote-job id to pre-select. Returns an unsubscribe fn. */
    onSelect: (cb: (id: string | null) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string | null): void => cb(id)
      ipcRenderer.on('jobs:select', listener)
      return () => ipcRenderer.removeListener('jobs:select', listener)
    },
    /** Jobs window → main window: request an action be run there. */
    sendAction: (action: JobsAction): void => ipcRenderer.send('jobs:action', action),
    /** Main window: subscribe to actions from the Jobs window. Returns an unsubscribe fn. */
    onAction: (cb: (action: JobsAction) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, action: JobsAction): void => cb(action)
      ipcRenderer.on('jobs:action', listener)
      return () => ipcRenderer.removeListener('jobs:action', listener)
    }
  },
  /**
   * Detachable Modeling Commands window. It's a form in its own OS window; the
   * main window owns the active system + launch logic + viewer, so this window
   * receives a small context snapshot and forwards launches back to the main
   * window (local runs fire-and-forget; remote submits await a boolean reply).
   */
  commandsWindow: {
    /** Open (or focus) the Commands window. */
    open: (): void => ipcRenderer.send('commands:open'),
    /** Main window → Commands window: publish the current context snapshot. */
    publishContext: (ctx: CommandsContext): void =>
      ipcRenderer.send('commands:publishContext', ctx),
    /** Commands window: ask main to (re)send the current context on mount. */
    requestContext: (): void => ipcRenderer.send('commands:requestContext'),
    /** Commands window: subscribe to context updates. Returns an unsubscribe fn. */
    onContext: (cb: (ctx: CommandsContext) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, ctx: CommandsContext): void => cb(ctx)
      ipcRenderer.on('commands:context', listener)
      return () => ipcRenderer.removeListener('commands:context', listener)
    },
    /** Commands window → main window: launch a local run against the active system. */
    run: (req: CommandsRunReq): void => ipcRenderer.send('commands:run', req),
    /** Main window: subscribe to forwarded local runs. Returns an unsubscribe fn. */
    onRun: (cb: (req: CommandsRunReq) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, req: CommandsRunReq): void => cb(req)
      ipcRenderer.on('commands:run', listener)
      return () => ipcRenderer.removeListener('commands:run', listener)
    },
    /** Commands window → main window: submit a remote job; resolves to success. */
    submit: (opts: unknown): Promise<boolean> => ipcRenderer.invoke('commands:submit', opts),
    /** Main window: subscribe to forwarded remote submits. Returns an unsubscribe fn. */
    onSubmit: (cb: (m: CommandsSubmitMsg) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, m: CommandsSubmitMsg): void => cb(m)
      ipcRenderer.on('commands:submit', listener)
      return () => ipcRenderer.removeListener('commands:submit', listener)
    },
    /** Main window → main: resolve a forwarded submit with its result. */
    submitResult: (reqId: number, ok: boolean): void =>
      ipcRenderer.send('commands:submitResult', { reqId, ok }),
    /** Commands window → main window: open the Clusters manager. */
    manageClusters: (): void => ipcRenderer.send('commands:manageClusters'),
    /** Main window: subscribe to a request to open the Clusters manager. */
    onManageClusters: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('commands:manageClusters', listener)
      return () => ipcRenderer.removeListener('commands:manageClusters', listener)
    }
  },
  /** Enable/disable the File ▸ Save Structure As ▸ PDB menu item. */
  setPdbExportEnabled: (enabled: boolean): void =>
    ipcRenderer.send('menu:pdbExportEnabled', enabled),
  /** Save text (e.g. a .key file) to a user-chosen path; resolves to the path or null. */
  saveTextFile: (suggestedName: string, contents: string): Promise<string | null> =>
    ipcRenderer.invoke('file:saveText', { suggestedName, contents }),
  /**
   * Save a Tinker .xyz; when `withKey` is set, also writes a sibling .key pointing
   * at Tinker's bundled basic.prm (if available). Resolves to the saved path(s) or null.
   */
  saveTinkerXyz: (
    suggestedName: string,
    xyz: string,
    withKey: boolean
  ): Promise<{ path: string; keyPath?: string } | null> =>
    ipcRenderer.invoke('structure:saveTinkerXyz', { suggestedName, xyz, withKey }),
  /** Open a text file (optionally restricted by extension filters); resolves to its path/name/contents, or null. */
  openTextFile: (
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<OpenedFile | null> => ipcRenderer.invoke('file:openText', filters),
  /** Pick a file path without reading it (for binary attachments like .dcd). */
  chooseFile: (
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('file:choosePath', filters),
  /** Read a text file by path. */
  readTextFile: (path: string): Promise<string> => ipcRenderer.invoke('file:readText', path),
  /** Molecule-builder Tinker helpers. */
  builder: {
    /** True when a `minimize` executable is available in the configured Tinker dir. */
    hasMinimize: (): Promise<boolean> => ipcRenderer.invoke('tinker:hasMinimize'),
    /** Run Tinker `minimize` on generated input; resolves to optimized .xyz text or an error. */
    minimize: (input: { xyz: string; prm: string; key: string }): Promise<{
      ok: boolean
      xyz?: string
      error?: string
    }> => ipcRenderer.invoke('builder:minimize', input)
  },
  /** Resolve the force-field .prm referenced by a key's PARAMETERS line. */
  resolveForceFieldFromKey: (
    keyText: string,
    keyPath?: string
  ): Promise<{ prmText?: string; prmName?: string }> =>
    ipcRenderer.invoke('forcefield:fromKey', keyText, keyPath),
  /** Lazy access to a large .arc: index it once, then fetch frames on demand. */
  trajectory: {
    open: (path: string): Promise<TrajectoryOpened> => ipcRenderer.invoke('trajectory:open', path),
    frame: (trajId: string, frame: number): Promise<Float32Array | null> =>
      ipcRenderer.invoke('trajectory:frame', trajId, frame),
    close: (trajId: string): Promise<boolean> => ipcRenderer.invoke('trajectory:close', trajId),
    /** Validate + open a .dcd against an .xyz's atom count; resolves to a trajId on success. */
    openDcd: (path: string, natoms: number): Promise<DcdOpened> =>
      ipcRenderer.invoke('trajectory:openDcd', path, natoms),
    /** Show a dialog to pick a .dcd file; resolves to its path, or null. */
    chooseDcd: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseDcd'),
    /** Fires as a trajectory's background index grows (and once when done). */
    onProgress: (cb: (p: TrajectoryProgress) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: TrajectoryProgress): void => cb(p)
      ipcRenderer.on('trajectory:progress', listener)
      return () => ipcRenderer.removeListener('trajectory:progress', listener)
    }
  },
  /** Remote (cluster) job management: clusters, jobs, and remote trajectories. */
  remote: {
    listClusters: (): Promise<ClusterProfile[]> => ipcRenderer.invoke('remote:listClusters'),
    /** Create an in-memory default profile of a kind (not yet saved). */
    newProfile: (kind: ClusterKind, name?: string): Promise<ClusterProfile> =>
      ipcRenderer.invoke('remote:newProfile', kind, name),
    saveCluster: (profile: ClusterProfile): Promise<ClusterProfile[]> =>
      ipcRenderer.invoke('remote:saveCluster', profile),
    deleteCluster: (id: string): Promise<ClusterProfile[]> =>
      ipcRenderer.invoke('remote:deleteCluster', id),
    testConnection: (id: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('remote:testConnection', id),
    /** Test a profile that may be unsaved (ad-hoc connection vars + password). */
    testProfile: (
      profile: ClusterProfile,
      vars?: Record<string, string>,
      password?: string
    ): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('remote:testProfile', profile, vars, password),
    /** True when a password-auth cluster needs a password entered this session. */
    needsPassword: (id: string): Promise<boolean> => ipcRenderer.invoke('remote:needsPassword', id),
    /** Set a password-auth cluster's password (optionally remembered, encrypted). */
    setPassword: (
      id: string,
      password: string,
      remember: boolean
    ): Promise<{ remembered: boolean }> =>
      ipcRenderer.invoke('remote:setPassword', id, password, remember),

    submit: (req: RemoteSubmitRequest): Promise<RemoteJobRecord> =>
      ipcRenderer.invoke('remote:submit', req),
    listJobs: (): Promise<RemoteJobRecord[]> => ipcRenderer.invoke('remote:listJobs'),
    poll: (id: string): Promise<RemoteJobState> => ipcRenderer.invoke('remote:poll', id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('remote:cancel', id),
    forgetJob: (id: string): Promise<RemoteJobRecord[]> => ipcRenderer.invoke('remote:forgetJob', id),
    /** Rename a job's UI label (empty restores the default program name). */
    renameJob: (id: string, label: string): Promise<RemoteJobRecord | undefined> =>
      ipcRenderer.invoke('remote:renameJob', id, label),
    listJobFiles: (id: string): Promise<string[]> => ipcRenderer.invoke('remote:listJobFiles', id),
    /** Download a remote job file to a user-chosen local path; resolves to the path or null. */
    saveJobFile: (id: string, name: string): Promise<string | null> =>
      ipcRenderer.invoke('remote:saveJobFile', id, name),
    /** Read a remote job file's text into the app. */
    openJobText: (id: string, name: string): Promise<{ name: string; text: string }> =>
      ipcRenderer.invoke('remote:openJobText', id, name),
    /** Open an arbitrary remote text file (e.g. a remote .xyz) by path. */
    openText: (
      clusterId: string,
      path: string,
      vars?: Record<string, string>
    ): Promise<{ name: string; text: string }> =>
      ipcRenderer.invoke('remote:openText', clusterId, path, vars),

    openTrajectory: (
      clusterId: string,
      path: string,
      vars?: Record<string, string>
    ): Promise<RemoteTrajectoryOpened> =>
      ipcRenderer.invoke('remote:openTrajectory', clusterId, path, vars),
    openJobTrajectory: (id: string): Promise<RemoteTrajectoryOpened> =>
      ipcRenderer.invoke('remote:openJobTrajectory', id),
    refreshTrajectory: (trajId: string): Promise<number> =>
      ipcRenderer.invoke('remote:refreshTrajectory', trajId),
    trajFrame: (trajId: string, frame: number): Promise<Float32Array | null> =>
      ipcRenderer.invoke('remote:trajFrame', trajId, frame),
    closeTrajectory: (trajId: string): Promise<boolean> =>
      ipcRenderer.invoke('remote:closeTrajectory', trajId),

    /** Subscribe to remote job updates (status/log changes). Returns an unsubscribe fn. */
    onJobUpdate: (cb: (job: RemoteJobRecord) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, job: RemoteJobRecord): void => cb(job)
      ipcRenderer.on('remote:jobUpdate', listener)
      return () => ipcRenderer.removeListener('remote:jobUpdate', listener)
    }
  }
}

export type TinkerApi = typeof api

contextBridge.exposeInMainWorld('tinker', api)
