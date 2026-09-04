import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

export function getDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const client = url.startsWith('https') ? https : http

    const request = client.get(url, {
      headers: {
        'User-Agent': 'DeepSeek-Harness-Desktop/0.1.2'
      }
    }, (response) => {
      // Handle redirects (301, 302, 307, 308)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close()
        try { fs.unlinkSync(dest) } catch {}
        return downloadFile(response.headers.location, dest, onProgress).then(resolve, reject)
      }

      if (response.statusCode !== 200) {
        file.close()
        try { fs.unlinkSync(dest) } catch {}
        return reject(new Error(`下载失败，服务器返回 HTTP 状态码 ${response.statusCode}`))
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
      let downloadedBytes = 0

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0 && onProgress) {
          const pct = Math.round((downloadedBytes / totalBytes) * 100)
          onProgress(pct)
        }
      })

      response.pipe(file)

      file.on('finish', () => {
        file.close(() => resolve(dest))
      })
    })

    request.on('error', (err) => {
      file.close()
      try { fs.unlinkSync(dest) } catch {}
      reject(err)
    })

    request.setTimeout(30000, () => {
      request.destroy()
      file.close()
      try { fs.unlinkSync(dest) } catch {}
      reject(new Error('下载连接超时'))
    })
  })
}

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
    for (const file of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, file), path.join(dest, file))
    }
  } else {
    fs.copyFileSync(src, dest)
  }
}

/**
 * Parses and validates raw dsh:// URL according to the official spec:
 * dsh://plugin/install?id={id}&name={name}&version={version}&repo={repo}&permissions={permissions}&downloadUrl={downloadUrl}
 */
