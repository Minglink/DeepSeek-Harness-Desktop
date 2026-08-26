import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { existsSync, appendFileSync } from 'node:fs'
import { downloadAndInstallPlugin, reconcileAllPlugins, getDshHome } from './installer.js'

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
let installDialog = null
let intentionalStop = false

function bundledBackend() {
  const nodePath = path.join(process.resourcesPath, 'node', 'node.exe')
  const runtimeDir = path.join(process.resourcesPath, 'runtime')
  const entry = path.join(runtimeDir, 'lib', 'bin.js')
  if (existsSync(nodePath) && existsSync(entry)) {
    return { node: nodePath, entry, cwd: runtimeDir }
  }
  return null
}

function installedBackend() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const base = path.join(localAppData, 'Programs', 'DeepSeek-Harness', 'resources')
  const nodePath = path.join(base, 'node', 'node.exe')
  const runtimeDir = path.join(base, 'runtime')
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
  return bundledBackend() || installedBackend() || devBackend()
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
  intentionalStop = false
  log(`startBackend: node=${target.node}`)
  log(`startBackend: entry=${target.entry} exists=${existsSync(target.entry)}`)
  const runtimeModules = path.join(target.cwd, 'node_modules')
  const env = {
    ...process.env,
    NODE_PATH: runtimeModules + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''),
  }
  backend = spawn(target.node, [target.entry, 'web', '--no-open'], {
    cwd: target.cwd,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  backend.on('exit', (code, signal) => {
    log(`backend exit: code=${code} signal=${signal} intentionalStop=${intentionalStop} isQuitting=${app.isQuitting}`)
    const isExpected = intentionalStop || app.isQuitting
    backend = null
    if (!isExpected) {
      showFatal('DeepSeek Harness 已退出', `后端服务意外停止（退出码 ${code}）。`)
    }
  })
  backend.on('error', (error) => {
    log(`backend spawn error: ${error.message}`)
    backend = null
    if (!intentionalStop && !app.isQuitting) {
      showFatal('无法启动 DeepSeek Harness', `启动后端失败：${error.message}`)
    }
  })
}

function stopBackend() {
  intentionalStop = true
  if (backend) {
    const pid = backend.pid
    try {
      if (process.platform === 'win32' && pid) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' })
        } catch {}
      }
      backend.kill('SIGTERM')
    } catch {}
    backend = null
  }
}

async function restartBackend() {
  log('restartBackend requested')
  stopBackend()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const target = resolveBackend()
  if (target) {
    startBackend(target)
    const up = await probe(APP_URL, 15000)
    return up
  }
  return false
}

function registerProtocol() {
  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('dsh', process.execPath, [path.resolve(process.argv[1])])
      }
    } else {
      app.setAsDefaultProtocolClient('dsh')
    }
  } catch {}
}

