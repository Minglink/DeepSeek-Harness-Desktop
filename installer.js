import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

function getDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Downloads, extracts, and configures a DeepSeek Harness plugin into ~/.dsh
 * Both as a profile bundle and/or loader patch so it is 100% active in backend and UI.
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
    onProgress?.('姝ｅ湪涓嬭浇鎻掍欢瀹夎鍖?..')
    const tempZip = path.join(os.tmpdir(), `dsh_plugin_${pluginId}_${Date.now()}.zip`)
    await downloadFile(downloadUrl, tempZip)

    onProgress?.('姝ｅ湪瑙ｅ帇骞跺啓鍏ユ枃浠?..')
    const tempExtract = path.join(os.tmpdir(), `dsh_extract_${pluginId}_${Date.now()}`)
    fs.mkdirSync(tempExtract, { recursive: true })

    try {
      execFileSync('tar.exe', ['-xf', tempZip, '-C', tempExtract], { stdio: 'ignore' })
    } catch {
      execFileSync('powershell.exe', ['-Command', `Expand-Archive -Force -Path "${tempZip}" -DestinationPath "${tempExtract}"`], { stdio: 'ignore' })
    }

    // Flatten if single root directory in archive
    let srcDir = tempExtract
    const items = fs.readdirSync(tempExtract)
    if (items.length === 1 && fs.statSync(path.join(tempExtract, items[0])).isDirectory()) {
      srcDir = path.join(tempExtract, items[0])
    }

    if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
      const monorepoPath1 = path.join(srcDir, 'plugins', pluginId)
      const monorepoPath2 = path.join(srcDir, 'packages', pluginId)
      if (fs.existsSync(path.join(monorepoPath1, 'package.json'))) {
        srcDir = monorepoPath1
      } else if (fs.existsSync(path.join(monorepoPath2, 'package.json'))) {
        srcDir = monorepoPath2
      } else if (fs.existsSync(path.join(srcDir, pluginId, 'package.json'))) {
        srcDir = path.join(srcDir, pluginId)
      }
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

  // 2. Read plugin manifest to get exact package name and bundle info
  let pkgName = pluginId
  const pluginPkgJsonPath = path.join(targetDir, 'package.json')
  let isBundle = false
  if (fs.existsSync(pluginPkgJsonPath)) {
    try {
      const pluginPkg = JSON.parse(fs.readFileSync(pluginPkgJsonPath, 'utf8'))
      if (pluginPkg.name) pkgName = pluginPkg.name
      if (pluginPkg.dsh?.bundle || fs.existsSync(path.join(targetDir, 'cordis.patch.yml'))) {
        isBundle = true
      }
    } catch {}
  }

  // 3. Configure profile dependencies and bundles
  onProgress?.('姝ｅ湪閰嶇疆 Harness 鎻掍欢鐜涓庝緷璧栧叧绯?..')
  configureProfiles(dshHome, pluginId, pkgName, isBundle)

  // 4. Ensure directory junctions in node_modules
  ensurePluginLinks(dshHome, pluginId, pkgName)

  onProgress?.('鎻掍欢瀹夎瀹屾垚锛佸凡鎴愬姛瑁呰浇')
}

function configureProfiles(dshHome, pluginId, pkgName, isBundle) {
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

    if (!pkg.dsh.profile.bundles.includes(pkgName)) {
      pkg.dsh.profile.bundles.push(pkgName)
    }

    // Write valid, BOM-free JSON
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }
}

function ensurePluginLinks(dshHome, pluginId, pkgName) {
  const pluginDir = path.join(dshHome, 'plugins', pluginId)
  const targets = [
    path.join(dshHome, 'node_modules', pkgName),
    path.join(dshHome, 'profiles', 'web', 'node_modules', pkgName),
    path.join(dshHome, 'profiles', 'default', 'node_modules', pkgName),
  ]

  for (const target of targets) {
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

  // Also ensure core @deepseek-ai runtime modules are linked
  try {
    const dshModules = path.join(dshHome, 'node_modules')
    const runtimeAi = path.join(process.resourcesPath, 'runtime', 'node_modules', '@deepseek-ai')
    const dshAi = path.join(dshModules, '@deepseek-ai')
    if (fs.existsSync(runtimeAi) && !fs.existsSync(dshAi)) {
      try {
        fs.symlinkSync(runtimeAi, dshAi, 'junction')
      } catch {
        copyRecursiveSync(runtimeAi, dshAi)
      }
    }
  } catch {}
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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const client = url.startsWith('https:') ? https : http

    function makeRequest(currentUrl, redirects = 0) {
      if (redirects > 5) return reject(new Error('閲嶅畾鍚戞鏁拌繃澶?))
      client.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return makeRequest(response.headers.location, redirects + 1)
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`涓嬭浇澶辫触 HTTP ${response.statusCode}`))
        }
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
