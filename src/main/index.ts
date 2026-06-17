import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join, basename, dirname } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'

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
        { label: 'Save Structure As…', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
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
    return { path, name: basename(path), text }
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
      }
    ) => {
      const { jobId, program, structurePath, extraArgs = [], stdin } = req
      const { tinkerDir } = loadSettings()
      const exe = tinkerDir ? join(tinkerDir, program) : program
      const cwd = structurePath ? dirname(structurePath) : undefined
      const args = [structurePath ? basename(structurePath) : '', ...extraArgs].filter(
        (a) => a !== ''
      )
      try {
        const child = spawn(exe, args, { cwd })
        jobs.set(jobId, child)
        const send = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
          event.sender.send('job:output', { jobId, stream, chunk: chunk.toString() })
        }
        child.stdout?.on('data', (d) => send('stdout', d))
        child.stderr?.on('data', (d) => send('stderr', d))
        child.on('error', (e) => {
          event.sender.send('job:exit', { jobId, code: null, error: e.message })
          jobs.delete(jobId)
        })
        child.on('close', (code) => {
          event.sender.send('job:exit', { jobId, code })
          jobs.delete(jobId)
        })
        if (stdin && child.stdin) {
          child.stdin.write(stdin)
          child.stdin.end()
        }
        return { ok: true, commandLine: `${exe} ${args.join(' ')}` }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    jobs.get(jobId)?.kill()
    jobs.delete(jobId)
    return true
  })

  // Save text (e.g. a composed .key file) to a user-chosen path.
  ipcMain.handle('file:saveText', async (_e, req: { suggestedName: string; contents: string }) => {
    const r = await dialog.showSaveDialog({ defaultPath: req.suggestedName })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, req.contents, 'utf8')
    return r.filePath
  })

  // Open any text file (e.g. a .key file) and return its path + contents.
  ipcMain.handle('file:openText', async () => {
    const r = await dialog.showOpenDialog({ title: 'Open File', properties: ['openFile'] })
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
