import { app, BrowserWindow, dialog, shell, ipcMain, Menu } from 'electron'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import fs, { existsSync, appendFileSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { downloadAndInstallPlugin, parseDshUrl, getDshHome, armorPluginCode } from './installer.js'
import { readConfig, hasValidApiKey, saveConfig, testApiConnection } from './api-vault.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HOST = '127.0.0.1'
const DEFAULT_PORT = Number(process.env.DSH_DESKTOP_PORT || 3080)
let APP_URL = `http://${HOST}:${DEFAULT_PORT}`

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
let onboardingDialog = null
let hubWindow = null
let localMarketWindow = null
let intentionalStop = false
let detectedAuthUrl = null
let isAuthLoaded = false
let pendingDshUrl = null
let lastStderr = ''
let lastStdout = ''

function loadAuthenticatedUrl(url) {
  if (isAuthLoaded) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  isAuthLoaded = true
  APP_URL = url
  log(`Loading authenticated URL into mainWindow: ${url}`)
  mainWindow.loadURL(url).catch((err) => {
    if (err.code !== 'ERR_ABORTED') {
      log(`loadURL error: ${err.message}`)
    }
  })
}

/**
 * Checks if a port is available on 127.0.0.1.
 * If occupied, blocked, or in Windows ExcludedPortRange, returns 0 so OS assigns a free port.
 */
function getAvailablePort(preferredPort = 3080) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => {
      log(`Port ${preferredPort} unavailable (${err.code || err.message}). Falling back to dynamic free port...`)
      resolve(0)
    })
    server.once('listening', () => {
      server.close(() => {
        log(`Port ${preferredPort} is verified free and available.`)
        resolve(preferredPort)
      })
    })
    try {
      server.listen(preferredPort, '127.0.0.1')
    } catch {
      resolve(0)
    }
  })
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const client = new net.Socket()
    client.setTimeout(80)
    client.once('connect', () => {
      client.destroy()
      resolve(true)
    })
    client.once('error', () => {
      client.destroy()
      resolve(false)
    })
    client.once('timeout', () => {
      client.destroy()
      resolve(false)
    })
    try {
      client.connect(port, '127.0.0.1')
    } catch {
      resolve(false)
    }
  })
}

async function killProcessOnPort(port) {
  if (!port || port === 0) return
  const inUse = await isPortListening(port)
  if (!inUse) return
  try {
    if (process.platform === 'win32') {
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
    } else {
      log(`killProcessOnPort (Linux): terminating lingering processes on port ${port}`)
      try {
        execFileSync('fuser', ['-k', '-n', 'tcp', `${port}`], { stdio: 'ignore' })
      } catch {
        try {
          const output = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          const pids = output.trim().split(/\s+/)
          for (const pid of pids) {
            if (pid && /^\d+$/.test(pid) && pid !== String(process.pid)) {
              try { process.kill(Number(pid), 'SIGKILL') } catch {}
            }
          }
        } catch {}
      }
    }
  } catch (err) {
    log(`killProcessOnPort error: ${err.message}`)
  }
}

/**
 * Strips forbidden bootstrap variables from .env files.
 * dsh-app-boot explicitly rejects DEEPSEEK_BASE_URL and other bootstrap variables in .env files.
 */
function sanitizeEnvFile(envPath) {
  if (!existsSync(envPath)) return
  try {
    const content = readFileSync(envPath, 'utf8')
    const lines = content.split(/\r?\n/)
    const forbidden = /^\s*(DEEPSEEK_BASE_URL|DEEPSEEK_SEARCH_BASE_URL|DSH_|XDG_|DYLD_|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|PYTHONPATH|SSL_CERT_)/i
    const cleanLines = lines.filter((line) => !forbidden.test(line))
    if (cleanLines.length !== lines.length) {
      log(`sanitizeEnvFile: stripping forbidden bootstrap variables from ${envPath}`)
      writeFileSync(envPath, cleanLines.join('\n') + '\n', 'utf8')
    }
  } catch (err) {
    log(`sanitizeEnvFile error: ${err.message}`)
  }
}

/**
 * 递归深度自愈与规范化 package.json 中的 main 与 exports 配置
 * 彻底消灭 Node.js ESM ERR_INVALID_PACKAGE_TARGET 崩溃隐患
 */
function sanitizePackageJsonFile(pkgFile) {
  if (!existsSync(pkgFile)) return false
  try {
    let raw = fs.readFileSync(pkgFile, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
    const pJson = JSON.parse(raw)
    let modified = false

    const normMain = (pJson.main && typeof pJson.main === 'string')
      ? (pJson.main.startsWith('./') ? pJson.main : `./${pJson.main.replace(/^(\.\/|\/)/, '')}`)
      : './index.js'
    if (pJson.main !== normMain) {
      pJson.main = normMain
      modified = true
    }

    const sanitizeTarget = (val) => {
      if (typeof val === 'string') {
        return val.startsWith('./') ? val : `./${val.replace(/^(\.\/|\/)/, '')}`
      }
      if (typeof val === 'object' && val !== null) {
        for (const sk of Object.keys(val)) {
          val[sk] = sanitizeTarget(val[sk])
        }
      }
      return val
    }

    pJson.exports = (pJson.exports && typeof pJson.exports === 'object') ? pJson.exports : {}
    for (const [k, v] of Object.entries(pJson.exports)) {
      const sanitized = sanitizeTarget(v)
      if (sanitized !== v) {
        pJson.exports[k] = sanitized
        modified = true
      }
    }

    if (!pJson.exports['.'] || !pJson.exports['.'].startsWith('./')) {
      pJson.exports['.'] = normMain
      modified = true
    }

    if (!pJson.exports['./package.json']) {
      pJson.exports['./package.json'] = './package.json'
      modified = true
    }

    if (!pJson.exports['./cordis.patch.yml']) {
      pJson.exports['./cordis.patch.yml'] = './cordis.patch.yml'
      modified = true
    }

    if (pJson.dsh && pJson.dsh.bundle && !pJson.name?.startsWith('@deepseek-ai/')) {
      delete pJson.dsh.bundle
      modified = true
    }

    if (modified) {
      fs.writeFileSync(pkgFile, JSON.stringify(pJson, null, 2) + '\n', 'utf8')
      log(`cleanLegacyState: sanitized package.json exports in ${pkgFile}`)
    }
    return modified
  } catch (err) {
    return false
  }
}

function scanAndSanitizeDir(dir, depth = 0) {
  if (depth > 5 || !existsSync(dir)) return
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        const pkgFile = path.join(full, 'package.json')
        if (existsSync(pkgFile)) {
          sanitizePackageJsonFile(pkgFile)
        }
        if (ent.name.startsWith('@') || ent.name === 'node_modules') {
          scanAndSanitizeDir(full, depth + 1)
        }
      }
    }
  } catch {}
}

/**
 * Self-healing cleanup of stale locks, legacy plugins, and corrupted configurations in ~/.dsh.
 * Deep Clean-Slate: Automatically purges all messy legacy plugins, broken profiles, and obsolete configs,
 * while 100% preserving user chat sessions and API credentials.
 */