function parseDshUrl(rawUrl) {
  try {
    if (!rawUrl || typeof rawUrl !== 'string') return null
    let clean = rawUrl.trim().replace(/^["']|["']$/g, '')
    if (!clean.toLowerCase().startsWith('dsh://') && !clean.toLowerCase().startsWith('dsh:')) return null
    
    const urlObj = new URL(clean.replace(/^dsh:\/\/?/i, 'https://dummy.local/'))
    const pathname = urlObj.pathname.replace(/^\/+/, '')
    if (pathname !== 'plugin/install' && !pathname.endsWith('plugin/install')) return null
    
    const params = urlObj.searchParams
    const id = params.get('id')
    const name = params.get('name') || id
    const version = params.get('version') || 'latest'
    const repo = params.get('repo') || id
    const permissions = params.get('permissions') || '常规权限'
    const downloadUrl = params.get('downloadUrl') || ''
    
    if (!id) return null
    return { id, name, version, repo, permissions, downloadUrl }
  } catch (err) {
    return null
  }
}

function showPluginInstallDialog(payload) {
  if (installDialog && !installDialog.isDestroyed()) {
    installDialog.focus()
    return
  }

  installDialog = new BrowserWindow({
    width: 480,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: 'DeepSeek 插件安装授权',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; padding: 24px; display: flex; flex-direction: column; height: 100vh; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #3b82f6, #6366f1); display: flex; align-items: center; justify-content: center; font-size: 22px; }
    .title { font-size: 18px; font-weight: 600; color: #f1f5f9; }
    .subtitle { font-size: 13px; color: #94a3b8; margin-top: 2px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 13px; }
    .row:last-child { margin-bottom: 0; }
    .label { color: #94a3b8; }
    .val { color: #f8fafc; font-weight: 500; text-align: right; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { background: #3b82f620; color: #60a5fa; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; border: 1px solid #3b82f640; }
    .perm-box { background: #0f172a80; border-radius: 8px; padding: 10px; margin-top: 8px; border-left: 3px solid #f59e0b; }
    .perm-title { font-size: 12px; color: #f59e0b; font-weight: 600; margin-bottom: 4px; }
    .perm-content { font-size: 12px; color: #cbd5e1; line-height: 1.4; }
    .status { margin-top: auto; font-size: 13px; color: #38bdf8; text-align: center; min-height: 20px; font-weight: 500; }
    .actions { display: flex; gap: 12px; margin-top: 16px; }
    button { flex: 1; padding: 10px 16px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-cancel { background: #334155; color: #cbd5e1; }
    .btn-cancel:hover { background: #475569; }
    .btn-install { background: #2563eb; color: #ffffff; }
    .btn-install:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🐳</div>
    <div>
      <div class="title">安装 DeepSeek 插件</div>
      <div class="subtitle">来自外部协议 dsh:// 的一键安装请求</div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <span class="label">插件名称</span>
      <span class="val" style="color: #60a5fa; font-weight: 600;">${escapeHtml(payload.name)}</span>
    </div>
    <div class="row">
      <span class="label">唯一标识</span>
      <span class="val">${escapeHtml(payload.id)}</span>
    </div>
    <div class="row">
      <span class="label">版本号</span>
      <span class="val"><span class="badge">v${escapeHtml(payload.version)}</span></span>
    </div>
    <div class="row">
      <span class="label">源码仓库/包名</span>
      <span class="val">${escapeHtml(payload.repo)}</span>
    </div>
    <div class="perm-box">
      <div class="perm-title">🛡️ 声明权限</div>
      <div class="perm-content">${escapeHtml(payload.permissions)}</div>
    </div>
  </div>

  <div id="status" class="status"></div>

  <div class="actions">
    <button id="cancelBtn" class="btn-cancel" onclick="handleCancel()">取消</button>
    <button id="installBtn" class="btn-install" onclick="handleInstall()">开始安装</button>
  </div>

  <script>
    const { ipcRenderer } = require('electron')
    function handleCancel() {
      window.close()
    }
    async function handleInstall() {
      document.getElementById('installBtn').disabled = true
      document.getElementById('cancelBtn').disabled = true
      document.getElementById('status').innerText = '正在启动安装流程...'
      ipcRenderer.send('dsh-install-plugin', ${JSON.stringify(payload)})
    }
    ipcRenderer.on('dsh-install-status', (event, msg) => {
      document.getElementById('status').innerText = msg
    })
    ipcRenderer.on('dsh-install-done', () => {
      document.getElementById('status').innerHTML = '<span style="color: #4ade80;">✅ 安装成功！已自动装载并热重启</span>'
      setTimeout(() => {
        window.close()
      }, 1200)
    })
    ipcRenderer.on('dsh-install-error', (event, err) => {
      document.getElementById('status').innerHTML = '<span style="color: #f87171;">❌ 安装失败: ' + err + '</span>'
      document.getElementById('cancelBtn').disabled = false
      document.getElementById('cancelBtn').innerText = '关闭'
    })
  </script>
</body>
</html>`

  installDialog.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  installDialog.on('closed', () => {
    installDialog = null
  })
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function handleProtocolUrl(rawUrl) {
  log(`handleProtocolUrl: ${rawUrl}`)
  const payload = parseDshUrl(rawUrl)
  if (!payload) return

  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  showPluginInstallDialog(payload)
}

// IPC listener for plugin installation
ipcMain.on('dsh-install-plugin', async (event, payload) => {
  try {
    await downloadAndInstallPlugin(payload, (msg) => {
      if (installDialog && !installDialog.isDestroyed()) {
        installDialog.webContents.send('dsh-install-status', msg)
      }
    })
    if (installDialog && !installDialog.isDestroyed()) {
      installDialog.webContents.send('dsh-install-status', '正在重启后端服务以载入插件...')
    }
    await restartBackend()
    if (installDialog && !installDialog.isDestroyed()) {
      installDialog.webContents.send('dsh-install-done')
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload()
    }
  } catch (err) {
    if (installDialog && !installDialog.isDestroyed()) {
      installDialog.webContents.send('dsh-install-error', err.message || String(err))
    }
  }
})

async function createWindow() {
  registerProtocol()

  // Auto-sync and repair all plugins in ~/.dsh/plugins on application startup
  try {
    const dshHome = getDshHome()
    const healed = reconcileAllPlugins(dshHome)
    if (healed.length > 0) {
      log(`Auto-reconciled plugins on startup: ${healed.join(', ')}`)
    }
  } catch (e) {
    log(`Plugin auto-reconcile error: ${e.message}`)
  }

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

  // Cold-start check for protocol URL
  const initialArg = process.argv.find(arg => arg.toLowerCase().startsWith('dsh://') || arg.toLowerCase().startsWith('dsh:'))
  if (initialArg) {
    handleProtocolUrl(initialArg)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const protoArg = commandLine.find(arg => arg.toLowerCase().startsWith('dsh://') || arg.toLowerCase().startsWith('dsh:'))
    if (protoArg) {
      handleProtocolUrl(protoArg)
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

