/** Private, bounded console transport; Electron console-message does not reliably identify child frames. */

import type { WebFrameMain } from 'electron'

interface ConsoleContents {
  readonly mainFrame: Pick<WebFrameMain, 'url'>
  isDestroyed(): boolean
}

/** A preload-owned primary page warning or error, never a public append operation. */
export interface DesktopRendererConsoleRecord {
  readonly level: 'warning' | 'error'
  readonly text: string
  readonly file: string
  readonly line: number
}

/** Reject malformed and oversized events before they reach the durable sanitizer. */
export function parseRendererConsole(value: unknown): DesktopRendererConsoleRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('level' in value) || (value.level !== 'warning' && value.level !== 'error')
    || !('text' in value) || typeof value.text !== 'string' || value.text.length > 256 * 1024
    || !('file' in value) || typeof value.file !== 'string' || value.file.length > 4096
    || !('line' in value) || typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line < 0) return
  return { level: value.level, text: value.text, file: value.file, line: value.line }
}

/** Authenticate the actual IPC frame, rather than the console-message event's source-frame getter. */
export function primaryRendererConsole(
  event: { readonly sender: ConsoleContents; readonly senderFrame: Pick<WebFrameMain, 'url'> | null },
  primary: ConsoleContents | undefined,
  value: unknown,
): DesktopRendererConsoleRecord | undefined {
  if (primary === undefined || primary.isDestroyed() || event.sender !== primary
    || event.senderFrame === null || event.senderFrame !== primary.mainFrame) return
  let url: URL
  try { url = new URL(event.senderFrame.url) } catch { return }
  if (url.protocol !== 'dsh-app:' || url.hostname !== 'app') return
  return parseRendererConsole(value)
}
