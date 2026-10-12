import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { parseRendererConsole, primaryRendererConsole, type DesktopRendererConsoleRecord } from '../src/renderer-console.ts'
import { RendererConsoleTail, renderCrashReport } from '../src/crash-report.ts'
import { sanitizeCommunityLog } from '../src/community-task-log.ts'

const record = { level: 'error', text: 'Author factory failed\n    at author/client.js:42:3', file: 'dsh-app://app/author/client.js', line: 42 }

it('accepts bounded warnings and original multi-line error stacks', () => {
  expect(parseRendererConsole(record)).toEqual(record)
  expect(parseRendererConsole({ ...record, level: 'warning' })).toEqual({ ...record, level: 'warning' })
  expect(parseRendererConsole({ ...record, text: 'a'.repeat(256 * 1024), file: 'a'.repeat(4096) })).toBeDefined()
})

it.each([null, [], {}, { ...record, level: 'info' }, { ...record, text: 7 }, { ...record, text: 'a'.repeat(256 * 1024 + 1) },
  { ...record, file: 'a'.repeat(4097) }, { ...record, line: -1 }, { ...record, line: Infinity }, { ...record, line: 1.5 }])(
  'rejects malformed or oversized console payloads (%j)', (value) => { expect(parseRendererConsole(value)).toBeUndefined() },
)

it('uses the actual IPC sender/frame and rejects the owned same-origin iframe', () => {
  const mainFrame = { url: 'dsh-app://app/' }, childFrame = { url: 'dsh-app://app/' }
  const primary = { mainFrame, isDestroyed: () => false }
  const other = { mainFrame, isDestroyed: () => false }
  expect(primaryRendererConsole({ sender: primary, senderFrame: mainFrame }, primary, record)).toEqual(record)
  expect(primaryRendererConsole({ sender: primary, senderFrame: childFrame }, primary, record)).toBeUndefined()
  expect(primaryRendererConsole({ sender: other, senderFrame: mainFrame }, primary, record)).toBeUndefined()
  expect(primaryRendererConsole({ sender: primary, senderFrame: null }, primary, record)).toBeUndefined()
  expect(primaryRendererConsole({ sender: primary, senderFrame: mainFrame }, undefined, record)).toBeUndefined()
  expect(primaryRendererConsole({ sender: primary, senderFrame: mainFrame },
    { mainFrame, isDestroyed: () => true }, record)).toBeUndefined()
})

it.each(['https://example.com/', 'dsh-app://shell/', 'not a URL'])('rejects top-frame console from an unowned document (%s)', (url) => {
  const mainFrame = { url }, primary = { mainFrame, isDestroyed: () => false }
  expect(primaryRendererConsole({ sender: primary, senderFrame: mainFrame }, primary, record)).toBeUndefined()
})

/** Exercise the actual main listener and event-time secret supplier without starting the Electron shell. */
function mainConsoleCapture() {
  const text = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let secrets: ts.FunctionDeclaration | undefined, registration: ts.CallExpression | undefined
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'desktopRuntimeLogSecrets') secrets = node
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.on'
      && node.arguments[0]?.getText(source) === 'DESKTOP_IPC.rendererConsole') registration = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (secrets === undefined || registration === undefined) throw new Error('Primary console main seam not found')
  const program = ts.transpileModule(`${secrets.getText(source)}\n${registration.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText
  let account: { token: string } | null = { token: 'bare-account-credential' }
  let configuration: { apiKey?: string } = { apiKey: 'bare-model-credential' }
  const mainFrame = { url: 'dsh-app://app/' }, primary = { mainFrame, isDestroyed: () => false }
  const tail = new RendererConsoleTail(), records: DesktopRendererConsoleRecord[] = []
  let listener: ((event: unknown, value: unknown) => void) | undefined
  runInNewContext(program, {
    runtimeLogSecrets: new Set<string>(), readCommunityAccount: () => account, readConfig: () => configuration,
    primaryRendererConsole, mainWindow: { webContents: primary }, rendererConsole: tail, sanitizeCommunityLog,
    community: { recordRendererLog: (value: DesktopRendererConsoleRecord) => { records.push(value) } },
    DESKTOP_IPC: { rendererConsole: 'owned-console-channel' },
    ipcMain: { on: (_channel: string, handler: (event: unknown, value: unknown) => void) => { listener = handler } },
  })
  if (listener === undefined) throw new Error('Primary console listener was not registered')
  return { tail, records, send: listener, primary, mainFrame,
    logout: () => { account = null; configuration = {} } }
}

it('sanitizes the actual main crash tail synchronously and retains bare credentials after immediate logout', () => {
  const capture = mainConsoleCapture()
  const event = { sender: capture.primary, senderFrame: capture.mainFrame }
  capture.send(event, { ...record, file: 'dsh-app://app/client.js?token=bare-account-credential',
    text: 'bare-account-credential bare-model-credential Author factory failed\n    at client.js:42:3' })
  capture.logout()
  capture.send(event, { ...record, text: 'later bare-account-credential bare-model-credential original cause retained' })
  expect(capture.records).toHaveLength(2)
  const crash = renderCrashReport({ source: 'renderer', phase: 'running', error: new Error('Owned crash fixture'),
    rendererConsole: capture.tail.snapshot(), time: new Date(0),
    app: { name: 'owned-test', version: '1', platform: 'win32', arch: 'x64', electron: '44', node: '24', locale: 'en' } })
  expect(crash).toContain('Author factory failed\n    at client.js:42:3')
  expect(crash).toContain('original cause retained')
  expect(crash).toContain('[redacted]')
  expect(crash).not.toContain('bare-account-credential')
  expect(crash).not.toContain('bare-model-credential')
})

it('keeps warnings out of the main crash tail and rejects child events before either diagnostic sink', () => {
  const capture = mainConsoleCapture()
  capture.send({ sender: capture.primary, senderFrame: capture.mainFrame }, { ...record, level: 'warning' })
  capture.send({ sender: capture.primary, senderFrame: { url: 'dsh-app://app/' } }, record)
  expect(capture.records).toHaveLength(1)
  expect(capture.records[0]?.level).toBe('warning')
  expect(capture.tail.snapshot()).toEqual([])
})
