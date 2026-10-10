/** Main-owned community state is exercised with inert package/RPC adapters and private catalog storage. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityInstallError, type PreparedCommunityBundle, type CommunityInstallOptions } from '../src/community-install.ts'
import type { DshProtocolParams } from '../src/installer.ts'
import { communityIntent, DesktopCommunityService, type CommunityServiceOptions } from '../src/community-service.ts'
import type { CommunityTaskId } from '../src/community-types.ts'
import { CommunityTransactionError } from '../src/community-transaction.ts'
import { communityTrialCleanupFailure, nativeCommunityTrialFailure } from '../src/community-failure.ts'

const roots: string[] = []
const services: DesktopCommunityService[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync()
  await Promise.all(services.splice(0).map(service => service.dispose()))
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function gate(): { promise: Promise<undefined>; resolve(): void } {
  const deferred = Promise.withResolvers<undefined>()
  const release = (): void => { deferred.resolve(undefined) }
  releases.push(release)
  return { promise: deferred.promise, resolve: release }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input
}

const prepared: PreparedCommunityBundle = { spec: '/inert/package.tgz', packageName: 'community-addon', version: '1.0.0', bundle: 'community-addon' }
const selection = { id: 'addon', name: 'Addon' }
const catalogItem = (id: string): object => ({ id, name: id, description: `Description for ${id}`, version: '1.0.0' })

async function fixture(overrides: Partial<CommunityServiceOptions> = {}): Promise<{ service: DesktopCommunityService; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-community-service-'))
  roots.push(directory)
  const service = new DesktopCommunityService({
    directory, account: () => null, changed: () => {}, prepare: async () => prepared,
    invoke: async method => method === 'listBundles' ? [] : { changed: true, application: 'applied' },
    ...overrides,
  })
  services.push(service)
  return { service, directory }
}

async function phase(service: DesktopCommunityService, id: CommunityTaskId): Promise<string | undefined> {
  return (await service.getState()).tasks.find(task => task.id === id)?.phase
}

describe('market plugin management', () => {
  it('keeps its own interface protected while exposing third-party bundle controls', async () => {
    const invoke = vi.fn<CommunityServiceOptions['invoke']>(async () => [
      { name: 'dsh-community', enabled: true, removable: true },
      { name: 'community-addon', enabled: false, removable: true },
    ])
    const { service } = await fixture({ invoke })
    expect((await service.getState()).bundles).toEqual([
      { name: 'dsh-community', enabled: true, removable: false, readOnly: true },
      { name: 'community-addon', enabled: false, removable: true, readOnly: false },
    ])
  })

  it('refuses to disable or remove its own interface before native mutations', async () => {
    const invoke = vi.fn<CommunityServiceOptions['invoke']>(async () => ({ changed: true, application: 'applied' }))
    const changed = vi.fn()
    const { service } = await fixture({ invoke, changed })
    const refusal = { changed: false, application: 'failed', problem: { code: 'market-required' } }
    expect(await service.setEnabled('dsh-community', false)).toEqual(refusal)
    expect(await service.remove('dsh-community')).toEqual(refusal)
    expect(invoke).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('forwards third-party enable and removal requests to the native manager', async () => {
    const invoke = vi.fn<CommunityServiceOptions['invoke']>(async () => ({ changed: true, application: 'applied' }))
    const changed = vi.fn()
    const { service } = await fixture({ invoke, changed })
    expect(await service.setEnabled('community-addon', true)).toEqual({ changed: true, application: 'applied' })
    expect(await service.remove('community-addon')).toEqual({ changed: true, application: 'applied' })
    expect(invoke.mock.calls).toEqual([
      ['setBundleEnabled', { name: 'community-addon', enabled: true }, expect.any(AbortSignal)],
      ['removeBundle', { name: 'community-addon' }, expect.any(AbortSignal)],
    ])
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('community task ownership', () => {
  it('deduplicates active selections and serializes different package transactions', async () => {
    const entered = gate(), release = gate()
    const calls: string[] = []
    const { service } = await fixture({ prepare: async (intent) => {
      calls.push(intent.id)
      if (intent.id === 'addon') { entered.resolve(); await release.promise }
      return prepared
    } })
    const first = service.install(selection)
    const duplicate = service.install(selection)
    const second = service.install({ id: 'other', name: 'Other' })
    expect(duplicate.id).toBe(first.id)
    await entered.promise
    expect(calls).toEqual(['addon'])
    expect(await phase(service, second.id)).toBe('queued')
    release.resolve()
    await expect.poll(() => phase(service, second.id)).toBe('applied')
    expect(calls).toEqual(['addon', 'other'])
    expect(service.install(selection).id).not.toBe(first.id)
  })

  it('cancels queued tasks without invoking their preparation', async () => {
    const entered = gate(), release = gate()
    const calls: string[] = []
    const { service } = await fixture({ prepare: async (intent) => {
      calls.push(intent.id)
      entered.resolve()
      await release.promise
      return prepared
    } })
    service.install(selection)
    await entered.promise
    const queued = service.install({ id: 'other', name: 'Other' })
    await service.cancel(queued.id)
    expect(await phase(service, queued.id)).toBe('cancelled')
    release.resolve()
    await service.dispose()
    expect(calls).toEqual(['addon'])
  })

  it('waits for preparation cleanup before acknowledging cancellation', async () => {
    const entered = gate(), abortObserved = gate(), cleanup = gate()
    let cleaned = false, installed = false
    const { service } = await fixture({
      prepare: async (_intent, options) => {
        entered.resolve()
        await new Promise<void>(resolveAbort => options.signal?.addEventListener('abort', () => { abortObserved.resolve(); resolveAbort() }, { once: true }))
        await cleanup.promise
        cleaned = true
        throw new CommunityInstallError('cancelled', 'Fixture cancelled')
      },
      invoke: async (method) => { if (method === 'installBundle') installed = true; return [] },
    })
    const task = service.install(selection)
    await entered.promise
    let returned = false
    const cancellation = service.cancel(task.id).then(() => { returned = true })
    await abortObserved.promise
    expect(returned).toBe(false)
    expect(await phase(service, task.id)).toBe('cancelling')
    cleanup.resolve()
    await cancellation
    expect(cleaned).toBe(true)
    expect(installed).toBe(false)
    expect(await phase(service, task.id)).toBe('cancelled')
  })

  it('keeps the native result authoritative when cancellation arrives during installation', async () => {
    const entered = gate(), finish = gate(), cancelSeen = gate()
    const { service } = await fixture({ invoke: async (method) => {
      if (method === 'listBundles') return []
      if (method === 'installBundle') { entered.resolve(); await finish.promise; return { changed: true, application: 'restart-required' } }
      if (method === 'cancelInstall') { cancelSeen.resolve(); return true }
      throw new Error('Unexpected fixture RPC')
    } })
    const task = service.install(selection)
    await entered.promise
    let returned = false
    const cancellation = service.cancel(task.id).then(() => { returned = true })
    await cancelSeen.promise
    expect(returned).toBe(false)
    finish.resolve()
    await cancellation
    expect(await phase(service, task.id)).toBe('restart-required')
  })

  it('does not overwrite a settled native result when the cancellation RPC fails later', async () => {
    const entered = gate(), finish = gate(), cancelSeen = gate(), cancelFinish = gate()
    const { service } = await fixture({ invoke: async (method) => {
      if (method === 'listBundles') return []
      if (method === 'installBundle') { entered.resolve(); await finish.promise; return { changed: true, application: 'applied' } }
      if (method === 'cancelInstall') { cancelSeen.resolve(); await cancelFinish.promise; throw new Error('Disconnected cancellation request') }
      throw new Error('Unexpected fixture RPC')
    } })
    const task = service.install(selection)
    await entered.promise
    const cancellation = service.cancel(task.id)
    await cancelSeen.promise
    finish.resolve()
    await expect.poll(() => phase(service, task.id)).toBe('applied')
    cancelFinish.resolve()
    await cancellation
    expect(await phase(service, task.id)).toBe('applied')
  })

  it.each(['disconnected', 'malformed'])('records %s native responses as failures', async (failure) => {
    const { service } = await fixture({ invoke: async (method) => {
      if (method === 'listBundles') return []
      if (failure === 'disconnected') throw new Error('Connection lost')
      return { ok: true }
    } })
    const task = service.install(selection)
    await expect.poll(() => phase(service, task.id)).toBe('failed')
    expect((await service.getState()).tasks.find(item => item.id === task.id)?.problem?.code).toBe('host-unavailable')
  })

  it('exposes account display fields without credentials and marks an unavailable Host', async () => {
    const { service } = await fixture({
      account: () => ({ userId: 'fixture-user', username: 'Community user', email: 'fixture@example.test', token: 'fixture-secret', savedAt: 1 }),
      invoke: async () => { throw new Error('Host unavailable') },
    })
    const state = await service.getState()
    expect(state.account).toEqual({ username: 'Community user', email: 'fixture@example.test' })
    expect(state.hostProblem?.code).toBe('host-unavailable')
    expect(JSON.stringify(state)).not.toContain('fixture-secret')
  })

  it('freezes a queued protocol source at confirmation time', async () => {
    const entered = gate(), release = gate()
    const sources: (string | undefined)[] = []
    const { service } = await fixture({ prepare: async (intent) => {
      if (intent.id === 'blocker') { entered.resolve(); await release.promise }
      else sources.push(intent.downloadUrl)
      return prepared
    } })
    service.install({ id: 'blocker', name: 'Blocker' })
    await entered.promise
    service.open({ ...selection, version: 'latest', repo: '', downloadUrl: 'https://example.com/confirmed.zip' })
    const pending = service.takePending()
    expect(pending?.sourceOrigin).toBe('https://example.com')
    if (pending === null) throw new Error('Expected the pending protocol selection')
    service.install({ id: pending.id, name: pending.name, ...(pending.version === undefined ? {} : { version: pending.version }) })
    service.open({ ...selection, version: 'latest', repo: '', downloadUrl: 'https://example.com/later.zip' })
    release.resolve()
    await expect.poll(async () => (await service.getState()).tasks.every(task => task.phase === 'applied')).toBe(true)
    expect(sources).toEqual(['https://example.com/confirmed.zip'])
  })

  it('waits for owned cleanup during disposal and refuses subsequent tasks', async () => {
    const entered = gate(), abortObserved = gate(), cleanup = gate()
    const { service } = await fixture({ prepare: async (_intent, options) => {
      entered.resolve()
      await new Promise<void>(resolveAbort => options.signal?.addEventListener('abort', () => { abortObserved.resolve(); resolveAbort() }, { once: true }))
      await cleanup.promise
      throw new CommunityInstallError('cancelled', 'Fixture cancelled')
    } })
    service.install(selection)
    await entered.promise
    let disposed = false
    const disposal = service.dispose().then(() => { disposed = true })
    await abortObserved.promise
    expect(disposed).toBe(false)
    expect(() => service.install(selection)).toThrow('Community service is stopping')
    cleanup.resolve()
    await disposal
    expect(disposed).toBe(true)
  })

  it('bounds unresponsive native HTTP observations while leaving the task outcome unknown', async () => {
    const installEntered = gate(), cancelEntered = gate()
    const observedSignals: AbortSignal[] = []
    const { service } = await fixture({ disposeTimeoutMs: 250, invoke: async (method, _args, signal) => {
      if (method === 'listBundles') return []
      if (signal === undefined) throw new Error('Missing owned observation signal')
      observedSignals.push(signal)
      if (method === 'installBundle') installEntered.resolve()
      if (method === 'cancelInstall') cancelEntered.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('HTTP observation stopped without a transaction result')) }, { once: true })
      })
    } })
    const task = service.install(selection)
    await installEntered.promise
    vi.useFakeTimers()
    try {
      let disposed = false
      const disposal = service.dispose().then(() => { disposed = true })
      await cancelEntered.promise
      expect(disposed).toBe(false)
      expect(observedSignals.every(signal => !signal.aborted)).toBe(true)
      await vi.advanceTimersByTimeAsync(249)
      expect(disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await disposal
      expect(observedSignals.every(signal => signal.aborted)).toBe(true)
      expect((await service.getState()).tasks.find(item => item.id === task.id)).toMatchObject({
        phase: 'failed', problem: { code: 'host-unavailable' },
      })
    } finally { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers() }
  })

  it('accepts a native cancellation result before its shutdown deadline and clears the timer', async () => {
    const entered = gate(), cancellation = gate()
    const { service } = await fixture({ disposeTimeoutMs: 250, invoke: async (method) => {
      if (method === 'listBundles') return []
      if (method === 'installBundle') { entered.resolve(); await cancellation.promise; return { changed: false, application: 'cancelled' } }
      if (method === 'cancelInstall') { cancellation.resolve(); return { status: 'cancelled' } }
      throw new Error('Unexpected fixture RPC')
    } })
    const task = service.install(selection)
    await entered.promise
    vi.useFakeTimers()
    try {
      await service.dispose()
      expect(await phase(service, task.id)).toBe('cancelled')
      expect(vi.getTimerCount()).toBe(0)
    } finally { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers() }
  })
})

describe('complete community catalog', () => {
  it('fetches every page and persists a reusable, credential-free snapshot', async () => {
    const pages: number[] = []
    const { service, directory } = await fixture({ fetch: async (input) => {
      const page = Number(new URL(requestUrl(input)).searchParams.get('page'))
      pages.push(page)
      return Response.json({ total: 3, plugins: page === 1 ? [catalogItem('one'), catalogItem('two')] : [catalogItem('three')] })
    } })
    const catalog = await service.catalog(true)
    expect(pages).toEqual([1, 2])
    expect(catalog.plugins.map(plugin => plugin.id)).toEqual(['one', 'two', 'three'])
    expect(catalog.cached).toBe(false)
    const snapshot: unknown = JSON.parse(await readFile(join(directory, 'catalog-v1.json'), 'utf8'))
    expect(snapshot).toMatchObject({ plugins: catalog.plugins })
    const cached = await fixture({ directory, fetch: async () => { throw new Error('Network must not run for a cached read') } })
    expect((await cached.service.catalog()).cached).toBe(true)
  })

  it.each(['missing-page', 'changed-total', 'oversized-result'])('refuses a catalog with %s', async (failure) => {
    const { service, directory } = await fixture({ fetch: async (input) => {
      const page = Number(new URL(requestUrl(input)).searchParams.get('page'))
      if (failure === 'oversized-result') return Response.json({ total: 1, plugins: [catalogItem('one'), catalogItem('two')] })
      return Response.json({ total: failure === 'changed-total' && page === 2 ? 1 : 2, plugins: page === 1 ? [catalogItem('one')] : [] })
    } })
    await expect(service.catalog(true)).rejects.toThrow()
    expect(await readdir(directory)).not.toContain('catalog-v1.json')
  })

  it('preserves the previous complete snapshot when refresh fails', async () => {
    let available = true
    const { service, directory } = await fixture({ fetch: async () => {
      if (!available) throw new Error('Fixture offline')
      return Response.json({ total: 1, plugins: [catalogItem('one')] })
    } })
    const previous = await service.catalog(true)
    const stored = await readFile(join(directory, 'catalog-v1.json'), 'utf8')
    available = false
    await expect(service.catalog(true)).rejects.toThrow('Fixture offline')
    expect(await service.catalog()).toEqual(previous)
    expect(await readFile(join(directory, 'catalog-v1.json'), 'utf8')).toBe(stored)
  })

  it('accepts current catalog identifiers, latest versions, and multiline descriptions', async () => {
    const { service } = await fixture({ fetch: async () => Response.json({ total: 3, plugins: [
      { id: '__probe_uniq_1__', name: 'Probe', description: 'First line\nSecond line', version: 'latest' },
      { id: '_________', name: 'Underscores', description: '' },
      { id: 'dsh-deepseek-web-login', name: 'Login', description: '', version: 'v0.1.77' },
    ] }) })
    const catalog = await service.catalog(true)
    expect(catalog.plugins).toEqual([
      { id: '__probe_uniq_1__', name: 'Probe', description: 'First line\nSecond line' },
      { id: '_________', name: 'Underscores', description: '' },
      { id: 'dsh-deepseek-web-login', name: 'Login', description: '', version: '0.1.77' },
    ])
  })

  it('reports incompatible records while completing all pages and preserves that count in cache', async () => {
    const { service, directory } = await fixture({ fetch: async (input) => {
      const page = Number(new URL(requestUrl(input)).searchParams.get('page'))
      return Response.json({ total: 3, plugins: page === 1
        ? [catalogItem('one'), { id: '../unsafe', name: 'Unsafe', version: 'latest' }]
        : [catalogItem('two')] })
    } })
    const catalog = await service.catalog(true)
    expect(catalog).toMatchObject({ skippedCount: 1, plugins: [{ id: 'one' }, { id: 'two' }] })
    const cached = await fixture({ directory })
    expect(await cached.service.catalog()).toMatchObject({ skippedCount: 1, cached: true })
  })

  it('refuses an entirely incompatible catalog instead of showing a false empty state', async () => {
    const { service } = await fixture({ fetch: async () => Response.json({ total: 1, plugins: [{ id: '../unsafe', name: 'Unsafe' }] }) })
    await expect(service.catalog(true)).rejects.toThrow('no compatible package records')
  })
})

describe('renderer installation intent', () => {
  it.each([
    { ...selection, version: '../../outside' },
    { ...selection, downloadUrl: 'http://unsafe.example/package.zip' },
    { ...selection, repo: 'https://example.com/package.git' },
    { ...selection, token: 'renderer-secret' },
    { id: '../addon', name: 'Addon' },
  ])('rejects an invalid or privileged renderer selection: %j', (value) => {
    expect(() => communityIntent(value)).toThrow('Invalid community selection')
  })
})

describe('durable candidate installation', () => {
  it('retains completed task outcomes after reopening the main-owned service', async () => {
    const first = await fixture({ apply: async (_prepared, _task, _signal, progress) => { progress('trial'); progress('activating') } })
    const task = first.service.install(selection)
    await expect.poll(() => phase(first.service, task.id)).toBe('applied')
    await first.service.dispose()
    const reopened = await fixture({ directory: first.directory })
    expect((await reopened.service.getState()).tasks).toContainEqual(expect.objectContaining({ id: task.id, phase: 'applied' }))
  })

  it('reports restored promotion failures without invoking a live native installation', async () => {
    const invoke = vi.fn(async (_method: string, _args: Record<string, unknown>) => [])
    const { service } = await fixture({ invoke, apply: async () => { throw new CommunityTransactionError('activation-failed', true) } })
    const task = service.install(selection)
    await expect.poll(() => phase(service, task.id)).toBe('failed')
    expect((await service.getState()).tasks[0]).toMatchObject({ restored: true, problem: { code: 'activation-failed' } })
    expect(invoke.mock.calls.some(([method]) => method === 'installBundle')).toBe(false)
  })

  it('reuses the immutable original for one AI retry after a native trial fails', async () => {
    const prepare = vi.fn(async (_intent: DshProtocolParams, options: CommunityInstallOptions) => ({ ...prepared,
      originalSpec: '/inert/original.zip', originalSha256: 'a'.repeat(64), repositoryArchive: true,
      adapted: options.adaptation?.force === true }))
    const apply = vi.fn(async (candidate: PreparedCommunityBundle) => { if (!candidate.adapted) throw new CommunityTransactionError('trial-failed', true) })
    const { service } = await fixture({ prepare, apply, adaptation: () => ({ apiKey: 'fixture-key', harnessVersion: '0.2.1-alpha.1' }) })
    const task = service.install(selection)
    await expect.poll(() => phase(service, task.id)).toBe('applied')
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(prepare.mock.calls[1]?.[1]).toMatchObject({
      originalArchive: { spec: '/inert/original.zip', sha256: 'a'.repeat(64), repositoryArchive: true }, adaptation: { force: true },
    })
    expect(apply).toHaveBeenCalledTimes(2)
    expect((await service.getState()).tasks[0]).toMatchObject({ adapted: true })
  })

  it('keeps a native virtual-store failure visible without requesting model adaptation', async () => {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const prepare = vi.fn(async () => ({ ...prepared, originalSpec: '/inert/original.tgz', originalSha256: 'a'.repeat(64) }))
      const failure = nativeCommunityTrialFailure({ application: 'failed', changed: false,
        error: { code: 'operation-error', diagnostic: 'private-api-key should never appear' },
        packageResult: { exitCode: 1, kind: 'unknown', output: '[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE] C:/private-user/profile token=private-token', logPath: 'private-path' } })
      const { service } = await fixture({ prepare, apply: async () => { throw failure },
        adaptation: () => ({ apiKey: 'private-model-key', harnessVersion: '0.2.1-alpha.1' }) })
      const task = service.install(selection)
      await expect.poll(() => phase(service, task.id)).toBe('failed')
      expect(prepare).toHaveBeenCalledTimes(1)
      expect((await service.getState()).tasks[0]).toMatchObject({ problem: { code: 'trial-failed' }, restored: true })
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[community] Initial installation failure', {
        taskId: task.id, code: 'trial-failed', cause: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', adaptationEligible: false,
      })
      expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private-api-key|private-user|private-token|private-model-key|private-path/)
    } finally { diagnostic.mockRestore() }
  })

  it('preserves the one controlled adaptation attempt for an actual native compatibility rejection result', async () => {
    const incompatible = [{ name: 'community-addon', version: '1.0.0', runtimeVersion: '0.2.1-alpha.1', peers: { '@deepseek-ai/dsh-settings': '^0.1.0' } }]
    const rejection = nativeCommunityTrialFailure({ application: 'failed', changed: false,
      error: { code: 'incompatible-version', incompatible },
      packageResult: { exitCode: 1, kind: 'unknown', output: '', logPath: 'private-log', truncated: false, incompatible } })
    const prepare = vi.fn(async (_intent: DshProtocolParams, options: CommunityInstallOptions) => ({ ...prepared,
      originalSpec: '/inert/original.tgz', originalSha256: 'a'.repeat(64), adapted: options.adaptation?.force === true }))
    const apply = vi.fn(async (candidate: PreparedCommunityBundle) => { if (!candidate.adapted) throw rejection })
    const { service } = await fixture({ prepare, apply, adaptation: () => ({ apiKey: 'fixture-key', harnessVersion: '0.2.1-alpha.1' }) })
    const task = service.install(selection)
    await expect.poll(() => phase(service, task.id)).toBe('applied')
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(prepare.mock.calls[1]?.[1].adaptation).toMatchObject({ force: true })
    expect((await service.getState()).tasks[0]).toMatchObject({ adapted: true })
  })

  it('retains the first trial summary and restoration result when the later adaptation fails', async () => {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const prepare = vi.fn(async (_intent: DshProtocolParams, options: CommunityInstallOptions) => {
        if (options.adaptation?.force) throw new CommunityInstallError('adaptation-failed', 'source too large with private-model-key')
        return { ...prepared, originalSpec: '/inert/original.tgz', originalSha256: 'a'.repeat(64) }
      })
      const { service, directory } = await fixture({ prepare,
        apply: async () => { throw new CommunityTransactionError('trial-failed', true, 'private-loader-stack') },
        adaptation: () => ({ apiKey: 'private-model-key', harnessVersion: '0.2.1-alpha.1' }) })
      const task = service.install(selection)
      await expect.poll(() => phase(service, task.id)).toBe('failed')
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(diagnostic.mock.calls).toEqual([
        ['[community] Initial installation failure', { taskId: task.id, code: 'trial-failed', cause: 'plugin-or-preparation', adaptationEligible: true }],
        ['[community] Installation failure', { taskId: task.id, code: 'adaptation-failed', cause: 'plugin-or-preparation', adaptationEligible: false }],
      ])
      const state = (await service.getState()).tasks[0]
      expect(state).toMatchObject({ problem: { code: 'adaptation-failed' }, restored: true })
      await service.dispose()
      const reopened = await fixture({ directory })
      expect((await reopened.service.getState()).tasks[0]).toMatchObject({ problem: { code: 'adaptation-failed' }, restored: true })
      expect(await readFile(join(directory, 'tasks-v1.json'), 'utf8')).not.toMatch(/private-loader-stack|private-model-key|source too large/)
      expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private-loader-stack|private-model-key|source too large/)
    } finally { diagnostic.mockRestore() }
  })

  it('keeps unfinished cleanup visible and never adapts or reports restoration for an unconfirmed child exit', async () => {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = nativeCommunityTrialFailure({ application: 'failed', packageResult: { exitCode: 1, output: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE private-key' } })
      const failure = communityTrialCleanupFailure(first)
      const prepare = vi.fn(async () => ({ ...prepared, originalSpec: '/inert/original.tgz', originalSha256: 'a'.repeat(64) }))
      const { service, directory } = await fixture({ prepare, apply: async () => { throw failure },
        adaptation: () => ({ apiKey: 'private-model-key', harnessVersion: '0.2.1-alpha.1' }) })
      const task = service.install(selection)
      await expect.poll(() => phase(service, task.id)).toBe('failed')
      expect(prepare).toHaveBeenCalledTimes(1)
      expect((await service.getState()).tasks[0]).toMatchObject({ problem: { code: 'rollback-failed' }, restored: false })
      await service.dispose()
      const reopened = await fixture({ directory })
      expect((await reopened.service.getState()).tasks[0]?.restored).not.toBe(true)
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith('[community] Initial installation failure', {
        taskId: task.id, code: 'rollback-failed', cause: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', cleanup: 'stop', adaptationEligible: false,
      })
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-key')
    } finally { diagnostic.mockRestore() }
  })
})
