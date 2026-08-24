import { execFile } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'

/**
 * Ensures that the `dsh://` protocol is registered in Windows Registry
 * under HKCU\Software\Classes\dsh.
 */
export function registerWindowsProtocol(exePath?: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(true)

  const executable = exePath || process.execPath
  const iconPath = path.join(path.dirname(executable), 'resources', 'icon.ico')

  return new Promise((resolve) => {
    // 1. Call Electron's built-in protocol registrar
    try {
      if (process.defaultApp) {
        if (process.argv.length >= 2) {
          app.setAsDefaultProtocolClient('dsh', process.execPath, [path.resolve(process.argv[1])])
        }
      } else {
        app.setAsDefaultProtocolClient('dsh')
      }
    } catch (e) {
      console.warn('[registry] app.setAsDefaultProtocolClient failed:', e)
    }

    // 2. Direct reg add fallback to ensure HKCU\Software\Classes\dsh is written
    const regCommands = [
      ['add', 'HKCU\\Software\\Classes\\dsh', '/ve', '/d', 'DeepSeek Harness Protocol', '/f'],
      ['add', 'HKCU\\Software\\Classes\\dsh', '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
      ['add', 'HKCU\\Software\\Classes\\dsh\\DefaultIcon', '/ve', '/d', `"${iconPath}",0`, '/f'],
      ['add', 'HKCU\\Software\\Classes\\dsh\\shell\\open\\command', '/ve', '/d', `"${executable}" "%1"`, '/f'],
    ]

    let completed = 0
    let hasError = false

    for (const args of regCommands) {
      execFile('reg.exe', args, (error) => {
        if (error) hasError = true
        completed++
        if (completed === regCommands.length) {
          if (!hasError) {
            console.log('[registry] Windows dsh:// protocol registered successfully in HKCU')
          }
          resolve(!hasError)
        }
      })
    }
  })
}
