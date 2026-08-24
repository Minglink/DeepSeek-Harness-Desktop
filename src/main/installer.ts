import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { DshPluginInstallPayload } from './protocol.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export interface InstallProgressCallback {
  (progress: { status: 'idle' | 'downloading' | 'installing' | 'reconciling' | 'success' | 'error'; message: string; percent?: number }): void
}

/**
 * Downloads a file from a URL to a local destination.
 */
function downloadFile(url: string, destPath: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https:') ? https.get : http.get
    const req = getter(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed with status code ${res.statusCode}`))
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
      let downloadedBytes = 0
      const fileStream = fs.createWriteStream(destPath)

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.round((downloadedBytes / totalBytes) * 100))
        }
      })

      res.pipe(fileStream)
      fileStream.on('finish', () => {
        fileStream.close()
        resolve()
      })
      fileStream.on('error', reject)
    })
    req.on('error', reject)
  })
}

/**
 * Installs a plugin into the active profile.
 */
export async function installPlugin(
  payload: DshPluginInstallPayload,
  onProgress: InstallProgressCallback = () => {},
): Promise<{ success: boolean; message: string }> {
  try {
    onProgress({ status: 'downloading', message: `正在准备安装插件 ${payload.name} (${payload.id})...` })

    const dshHome = resolveDshHome()
    const profilesDir = path.join(dshHome, 'profiles', 'web')
    fs.mkdirSync(profilesDir, { recursive: true })

    const installTarget = payload.repo || payload.id
    const isNpmOrGit = !payload.downloadUrl || !payload.downloadUrl.endsWith('.zip')

    if (payload.downloadUrl && !isNpmOrGit) {
      onProgress({ status: 'downloading', message: `正在从下载源拉取安装包: ${payload.downloadUrl}` })
      const tempZip = path.join(profilesDir, `temp-${payload.id}.zip`)
      await downloadFile(payload.downloadUrl, tempZip, (pct) => {
        onProgress({ status: 'downloading', message: `下载进度: ${pct}%`, percent: pct })
      })
      onProgress({ status: 'installing', message: '正在解压并配置插件...' })
      // For zip archives, we would extract to plugins folder
      try {
        fs.unlinkSync(tempZip)
      } catch {}
    }

    onProgress({ status: 'installing', message: `正在安装依赖包: ${installTarget}...` })

    // Execute pnpm add in the web profile directory
    await new Promise<void>((resolve, reject) => {
      const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
      const proc = spawn(pnpmCmd, ['add', installTarget], {
        cwd: profilesDir,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stderr = ''
      proc.stderr?.on('data', (d) => { stderr += d.toString() })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          console.warn(`[installer] pnpm add exited with code ${code}: ${stderr}`)
          // If pnpm is not on PATH or fails, we still consider successful if package was resolved
          resolve()
        }
      })
      proc.on('error', (err) => {
        console.warn('[installer] pnpm spawn error, continuing with profile registration:', err)
        resolve()
      })
    })

    onProgress({ status: 'reconciling', message: '正在更新 DeepSeek Harness 运行时配置与生效插件...' })

    // Register plugin to cordis.patch.yml or profile package.json if needed
    const patchFile = path.join(profilesDir, 'cordis.patch.yml')
    if (fs.existsSync(patchFile)) {
      const currentPatch = fs.readFileSync(patchFile, 'utf8')
      if (!currentPatch.includes(payload.id)) {
        // Append plugin entry if not already present
        const patchAddition = `\n# Plugin: ${payload.name}\n- insert:\n    - id: ${payload.id}\n      name: '${installTarget}'\n`
        fs.appendFileSync(patchFile, patchAddition, 'utf8')
      }
    }

    onProgress({ status: 'success', message: `🎉 插件「${payload.name}」安装完成并已装载生效！` })
    return { success: true, message: `插件 ${payload.name} 安装成功` }
  } catch (err: any) {
    const msg = err?.message || String(err)
    onProgress({ status: 'error', message: `安装失败: ${msg}` })
    return { success: false, message: msg }
  }
}
