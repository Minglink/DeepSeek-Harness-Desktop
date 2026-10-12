/** Collect only the primary application page's console, before its first module executes. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, SCHEME } from './ipc.ts'
import { parseRendererConsole, type DesktopRendererConsoleRecord } from './renderer-console.ts'

/** This function is serialized into the main world: all runtime dependencies stay inside its body. */
export function capturePrimaryPageConsole(send: (record: DesktopRendererConsoleRecord) => void): void {
  const maxText = 256 * 1024
  const omitted = 'Renderer console message omitted because it exceeded the diagnostic size limit'
  const describe = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value === null) return 'null'
    if (typeof value === 'undefined' || typeof value === 'number' || typeof value === 'boolean'
      || typeof value === 'bigint' || typeof value === 'symbol') return String(value)
    // Error.stack can be V8's lazy accessor. Ordinary objects' getters and custom formatters stay untouched.
    try {
      if (value instanceof Error && typeof value.stack === 'string') return value.stack
      const stack = Object.getOwnPropertyDescriptor(value, 'stack')?.value as unknown
      if (typeof stack === 'string') return stack
      const message = Object.getOwnPropertyDescriptor(value, 'message')?.value as unknown
      if (typeof message === 'string') return message
    } catch { /* An uninspectable proxy remains a console argument, not a logging failure. */ }
    return typeof value === 'function' ? '[function]' : '[object]'
  }
  for (const level of ['warning', 'error'] as const) {
    const key = level === 'warning' ? 'warn' : 'error'
    const original = console[key]
    console[key] = (...values: unknown[]): void => {
      try {
        let text = ''
        for (const value of values) {
          const part = describe(value)
          if (text.length + part.length + 1 > maxText) { text = omitted; break }
          text += (text === '' ? '' : ' ') + part
        }
        const stack = new Error().stack ?? ''
        const caller = stack.split('\n').slice(2).map(line => line.match(/(?:\(|\s)([^\s()]+):(\d+):\d+\)?$/u)).find(match => match !== null)
        const file = caller?.[1] ?? location.href
        const line = Number(caller?.[2] ?? 0)
        send({ level, text, file: file.length <= 4096 ? file : location.href.slice(0, 4096),
          line: Number.isSafeInteger(line) && line >= 0 ? line : 0 })
      } catch { /* Diagnostics must not change the page's original console behavior. */ }
      original.apply(console, values)
    }
  }
}

/** Function proxy stays in the console closure; there is no renderer-facing append method. */
export function installDesktopConsoleCapture(): void {
  if (!process.isMainFrame || location.protocol !== `${SCHEME}:` || location.hostname !== 'app') return
  contextBridge.executeInMainWorld({ func: capturePrimaryPageConsole, args: [(value: unknown): void => {
    const record = parseRendererConsole(value)
    if (record !== undefined) ipcRenderer.send(DESKTOP_IPC.rendererConsole, record)
  }] })
}