function cleanLegacyState() {
  try {
    const dshHome = getDshHome()
    mkdirSync(dshHome, { recursive: true })

    // Purge forbidden bootstrap variables from all .env files
    sanitizeEnvFile(path.join(dshHome, '.env'))
    sanitizeEnvFile(path.join(process.cwd(), '.env'))

    // Purge any stale protocol intent file on cold boot
    const intentFile = path.join(dshHome, '.dsh-protocol-intent')
    if (existsSync(intentFile)) {
      try { rmSync(intentFile, { force: true }) } catch {}
    }

    // 1. Always remove any abandoned .lock files that block boot
    try {
      const dshFiles = fs.readdirSync(dshHome)
      for (const f of dshFiles) {
        if (f.endsWith('.lock')) {
          try { rmSync(path.join(dshHome, f), { force: true }) } catch {}
          log(`cleanLegacyState: removed stale lock ${f}`)
        }
      }
    } catch {}

    const profilesDir = path.join(dshHome, 'profiles')
    if (existsSync(profilesDir)) {
      const lockFile = path.join(profilesDir, 'node_modules.lock')
      if (existsSync(lockFile)) {
        try { rmSync(lockFile, { force: true }) } catch {}
      }

      // Self-healing: Always guarantee profiles/*/package.json bundles strictly contain base framework bundles only
      try {
        const entries = fs.readdirSync(profilesDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== 'node_modules') {
            const pPkgPath = path.join(profilesDir, entry.name, 'package.json')
            if (existsSync(pPkgPath)) {
              try {
                let content = fs.readFileSync(pPkgPath, 'utf8')
                if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
                const pkg = JSON.parse(content)
                if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
                  const baseBundles = [
                    '@deepseek-ai/dsh-base',
                    '@deepseek-ai/dsh-web-app',
                    '@deepseek-ai/dsh-experimental-agent-team-profile',
                    '@deepseek-ai/dsh-experimental-agent-team-web-profile',
                  ]
                  const currentBundles = pkg.dsh.profile.bundles
                  const missingBase = baseBundles.filter(b => !currentBundles.includes(b))
                  if (missingBase.length > 0) {
                    pkg.dsh.profile.bundles = Array.from(new Set([...baseBundles, ...currentBundles]))
                    fs.writeFileSync(pPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
                    log(`cleanLegacyState: ensured base bundles in ${pPkgPath}`)
                  }
                }
              } catch {}
            }

            // Deduplicate profile cordis.patch.yml entries and strip stray [] causing YAMLException
            const pPatchPath = path.join(profilesDir, entry.name, 'cordis.patch.yml')
            if (existsSync(pPatchPath)) {
              try {
                let rawPatch = fs.readFileSync(pPatchPath, 'utf8')
                if (rawPatch.charCodeAt(0) === 0xFEFF) rawPatch = rawPatch.slice(1)
                // Strip stray [] lines (fixes YAMLException: end of the stream or a document separator is expected)
                if (/^\s*\[\]\s*$/m.test(rawPatch)) {
                  rawPatch = rawPatch.replace(/^\s*\[\]\s*$/gm, '').trim()
                }
                const seenIds = new Set()
                const lines = rawPatch.split(/\r?\n/)
                let hasDups = false
                for (const line of lines) {
                  const m = line.match(/^\s*-\s*id:\s*~?([a-zA-Z0-9_-]+)/)
                  if (m) {
                    if (seenIds.has(m[1])) {
                      hasDups = true
                      break
                    }
                    seenIds.add(m[1])
                  }
                }
                // Prune duplicates and missing plugins from cordis.patch.yml
                const cleanedBlocks = []
                const blockRegex = /-\s*insert:[\s\S]*?(?=(\n-\s*insert:|$))/g
                let bMatch
                const keptPluginIds = new Set()
                while ((bMatch = blockRegex.exec(rawPatch)) !== null) {
                  const block = bMatch[0]
                  const idMatch = block.match(/id:\s*~?([a-zA-Z0-9_-]+)/)
                  if (idMatch) {
                    const pid = idMatch[1]
                    // 内置框架包（液态玻璃主题与插件市场）已由 @deepseek-ai/dsh-web-app 底层内置挂载
                    // 严禁写入 profile 的 cordis.patch.yml，否则 Cordis 启动必报 duplicate loader entry id 崩溃
                    if (pid === 'dsh-theme' || pid === 'stream-market' || pid === 'dsh-stream-market' || pid === 'deepseek-ai-cordis' || pid === 'ui-liquid-glass' || pid === 'dsh-client-ui-liquid-glass' || pid === '@deepseek-ai/dsh-client-ui-liquid-glass') {
                      log(`cleanLegacyState: pruned builtin ${pid} from ${pPatchPath} to prevent duplicate entry crash`)
                      continue
                    }
                    const existsInProfile = fs.existsSync(path.join(profilesDir, entry.name, 'node_modules', pid))
                    const existsInPlugins = fs.existsSync(path.join(dshHome, 'plugins', pid))
                    const isInternal = pid.startsWith('@deepseek-ai/') || pid === 'cordis' ||
                      pid === 'dsh-external-dsh-graded-mode'
                    if (!existsInProfile && !existsInPlugins && !isInternal) {
                      log(`cleanLegacyState: pruned missing plugin ${pid} from ${pPatchPath}`)
                      continue
                    }
                    if (!keptPluginIds.has(pid)) {
                      keptPluginIds.add(pid)
                      cleanedBlocks.push(block.trim())
                    }
                  } else {
                    cleanedBlocks.push(block.trim())
                  }
                }
                rawPatch = cleanedBlocks.length > 0 ? cleanedBlocks.join('\n\n') : '[]'
                fs.writeFileSync(pPatchPath, (rawPatch.length > 0 ? rawPatch.trim() : '[]') + '\n', 'utf8')
                log(`cleanLegacyState: verified and healed YAML in ${pPatchPath}`)
              } catch {}
            }
          }
        }
      } catch {}
    }

    // 2. Self-healing: Strip duplicate plugin entries from ~/.dsh/cordis.patch.yml (prevents duplicate loader entry id)
    const homePatch = path.join(dshHome, 'cordis.patch.yml')
    if (existsSync(homePatch)) {
      try {
        let raw = fs.readFileSync(homePatch, 'utf8')
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
        if (raw.includes('insert:') || raw.includes('dsh-')) {
          const cleaned = raw.replace(/- insert:[\s\S]*?(?=(\n- |$))/g, '').replace(/^\s*\[\]\s*$/gm, '').trim()
          if (cleaned.length === 0 || cleaned === '[]') {
            try { rmSync(homePatch, { force: true }) } catch {}
          } else {
            fs.writeFileSync(homePatch, cleaned + '\n', 'utf8')
          }
          log('cleanLegacyState: removed conflicting plugin inserts from ~/.dsh/cordis.patch.yml')
        }
      } catch {}
    }

    // 3. Self-healing: Ensure every installed plugin in ~/.dsh/plugins exports "./client" and registers __ModuleLoader__
    const pluginsDir = path.join(dshHome, 'plugins')
    if (existsSync(pluginsDir)) {
      try {
        const pEntries = fs.readdirSync(pluginsDir, { withFileTypes: true })
        for (const pe of pEntries) {
          if (pe.isDirectory()) {
            const pDir = path.join(pluginsDir, pe.name)
            const pkgFile = path.join(pDir, 'package.json')
            if (existsSync(pkgFile)) {
              try {
                let raw = fs.readFileSync(pkgFile, 'utf8')
                if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
                const pJson = JSON.parse(raw)
                let modified = false

                const libClient = path.join(pDir, 'lib', 'client.js')
                const rootClient = path.join(pDir, 'client.js')

                // 1. 若 lib/client.js 存在且 rootClient 不存在或仅为代理，优先同步编译后的完整 lib/client.js
                if (existsSync(libClient)) {
                  try {
                    const libCode = fs.readFileSync(libClient, 'utf8')
                    if (existsSync(rootClient)) {
                      const rootCode = fs.readFileSync(rootClient, 'utf8')
                      if (rootCode.includes('./lib/client.js') || (libCode.includes('__ModuleLoader__') && !rootCode.includes('__ModuleLoader__'))) {
                        fs.copyFileSync(libClient, rootClient)
                        log(`cleanLegacyState: synced lib/client.js to client.js for ${pe.name}`)
                      }
                    } else {
                      fs.copyFileSync(libClient, rootClient)
                      log(`cleanLegacyState: created client.js from lib/client.js for ${pe.name}`)
                    }
                  } catch {}
                }
                const clientClient = path.join(pDir, 'client', 'client.js')
                if (existsSync(clientClient)) {
                  try {
                    if (existsSync(rootClient)) {
                      const rootCode = fs.readFileSync(rootClient, 'utf8')
                      if (rootCode.includes('[AI Client Scope Sandbox]') && rootCode.indexOf('[AI Client Scope Sandbox]') !== rootCode.lastIndexOf('[AI Client Scope Sandbox]')) {
                        fs.copyFileSync(clientClient, rootClient)
                        log(`cleanLegacyState: recovered corrupted client.js from client/client.js for ${pe.name}`)
                      }
                    } else {
                      fs.copyFileSync(clientClient, rootClient)
                    }
                  } catch {}
                }

                const hasClientFile = existsSync(rootClient) || existsSync(libClient)
                const clientRel = existsSync(rootClient) ? './client.js' : './lib/client.js'

                if (hasClientFile) {
                  const clientFullPath = path.join(pDir, clientRel)
                  try {
                    let clientCode = fs.readFileSync(clientFullPath, 'utf8')
                    if (clientCode.charCodeAt(0) === 0xFEFF) clientCode = clientCode.slice(1)
                    if (!clientCode.includes('__ModuleLoader__') && !clientCode.includes('[AI Client Scope Sandbox]')) {
                      clientCode = clientCode.replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
                      clientCode = `/**\n * ${pe.name} Client Module (Auto-wrapped for Cordis __ModuleLoader__)\n */\nwindow.__ModuleLoader__.load({\n  id: ${JSON.stringify(pe.name)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n    try {\n${clientCode}\n    } catch (e) {\n      console.warn("[${pe.name}] client module execution warning:", e);\n    }\n    exports.apply = exports.apply || function() {};\n    return module.exports;\n  }\n});\n`
                      clientCode = `/* [AI Client Scope Sandbox] ${pe.name} */\n(() => {\n  try {\n${clientCode}\n  } catch (err) {\n    console.warn('[AI Client Sandbox] ${pe.name} runtime error:', err);\n  }\n})();\n`
                      fs.writeFileSync(clientFullPath, clientCode, 'utf8')
                      log(`cleanLegacyState: sandboxed client script for ${pe.name} in isolated IIFE`)
                    }

                    // 同步到各 Profile 下的 node_modules
                    for (const prof of ['web', 'desktop', 'default']) {
                      const profPluginDir = path.join(dshHome, 'profiles', prof, 'node_modules', pe.name)
                      if (existsSync(profPluginDir)) {
                        const profClientPath = path.join(profPluginDir, clientRel)
                        fs.mkdirSync(path.dirname(profClientPath), { recursive: true })
                        fs.copyFileSync(clientFullPath, profClientPath)
                      }
                    }
                  } catch {}

                  const serviceMjs = path.join(pDir, 'lib', 'service.mjs')
                  if (existsSync(serviceMjs)) {
                    try {
                      let sCode = fs.readFileSync(serviceMjs, 'utf8')
                      if (sCode.includes("err?.code !== 'EADDRINUSE'") && !sCode.includes('EACCES')) {
                        sCode = sCode.replace("if (err?.code !== 'EADDRINUSE') throw err;", "if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;");
                        fs.writeFileSync(serviceMjs, sCode, 'utf8')
                        for (const prof of ['web', 'desktop', 'default']) {
                          const profS = path.join(dshHome, 'profiles', prof, 'node_modules', pe.name, 'lib', 'service.mjs')
                          if (existsSync(path.dirname(profS))) {
                            fs.writeFileSync(profS, sCode, 'utf8')
                          }
                        }
                        log(`cleanLegacyState: patched EACCES fallback into ${pe.name}/lib/service.mjs`)
                      }
                    } catch {}
                  }

                  pJson.dsh = pJson.dsh || {}
                  if (!pJson.dsh.client) {
                    pJson.dsh.client = { platform: 'web' }
                    modified = true
                  }

                  const normMain = (pJson.main && pJson.main.startsWith('./'))
                    ? pJson.main
                    : (pJson.main ? `./${pJson.main.replace(/^(\.\/|\/)/, '')}` : './index.js')
                  if (pJson.main !== normMain) {
                    pJson.main = normMain
                    modified = true
                  }

                  pJson.exports = (pJson.exports && typeof pJson.exports === 'object') ? pJson.exports : {}

                  // 严格规范化所有 exports 路径，必须以 ./ 开头，彻底根绝 Node ESM ERR_INVALID_PACKAGE_TARGET 崩溃
                  const sanitizeExportTarget = (val) => {
                    if (typeof val === 'string') {
                      return val.startsWith('./') ? val : `./${val.replace(/^(\.\/|\/)/, '')}`
                    }
                    if (typeof val === 'object' && val !== null) {
                      for (const sk of Object.keys(val)) {
                        val[sk] = sanitizeExportTarget(val[sk])
                      }
                    }
                    return val
                  }

                  for (const [k, v] of Object.entries(pJson.exports)) {
                    const sanitized = sanitizeExportTarget(v)
                    if (sanitized !== v) {
                      pJson.exports[k] = sanitized
                      modified = true
                    }
                  }

                  if (!pJson.exports['.']) {
                    pJson.exports['.'] = normMain
                    modified = true
                  } else if (typeof pJson.exports['.'] === 'string' && !pJson.exports['.'].startsWith('./')) {
                    pJson.exports['.'] = `./${pJson.exports['.'].replace(/^(\.\/|\/)/, '')}`
                    modified = true
                  }

                  const normClient = clientRel.startsWith('./') ? clientRel : `./${clientRel.replace(/^(\.\/|\/)/, '')}`
                  if (pJson.exports['./client'] !== normClient) {
                    pJson.exports['./client'] = normClient
                    modified = true
                  }
                  if (!pJson.exports['./cordis.patch.yml']) {
                    pJson.exports['./cordis.patch.yml'] = './cordis.patch.yml'
                    modified = true
                  }
                  if (!pJson.exports['./package.json']) {
                    pJson.exports['./package.json'] = './package.json'
                    modified = true
                  }
                } else {
                  const normMain = (pJson.main && pJson.main.startsWith('./'))
                    ? pJson.main
                    : (pJson.main ? `./${pJson.main.replace(/^(\.\/|\/)/, '')}` : './index.js')
                  if (pJson.main !== normMain) {
                    pJson.main = normMain
                    modified = true
                  }
                  if (pJson.exports && typeof pJson.exports === 'object') {
                    for (const [k, v] of Object.entries(pJson.exports)) {
                      if (typeof v === 'string' && !v.startsWith('./')) {
                        pJson.exports[k] = `./${v.replace(/^(\.\/|\/)/, '')}`
                        modified = true
                      } else if (typeof v === 'object' && v !== null) {
                        for (const sk of Object.keys(v)) {
                          if (typeof v[sk] === 'string' && !v[sk].startsWith('./')) {
                            v[sk] = `./${v[sk].replace(/^(\.\/|\/)/, '')}`
                            modified = true
                          }
                        }
                      }
                    }
                    if (!pJson.exports['.']) {
                      pJson.exports['.'] = normMain
                      modified = true
                    } else if (typeof pJson.exports['.'] === 'string' && !pJson.exports['.'].startsWith('./')) {
                      pJson.exports['.'] = `./${pJson.exports['.'].replace(/^(\.\/|\/)/, '')}`
                      modified = true
                    }
                    if (pJson.exports['./client']) {
                      delete pJson.exports['./client']
                      modified = true
                    }
                  }
                  if (pJson.dsh && pJson.dsh.client) {
                    delete pJson.dsh.client
                    modified = true
                  }
                }

                // 彻底清除第三方插件中的 dsh.bundle 声明，杜绝 DSH 自动提升为 bundles 层产生 duplicate loader entry 崩溃
                if (pJson.dsh && pJson.dsh.bundle) {
                  delete pJson.dsh.bundle
                  modified = true
                }

                if (modified) {
                  fs.writeFileSync(pkgFile, JSON.stringify(pJson, null, 2) + '\n', 'utf8')
                  log(`cleanLegacyState: healed plugin exports and dsh.client for ${pe.name}`)
                  for (const prof of ['web', 'desktop', 'default']) {
                    const profPluginPkg = path.join(dshHome, 'profiles', prof, 'node_modules', pe.name, 'package.json')
                    if (existsSync(profPluginPkg)) {
                      try { fs.writeFileSync(profPluginPkg, JSON.stringify(pJson, null, 2) + '\n', 'utf8') } catch {}
                    }
                  }
                }

                // AI Code Armor: 对插件源码注入防崩溃与未决调用熔断保护
                armorPluginCode(pDir, pe.name)
              } catch (e) {
                log(`cleanLegacyState: error inspecting plugin ${pe.name}: ${e.message}`)
              }
            }
          }
        }
      } catch {}
    }

    // 2. Comprehensive 0.1.3 Clean-Slate: Wipes legacy plugins, broken profiles, and old configs
    const cleanSlateFlag = path.join(dshHome, '.dsh-v013-final-clean-slate')
    if (!existsSync(cleanSlateFlag)) {
      log('cleanLegacyState: executing full 0.1.3 clean-slate purge...')

      // A. Purge plugins directory
      const pluginsDir = path.join(dshHome, 'plugins')
      if (existsSync(pluginsDir)) {
        try { rmSync(pluginsDir, { recursive: true, force: true }) } catch {}
      }

      // B. Purge profiles directory
      if (existsSync(profilesDir)) {
        try { rmSync(profilesDir, { recursive: true, force: true }) } catch {}
      }

      // C. Purge ~/.dsh/node_modules
      const nmDir = path.join(dshHome, 'node_modules')
      if (existsSync(nmDir)) {
        try { rmSync(nmDir, { recursive: true, force: true }) } catch {}
      }

      // D. Purge settings.yaml, storages, scripts, cache
      const settingsYaml = path.join(dshHome, 'settings.yaml')
      if (existsSync(settingsYaml)) {
        try { rmSync(settingsYaml, { force: true }) } catch {}
      }

      const oldPatch = path.join(dshHome, 'cordis.patch.yml')
      if (existsSync(oldPatch)) {
        try { rmSync(oldPatch, { force: true }) } catch {}
      }

      for (const sub of ['storages', 'scripts', 'cache', 'temp']) {
        const p = path.join(dshHome, sub)
        if (existsSync(p)) {
          try { rmSync(p, { recursive: true, force: true }) } catch {}
        }
      }

      // Sessions (chat history) & credentials are 100% untouched and preserved
      writeFileSync(cleanSlateFlag, '0.1.3-clean-slate\n', 'utf8')
      log('cleanLegacyState: clean-slate finished. Sessions and credentials safely preserved.')
    }

    // 全方位扫描并自愈所有 profile、plugins 与 node_modules 下的 package.json
    const scanDirs = [
      path.join(dshHome, 'plugins'),
      path.join(dshHome, 'profiles', 'web', 'node_modules'),
      path.join(dshHome, 'profiles', 'default', 'node_modules'),
      path.join(dshHome, 'profiles', 'desktop', 'node_modules'),
      path.join(dshHome, 'profiles', 'node_modules'),
      path.join(dshHome, 'node_modules')
    ]
    for (const sDir of scanDirs) {
      scanAndSanitizeDir(sDir)
    }

    // 清理旧版 deepseek-ai-cordis 主题插件，由新的液态玻璃与动态壁纸套件全新接管
    try {
      const oldThemePlugin = path.join(dshHome, 'plugins', 'deepseek-ai-cordis')
      if (existsSync(oldThemePlugin)) rmSync(oldThemePlugin, { recursive: true, force: true })
      for (const p of ['web', 'default', 'desktop']) {
        const oldNm = path.join(dshHome, 'profiles', p, 'node_modules', 'deepseek-ai-cordis')
        if (existsSync(oldNm)) {
          try {
            if (process.platform === 'win32') execFileSync('cmd.exe', ['/c', 'rmdir', oldNm], { stdio: 'ignore' })
            else rmSync(oldNm, { recursive: true, force: true })
          } catch {
            try { rmSync(oldNm, { recursive: true, force: true }) } catch {}
          }
        }
      }
    } catch {}

    ensureUltraExtensions(dshHome)
  } catch (err) {
    log(`cleanLegacyState error: ${err.message}`)
  }
}

