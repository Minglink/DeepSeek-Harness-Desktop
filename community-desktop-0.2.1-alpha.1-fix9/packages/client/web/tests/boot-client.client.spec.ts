// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import {
  createClientModuleSystem, parseBootManifest,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget, type WebBootEntry, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertEntriesActive, bootClient, type EntryStateLabel } from '../src/boot-client.ts'
import { FIBER_STATE } from '../src/loader-status.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'

function graphOf(ids: readonly string[]): WebBootGraph {
  const entries: WebBootEntry[] = ids.map(id => ({ id, url: `/${id}.js`, rev: '1' }))
  return {
    rev: 'graph',
    entries,
    batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: [...ids] }],
  }
}

/** Module system seeded with inline plugin modules; `loaded` records every transport call. */
function modulesOf(graph: WebBootGraph, staticModules: Record<string, unknown>): { modules: ClientModuleLoader; loaded: string[] } {
  const loaded: string[] = []
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: BOOTSTRAP_ID, exports: {} }, options),
  }
  const modules = target.create({
    boot: graph,
    staticModules,
    loadBundle: async (url) => { loaded.push(url) },
  })
  return { modules, loaded }
}

/** Recording progress sink. */
function stateSink(): { states: Map<string, EntryStateLabel[]>; onEntryState: (name: string, state: EntryStateLabel) => void } {
  const states = new Map<string, EntryStateLabel[]>()
  return {
    states,
    onEntryState: (name, state) => { states.set(name, [...(states.get(name) ?? []), state]) },
  }
}

describe('bootClient', () => {
  it('does not change author activation when a warning contains a circular object', async () => {
    const argument: { self?: object } = {}
    argument.self = argument
    const { modules } = modulesOf(graphOf(['logging']), { logging: { apply: (ctx: Context) => { ctx.logger.warn(argument) } } })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warning.mockRestore() })
    await bootClient({ ctx, modules, manifest: modules.manifest })
    expect(warning).toHaveBeenCalledExactlyOnceWith('[client:logging; logger:loader] Client log message could not be formatted')
  })

  it('exports the real factory failure and cause stack through the public Cordis logger', async () => {
    const original = new TypeError("Cannot read properties of undefined (reading 'subscribe')")
    original.stack = "TypeError: Cannot read properties of undefined (reading 'subscribe')\n    at authorApply (plugins/novel/client.js:4614:25)"
    const failure = new Error('author factory failed', { cause: original })
    const { modules } = modulesOf(graphOf(['novel']), { novel: { apply: () => { throw failure } } })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow('novel: failed')

    const output = error.mock.calls.map(args => args.join(' ')).join('\n')
    expect(output).toContain('[client:novel; logger:loader]')
    expect(output).toContain("Cannot read properties of undefined (reading 'subscribe')")
    expect(output).toContain('plugins/novel/client.js:4614:25')
    expect(output).toContain('author factory failed')
  })

  it('exports only warning and error messages and releases its exporter with the root context', async () => {
    const { modules } = modulesOf(graphOf(['logging']), { logging: { apply: (ctx: Context) => {
      ctx.logger.info('ordinary progress')
      ctx.logger.debug('debug detail')
      ctx.logger.warn('warning from %s', 'author')
      ctx.logger.error(new Error('author runtime error'))
    } } })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { warning.mockRestore(); error.mockRestore() })

    await bootClient({ ctx, modules, manifest: modules.manifest })
    expect(warning.mock.calls.flat().join('\n')).toBe('[client:logging; logger:loader] warning from author')
    expect(error.mock.calls.flat().join('\n')).toContain('[client:logging; logger:loader] Error: author runtime error')
    expect([...warning.mock.calls, ...error.mock.calls].flat().join('\n')).not.toContain('ordinary progress')
    expect([...warning.mock.calls, ...error.mock.calls].flat().join('\n')).not.toContain('debug detail')

    await ctx.fiber.dispose()
    warning.mockClear()
    error.mockClear()
    ctx.logger.warn('after dispose')
    ctx.logger.error('after dispose')
    expect(warning).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('activates every seeded row without touching the bundle transport', async () => {
    const graph = graphOf(['provider', 'consumer'])
    const { modules, loaded } = modulesOf(graph, {
      provider: { apply: (ctx: Context) => { ctx.reflect.provide('x', { marker: 'x' }) } },
      consumer: { inject: ['x'], apply: () => {} },
    })
    const ctx = new Context()
    const sink = stateSink()

    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })

    expect(loaded).toEqual([])
    const consumer = sink.states.get('consumer') ?? []
    expect(consumer[0]).toBe('loading')
    expect(consumer.at(-1)).toBe('active')
    expect(sink.states.get('provider')?.at(-1)).toBe('active')
    await ctx.fiber.dispose()
  })

  it('reports a row waiting on a service the roster never provides', async () => {
    const graph = graphOf(['orphan'])
    const { modules } = modulesOf(graph, { orphan: { inject: ['nothing'], apply: () => {} } })
    const ctx = new Context()

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(
      'orphan: pending (waiting for service: nothing)',
    )
    await ctx.fiber.dispose()
  })

  it('reports and logs an import failure for a row that is neither seeded nor a graph row', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf(['ghost']))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const sink = stateSink()

    await expect(bootClient({ ctx, modules, manifest, onEntryState: sink.onEntryState })).rejects.toThrow(
      'web boot: 1 entry did not activate\nghost: import failed (see console for the import error)',
    )
    expect(sink.states.get('ghost')).toEqual(['loading', 'failed'])
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toHaveProperty('message', expect.stringContaining('client-modules: cannot resolve'))
  })
})

