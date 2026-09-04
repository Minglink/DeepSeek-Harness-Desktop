import { app, BrowserWindow, dialog, shell, ipcMain } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { existsSync, appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { downloadAndInstallPlugin, parseDshUrl, getDshHome } from './installer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HOST = '127.0.0.1'
const PORT = Number(process.env.DSH_DESKTOP_PORT || 3080)
let APP_URL = `http://${HOST}:${PORT}`

const LOG_FILE = process.env.DSH_DESKTOP_LOG || path.join(getDshHome(), 'desktop.log')

function log(message) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

let backend = null
let mainWindow = null
let installDialog = null
let intentionalStop = false
let detectedAuthUrl = null
let isAuthLoaded = false

function loadAuthenticatedUrl(url) {
  if (isAuthLoaded) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  isAuthLoaded = true
  log(`Loading authenticated URL into mainWindow: ${url}`)
  mainWindow.loadURL(url).catch((err) => {
    if (err.code !== 'ERR_ABORTED') {
      log(`loadURL error: ${err.message}`)
    }
  })
}

function killProcessOnPort(port) {
  if (process.platform !== 'win32') return
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of output.split('\n')) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid) && pid !== '0' && pid !== String(process.pid)) {
          log(`killProcessOnPort: terminating lingering PID ${pid} on port ${port}`)
          try {
            execFileSync('taskkill.exe', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' })
          } catch {}
        }
      }
    }
  } catch (err) {
    log(`killProcessOnPort error: ${err.message}`)
  }
}