/**
 * 确保 DeepSeek Harness 0.1.6 Max 核心生态扩展（插件市场 + 主题皮肤套件）
 * 100% 自动装配、自动修复软链、自动写入 cordis.patch.yml。
 */
function ensureUltraExtensions(dshHome) {
  try {
    const runtimeModulesCandidates = [
      path.join(__dirname, 'runtime', 'node_modules'),
      path.join(process.resourcesPath || '', 'runtime', 'node_modules'),
      path.join(process.resourcesPath || '', '..', 'runtime', 'node_modules'),
      path.join(process.cwd(), 'runtime', 'node_modules'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'node_modules'),
    ]
    let runtimeModules = null
    for (const r of runtimeModulesCandidates) {
      if (r && existsSync(r)) {
        runtimeModules = r
        break
      }
    }

    const pluginsDir = path.join(dshHome, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })

    const ultraPlugins = [
      { id: 'dsh-stream-market', patchId: 'dsh-stream-market', patchName: 'dsh-stream-market', aliases: ['stream-market'] },
      { id: '@deepseek-ai/dsh-client-ui-liquid-glass', patchId: 'ui-liquid-glass', patchName: '@deepseek-ai/dsh-client-ui-liquid-glass', aliases: ['dsh-theme', 'ui-liquid-glass', 'dsh-client-ui-liquid-glass'] }
    ]

    for (const item of ultraPlugins) {
      const targetDir = path.join(pluginsDir, item.id)
      if (runtimeModules) {
        const sourceDir = path.join(runtimeModules, item.id)
        if (existsSync(sourceDir)) {
          try {
            mkdirSync(path.dirname(targetDir), { recursive: true })
            if (!existsSync(targetDir)) {
              fs.cpSync(sourceDir, targetDir, { recursive: true })
              log(`ensureUltraExtensions: seeded ${item.id} from runtime to ~/.dsh/plugins`)
            } else {
              fs.cpSync(sourceDir, targetDir, { recursive: true })
              log(`ensureUltraExtensions: updated ${item.id} from runtime to ~/.dsh/plugins`)
            }
          } catch (e) {
            log(`ensureUltraExtensions error seeding/updating ${item.id}: ${e.message}`)
          }
        }
      }
    }

    const profilesDir = path.join(dshHome, 'profiles')
    if (existsSync(profilesDir)) {
      const profEntries = fs.readdirSync(profilesDir, { withFileTypes: true })
      for (const pe of profEntries) {
        if (pe.isDirectory() && pe.name !== 'node_modules') {
          const nmDir = path.join(profilesDir, pe.name, 'node_modules')
          mkdirSync(nmDir, { recursive: true })

          for (const item of ultraPlugins) {
            const targetDir = path.join(pluginsDir, item.id)
            if (existsSync(targetDir)) {
              // Ensure primary junction
              const pNm = path.join(nmDir, item.id)
              mkdirSync(path.dirname(pNm), { recursive: true })
              if (!existsSync(pNm)) {
                try {
                  fs.symlinkSync(targetDir, pNm, 'junction')
                  log(`ensureUltraExtensions: created junction ${item.id} in profile ${pe.name}`)
                } catch {}
              }
              // Ensure alias junctions
              for (const alias of item.aliases) {
                const aNm = path.join(nmDir, alias)
                mkdirSync(path.dirname(aNm), { recursive: true })
                if (!existsSync(aNm)) {
                  try {
                    fs.symlinkSync(targetDir, aNm, 'junction')
                    log(`ensureUltraExtensions: created alias junction ${alias} in profile ${pe.name}`)
                  } catch {}
                }
              }
            }
          }

          // 关键防护：主题皮肤与插件市场已作为官方核心组件内置于 @deepseek-ai/dsh-web-app 的 cordis.patch.yml 中。
          // 严禁向各个 Profile 的 cordis.patch.yml 再次追加挂载，若存在历史遗留条目必须坚决剔除，彻底杜绝 duplicate loader entry id 崩溃！
          const patchPath = path.join(profilesDir, pe.name, 'cordis.patch.yml')
          if (existsSync(patchPath)) {
            try {
              let patchContent = fs.readFileSync(patchPath, 'utf8')
              if (patchContent.charCodeAt(0) === 0xFEFF) patchContent = patchContent.slice(1)
              const conflictIds = ['dsh-theme', 'stream-market', 'dsh-stream-market', 'deepseek-ai-cordis', 'ui-liquid-glass', 'dsh-client-ui-liquid-glass', '@deepseek-ai/dsh-client-ui-liquid-glass']
              let hasConflict = conflictIds.some(cid => patchContent.includes(cid))
              if (hasConflict) {
                const blockRegex = /-\s*insert:[\s\S]*?(?=(\n-\s*insert:|$))/g
                let bMatch
                const keptBlocks = []
                while ((bMatch = blockRegex.exec(patchContent)) !== null) {
                  const block = bMatch[0]
                  const idMatch = block.match(/id:\s*~?([a-zA-Z0-9_-]+)/)
                  if (idMatch && conflictIds.includes(idMatch[1])) {
                    log(`ensureUltraExtensions: safely pruned builtin ${idMatch[1]} from ${pe.name}/cordis.patch.yml`)
                    continue
                  }
                  keptBlocks.push(block.trim())
                }
                const cleaned = keptBlocks.length > 0 ? keptBlocks.join('\n\n') : '[]'
                fs.writeFileSync(patchPath, cleaned.trim() + '\n', 'utf8')
                log(`ensureUltraExtensions: cleaned conflict entries from ${pe.name}/cordis.patch.yml`)
              }
            } catch (pErr) {
              log(`ensureUltraExtensions patch cleanup error: ${pErr.message}`)
            }
          }
        }
      }
    }
  } catch (err) {
    log(`ensureUltraExtensions error: ${err.message}`)
  }
}