export function parseDshUrl(rawUrl) {
  try {
    if (!rawUrl || typeof rawUrl !== 'string') return null
    let clean = rawUrl.trim().replace(/^["']|["']$/g, '')
    if (!clean.toLowerCase().startsWith('dsh://') && !clean.toLowerCase().startsWith('dsh:')) return null

    const urlObj = new URL(clean.replace(/^dsh:\/\/?/i, 'https://dummy.local/'))
    const pathname = urlObj.pathname.replace(/^\/+/, '')
    if (pathname !== 'plugin/install' && !pathname.endsWith('plugin/install')) return null

    const params = urlObj.searchParams
    const id = (params.get('id') || '').trim().toLowerCase()
    if (!id || !/^[a-z0-9][a-z0-9-_.]*$/.test(id)) return null

    const name = (params.get('name') || id).trim()
    const version = (params.get('version') || 'latest').trim()
    const repo = (params.get('repo') || id).trim()
    const permissions = (params.get('permissions') || '网络访问, 本地文件读取').trim()
    const downloadUrl = (params.get('downloadUrl') || '').trim()

    return { id, name, version, repo, permissions, downloadUrl }
  } catch {
    return null
  }
}

/**
 * Downloads, extracts, and registers a plugin into ~/.dsh
 */
export async function downloadAndInstallPlugin(payload, onProgress) {
  const dshHome = getDshHome()
  const pluginId = payload.id
  const targetDir = path.join(dshHome, 'plugins', pluginId)

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  // 1. Build candidates list for download
  const candidateUrls = []
  if (payload.repo && payload.repo.includes('/') && !payload.repo.startsWith('@')) {
    if (payload.version && payload.version !== 'latest') {
      candidateUrls.push(`https://github.com/${payload.repo}/archive/refs/tags/v${payload.version}.zip`)
      candidateUrls.push(`https://github.com/${payload.repo}/archive/refs/tags/${payload.version}.zip`)
    }
    candidateUrls.push(`https://github.com/${payload.repo}/archive/HEAD.zip`)
  }
  if (payload.downloadUrl && (payload.downloadUrl.startsWith('http://') || payload.downloadUrl.startsWith('https://'))) {
    candidateUrls.push(payload.downloadUrl)
  }

  let downloaded = false
  const tempZip = path.join(os.tmpdir(), `dsh_plugin_${pluginId}_${Date.now()}.zip`)
  const tempExtract = path.join(os.tmpdir(), `dsh_extract_${pluginId}_${Date.now()}`)

  for (const url of candidateUrls) {
    try {
      onProgress?.(`正在从源下载安装包：${payload.name}...`)
      await downloadFile(url, tempZip, (pct) => {
        onProgress?.(`正在下载插件安装包 (${pct}%)...`)
      })
      downloaded = true
      break
    } catch {
      // try next candidate
    }
  }

  if (downloaded) {
    onProgress?.('正在解压并写入文件...')
    fs.mkdirSync(tempExtract, { recursive: true })

    try {
      execFileSync('tar.exe', ['-xf', tempZip, '-C', tempExtract], { stdio: 'ignore' })
    } catch {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Force -Path "${tempZip}" -DestinationPath "${tempExtract}"`], { stdio: 'ignore' })
    }

    // Flatten nested single directory
    let srcDir = tempExtract
    const items = fs.readdirSync(tempExtract)
    if (items.length === 1 && fs.statSync(path.join(tempExtract, items[0])).isDirectory()) {
      srcDir = path.join(tempExtract, items[0])
    }

    // Locate inner plugin directory if monorepo
    if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
      for (const sub of ['plugins/' + pluginId, 'packages/' + pluginId, pluginId]) {
        const candidate = path.join(srcDir, sub)
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
          srcDir = candidate
          break
        }
      }
    }

    copyRecursiveSync(srcDir, targetDir)

    try { fs.unlinkSync(tempZip) } catch {}
    try { fs.rmSync(tempExtract, { recursive: true, force: true }) } catch {}
  } else {
    // If no downloadable package, create minimal standard plugin scaffold
    const entryFile = path.join(targetDir, 'index.js')
    if (!fs.existsSync(entryFile)) {
      fs.writeFileSync(entryFile, `export const name = "${pluginId}";\nexport function apply(ctx) {\n  console.log("Loaded DeepSeek plugin: ${pluginId}");\n}\n`, 'utf8')
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
  } else {
    // Create package.json if missing
    const minimalPkg = {
      name: pkgName,
      version: payload.version || '1.0.0',
      type: 'module',
      main: 'index.js',
      description: payload.name
    }
    fs.writeFileSync(pluginPkgJsonPath, JSON.stringify(minimalPkg, null, 2) + '\n', 'utf8')
  }

  // 3. Configure 0.1.2 profile & bundles
  onProgress?.('正在配置 Harness 运行环境与依赖 (注册 bundles)...')
  configureProfiles(dshHome, pluginId, pkgName)

  // 4. Ensure node_modules junctions
  ensurePluginLinks(dshHome, pluginId, pkgName)

  onProgress?.('插件安装与环境装配完成！')
}

/**
 * Configure profiles (web and default) for DeepSeek Harness 0.1.2:
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
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
        }
      }
    }

    if (fs.existsSync(pkgPath)) {
      try {
        let content = fs.readFileSync(pkgPath, 'utf8')
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1)
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

    // Add new plugin bundle
    if (!pkg.dsh.profile.bundles.includes(pkgName)) {
      pkg.dsh.profile.bundles.push(pkgName)
    }

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
    path.join(dshHome, 'profiles', 'default', 'node_modules')
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

  // Link core @deepseek-ai modules from packaged resources if present
  try {
    const runtimeAiDirs = [
      process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'node_modules', '@deepseek-ai'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek-Harness', 'resources', 'runtime', 'node_modules', '@deepseek-ai')
    ].filter(Boolean)

    for (const runtimeAi of runtimeAiDirs) {
      if (fs.existsSync(runtimeAi)) {
        const dshAi = path.join(dshHome, 'node_modules', '@deepseek-ai')
        const profileWebAi = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai')
        for (const destAi of [dshAi, profileWebAi]) {
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
