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
 * Downloads and installs a plugin into ~/.dsh/plugins and configures cordis.patch.yml
 */
export async function downloadAndInstallPlugin(payload, onProgress) {
  const dshHome = getDshHome()
  const pluginId = payload.id
  const targetDir = path.join(dshHome, 'plugins', pluginId)
  
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  // Determine download source
  let downloadUrl = payload.downloadUrl
  if (!downloadUrl && payload.repo && payload.repo.includes('/')) {
    downloadUrl = `https://github.com/${payload.repo}/archive/refs/heads/main.zip`
  }

  if (downloadUrl) {
    onProgress?.('正在下载插件安装包...')
    const tempZip = path.join(os.tmpdir(), `dsh_plugin_${pluginId}_${Date.now()}.zip`)
    await downloadFile(downloadUrl, tempZip)
    
    onProgress?.('正在解压并写入文件...')
    const tempExtract = path.join(os.tmpdir(), `dsh_extract_${pluginId}_${Date.now()}`)
    fs.mkdirSync(tempExtract, { recursive: true })
    
    try {
      execFileSync('tar.exe', ['-xf', tempZip, '-C', tempExtract], { stdio: 'ignore' })
    } catch {
      execFileSync('powershell.exe', ['-Command', `Expand-Archive -Force -Path "${tempZip}" -DestinationPath "${tempExtract}"`], { stdio: 'ignore' })
    }
    
    // Check extracted contents (flatten if wrapped in single directory)
    let srcDir = tempExtract
    const items = fs.readdirSync(tempExtract)
    if (items.length === 1 && fs.statSync(path.join(tempExtract, items[0])).isDirectory()) {
      srcDir = path.join(tempExtract, items[0])
    }
    
    copyRecursiveSync(srcDir, targetDir)
    
    try { fs.unlinkSync(tempZip) } catch {}
    try { fs.rmSync(tempExtract, { recursive: true, force: true }) } catch {}
  } else {
    // Generate minimal plugin index.js if no download source provided
    const entryFile = path.join(targetDir, 'index.js')
    if (!fs.existsSync(entryFile)) {
      fs.writeFileSync(entryFile, `export const name = "${pluginId}";\nexport function apply(ctx) {\n  console.log("Loaded plugin ${pluginId}");\n}\n`, 'utf8')
    }
  }

  // Update ~/.dsh/profiles/web/cordis.patch.yml
  onProgress?.('正在配置插件启动项与环境...')
  updateCordisPatch(dshHome, pluginId, targetDir)

  // Ensure ~/.dsh/node_modules/@deepseek-ai is linked
  ensureDshModules(dshHome)

  onProgress?.('插件安装完成！已就绪')
}

function updateCordisPatch(dshHome, pluginId, pluginDir) {
  const profileDir = path.join(dshHome, 'profiles', 'web')
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true })
  }
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  
  let entryName = pluginId
  const pkgJsonPath = path.join(pluginDir, 'package.json')
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
      if (pkg.name) entryName = pkg.name
    } catch {}
  }
  if (entryName === pluginId) {
    const indexPath = path.join(pluginDir, 'index.js').replace(/\\/g, '/')
    if (fs.existsSync(path.join(pluginDir, 'index.js'))) {
      entryName = indexPath
    }
  }

  let content = ''
  if (fs.existsSync(patchFile)) {
    content = fs.readFileSync(patchFile, 'utf8')
  }

  // If already present, don't duplicate
  if (content.includes(entryName) || content.includes(pluginId)) {
    return
  }

  let trimmed = content.trim()
  if (!trimmed || trimmed === '[]') {
    content = `- insert:\n    name: "${entryName}"\n`
  } else {
    content = content + `\n- insert:\n    name: "${entryName}"\n`
  }

  fs.writeFileSync(patchFile, content, 'utf8')
}

function ensureDshModules(dshHome) {
  try {
    const dshModules = path.join(dshHome, 'node_modules')
    if (!fs.existsSync(dshModules)) fs.mkdirSync(dshModules, { recursive: true })
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
      if (redirects > 5) return reject(new Error('重定向次数过多'))
      client.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return makeRequest(response.headers.location, redirects + 1)
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`下载失败 HTTP ${response.statusCode}`))
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