function bundledBackend() {
  const candidateDirs = [
    process.resourcesPath,
    path.resolve(__dirname, '..'),
    path.join(path.dirname(process.execPath), 'resources'),
    path.join(process.cwd(), 'resources'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek', 'DeepSeek Harness', 'resources'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek-Harness', 'resources'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'resources'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'DeepSeek Harness', 'resources'),
    path.dirname(process.execPath),
    process.cwd(),
  ]

  for (const dir of candidateDirs) {
    if (!dir) continue

    const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node'
    const candidateNodes = [
      path.join(dir, 'node', nodeBin),
      path.join(dir, 'node', 'node'),
      path.join(dir, 'node', 'node.exe'),
      path.join(dir, '..', 'node', nodeBin),
      path.join(process.resourcesPath || '', 'node', nodeBin),
      path.join(process.resourcesPath || '', 'node', 'node'),
      path.join(process.resourcesPath || '', 'node', 'node.exe'),
      process.env.DSH_DESKTOP_NODE || '',
      '/usr/bin/node',
      '/usr/local/bin/node',
      'node',
    ]

    const candidateEntries = [
      path.join(dir, 'runtime', 'lib', 'bin.js'),
      path.join(dir, 'lib', 'bin.js'),
      path.join(dir, '..', 'runtime', 'lib', 'bin.js'),
      path.join(process.resourcesPath || '', 'runtime', 'lib', 'bin.js'),
    ]

    for (const nodePath of candidateNodes) {
      if (!nodePath) continue
      let isNodeValid = nodePath === 'node' || existsSync(nodePath)
      if (isNodeValid && process.platform !== 'win32' && nodePath !== 'node') {
        try {
          fs.chmodSync(nodePath, 0o755)
        } catch {}
      }
      if (!isNodeValid) continue

      for (const entry of candidateEntries) {
        if (existsSync(entry)) {
          const cwd = path.dirname(path.dirname(entry))
          log(`bundledBackend resolved target: node=${nodePath} entry=${entry} cwd=${cwd}`)
          return { node: nodePath, entry, cwd }
        }
      }
    }
  }
  return null
}

