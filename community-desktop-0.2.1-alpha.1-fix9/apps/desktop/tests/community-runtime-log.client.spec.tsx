// @vitest-environment jsdom
/** Runtime diagnostics remain independent of installation and Host state. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityRuntimeLogPanel } from '../plugins/dsh-community/src/client/CommunityRuntimeLogPanel.tsx'
import { communityEn, communityZh } from '../src/community-locales.ts'
import type { CommunityRuntimeLog, DesktopCommunityApi } from '../src/community-types.ts'

afterEach(cleanup)
const entry = { sequence: 1, time: 1, source: 'renderer' as const, level: 'error' as const,
  text: 'Timeline order invariant failed', file: 'Timeline.js', line: 82 }
function fixture() {
  let log: CommunityRuntimeLog = { entries: [entry], nextCursor: 1, truncated: false, unavailable: false }
  const listeners = new Set<() => void>()
  const api = {
    getRuntimeLog: vi.fn<NonNullable<DesktopCommunityApi['getRuntimeLog']>>(async (after = 0) => ({ ...log, entries: log.entries.filter(item => item.sequence > after) })),
    copyRuntimeLog: vi.fn<NonNullable<DesktopCommunityApi['copyRuntimeLog']>>(async () => {}),
    exportRuntimeLog: vi.fn<NonNullable<DesktopCommunityApi['exportRuntimeLog']>>(async () => true),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { api, listenerCount: () => listeners.size,
    update(value: CommunityRuntimeLog): void { log = value; for (const listener of listeners) listener() } }
}

describe('client runtime log panel', () => {
  it.each(['en', 'zh-CN'])('labels retained startup and package errors independently of a task in %s', async (locale) => {
    const f = fixture(), copy = locale === 'en' ? communityEn : communityZh
    f.update({ entries: [{ ...entry, source: 'system', text: 'startup pnpm deadline: 300000ms' },
      { ...entry, source: 'pnpm', sequence: 2, text: 'UND_ERR_SOCKET original startup cause' }], nextCursor: 2,
    truncated: false, unavailable: false })
    render(<CommunityRuntimeLogPanel api={f.api} locale={locale} />)
    fireEvent.click(screen.getByRole('button', { name: copy.runtimeLogShow }))
    expect(await screen.findByText('UND_ERR_SOCKET original startup cause')).toBeTruthy()
    expect(screen.getByText(copy.runtimeLogSystem)).toBeTruthy()
    expect(screen.getByText(copy.runtimeLogPnpm)).toBeTruthy()
  })
  it.each(['en', 'zh-CN'])('shows saved original errors and their location in %s without reading while collapsed', async (locale) => {
    const f = fixture(), copy = locale === 'en' ? communityEn : communityZh
    render(<CommunityRuntimeLogPanel api={f.api} locale={locale} />)
    expect(f.api.getRuntimeLog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.runtimeLogShow }))
    const log = await screen.findByRole('log', { name: copy.runtimeLogTitle })
    expect(await within(log).findByText(entry.text)).toBeTruthy()
    expect(within(log).getByText('Timeline.js:82')).toBeTruthy()
    expect(f.api.getRuntimeLog).toHaveBeenCalledWith(undefined)
    expect({ title: copy.runtimeLogTitle, source: within(log).getByText(copy.runtimeLogRenderer).textContent,
      text: within(log).getByText(entry.text).textContent, location: within(log).getByText('Timeline.js:82').textContent }).toMatchSnapshot()
  })

  it('appends live cursor entries once and releases its subscription on collapse and unmount', async () => {
    const f = fixture(), view = render(<CommunityRuntimeLogPanel api={f.api} locale="en" />)
    fireEvent.click(screen.getByRole('button', { name: communityEn.runtimeLogShow }))
    await screen.findByText(entry.text)
    await act(async () => { f.update({ entries: [entry, { ...entry, sequence: 2, text: 'remote.session unavailable', file: 'ModelSwitcher.js' }], nextCursor: 2, truncated: false, unavailable: false }) })
    expect(await screen.findByText('remote.session unavailable')).toBeTruthy()
    expect(screen.getAllByText(entry.text)).toHaveLength(1)
    expect(f.api.getRuntimeLog).toHaveBeenLastCalledWith(1)
    expect(f.listenerCount()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: communityEn.runtimeLogHide }))
    expect(f.listenerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: communityEn.runtimeLogShow }))
    await screen.findByText('remote.session unavailable')
    expect(f.api.getRuntimeLog).toHaveBeenLastCalledWith(undefined)
    view.unmount()
    expect(f.listenerCount()).toBe(0)
  })

  it('exposes bounded history and failed storage while keeping available original output', async () => {
    const f = fixture()
    f.update({ entries: [entry], nextCursor: 1, truncated: true, unavailable: true })
    render(<CommunityRuntimeLogPanel api={f.api} locale="en" />)
    fireEvent.click(screen.getByRole('button', { name: communityEn.runtimeLogShow }))
    expect(await screen.findByText(communityEn.taskLogUnavailable)).toBeTruthy()
    expect(screen.getByText(communityEn.taskLogTruncated)).toBeTruthy()
    expect(screen.getByText(entry.text)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogPause }))
    expect(screen.getByRole('button', { name: communityEn.taskLogResume }).getAttribute('aria-pressed')).toBe('true')
  })

  it('reports copy and export failures and cancellation, using runtime APIs without a task id', async () => {
    const f = fixture()
    render(<CommunityRuntimeLogPanel api={f.api} locale="en" />)
    fireEvent.click(screen.getByRole('button', { name: communityEn.runtimeLogShow }))
    await screen.findByText(entry.text)
    f.api.copyRuntimeLog.mockRejectedValueOnce(new Error('native clipboard unavailable'))
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogCopy }))
    expect(await screen.findByText(communityEn.runtimeLogCopyFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogCopy }))
    expect(await screen.findByText(communityEn.runtimeLogCopied)).toBeTruthy()
    expect(f.api.copyRuntimeLog).toHaveBeenLastCalledWith()
    f.api.exportRuntimeLog.mockRejectedValueOnce(new Error('export failed'))
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogExport }))
    expect(await screen.findByText(communityEn.runtimeLogExportFailed)).toBeTruthy()
    f.api.exportRuntimeLog.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogExport }))
    expect(await screen.findByText(communityEn.taskLogExportCancelled)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogExport }))
    expect(await screen.findByText(communityEn.runtimeLogExported)).toBeTruthy()
    expect(f.api.exportRuntimeLog).toHaveBeenLastCalledWith()
  })

  it('recovers a read failure on refresh without overlapping requests', async () => {
    const f = fixture()
    f.api.getRuntimeLog.mockRejectedValueOnce(new Error('read failed'))
    render(<CommunityRuntimeLogPanel api={f.api} locale="en" />)
    fireEvent.click(screen.getByRole('button', { name: communityEn.runtimeLogShow }))
    await screen.findByText(communityEn.runtimeLogReadFailed)
    fireEvent.click(screen.getByRole('button', { name: communityEn.refresh }))
    await screen.findByText(entry.text)
    await waitFor(() => { expect(screen.queryByText(communityEn.runtimeLogReadFailed)).toBeNull() })
    const gate = Promise.withResolvers<CommunityRuntimeLog>()
    f.api.getRuntimeLog.mockReturnValueOnce(gate.promise)
    act(() => { f.update({ entries: [entry], nextCursor: 1, truncated: false, unavailable: false }) })
    const calls = f.api.getRuntimeLog.mock.calls.length
    act(() => { f.update({ entries: [entry], nextCursor: 1, truncated: false, unavailable: false }) })
    expect(f.api.getRuntimeLog.mock.calls).toHaveLength(calls)
    await act(async () => { gate.resolve({ entries: [], nextCursor: 1, truncated: false, unavailable: false }) })
    await waitFor(() => { expect(f.api.getRuntimeLog.mock.calls.length).toBe(calls + 1) })
  })

  it('opens on an older Desktop API with an update instruction and no reads or subscriptions', () => {
    const subscribe = vi.fn(() => () => {})
    render(<CommunityRuntimeLogPanel api={{ subscribe }} locale="zh-CN" />)
    fireEvent.click(screen.getByRole('button', { name: communityZh.runtimeLogShow }))
    expect(screen.getByText(communityZh.runtimeLogUnsupported)).toBeTruthy()
    expect(screen.getByRole('button', { name: communityZh.taskLogCopy }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: communityZh.taskLogExport }).hasAttribute('disabled')).toBe(true)
    expect(subscribe).not.toHaveBeenCalled()
  })
})
