import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync, appendFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HOST = '127.0.0.1'
const PORT = Number(process.env.DSH_DESKTOP_PORT || 3080)
const APP_URL = `http://${HOST}:${PORT}`

function log(message) {
  if (!process.env.DSH_DESKTOP_LOG) return
  try {
    appendFileSync(process.env.DSH_DESKTOP_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

let backend = null
let mainWindow = null

function bundledBackend() {
  const nodePath = path.join(process.resourcesPath, 'node', 'node.exe')
  const runtimeDir = path.join(process.resourcesPath, 'runtime')
  const entry = path.join(runtimeDir, 'lib', 'bin.js')
  if (existsSync(nodePath) && existsSync(entry)) {
    return { node: nodePath, entry, cwd: runtimeDir }
  }
  return null
}

function devBackend() {
  let dir = path.resolve(__dirname, '..')
  for (let i = 0; i < 8; i++) {
    const entry = path.join(dir, 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(entry)) {
      return { node: process.env.DSH_DESKTOP_NODE || 'node', entry, cwd: dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveBackend() {
  return bundledBackend() || devBackend()
}

async function probe(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

function showFatal(title, detail) {
  dialog.showErrorBox(title, detail)
  app.quit()
}

function startBackend(target) {
  log(`startBackend: node=${target.node}`)
  log(`startBackend: entry=${target.entry} exists=${existsSync(target.entry)}`)
  backend = spawn(target.node, [target.entry, 'web'], {
    cwd: target.cwd,
    stdio: 'ignore',
    windowsHide: true,
  })
  backend.on('exit', (code, signal) => {
    log(`backend exit: code=${code} signal=${signal}`)
    backend = null
    if (!app.isQuitting) {
      showFatal('DeepSeek Harness 已退出', `后端服务意外停止（退出码 ${code}）。`)
    }
  })
  backend.on('error', (error) => {
    log(`backend spawn error: ${error.message}`)
    backend = null
    if (!app.isQuitting) {
      showFatal('无法启动 DeepSeek Harness', `启动后端失败：${error.message}`)
    }
  })
}

function stopBackend() {
  if (backend && !backend.killed) {
    backend.kill()
    backend = null
  }
}

async function createWindow() {
  const alreadyUp = await probe(APP_URL, 400)
  if (!alreadyUp) {
    const target = resolveBackend()
    if (!target) {
      showFatal('无法定位后端',
        '未找到打包的运行时，也未找到 deepseek-harness 项目目录。')
      return
    }
    startBackend(target)
    const up = await probe(APP_URL, 30000)
    if (!up) {
      showFatal('后端启动失败', `后端未在 30 秒内就绪（${APP_URL}）。`)
      return
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
  })

  mainWindow.loadURL(APP_URL)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    stopBackend()
  })

  app.whenReady().then(createWindow)

  app.on('window-all-closed', () => {
    app.quit()
  })
}
