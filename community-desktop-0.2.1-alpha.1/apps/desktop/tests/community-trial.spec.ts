/** Trial probes retain the real authenticated HTTP bridge over an OS-assigned fixture listener and owned Host lifecycle hooks. */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { assertCommunityBundleReady, observeCommunityOperation, trialCommunityBundle, type CommunityTrialHostFactory } from '../src/community-trial.ts'
import { communityFailureSummary } from '../src/community-failure.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
    server.closeAllConnections()
  })))
})
const prepared = { spec: 'private-fixture.tgz', packageName: '@example/trial', version: '1.2.3', bundle: '@example/trial' }
const rows = [{ rowId: 'fixture-entry', moduleName: '@example/trial', entryId: 'fixture-entry' }]
const bundle = { name: prepared.packageName, version: prepared.version, enabled: true, installed: true, optional: false, removable: true, rows, overrides: [] }
const entry = { entryId: 'fixture-entry', moduleName: '@example/trial', enabled: true, fiberPhase: 'active' }

async function fixture(values: {
  install?: unknown
  inventory?: unknown
  entries?: unknown
  onInstall?: () => Promise<void>
  authenticationStatus?: number
  rpcStatus?: number
  startFailureAt?: number
  stopFailure?: boolean
} = {}): Promise<{
  createHost: CommunityTrialHostFactory; events: string[]; methods: string[]; fail: (error: Error) => void
}> {
  const methods: string[] = [], events: string[] = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      if (values.authenticationStatus !== undefined) { response.writeHead(values.authenticationStatus); response.end(); return }
      response.writeHead(303, { 'set-cookie': 'fixture_auth=private-cookie; HttpOnly; SameSite=Strict', location: '/' }); response.end(); return
    }
    expect(request.headers.cookie).toBe('fixture_auth=private-cookie')
    if (values.rpcStatus !== undefined) { response.writeHead(values.rpcStatus); response.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    methods.push(payload.method)
    let value: unknown
    if (payload.method === 'pluginManager/installBundle') {
      expect(payload.payload.args).toEqual({ spec: prepared.spec, options: { enabled: true } })
      await values.onInstall?.()
      value = values.install ?? { application: 'applied', changed: true }
    } else if (payload.method === 'pluginManager/listBundles') value = values.inventory ?? [bundle]
    else if (payload.method === 'pluginManager/listPlugins') value = values.entries ?? [entry]
    else throw new Error('Unexpected fixture method')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value } }))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture listener has no TCP address')
  let count = 0, failure: (error: Error) => void = () => {}
  const createHost: CommunityTrialHostFactory = failed => {
    const number = ++count
    failure = failed
    return {
      start: async () => { events.push(`start-${number}`); if (values.startFailureAt === number) throw new Error('Fixture plugin or Host failure'); return { url: `http://127.0.0.1:${address.port}/?token=fixture-launch-token` } },
      stop: async () => { events.push(`stop-${number}`); if (values.stopFailure) throw new Error('Fixture Host stop failed') },
    }
  }
  return { createHost, events, methods, fail: error => failure(error) }
}