function devBackend() {
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node'
  let localNode = path.join(__dirname, 'node', nodeBin)
  if (!existsSync(localNode)) {
    if (existsSync(path.join(__dirname, 'node', 'node'))) {
      localNode = path.join(__dirname, 'node', 'node')
    } else if (existsSync(path.join(__dirname, 'node', 'node.exe'))) {
      localNode = path.join(__dirname, 'node', 'node.exe')
    }
  }
  if (process.platform !== 'win32' && existsSync(localNode)) {
    try { fs.chmodSync(localNode, 0o755) } catch {}
  }
  const localEntry = path.join(__dirname, 'runtime', 'lib', 'bin.js')
  if (existsSync(localNode) && existsSync(localEntry)) {
    return { node: localNode, entry: localEntry, cwd: path.join(__dirname, 'runtime') }
  }
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

function formatDetailLog(text) {
  if (!text) return ''
  const trimmed = text.trim()
  if (trimmed.length <= 1800) return trimmed
  return trimmed.slice(0, 900) + '\n\n... [中间系统日志已省略] ...\n\n' + trimmed.slice(-900)
}

function showFatal(title, detail) {
  dialog.showErrorBox(title, detail)
  app.quit()
}

let startupFailCount = 0

async function startBackend(target) {
  intentionalStop = false
  detectedAuthUrl = null
  isAuthLoaded = false
  lastStderr = ''
  lastStdout = ''

  cleanLegacyState()
  await killProcessOnPort(DEFAULT_PORT)
  await killProcessOnPort(18899)

  // Dynamically resolve port: try DEFAULT_PORT first; if busy or blocked by Windows, auto-assign free port!
  const chosenPort = await getAvailablePort(DEFAULT_PORT)
  log(`startBackend: node=${target.node} entry=${target.entry} port=${chosenPort}`)

  const runtimeModules = path.join(target.cwd, 'node_modules')
  const { apiKey, baseUrl } = readConfig()

  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: apiKey || process.env.DEEPSEEK_API_KEY || '',
    DEEPSEEK_BASE_URL: baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    NODE_PATH: runtimeModules + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''),
    DSH_HOME: getDshHome(),
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_MARKET_PORT: '18899',
  }

  const nodeArgs = ['--expose-internals', target.entry, 'web', '--no-open', '--port', String(chosenPort)]
  backend = spawn(target.node, nodeArgs, {
    cwd: target.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  })

  function handleData(chunk, isErr = false) {
    const text = chunk.toString('utf8')
    if (isErr) {
      lastStderr += text
      if (lastStderr.length > 8000) lastStderr = lastStderr.slice(-8000)
      log(`[backend stderr] ${text.trim()}`)
    } else {
      lastStdout += text
      if (lastStdout.length > 8000) lastStdout = lastStdout.slice(-8000)
      log(`[backend stdout] ${text.trim()}`)
    }

    const match = /(https?:\/\/127\.0\.0\.1:\d+[^\s)]*)/.exec(text)
    if (match) {
      const url = match[1]
      if (!detectedAuthUrl) {
        detectedAuthUrl = url
        startupFailCount = 0
        log(`Captured detectedAuthUrl: ${detectedAuthUrl}`)
      }
      loadAuthenticatedUrl(url)
    }
  }

  backend.stdout.on('data', (chunk) => handleData(chunk, false))
  backend.stderr.on('data', (chunk) => handleData(chunk, true))

  backend.on('exit', async (code, signal) => {
    const isExpected = intentionalStop || app.isQuitting
    log(`backend exit: code=${code} signal=${signal} isExpected=${isExpected}`)
    backend = null
    if (!isExpected) {
      if (!detectedAuthUrl && startupFailCount < 5) {
        startupFailCount++
        const errLog = (lastStderr || '') + '\n' + (lastStdout || '')
        log(`backend early exit during startup (exit code ${code}, attempt ${startupFailCount}). Checking for auto-recoverable errors...`)

        // 核心自愈：若发生端口竞争 (EADDRINUSE 18899 / 3080)，自动查杀占用源并平滑重试，绝不弹窗报错吓退用户
        if (errLog.includes('EADDRINUSE') || errLog.includes('address already in use')) {
          log(`[Auto-Heal] Detected EADDRINUSE on startup. Forcefully reclaiming ports 18899 and ${DEFAULT_PORT}...`)
          await killProcessOnPort(18899)
          await killProcessOnPort(DEFAULT_PORT)
          setTimeout(() => {
            startBackend(target)
          }, 1200)
          return
        }

        if (errLog.includes('ERR_INVALID_PACKAGE_TARGET') ||
            errLog.includes('plugin tree failed to load') ||
            errLog.includes('failed to import loader entry') ||
            errLog.includes('YAMLException')) {
          log('Auto-healing detected plugin startup error...')
          const m = /failed to import loader entry\s+([@a-zA-Z0-9_-]+)/i.exec(errLog) ||
                    /Invalid "exports" main target.*?[\\\/]node_modules[\\\/]([@a-zA-Z0-9_-]+)/i.exec(errLog)
          if (m && m[1]) {
            const badId = m[1]
            log(`Quarantining broken plugin from cordis.patch.yml: ${badId}`)
            for (const prof of ['web', 'default', 'desktop']) {
              const pf = path.join(getDshHome(), 'profiles', prof, 'cordis.patch.yml')
              if (existsSync(pf)) {
                try {
                  let txt = fs.readFileSync(pf, 'utf8')
                  const reg = new RegExp(`-\\s*insert:[\\s\\S]*?id:\\s*~?${badId}[\\s\\S]*?(?=(\\n-\\s*insert:|$))`, 'g')
                  txt = txt.replace(reg, '').trim()
                  fs.writeFileSync(pf, (txt.length > 0 ? txt : '[]') + '\n', 'utf8')
                } catch {}
              }
            }
          }
          cleanLegacyState()
          log('Retrying startBackend in auto-healed safe mode...')
          setTimeout(() => {
            startBackend(target)
          }, 800)
          return
        }
      }
      const detail = formatDetailLog(lastStderr || lastStdout || '')
      showFatal('DeepSeek Harness 服务已退出', `后端服务意外停止（退出码 ${code}）。\n\n${detail ? '最新日志：\n' + detail : ''}`)
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
      } else if (pid) {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          try { process.kill(pid, 'SIGTERM') } catch {}
        }
      }
      backend.kill('SIGTERM')
    } catch {}
    backend = null
  }
}

function waitForAuthUrl(timeoutMs = 60000, onTick) {
  if (detectedAuthUrl) return Promise.resolve(detectedAuthUrl)
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const deadline = startTime + timeoutMs
    const interval = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startTime) / 1000)
      onTick?.(elapsedSec)

      if (detectedAuthUrl) {
        clearInterval(interval)
        resolve(detectedAuthUrl)
      } else if (!backend) {
        clearInterval(interval)
        const detail = formatDetailLog(lastStderr || lastStdout || '')
        reject(new Error(`后端服务未能成功启动。${detail ? '\n\n最新日志：\n' + detail : ''}`))
      } else if (Date.now() > deadline) {
        clearInterval(interval)
        const detail = formatDetailLog(lastStderr || lastStdout || '')
        reject(new Error(`等待后端安全握手超时（已等待 ${elapsedSec} 秒）。${detail ? '\n\n最新日志：\n' + detail : ''}`))
      }
    }, 50)
  })
}

let restartDebounce = null

