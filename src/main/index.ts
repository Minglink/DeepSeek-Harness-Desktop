import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseDshProtocolUrl, type DshPluginInstallPayload } from './protocol.ts'
import { registerWindowsProtocol } from './windows-registry.ts'
import { startDshServer, type ServerInstance } from './server.ts'
import { installPlugin } from './installer.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..', '..')
const iconPath = path.join(rootDir, 'resources', 'icon.ico')
const pngIconPath = path.join(rootDir, 'resources', 'icon.png')

let mainWindow: BrowserWindow | null = null
let dialogWindow: BrowserWindow | null = null
let serverInstance: ServerInstance | null = null
let pendingInstallPayload: DshPluginInstallPayload | null = null

// Request Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  console.log('[dsh-desktop] Another instance is already running. Exiting...')
  app.quit()
} else {
  // Listen for second instance (hot link activation from browser)
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }

    // Look for dsh:// URL in command line arguments
    const protocolArg = argv.find(arg => arg.toLowerCase().startsWith('dsh://') || arg.toLowerCase().startsWith('dsh:'))
    if (protocolArg) {
      handleProtocolUrl(protocolArg)
    }
  })

  // macOS open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url)
  })

  app.whenReady().then(async () => {
    app.setName('DeepSeek Harness')

    // Register URI Scheme in OS
    await registerWindowsProtocol()

    // Start Backend Service
    try {
      serverInstance = await startDshServer(3080)
    } catch (err) {
      console.error('[dsh-desktop] Failed to start backend server:', err)
    }

    // Create Main GUI Window
    createMainWindow()

    // Check cold-start CLI args for dsh:// URL
    const initialProtocolArg = process.argv.find(arg =>
      arg.toLowerCase().startsWith('dsh://') || arg.toLowerCase().startsWith('dsh:'),
    )
    if (initialProtocolArg) {
      handleProtocolUrl(initialProtocolArg)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('before-quit', async () => {
    if (serverInstance) {
      console.log('[dsh-desktop] Shutting down backend server...')
      await serverInstance.stop()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

/**
 * Creates the main application window.
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: process.platform === 'win32' ? iconPath : pngIconPath,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })

  // Lock window title
  mainWindow.setTitle('DeepSeek Harness')
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault()
    mainWindow?.setTitle('DeepSeek Harness')
  })

  // Remove default native menu bar for clean modern look
  Menu.setApplicationMenu(null)

  const targetUrl = serverInstance?.url || 'http://127.0.0.1:3080'
  console.log(`[dsh-desktop] Loading main window from ${targetUrl}`)

  mainWindow.loadURL(targetUrl).catch((err) => {
    console.error(`[dsh-desktop] Failed to load URL ${targetUrl}:`, err)
  })

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Handles incoming `dsh://` protocol request.
 */
function handleProtocolUrl(rawUrl: string) {
  console.log(`[dsh-desktop] Received protocol URL: ${rawUrl}`)
  const payload = parseDshProtocolUrl(rawUrl)
  if (!payload) {
    console.warn(`[dsh-desktop] Ignored invalid protocol URL: ${rawUrl}`)
    return
  }

  showInstallDialog(payload)
}

/**
 * Opens or focuses the Plugin Installation Dialog modal.
 */
function showInstallDialog(payload: DshPluginInstallPayload) {
  pendingInstallPayload = payload

  if (dialogWindow && !dialogWindow.isDestroyed()) {
    dialogWindow.focus()
    dialogWindow.webContents.send('plugin:install-request', payload)
    return
  }

  const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs')
  const dialogHtmlPath = path.join(rootDir, 'src', 'renderer', 'install-dialog.html')

  dialogWindow = new BrowserWindow({
    width: 520,
    height: 580,
    resizable: false,
    maximizable: false,
    minimizable: false,
    modal: !!mainWindow,
    parent: mainWindow || undefined,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    title: `安装插件 - ${payload.name}`,
    icon: process.platform === 'win32' ? iconPath : pngIconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  dialogWindow.loadFile(dialogHtmlPath)

  dialogWindow.webContents.on('did-finish-load', () => {
    dialogWindow?.webContents.send('plugin:install-request', payload)
  })

  dialogWindow.on('closed', () => {
    dialogWindow = null
    pendingInstallPayload = null
  })
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('plugin:get-pending-payload', () => {
  return pendingInstallPayload
})

ipcMain.handle('plugin:confirm-install', async (_event, payload: DshPluginInstallPayload) => {
  console.log('[ipc] Starting plugin installation:', payload.name)
  const result = await installPlugin(payload, (progress) => {
    if (dialogWindow && !dialogWindow.isDestroyed()) {
      dialogWindow.webContents.send('plugin:install-progress', progress)
    }
  })
  return result
})

ipcMain.on('plugin:cancel-install', (_event, pluginId: string) => {
  console.log(`[ipc] Plugin installation canceled by user: ${pluginId}`)
})

ipcMain.on('dialog:close', () => {
  if (dialogWindow && !dialogWindow.isDestroyed()) {
    dialogWindow.close()
  }
})
