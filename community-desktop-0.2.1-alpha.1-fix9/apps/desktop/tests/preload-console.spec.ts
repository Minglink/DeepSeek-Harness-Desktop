// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { capturePrimaryPageConsole, installDesktopConsoleCapture } from '../src/preload-console.ts'
import type { DesktopRendererConsoleRecord } from '../src/renderer-console.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { executeInMainWorld: vi.fn(), exposeInMainWorld: vi.fn() }, ipcRenderer: { send: vi.fn() },
}))
vi.mock('electron', () => electron)
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

it('preserves original console arguments and records the actual Error stack without info/debug', () => {
  const warn = vi.fn(), error = vi.fn(), info = vi.fn(), send = vi.fn<(record: DesktopRendererConsoleRecord) => void>()
  vi.stubGlobal('console', { ...console, warn, error, info })
  capturePrimaryPageConsole(send)
  const cause = new Error('undefined.subscribe at the author factory')
  console.warn('Author readiness', 3)
  console.error('Author startup failed', cause)
  console.info('ordinary information')
  expect(warn).toHaveBeenCalledExactlyOnceWith('Author readiness', 3)
  expect(error).toHaveBeenCalledExactlyOnceWith('Author startup failed', cause)
  expect(info).toHaveBeenCalledExactlyOnceWith('ordinary information')
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[0]![0]).toMatchObject({ level: 'warning', text: 'Author readiness 3' })
  expect(send.mock.calls[1]![0].text).toContain(cause.stack)
  expect(send.mock.calls[1]![0]).toMatchObject({ level: 'error' })
})

it('does not evaluate logged object getters or leak a partial oversized secret', () => {
  const error = vi.fn(), getter = vi.fn(() => 'not-a-real-secret'), send = vi.fn<(record: DesktopRendererConsoleRecord) => void>()
  vi.stubGlobal('console', { ...console, error })
  capturePrimaryPageConsole(send)
  console.error({ get stack() { return getter() }, toJSON() { return getter() }, toString() { return getter() } })
  console.error('Bearer ' + 'credential-fragment'.repeat(20000))
  expect(getter).not.toHaveBeenCalled()
  expect(send.mock.calls[0]![0].text).toBe('[object]')
  expect(send.mock.calls[1]![0].text).toBe('Renderer console message omitted because it exceeded the diagnostic size limit')
  expect(JSON.stringify(send.mock.calls)).not.toContain('credential-fragment')
  expect(error).toHaveBeenCalledTimes(2)
})

it('retains original console behavior even when the private diagnostic callback fails', () => {
  const warn = vi.fn(), send = vi.fn(() => { throw new Error('IPC unavailable') })
  vi.stubGlobal('console', { ...console, warn })
  capturePrimaryPageConsole(send)
  expect(() => { console.warn('still visible') }).not.toThrow()
  expect(warn).toHaveBeenCalledExactlyOnceWith('still visible')
})

it('is self-contained when Electron serializes the function into another world', () => {
  const send = vi.fn(), warn = vi.fn(), error = vi.fn()
  const sandbox = { console: { warn, error }, location: { href: 'dsh-app://app/' }, send }
  runInNewContext('(' + capturePrimaryPageConsole.toString() + ')(send);console.error("main-world cause")', sandbox)
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 'error', text: 'main-world cause' }))
  expect(error).toHaveBeenCalledExactlyOnceWith('main-world cause')
})

it('passes a private callback proxy without adding any public diagnostic append API', () => {
  vi.stubGlobal('process', { ...process, isMainFrame: true })
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  installDesktopConsoleCapture()
  expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  expect(electron.contextBridge.executeInMainWorld).toHaveBeenCalledOnce()
  const execution = electron.contextBridge.executeInMainWorld.mock.calls[0]![0] as
    { func: typeof capturePrimaryPageConsole; args: [(value: unknown) => void] }
  expect(execution.func).toBe(capturePrimaryPageConsole)
  execution.args[0]({ level: 'error', text: 'original cause', file: 'author/client.js', line: 7 })
  execution.args[0]({ level: 'info', text: 'ignored', file: '', line: 0 })
  expect(electron.ipcRenderer.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.rendererConsole,
    { level: 'error', text: 'original cause', file: 'author/client.js', line: 7 })
})

it.each([{ isMainFrame: false, url: 'dsh-app://app/' }, { isMainFrame: true, url: 'dsh-app://shell/' }, { isMainFrame: true, url: 'https://example.com/' }])(
  'does not instrument child or non-application documents (%j)', ({ isMainFrame, url }) => {
    vi.stubGlobal('process', { ...process, isMainFrame })
    vi.stubGlobal('location', new URL(url))
    installDesktopConsoleCapture()
    expect(electron.contextBridge.executeInMainWorld).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled()
  },
)