async function restartBackend() {
  log('restartBackend requested')
  isAuthLoaded = false
  detectedAuthUrl = null
  lastStderr = ''
  lastStdout = ''

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      var tip = document.getElementById('tip-text');
      if (tip) tip.innerText = '⚡ 正在安全释放端口并平滑重启运行时...';
    `).catch(() => {})
  }

  stopBackend()
  // 彻底释放端口 18899 与主服务端口，并等待 Windows Socket 完全关闭
  await killProcessOnPort(18899)
  await killProcessOnPort(DEFAULT_PORT)

  for (let i = 0; i < 10; i++) {
    const portBusy = await isPortListening(18899)
    if (!portBusy) break
    await killProcessOnPort(18899)
    await new Promise((r) => setTimeout(r, 200))
  }
  await new Promise((resolve) => setTimeout(resolve, 350))

  cleanLegacyState()
  const target = resolveBackend()
  if (target) {
    await startBackend(target)
    try {
      const url = await waitForAuthUrl(60000)
      startupFailCount = 0
      log(`restartBackend succeeded: ${url}`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url).catch(() => {})
      }
      if (localMarketWindow && !localMarketWindow.isDestroyed()) {
        localMarketWindow.reload()
      }
      return true
    } catch (err) {
      log(`restartBackend failed: ${err.message}`)
      return false
    }
  }
  return false
}

function watchRestartTrigger() {
  try {
    const dshDir = getDshHome()
    mkdirSync(dshDir, { recursive: true })
    const triggerFile = path.join(dshDir, '.dsh-restart-trigger')

    // File polling watcher to guarantee 100% reliable trigger detection on Windows
    let lastMtime = existsSync(triggerFile) ? fs.statSync(triggerFile).mtimeMs : 0
    setInterval(async () => {
      try {
        if (existsSync(triggerFile)) {
          const mtime = fs.statSync(triggerFile).mtimeMs
          if (mtime > lastMtime) {
            lastMtime = mtime
            if (restartDebounce) clearTimeout(restartDebounce)
            restartDebounce = setTimeout(async () => {
              log('Hot restart trigger file modified! Triggering restartBackend()...')
              await restartBackend()
            }, 150)
          }
        }
      } catch {}
    }, 300)
  } catch (err) {
    log(`watchRestartTrigger error: ${err.message}`)
  }
}

function watchProtocolIntent() {
  try {
    const dshDir = getDshHome()
    mkdirSync(dshDir, { recursive: true })
    const intentFile = path.join(dshDir, '.dsh-protocol-intent')

    // Always clear stale intent file on startup so cold boot never triggers accidental popups
    try {
      if (existsSync(intentFile)) {
        rmSync(intentFile, { force: true })
      }
    } catch {}

    // Only process intents triggered after application is fully active
    let lastProcessedTimestamp = Date.now() + 1500
    let lastMtime = 0
    setInterval(() => {
      try {
        if (existsSync(intentFile)) {
          const mtime = fs.statSync(intentFile).mtimeMs
          if (mtime >= lastMtime) {
            lastMtime = mtime
            try {
              const raw = fs.readFileSync(intentFile, 'utf8')
              const data = JSON.parse(raw)
              const ts = data.timestamp || mtime
              if (data && data.url && ts > lastProcessedTimestamp) {
                lastProcessedTimestamp = ts
                log(`watchProtocolIntent: detected intent URL: ${data.url}`)
                // Consume and remove intent file immediately
                try { rmSync(intentFile, { force: true }) } catch {}
                handleDshProtocolUrl(data.url)
              }
            } catch (err) {
              log(`watchProtocolIntent parse error: ${err.message}`)
            }
          }
        }
      } catch {}
    }, 100)
  } catch (err) {
    log(`watchProtocolIntent error: ${err.message}`)
  }
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

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]))
}

/**
 * First-Run Onboarding Wizard Modal: Prompts user to input DeepSeek API Key.
 */
function showOnboardingDialog() {
  if (onboardingDialog && !onboardingDialog.isDestroyed()) {
    onboardingDialog.focus()
    return
  }

  const { apiKey, baseUrl, aiModel } = readConfig()

  onboardingDialog = new BrowserWindow({
    width: 550,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: true,
    title: '接入 DeepSeek API - 首屏配置向导',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  const currentModel = aiModel || 'deepseek-chat'
  const isCustomModel = currentModel !== 'deepseek-chat' && currentModel !== 'deepseek-reasoner'

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>接入 DeepSeek API</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; }
    body { background: #0f172a; color: #f8fafc; padding: 28px 24px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    .logo { width: 48px; height: 48px; border-radius: 14px; background: linear-gradient(135deg, #0ea5e9, #2563eb); display: flex; align-items: center; justify-content: center; font-size: 26px; box-shadow: 0 4px 16px rgba(14, 165, 233, 0.35); }
    .title { font-size: 20px; font-weight: 700; color: #f1f5f9; }
    .subtitle { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 14px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .label { font-size: 13px; font-weight: 600; color: #cbd5e1; display: flex; justify-content: space-between; align-items: center; }
    .label a { color: #38bdf8; text-decoration: none; font-size: 12px; }
    .label a:hover { text-decoration: underline; }
    .input-box { background: #0f172a; border: 1px solid #475569; border-radius: 8px; padding: 10px 12px; color: #f8fafc; font-size: 13px; font-family: monospace; outline: none; transition: all 0.2s; }
    .input-box:focus { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2); }
    .tip-box { background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 10px; padding: 12px; font-size: 12px; color: #bae6fd; line-height: 1.5; }
    .status { font-size: 13px; text-align: center; min-height: 22px; font-weight: 500; margin-top: auto; }
    .actions { display: flex; gap: 12px; margin-top: 16px; }
    button { flex: 1; padding: 12px 16px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-test { background: #334155; color: #cbd5e1; }
    .btn-test:hover { background: #475569; color: #fff; }
    .btn-submit { background: #0284c7; color: #ffffff; }
    .btn-submit:hover { background: #0369a1; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🚀</div>
    <div>
      <div class="title">欢迎使用 DeepSeek Harness</div>
      <div class="subtitle">请先接入 DeepSeek API 激活智能体全套能力</div>
    </div>
  </div>

  <div class="card">
    <div class="form-group">
      <div class="label">
        <span>DeepSeek API Key <span style="color:#f43f5e">*</span></span>
        <a href="https://platform.deepseek.com/api_keys" target="_blank" id="link-get-key">获取 API Key &rarr;</a>
      </div>
      <input type="password" id="input-key" class="input-box" placeholder="sk-..." value="${escapeHtml(apiKey || '')}" />
    </div>

    <div class="form-group">
      <div class="label"><span>API 服务地址 (Base URL)</span></div>
      <input type="text" id="input-url" class="input-box" placeholder="https://api.deepseek.com" value="${escapeHtml(baseUrl || 'https://api.deepseek.com')}" />
    </div>

    <div class="form-group">
      <div class="label">
        <span>默认 AI 装配与调度模型</span>
        <span style="font-size: 11px; color: #38bdf8;">默认 Flash v4 极速超低耗</span>
      </div>
      <select id="select-model" class="input-box" style="cursor: pointer;">
        <option value="deepseek-chat" ${(!isCustomModel && currentModel === 'deepseek-chat') ? 'selected' : ''}>⚡ DeepSeek-V4-Flash (deepseek-chat) - 推荐 · 极速装配 · 极低消耗</option>
        <option value="deepseek-reasoner" ${(!isCustomModel && currentModel === 'deepseek-reasoner') ? 'selected' : ''}>🧠 DeepSeek-V4-Pro / Reasoner (deepseek-reasoner) - 深度推理 · 复杂审计</option>
        <option value="custom" ${isCustomModel ? 'selected' : ''}>⚙️ 自定义其他模型 (兼容第三方 / OneAPI 渠道)</option>
      </select>
      <input type="text" id="input-custom-model" class="input-box" style="${isCustomModel ? 'display: block;' : 'display: none;'} margin-top: 6px;" placeholder="输入模型名称，例如 gpt-4o-mini 或 deepseek-chat" value="${isCustomModel ? escapeHtml(currentModel) : ''}" />
    </div>

    <div class="tip-box">
      💡 <strong>说明：</strong>密钥将安全保存于本地环境凭据库中。系统默认使用 <strong>Flash v4</strong> 极速模型进行插件预检与装配调度，无需繁琐配置即可秒级完成插件激活。
    </div>
  </div>

  <div class="status" id="status-text">请输入您的 API Key 并点击保存进入客户端</div>

  <div class="actions">
    <button class="btn-test" id="btn-test">测试网络连接</button>
    <button class="btn-submit" id="btn-submit">保存并开启客户端</button>
  </div>

  <script>
    const { ipcRenderer } = require('electron');
    const inputKey = document.getElementById('input-key');
    const inputUrl = document.getElementById('input-url');
    const selectModel = document.getElementById('select-model');
    const inputCustomModel = document.getElementById('input-custom-model');
    const btnTest = document.getElementById('btn-test');
    const btnSubmit = document.getElementById('btn-submit');
    const statusText = document.getElementById('status-text');
    const linkGetKey = document.getElementById('link-get-key');

    selectModel.addEventListener('change', () => {
      if (selectModel.value === 'custom') {
        inputCustomModel.style.display = 'block';
        inputCustomModel.focus();
      } else {
        inputCustomModel.style.display = 'none';
      }
    });

    function getSelectedModel() {
      if (selectModel.value === 'custom') {
        return (inputCustomModel.value || '').trim() || 'deepseek-chat';
      }
      return selectModel.value || 'deepseek-chat';
    }

    linkGetKey.addEventListener('click', (e) => {
      e.preventDefault();
      ipcRenderer.send('open-external-url', 'https://platform.deepseek.com/api_keys');
    });

    btnTest.addEventListener('click', () => {
      const key = inputKey.value.trim();
      const url = inputUrl.value.trim() || 'https://api.deepseek.com';
      if (!key) {
        statusText.style.color = '#f87171';
        statusText.innerText = '请先输入 DeepSeek API Key 再进行测试';
        return;
      }
      btnTest.disabled = true;
      btnSubmit.disabled = true;
      statusText.style.color = '#38bdf8';
      statusText.innerText = '正在向 DeepSeek API 发起连通性测通...';
      ipcRenderer.send('test-api-key', { apiKey: key, baseUrl: url });
    });

    btnSubmit.addEventListener('click', () => {
      const key = inputKey.value.trim();
      const url = inputUrl.value.trim() || 'https://api.deepseek.com';
      const model = getSelectedModel();
      if (!key) {
        statusText.style.color = '#f87171';
        statusText.innerText = 'API Key 不能为空';
        return;
      }
      btnTest.disabled = true;
      btnSubmit.disabled = true;
      statusText.style.color = '#38bdf8';
      statusText.innerText = '正在保存配置并初始化客户端...';
      ipcRenderer.send('save-api-key', { apiKey: key, baseUrl: url, aiModel: model });
    });

    ipcRenderer.on('test-api-result', (_event, result) => {
      btnTest.disabled = false;
      btnSubmit.disabled = false;
      if (result.ok) {
        statusText.style.color = '#4ade80';
        statusText.innerText = '✅ 连接成功！DeepSeek API 响应正常。';
      } else {
        statusText.style.color = '#f87171';
        statusText.innerText = '❌ 连接失败：' + (result.error || '无法访问');
      }
    });

    ipcRenderer.on('save-api-result', (_event, success, err) => {
      if (success) {
        statusText.style.color = '#4ade80';
        statusText.innerText = '🎉 配置已保存，正在进入客户端...';
        setTimeout(() => {
          ipcRenderer.send('onboarding-completed');
        }, 800);
      } else {
        btnTest.disabled = false;
        btnSubmit.disabled = false;
        statusText.style.color = '#f87171';
        statusText.innerText = '保存失败：' + (err || '未知错误');
      }
    });
  </script>
</body>
</html>`

  onboardingDialog.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  onboardingDialog.on('closed', () => {
    onboardingDialog = null
  })
}

