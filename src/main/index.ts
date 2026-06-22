import { app, BrowserWindow, shell, ipcMain, dialog, Menu, safeStorage } from 'electron'
import type { MenuItemConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { join, basename, dirname } from 'path'
import { readFile, writeFile } from 'fs/promises'
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import {
  LIVE_SUFFIX,
  hasSaveCycle,
  hasDcdArchive,
  buildLiveKey,
  cycleFilesFor,
  nextVersionName,
  splitArcFrames
} from './liveJob'
import {
  readFirstFrame,
  indexArcProgressive,
  readFrameCoords,
  detectStride,
  type TrajectoryIndex
} from './trajectory'
import { openDcd, readDcdFrame, type DcdIndex } from './dcd'
import { RemoteManager } from './remote/manager'
import { newClusterProfile } from './remote/presets'
import type { ClusterProfile, ClusterKind, RemoteSubmitRequest } from './remote/types'

/** Send a menu action to the focused window's renderer. */
function sendMenu(action: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu', action)
}

/** Build the native application menu. Open / Load Example live here now. */
function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'Open Remote…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenu('openRemote') },
        { label: 'New Molecule (Builder)…', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('build') },
        {
          label: 'Save Structure As',
          submenu: [
            { label: 'Tinker XYZ (.xyz)', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save:txyz') },
            { label: 'XYZ (.xyz)', click: () => sendMenu('save:xyz') },
            { label: 'MDL MOL (.mol)', click: () => sendMenu('save:mol') },
            { id: 'save-pdb', label: 'PDB (.pdb)', click: () => sendMenu('save:pdb') }
          ]
        },
        { label: 'Load Example', click: () => sendMenu('loadExample') },
        {
          label: 'Download',
          submenu: [
            { label: 'From PubChem…', click: () => sendMenu('download:pubchem') },
            { label: 'From NCI…', click: () => sendMenu('download:nci') },
            { label: 'From PDB…', click: () => sendMenu('download:pdb') }
          ]
        },
        { type: 'separator' },
        { label: 'Close System', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close') },
        ...(isMac
          ? []
          : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Tinker',
      submenu: [
        { label: 'Modeling Commands…', click: () => sendMenu('commands') },
        { label: 'Jobs…', click: () => sendMenu('jobs') },
        { label: 'Clusters…', click: () => sendMenu('clusters') },
        { label: 'Keyword Reference…', click: () => sendMenu('keywords') },
        { label: 'Open Key File…', click: () => sendMenu('openKey') },
        { label: 'Apply Force Field (.prm)…', click: () => sendMenu('applyFF') },
        { type: 'separator' },
        { label: 'Set Tinker Installation Folder…', click: () => sendMenu('setTinkerDir') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Graphics Settings…', click: () => sendMenu('graphics') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Electron main process.
 *
 * Responsibilities (kept deliberately thin): create the application window,
 * load the renderer, and own the privileged operations the UI is not allowed to
 * do directly (file I/O now; spawning/monitoring Tinker jobs later). Those are
 * exposed to the renderer through typed IPC channels via the preload script,
 * never by enabling nodeIntegration in the renderer.
 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'Force Field Explorer',
    backgroundColor: '#12141a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Open external links in the user's browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // In dev, electron-vite serves the renderer over http with HMR; in a packaged
  // build we load the bundled HTML file from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Headless screenshot harness (dev/verification only): when FFE_CAPTURE points
  // at a path, the renderer auto-loads the example, we wait for it to render, grab
  // the window to a PNG, and quit. Lets us verify rendering without a person at
  // the screen. No effect during normal use.
  const capturePath = process.env['FFE_CAPTURE']
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage()
          await writeFile(capturePath, image.toPNG())
        } catch (e) {
          console.error('capture failed:', e)
        }
        app.quit()
      }, 4000)
    })
  }
}

// Persisted settings (userData/settings.json).
interface Settings {
  tinkerDir?: string
}
function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}
function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings
  } catch {
    return {}
  }
}
function saveSettings(s: Settings): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
  } catch (e) {
    console.error('Failed to save settings:', e)
  }
}

// Running Tinker jobs, keyed by an id chosen by the renderer.
const jobs = new Map<string, ChildProcess>()

/**
 * Resolve a Tinker program from the configured Tinker directory. We now expect
 * that directory to be the Tinker *root* (holding `bin/` and `params/`), but stay
 * tolerant of installs that put binaries in a platform-specific `bin-macos/` etc.,
 * or of a directory pointed straight at the binaries. Returns the first existing
 * path, or null if none is found.
 */
