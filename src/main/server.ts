import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { dialog, BrowserWindow, app } from 'electron'
import WebSocket, { WebSocketServer } from 'ws'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
const GENERAL_CONFIG_SCHEMA = {
  uid: 3,
  refs: {
    '0': { type: 'string', meta: {} },
    '1': { type: 'string', meta: {} },
    '2': { type: 'string', meta: {} },
    '3': { type: 'object', meta: { default: {} }, dict: { theme: 0, language: 1, enterBehavior: 2 } },
  },
}

const ONBOARDING_CONFIG_SCHEMA = {
  uid: 5,
  refs: {
    '4': { type: 'string', meta: {} },
    '5': { type: 'object', meta: { default: {} }, dict: { welcomeNoticeVersion: 4 } },
  },
}

const DEEPSEEK_CONFIG_SCHEMA = {
  uid: 28,
  refs: {
    '7': { type: 'string', meta: { role: 'credential-ref' } },
    '8': { type: 'string', meta: {} },
    '11': { type: 'number', meta: { step: 1, min: 1 } },
    '14': { type: 'number', meta: { step: 1, min: 1 } },
    '16': { type: 'string', meta: { required: true } },
    '17': { type: 'string', meta: {} },
    '18': { type: 'string', meta: {} },
    '21': { type: 'number', meta: { step: 1, min: 1 } },
    '24': { type: 'number', meta: { step: 1, min: 1 } },
    '25': {
      type: 'object',
      meta: { default: {} },
      dict: { id: 16, name: 17, description: 18, contextWindow: 21, maxTokens: 24 },
    },
    '27': {
      type: 'array',
      meta: {
        default: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek-V4-Flash',
            description: 'DeepSeek 官方极速旗舰模型，百万级超长上下文',
            contextWindow: 1000000,
            maxTokens: 32000,
          },
          {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek-V4-Pro',
            description: 'DeepSeek 顶级代码生成与复杂系统架构模型',
            contextWindow: 1000000,
            maxTokens: 32000,
          },
          {
            id: 'deepseek-v4-flash-vision-exp',
            name: 'DeepSeek-V4-Flash-Vision (图像理解)',
            description: '支持多模态图像理解与视觉分析（实验版）',
            contextWindow: 1000000,
            maxTokens: 32000,
          },
          {
            id: 'deepseek-chat',
            name: 'DeepSeek-V3',
            description: 'DeepSeek 旗舰级通用对话模型',
            contextWindow: 65536,
            maxTokens: 8192,
          },
          {
            id: 'deepseek-reasoner',
            name: 'DeepSeek-R1',
            description: 'DeepSeek 强化学习推理模型',
            contextWindow: 65536,
            maxTokens: 8192,
          },
        ],
      },
      inner: 25,
    },
    '28': {
      type: 'object',
      meta: { default: {} },
      dict: {
        apiKeyEnv: 7,
        baseURL: 8,
        defaultContextWindow: 11,
        maxTokens: 14,
        models: 27,
      },
    },
  },
}

const PIAI_CONFIG_SCHEMA = {
  uid: 49,
  refs: {
    '30': { type: 'string', meta: { role: 'credential-ref' } },
    '31': { type: 'string', meta: {} },
    '32': { type: 'union', meta: {}, list: [34, 36, 38] },
    '34': { type: 'const', meta: { required: true }, value: 'openai-compatible' },
    '36': { type: 'const', meta: { required: true }, value: 'anthropic' },
    '38': { type: 'const', meta: { required: true }, value: 'ollama' },
    '40': { type: 'string', meta: { required: true } },
    '41': { type: 'string', meta: {} },
    '42': { type: 'number', meta: {} },
    '43': { type: 'number', meta: {} },
    '44': {
      type: 'object',
      meta: { default: {} },
      dict: { id: 40, name: 41, contextWindow: 42, maxTokens: 43 },
    },
    '45': { type: 'array', meta: { default: [] }, inner: 44 },
    '46': {
      type: 'object',
      meta: { default: {} },
      dict: { apiKeyEnv: 30, baseURL: 31, api: 32, models: 45 },
    },
    '47': { type: 'dict', meta: { default: {} }, inner: 46, sKey: 48 },
    '48': { type: 'string', meta: {} },
    '49': { type: 'object', meta: { default: {} }, dict: { providers: 47 } },
  },
}

const PERMISSIONS_CONFIG_SCHEMA = {
  uid: 53,
  refs: {
    '50': { type: 'boolean', meta: {} },
    '51': { type: 'boolean', meta: {} },
    '52': { type: 'boolean', meta: {} },
    '53': {
      type: 'object',
      meta: { default: {} },
      dict: { allowSubprocesses: 50, allowNetwork: 51, allowFileSystem: 52 },
    },
  },
}

export interface ServerInstance {
  url: string
  port: number
  stop: () => Promise<void>
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
}

function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/**
 * Finds an available TCP port starting from preferredPort.
 */
async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort
  while (port < startPort + 100) {
    const isFree = await new Promise<boolean>((resolve) => {
      const server = http.createServer()
        .once('error', () => resolve(false))
        .once('listening', () => {
          server.once('close', () => resolve(true)).close()
        })
        .listen(port, '127.0.0.1')
    })
    if (isFree) return port
    port++
  }
  return startPort
}

interface ClientPluginEntry {
  id: string
  filePath: string
  rev: string
  immediately?: boolean
}

// Local Storage for Workspaces and Sessions
interface WorkspaceItem {
  id: string
  name: string
  path: string
  createdAt: number
  archivedSessionIds?: string[]
}

interface SessionItem {
  id: string
  title: string
  workspaceId: string
  createdAt: number
  model: string
  messages?: any[]
  events?: any[]
  seq?: number
  turn?: number
}

function getStorePath(): string {
  try {
    const dir = app.getPath('userData')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'dsh-store.json')
  } catch {
    return path.join(os.homedir(), '.dsh-desktop-store.json')
  }
}

function loadLocalStore(): { workspaces: WorkspaceItem[]; sessions: SessionItem[]; settings: Record<string, any>; credentials: Record<string, string> } {
  const storePath = getStorePath()
  if (fs.existsSync(storePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'))
      return {
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        settings: parsed.settings || { 'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' } },
        credentials: parsed.credentials || {},
      }
    } catch {}
  }
  return {
    workspaces: [],
    sessions: [],
    settings: { 'ui-onboarding': { welcomeNoticeVersion: '2026-08-13.1' } },
    credentials: {},
  }
}

function saveLocalStore(store: { workspaces: WorkspaceItem[]; sessions: SessionItem[]; settings: Record<string, any>; credentials?: Record<string, string> }) {
  const storePath = getStorePath()
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8')
  } catch (e) {
    console.error('[dsh-server] Failed to save store:', e)
  }
}

/**
 * Starts the embedded DeepSeek Harness Web, API & Plugin Host Server.
 */
