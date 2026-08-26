import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

export function getDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Downloads, extracts, and configures a DeepSeek Harness plugin into ~/.dsh
 * Both as a profile bundle and loader patch so it is 100% active in backend and UI.
 */
export async function downloadAndInstallPlugin(payload, onProgress) {
  const dshHome = getDshHome()
  const pluginId = payload.id
  const targetDir = path.join(dshHome, 'plugins', pluginId)

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  // 1. Determine download source
  let downloadUrl = payload.downloadUrl
  if (downloadUrl && !downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
    downloadUrl = ''
  }
  if (!downloadUrl && payload.repo && payload.repo.includes('/')) {
    downloadUrl = `https://github.com/${payload.repo}/archive/HEAD.zip`
  }

  if (downloadUrl) {
    onProgress?.(`正在下载插件安装包：${payload.name || pluginId}...`)
    const tempZip = path.join(os.tmpdir(), `dsh_plugin_${pluginId}_${Date.now()}.zip`)
    await downloadFile(downloadUrl, tempZip, (pct) => {
      onProgress?.(`正在下载插件安装包 (${pct}%)...`)
    })

    onProgress?.('正在解压并写入文件...')
    const tempExtract = path.join(os.tmpdir(), `dsh_extract_${pluginId}_${Date.now()}`)
    fs.mkdirSync(tempExtract, { recursive: true })

    try {
      execFileSync('tar.exe', ['-xf', tempZip, '-C', tempExtract], { stdio: 'ignore' })
    } catch {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Force -Path "${tempZip}" -DestinationPath "${tempExtract}"`], { stdio: 'ignore' })
    }

    // Flatten nested directory if archive wraps contents
    let srcDir = tempExtract
    const items = fs.readdirSync(tempExtract)
    if (items.length === 1 && fs.statSync(path.join(tempExtract, items[0])).isDirectory()) {
      srcDir = path.join(tempExtract, items[0])
    }

    // Locate package directory if monorepo
    if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
      const p1 = path.join(srcDir, 'plugins', pluginId)
      const p2 = path.join(srcDir, 'packages', pluginId)
      const p3 = path.join(srcDir, pluginId)
      if (fs.existsSync(path.join(p1, 'package.json'))) srcDir = p1
      else if (fs.existsSync(path.join(p2, 'package.json'))) srcDir = p2
      else if (fs.existsSync(path.join(p3, 'package.json'))) srcDir = p3
    }

    copyRecursiveSync(srcDir, targetDir)

    try { fs.unlinkSync(tempZip) } catch {}
    try { fs.rmSync(tempExtract, { recursive: true, force: true }) } catch {}
  } else {
    // Minimal fallback entry if no download URL
    const entryFile = path.join(targetDir, 'index.js')
    if (!fs.existsSync(entryFile)) {
      fs.writeFileSync(entryFile, `export const name = "${pluginId}";\nexport function apply(ctx) {\n  console.log("Loaded plugin ${pluginId}");\n}\n`, 'utf8')
    }
  }

  // 2. Read plugin manifest & patch declaration
  let pkgName = pluginId
  const pluginPkgJsonPath = path.join(targetDir, 'package.json')
  if (fs.existsSync(pluginPkgJsonPath)) {
    try {
      let content = fs.readFileSync(pluginPkgJsonPath, 'utf8')
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
      const pluginPkg = JSON.parse(content)
      if (pluginPkg.name) pkgName = pluginPkg.name

      // Ensure cordis patch is configured if cordis.patch.yml exists
      if (fs.existsSync(path.join(targetDir, 'cordis.patch.yml'))) {
        pluginPkg.dsh = pluginPkg.dsh || {}
        if (!pluginPkg.dsh.bundle || typeof pluginPkg.dsh.bundle === 'boolean') {
          pluginPkg.dsh.bundle = { patch: './cordis.patch.yml' }
          fs.writeFileSync(pluginPkgJsonPath, JSON.stringify(pluginPkg, null, 2) + '\n', 'utf8')
        }
      }
    } catch {}
  }

  // 3. Configure profile dependencies and bundles
  onProgress?.('正在配置 Harness 插件环境与依赖关系 (注册 bundles)...')
  configureProfiles(dshHome, pluginId, pkgName)

  // 4. Ensure directory junctions in all node_modules
  ensurePluginLinks(dshHome, pluginId, pkgName)

  onProgress?.('插件配置完成！')
}

/**
 * Configure profiles (web and default) so that:
 * 1. dependencies includes the file: link to plugins/<pluginId>
 * 2. dsh.profile.bundles includes the package name to be loaded into the runtime
 */
export function configureProfiles(dshHome, pluginId, pkgName) {
  const profileNames = ['web', 'default']
  for (const name of profileNames) {
    const profileDir = path.join(dshHome, 'profiles', name)
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true })
    }

    const pkgPath = path.join(profileDir, 'package.json')
    let pkg = {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        },
      },
    }

    if (fs.existsSync(pkgPath)) {
      try {
        let content = fs.readFileSync(pkgPath, 'utf8')
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1) // Strip UTF-8 BOM
        pkg = JSON.parse(content)
      } catch {}
    }

    pkg.dependencies = pkg.dependencies || {}
    pkg.dependencies[pkgName] = `file:../../plugins/${pluginId}`

    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

    // Ensure base bundles exist
    if (!pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')) {
      pkg.dsh.profile.bundles.unshift('@deepseek-ai/dsh-base')
    }
    if (!pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app')) {
      pkg.dsh.profile.bundles.splice(1, 0, '@deepseek-ai/dsh-web-app')
    }

    // Always ensure the plugin is registered in bundles so Harness loads it
    if (!pkg.dsh.profile.bundles.includes(pkgName)) {
      pkg.dsh.profile.bundles.push(pkgName)
    }

    // Write valid, BOM-free UTF-8 JSON
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }
}

/**
 * Creates directory junctions / symlinks across all node_modules search paths.
 */
export function ensurePluginLinks(dshHome, pluginId, pkgName) {
  const pluginDir = path.join(dshHome, 'plugins', pluginId)
  if (!fs.existsSync(pluginDir)) return

  const targetNames = Array.from(new Set([pkgName, pluginId].filter(Boolean)))
  
  const searchDirs = [
    path.join(dshHome, 'profiles', 'web', 'node_modules'),
    path.join(dshHome, 'profiles', 'node_modules'),
    path.join(dshHome, 'node_modules'),
    path.join(dshHome, 'profiles', 'default', 'node_modules'),
  ]

  for (const dir of searchDirs) {
    for (const name of targetNames) {
      const target = path.join(dir, name)
      try {
        const parentDir = path.dirname(target)
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })
        if (fs.existsSync(target)) {
          try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
        }
        try {
          fs.symlinkSync(pluginDir, target, 'junction')
        } catch {
          copyRecursiveSync(pluginDir, target)
        }
      } catch {}
    }
  }

  // Also ensure core @deepseek-ai runtime modules are linked if runtime resources exist
  try {
    const runtimeAiDirs = [
      process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'node_modules', '@deepseek-ai'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek-Harness', 'resources', 'runtime', 'node_modules', '@deepseek-ai'),
    ].filter(Boolean)

    for (const runtimeAi of runtimeAiDirs) {
      if (fs.existsSync(runtimeAi)) {
        const dshAi = path.join(dshHome, 'node_modules', '@deepseek-ai')
        const profileWebAi = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
        const profileAi = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
        for (const destAi of [dshAi, profileWebAi, profileAi]) {
          if (!fs.existsSync(destAi)) {
            try {
              fs.mkdirSync(path.dirname(destAi), { recursive: true })
              fs.symlinkSync(runtimeAi, destAi, 'junction')
            } catch {
              try { copyRecursiveSync(runtimeAi, destAi) } catch {}
            }
          }
        }
        break
      }
    }
  } catch {}
}

/**
 * Automatically scans ~/.dsh/plugins and reconciles all installed plugins into profiles & bundles.
 * Call this on app startup to auto-heal any plugins installed manually or via previous versions.
 */
export function reconcileAllPlugins(dshHome = getDshHome()) {
  const pluginsRoot = path.join(dshHome, 'plugins')
  if (!fs.existsSync(pluginsRoot)) return []

  const reconciled = []
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const pluginId = entry.name
    const targetDir = path.join(pluginsRoot, pluginId)
    let pkgName = pluginId

    const pluginPkgJsonPath = path.join(targetDir, 'package.json')
    if (fs.existsSync(pluginPkgJsonPath)) {
      try {
        let content = fs.readFileSync(pluginPkgJsonPath, 'utf8')
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
        const pluginPkg = JSON.parse(content)
        if (pluginPkg.name) pkgName = pluginPkg.name

        if (fs.existsSync(path.join(targetDir, 'cordis.patch.yml'))) {
          pluginPkg.dsh = pluginPkg.dsh || {}
          if (!pluginPkg.dsh.bundle || typeof pluginPkg.dsh.bundle === 'boolean') {
            pluginPkg.dsh.bundle = { patch: './cordis.patch.yml' }
            fs.writeFileSync(pluginPkgJsonPath, JSON.stringify(pluginPkg, null, 2) + '\n', 'utf8')
          }
        }
      } catch {}
    }

    configureProfiles(dshHome, pluginId, pkgName)
    ensurePluginLinks(dshHome, pluginId, pkgName)
    reconciled.push(pkgName)
  }

  return reconciled
}

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyRecursiveSync(srcPath, destPath)
    } else {
      try { fs.copyFileSync(srcPath, destPath) } catch {}
    }
  }
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const client = url.startsWith('https:') ? https : http

    function makeRequest(currentUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('重定向次数过多'))
      client.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return makeRequest(response.headers.location, redirects + 1)
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`下载失败 HTTP ${response.statusCode}`))
        }
        const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
        let downloadedBytes = 0

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length
          if (totalBytes > 0 && onProgress) {
            onProgress(Math.round((downloadedBytes / totalBytes) * 100))
          }
        })

        response.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve()
        })
      }).on('error', (err) => {
        fs.unlink(dest, () => {})
        reject(err)
      })
    }

    makeRequest(url)
  })
}