/**
 * AI-Driven Plugin Installation Window (AI Agent 自动化装配弹窗).
 */
function showPluginInstallDialog(payload) {
  if (installDialog && !installDialog.isDestroyed()) {
    installDialog.focus()
    return
  }

  const { aiModel } = readConfig()
  const cleanModel = aiModel || 'deepseek-chat'
  const modelBadge = (cleanModel === 'deepseek-chat') 
    ? '⚡ DeepSeek-V4-Flash (官方极速)' 
    : (cleanModel === 'deepseek-reasoner' ? '🧠 DeepSeek-V4-Pro (深度推理)' : `⚙️ ${cleanModel}`)

  installDialog = new BrowserWindow({
    width: 520,
    height: 610,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: 'DeepSeek 智能插件装配 (AI Agent 自动化运维)',
    icon: path.join(__dirname, 'build', 'icon.png'),
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
  <title>DeepSeek 插件装配</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; }
    body { background: #0f172a; color: #f8fafc; padding: 24px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .logo { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #0ea5e9, #3b82f6); display: flex; align-items: center; justify-content: center; font-size: 24px; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3); }
    .title { font-size: 17px; font-weight: 700; color: #f1f5f9; }
    .subtitle { font-size: 12px; color: #94a3b8; margin-top: 3px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
    .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; }
    .row:last-child { margin-bottom: 0; }
    .label { color: #94a3b8; font-size: 12px; }
    .val { color: #f8fafc; font-weight: 600; text-align: right; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { background: #0284c725; color: #38bdf8; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; border: 1px solid #0284c750; }
    .ai-banner { background: linear-gradient(90deg, rgba(14,165,233,0.15), rgba(99,102,241,0.15)); border: 1px solid rgba(56,189,248,0.3); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; font-size: 12px; color: #38bdf8; display: flex; align-items: center; gap: 8px; font-weight: 500; }
    .steps-box { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 12px; color: #94a3b8; line-height: 1.6; }
    .status { font-size: 13px; color: #38bdf8; text-align: center; min-height: 20px; font-weight: 500; margin-top: auto; }
    .progress-bar { width: 100%; height: 5px; background: #334155; border-radius: 3px; overflow: hidden; margin-top: 8px; display: none; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #38bdf8, #6366f1); width: 0%; transition: width 0.3s ease; }
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
    <div class="logo">🤖</div>
    <div>
      <div class="title">DeepSeek 智能插件装配中心</div>
      <div class="subtitle">AI Agent 自动化运维与环境自愈系统</div>
    </div>
  </div>

  <div class="ai-banner">
    <span>✨</span><span>一键安装将由内置 AI 自动排查环境依赖、配置补丁并执行健康自检。</span>
  </div>

  <div class="card">
    <div class="row">
      <span class="label">插件名称</span>
      <span class="val" style="color: #38bdf8;">${escapeHtml(payload.name)}</span>
    </div>
    <div class="row">
      <span class="label">调度 AI 引擎</span>
      <span class="val" style="color: #38bdf8; font-size: 12px;">${escapeHtml(modelBadge)}</span>
    </div>
    <div class="row">
      <span class="label">唯一标识</span>
      <span class="val" style="font-family: monospace;">${escapeHtml(payload.id)}</span>
    </div>
    <div class="row">
      <span class="label">版本号</span>
      <span class="badge">${escapeHtml(payload.version)}</span>
    </div>
    <div class="row">
      <span class="label">开源源</span>
      <span class="val" title="${escapeHtml(payload.repo)}">${escapeHtml(payload.repo)}</span>
    </div>
    <div class="row">
      <span class="label">权限申请</span>
      <span class="val" style="font-size: 11px; color: #e2e8f0;">${escapeHtml(payload.permissions || '网络访问, 本地文件读取')}</span>
    </div>
  </div>

  <div class="steps-box" id="steps-box">
    <strong>📋 AI 自动化装配规程（遵从 Hub 7 大铁律）：</strong><br>
    • 智能解包穿透 &bull; Cordis 补丁自愈 &bull; 无提权 NTFS 软链 &bull; 无 BOM 事务写入 &bull; 闭环健康自检
  </div>

  <div class="status" id="status-text">等待确认装配授权...</div>
  <div class="progress-bar" id="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>

  <div class="actions">
    <button class="btn-cancel" id="btn-cancel" onclick="window.close()">取消</button>
    <button class="btn-install" id="btn-install">授权并由 AI 自动装配</button>
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
      progressFill.style.width = '15%';
      statusText.innerText = 'AI Agent 正在调度环境与依赖...';
      ipcRenderer.send('start-plugin-install', ${JSON.stringify(payload)});
    });

    ipcRenderer.on('install-progress', (_event, msg) => {
      statusText.innerText = msg;
      if (msg.includes('1/6')) progressFill.style.width = '20%';
      else if (msg.includes('2/6')) progressFill.style.width = '40%';
      else if (msg.includes('3/6')) progressFill.style.width = '60%';
      else if (msg.includes('4/6')) progressFill.style.width = '75%';
      else if (msg.includes('5/6')) progressFill.style.width = '88%';
      else if (msg.includes('6/6')) progressFill.style.width = '96%';
    });

    ipcRenderer.on('install-done', (_event, success, err) => {
      if (success) {
        progressFill.style.width = '100%';
        statusText.style.color = '#15803d';
        statusText.innerText = '🎉 插件已由 AI 成功适配并激活！即刻可用。';
        setTimeout(() => window.close(), 1600);
      } else {
        progressBar.style.display = 'none';
        btnInstall.style.display = 'none';
        btnCancel.disabled = false;
        btnCancel.innerText = '我知道了 (关闭)';
        btnCancel.style.background = '#dc2626';
        btnCancel.style.color = '#ffffff';

        // 渲染高清晰度 AI 拦截诊断卡片
        const stepsBox = document.getElementById('steps-box');
        if (stepsBox) {
          stepsBox.style.background = '#fef2f2';
          stepsBox.style.border = '1px solid #fca5a5';
          stepsBox.style.color = '#991b1b';
          stepsBox.innerHTML = '<div style="font-weight: 700; font-size: 13px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; color: #dc2626;">' +
            '<span>🚫</span><span>AI 智能主动取消本次安装</span></div>' +
            '<div style="font-size: 12px; line-height: 1.5; white-space: pre-line;">' + (err || '未能通过系统可用性自检') + '</div>';
        }
        statusText.style.color = '#dc2626';
        statusText.innerText = '安装已主动终止并回滚，系统环境保持纯净无残留';
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

  // Check if API Key is configured
  if (!hasValidApiKey()) {
    log(`handleDshProtocolUrl: API key missing. Queuing pending intent for plugin ${payload.id}`)
    pendingDshUrl = url
    showOnboardingDialog()
    return
  }

  showPluginInstallDialog(payload)
}

/**
 * Opens the Integrated Local Plugin Market (dsh-stream-market) in a dedicated window.
 */
function openLocalMarketWindow() {
  if (localMarketWindow && !localMarketWindow.isDestroyed()) {
    localMarketWindow.focus()
    return
  }

  localMarketWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    title: 'DeepSeek Harness - 内置插件市场 (本地极速)',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Intercept dsh:// links inside Local Market window
  localMarketWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
      handleDshProtocolUrl(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  localMarketWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
      event.preventDefault()
      handleDshProtocolUrl(url)
    }
  })

  localMarketWindow.loadURL('http://127.0.0.1:18899/?fullscreen=1')
  localMarketWindow.on('closed', () => {
    localMarketWindow = null
  })
}

/**
 * Opens the DeepSeek Harness Hub Market (deepseek.stream) in a dedicated window.
 */
function openHubMarketWindow() {
  if (hubWindow && !hubWindow.isDestroyed()) {
    hubWindow.focus()
    return
  }

  hubWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'DeepSeek Harness Hub - 插件市场',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Intercept dsh:// links inside Hub window
  hubWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
      handleDshProtocolUrl(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  hubWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
      event.preventDefault()
      handleDshProtocolUrl(url)
    }
  })

  hubWindow.loadURL('https://deepseek.stream/')
  hubWindow.on('closed', () => {
    hubWindow = null
  })
}

// Application Menu
function setupApplicationMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: '关于 DeepSeek Harness', role: 'about' },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '插件市场',
      submenu: [
        {
          label: '⚡ 内置插件市场 (本地极速)',
          accelerator: 'CmdOrCtrl+M',
          click: () => openLocalMarketWindow(),
        },
        {
          label: '🌐 Hub 市场 (网页版)',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => openHubMarketWindow(),
        },
        {
          label: '📖 开发者与协议指南',
          click: () => shell.openExternal('https://deepseek.stream/guide'),
        },
      ],
    },
    {
      label: '配置与服务',
      submenu: [
        {
          label: '🔑 重新配置 DeepSeek API Key',
          click: () => showOnboardingDialog(),
        },
        {
          label: '🔄 重启后端服务',
          click: async () => {
            await restartBackend()
            if (mainWindow && detectedAuthUrl) {
              mainWindow.loadURL(detectedAuthUrl)
            }
          },
        },
        { type: 'separator' },
        {
          label: '📁 打开用户数据目录 (.dsh)',
          click: () => shell.openPath(getDshHome()),
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新载入', role: 'reload' },
        { label: '强制重新载入', role: 'forceReload' },
        { label: '切换开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
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
    setupApplicationMenu()
    watchRestartTrigger()
    watchProtocolIntent()

    ipcMain.handle('dsh:restart-backend', async () => {
      log('IPC dsh:restart-backend triggered from renderer')
      return await restartBackend()
    })

    // Global interception: catch any dsh:// link triggered from any window or iframe
    app.on('web-contents-created', (_event, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
          handleDshProtocolUrl(url)
          return { action: 'deny' }
        }
        return { action: 'allow' }
      })
      contents.on('will-navigate', (event, url) => {
        if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
          event.preventDefault()
          handleDshProtocolUrl(url)
        }
      })
      contents.on('will-frame-navigate', (event) => {
        if (event.url && (event.url.startsWith('dsh://') || event.url.startsWith('dsh:'))) {
          event.preventDefault()
          handleDshProtocolUrl(event.url)
        }
      })
    })

    // Create Main Window
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 960,
      minHeight: 640,
      title: 'DeepSeek Harness',
      icon: path.join(__dirname, 'build', 'icon.png'),
      autoHideMenuBar: false,
      backgroundColor: '#0f172a',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
        handleDshProtocolUrl(url)
        return { action: 'deny' }
      }
      return { action: 'allow' }
    })
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
        event.preventDefault()
        handleDshProtocolUrl(url)
      }
    })

    const loadingHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; background: #0f172a; color: #94a3b8; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: -apple-system, sans-serif; }
    .spinner { width: 44px; height: 44px; border: 4px solid #1e293b; border-top-color: #0ea5e9; border-radius: 50%; animation: spin 0.9s linear infinite; margin-bottom: 20px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .tip { font-size: 15px; letter-spacing: 0.5px; color: #e2e8f0; font-weight: 500; }
    .subtip { font-size: 12px; color: #64748b; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="tip" id="tip-text">正在启动 DeepSeek Harness 运行时...</div>
  <div class="subtip" id="subtip-text">载入本地模型适配器与插件容器</div>
</body>
</html>`
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`)

    // Check startup argv for initial dsh:// link
    const initialDshUrl = findDshUrl(process.argv)
    if (initialDshUrl) {
      pendingDshUrl = initialDshUrl
    }

    // Resolve Backend files
    let target = null
    for (let attempt = 0; attempt < 30; attempt++) {
      target = resolveBackend()
      if (target) break
      log(`Waiting for backend files to become ready (attempt ${attempt + 1}/30)... execPath=${process.execPath} resourcesPath=${process.resourcesPath}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    if (!target) {
      log(`FATAL: resolveBackend failed. execPath=${process.execPath} resourcesPath=${process.resourcesPath}`)
      showFatal('缺少运行时环境', `未找到 DeepSeek Harness 运行时依赖文件 (runtime/lib/bin.js)。\n\n检测资源目录：${process.resourcesPath}\n请确认安装包完整或重新运行安装程序。`)
      return
    }

    await startBackend(target)

    mainWindow.webContents.on('did-finish-load', () => {
      log(`mainWindow did-finish-load: URL=${mainWindow.webContents.getURL()}`)
    })

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log(`did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
      if (errorCode === -3) return
      if (detectedAuthUrl && validatedURL !== detectedAuthUrl) {
        isAuthLoaded = false
        loadAuthenticatedUrl(detectedAuthUrl)
      }
    })

    try {
      const authUrl = await waitForAuthUrl(60000, (sec) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(`
            var el = document.getElementById('tip-text');
            if (el) el.innerText = '正在启动 DeepSeek Harness 运行时 (' + ${sec} + '秒)...';
          `).catch(() => {})
        }
      })
      loadAuthenticatedUrl(authUrl)
    } catch (err) {
      if (!backend) return
      showFatal('服务启动超时', `无法完成安全认证握手：${err.message}\n\n查看运行日志：${LOG_FILE}`)
      return
    }

    // After backend is loaded, check if user has configured API Key
    if (!hasValidApiKey()) {
      showOnboardingDialog()
    } else if (pendingDshUrl) {
      setTimeout(() => {
        const url = pendingDshUrl
        pendingDshUrl = null
        handleDshProtocolUrl(url)
      }, 1000)
    }

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })

  // IPC handler: Test API Key connection
  ipcMain.on('test-api-key', async (event, { apiKey, baseUrl }) => {
    const result = await testApiConnection(apiKey, baseUrl)
    event.reply('test-api-result', result)
  })

  // IPC handler: Save API Key configuration
  ipcMain.on('save-api-key', (event, { apiKey, baseUrl, aiModel }) => {
    try {
      saveConfig({ apiKey, baseUrl, aiModel })
      event.reply('save-api-result', true)
    } catch (err) {
      event.reply('save-api-result', false, err.message)
    }
  })

  // IPC handler: Onboarding completed
  ipcMain.on('onboarding-completed', async () => {
    if (onboardingDialog && !onboardingDialog.isDestroyed()) {
      onboardingDialog.close()
      onboardingDialog = null
    }

    // If there is a pending one-click install, execute it now!
    if (pendingDshUrl) {
      const url = pendingDshUrl
      pendingDshUrl = null
      setTimeout(() => handleDshProtocolUrl(url), 500)
    }
  })

  // IPC handler: Open external URL safely
  ipcMain.on('open-external-url', (_event, url) => {
    shell.openExternal(url)
  })

  // IPC handler: Start AI Plugin Provisioning
  ipcMain.on('start-plugin-install', async (event, payload) => {
    try {
      await downloadAndInstallPlugin(payload, (msg) => {
        if (typeof msg === 'string') {
          event.reply('install-progress', msg)
        }
      })

      event.reply('install-progress', 'AI 正在热重启 DeepSeek Harness 运行时以应用新插件...')
      const restarted = await restartBackend()
      if (!restarted) {
        throw new Error('重启 DeepSeek Harness 运行时未能完成握手，请检查运行日志')
      }

      if (mainWindow && !mainWindow.isDestroyed() && detectedAuthUrl) {
        mainWindow.loadURL(detectedAuthUrl)
      }

      event.reply('install-done', true)

      // 实时向已打开的市场窗口与主窗口派发刷新指令，点亮小绿标
      const notifyScript = `try { if (typeof refreshAll === 'function') refreshAll(); else if (typeof fetchInstalled === 'function') fetchInstalled().then(() => { if (typeof renderMarketList === 'function') renderMarketList(); if (typeof renderLocalList === 'function') renderLocalList(); }); } catch(e){}`
      if (localMarketWindow && !localMarketWindow.isDestroyed()) {
        localMarketWindow.webContents.executeJavaScript(notifyScript).catch(() => {})
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(notifyScript).catch(() => {})
      }
    } catch (err) {
      log(`start-plugin-install error: ${err.message}`)
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