describe('community candidate Host trial', () => {
  it('installs, fully restarts, checks native registered rows and awaits both owned Host stops', async () => {
    const data = await fixture()
    await trialCommunityBundle(data.createHost, prepared, new AbortController().signal)
    expect(data.events).toEqual(['start-1', 'stop-1', 'start-2', 'stop-2'])
    expect(data.methods).toEqual(['pluginManager/installBundle', 'pluginManager/listBundles', 'pluginManager/listPlugins'])
  })

  it('allows an install requiring restart only after the fresh Host reports actual active rows', async () => {
    const data = await fixture({ install: { application: 'restart-required', changed: true } })
    await trialCommunityBundle(data.createHost, prepared, new AbortController().signal)
    expect(data.events).toEqual(['start-1', 'stop-1', 'start-2', 'stop-2'])
  })

  it.each([
    { application: 'failed', changed: false }, { application: 'overridden', changed: true },
    { application: 'applied', changed: true, error: { code: 'operation-error' } }, {},
  ])('does not promote a refused or failed native install: %j', async install => {
    const data = await fixture({ install })
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toMatchObject({ code: 'trial-failed' })
    expect(data.events).toEqual(['start-1', 'stop-1'])
    expect(data.methods).toEqual(['pluginManager/installBundle'])
  })

  it('stops the restarted candidate when its Loader entry failed', async () => {
    const data = await fixture({ entries: [{ ...entry, fiberPhase: 'failed' }] })
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toMatchObject({ code: 'trial-failed' })
    expect(data.events).toEqual(['start-1', 'stop-1', 'start-2', 'stop-2'])
  })

  it.each([
    { packageResult: { exitCode: 1, kind: 'unknown', output: '[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE] private directory' } },
    { packageResult: { exitCode: 1, kind: 'permission', output: 'private stderr' } },
    { packageResult: { exitCode: 0, kind: 'timeout', timedOut: true, output: '' } },
    { error: { code: 'stale-approval' } },
  ])('marks native deployment and policy failures ineligible for source adaptation: %j', async (result) => {
    const data = await fixture({ install: { application: 'failed', changed: false, ...result } })
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toMatchObject({ code: 'trial-failed', restored: true, adaptationEligible: false })
    expect(data.events).toEqual(['start-1', 'stop-1'])
  })

  it('keeps an explicit native compatibility refusal eligible for the existing adaptation path', async () => {
    const incompatible = [{ name: '@example/trial', version: '1.2.3', runtimeVersion: '0.2.1-alpha.1', peers: { '@deepseek-ai/dsh-settings': '^0.1.0' } }]
    const data = await fixture({ install: { application: 'failed', changed: false,
      error: { code: 'incompatible-version', incompatible },
      packageResult: { exitCode: 1, kind: 'unknown', output: '', truncated: false, logPath: 'private-log', incompatible } } })
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toMatchObject({ code: 'trial-failed', adaptationEligible: true })
  })

  it.each([
    { authenticationStatus: 401 }, { rpcStatus: 503 }, { startFailureAt: 1 },
  ])('does not rewrite plugin source to repair owned Host or transport failures: %j', async (options) => {
    const data = await fixture(options)
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toMatchObject({ code: 'trial-failed', adaptationEligible: false })
  })

  it('reports unfinished recovery rather than restoration when the owned Host cannot confirm exit', async () => {
    const data = await fixture({ stopFailure: true })
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toMatchObject({
      code: 'rollback-failed', restored: false, adaptationEligible: false,
    })
    expect(data.events).toEqual(['start-1', 'stop-1', 'stop-1'])
    expect(data.methods).toEqual(['pluginManager/installBundle'])
  })

  it('preserves the first native pnpm cause when teardown also fails', async () => {
    const data = await fixture({ stopFailure: true, install: { application: 'failed', changed: false,
      error: { code: 'operation-error' }, packageResult: { exitCode: 1, kind: 'unknown', output: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE private-home' } } })
    let error: unknown
    try { await trialCommunityBundle(data.createHost, prepared, new AbortController().signal) }
    catch (failure) { error = failure }
    expect(error).toMatchObject({ code: 'rollback-failed', restored: false, adaptationEligible: false })
    expect(communityFailureSummary(error)).toEqual({ code: 'rollback-failed', cause: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', cleanup: 'stop', adaptationEligible: false })
    expect(data.events).toEqual(['start-1', 'stop-1'])
    expect(data.methods).toEqual(['pluginManager/installBundle'])
  })

  it('leaves a concrete plugin startup failure eligible after native installation', async () => {
    const data = await fixture({ startFailureAt: 2 })
    await expect(trialCommunityBundle(data.createHost, prepared, new AbortController().signal)).rejects.toThrow('Fixture plugin or Host failure')
    expect(data.events).toEqual(['start-1', 'stop-1', 'start-2', 'stop-2'])
  })

  it('cancels a pending native install and stops its Host before rejecting', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController()
    const data = await fixture({ onInstall: async () => { entered.resolve(); await release.promise } })
    const operation = trialCommunityBundle(data.createHost, prepared, controller.signal)
    const rejection = expect(operation).rejects.toThrow()
    await entered.promise
    controller.abort(new Error('Fixture cancellation'))
    await rejection
    release.resolve()
    expect(data.events).toEqual(['start-1', 'stop-1'])
  })

  it('routes candidate fatal events into its own cancellation and teardown', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const data = await fixture({ onInstall: async () => { entered.resolve(); await release.promise } })
    const operation = trialCommunityBundle(data.createHost, prepared, new AbortController().signal)
    const rejection = expect(operation).rejects.toThrow()
    await entered.promise
    data.fail(new Error('Candidate fatal failure'))
    await rejection
    release.resolve()
    expect(data.events).toEqual(['start-1', 'stop-1'])
  })

  it.each([
    { value: {}, entries: [entry] }, { value: [], entries: [entry] },
    { value: [{ ...bundle, version: '1.2.4' }], entries: [entry] },
    { value: [{ ...bundle, enabled: false }], entries: [entry] },
    { value: [{ ...bundle, error: { code: 'incompatible-version' } }], entries: [entry] },
    { value: [{ ...bundle, rows: [] }], entries: [entry] },
    { value: [bundle], entries: [] }, { value: [bundle], entries: {} },
    { value: [bundle], entries: [{ ...entry, enabled: false, fiberPhase: null }] },
    { value: [bundle], entries: [{ ...entry, fiberPhase: 'pending' }] },
    { value: [bundle], entries: [{ ...entry, fiberPhase: 'loading' }] },
    { value: [bundle], entries: [{ ...entry, fiberPhase: 'failed' }] },
    { value: [bundle], entries: [{ ...entry, moduleName: 'other-plugin' }] },
    { value: [bundle], entries: [{ ...entry, enabled: 'yes' }] },
  ])('rejects missing, disabled, incompatible or non-active registrations: %j', ({ value, entries }) => {
    expect(() => assertCommunityBundleReady(value, prepared.packageName, prepared.version, entries)).toThrow()
  })

  it('accepts optional disabled bundle rows alongside an actual active feature', () => {
    assertCommunityBundleReady([{ ...bundle, rows: [...rows, { rowId: 'optional', moduleName: 'optional-plugin', entryId: 'optional' }] }],
      prepared.packageName, prepared.version, [entry, { entryId: 'optional', moduleName: 'optional-plugin', enabled: false, fiberPhase: null }])
  })

  it('observes a completed owned operation and unregisters its cancellation observer', async () => {
    const controller = new AbortController()
    expect(await observeCommunityOperation(Promise.resolve('ready'), controller.signal)).toBe('ready')
    controller.abort(new Error('Later cancellation'))
  })
})
