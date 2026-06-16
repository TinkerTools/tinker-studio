import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile } from 'fs/promises'

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
}

app.whenReady().then(() => {
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
