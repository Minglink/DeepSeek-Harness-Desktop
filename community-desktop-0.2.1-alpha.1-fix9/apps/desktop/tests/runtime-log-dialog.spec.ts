import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CommunityRuntimeLogStore, formatCommunityRuntimeLog } from '../src/community-runtime-log.ts'
import type { MessageBoxOptions } from 'electron'
import { expect, it, vi } from 'vitest'
import { DesktopRuntimeLogDialog } from '../src/runtime-log-dialog.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const HISTORY = 'DSH client runtime log\n2026-10-11T12:00:00.000Z renderer error plugins/novel/client.js:4614\n[client:novel] TypeError: undefined.subscribe\n    at authorApply (plugins/novel/client.js:4614:25)\n'

function fixture(locale = 'en', history = HISTORY) {
  const operations = {
    messages: () => resolveDesktopLocale(locale).messages,
    read: vi.fn(async () => history),
    show: vi.fn(async (_options: MessageBoxOptions) => ({ response: 0, checkboxChecked: false })),
    copy: vi.fn(async (_text: string) => {}),
    export: vi.fn(async (_text: string) => true),
  }
  return { operations, viewer: new DesktopRuntimeLogDialog(operations) }
}

it.each(['en', 'zh-CN'])('shows original client history and localized native actions without a Host or renderer in %s', async (locale) => {
  const { operations, viewer } = fixture(locale)
  await viewer.show()
  const options = operations.show.mock.calls[0]![0]
  expect(options.detail).toBe(HISTORY)
  expect(options.defaultId).toBe(0)
  expect(options.cancelId).toBe(0)
  expect(options.noLink).toBe(true)
  await expect([options.title, options.message, options.detail, ...options.buttons!].join('\n') + '\n')
    .toMatchFileSnapshot(`expected/runtime-log-dialog-${locale}.txt`)
})

it.each(['en', 'zh-CN'])('shortens only the preview and copies and exports complete retained history in %s', async (locale) => {
  const history = `${'😀 retained warning\n'.repeat(2000)}${HISTORY}`
  const { operations, viewer } = fixture(locale, history)
  operations.show.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
  await viewer.show()
  expect(operations.copy).toHaveBeenCalledExactlyOnceWith(history)
  expect(operations.export).toHaveBeenCalledExactlyOnceWith(history)
  for (const [options] of operations.show.mock.calls) {
    expect(options.detail!.length).toBeLessThanOrEqual(16_000)
    expect(options.detail!.isWellFormed()).toBe(true)
    expect(options.detail).toContain(operations.messages().runtimeLogPreviewTruncated)
    expect(options.detail).toContain('plugins/novel/client.js:4614:25')
  }
  expect(operations.show.mock.calls[1]![0].message).toBe(operations.messages().runtimeLogCopied)
  expect(operations.show.mock.calls[2]![0].message).toBe(operations.messages().runtimeLogExported)
})

it.each(['en', 'zh-CN'])('keeps copy failure, export cancellation and export failure in the viewer in %s', async (locale) => {
  const { operations, viewer } = fixture(locale)
  operations.copy.mockRejectedValueOnce(new Error('clipboard unavailable'))
  operations.export.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('write denied'))
  operations.show.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
  await viewer.show()
  const messages = operations.messages()
  expect(operations.show.mock.calls.map(([options]) => options.message)).toEqual([
    messages.runtimeLogDescription, messages.runtimeLogCopyFailed, messages.runtimeLogExportCancelled, messages.runtimeLogExportFailed,
  ])
  expect(operations.read).toHaveBeenCalledTimes(4)
  expect(operations.export).toHaveBeenNthCalledWith(1, HISTORY)
  expect(operations.export).toHaveBeenNthCalledWith(2, HISTORY)
  expect(operations.show.mock.calls.every(([options]) => options.detail === HISTORY)).toBe(true)
})

it.each(['en', 'zh-CN'])('offers localized refresh after a read failure and does not copy or export stale history in %s', async (locale) => {
  const { operations, viewer } = fixture(locale)
  operations.read.mockRejectedValueOnce(new Error('history unavailable'))
  operations.show.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
  await viewer.show()
  expect(operations.show.mock.calls[0]![0]).toMatchObject({
    message: operations.messages().runtimeLogReadFailed,
    buttons: [operations.messages().runtimeLogBack, operations.messages().runtimeLogRefresh],
  })
  expect(operations.show.mock.calls[1]![0].detail).toBe(HISTORY)
  expect(operations.copy).not.toHaveBeenCalled()
  expect(operations.export).not.toHaveBeenCalled()
})

it('allows Back on a read failure and joins simultaneous Help and recovery requests', async () => {
  const { operations, viewer } = fixture()
  const choice = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
  operations.read.mockRejectedValueOnce(new Error('history unavailable'))
  operations.show.mockImplementationOnce(() => choice.promise)
  const first = viewer.show()
  expect(viewer.show()).toBe(first)
  await vi.waitFor(() => { expect(operations.show).toHaveBeenCalledOnce() })
  expect(operations.copy).not.toHaveBeenCalled()
  expect(operations.export).not.toHaveBeenCalled()
  choice.resolve({ response: 0, checkboxChecked: false })
  await first
  await viewer.show()
  expect(operations.show).toHaveBeenCalledTimes(2)
  expect(operations.show.mock.calls[1]![0].detail).toBe(HISTORY)
})

it('reads, copies and exports durable startup errors before a community service or Host exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-early-log-viewer-'))
  try {
    let secrets = ['early-bare-account-value']
    const store = new CommunityRuntimeLogStore(root, () => secrets, () => {})
    store.append({ source: 'pnpm', level: 'error', text: 'early-bare-account-value UND_ERR_SOCKET before Host ready' })
    secrets = []
    const copy = vi.fn(async (_text: string) => {})
    let response = 0
    const viewer = new DesktopRuntimeLogDialog({
      messages: () => resolveDesktopLocale('en').messages,
      read: async () => { await store.flush(); return formatCommunityRuntimeLog(await store.read()) },
      show: async () => ({ response: [1, 2, 0][response++]!, checkboxChecked: false }),
      copy,
      export: async (text) => { await writeFile(join(root, 'owned-export.log'), text, 'utf8'); return true },
    })
    await viewer.show()
    expect(copy).toHaveBeenCalledOnce()
    const original = copy.mock.calls[0]![0]
    expect(original).toContain('[pnpm]')
    expect(original).toContain('[redacted] UND_ERR_SOCKET before Host ready')
    expect(original).not.toContain('early-bare-account-value')
    expect(await readFile(join(root, 'owned-export.log'), 'utf8')).toBe(original)
    const reopened = new CommunityRuntimeLogStore(root, () => [], () => {})
    expect(formatCommunityRuntimeLog(await reopened.read())).toBe(original)
  } finally {
    expect(resolve(root).startsWith(resolve(join(tmpdir(), 'dsh-early-log-viewer-')))).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
