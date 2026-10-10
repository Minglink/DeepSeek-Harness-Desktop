// @vitest-environment jsdom
/** Built market factory smoke; regenerate its artifact with `node --import tsx apps/desktop/scripts/build-market.ts`. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as reactDom from 'react-dom'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CommunityChange, CommunityNavigationId, DesktopCommunityApi } from '../src/community-types.ts'

interface ModuleHandoff {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => unknown
}

interface SlotEntry {
  readonly options: Readonly<Record<string, unknown>>
  readonly component: () => React.ReactNode
}

interface MarketTestContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  inject(services: string[], callback: (context: { slots: MarketTestContext['slots'] }) => void): void
  provide(name: string, value: unknown): void
  readonly slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, component: () => React.ReactNode): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string) => string
    subscribe(listener: () => void): () => void
    getSnapshot(): { active: string }
  }
  readonly theme: { getTheme(): null; setTheme(id: string): void }
  readonly layout: { selectPanel(id: string): void }
}

interface BuiltMarket {
  readonly name: string
  readonly inject: readonly string[]
  readonly apply: (context: MarketTestContext) => void
}

function setWindowValue(name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(window, name)
  onTestFinished(() => {
    if (previous === undefined) Reflect.deleteProperty(window, name)
    else Object.defineProperty(window, name, previous)
  })
  Object.defineProperty(window, name, { configurable: true, writable: true, value })
}

function handoffFrom(value: unknown): ModuleHandoff {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string'
    || !('factory' in value) || typeof value.factory !== 'function') throw new Error('Invalid built market handoff')
  return { id: value.id, factory: value.factory as ModuleHandoff['factory'] }
}

function marketFrom(value: unknown): BuiltMarket {
  if (typeof value !== 'object' || value === null || !('apply' in value) || typeof value.apply !== 'function'
    || !('name' in value) || typeof value.name !== 'string' || !('inject' in value)
    || !Array.isArray(value.inject) || !value.inject.every(service => typeof service === 'string')) {
    throw new Error('Invalid built market exports')
  }
  return { name: value.name, inject: value.inject, apply: value.apply as BuiltMarket['apply'] }
}

function loadBuiltMarket() {
  const originalStyles = new Set(document.querySelectorAll('style[data-plugin="dsh-community"]'))
  onTestFinished(() => {
    for (const style of document.querySelectorAll('style[data-plugin="dsh-community"]')) {
      if (!originalStyles.has(style)) style.remove()
    }
  })
  const captured: { handoff?: ModuleHandoff } = {}
  setWindowValue('__ModuleLoader__', { load: (value: unknown) => { captured.handoff = handoffFrom(value) } })
  const code = readFileSync(resolve('apps/desktop/plugins/dsh-community/client/client.js'), 'utf8')
  // This fixture executes the generated browser factory through its shipped module-loader entry.
  new Function(code)()
  assert(captured.handoff !== undefined)
  const modules = new Map<string, unknown>([
    ['react', React], ['react/jsx-runtime', jsxRuntime], ['react-dom', reactDom],
    ['@deepseek-ai/dsh-client-ui-primitives', primitives],
  ])
  const requested: string[] = []
  const exports = captured.handoff.factory((specifier) => {
    if (!modules.has(specifier)) throw new Error(`Unsupported built market import: ${specifier}`)
    requested.push(specifier)
    return modules.get(specifier)
  })
  return { id: captured.handoff.id, plugin: marketFrom(exports), requested }
}

function contextFixture() {
  const entries: SlotEntry[] = []
  const disposers: Array<() => void> = []
  const dictionaries = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()
  const provided = new Map<string, unknown>()
  const localeSnapshot = { active: 'en' }
  const localeListeners = new Set<() => void>()
  const selectPanel = vi.fn((_id: string) => {})
  let disposed = false
  const ctx: MarketTestContext = {
    effect(callback) {
      const result = callback()
      if (typeof result === 'function') disposers.push(result as () => void)
    },
    on: () => () => {},
    inject: (_services, callback) => { callback({ slots: ctx.slots }) },
    provide: (name, value) => { provided.set(name, value) },
    slots: {
      inject: (_name, register) => { register() },
      register(options, component) {
        const entry = { options, component }
        entries.push(entry)
        const remove = (): void => {
          const index = entries.indexOf(entry)
          if (index !== -1) entries.splice(index, 1)
        }
        disposers.push(remove)
        return remove
      },
    },
    locale: {
      register(namespace, values) {
        dictionaries.set(namespace, values)
        return () => { dictionaries.delete(namespace) }
      },
      bind: namespace => key => dictionaries.get(namespace)?.en[key] ?? key,
      subscribe: (listener) => { localeListeners.add(listener); return () => { localeListeners.delete(listener) } },
      getSnapshot: () => localeSnapshot,
    },
    theme: { getTheme: () => null, setTheme: () => {} },
    layout: { selectPanel },
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.reverse()) disposer()
  }
  onTestFinished(dispose)
  return { ctx, entries, selectPanel, provided, dispose }
}

function desktopFixture(coldOpen: boolean) {
  let sequence = coldOpen ? 1 : 0
  let pendingOpen: CommunityNavigationId | null = coldOpen ? 'navigation-1' as CommunityNavigationId : null
  const openListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const acknowledge = (request: CommunityNavigationId): void => {
    if (pendingOpen === request) pendingOpen = null
  }
  const api: DesktopCommunityApi = {
    getState: vi.fn(async () => ({ account: null, bundles: [], tasks: [] })),
    catalog: vi.fn(async () => ({ plugins: [], updatedAt: 1_799_999_000_000, cached: false })),
    detail: vi.fn(async () => { throw new Error('This fixture has no selected plugin') }),
    openWebsite: vi.fn(async () => {}),
    install: vi.fn(async () => { throw new Error('This bundle smoke does not install packages') }),
    cancel: vi.fn(async () => {}),
    setEnabled: vi.fn(async (): Promise<CommunityChange> => ({ application: 'applied', changed: false })),
    remove: vi.fn(async (): Promise<CommunityChange> => ({ application: 'applied', changed: false })),
    login: vi.fn<DesktopCommunityApi['login']>(async () => ({ ok: true })),
    logout: vi.fn(async () => {}),
    takePending: vi.fn(async () => null),
    claimOpen: vi.fn(async () => pendingOpen),
    acknowledgeOpen: vi.fn(async (request) => { acknowledge(request) }),
    subscribe: (listener) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
    subscribeOpen: (listener) => { openListeners.add(listener); return () => { openListeners.delete(listener) } },
  }
  setWindowValue('dshDesktop', { protocolVersion: 1, community: api })
  return {
    api,
    acknowledge,
    pendingRequest: (): CommunityNavigationId | null => pendingOpen,
    notify(): void { for (const listener of openListeners) listener() },
    open(): void {
      pendingOpen = `navigation-${++sequence}` as CommunityNavigationId
      for (const listener of openListeners) listener()
    },
    openListenerCount: (): number => openListeners.size,
    stateListenerCount: (): number => stateListeners.size,
  }
}

afterEach(cleanup)

describe('built desktop market factory', () => {
  it('registers the desktop panel, opens it from native requests, and releases its subscriptions', async () => {
    const desktop = desktopFixture(false)
    const built = loadBuiltMarket()
    const fixture = contextFixture()
    built.plugin.apply(fixture.ctx)
    expect(built.id).toBe('dsh-community')
    expect(built.plugin.name).toBe('dsh-community')
    expect(built.plugin.inject).toEqual(['slots', 'locale', 'layout'])
    expect(new Set(built.requested)).toEqual(new Set([
      'react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives',
    ]))
    expect(fixture.entries.some(entry => entry.options.name === 'main' && entry.options.key === 'community-market')).toBe(true)
    expect(fixture.entries.some(entry => entry.options.name === 'sidebar.panellist' && entry.options.id === 'community-market')).toBe(true)
    expect(fixture.entries.some(entry => entry.options.name === 'settings.section' && entry.options.id === 'market')).toBe(false)
    await act(async () => {})
    expect(fixture.selectPanel).not.toHaveBeenCalled()
    expect(desktop.openListenerCount()).toBe(1)

    await act(async () => { desktop.open() })
    expect(fixture.selectPanel).toHaveBeenCalledExactlyOnceWith('community-market')
    expect(desktop.api.claimOpen).toHaveBeenCalledTimes(2)
    expect(desktop.api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith('navigation-1')
    fixture.dispose()
    expect(desktop.openListenerCount()).toBe(0)
    expect(fixture.entries).toEqual([])
    desktop.open()
    expect(fixture.selectPanel).toHaveBeenCalledTimes(1)
  })

  it('consumes the cold-start navigation flag and renders the built community panel with shared React and primitives', async () => {
    const desktop = desktopFixture(true)
    const built = loadBuiltMarket()
    const fixture = contextFixture()
    built.plugin.apply(fixture.ctx)
    await act(async () => {})
    expect(fixture.selectPanel).toHaveBeenCalledExactlyOnceWith('community-market')
    expect(await desktop.api.claimOpen()).toBeNull()
    const panel = fixture.entries.find(entry => entry.options.name === 'main' && entry.options.key === 'community-market')
    assert(panel !== undefined)
    const view = render(React.createElement(panel.component))
    expect(await screen.findByRole('heading', { name: 'Stream community' })).toBeTruthy()
    expect(await screen.findByText('No community plugins are available')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Community' }).getAttribute('aria-selected')).toBe('true')
    expect(desktop.stateListenerCount()).toBe(1)
    expect(desktop.openListenerCount()).toBe(2)
    view.unmount()
    expect(desktop.stateListenerCount()).toBe(0)
    expect(desktop.openListenerCount()).toBe(1)
    fixture.dispose()
    expect(desktop.openListenerCount()).toBe(0)
  })

  it('leaves a delayed navigation reply for the live module after reload', async () => {
    const desktop = desktopFixture(true)
    const request = desktop.pendingRequest()
    assert(request !== null)
    const delayed = Promise.withResolvers<CommunityNavigationId | null>()
    onTestFinished(() => { delayed.resolve(request) })
    vi.mocked(desktop.api.claimOpen).mockImplementationOnce(() => delayed.promise)
    const built = loadBuiltMarket()
    const previous = contextFixture()
    built.plugin.apply(previous.ctx)
    previous.dispose()
    expect(desktop.openListenerCount()).toBe(0)
    expect(desktop.pendingRequest()).toBe(request)

    const current = contextFixture()
    built.plugin.apply(current.ctx)
    await act(async () => {})
    expect(current.selectPanel).toHaveBeenCalledExactlyOnceWith('community-market')
    expect(desktop.api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(request)
    delayed.resolve(request)
    await act(async () => {})
    expect(previous.selectPanel).not.toHaveBeenCalled()
    expect(desktop.api.acknowledgeOpen).toHaveBeenCalledTimes(1)
    expect(desktop.pendingRequest()).toBeNull()
    current.dispose()
    expect(desktop.openListenerCount()).toBe(0)
  })

  it('keeps a newer navigation request when an earlier acknowledgement settles', async () => {
    const desktop = desktopFixture(true)
    const firstRequest = desktop.pendingRequest()
    assert(firstRequest !== null)
    const delayedAck = Promise.withResolvers<void>()
    const delayedRead = Promise.withResolvers<CommunityNavigationId | null>()
    onTestFinished(() => { delayedAck.resolve(); delayedRead.resolve(null) })
    vi.mocked(desktop.api.acknowledgeOpen).mockImplementationOnce(async (request) => {
      await delayedAck.promise
      desktop.acknowledge(request)
    })
    const built = loadBuiltMarket()
    const fixture = contextFixture()
    built.plugin.apply(fixture.ctx)
    await act(async () => {})
    expect(desktop.api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(firstRequest)
    expect(desktop.pendingRequest()).toBe(firstRequest)

    vi.mocked(desktop.api.claimOpen).mockImplementationOnce(() => delayedRead.promise)
    desktop.open()
    const nextRequest = desktop.pendingRequest()
    assert(nextRequest !== null && nextRequest !== firstRequest)
    delayedAck.resolve()
    await act(async () => {})
    expect(desktop.pendingRequest()).toBe(nextRequest)
    expect(fixture.selectPanel).toHaveBeenCalledTimes(1)
    delayedRead.resolve(nextRequest)
    await act(async () => {})
    expect(fixture.selectPanel).toHaveBeenCalledTimes(2)
    expect(vi.mocked(desktop.api.acknowledgeOpen).mock.calls).toEqual([[firstRequest], [nextRequest]])
    expect(desktop.pendingRequest()).toBeNull()
    fixture.dispose()
    expect(desktop.openListenerCount()).toBe(0)
  })

  it('ignores an open notification with no pending navigation request', async () => {
    const desktop = desktopFixture(false)
    const built = loadBuiltMarket()
    const fixture = contextFixture()
    built.plugin.apply(fixture.ctx)
    await act(async () => { desktop.notify() })
    expect(fixture.selectPanel).not.toHaveBeenCalled()
    expect(desktop.api.acknowledgeOpen).not.toHaveBeenCalled()
    fixture.dispose()
    expect(desktop.openListenerCount()).toBe(0)
  })

  it('retains the request when panel selection fails and allows a replacement module to open it', async () => {
    const desktop = desktopFixture(true)
    const request = desktop.pendingRequest()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warning.mockRestore() })
    const built = loadBuiltMarket()
    const previous = contextFixture()
    previous.selectPanel.mockImplementationOnce(() => { throw new Error('Panel registration is unavailable') })
    built.plugin.apply(previous.ctx)
    await act(async () => {})
    expect(warning).toHaveBeenCalledExactlyOnceWith('Community navigation is unavailable')
    expect(desktop.api.acknowledgeOpen).not.toHaveBeenCalled()
    expect(desktop.pendingRequest()).toBe(request)
    previous.dispose()

    const current = contextFixture()
    built.plugin.apply(current.ctx)
    await act(async () => {})
    expect(current.selectPanel).toHaveBeenCalledExactlyOnceWith('community-market')
    expect(desktop.api.acknowledgeOpen).toHaveBeenCalledExactlyOnceWith(request)
    current.dispose()
    expect(desktop.openListenerCount()).toBe(0)
  })

  it('registers no secondary market or settings service without desktop capabilities', () => {
    setWindowValue('dshDesktop', undefined)
    const built = loadBuiltMarket()
    const fixture = contextFixture()
    built.plugin.apply(fixture.ctx)
    expect(fixture.entries.some(entry => entry.options.name === 'settings.section' && entry.options.id === 'market')).toBe(false)
    expect(fixture.entries.some(entry => entry.options.name === 'main' && entry.options.key === 'community-market')).toBe(false)
    expect(fixture.entries.some(entry => entry.options.name === 'sidebar.panellist' && entry.options.id === 'community-market')).toBe(false)
    expect(fixture.provided.has('market')).toBe(false)
    expect(fixture.selectPanel).not.toHaveBeenCalled()
    fixture.dispose()
    expect(fixture.entries).toEqual([])
  })
})