function bundledBackend() {
  const candidateDirs = [
    process.resourcesPath,
    path.join(path.dirname(process.execPath), 'resources'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek', 'DeepSeek Harness', 'resources'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek-Harness', 'resources'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources'),
  ]

  for (const dir of candidateDirs) {
    if (!dir) continue
    const nodePath = path.join(dir, 'node', 'node.exe')
    const runtimeDir = path.join(dir, 'runtime')
    const entry = path.join(runtimeDir, 'lib', 'bin.js')
    if (existsSync(nodePath) && existsSync(entry)) {
      return { node: nodePath, entry, cwd: runtimeDir }
    }
  }
  return null
}

function devBackend() {
  // Check local deep directory
  const localNode = path.join(__dirname, 'node', 'node.exe')
  const localEntry = path.join(__dirname, 'runtime', 'lib', 'bin.js')
  if (existsSync(localNode) && existsSync(localEntry)) {
    return { node: localNode, entry: localEntry, cwd: path.join(__dirname, 'runtime') }
  }
  // Check workspace
  let dir = path.resolve(__dirname, '..')
  for (let i = 0; i < 6; i++) {
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

function showFatal(title, detail) {
  dialog.showErrorBox(title, detail)
  app.quit()
}

function cleanLegacyPlugins() {
  try {
    const dshHome = getDshHome()
    const migrationFlag = path.join(dshHome, '.plugins-v012-cleaned')
    if (existsSync(migrationFlag)) {
      return
    }

    log('cleanLegacyPlugins: clearing incompatible legacy plugins while preserving sessions...')

    // 1. Clear plugins directory (~/.dsh/plugins)
    const pluginsDir = path.join(dshHome, 'plugins')
    if (existsSync(pluginsDir)) {
      try {
        rmSync(pluginsDir, { recursive: true, force: true })
      } catch (err) {
        log(`Failed to remove pluginsDir: ${err.message}`)
      }
    }
    mkdirSync(pluginsDir, { recursive: true })

    // 2. Clear profiles directory (~/.dsh/profiles) so 0.1.2 regenerates a clean default profile
    const profilesDir = path.join(dshHome, 'profiles')
    if (existsSync(profilesDir)) {
      try {
        rmSync(profilesDir, { recursive: true, force: true })
      } catch (err) {
        log(`Failed to remove profilesDir: ${err.message}`)
      }
    }

    // 3. Clear node_modules in ~/.dsh
    const nodeModulesDir = path.join(dshHome, 'node_modules')
    if (existsSync(nodeModulesDir)) {
      try {
        rmSync(nodeModulesDir, { recursive: true, force: true })
      } catch (err) {
        log(`Failed to remove ~/.dsh/node_modules: ${err.message}`)
      }
    }

    // Mark cleanup as completed (sessions and settings are safely untouched)
    writeFileSync(migrationFlag, '0.1.2\n', 'utf8')
    log('cleanLegacyPlugins: legacy plugins removed successfully. Historical sessions preserved.')
  } catch (err) {
    log(`cleanLegacyPlugins error: ${err.message}`)
  }
}

function startBackend(target) {
  intentionalStop = false
  detectedAuthUrl = null
  isAuthLoaded = false
  cleanLegacyPlugins()
  killProcessOnPort(PORT)
  log(`startBackend: node=${target.node} entry=${target.entry}`)
  const runtimeModules = path.join(target.cwd, 'node_modules')
  const env = {
    ...process.env,
    NODE_PATH: runtimeModules + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''),
    DSH_HOME: getDshHome(),
  }

  backend = spawn(target.node, [target.entry, 'web', '--no-open', '--port', String(PORT)], {
    cwd: target.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })

  let lastStderr = ''
  let lastStdout = ''

  function handleData(chunk, isErr = false) {
    const text = chunk.toString('utf8')
    if (isErr) {
      lastStderr += text
      if (lastStderr.length > 4000) lastStderr = lastStderr.slice(-4000)
      log(`[backend stderr] ${text.trim()}`)
    } else {
      lastStdout += text
      if (lastStdout.length > 4000) lastStdout = lastStdout.slice(-4000)
      log(`[backend stdout] ${text.trim()}`)
    }

    const match = /(https?:\/\/127\.0\.0\.1:\d+[^\s)]*)/.exec(text)
    if (match) {
      const url = match[1]
      if (!detectedAuthUrl) {
        detectedAuthUrl = url
        log(`Captured detectedAuthUrl: ${detectedAuthUrl}`)
      }
      loadAuthenticatedUrl(url)
    }
  }

  backend.stdout.on('data', (chunk) => handleData(chunk, false))
  backend.stderr.on('data', (chunk) => handleData(chunk, true))

  backend.on('exit', (code, signal) => {
    const isExpected = intentionalStop || app.isQuitting
    log(`backend exit: code=${code} signal=${signal} isExpected=${isExpected}`)
    backend = null
    if (!isExpected) {
      const detail = (lastStderr || lastStdout || '').trim()
      showFatal('DeepSeek Harness 服务已退出', `后端服务意外停止（退出码 ${code}）。\n\n${detail ? '错误详情：\n' + detail : ''}`)
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

function waitForAuthUrl(timeoutMs = 25000) {
  if (detectedAuthUrl) return Promise.resolve(detectedAuthUrl)
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const interval = setInterval(() => {
      if (detectedAuthUrl) {
        clearInterval(interval)
        resolve(detectedAuthUrl)
      } else if (Date.now() > deadline) {
        clearInterval(interval)
        reject(new Error('等待后端安全握手超时（未在规定时间内获取到启动访问令牌）'))
      } else if (!backend) {
        clearInterval(interval)
        reject(new Error('后端服务异常退出，未能完成启动'))
      }
    }, 100)
  })
}

async function restartBackend() {
  log('restartBackend requested')
  isAuthLoaded = false
  stopBackend()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const target = resolveBackend()
  if (target) {
    startBackend(target)
    try {
      await waitForAuthUrl(25000)
      return true
    } catch (err) {
      log(`restartBackend failed: ${err.message}`)
      return false
    }
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

function showPluginInstallDialog(payload) {
  if (installDialog && !installDialog.isDestroyed()) {
    installDialog.focus()
    return
  }

  installDialog = new BrowserWindow({
    width: 490,
    height: 560,
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
  <title>插件一键安装授权</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    body { background: #0f172a; color: #f8fafc; padding: 24px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .logo { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #0ea5e9, #3b82f6); display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3); }
    .title { font-size: 18px; font-weight: 600; color: #f1f5f9; }
    .subtitle { font-size: 13px; color: #94a3b8; margin-top: 3px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
    .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 13px; }
    .row:last-child { margin-bottom: 0; }
    .label { color: #94a3b8; }
    .val { color: #f8fafc; font-weight: 500; text-align: right; max-width: 270px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { background: #0284c720; color: #38bdf8; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; border: 1px solid #0284c740; }
    .perm-box { background: #1e293b; border: 1px solid #b45309; border-radius: 10px; padding: 12px; margin-bottom: 16px; }
    .perm-title { font-size: 12px; color: #fbbf24; font-weight: 600; margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
    .perm-content { font-size: 12px; color: #e2e8f0; line-height: 1.5; }
    .status { font-size: 13px; color: #38bdf8; text-align: center; min-height: 20px; font-weight: 500; margin-top: auto; }
    .progress-bar { width: 100%; height: 4px; background: #334155; border-radius: 2px; overflow: hidden; margin-top: 8px; display: none; }
    .progress-fill { height: 100%; background: #38bdf8; width: 0%; transition: width 0.2s; }
    .actions { display: flex; gap: 12px; margin-top: 14px; }
    button { flex: 1; padding: 11px 16px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-cancel { background: #334155; color: #cbd5e1; }
    .btn-cancel:hover { background: #475569; }
    .btn-install { background: #0284c7; color: #ffffff; }
    .btn-install:hover { background: #0369a1; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">📦</div>
    <div>
      <div class="title">安装 DeepSeek 扩展插件</div>
      <div class="subtitle">来自社区联动协议 dsh:// 的一键安装请求</div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <span class="label">插件名称</span>
      <span class="val" style="color: #38bdf8; font-weight: 600;">${escapeHtml(payload.name)}</span>
    </div>
    <div class="row">
      <span class="label">唯一标识</span>
      <span class="val">${escapeHtml(payload.id)}</span>
    </div>
    <div class="row">
      <span class="label">版本号</span>
      <span class="badge">${escapeHtml(payload.version)}</span>
    </div>
    <div class="row">
      <span class="label">开源仓库</span>
      <span class="val" title="${escapeHtml(payload.repo)}">${escapeHtml(payload.repo)}</span>
    </div>
  </div>

  <div class="perm-box">
    <div class="perm-title">⚠️ 权限申请声明</div>
    <div class="perm-content">${escapeHtml(payload.permissions || '网络访问, 本地文件读取')}</div>
  </div>

  <div class="status" id="status-text">等待确认授权...</div>
  <div class="progress-bar" id="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>

  <div class="actions">
    <button class="btn-cancel" id="btn-cancel" onclick="window.close()">取消</button>
    <button class="btn-install" id="btn-install">授权并一键安装</button>
  </div>

  <script>
    const { ipcRenderer } = require('electron');
    const btnInstall = document.getElementById('btn-install');
    const btnCancel = document.getElementById('btn-cancel');
    const statusText = document.getElementById('status-text');
    const progressBar = document.getElementById('progress-bar');
    const progressFill = document.getElementById('progress-fill');

    btnInstall.addEventListener('click', () => {
      btnInstall.disabled = true;
      btnCancel.disabled = true;
      progressBar.style.display = 'block';
      statusText.innerText = '正在准备下载环境...';
      ipcRenderer.send('start-plugin-install', ${JSON.stringify(payload)});
    });

    ipcRenderer.on('install-progress', (_event, msg) => {
      statusText.innerText = msg;
    });

    ipcRenderer.on('install-percent', (_event, pct) => {
      progressFill.style.width = pct + '%';
    });

    ipcRenderer.on('install-done', (_event, success, err) => {
      progressBar.style.display = 'none';
      if (success) {
        statusText.style.color = '#4ade80';
        statusText.innerText = '🎉 安装完成，服务已生效！';
        setTimeout(() => window.close(), 1500);
      } else {
        statusText.style.color = '#f87171';
        statusText.innerText = '安装失败：' + (err || '未知错误');
        btnCancel.disabled = false;
        btnCancel.innerText = '关闭';
      }
    });
  </script>
</body>
</html>`

  installDialog.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  installDialog.on('closed', () => {
    installDialog = null
  })
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]))
}

function findDshUrl(argv) {
  for (const arg of argv) {
    if (typeof arg === 'string' && (arg.toLowerCase().startsWith('dsh://') || arg.toLowerCase().startsWith('dsh:'))) {
      return arg
    }
  }
  return null
}

function handleDshProtocolUrl(url) {
  const payload = parseDshUrl(url)
  if (!payload) return
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  showPluginInstallDialog(payload)
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    const dshUrl = findDshUrl(commandLine)
    if (dshUrl) {
      handleDshProtocolUrl(dshUrl)
    }
  })

  app.on('ready', async () => {
    registerProtocol()

    // Create Main Window
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 960,
      minHeight: 640,
      title: 'DeepSeek Harness',
      icon: path.join(__dirname, 'build', 'icon.png'),
      autoHideMenuBar: true,
      backgroundColor: '#0f172a',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    const loadingHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; background: #0f172a; color: #94a3b8; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: -apple-system, sans-serif; }
    .spinner { width: 42px; height: 42px; border: 4px solid #1e293b; border-top-color: #0ea5e9; border-radius: 50%; animation: spin 0.9s linear infinite; margin-bottom: 18px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .tip { font-size: 14px; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="tip">正在启动 DeepSeek Harness 0.1.2 运行时...</div>
</body>
</html>`
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`)

    // Resolve & Start Backend (with retry up to 15s to tolerate initial disk-flush/antivirus latency)
    let target = null
    for (let attempt = 0; attempt < 30; attempt++) {
      target = resolveBackend()
      if (target) break
      log(`Waiting for backend files to become ready (attempt ${attempt + 1}/30)...`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    if (!target) {
      showFatal('缺少运行时环境', '未找到 DeepSeek Harness 运行时依赖文件 (runtime/lib/bin.js)。请确认安装包完整。')
      return
    }

    startBackend(target)

    mainWindow.webContents.on('did-finish-load', () => {
      log(`mainWindow did-finish-load: URL=${mainWindow.webContents.getURL()} title=${mainWindow.webContents.getTitle()}`)
    })

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log(`did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
      if (errorCode === -3) return
      if (detectedAuthUrl && validatedURL !== detectedAuthUrl) {
        log(`Retrying navigation to detectedAuthUrl: ${detectedAuthUrl}`)
        isAuthLoaded = false
        loadAuthenticatedUrl(detectedAuthUrl)
      }
    })

    try {
      const authUrl = await waitForAuthUrl(30000)
      loadAuthenticatedUrl(authUrl)
    } catch (err) {
      if (!backend) return
      showFatal('服务启动超时', `无法完成安全认证握手：${err.message}\n\n请检查端口 ${PORT} 是否被占用或查看运行日志：${LOG_FILE}`)
      return
    }

    // Check startup argv for dsh:// link
    const initialDshUrl = findDshUrl(process.argv)
    if (initialDshUrl) {
      setTimeout(() => handleDshProtocolUrl(initialDshUrl), 1000)
    }

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  // IPC handler for plugin installation dialog
  ipcMain.on('start-plugin-install', async (event, payload) => {
    try {
      await downloadAndInstallPlugin(payload, (msg) => {
        if (typeof msg === 'string') {
          event.reply('install-progress', msg)
        }
      })

      event.reply('install-progress', '正在热重启 DeepSeek Harness 运行时以生效...')
      await restartBackend()

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(detectedAuthUrl || APP_URL)
      }

      event.reply('install-done', true)
    } catch (err) {
      event.reply('install-done', false, err.message)
    }
  })

  app.on('window-all-closed', () => {
    stopBackend()
    app.quit()
  })

  app.on('will-quit', () => {
    stopBackend()
  })
}
