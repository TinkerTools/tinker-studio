import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron'
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
  closeSync
} from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import {
  LIVE_SUFFIX,
  hasSaveCycle,
  buildLiveKey,
  cycleFilesFor,
  nextVersionName,
  splitArcFrames
} from './liveJob'

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
        { label: 'Job Output…', click: () => sendMenu('jobs') },
        { label: 'Keyword Reference…', click: () => sendMenu('keywords') },
        { label: 'Open Key File…', click: () => sendMenu('openKey') },
        { label: 'Apply Force Field (.prm)…', click: () => sendMenu('applyFF') },
        { type: 'separator' },
        { label: 'Set Tinker Directory…', click: () => sendMenu('setTinkerDir') }
      ]
    },
    { role: 'viewMenu' },
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

/** Per-job state for streaming a live simulation's coordinate files. */
interface LiveWatch {
  kind: 'dynamics' | 'minimize'
  dir: string
  inputName: string // original coordinate file name, e.g. mol.xyz
  watchStem: string // stem whose cycle files we watch (mol or mol_ffelive)
  temp: boolean // did we create throwaway _ffelive files
  sent: Set<string> // cycle file names already sent (minimize)
  arcOffset: number // bytes of the .arc already read (dynamics)
  arcBuffer: string // read-but-not-yet-framed .arc tail (dynamics)
  arcStride: number // lines per .arc frame, 0 until known (dynamics)
  interval?: ReturnType<typeof setInterval>
  poll?: () => void
}
const liveWatches = new Map<string, LiveWatch>()

function makeLiveWatch(
  kind: 'dynamics' | 'minimize',
  dir: string,
  inputName: string,
  watchStem: string,
  temp: boolean
): LiveWatch {
  return {
    kind,
    dir,
    inputName,
    watchStem,
    temp,
    sent: new Set(),
    arcOffset: 0,
    arcBuffer: '',
    arcStride: 0
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
      for (const text of frames) event.sender.send('job:live', { jobId, mode: 'append', text })
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
      resultName = `${w.watchStem}.arc`
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
  const key = { keyName, keyText }

  const paramLine = keyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^parameters\b/i.test(l))
  if (!paramLine) return key

  let param = paramLine
    .replace(/^parameters\s+/i, '')
    .replace(/^"(.*)"$/, '$1')
    .trim()
  if (!param || param.toLowerCase() === 'none') return key
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
    if (prmText) return { prmText, prmName: fileName, ...key }
  }
  return key
}

/** Privileged operations exposed to the renderer over IPC. */
function registerIpcHandlers(): void {
  // Show an open dialog and return the chosen file's path + text contents.
  ipcMain.handle('structure:open', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Tinker Structure',
      properties: ['openFile'],
      filters: [
        { name: 'Tinker Coordinates', extensions: ['xyz', 'arc', 'txyz'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const text = await readFile(path, 'utf8')
    const ff = await findAssociatedForceField(path)
    return { path, name: basename(path), text, ...ff }
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

  // Settings: report current, or prompt for the Tinker binary directory.
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:chooseTinkerDir', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Select the Tinker Binary Directory',
      properties: ['openDirectory']
    })
    const s = loadSettings()
    if (!r.canceled && r.filePaths[0]) {
      s.tinkerDir = r.filePaths[0]
      saveSettings(s)
    }
    return s
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
      const { tinkerDir } = loadSettings()
      const exe = tinkerDir ? join(tinkerDir, program) : program
      const dir = dirname(structurePath)
      const inputName = basename(structurePath)
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
          live = makeLiveWatch('dynamics', dir, inputName, stem, false)
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
}

app.whenReady().then(() => {
  buildApplicationMenu()
  registerIpcHandlers()
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
