/** Forward native package output to the owning Electron process before profile entries mount. */
import type { Context } from '@deepseek-ai/cordis'
import type { PluginInstallLogChunk } from '@deepseek-ai/dsh-plugin-manager/types'

const MAX_INSTALL_LOG_CHARS = 64 * 1024

/**
 * Observe package operations without exposing their output through the Web application.
 * @param ctx - Host context that owns the package manager and observer lifetime.
 * @param send - Private child IPC sender; bounded frames preserve text and carry exit only on the final frame.
 */
export function installDesktopInstallLog(ctx: Context, send: (chunk: PluginInstallLogChunk) => void): void {
  ctx.on('plugin-manager/install-log', (chunk) => {
    try {
      if (chunk.text.length <= MAX_INSTALL_LOG_CHARS) { send(chunk); return }
      const { exitCode, ...fields } = chunk
      let offset = 0
      while (offset < chunk.text.length) {
        let end = Math.min(offset + MAX_INSTALL_LOG_CHARS, chunk.text.length)
        const last = chunk.text.charCodeAt(end - 1), next = chunk.text.charCodeAt(end)
        if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
        send({ ...fields, text: chunk.text.slice(offset, end),
          ...(end === chunk.text.length && exitCode !== undefined ? { exitCode } : {}) })
        offset = end
      }
    }
    catch (_error) { console.error('Desktop installation log forwarding failed') }
  })
}
