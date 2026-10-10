/** Real Cordis, Connection, credential persistence, and WebServer ownership; no HTTP calls. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as Connection from '../src/index.ts'

let root: Context | undefined
let home: string | undefined

afterEach(async () => {
  await root?.fiber.dispose()
  root = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function mounted(): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-connection-owner-'))
  root = new Context()
  await root.plugin(LocalCredentials, { path: join(home, '.credentials.yaml'), watch: false })
  await root.plugin(Connection)
  return root
}

/** Own fixture callbacks are never dispatched through the HTTP carrier. */
const handler: Connection.ConnectionRpcHandler = async () => {
  throw new Error('ownership fixture must not dispatch an RPC')
}

/** Observes the real route registry through its public duplicate-route contract. */
function expectRegistered(server: WebServer, path: string): void {
  expect(() => server.register({ kind: 'prefix', path, handler: () => {} }))
    .toThrow(`duplicate prefix route "${path}"`)
}

function expectWithdrawn(server: WebServer, path: string): void {
  const remove = server.register({ kind: 'prefix', path, handler: () => {} })
  remove()
}

describe('Connection caller-owned legacy RPC channels', () => {
  it('registers through a caller whose WebServer dependency differs from the Connection provider', async () => {
    const ctx = await mounted()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const server = ctx.get('webServer', true)!
    const caller = ctx.plugin({ inject: ['connection', 'webServer'], apply(owner) {
      owner.connection.rpc.handle('/owned-rpc', handler)
    } })
    await caller.await()
    expect(caller.state).toBe(FiberState.ACTIVE)
    expectRegistered(server, '/owned-rpc')
    await caller.dispose()
    expectWithdrawn(server, '/owned-rpc')
    expectRegistered(server, '/api')
  })

  it('makes the returned disposer idempotent without withdrawing another caller route', async () => {
    const ctx = await mounted()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const server = ctx.get('webServer', true)!
    let remove: (() => Promise<void>) | undefined
    const caller = ctx.plugin({ inject: ['connection', 'webServer'], apply(owner) {
      remove = owner.connection.rpc.handle('/owned-first', handler)
      owner.connection.rpc.handle('/owned-second', handler)
    } })
    await caller.await()
    await remove!()
    await remove!()
    expectWithdrawn(server, '/owned-first')
    expectRegistered(server, '/owned-second')
    await caller.dispose()
    expectWithdrawn(server, '/owned-second')
  })

  it('remounts on an actual WebServer restart when the caller declares its transport dependency', async () => {
    const ctx = await mounted()
    const carrier = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await carrier.await()
    const first = ctx.get('webServer', true)!
    let activations = 0
    const caller = ctx.plugin({ inject: ['connection', 'webServer'], apply(owner) {
      activations++
      owner.connection.rpc.handle('/owned-reload', handler)
    } })
    await caller.await()
    expectRegistered(first, '/owned-reload')
    await carrier.restart()
    await caller.await()
    const second = ctx.get('webServer', true)!
    expect(second).not.toBe(first)
    expect(activations).toBe(2)
    expectWithdrawn(first, '/owned-reload')
    expectRegistered(second, '/owned-reload')
    await caller.dispose()
    expectWithdrawn(second, '/owned-reload')
  })

  it('refuses registration without an active HTTP transport and preserves carrier-neutral Connection', async () => {
    const ctx = await mounted()
    expect(ctx.get('connection', true)).toBeDefined()
    expect(() => ctx.get('connection', true)!.rpc.handle('/owned-missing', handler))
      .toThrow('requires an active webServer')
    const carrier = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await carrier.await()
    await carrier.dispose()
    expect(() => ctx.get('connection', true)!.rpc.handle('/owned-withdrawn', handler))
      .toThrow('requires an active webServer')
    expect(ctx.get('connection', true)).toBeDefined()
  })

  it('refuses a real service whose providing fiber has not activated', async () => {
    const ctx = await mounted()
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const carrier = ctx.plugin(async (owner) => {
      new WebServer(owner, { host: '127.0.0.1', port: 0 })
      entered.resolve(undefined)
      await release.promise
    })
    try {
      await entered.promise
      expect(ctx.get('webServer', false)).toBeInstanceOf(WebServer)
      expect(ctx.get('webServer', true)).toBeUndefined()
      expect(() => ctx.get('connection', true)!.rpc.handle('/owned-inactive', handler))
        .toThrow('requires an active webServer')
    } finally {
      release.resolve(undefined)
      await carrier.await()
      await carrier.dispose()
    }
  })

  it('respects the caller transport isolation instead of looking up a root-level server', async () => {
    const ctx = await mounted()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const server = ctx.get('webServer', true)!
    const isolated = ctx.isolate('webServer')
    const caller = isolated.plugin({ inject: ['connection'], apply(owner) {
      expect(owner.get('webServer', true)).toBeUndefined()
      expect(() => owner.connection.rpc.handle('/owned-isolated', handler))
        .toThrow('requires an active webServer')
    } })
    await caller.await()
    expectWithdrawn(server, '/owned-isolated')
    await caller.dispose()
    expectRegistered(server, '/api')
  })

  it('refuses invalid and duplicate channels without stealing an existing route', async () => {
    const ctx = await mounted()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const server = ctx.get('webServer', true)!
    const owner = ctx.plugin({ inject: ['connection', 'webServer'], apply(caller) {
      expect(() => caller.connection.rpc.handle('/api', handler)).toThrow('invalid or reserved RPC channel')
      expect(() => caller.connection.rpc.handle('outside', handler)).toThrow('invalid or reserved RPC channel')
      caller.connection.rpc.handle('/owned-duplicate', handler)
      expect(() => caller.connection.rpc.handle('/owned-duplicate', handler)).toThrow('duplicate prefix route')
    } })
    await owner.await()
    expectRegistered(server, '/owned-duplicate')
    await owner.dispose()
    expectWithdrawn(server, '/owned-duplicate')
    expectRegistered(server, '/api')
  })
})