describe('assertEntriesActive', () => {
  interface FakeEntry { name: string; fiber?: { state: number; inject: Record<string, null> } }

  /** Loader-shaped double: entries with scripted fiber states, services by name. */
  function auditCtx(entries: readonly FakeEntry[], services: Record<string, unknown> = {}): Context {
    return {
      loader: {
        * entries() {
          for (const entry of entries) yield { options: { name: entry.name }, fiber: entry.fiber }
        },
      },
      get: (name: string) => services[name],
    } as unknown as Context
  }

  const silent = { importError: () => undefined }

  it('passes when every entry is active', () => {
    expect(() => { assertEntriesActive(auditCtx([{ name: 'a', fiber: { state: FIBER_STATE.ACTIVE, inject: {} } }]), silent) }).not.toThrow()
  })

  it('names import failures, missing services, and other non-active states', () => {
    const ctx = auditCtx([
      { name: 'lost' },
      { name: 'waiting', fiber: { state: FIBER_STATE.PENDING, inject: { present: null, a: null, b: null } } },
      { name: 'opaque', fiber: { state: FIBER_STATE.PENDING, inject: {} } },
      { name: 'broken', fiber: { state: FIBER_STATE.FAILED, inject: {} } },
    ], { present: {} })

    expect(() => { assertEntriesActive(ctx, silent) }).toThrow([
      'web boot: 4 entries did not activate',
      'lost: import failed (see console for the import error)',
      'waiting: pending (waiting for services: a, b)',
      'opaque: pending (waiting for services: unknown)',
      'broken: failed',
    ].join('\n'))
  })

  it('uses the singular form for one failing entry', () => {
    expect(() => { assertEntriesActive(auditCtx([{ name: 'lost' }]), silent) }).toThrow('web boot: 1 entry did not activate\n')
  })

  it('names the recorded import error of a fiberless entry when the module system is supplied', () => {
    const recorded = new Map([['lost', new Error('client-modules: could not load "lost": plugins/??lost/client.js&rev=0: bundle script failed to load')]])
    const modules = { importError: (id: string) => recorded.get(id) }
    expect(() => { assertEntriesActive(auditCtx([{ name: 'lost' }, { name: 'quiet' }]), modules) }).toThrow([
      'web boot: 2 entries did not activate',
      'lost: import failed: client-modules: could not load "lost": plugins/??lost/client.js&rev=0: bundle script failed to load',
      'quiet: import failed (see console for the import error)',
    ].join('\n'))
  })
})