function resolveTinkerExe(program: string): string | null {
  const { tinkerDir } = loadSettings()
  if (!tinkerDir) return null
  const prog = process.platform === 'win32' ? `${program}.exe` : program
  const platformBin =
    process.platform === 'darwin' ? 'bin-macos' : process.platform === 'win32' ? 'bin-windows' : 'bin-linux'
  const candidates = [
    join(tinkerDir, 'bin', prog),
    join(tinkerDir, platformBin, prog),
    join(tinkerDir, prog) // legacy: pointed straight at the bin directory
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Locate Tinker's `params/` directory under (or beside) the configured root. */
function tinkerParamsDir(): string | null {
  const { tinkerDir } = loadSettings()
  if (!tinkerDir) return null
  const candidates = [join(tinkerDir, 'params'), join(tinkerDir, '..', 'params')]
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Path to Tinker's bundled generic `basic.prm`, if present. */
function basicPrmPath(): string | null {
  const params = tinkerParamsDir()
  if (!params) return null
  const p = join(params, 'basic.prm')
  return existsSync(p) ? p : null
}

/** Scratch directory for jobs on systems that aren't backed by a file on disk. */
function workDir(): string {
  const d = join(app.getPath('temp'), 'force-field-explorer')
  mkdirSync(d, { recursive: true })
  return d
}

/** Per-job state for streaming a live simulation's coordinate files. */
interface LiveWatch {
  kind: 'dynamics' | 'minimize'
  // Dynamics trajectory output format: Tinker writes a growing .arc, or a .dcd
  // when the key has DCD-ARCHIVE. Both are streamed to the renderer identically.
  format: 'arc' | 'dcd'
  dir: string
  inputName: string // original coordinate file name, e.g. mol.xyz
  watchStem: string // stem whose cycle files we watch (mol or mol_ffelive)
  temp: boolean // did we create throwaway _ffelive files
  sent: Set<string> // cycle file names already sent (minimize)
  arcOffset: number // bytes of the .arc already read (dynamics)
  arcBuffer: string // read-but-not-yet-framed .arc tail (dynamics)
  arcStride: number // lines per .arc frame, 0 until known (dynamics)
  // Incremental byte-offset index of the growing .arc, so a live dynamics run is
  // served to the renderer as a normal streamed trajectory (dynamics).
  arcOffsets: number[] // frame byte boundaries: [0, end0, end1, …]
  arcNatoms: number // atoms per frame, 0 until known
  arcHasBox: boolean // does each frame carry a periodic-box line
  dcdIndex?: DcdIndex // parsed header of the growing .dcd (dynamics, format 'dcd')
  liveTrajId?: string // trajId under which the index is registered
  interval?: ReturnType<typeof setInterval>
  poll?: () => void
}
const liveWatches = new Map<string, LiveWatch>()

// Streamed-trajectory byte-offset indexes, keyed by trajId. Module-scope so the
// live-dynamics watcher can register/grow an index for a running job's .arc and
// the trajectory:frame handler can read from it — live playback is just a normal
// streamed trajectory whose file happens to still be growing.
const trajectories = new Map<string, TrajectoryIndex>()

// Attached .dcd trajectories (binary, fixed-size frames), keyed by trajId. Kept
// separate from the .arc/live text indexes; trajectory:frame dispatches to either.
const dcdTrajectories = new Map<string, DcdIndex>()

function makeLiveWatch(
  kind: 'dynamics' | 'minimize',
  dir: string,
  inputName: string,
  watchStem: string,
  temp: boolean,
  format: 'arc' | 'dcd' = 'arc'
): LiveWatch {
  return {
    kind,
    format,
    dir,
    inputName,
    watchStem,
    temp,
    sent: new Set(),
    arcOffset: 0,
    arcBuffer: '',
    arcStride: 0,
    arcOffsets: [0],
    arcNatoms: 0,
    arcHasBox: false
  }
}

/** Read any new coordinate data the running program has written and send it. */
function pollLive(event: IpcMainInvokeEvent, jobId: string, w: LiveWatch): void {
  try {
    if (w.kind === 'minimize') {
      for (const f of cycleFilesFor(readdirSync(w.dir), w.watchStem)) {
        if (w.sent.has(f.name)) continue
        w.sent.add(f.name)
        const text = readFileSync(join(w.dir, f.name), 'utf8')
        event.sender.send('job:live', { jobId, mode: 'append', text })
      }
    } else if (w.format === 'dcd') {
      // Live DCD: parse the binary header once (when the first frame exists), then
      // recompute the frame count from the growing file size. The renderer reads
      // frames from it on demand via the same streamed-trajectory path.
      const dcdPath = join(w.dir, `${w.watchStem}.dcd`)
      if (!existsSync(dcdPath)) return
      if (!w.dcdIndex) {
        try {
          w.dcdIndex = openDcd(dcdPath) // throws until a full first frame is written
        } catch {
          return
        }
        w.liveTrajId = `live-${jobId}`
        dcdTrajectories.set(w.liveTrajId, w.dcdIndex)
      } else {
        const size = statSync(dcdPath).size
        w.dcdIndex.frameCount = Math.floor((size - w.dcdIndex.headerSize) / w.dcdIndex.frameSize)
      }
      event.sender.send('job:liveArc', {
        jobId,
        trajId: w.liveTrajId,
        frameCount: w.dcdIndex.frameCount
      })
    } else {
      // Read only the bytes appended since last poll, frame the complete ones,
      // and send each as one coordinate set — never re-reading the whole file.
      const arc = join(w.dir, `${w.watchStem}.arc`)
      if (!existsSync(arc)) return
      const size = statSync(arc).size
      if (size <= w.arcOffset) return
      const len = size - w.arcOffset
      const buf = Buffer.allocUnsafe(len)
      const fd = openSync(arc, 'r')
      try {
        readSync(fd, buf, 0, len, w.arcOffset)
      } finally {
        closeSync(fd)
      }
      w.arcOffset = size
      w.arcBuffer += buf.toString('utf8')
      const { frames, rest, stride } = splitArcFrames(w.arcBuffer, w.arcStride)
      w.arcStride = stride
      w.arcBuffer = rest
      if (frames.length === 0) return
      // Topology is constant; read it from the first complete frame once.
      if (w.arcNatoms === 0) {
        const l = frames[0].split('\n')
        const d = detectStride(l[0], l[1] ?? '')
        w.arcNatoms = d.natoms
        w.arcHasBox = d.hasBox
      }
      // Extend the byte-offset index. Each frame's reconstructed text is byte-for-
      // byte what's in the file (Tinker writes '\n'-terminated lines, no blank
      // separators), so cumulative byte lengths are the frames' file offsets.
      for (const text of frames) {
        const last = w.arcOffsets[w.arcOffsets.length - 1]
        w.arcOffsets.push(last + Buffer.byteLength(text, 'utf8'))
      }
      if (!w.liveTrajId) w.liveTrajId = `live-${jobId}`
      const frameCount = w.arcOffsets.length - 1
      trajectories.set(w.liveTrajId, {
        path: arc,
        offsets: w.arcOffsets,
        natoms: w.arcNatoms,
        hasBox: w.arcHasBox,
        frameCount
      })
      // Tell the renderer the new frame count; it reads frames from the .arc on
      // demand through the same windowed path as an opened trajectory.
      event.sender.send('job:liveArc', { jobId, trajId: w.liveTrajId, frameCount })
    }
  } catch {
    // The directory may be mid-write; just try again next tick.
  }
}

/** Stop watching a job and drop its state (without emitting a result). */
function endLive(jobId: string, _ok: boolean): void {
  const w = liveWatches.get(jobId)
  if (!w) return
  if (w.interval) clearInterval(w.interval)
  liveWatches.delete(jobId)
}

/**
 * Final poll, emit the result name, and clean up throwaway temp files. For a
 * temp-key minimize run, copy the last cycle file to Tinker's normal versioned
 * output name (`mol.xyz_2`) and delete all `<stem>_ffelive.*` files.
 */
function finalizeLive(event: IpcMainInvokeEvent, jobId: string, ok: boolean): void {
  const w = liveWatches.get(jobId)
  if (!w) return
  if (w.interval) clearInterval(w.interval)
  try {
    if (w.poll) w.poll() // flush any remaining frames
    let resultName: string | undefined
    if (w.kind === 'minimize') {
      const cycles = cycleFilesFor(readdirSync(w.dir), w.watchStem)
      const last = cycles[cycles.length - 1]
      if (w.temp) {
        if (ok && last) {
          resultName = nextVersionName(readdirSync(w.dir), w.inputName)
          copyFileSync(join(w.dir, last.name), join(w.dir, resultName))
        }
        for (const n of readdirSync(w.dir)) {
          if (n.startsWith(`${w.watchStem}.`)) {
            try {
              unlinkSync(join(w.dir, n))
            } catch {
              // ignore files that vanished or are locked
            }
          }
        }
      } else if (last) {
        resultName = last.name
      }
    } else {
      resultName = `${w.watchStem}.${w.format}`
    }
    event.sender.send('job:liveEnd', { jobId, kind: w.kind, resultName })
  } catch {
    event.sender.send('job:liveEnd', { jobId, kind: w.kind })
  } finally {
    liveWatches.delete(jobId)
  }
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Replicate the original FFE's open chain: find a sibling .key file, read its
 * PARAMETERS line, and locate + read the referenced force-field .prm so the
 * renderer can apply it automatically.
 */
async function findAssociatedForceField(
  structurePath: string
): Promise<{ prmText?: string; prmName?: string; keyName?: string; keyText?: string }> {
  const dir = dirname(structurePath)
  const stem = basename(structurePath).replace(/\.[^.]*$/, '')
  let keyName: string | undefined
  let keyText = await readIfExists(join(dir, `${stem}.key`))
  if (keyText != null) keyName = `${stem}.key`
  else {
    keyText = await readIfExists(join(dir, 'tinker.key'))
    if (keyText != null) keyName = 'tinker.key'
  }
  if (keyText == null) return {}
  return { keyName, keyText, ...(await resolveForceFieldFromKey(keyText, dir)) }
}

/**
 * Read a key's PARAMETERS line and locate + read the referenced .prm (relative
 * to `dir` or the Tinker params directory). Returns {} if there is none.
 */
async function resolveForceFieldFromKey(
  keyText: string,
  dir: string
): Promise<{ prmText?: string; prmName?: string }> {
  const paramLine = keyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^parameters\b/i.test(l))
  if (!paramLine) return {}

  let param = paramLine
    .replace(/^parameters\s+/i, '')
    .replace(/^"(.*)"$/, '$1')
    .trim()
  if (!param || param.toLowerCase() === 'none') return {}
  if (!param.toLowerCase().endsWith('.prm')) param += '.prm'

  const fileName = basename(param)
  const { tinkerDir } = loadSettings()
  const candidates = [
    param, // absolute path
    join(dir, param), // relative to the structure
    ...(tinkerDir
      ? [
          join(tinkerDir, fileName),
          join(tinkerDir, 'params', fileName),
          join(tinkerDir, '..', 'params', fileName)
        ]
      : [])
  ]
  for (const c of candidates) {
    const prmText = await readIfExists(c)
    if (prmText) return { prmText, prmName: fileName }
  }
  return {}
}

/** Privileged operations exposed to the renderer over IPC. */
function registerIpcHandlers(): void {
  // Resolve a .prm referenced by an attached key's PARAMETERS line.
  ipcMain.handle('forcefield:fromKey', (_e, keyText: string, keyPath?: string) =>
    resolveForceFieldFromKey(keyText, keyPath ? dirname(keyPath) : '.')
  )

  // Write an in-memory system to a scratch .xyz (+ .key) so a Tinker job can run
  // on a system that wasn't loaded from a file on disk. Returns the .xyz path.
  // When `basicKey` is set (an untyped molecule typed for basic.prm), the key
  // points at Tinker's bundled basic.prm so the run actually has parameters.
  ipcMain.handle(
    'job:prepareStructure',
    (_e, name: string, xyzText: string, keyText?: string, basicKey?: boolean): string => {
      const dir = workDir()
      const stem = (name.replace(/\.[^.]*$/, '') || 'structure').replace(/[^A-Za-z0-9._-]/g, '_')
      const path = join(dir, `${stem}.xyz`)
      writeFileSync(path, xyzText, 'utf8')
      const basic = basicKey ? basicPrmPath() : null
      if (basic) writeFileSync(join(dir, `${stem}.key`), `parameters "${basic}"\n`, 'utf8')
      else if (keyText != null) writeFileSync(join(dir, `${stem}.key`), keyText, 'utf8')
      return path
    }
  )

  // Show an open dialog and return the chosen file's path + text contents.
  ipcMain.handle('structure:open', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Tinker Structure',
      properties: ['openFile'],
      filters: [
        { name: 'Structures', extensions: ['xyz', 'arc', 'txyz', 'pdb', 'int', 'sdf', 'mol'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    // .arc files can be huge — don't read them whole. Flag them so the renderer
    // opens them lazily via the streamed-trajectory API instead.
    if (path.toLowerCase().endsWith('.arc')) {
      return { path, name: basename(path), text: '', arc: true }
    }
    const text = await readFile(path, 'utf8')
    const ff = await findAssociatedForceField(path)
    // Pick up a sibling .seq file (same stem) if present.
    const stem = basename(path).replace(/\.[^.]*$/, '')
    const seqText = await readIfExists(join(dirname(path), `${stem}.seq`))
    const seq = seqText != null ? { seqName: `${stem}.seq`, seqText } : {}
    // For a Tinker .xyz, note a sibling .dcd trajectory (same stem) so the renderer
    // can offer to attach + play it (the parser validates the atom count).
    const sibDcd = join(dirname(path), `${stem}.dcd`)
    const dcd = /\.(xyz|txyz)$/i.test(path) && existsSync(sibDcd) ? { dcdPath: sibDcd } : {}
    return { path, name: basename(path), text, ...ff, ...seq, ...dcd }
  })

  // Lazy streamed-trajectory API for large .arc files: index once, then read
  // individual frames on demand (see trajectory.ts).
  let trajCounter = 0
  ipcMain.handle('trajectory:open', (e, path: string) => {
    // Return the first frame immediately so it renders without waiting for the
    // full byte-offset index, which is built in the background (non-blocking) and
    // streamed back via trajectory:progress so already-indexed frames are
    // scrubbable as the scan proceeds.
    const head = readFirstFrame(path)
    const trajId = `traj-${++trajCounter}`
    const entry: TrajectoryIndex = {
      path,
      offsets: [0],
      natoms: head.natoms,
      hasBox: head.hasBox,
      frameCount: 0
    }
    trajectories.set(trajId, entry)
    // Instant rough total from file size / first-frame size (frames vary in byte
    // length, so this is an estimate; the scan yields the exact count).
    const size = statSync(path).size
    const estimate = Math.max(1, Math.round(size / Math.max(1, Buffer.byteLength(head.firstFrameText))))

    let lastSent = 0
    void indexArcProgressive(path, (frameCount, offsets, done) => {
      if (!trajectories.has(trajId)) return false // closed; stop scanning
      entry.offsets = offsets
      entry.frameCount = frameCount
      const now = Date.now()
      if ((done || now - lastSent > 200) && !e.sender.isDestroyed()) {
        lastSent = now
        e.sender.send('trajectory:progress', { trajId, frameCount, done })
      }
      return true
    }).catch(() => {})

    return { trajId, frameCount: 0, estimate, firstFrameText: head.firstFrameText }
  })
  ipcMain.handle('trajectory:frame', (_e, trajId: string, frame: number): Float32Array | null => {
    const dcd = dcdTrajectories.get(trajId)
    if (dcd) {
      if (frame < 0 || frame >= dcd.frameCount) return null
      return readDcdFrame(dcd, frame)
    }
    const index = trajectories.get(trajId)
    if (!index || frame < 0 || frame >= index.frameCount) return null
    return readFrameCoords(index, frame)
  })
  // Attach a .dcd to an .xyz: validate it parses and its atom count matches, then
  // expose it as a streamed trajectory the renderer plays like an .arc.
  ipcMain.handle('trajectory:openDcd', (_e, path: string, natoms: number) => {
    try {
      const index = openDcd(path)
      if (index.natoms !== natoms) {
        return {
          ok: false as const,
          reason: `atom count differs (xyz has ${natoms}, dcd has ${index.natoms})`
        }
      }
      const trajId = `dcd-${++trajCounter}`
      dcdTrajectories.set(trajId, index)
      return { ok: true as const, trajId, frameCount: index.frameCount, name: basename(path) }
    } catch (e) {
      return { ok: false as const, reason: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('dialog:chooseDcd', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Attach DCD Trajectory',
      properties: ['openFile'],
      filters: [
        { name: 'DCD Trajectory', extensions: ['dcd'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  ipcMain.handle('trajectory:close', (_e, trajId: string) => {
    trajectories.delete(trajId)
    dcdTrajectories.delete(trajId)
    return true
  })

  // Fetch a structure from an online database (done in main to avoid CORS).
  ipcMain.handle('structure:download', async (_event, source: string, query: string) => {
    const q = query.trim()
    if (!q) throw new Error('Empty query')
    let url: string
    let format: 'sdf' | 'pdb'
    if (source === 'pubchem') {
      url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(q)}/record/SDF/?record_type=3d&response_type=display`
      format = 'sdf'
    } else if (source === 'nci') {
      url = `https://cactus.nci.nih.gov/chemical/structure/${encodeURIComponent(q)}/sdf`
      format = 'sdf'
    } else if (source === 'pdb') {
      url = `https://files.rcsb.org/download/${encodeURIComponent(q.toUpperCase())}.pdb`
      format = 'pdb'
    } else {
      throw new Error(`Unknown download source: ${source}`)
    }
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status}) — not found?`)
    }
    const text = await response.text()
    return { text, format, name: q }
  })

  // Report settings plus whether the configured directory actually resolves the
  // Tinker executables and bundled force fields (so the UI can confirm the choice).
  function settingsWithStatus(): Settings & { hasExecutables: boolean; hasBasicPrm: boolean } {
    return {
      ...loadSettings(),
      hasExecutables: resolveTinkerExe('minimize') != null || resolveTinkerExe('analyze') != null,
      hasBasicPrm: basicPrmPath() != null
    }
  }
  ipcMain.handle('settings:get', () => settingsWithStatus())
  ipcMain.handle('settings:chooseTinkerDir', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Select your Tinker installation folder',
      message: 'Choose the top-level Tinker folder.',
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory']
    })
    const s = loadSettings()
    if (!r.canceled && r.filePaths[0]) {
      s.tinkerDir = r.filePaths[0]
      saveSettings(s)
    }
    return settingsWithStatus()
  })

  // Launch a Tinker program: spawn `<tinkerDir>/<program> <file> [args]` in the
  // structure's directory, feed option answers to stdin, stream output back.
  // When `watch` is set, also stream the coordinate files it writes (see below).
  ipcMain.handle(
    'job:run',
    (
      event,
      req: {
        jobId: string
        program: string
        structurePath: string
        extraArgs?: string[]
        stdin?: string
        watch?: 'dynamics' | 'minimize' | null
        keyText?: string
      }
    ) => {
      const { jobId, program, structurePath, extraArgs = [], stdin, watch, keyText } = req
      // Resolve the binary under the Tinker root (bin/, bin-<platform>/, or direct);
      // fall back to a bare name so a PATH-resolved Tinker still runs.
      const exe = resolveTinkerExe(program) ?? (process.platform === 'win32' ? `${program}.exe` : program)
      // Commands with no coordinate input (e.g. protein/nucleic builders) run in
      // a scratch directory.
      const dir = structurePath ? dirname(structurePath) : workDir()
      const inputName = structurePath ? basename(structurePath) : ''
      const stem = inputName.replace(/\.[^.]*$/, '')

      // For minimizers without SAVE-CYCLE in their key, run on a throwaway copy
      // with a temp key that adds it, so the real key/dir stay untouched.
      let runName = inputName
      let live: LiveWatch | null = null
      try {
        if (watch === 'minimize') {
          if (hasSaveCycle(keyText)) {
            live = makeLiveWatch('minimize', dir, inputName, stem, false)
          } else {
            const watchStem = `${stem}${LIVE_SUFFIX}`
            copyFileSync(structurePath, join(dir, `${watchStem}.xyz`))
            writeFileSync(join(dir, `${watchStem}.key`), buildLiveKey(keyText), 'utf8')
            runName = `${watchStem}.xyz`
            live = makeLiveWatch('minimize', dir, inputName, watchStem, true)
          }
        } else if (watch === 'dynamics') {
          // A DCD-ARCHIVE key makes `dynamic` write <stem>.dcd instead of <stem>.arc.
          const fmt = hasDcdArchive(keyText) ? 'dcd' : 'arc'
          live = makeLiveWatch('dynamics', dir, inputName, stem, false, fmt)
        }

        const args = [runName, ...extraArgs].filter((a) => a !== '')
        const child = spawn(exe, args, { cwd: dir })
        jobs.set(jobId, child)
        const send = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
          event.sender.send('job:output', { jobId, stream, chunk: chunk.toString() })
        }
        child.stdout?.on('data', (d) => send('stdout', d))
        child.stderr?.on('data', (d) => send('stderr', d))

        if (live) {
          const w = live
          w.poll = (): void => pollLive(event, jobId, w)
          w.interval = setInterval(w.poll, 300)
          liveWatches.set(jobId, w)
        }

        child.on('error', (e) => {
          endLive(jobId, false)
          event.sender.send('job:exit', { jobId, code: null, error: e.message })
          jobs.delete(jobId)
        })
        child.on('close', (code) => {
          // One last poll, then emit the result + clean up any temp files.
          finalizeLive(event, jobId, code === 0)
          event.sender.send('job:exit', { jobId, code })
          jobs.delete(jobId)
        })
        if (stdin && child.stdin) {
          child.stdin.write(stdin)
          child.stdin.end()
        }
        return { ok: true, commandLine: `${exe} ${args.join(' ')}` }
      } catch (e) {
        endLive(jobId, false)
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    jobs.get(jobId)?.kill()
    jobs.delete(jobId)
    return true
  })

  // After a job finishes, locate the coordinate file Tinker produced. Tinker
  // writes optimized/derived structures as numbered cycle files next to the
  // input — e.g. `mol.xyz` -> `mol.xyz_2` (highest number = latest). Returns the
  // newest one written since the job started, or null if none was produced.
  ipcMain.handle(
    'job:collectResult',
    (_e, req: { structurePath: string; since: number }): { name: string; path: string; text: string } | null => {
      try {
        const dir = dirname(req.structurePath)
        const inputName = basename(req.structurePath)
        const cycle = /_(\d+)$/
        const candidates = readdirSync(dir)
          .filter((n) => n.startsWith(`${inputName}_`) && cycle.test(n))
          .map((name) => {
            const path = join(dir, name)
            return {
              name,
              path,
              n: Number(name.match(cycle)![1]),
              mtime: statSync(path).mtimeMs
            }
          })
          // Allow a little clock slack so we don't miss a just-written file.
          .filter((c) => c.mtime >= req.since - 2000)
        if (candidates.length === 0) return null
        candidates.sort((a, b) => b.n - a.n)
        const best = candidates[0]
        return { name: best.name, path: best.path, text: readFileSync(best.path, 'utf8') }
      } catch {
        return null
      }
    }
  )

  // Enable/disable the "Save as PDB" item — only structures carrying residue
  // data (i.e. loaded from PDB) round-trip meaningfully to PDB.
  ipcMain.on('menu:pdbExportEnabled', (_e, enabled: boolean) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('save-pdb')
    if (item) item.enabled = enabled
  })

  // Save text (e.g. a composed .key file) to a user-chosen path.
  ipcMain.handle('file:saveText', async (_e, req: { suggestedName: string; contents: string }) => {
    const r = await dialog.showSaveDialog({ defaultPath: req.suggestedName })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, req.contents, 'utf8')
    return r.filePath
  })

  // Save a Tinker .xyz and, when `withKey` is set and Tinker's bundled basic.prm is
  // available, drop a sibling .key alongside it referencing that force field — so
  // the saved structure (typed for basic.prm) is immediately usable by Tinker.
  ipcMain.handle(
    'structure:saveTinkerXyz',
    async (_e, req: { suggestedName: string; xyz: string; withKey: boolean }) => {
      const r = await dialog.showSaveDialog({ defaultPath: req.suggestedName })
      if (r.canceled || !r.filePath) return null
      await writeFile(r.filePath, req.xyz, 'utf8')
      let keyPath: string | undefined
      const basic = req.withKey ? basicPrmPath() : null
      if (basic) {
        keyPath = join(dirname(r.filePath), `${basename(r.filePath).replace(/\.[^.]*$/, '')}.key`)
        await writeFile(keyPath, `parameters "${basic}"\n`, 'utf8')
      }
      return { path: r.filePath, keyPath }
    }
  )

  // Open any text file (e.g. a .key file) and return its path + contents.
  ipcMain.handle(
    'file:openText',
    async (_e, filters?: Array<{ name: string; extensions: string[] }>) => {
    const r = await dialog.showOpenDialog({
      title: 'Open File',
      properties: ['openFile'],
      ...(filters ? { filters } : {})
    })
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    const text = await readFile(path, 'utf8')
    return { path, name: basename(path), text }
  })

  // Pick a file but don't read it (used by attach, which only reads text for
  // .key/.seq/.prm and hands a .dcd path straight to the binary trajectory API).
  ipcMain.handle(
    'file:choosePath',
    async (_e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const r = await dialog.showOpenDialog({
        title: 'Attach File',
        properties: ['openFile'],
        ...(filters ? { filters } : {})
      })
      if (r.canceled || r.filePaths.length === 0) return null
      return { path: r.filePaths[0], name: basename(r.filePaths[0]) }
    }
  )
  ipcMain.handle('file:readText', (_e, path: string) => readFile(path, 'utf8'))

  // Is a usable `minimize` executable configured? (Gates the builder's optional
  // Tinker geometry clean-up.)
  ipcMain.handle('tinker:hasMinimize', () => resolveTinkerExe('minimize') != null)

  // Run Tinker `minimize` on a builder molecule. Prefers Tinker's bundled generic
  // `basic.prm` (atom types = 10·Z + #neighbors, which the renderer writes into the
  // .xyz); falls back to the renderer's generated minimal force field if basic.prm
  // isn't found. Writes inputs to a throwaway dir and returns the optimized
  // coordinates (Tinker's `<stem>.xyz_2`).
  ipcMain.handle(
    'builder:minimize',
    (_e, req: { xyz: string; prm: string; key: string }): Promise<{ ok: boolean; xyz?: string; error?: string }> => {
      const exe = resolveTinkerExe('minimize')
      if (!exe) {
        return Promise.resolve({ ok: false, error: 'minimize not found — set the Tinker directory.' })
      }
      const dir = mkdtempSync(join(app.getPath('temp'), 'ffe-min-'))
      const stem = 'builder'
      try {
        writeFileSync(join(dir, `${stem}.xyz`), req.xyz, 'utf8')
        const basic = basicPrmPath()
        if (basic) {
          // Use Tinker's bundled basic force field directly.
          writeFileSync(join(dir, `${stem}.key`), `parameters "${basic}"\n`, 'utf8')
        } else {
          writeFileSync(join(dir, `${stem}.key`), req.key, 'utf8')
          writeFileSync(join(dir, 'builder-generic.prm'), req.prm, 'utf8')
        }
      } catch (e) {
        rmSync(dir, { recursive: true, force: true })
        return Promise.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
      // `minimize <file> <grdmin>`: pass the RMS-gradient criterion as an argument
      // (and close stdin so it can't hang waiting for a prompt).
      return new Promise((resolve) => {
        let log = ''
        const child = spawn(exe, [`${stem}.xyz`, '0.5'], { cwd: dir })
        child.stdout?.on('data', (d) => (log += d.toString()))
        child.stderr?.on('data', (d) => (log += d.toString()))
        child.stdin?.end()
        child.on('error', (err) => {
          rmSync(dir, { recursive: true, force: true })
          resolve({ ok: false, error: err.message })
        })
        child.on('close', (code) => {
          let result: { ok: boolean; xyz?: string; error?: string }
          const outPath = join(dir, `${stem}.xyz_2`)
          try {
            if (existsSync(outPath)) {
              result = { ok: true, xyz: readFileSync(outPath, 'utf8') }
            } else {
              result = { ok: false, error: `minimize produced no output (exit ${code}).\n${log.slice(-600)}` }
            }
          } catch (e) {
            result = { ok: false, error: e instanceof Error ? e.message : String(e) }
          }
          rmSync(dir, { recursive: true, force: true })
          resolve(result)
        })
      })
    }
  )
}

// Remote (cluster) job manager. Created on app-ready; broadcasts job updates to
// every open window so the Jobs UI stays live.
let remote: RemoteManager | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send(channel, payload)
  }
}

/** IPC surface for clusters, remote jobs, and remote trajectory streaming. */
function registerRemoteHandlers(mgr: RemoteManager): void {
  // Clusters.
  ipcMain.handle('remote:listClusters', () => mgr.listClusters())
  ipcMain.handle('remote:newProfile', (_e, kind: ClusterKind, name?: string) =>
    newClusterProfile(kind, name)
  )
  ipcMain.handle('remote:saveCluster', (_e, profile: ClusterProfile) => mgr.saveCluster(profile))
  ipcMain.handle('remote:deleteCluster', (_e, id: string) => mgr.deleteCluster(id))
  ipcMain.handle('remote:testConnection', (_e, id: string) => mgr.testConnection(id))
  ipcMain.handle(
    'remote:testProfile',
    (_e, profile: ClusterProfile, vars?: Record<string, string>, password?: string) =>
      mgr.testProfile(profile, vars, password)
  )
  ipcMain.handle('remote:needsPassword', (_e, id: string) => mgr.needsPassword(id))
  ipcMain.handle(
    'remote:setPassword',
    (_e, id: string, password: string, remember: boolean) => mgr.setPassword(id, password, remember)
  )

  // Jobs.
  ipcMain.handle('remote:submit', (_e, req: RemoteSubmitRequest) => mgr.submit(req))
  ipcMain.handle('remote:listJobs', () => mgr.listJobs())
  ipcMain.handle('remote:poll', (_e, id: string) => mgr.poll(id))
  ipcMain.handle('remote:cancel', (_e, id: string) => mgr.cancel(id))
  ipcMain.handle('remote:forgetJob', (_e, id: string) => mgr.forgetJob(id))
  ipcMain.handle('remote:renameJob', (_e, id: string, label: string) => mgr.renameJob(id, label))
  ipcMain.handle('remote:listJobFiles', (_e, id: string) => mgr.listJobFiles(id))

  // Download a remote job file to a user-chosen local path.
  ipcMain.handle('remote:saveJobFile', async (_e, id: string, name: string) => {
    const r = await dialog.showSaveDialog({ defaultPath: name })
    if (r.canceled || !r.filePath) return null
    const buf = await mgr.fetchJobBytes(id, name)
    await writeFile(r.filePath, buf)
    return r.filePath
  })

  // Open a remote job file as text directly into the app (no local copy kept).
  ipcMain.handle('remote:openJobText', (_e, id: string, name: string) => mgr.fetchJobText(id, name))

  // Open an arbitrary remote text file (e.g. a remote .xyz) by path.
  ipcMain.handle('remote:openText', (_e, clusterId: string, path: string, vars?: Record<string, string>) =>
    mgr.openRemoteText(clusterId, path, vars)
  )

  // Remote trajectory streaming (mirrors the local trajectory API).
  ipcMain.handle('remote:openTrajectory', (_e, clusterId: string, path: string, vars?: Record<string, string>) =>
    mgr.openTrajectory(clusterId, path, vars)
  )
  ipcMain.handle('remote:openJobTrajectory', (_e, id: string) => mgr.openJobTrajectory(id))
  ipcMain.handle('remote:refreshTrajectory', (_e, trajId: string) => mgr.refreshTrajectory(trajId))
  ipcMain.handle('remote:trajFrame', (_e, trajId: string, frame: number) =>
    mgr.readTrajectoryFrame(trajId, frame)
  )
  ipcMain.handle('remote:closeTrajectory', (_e, trajId: string) => {
    mgr.closeTrajectory(trajId)
    return true
  })
}

app.whenReady().then(() => {
  buildApplicationMenu()
  registerIpcHandlers()
  // OS-keychain encryption for remembered passwords (Electron safeStorage).
  const secretCrypto = {
    encrypt: (plain: string): string | null =>
      safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null,
    decrypt: (stored: string): string | null => {
      try {
        return safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(stored, 'base64'))
          : null
      } catch {
        return null
      }
    }
  }
  remote = new RemoteManager(app.getPath('userData'), broadcast, secretCrypto)
  registerRemoteHandlers(remote)
  remote.resumePolling()
  createWindow()

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS apps typically stay alive until the user quits explicitly.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  remote?.dispose()
})