export async function startDshServer(preferredPort = 3080): Promise<ServerInstance> {
  const port = await findAvailablePort(preferredPort)
  const serverUrl = `http://127.0.0.1:${port}`

  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  
  // Find app resources root (in both dev & packaged builds)
  const possibleAppRoots = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(process.cwd(), 'apps/desktop'),
    path.resolve(process.cwd()),
  ]

  let appDir = possibleAppRoots.find(p => fs.existsSync(path.join(p, 'web-dist')) || fs.existsSync(path.join(p, 'client-plugins'))) || possibleAppRoots[0]

  // Possible frontend web-dist roots
  const possibleWebRoots = [
    path.join(appDir, 'web-dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(__dirname, '../../../apps/web/dist'),
    path.resolve(process.cwd(), 'web-dist'),
  ]

  const webDistDir = possibleWebRoots.find(p => fs.existsSync(path.join(p, 'index.html'))) || possibleWebRoots[0]
  console.log(`[dsh-server] Using web-dist directory: ${webDistDir}`)

  // Collect client plugin registry
  const pluginMap = new Map<string, ClientPluginEntry>()

  // 1. Try loading from bundled client-plugins manifest
  const clientPluginsDir = path.join(appDir, 'client-plugins')
  const manifestPath = path.join(clientPluginsDir, 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, { id: string; file: string; rev: string; immediately?: boolean }>
      for (const [id, item] of Object.entries(manifest)) {
        const fullPath = path.join(clientPluginsDir, item.file)
        if (fs.existsSync(fullPath)) {
          pluginMap.set(id, {
            id,
            filePath: fullPath,
            rev: item.rev,
            immediately: item.immediately,
          })
        }
      }
      console.log(`[dsh-server] Loaded ${pluginMap.size} client plugins from bundled manifest`)
    } catch (e) {
      console.warn('[dsh-server] Failed to load manifest.json:', e)
    }
  }

  // 2. Scan fallback source packages and user-installed profile plugins
  const packagesRoots = [
    path.join(appDir, 'packages'),
    path.resolve(process.cwd(), 'packages'),
    path.resolve(__dirname, '../../../packages'),
    path.join(resolveDshHome(), 'profiles', 'web', 'node_modules')
  ]
    function scanDir(dir: string) {
      if (!fs.existsSync(dir)) return
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const current = path.join(dir, entry.name)
          const pkgJson = path.join(current, 'package.json')
          let clientJs = path.join(current, 'lib', 'client.js')
          if (!fs.existsSync(clientJs)) {
            clientJs = path.join(current, 'client.js')
          }
          if (fs.existsSync(pkgJson) && fs.existsSync(clientJs)) {
            try {
              const data = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
              if (data.name && data.dsh?.client?.platform === 'web') {
                const content = fs.readFileSync(clientJs)
                pluginMap.set(data.name, {
                  id: data.name,
                  filePath: clientJs,
                  rev: shortHash(content),
                  immediately: data.dsh.client.immediately === true,
                })
              }
            } catch {}
          } else {
            scanDir(current)
          }
        }
      } catch {}
    }

    for (const r of packagesRoots) {
      scanDir(r)
    }
    console.log(`[dsh-server] Scanned ${pluginMap.size} client plugins from packages directories`)
  // Build __DSH_BOOT__ graph
  const graphEntries: any[] = []
  for (const [id, item] of pluginMap.entries()) {
    graphEntries.push({
      id,
      url: `/plugins/${id}/client.js?rev=${item.rev}`,
      rev: item.rev,
      immediately: item.immediately,
    })
  }

  const bootGraph = {
    rev: shortHash(JSON.stringify(graphEntries)),
    entries: graphEntries,
  }

  const bootstrapQueueScript = `<script>(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id==="@deepseek-ai/dsh-client-modules")
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: @deepseek-ai/dsh-client-modules/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: @deepseek-ai/dsh-client-modules/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()</script>
<script src="/plugins/@deepseek-ai/dsh-client-modules/client.js"></script>
<script src="/plugins/@deepseek-ai/dsh-client-runtime/client.js"></script>
<script>window.__DSH_BOOT__ = ${JSON.stringify(bootGraph)};</script>`

  const muxSockets = new Set<WebSocket>()
  const hostSockets = new Set<WebSocket>()
  
  // Track SSE HTTP responses
  const muxSseResponses = new Set<http.ServerResponse>()
  const hostSseResponses = new Set<http.ServerResponse>()

  const wssMux = new WebSocketServer({ noServer: true })
  const wssHost = new WebSocketServer({ noServer: true })

  wssMux.on('connection', (ws) => {
    muxSockets.add(ws)
    ws.on('close', () => muxSockets.delete(ws))
    ws.on('error', () => muxSockets.delete(ws))
  })

  wssHost.on('connection', (ws) => {
    hostSockets.add(ws)
    ws.on('close', () => hostSockets.delete(ws))
    ws.on('error', () => hostSockets.delete(ws))
  })

  function broadcastMux(payload: any) {
    const frame = {
      type: 'server-request',
      rpcId: randomUUID(),
      method: payload.type,
      payload,
    }
    const str = JSON.stringify(frame)
    for (const ws of muxSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(str)
        } catch {}
      }
    }
    for (const res of muxSseResponses) {
      try {
        res.write(`data: ${str}\n\n`)
      } catch {}
    }
  }

  function broadcastHost(payload: any) {
    const frame = {
      type: 'server-request',
      rpcId: randomUUID(),
      method: payload.type,
      payload,
    }
    const str = JSON.stringify(frame)
    for (const ws of hostSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(str)
        } catch {}
      }
    }
    for (const res of hostSseResponses) {
      try {
        res.write(`data: ${str}\n\n`)
      } catch {}
    }
  }

  const inFlightRequests = new Map<string, { abort: () => void }>()

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/'
    let reqPath = decodeURIComponent(rawUrl.split('?')[0])

    // Route 1: Client Plugins: /plugins/<id>/client.js and source maps
    if (reqPath.startsWith('/plugins/')) {
      const isMap = reqPath.endsWith('.map')
      let pluginId = reqPath.slice('/plugins/'.length)
      if (pluginId.endsWith('/client.js.map')) {
        pluginId = pluginId.slice(0, -'/client.js.map'.length)
      } else if (pluginId.endsWith('/client.js')) {
        pluginId = pluginId.slice(0, -'/client.js'.length)
      }

      const plugin = pluginMap.get(pluginId)
      if (plugin) {
        const filePath = isMap ? `${plugin.filePath}.map` : plugin.filePath
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath)
          res.writeHead(200, {
            'Content-Type': isMap ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
          })
          res.end(content)
          return
        }
      }

      console.warn(`[dsh-server] 404 for plugin: ${pluginId} (req: ${reqPath})`)
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Plugin not found: ${pluginId}`)
      return
    }

    // Route 2: Realtime SSE Event Streams fallback
    if (reqPath === '/api/events.mux' || reqPath === '/api/events.host' || reqPath === '/events.mux' || reqPath === '/events.host') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write(': connected\n\n')
      
      const isMux = reqPath.includes('mux')
      if (isMux) muxSseResponses.add(res)
      else hostSseResponses.add(res)

      const interval = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(interval)
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(interval)
        if (isMux) muxSseResponses.delete(res)
        else hostSseResponses.delete(res)
      })
      return
    }

    // Route 3: Full API RPC Endpoints (POST /api/*)
    if (reqPath.startsWith('/api/')) {
      const method = reqPath.replace(/^\/api\//, '')
      let reqBody: any = {}

      if (req.method === 'POST') {
        const buffers: Buffer[] = []
        for await (const chunk of req) {
          buffers.push(chunk)
        }
        const rawBody = Buffer.concat(buffers).toString('utf8')
        try {
          if (rawBody) reqBody = JSON.parse(rawBody)
        } catch {}
      }

      const rpcId = reqBody.rpcId || randomUUID()
      const payload = reqBody.payload || {}
      const store = loadLocalStore()

      let resultValue: any = {}

      try {
        if (method === 'host.describe') {
          resultValue = {
            version: '0.1.1',
            cwd: process.cwd(),
            home: os.homedir(),
            attachedSessions: store.sessions.length,
            canOpenPath: true,
          }
        } else if (method === 'host.pickDirectory') {
          // Native Desktop Directory Picker
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
          const dlgResult = await dialog.showOpenDialog(win, {
            title: '选择工作区目录',
            properties: ['openDirectory', 'createDirectory'],
          })
          if (!dlgResult.canceled && dlgResult.filePaths && dlgResult.filePaths.length > 0) {
            const pickedPath = dlgResult.filePaths[0]
            const name = path.basename(pickedPath) || pickedPath
            
            let ws = store.workspaces.find(w => w.path === pickedPath)
            if (!ws) {
              ws = {
                id: randomUUID(),
                name,
                path: pickedPath,
                createdAt: Date.now(),
              }
              store.workspaces.unshift(ws)
              saveLocalStore(store)
            }
            resultValue = { path: pickedPath }
          } else {
            resultValue = { path: null }
          }
        } else if (method === 'host.listDirectory') {
          const targetDir = payload.path || os.homedir()
          const crumbs: any[] = []
          const entries: any[] = []

          // Build breadcrumbs
          let cur = path.resolve(targetDir)
          while (cur) {
            crumbs.unshift({
              name: path.basename(cur) || cur,
              path: cur,
              hidden: false,
            })
            const parent = path.dirname(cur)
            if (parent === cur) break
            cur = parent
          }

          try {
            if (fs.existsSync(targetDir)) {
              const files = fs.readdirSync(targetDir, { withFileTypes: true })
              for (const f of files) {
                entries.push({
                  name: f.name,
                  path: path.join(targetDir, f.name),
                  hidden: f.name.startsWith('.'),
                })
              }
            }
          } catch {}

          resultValue = {
            path: targetDir,
            home: os.homedir(),
            crumbs,
            entries,
            truncated: false,
          }
        } else if (method === 'host.createDirectory') {
          const newDir = path.join(payload.path || os.homedir(), payload.name || 'NewFolder')
          try { fs.mkdirSync(newDir, { recursive: true }) } catch {}
          resultValue = { path: newDir }
        } else if (method === 'host.openPath') {
          resultValue = { opened: true }
        } else if (method === 'workspace.list') {
          if (store.workspaces.length === 0) {
            const defaultPath = path.join(os.homedir(), 'DeepSeek-Workspaces')
            if (!fs.existsSync(defaultPath)) {
              try { fs.mkdirSync(defaultPath, { recursive: true }) } catch {}
            }
            store.workspaces.push({
              id: 'default',
              name: '默认工作区',
              path: defaultPath,
              createdAt: Date.now(),
            })
            saveLocalStore(store)
          }

          resultValue = {
            items: store.workspaces.map(w => ({
              workspaceId: w.id,
              path: w.path,
              title: w.name,
              sessionIds: store.sessions.filter(s => s.workspaceId === w.id && !(w.archivedSessionIds || []).includes(s.id)).map(s => s.id),
              createdAt: new Date(w.createdAt).toISOString(),
              updatedAt: new Date(w.createdAt).toISOString(),
            })),
            archivedSessionIds: store.workspaces.flatMap(w => w.archivedSessionIds || []),
          }
        } else if (method === 'workspace.create') {
          const wsPath = payload.path || path.join(os.homedir(), 'DeepSeek-Workspaces', payload.name || 'New-Workspace')
          try { fs.mkdirSync(wsPath, { recursive: true }) } catch {}
          const ws: WorkspaceItem = {
            id: randomUUID(),
            name: path.basename(wsPath) || '新工作区',
            path: wsPath,
            createdAt: Date.now(),
          }
          store.workspaces.unshift(ws)
          saveLocalStore(store)
          resultValue = {
            workspace: {
              workspaceId: ws.id,
              path: ws.path,
              title: ws.name,
              sessionIds: [],
              createdAt: new Date(ws.createdAt).toISOString(),
              updatedAt: new Date(ws.createdAt).toISOString(),
            },
            created: true,
          }
        } else if (method === 'workspace.rename') {
          const ws = store.workspaces.find(w => w.id === payload.workspaceId)
          if (ws) {
            ws.name = payload.title
            saveLocalStore(store)
          }
          resultValue = {
            workspace: {
              workspaceId: ws?.id || payload.workspaceId,
              path: ws?.path || os.homedir(),
              title: payload.title,
              sessionIds: [],
              createdAt: new Date(ws?.createdAt || Date.now()).toISOString(),
              updatedAt: new Date().toISOString(),
            }
          }
        } else if (method === 'workspace.delete') {
          store.workspaces = store.workspaces.filter(w => w.id !== payload.workspaceId)
          saveLocalStore(store)
          resultValue = { deleted: true }
        } else if (method === 'workspace.insertBefore') {
          resultValue = {
            workspaceIds: store.workspaces.map(w => w.id),
          }
        } else if (method === 'workspace.insertSessionBefore') {
          const ws = store.workspaces[0] || { id: 'default', name: '默认工作区', path: os.homedir(), createdAt: Date.now() }
          resultValue = {
            workspace: {
              workspaceId: ws.id,
              path: ws.path,
              title: ws.name,
              sessionIds: store.sessions.map(s => s.id),
              createdAt: new Date(ws.createdAt).toISOString(),
              updatedAt: new Date().toISOString(),
            }
          }
        } else if (method === 'workspace.archiveSession') {
          const ws = store.workspaces.find(w => store.sessions.find(s => s.id === payload.sessionId)?.workspaceId === w.id)
          if (ws) {
            if (!ws.archivedSessionIds) ws.archivedSessionIds = []
            if (!ws.archivedSessionIds.includes(payload.sessionId)) {
              ws.archivedSessionIds.push(payload.sessionId)
              saveLocalStore(store)
            }
            resultValue = { archivedSessionIds: ws.archivedSessionIds }
          } else {
            resultValue = { archivedSessionIds: [] }
          }
        } else if (method === 'agentPreset.list') {
          // Agent Presets schema: { presets: AgentPresetEntry[], authorable: boolean, hasDocument: boolean }
          resultValue = {
            presets: [
              {
                id: 'default',
                trust: 'system',
                isDefault: true,
                name: 'DeepSeek 标准全能助手',
                description: '官方标准全能编码与逻辑推理代理，支持全套工具调用',
              },
              {
                id: 'coder',
                trust: 'system',
                isDefault: false,
                name: '智能代码架构师',
                description: '针对大型项目研发、架构设计与系统重构优化',
              },
              {
                id: 'researcher',
                trust: 'system',
                isDefault: false,
                name: '全域深度研究员',
                description: '多源网络检索、技术调研与长文报告生成',
              }
            ],
            authorable: true,
            hasDocument: true,
          }
        } else if (method === 'agentPreset.select') {
          resultValue = { agentPreset: payload.agentPreset || 'default' }
        } else if (method === 'agentPreset.read') {
          resultValue = {
            agentPreset: payload.agentPreset || 'default',
            trust: 'system',
            content: '# DeepSeek Harness Agent Preset\n\nname: DeepSeek 官方智能体预设\n',
            name: 'DeepSeek 官方智能体预设',
            description: '全功能代理预设',
          }
        } else if (method === 'agentPreset.copy') {
          resultValue = { agentPreset: payload.agentPreset || 'custom' }
        } else if (method === 'agentPreset.openDocument') {
          resultValue = { opened: true }
        } else if (method === 'agentPreset.remove') {
          resultValue = {}
        } else if (method === 'settings.describe') {
          // Settings Describe Schema: { writable: boolean, hasDocument: boolean, namespaces: SettingsNamespaceView[] }
          resultValue = {
            writable: true,
            hasDocument: true,
            namespaces: [
              {
                ns: 'general',
                schema: GENERAL_CONFIG_SCHEMA,
                value: store.settings.general || { theme: 'system', language: 'zh', enterBehavior: 'queue' },
                applies: 'live',
                secrets: [],
                revision: 1,
              },
              {
                ns: 'ui-onboarding',
                schema: ONBOARDING_CONFIG_SCHEMA,
                value: store.settings['ui-onboarding'] || { welcomeNoticeVersion: '2026-08-13.1' },
                applies: 'live',
                secrets: [],
                revision: 1,
              },
              {
                ns: 'llm-deepseek',
                schema: DEEPSEEK_CONFIG_SCHEMA,
                value: {
                  apiKeyEnv: 'DEEPSEEK_API_KEY',
                  baseURL: 'https://api.deepseek.com',
                  defaultContextWindow: 1000000,
                  maxTokens: 32000,
                  defaultModel: 'deepseek-v4-flash',
                  models: [
                    {
                      id: 'deepseek-v4-flash',
                      name: 'DeepSeek-V4-Flash',
                      description: 'DeepSeek-V4-Flash（极速旗舰，100万上下文）',
                      contextWindow: 1000000,
                      maxTokens: 32000,
                    },
                    {
                      id: 'deepseek-v4-pro',
                      name: 'DeepSeek-V4-Pro',
                      description: 'DeepSeek-V4-Pro（高阶通用与编程旗舰，100万上下文）',
                      contextWindow: 1000000,
                      maxTokens: 32000,
                    },
                    {
                      id: 'deepseek-v4-flash-vision-exp',
                      name: 'DeepSeek-V4-Flash-Vision (图像理解)',
                      description: 'DeepSeek-V4-Flash 图像理解（实验版，多模态视觉）',
                      contextWindow: 1000000,
                      maxTokens: 32000,
                    },
                    {
                      id: 'deepseek-reasoner',
                      name: 'DeepSeek-R1',
                      description: 'DeepSeek-R1（深度思考与推理）',
                      contextWindow: 65536,
                      maxTokens: 8192,
                    },
                    {
                      id: 'deepseek-chat',
                      name: 'DeepSeek-V3',
                      description: 'DeepSeek-V3（通用对话与编程）',
                      contextWindow: 65536,
                      maxTokens: 8192,
                    },
                  ],
                  ...(store.settings['llm-deepseek'] || {})
                },
                base: {
                  baseURL: 'https://api.deepseek.com',
                  defaultContextWindow: 1000000,
                  maxTokens: 32000,
                  defaultModel: 'deepseek-v4-flash',
                  models: [
                    {
                      id: 'deepseek-v4-flash',
                      name: 'DeepSeek-V4-Flash',
                      description: 'DeepSeek-V4-Flash（极速旗舰，100万上下文）',
                      contextWindow: 1000000,
                      maxTokens: 32000,
                    },
                    {
                      id: 'deepseek-v4-pro',
                      name: 'DeepSeek-V4-Pro',
                      description: 'DeepSeek-V4-Pro（高阶通用与编程旗舰，100万上下文）',
                      contextWindow: 1000000,
                      maxTokens: 32000,
                    },
                    {
                      id: 'deepseek-v4-flash-vision-exp',
                      name: 'DeepSeek-V4-Flash-Vision (图像理解)',
                      description: 'DeepSeek-V4-Flash 图像理解（实验版，多模态视觉）',
                      contextWindow: 1000000,
                      maxTokens: 32000,
                    },
                    {
                      id: 'deepseek-reasoner',
                      name: 'DeepSeek-R1',
                      description: 'DeepSeek-R1（深度思考与推理）',
                      contextWindow: 65536,
                      maxTokens: 8192,
                    },
                    {
                      id: 'deepseek-chat',
                      name: 'DeepSeek-V3',
                      description: 'DeepSeek-V3（通用对话与编程）',
                      contextWindow: 65536,
                      maxTokens: 8192,
                    },
                  ],
                },
                user: store.settings['llm-deepseek'] || {},
                applies: 'live',
                secrets: [{ path: ['apiKey'], set: !!(store.settings?.['llm-deepseek']?.apiKey || store.credentials?.DEEPSEEK_API_KEY) }],
                revision: 1,
              },
              {
                ns: 'llm-pi-ai',
                schema: PIAI_CONFIG_SCHEMA,
                value: store.settings['llm-pi-ai'] || { providers: {} },
                user: store.settings['llm-pi-ai'] || { providers: {} },
                applies: 'live',
                secrets: [],
                revision: 1,
              },
              {
                ns: 'permissions',
                schema: PERMISSIONS_CONFIG_SCHEMA,
                value: store.settings.permissions || { allowSubprocesses: true, allowNetwork: true, allowFileSystem: true },
                applies: 'live',
                secrets: [],
                revision: 1,
              }
            ],
          }
        } else if (method === 'settings.openDocument') {
          resultValue = { opened: true }
        } else if (method === 'settings.update' || method === 'settings.replace' || method === 'settings.mutate') {
          const ns = payload.ns || 'general'
          store.settings[ns] = store.settings[ns] || {}
          if (payload.ops && Array.isArray(payload.ops)) {
            for (const op of payload.ops) {
              if (op.op === 'set' && op.path && op.path.length > 0) {
                let cur = store.settings[ns]
                for (let i = 0; i < op.path.length - 1; i++) {
                  cur[op.path[i]] = cur[op.path[i]] || {}
                  cur = cur[op.path[i]]
                }
                cur[op.path[op.path.length - 1]] = op.value
              } else if (op.op === 'unset' && op.path && op.path.length > 0) {
                let cur = store.settings[ns]
                for (let i = 0; i < op.path.length - 1; i++) {
                  if (!cur[op.path[i]]) break
                  cur = cur[op.path[i]]
                }
                if (cur) delete cur[op.path[op.path.length - 1]]
              }
            }
          } else if (payload.patch) {
            store.settings[ns] = { ...(store.settings[ns] || {}), ...payload.patch }
          } else if (payload.section) {
            store.settings[ns] = payload.section
          }
          saveLocalStore(store)
          resultValue = {
            ns,
            schema: { type: 'object' },
            value: store.settings[ns] || {},
            applies: 'live',
            secrets: [],
            revision: (payload.expectedRevision || 1) + 1,
          }
        } else if (method === 'credentials.describe') {
          const creds: Record<string, any> = {}
          const requestedRefs = Array.isArray(payload.refs) && payload.refs.length > 0 ? payload.refs : ['DEEPSEEK_API_KEY']
          for (const ref of requestedRefs) {
            const isSet = !!(store.credentials?.[ref] || (ref === 'DEEPSEEK_API_KEY' && (process.env.DEEPSEEK_API_KEY || store.settings?.['llm-deepseek']?.apiKey || store.settings?.deepseek?.apiKey)))
            creds[ref] = {
              configured: isSet,
              writable: true,
              source: isSet ? 'user' : undefined,
            }
          }
          resultValue = {
            credentials: creds,
          }
        } else if (method === 'credentials.set') {
          if (payload.ref && payload.value) {
            store.credentials = store.credentials || {}
            store.credentials[payload.ref] = payload.value
            if (payload.ref === 'DEEPSEEK_API_KEY') {
              store.settings['llm-deepseek'] = store.settings['llm-deepseek'] || {}
              store.settings['llm-deepseek'].apiKey = payload.value
            }
            saveLocalStore(store)
          }
          resultValue = {}
        } else if (method === 'credentials.unset') {
          if (payload.ref) {
            if (store.credentials) delete store.credentials[payload.ref]
            if (payload.ref === 'DEEPSEEK_API_KEY' && store.settings?.['llm-deepseek']) {
              delete store.settings['llm-deepseek'].apiKey
            }
            saveLocalStore(store)
          }
          resultValue = {}
        } else if (method === 'llm.providers') {
          resultValue = {
            providers: [
              {
                provider: 'deepseek-official',
                displayName: 'DeepSeek 官方 API',
                settingsNs: 'llm-deepseek',
                settingsPath: [],
                active: true,
                declared: true,
              }
            ],
          }
        } else if (method === 'llm.models') {
          resultValue = {
            groups: [
              {
                id: 'deepseek',
                name: 'DeepSeek 官方大模型',
                models: [
                  {
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek-V4-Flash (极速旗舰)',
                    description: 'DeepSeek 官方极速旗舰大模型，百万级上下文与超高吞吐',
                  },
                  {
                    id: 'deepseek-v4-pro',
                    name: 'DeepSeek-V4-Pro (高阶通用与编程)',
                    description: 'DeepSeek 顶级代码生成、复杂系统架构与深度推理模型',
                  },
                  {
                    id: 'deepseek-v4-flash-vision-exp',
                    name: 'DeepSeek-V4-Flash 图像理解 (实验版)',
                    description: '支持多模态图像与图表深度解析',
                  },
                  {
                    id: 'deepseek-reasoner',
                    name: 'DeepSeek-R1 (深度思考与推理)',
                    description: 'DeepSeek 强化学习推理模型，思维链长，擅长复杂数理推导与架构设计',
                    reasoning: {
                      efforts: [
                        { id: 'high', name: '深度思考 (High)', description: '完整展开深度推理链' },
                        { id: 'medium', name: '标准思考 (Medium)', description: '平衡推理深度与响应时间' }
                      ],
                      defaultEffort: 'high',
                    }
                  },
                  {
                    id: 'deepseek-chat',
                    name: 'DeepSeek-V3 (通用对话与编程)',
                    description: 'DeepSeek 旗舰级通用大模型，具备极强代码生成与逻辑分析能力',
                  }
                ]
              }
            ],
            failures: [],
          }
        } else if (method === 'llm.discoverModels') {
          let discovered: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number }> = []
          const apiKey = payload.apiKey || store.credentials?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || ''
          const baseURL = (payload.baseURL || 'https://api.deepseek.com').trim()

          if (apiKey) {
            const urlsToTry: string[] = []
            const cleanBase = baseURL.replace(/\/+$/, '')
            urlsToTry.push(`${cleanBase}/models`)
            urlsToTry.push(`${cleanBase}/v1/models`)
            if (cleanBase.includes('/anthropic')) {
              const parentBase = cleanBase.replace(/\/anthropic$/, '')
              urlsToTry.push(`${parentBase}/models`)
              urlsToTry.push(`${parentBase}/v1/models`)
            }

            for (const testUrl of urlsToTry) {
              try {
                const u = new URL(testUrl)
                const res = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
                  const req = https.request({
                    protocol: u.protocol,
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
                    path: u.pathname + u.search,
                    method: 'GET',
                    headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'x-api-key': apiKey,
                      'User-Agent': 'DeepSeek-Harness/0.1.1',
                    },
                    timeout: 5000,
                  }, (r) => {
                    let body = ''
                    r.on('data', chunk => { body += chunk })
                    r.on('end', () => resolve({ status: r.statusCode, body }))
                  })
                  req.on('error', reject)
                  req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
                  req.end()
                })

                if (res.status === 200 && res.body) {
                  const parsed = JSON.parse(res.body)
                  if (Array.isArray(parsed.data) && parsed.data.length > 0) {
                    discovered = parsed.data.map((m: any) => {
                      const id = typeof m === 'string' ? m : (m.id || String(m))
                      let name = id
                      if (id === 'deepseek-v4-flash') name = 'DeepSeek-V4-Flash'
                      else if (id === 'deepseek-v4-pro') name = 'DeepSeek-V4-Pro'
                      else if (id === 'deepseek-v4-flash-vision-exp') name = 'DeepSeek-V4-Flash-Vision (图像理解)'
                      else if (id === 'deepseek-chat') name = 'DeepSeek-V3'
                      else if (id === 'deepseek-reasoner') name = 'DeepSeek-R1'
                      return {
                        id,
                        name,
                        contextWindow: 1000000,
                        maxTokens: 32000,
                      }
                    })
                    break
                  }
                }
              } catch {}
            }
          }

          if (discovered.length === 0) {
            discovered = [
              { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1000000, maxTokens: 32000 },
              { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, maxTokens: 32000 },
              { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision (图像理解)', contextWindow: 1000000, maxTokens: 32000 },
              { id: 'deepseek-reasoner', name: 'DeepSeek-R1', contextWindow: 65536, maxTokens: 8192 },
              { id: 'deepseek-chat', name: 'DeepSeek-V3', contextWindow: 65536, maxTokens: 8192 },
            ]
          }

          resultValue = {
            models: discovered,
          }
        } else if (method === 'skill.list') {
          resultValue = {
            skills: [
              {
                name: 'dsh-plugin-loader',
                description: 'DeepSeek 插件市场一键安装联动协议支持',
                whenToUse: '接收并处理 dsh://plugin/install 协议时使用',
                modelInvocable: true,
              },
              {
                name: 'code-intelligence',
                description: '代码语法分析与符号导航',
                whenToUse: '检索与理解工作区代码结构时使用',
                modelInvocable: true,
              }
            ],
          }
        } else if (method === 'session.list') {
          resultValue = {
            items: store.sessions.map(s => ({
              sessionId: s.id,
              updatedAt: s.createdAt,
              running: inFlightRequests.has(s.id),
              blank: !s.messages || s.messages.length === 0,
              cwd: store.workspaces.find(w => w.id === s.workspaceId)?.path || os.homedir(),
              agentPreset: 'default',
              projections: {
                asOfSeq: s.events ? s.events.length : (s.messages ? s.messages.length : 0),
                values: {
                  title: s.title,
                }
              }
            })),
          }
        } else if (method === 'session.create') {
          const wsId = payload.workspaceId || (store.workspaces[0]?.id || 'default')
          const session: SessionItem = {
            id: randomUUID(),
            title: payload.title || '新会话',
            workspaceId: wsId,
            createdAt: Date.now(),
            model: payload.model || 'deepseek-v4-flash',
            messages: [],
            events: [],
            seq: 0,
            turn: 0,
          }
          store.sessions.unshift(session)
          saveLocalStore(store)
          resultValue = {
            sessionId: session.id,
            agentPreset: 'default',
          }
        } else if (method === 'session.history') {
          const session = store.sessions.find(s => s.id === payload.sessionId)
          resultValue = {
            events: (session?.events || []).map(event => ({ event, view: undefined })),
            hasMore: false,
            projections: {
              asOfSeq: session?.events?.length || 0,
              values: {
                title: session?.title || '新会话',
              },
            }
          }
        } else if (method === 'session.models') {
          resultValue = {
            current: {
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
            },
            routable: true,
            groups: [
              {
                id: 'deepseek',
                name: 'DeepSeek 官方大模型',
                models: [
                  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
                  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
                  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision (图像理解)' },
                  { id: 'deepseek-reasoner', name: 'DeepSeek-R1' },
                  { id: 'deepseek-chat', name: 'DeepSeek-V3' },
                ]
              }
            ],
            failures: [],
          }
        } else if (method === 'session.selectModel') {
          const session = store.sessions.find(s => s.id === payload.sessionId)
          if (session) {
            session.model = payload.model
            saveLocalStore(store)
          }
          resultValue = {
            selected: {
              provider: payload.provider || 'deepseek',
              model: payload.model,
              reasoningEffort: payload.reasoningEffort,
            }
          }
        } else if (method === 'session.rename') {
          const session = store.sessions.find(s => s.id === payload.sessionId)
          if (session) {
            session.title = payload.title
            saveLocalStore(store)
          }
          resultValue = {
            title: payload.title || '会话',
            seq: 1,
          }
        } else if (method === 'session.fork') {
          resultValue = {
            sessionId: randomUUID(),
          }
        } else if (method === 'session.search') {
          resultValue = {
            items: [],
            hasMore: false,
          }
        } else if (method === 'session.prompt') {
          const sessionId = payload.sessionId
          let session = store.sessions.find(s => s.id === sessionId)
          if (!session) {
            session = {
              id: sessionId,
              title: '新会话',
              workspaceId: store.workspaces[0]?.id || 'default',
              createdAt: Date.now(),
              model: 'deepseek-v4-flash',
              messages: [],
              events: [],
              seq: 0,
              turn: 0,
            }
            store.sessions.unshift(session)
            saveLocalStore(store)
          }

          let promptText = ''
          if (typeof payload.prompt === 'string') {
            promptText = payload.prompt
          } else if (Array.isArray(payload.content)) {
            promptText = payload.content.map((c: any) => c.text || '').filter(Boolean).join('\n')
          } else if (typeof payload.content === 'string') {
            promptText = payload.content
          } else if (payload.prompt && typeof payload.prompt.text === 'string') {
            promptText = payload.prompt.text
          } else if (payload.prompt && Array.isArray(payload.prompt.content)) {
            promptText = payload.prompt.content.map((c: any) => c.text || '').filter(Boolean).join('\n')
          } else if (payload.prompt && typeof payload.prompt.content === 'string') {
            promptText = payload.prompt.content
          } else if (typeof payload.text === 'string') {
            promptText = payload.text
          }
          promptText = promptText.trim()

          if (session && promptText) {
            session.events = session.events || []
            session.messages = session.messages || []
            session.seq = session.seq !== undefined ? session.seq : session.events.length
            session.turn = (session.turn || 0) + 1
            const currentTurn = session.turn

            // If session title is default, update title to prompt preview
            if (session.title === '新会话' || !session.title) {
              session.title = promptText.slice(0, 24)
              broadcastMux({
                type: 'session/projection',
                sessionId,
                key: 'title',
                value: session.title,
                seq: session.seq,
              })
            }

            const recordAndEmitEvent = (type: string, data: any, surfaceOp?: 'append' | 'replacement') => {
              const seq = session.seq!++
              const event: any = {
                type,
                seq,
                time: Date.now(),
                data,
              }
              if (surfaceOp) {
                event.surfaceOp = surfaceOp
              }
              session.events!.push(event)
              broadcastMux({
                type: 'session/event',
                sessionId,
                event,
              })
              return event
            }

            // 1. turn/start
            recordAndEmitEvent('turn/start', { turn: currentTurn })

            // 2. user/message
            recordAndEmitEvent('user/message', {
              id: `msg-${randomUUID()}`,
              content: [{ type: 'text', text: promptText }],
              source: { kind: 'user' },
            }, 'append')
            session.messages.push({
              role: 'user',
              content: promptText,
            })

            // 3. Status: running
            broadcastHost({
              type: 'host/session-status',
              sessionId,
              running: true,
            })

            // Launch streaming LLM inference
            ;(async () => {
              try {
                recordAndEmitEvent('step/start', { turn: currentTurn, step: 0 })

                const apiKey = store.credentials?.DEEPSEEK_API_KEY || store.settings?.['llm-deepseek']?.apiKey || process.env.DEEPSEEK_API_KEY || ''
                const baseURL = store.settings?.['llm-deepseek']?.baseURL || 'https://api.deepseek.com'
                const model = session.model || store.settings?.['llm-deepseek']?.defaultModel || 'deepseek-v4-flash'

                let fullText = ''
                let fullReasoning = ''

                if (apiKey) {
                  const cleanBase = baseURL.replace(/\/+$/, '')
                  const endpointUrl = new URL(cleanBase.endsWith('/v1') ? `${cleanBase}/chat/completions` : `${cleanBase}/chat/completions`)

                  const messagesForApi = session.messages!.map(m => ({
                    role: m.role,
                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                  }))

                  const requestBody = JSON.stringify({
                    model: model.includes('v4') || model.includes('reasoner') || model.includes('chat') ? model : 'deepseek-v4-flash',
                    messages: messagesForApi,
                    stream: true,
                  })

                  const req = https.request({
                    protocol: endpointUrl.protocol,
                    hostname: endpointUrl.hostname,
                    port: endpointUrl.port || (endpointUrl.protocol === 'https:' ? 443 : 80),
                    path: endpointUrl.pathname + endpointUrl.search,
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${apiKey}`,
                      'User-Agent': 'DeepSeek-Harness/0.1.1',
                    },
                  }, (res) => {
                    let buffer = ''
                    res.on('data', (chunk) => {
                      buffer += chunk.toString()
                      const lines = buffer.split('\n')
                      buffer = lines.pop() || ''
                      for (const line of lines) {
                        const trimmed = line.trim()
                        if (trimmed.startsWith('data: ')) {
                          const dataStr = trimmed.slice(6)
                          if (dataStr === '[DONE]') continue
                          try {
                            const parsed = JSON.parse(dataStr)
                            const delta = parsed.choices?.[0]?.delta
                            if (delta) {
                              if (delta.reasoning_content) {
                                if (!fullReasoning) {
                                  recordAndEmitEvent('assistant/chunk', {
                                    turn: currentTurn,
                                    step: 0,
                                    chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
                                  })
                                }
                                fullReasoning += delta.reasoning_content
                                recordAndEmitEvent('assistant/chunk', {
                                  turn: currentTurn,
                                  step: 0,
                                  chunk: { type: 'reasoning-delta', text: delta.reasoning_content, index: 0 },
                                })
                              }
                              if (delta.content) {
                                if (!fullText) {
                                  if (fullReasoning) {
                                    recordAndEmitEvent('assistant/chunk', {
                                      turn: currentTurn,
                                      step: 0,
                                      chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: fullReasoning } },
                                    })
                                  }
                                  recordAndEmitEvent('assistant/chunk', {
                                    turn: currentTurn,
                                    step: 0,
                                    chunk: { type: 'block-start', index: 1, blockType: 'text' },
                                  })
                                }
                                fullText += delta.content
                                recordAndEmitEvent('assistant/chunk', {
                                  turn: currentTurn,
                                  step: 0,
                                  chunk: { type: 'text-delta', text: delta.content, index: 1 },
                                })
                              }
                            }
                          } catch {}
                        }
                      }
                    })

                    res.on('end', () => {
                      inFlightRequests.delete(sessionId)
                      
                      if (fullText) {
                        recordAndEmitEvent('assistant/chunk', {
                          turn: currentTurn,
                          step: 0,
                          chunk: { type: 'block-end', index: 1, block: { type: 'text', text: fullText } },
                        })
                      } else if (fullReasoning && !fullText) {
                        // End reasoning if text never started
                        recordAndEmitEvent('assistant/chunk', {
                          turn: currentTurn,
                          step: 0,
                          chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: fullReasoning } },
                        })
                        // Add empty text block since frontend expects text
                        recordAndEmitEvent('assistant/chunk', {
                          turn: currentTurn,
                          step: 0,
                          chunk: { type: 'block-start', index: 1, blockType: 'text' },
                        })
                        recordAndEmitEvent('assistant/chunk', {
                          turn: currentTurn,
                          step: 0,
                          chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '（无回复内容）' } },
                        })
                        fullText = '（无回复内容）'
                      }

                      const contentBlocks: any[] = []
                      if (fullReasoning) {
                        contentBlocks.push({ type: 'reasoning', text: fullReasoning })
                      }
                      contentBlocks.push({ type: 'text', text: fullText || '（无回复内容）' })

                      session.messages!.push({
                        role: 'assistant',
                        content: fullText,
                      })

                      recordAndEmitEvent('assistant/message', {
                        turn: currentTurn,
                        step: 0,
                        message: {
                          id: `asst-${randomUUID()}`,
                          role: 'assistant',
                          source: { provider: 'llm-deepseek', model: model },
                          content: contentBlocks,
                        },
                      }, 'append')

                      recordAndEmitEvent('step/end', { turn: currentTurn, step: 0 }, 'append')
                      recordAndEmitEvent('turn/end', { turn: currentTurn, reason: { kind: 'completed' } }, 'append')

                      broadcastHost({
                        type: 'host/session-status',
                        sessionId,
                        running: false,
                      })
                      saveLocalStore(store)
                    })
                  })

                  inFlightRequests.set(sessionId, {
                    abort: () => {
                      req.destroy()
                    }
                  })

                  req.on('error', (err) => {
                    inFlightRequests.delete(sessionId)
                    recordAndEmitEvent('assistant/message', {
                      turn: currentTurn,
                      step: 0,
                      message: {
                        id: `err-${randomUUID()}`,
                        role: 'assistant',
                        source: { provider: 'llm-deepseek', model: model },
                        content: [{ type: 'text', text: `[API 请求失败: ${err.message}]` }],
                      },
                    }, 'append')
                    recordAndEmitEvent('step/end', { turn: currentTurn, step: 0 })
                    recordAndEmitEvent('turn/end', { turn: currentTurn, reason: { kind: 'error' } })
                    broadcastHost({
                      type: 'host/session-status',
                      sessionId,
                      running: false,
                    })
                    saveLocalStore(store)
                  })

                  req.write(requestBody)
                  req.end()
                } else {
                  recordAndEmitEvent('assistant/message', {
                    turn: currentTurn,
                    step: 0,
                    message: {
                      id: `notice-${randomUUID()}`,
                      content: [{ type: 'text', text: '请先在「设置 ➔ 模型 ➔ DeepSeek 官方 API」中配置您的 API Key。' }],
                    },
                  }, 'append')
                  recordAndEmitEvent('step/end', { turn: currentTurn, step: 0 })
                  recordAndEmitEvent('turn/end', { turn: currentTurn, reason: { kind: 'completed' } })
                  broadcastHost({
                    type: 'host/session-status',
                    sessionId,
                    running: false,
                  })
                  saveLocalStore(store)
                }
              } catch (err: any) {
                inFlightRequests.delete(sessionId)
                broadcastHost({
                  type: 'host/session-status',
                  sessionId,
                  running: false,
                })
              }
            })()
          }

          resultValue = {
            accepted: true,
          }
        } else if (method === 'session.cancel') {
          const inFlight = inFlightRequests.get(payload.sessionId)
          if (inFlight) {
            inFlight.abort()
            inFlightRequests.delete(payload.sessionId)
          }
          const session = store.sessions.find(s => s.id === payload.sessionId)
          if (session) {
            const seq = session.seq !== undefined ? session.seq++ : 0
            session.events = session.events || []
            const event = {
              type: 'turn/end',
              seq,
              time: Date.now(),
              data: {
                turn: session.turn || 1,
                reason: { kind: 'interrupted' },
              },
            }
            session.events.push(event)
            broadcastMux({
              type: 'session/event',
              sessionId: payload.sessionId,
              event,
            })
          }
          broadcastHost({
            type: 'host/session-status',
            sessionId: payload.sessionId,
            running: false,
          })
          resultValue = {
            accepted: true,
          }
        } else if (method === 'session.updateQueue') {
          resultValue = {
            accepted: true,
          }
        } else if (method === 'subagent.list') {
          resultValue = {
            entries: [],
            parentAvailable: true,
          }
        } else if (method === 'subagent.history') {
          resultValue = {
            events: [],
            hasMore: false,
          }
        } else if (method === 'subagent.prompt') {
          resultValue = {
            messageId: randomUUID(),
          }
        } else if (method === 'subagent.interrupt') {
          resultValue = {
            accepted: true,
          }
        } else if (method.includes('pluginInventory') || reqPath.includes('pluginInventory')) {
          // Plugin Inventory Remote Handler
          const allPlugins: any[] = [
            {
              entryId: 'core-harness',
              moduleName: '@deepseek-ai/dsh-core',
              enabled: true,
              fiberPhase: 'active',
            },
            {
              entryId: 'llm-deepseek',
              moduleName: '@deepseek-ai/dsh-llm',
              enabled: true,
              fiberPhase: 'active',
            },
            {
              entryId: 'plugin-protocol',
              moduleName: '@deepseek-ai/dsh-plugin-protocol-installer',
              enabled: true,
              fiberPhase: 'active',
            },
            {
              entryId: 'tools-builtin',
              moduleName: '@deepseek-ai/dsh-tools',
              enabled: true,
              fiberPhase: 'active',
            },
            {
              entryId: 'skills-engine',
              moduleName: '@deepseek-ai/dsh-skill',
              enabled: true,
              fiberPhase: 'active',
            },
            {
              entryId: 'workspace-manager',
              moduleName: '@deepseek-ai/dsh-workspace',
              enabled: true,
              fiberPhase: 'active',
            },
            {
              entryId: 'subagents-runtime',
              moduleName: '@deepseek-ai/dsh-subagent',
              enabled: true,
              fiberPhase: 'active',
            },
            ...Array.from(pluginMap.keys()).map(id => ({
              entryId: id.replace(/[^a-zA-Z0-9_-]/g, '-'),
              moduleName: id,
              enabled: true,
              fiberPhase: 'active',
            }))
          ]

          // Append plugins from cordis.patch.yml
          const patchFile = path.join(resolveDshHome(), 'profiles', 'web', 'cordis.patch.yml')
          if (fs.existsSync(patchFile)) {
            const patchContent = fs.readFileSync(patchFile, 'utf8')
            const lines = patchContent.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('- id: ')) {
                const id = lines[i].split('- id: ')[1].trim()
                const nameLine = lines[i + 1] || ''
                if (nameLine.includes('name: ')) {
                  const nameMatch = nameLine.match(/name:\s*'([^']+)'/)
                  const moduleName = nameMatch ? nameMatch[1] : id
                  if (!allPlugins.some(p => p.moduleName === moduleName)) {
                    allPlugins.push({
                      entryId: id.replace(/[^a-zA-Z0-9_-]/g, '-'),
                      moduleName: moduleName,
                      enabled: true,
                      fiberPhase: 'active'
                    })
                  }
                }
              }
            }
          }
          resultValue = { entries: allPlugins }
        } else if (method.includes('commands')) {
          resultValue = { commands: [] }
        } else if (method.includes('goals')) {
          resultValue = { goals: [] }
        } else if (method.includes('fileReferences') || method.includes('sessionReferences')) {
          resultValue = { references: [] }
        } else if (method.includes('messageFeedback')) {
          resultValue = { feedback: [] }
        } else if (method.startsWith('goal.')) {
          if (method === 'goal.clear') {
            resultValue = { cleared: true }
          } else {
            resultValue = {
              ref: {
                id: payload.ref?.id || randomUUID(),
                revision: (payload.ref?.revision || 0) + 1,
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`[dsh-server] Error handling API ${method}:`, err)
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId,
        result: {
          ok: true,
          value: resultValue,
        },
      }))
      return
    }

    // Route 4: Static Frontend HTML with Bootstrap Injections
    if (reqPath === '/' || reqPath === '/index.html') {
      const indexPath = path.join(webDistDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, 'utf8')
        html = html.replace('<head>', `<head>\n${bootstrapQueueScript}`)
        html = html.replace(/<title>.*?<\/title>/, '<title>DeepSeek Harness</title>')
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        res.end(html)
        return
      }
    }

    // Route 5: General Static Assets (CSS, JS, Fonts)
    let filePath = path.join(webDistDir, reqPath)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(webDistDir, 'index.html')
    }

    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 Not Found')
        return
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      })
      res.end(data)
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url || '/'
    const reqPath = decodeURIComponent(rawUrl.split('?')[0])
    if (reqPath === '/api/events.mux' || reqPath === '/events.mux' || reqPath === '/api/events/mux' || reqPath === '/events/mux') {
      wssMux.handleUpgrade(req, socket, head, (ws) => {
        wssMux.emit('connection', ws, req)
      })
    } else if (reqPath === '/api/events.host' || reqPath === '/events.host' || reqPath === '/api/events/host' || reqPath === '/events/host') {
      wssHost.handleUpgrade(req, socket, head, (ws) => {
        wssHost.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[dsh-server] Server listening at ${serverUrl}`)
      resolve()
    })
  })

  const stop = async () => {
    server.close()
  }

  return {
    url: serverUrl,
    port,
    stop,
  }
}
