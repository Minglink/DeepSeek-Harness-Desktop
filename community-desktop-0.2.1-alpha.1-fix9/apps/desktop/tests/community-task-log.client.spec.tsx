// @vitest-environment jsdom
/** Owner-local installation diagnostics, driven only by the credential-free log bridge. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommunityTask, CommunityTaskId, CommunityTaskLog, CommunityTaskLogEntry } from '../src/community-types.ts'
import { CommunityTaskLogPanel, type CommunityTaskLogPanelProps } from '../plugins/dsh-community/src/client/CommunityTaskLogPanel.tsx'
import { communityEn, communityZh } from '../plugins/dsh-community/src/client/community-locales.ts'

afterEach(cleanup)

const TASK: CommunityTask = {
  id: 'historical-purge-task' as CommunityTaskId,
  plugin: { id: 'dsh-purge', name: 'DSH Purge', version: '1.0.0' },
  phase: 'failed', createdAt: 1_799_999_000_000, updatedAt: 1_799_999_001_000,
  problem: { code: 'install-failed' },
}

function entry(sequence = 1, overrides: Partial<CommunityTaskLogEntry> = {}): CommunityTaskLogEntry {
  return {
    sequence, time: 1_799_999_000_000, phase: 'installing', level: 'error', source: 'pnpm',
    text: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE: virtual store directory differs\ncommand: pnpm install\ncwd: [profile]',
    code: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', exitCode: 1, ...overrides,
  }
}

function log(entries: readonly CommunityTaskLogEntry[] = [entry()], overrides: Partial<CommunityTaskLog> = {}): CommunityTaskLog {
  return { id: TASK.id, entries, nextCursor: entries.at(-1)?.sequence ?? 0, truncated: false, unavailable: false, ...overrides }
}

function fixture(history = log()) {
  const listeners = new Set<() => void>()
  const api = {
    getTaskLog: vi.fn<CommunityTaskLogPanelProps['api']['getTaskLog']>(async () => history),
    copyTaskLog: vi.fn<CommunityTaskLogPanelProps['api']['copyTaskLog']>(async () => {}),
    exportTaskLog: vi.fn<CommunityTaskLogPanelProps['api']['exportTaskLog']>(async () => true),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  } satisfies CommunityTaskLogPanelProps['api']
  return { api, listenerCount: (): number => listeners.size, emit(): void { for (const listener of listeners) listener() } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function show(f: ReturnType<typeof fixture>, locale = 'en'): Promise<ReturnType<typeof render>> {
  const view = render(<CommunityTaskLogPanel api={f.api} task={TASK} locale={locale} />)
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? communityEn.taskLogShow : communityZh.taskLogShow }))
  await waitFor(() => { expect(f.api.getTaskLog).toHaveBeenCalled() })
  return view
}

describe('community task log panel', () => {
  it.each(['en', 'zh-CN'])('explains an older desktop bridge without invoking missing log APIs (%s)', async (locale) => {
    const copy = locale === 'en' ? communityEn : communityZh
    const oldApi = { subscribe: vi.fn(() => () => {}) }
    render(<CommunityTaskLogPanel api={oldApi as unknown as CommunityTaskLogPanelProps['api']} task={TASK} locale={locale} />)
    fireEvent.click(screen.getByRole('button', { name: copy.taskLogShow }))
    expect(screen.getByRole('status').textContent).toBe(copy.taskLogUnsupported)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(oldApi.subscribe).not.toHaveBeenCalled()
    const controls = [copy.taskLogPause, copy.taskLogCopy, copy.taskLogExport, copy.refresh]
    for (const name of controls) expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
    expect({ message: screen.getByRole('status').textContent,
      controls: controls.map(name => ({ text: name, disabled: screen.getByRole('button', { name }).hasAttribute('disabled') })),
    }).toMatchSnapshot()
  })

  it('does not read or subscribe to logs until that task is expanded', async () => {
    const f = fixture()
    render(<CommunityTaskLogPanel api={f.api} task={TASK} locale="en" />)
    expect(f.api.getTaskLog).not.toHaveBeenCalled()
    expect(f.listenerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogShow }))
    expect(await screen.findByText(entry().text, { normalizer: value => value })).toBeTruthy()
    expect(f.api.getTaskLog).toHaveBeenCalledExactlyOnceWith(TASK.id, undefined)
    expect(f.listenerCount()).toBe(1)
  })

  it.each(['en', 'zh-CN'])('shows durable errors, source, phase, exit code and localized controls (%s)', async (locale) => {
    const copy = locale === 'en' ? communityEn : communityZh
    const f = fixture(log([entry()], { truncated: true, unavailable: true }))
    await show(f, locale)
    const output = await screen.findByRole('log')
    await within(output).findByText(entry().text, { normalizer: value => value })
    expect(within(output).getByText(copy.installing)).toBeTruthy()
    expect(within(output).getByText(copy.taskLogPnpm)).toBeTruthy()
    expect(within(output).getByText(copy.taskLogExit.replace('{code}', '1'))).toBeTruthy()
    expect(screen.getByText(copy.taskLogUnavailable)).toBeTruthy()
    expect(screen.getByText(copy.taskLogTruncated)).toBeTruthy()
    expect({
      title: output.getAttribute('aria-label'),
      buttons: screen.getAllByRole('button').map(button => button.textContent),
      notices: [...screen.getAllByRole('alert'), ...screen.getAllByRole('status')].map(notice => notice.textContent),
      metadata: [...output.querySelectorAll('span')].map(item => item.textContent),
      text: output.querySelector('pre')?.textContent,
    }).toMatchSnapshot()
  })

  it('renders log output as plain text without interpreting HTML', async () => {
    const text = '<script>window.compromised = true</script>\n<img src=x onerror="alert(1)">'
    const f = fixture(log([entry(1, { text })]))
    await show(f)
    const output = screen.getByRole('log')
    expect(await within(output).findByText(text, { normalizer: value => value })).toBeTruthy()
    expect(output.querySelector('script, img')).toBeNull()
  })

  it('appends live cursor updates once, in sequence order', async () => {
    const f = fixture()
    await show(f)
    await screen.findByText(entry().text, { normalizer: value => value })
    f.api.getTaskLog.mockResolvedValue(log([entry(3, { text: 'Host plugin is active', source: 'host', phase: 'activating', level: 'info', exitCode: undefined }), entry(2, { text: 'Package installed', level: 'info' }), entry()], { nextCursor: 3 }))
    await act(async () => { f.emit() })
    expect(f.api.getTaskLog).toHaveBeenLastCalledWith(TASK.id, 1)
    const output = screen.getByRole('log')
    expect([...output.querySelectorAll('pre')].map(item => item.textContent)).toEqual([entry().text, 'Package installed', 'Host plugin is active'])
  })

  it('coalesces notifications during a pending read and uses its settled cursor', async () => {
    const initial = deferred<CommunityTaskLog>()
    const f = fixture()
    f.api.getTaskLog.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(log([entry(2, { text: 'second output' })]))
    await show(f)
    await act(async () => { f.emit(); f.emit(); f.emit() })
    expect(f.api.getTaskLog).toHaveBeenCalledTimes(1)
    await act(async () => { initial.resolve(log()) })
    expect(await screen.findByText('second output')).toBeTruthy()
    expect(f.api.getTaskLog.mock.calls).toEqual([[TASK.id, undefined], [TASK.id, 1]])
  })

  it('can pause automatic scrolling while new output continues to arrive', async () => {
    const f = fixture()
    await show(f)
    await screen.findByText(entry().text, { normalizer: value => value })
    const output = screen.getByRole('log')
    Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 100 })
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogPause }))
    output.scrollTop = 13
    f.api.getTaskLog.mockResolvedValue(log([entry(2, { text: 'continued output' })]))
    await act(async () => { f.emit() })
    expect(screen.getByText('continued output')).toBeTruthy()
    expect(output.scrollTop).toBe(13)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogResume }))
    expect(output.scrollTop).toBe(100)
  })

  it('keeps available output on a read failure and retries from the same cursor', async () => {
    const f = fixture()
    await show(f)
    await screen.findByText(entry().text, { normalizer: value => value })
    f.api.getTaskLog.mockRejectedValueOnce(new Error('disk read failed'))
    await act(async () => { f.emit() })
    expect(screen.getByRole('alert').textContent).toBe(communityEn.taskLogReadFailed)
    expect(screen.getByText(entry().text, { normalizer: value => value })).toBeTruthy()
    f.api.getTaskLog.mockResolvedValue(log([entry(2, { text: 'recovered output' })]))
    fireEvent.click(screen.getByRole('button', { name: communityEn.refresh }))
    expect(await screen.findByText('recovered output')).toBeTruthy()
    expect(f.api.getTaskLog).toHaveBeenLastCalledWith(TASK.id, 1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('bounds the visible tail and explains entries omitted by the renderer', async () => {
    const f = fixture(log(Array.from({ length: 2_001 }, (_, index) => entry(index + 1, { text: `line-${index + 1}` }))))
    await show(f)
    await screen.findByText('line-2001')
    expect(screen.getByRole('log').querySelectorAll('li')).toHaveLength(2_000)
    expect(screen.queryByText('line-1')).toBeNull()
    expect(screen.getByText(communityEn.taskLogTruncated)).toBeTruthy()
  })

  it('reports empty history and a missing process exit status explicitly', async () => {
    const f = fixture(log([]))
    await show(f)
    expect(await screen.findByText(communityEn.taskLogEmpty)).toBeTruthy()
    f.api.getTaskLog.mockResolvedValue(log([entry(1, { exitCode: null })]))
    await act(async () => { f.emit() })
    expect(screen.getByText(communityEn.taskLogExit.replace('{code}', communityEn.taskLogUnknownExit))).toBeTruthy()
  })

  it.each(['en', 'zh-CN'])('copies and exports with localized success, cancel and failure feedback (%s)', async (locale) => {
    const copy = locale === 'en' ? communityEn : communityZh
    const f = fixture()
    await show(f, locale)
    await screen.findByText(entry().text, { normalizer: value => value })
    fireEvent.click(screen.getByRole('button', { name: copy.taskLogCopy }))
    expect(await screen.findByText(copy.taskLogCopied)).toBeTruthy()
    expect(f.api.copyTaskLog).toHaveBeenCalledExactlyOnceWith(TASK.id)
    f.api.copyTaskLog.mockRejectedValueOnce(new Error('clipboard unavailable'))
    fireEvent.click(screen.getByRole('button', { name: copy.taskLogCopy }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', copy.taskLogCopyFailed)
    fireEvent.click(screen.getByRole('button', { name: copy.taskLogExport }))
    expect(await screen.findByText(copy.taskLogExported)).toBeTruthy()
    expect(f.api.exportTaskLog).toHaveBeenCalledExactlyOnceWith(TASK.id)
    f.api.exportTaskLog.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: copy.taskLogExport }))
    expect(await screen.findByText(copy.taskLogExportCancelled)).toBeTruthy()
    f.api.exportTaskLog.mockRejectedValueOnce(new Error('write failed'))
    fireEvent.click(screen.getByRole('button', { name: copy.taskLogExport }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', copy.taskLogExportFailed)
  })

  it('prevents overlapping copy/export operations until the current operation settles', async () => {
    const pending = deferred<undefined>()
    const f = fixture()
    f.api.copyTaskLog.mockReturnValueOnce(pending.promise)
    await show(f)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogCopy }))
    expect(screen.getByRole('button', { name: communityEn.taskLogCopy }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogExport }))
    expect(f.api.exportTaskLog).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(screen.getByRole('button', { name: communityEn.taskLogExport }).hasAttribute('disabled')).toBe(false)
  })

  it('releases subscriptions on collapse and unmount, then reloads durable history on reopen', async () => {
    const f = fixture()
    const view = await show(f)
    await screen.findByText(entry().text, { normalizer: value => value })
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogHide }))
    expect(f.listenerCount()).toBe(0)
    await act(async () => { f.emit() })
    expect(f.api.getTaskLog).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogShow }))
    expect(await screen.findByText(entry().text, { normalizer: value => value })).toBeTruthy()
    expect(f.api.getTaskLog).toHaveBeenLastCalledWith(TASK.id, undefined)
    expect(f.listenerCount()).toBe(1)
    view.unmount()
    expect(f.listenerCount()).toBe(0)
  })

  it('ignores a read that settles after the task panel has been closed', async () => {
    const pending = deferred<CommunityTaskLog>()
    const f = fixture()
    f.api.getTaskLog.mockReturnValueOnce(pending.promise)
    await show(f)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogHide }))
    await act(async () => { pending.resolve(log([entry(1, { text: 'late output' })])) })
    expect(screen.queryByRole('log')).toBeNull()
    expect(screen.queryByText('late output')).toBeNull()
    expect(f.listenerCount()).toBe(0)
  })
})
