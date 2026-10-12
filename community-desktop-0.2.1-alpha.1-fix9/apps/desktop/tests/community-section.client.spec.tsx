// @vitest-environment jsdom
/** Community panel behavior against a credential-free desktop bridge. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type {
  CommunityCatalog, CommunityCatalogQuery, CommunityChange, CommunityInstallIntent, CommunityState,
  CommunityTask, CommunityTaskId, DesktopCommunityApi, CommunityLoginFailureCode,
} from '../src/community-types.ts'
import { CommunitySection } from '../plugins/dsh-community/src/client/CommunitySection.tsx'
import { communityEn, communityZh } from '../plugins/dsh-community/src/client/community-locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const PLUGIN = {
  id: 'dsh-notes', name: 'Notes', description: 'Keep project notes close to your conversation',
  version: '1.2.0', author: 'Community author', category: 'Productivity',
}
const INTENT: CommunityInstallIntent = { id: PLUGIN.id, name: PLUGIN.name, version: PLUGIN.version }
const CATALOG: CommunityCatalog = { plugins: [PLUGIN], updatedAt: 1_799_999_000_000, cached: false }
const APPLIED: CommunityChange = { application: 'applied', changed: true }

function task(overrides: Partial<CommunityTask> = {}): CommunityTask {
  return {
    id: 'task-notes' as CommunityTaskId, plugin: INTENT, phase: 'queued',
    createdAt: 1_799_999_000_000, updatedAt: 1_799_999_000_000, ...overrides,
  }
}

function fixture(initial: Partial<CommunityState> = {}, pending: CommunityInstallIntent | null = null) {
  let state: CommunityState = { account: { username: 'alice', email: 'alice@example.test' }, tasks: [], bundles: [], ...initial }
  const listeners = new Set<() => void>()
  const openListeners = new Set<() => void>()
  const api = {
    getState: vi.fn(async () => state),
    catalog: vi.fn(async (_refresh?: boolean, _query?: CommunityCatalogQuery) => CATALOG),
    detail: vi.fn<DesktopCommunityApi['detail']>(async (id: string) => id === PLUGIN.id
      ? { ...PLUGIN, readme: '# Notes\n\nKeep project notes close to your conversation.' }
      : { id, name: 'Other plugin', description: '', readme: '' }),
    openWebsite: vi.fn<DesktopCommunityApi['openWebsite']>(async (_path?: string, _target?: 'system-browser') => {}),
    install: vi.fn(async (_intent: CommunityInstallIntent) => {
      const created = task()
      state = { ...state, tasks: [created] }
      return created
    }),
    cancel: vi.fn(async (_id: CommunityTaskId) => {}),
    getTaskLog: vi.fn<DesktopCommunityApi['getTaskLog']>(async id => ({ id, entries: [], nextCursor: 0, truncated: false, unavailable: false })),
    copyTaskLog: vi.fn<DesktopCommunityApi['copyTaskLog']>(async () => {}),
    exportTaskLog: vi.fn<DesktopCommunityApi['exportTaskLog']>(async () => true),
    setEnabled: vi.fn(async (_name: string, _enabled: boolean) => APPLIED),
    remove: vi.fn(async (_name: string) => APPLIED),
    login: vi.fn<DesktopCommunityApi['login']>(async (_email: string, _password: string) => {
      state = { ...state, account: { username: 'alice', email: 'alice@example.test' } }
      return { ok: true }
    }),
    logout: vi.fn(async () => {}),
    takePending: vi.fn(async () => { const intent = pending; pending = null; return intent }),
    claimOpen: vi.fn(async () => null),
    acknowledgeOpen: vi.fn(async () => {}),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    subscribeOpen: vi.fn((listener: () => void) => { openListeners.add(listener); return () => { openListeners.delete(listener) } }),
  } satisfies DesktopCommunityApi
  return {
    api,
    update(next: Partial<CommunityState>): void {
      state = { ...state, ...next }
      for (const listener of listeners) listener()
    },
    open(intent: CommunityInstallIntent | null): void {
      pending = intent
      for (const listener of openListeners) listener()
    },
    listenerCount: (): number => listeners.size + openListeners.size,
  }
}

function show(f: ReturnType<typeof fixture>, locale = 'en') {
  return render(<CommunitySection api={f.api} locale={locale} />)
}

async function openDetails(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'View details · Notes' }))
  return screen.getByRole('dialog', { name: 'Install Notes' })
}

describe('desktop community panel', () => {
  it.each(['en', 'zh-CN'])('opens external release instructions without native installation, login or Host availability (%s)', async (locale) => {
    const copy = locale === 'en' ? communityEn : communityZh
    const external = { ...PLUGIN, installationBoundary: true as const }
    const f = fixture({ account: null, hostProblem: { code: 'host-unavailable' } })
    f.api.catalog.mockResolvedValue({ ...CATALOG, plugins: [external] })
    f.api.detail.mockResolvedValue(external)
    show(f, locale)
    fireEvent.click(await screen.findByRole('button', { name: copy.releaseInstructions }))
    const dialog = await screen.findByRole('dialog', { name: copy.releaseInstructionsTitle.replace('{name}', PLUGIN.name) })
    expect(within(dialog).getByText(copy.externalInstallRequired)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: copy.installConfirm })).toBeNull()
    expect(within(dialog).queryByText(copy.verificationNote)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: copy.openReleaseInstructions }))
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.login).not.toHaveBeenCalled()
    expect(f.api.install).not.toHaveBeenCalled()
  })

  it('uses current external detail metadata for a protocol request from an older catalog', async () => {
    const f = fixture({ account: null }, INTENT)
    f.api.detail.mockResolvedValue({ ...PLUGIN, installationBoundary: true })
    show(f)
    const dialog = await screen.findByRole('dialog', { name: communityEn.releaseInstructionsTitle.replace('{name}', PLUGIN.name) })
    fireEvent.click(within(dialog).getByRole('button', { name: communityEn.openReleaseInstructions }))
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.install).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: communityEn.signInTitle })).toBeNull()
  })

  it('opens external release instructions from a failed task while the Host is unavailable', async () => {
    const f = fixture({ account: null, hostProblem: { code: 'host-unavailable' }, tasks: [task({ phase: 'failed', problem: { code: 'external-installation-required' } })] })
    show(f)
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(await screen.findByText(communityEn.externalInstallRequired)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.openReleaseInstructions }))
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.install).not.toHaveBeenCalled()
    expect(f.api.login).not.toHaveBeenCalled()
  })

  it.each(['external', 'manual'])('keeps an old failure actionable through current %s catalog instructions while the Host is unavailable', async (kind) => {
    const current = { ...PLUGIN, ...(kind === 'external' ? { installationBoundary: true as const } : { manualDistribution: true as const }) }
    const f = fixture({ account: null, hostProblem: { code: 'host-unavailable' }, tasks: [task({ phase: 'failed', problem: { code: 'incompatible-package' } })] })
    f.api.catalog.mockResolvedValue({ ...CATALOG, plugins: [current] })
    show(f)
    await screen.findByRole('button', { name: kind === 'external' ? communityEn.releaseInstructions : communityEn.manualDownload })
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    const instructions = screen.getByRole('button', { name: kind === 'external' ? communityEn.openReleaseInstructions : communityEn.manualInstructions })
    expect(instructions.hasAttribute('disabled')).toBe(false)
    fireEvent.click(instructions)
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.install).not.toHaveBeenCalled()
    expect(f.api.login).not.toHaveBeenCalled()
  })

  it('opens historical diagnostics only for the selected installation task', async () => {
    const historical = task({ phase: 'failed', problem: { code: 'install-failed' } })
    const f = fixture({ tasks: [historical] })
    f.api.getTaskLog.mockResolvedValue({ id: historical.id, entries: [{
      sequence: 1, time: historical.updatedAt, phase: 'installing', level: 'error', source: 'pnpm',
      text: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE: original pnpm error', exitCode: 1,
    }], nextCursor: 1, truncated: false, unavailable: false })
    const view = show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(f.api.getTaskLog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: communityEn.taskLogShow }))
    expect(await screen.findByText('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE: original pnpm error')).toBeTruthy()
    expect(f.api.getTaskLog).toHaveBeenCalledExactlyOnceWith(historical.id, undefined)
    expect(screen.getByText(communityEn.taskLogExit.replace('{code}', '1'))).toBeTruthy()
    view.unmount()
    expect(f.listenerCount()).toBe(0)
  })

  it.each(['en', 'zh-CN'])('opens full-package download instructions without login or automatic installation (%s)', async (locale) => {
    const copy = locale === 'en' ? communityEn : communityZh
    const manual = { ...PLUGIN, manualDistribution: true as const, readme: '# Complete package\n\nFollow the author installation guide.' }
    const f = fixture({ account: null, hostProblem: { code: 'host-unavailable' } })
    f.api.catalog.mockResolvedValue({ ...CATALOG, plugins: [manual] })
    f.api.detail.mockResolvedValue(manual)
    show(f, locale)
    fireEvent.click(await screen.findByRole('button', { name: copy.manualDownload }))
    const dialog = await screen.findByRole('dialog', { name: copy.manualInstallTitle.replace('{name}', PLUGIN.name) })
    expect(within(dialog).getByText(copy.manualInstallRequired)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: copy.installConfirm })).toBeNull()
    expect(within(dialog).queryByText(copy.verificationNote)).toBeNull()
    expect({ action: within(dialog).getByRole('button', { name: copy.manualInstructions }).textContent,
      note: within(dialog).getByText(copy.manualInstallRequired).textContent }).toMatchSnapshot()
    fireEvent.click(within(dialog).getByRole('button', { name: copy.manualInstructions }))
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.login).not.toHaveBeenCalled()
    expect(f.api.install).not.toHaveBeenCalled()
  })

  it('uses current manual detail metadata for a protocol request from an older catalog', async () => {
    const f = fixture({ account: null }, INTENT)
    f.api.detail.mockResolvedValue({ ...PLUGIN, manualDistribution: true })
    show(f)
    const dialog = await screen.findByRole('dialog', { name: communityEn.manualInstallTitle.replace('{name}', PLUGIN.name) })
    fireEvent.click(within(dialog).getByRole('button', { name: communityEn.manualInstructions }))
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.install).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: communityEn.signInTitle })).toBeNull()
  })

  it('replaces a manual-installation failure retry with its download instructions', async () => {
    const f = fixture({ account: null, tasks: [task({ phase: 'failed', problem: { code: 'manual-install-required' } })] })
    show(f)
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(await screen.findByText(communityEn.manualInstallRequired)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.manualInstructions }))
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith(`/plugins/${PLUGIN.id}`)
    expect(f.api.install).not.toHaveBeenCalled()
    expect(f.api.login).not.toHaveBeenCalled()
  })

  it('names the header destination in English and uses the owning desktop website action', async () => {
    const f = fixture({ account: null })
    show(f)
    const website = screen.getByRole('button', { name: communityEn.website })
    expect(website.closest('header')).toBeTruthy()
    expect(within(website).getByText('deepseek.stream')).toBeTruthy()
    fireEvent.click(website)
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith('/')
    await screen.findByRole('button', { name: 'View details · Notes' })
  })

  it('shows a persistent community login and opens only the owner website action', async () => {
    const f = fixture({ account: null })
    show(f, 'zh-CN')
    const login = screen.getByRole('button', { name: communityZh.signIn })
    expect(login.closest('header')).toBeTruthy()
    expect(screen.queryByText('更多插件来源')).toBeNull()
    const website = screen.getByRole('button', { name: communityZh.website })
    expect(website.closest('header')).toBeTruthy()
    expect(within(website).getByText('deepseek.stream')).toBeTruthy()
    fireEvent.click(website)
    expect(f.api.openWebsite).toHaveBeenCalledExactlyOnceWith('/')
    await screen.findByRole('button', { name: '查看详情 · Notes' })
    expect({
      heading: screen.getByRole('heading', { level: 1 }).textContent,
      account: screen.getByText(communityZh.signInHint).textContent,
      tabs: screen.getAllByRole('tab').map(item => item.textContent),
      categories: within(screen.getByRole('group', { name: communityZh.category })).getAllByRole('button').map(item => item.textContent),
      website: website.getAttribute('aria-label'),
      websiteDestination: website.getAttribute('aria-description'),
    }).toMatchInlineSnapshot(`
      {
        "account": "连接社区账号，即可下载插件并继续安装",
        "categories": [
          "全部插件",
          "工具",
          "模型",
          "提示词",
          "工作流",
          "外观",
          "开发",
        ],
        "heading": "深流社区",
        "tabs": [
          "社区",
          "已安装",
          "安装任务",
        ],
        "website": "深流社区",
        "websiteDestination": "deepseek.stream",
      }
    `)
  })

  it('uses server-side category, ranking, and pagination while resetting a new filter to page one', async () => {
    const f = fixture()
    f.api.catalog.mockImplementation(async (_refresh, query) => ({ ...CATALOG, total: 20, totalPages: 2, page: query?.page ?? 1 }))
    show(f)
    await screen.findByRole('button', { name: 'View details · Notes' })
    fireEvent.click(screen.getByRole('button', { name: communityEn.nextPage }))
    await waitFor(() => {
      expect(f.api.catalog).toHaveBeenLastCalledWith(false, expect.objectContaining({ page: 2, pageSize: 15 }))
    })
    fireEvent.click(screen.getByRole('button', { name: communityEn.toolsCategory }))
    await waitFor(() => {
      expect(f.api.catalog).toHaveBeenLastCalledWith(false, expect.objectContaining({ category: 'tools', page: 1 }))
    })
    fireEvent.click(screen.getByRole('button', { name: `${communityEn.sort} · ${communityEn.hotSort}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: communityEn.newestSort }))
    await waitFor(() => {
      expect(f.api.catalog).toHaveBeenLastCalledWith(false, expect.objectContaining({ category: 'tools', sortBy: 'newest', page: 1 }))
    })
    expect(screen.getByText('20 plugins')).toBeTruthy()
  })

  it('waits for Chinese composition to finish and sends the committed search to the server', async () => {
    const f = fixture()
    show(f)
    await screen.findByRole('button', { name: 'View details · Notes' })
    vi.useFakeTimers()
    const field = screen.getByRole('textbox', { name: communityEn.search })
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: 'zhuti' } })
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(f.api.catalog).toHaveBeenCalledTimes(1)
    fireEvent.change(field, { target: { value: '主题' } })
    fireEvent.compositionEnd(field, { data: '主题' })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(f.api.catalog).toHaveBeenLastCalledWith(false, expect.objectContaining({ query: '主题', page: 1 }))
    expect(screen.getByRole('button', { name: 'View details · Notes' })).toBeTruthy()
  })

  it('loads full documentation from the detail endpoint rather than using the short catalog description', async () => {
    const f = fixture()
    f.api.detail.mockResolvedValue({ ...PLUGIN, readme: '# Actual plugin guide\n\nEnable the note tools in your preset.' })
    show(f)
    const dialog = await openDetails()
    expect(await within(dialog).findByRole('heading', { name: 'Actual plugin guide' })).toBeTruthy()
    expect(f.api.detail).toHaveBeenCalledExactlyOnceWith(PLUGIN.id)
    expect(within(dialog).getByText(communityEn.verificationNote)).toBeTruthy()
  })

  it('shows restoration and paid access failures without reopening login', async () => {
    const f = fixture({ tasks: [task({ phase: 'failed', restored: true, problem: { code: 'plugin-unlock-required' } })] })
    show(f)
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(await screen.findByText(communityEn.restored)).toBeTruthy()
    expect(screen.getByText(communityEn.unlockRequired)).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: communityEn.signInTitle })).toBeNull()
  })

  it('opens protocol confirmation and projects the main-owned task after explicit installation', async () => {
    const f = fixture({}, INTENT)
    show(f)
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes' })
    expect(within(dialog).getByText('Stream community · deepseek.stream')).toBeTruthy()
    expect(within(dialog).getByText(communityEn.targetName)).toBeTruthy()
    expect(within(dialog).getByText('1.2.0')).toBeTruthy()
    expect(f.api.install).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: communityEn.installConfirm }))
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledWith(INTENT) })
    expect(await screen.findByText(communityEn.queued)).toBeTruthy()
    expect(screen.getByRole('tab', { name: communityEn.tasks }).getAttribute('aria-selected')).toBe('true')

    await act(async () => { f.update({ tasks: [task({ phase: 'applied' })] }) })
    expect(await screen.findByText(communityEn.installedNote)).toBeTruthy()
    expect(screen.queryByText(communityEn.restartNote)).toBeNull()
  })

  it('preserves an explicit protocol version when the catalog advertises a newer release', async () => {
    const pinned = { ...INTENT, version: '1.0.0' }
    const f = fixture({}, pinned)
    show(f)
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes' })
    expect(within(dialog).getByText('1.0.0')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: communityEn.installConfirm }))
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledWith(pinned) })
  })

  it('discloses an external HTTPS origin while keeping source metadata out of the install request', async () => {
    const pending = { ...INTENT, version: '1.0.0', sourceOrigin: 'https://plugins.example.test' }
    const f = fixture({}, pending)
    show(f)
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes' })
    expect(within(dialog).getByText('External HTTPS source · https://plugins.example.test')).toBeTruthy()
    expect(within(dialog).getByText('1.0.0')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: communityEn.installConfirm }))
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledExactlyOnceWith({ ...INTENT, version: '1.0.0' }) })
    expect(Object.keys(f.api.install.mock.calls[0]![0]).sort()).toEqual(['id', 'name', 'version'])
  })

  it('resumes a confirmed installation after sign-in without sending download URLs or tokens', async () => {
    const f = fixture({ account: null })
    show(f)
    const detail = await openDetails()
    fireEvent.click(within(detail).getByRole('button', { name: communityEn.installConfirm }))
    const login = await screen.findByRole('dialog', { name: communityEn.signInTitle })
    expect(f.api.install).not.toHaveBeenCalled()
    fireEvent.change(within(login).getByLabelText(communityEn.username), { target: { value: 'alice' } })
    fireEvent.change(within(login).getByLabelText(communityEn.password), { target: { value: 'private-password' } })
    fireEvent.click(within(login).getByRole('button', { name: communityEn.signInContinue }))
    await waitFor(() => { expect(f.api.login).toHaveBeenCalledWith('alice', 'private-password') })
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledExactlyOnceWith(INTENT) })
    expect(screen.queryByLabelText(communityEn.password)).toBeNull()
    expect(Object.keys(f.api.install.mock.calls[0]![0]).sort()).toEqual(['id', 'name', 'version'])
  })

  it('retains confirmed installation through a failed sign-in and resumes once after a successful retry', async () => {
    const f = fixture({ account: null })
    f.api.login.mockResolvedValueOnce({ ok: false, problem: { code: 'login-network-failed' } })
    show(f)
    const detail = await openDetails()
    fireEvent.click(within(detail).getByRole('button', { name: communityEn.installConfirm }))
    const login = await screen.findByRole('dialog', { name: communityEn.signInTitle })
    fireEvent.change(within(login).getByLabelText(communityEn.username), { target: { value: 'alice' } })
    fireEvent.change(within(login).getByLabelText(communityEn.password), { target: { value: 'fixture-password' } })
    fireEvent.click(within(login).getByRole('button', { name: communityEn.signInContinue }))
    expect(await within(login).findByText(communityEn.loginNetworkFailed)).toBeTruthy()
    expect(f.api.install).not.toHaveBeenCalled()
    fireEvent.click(within(login).getByRole('button', { name: communityEn.signInContinue }))
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledExactlyOnceWith(INTENT) })
    expect(screen.queryByRole('dialog', { name: communityEn.signInTitle })).toBeNull()
  })

  it.each(['en', 'zh-CN'])('retains login fields and confirmed installation when account links open in the browser (%s)', async (locale) => {
    const copy = locale === 'en' ? communityEn : communityZh
    const f = fixture({ account: null }, INTENT)
    show(f, locale)
    const detail = await screen.findByRole('dialog', { name: locale === 'en' ? 'Install Notes' : '安装 Notes' })
    fireEvent.click(within(detail).getByRole('button', { name: copy.installConfirm }))
    const login = await screen.findByRole('dialog', { name: copy.signInTitle })
    fireEvent.change(within(login).getByLabelText(copy.username), { target: { value: 'alice' } })
    fireEvent.change(within(login).getByLabelText(copy.password), { target: { value: 'fixture-password' } })
    fireEvent.click(within(login).getByRole('button', { name: copy.registerCommunityAccount }))
    expect(f.api.openWebsite).toHaveBeenLastCalledWith('/auth/register', 'system-browser')
    fireEvent.click(within(login).getByRole('button', { name: copy.openCommunityWebsite }))
    expect(f.api.openWebsite).toHaveBeenLastCalledWith('/', 'system-browser')
    expect(f.api.openWebsite).toHaveBeenCalledTimes(2)
    expect(within(login).getByText(copy.registrationReturnHint)).toBeTruthy()
    expect(within(login).getByLabelText<HTMLInputElement>(copy.username).value).toBe('alice')
    expect(within(login).getByLabelText<HTMLInputElement>(copy.password).value).toBe('fixture-password')
    expect(f.api.login).not.toHaveBeenCalled()
    expect(f.api.install).not.toHaveBeenCalled()
    fireEvent.click(within(login).getByRole('button', { name: copy.signInContinue }))
    await waitFor(() => { expect(f.api.login).toHaveBeenCalledExactlyOnceWith('alice', 'fixture-password') })
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledExactlyOnceWith(INTENT) })
  })

  it('shows browser-opening failure in the login dialog and retains its inputs and pending installation', async () => {
    const f = fixture({ account: null }, INTENT)
    f.api.openWebsite.mockRejectedValueOnce(new Error('private-browser-diagnostic'))
    show(f)
    const detail = await screen.findByRole('dialog', { name: 'Install Notes' })
    fireEvent.click(within(detail).getByRole('button', { name: communityEn.installConfirm }))
    const login = await screen.findByRole('dialog', { name: communityEn.signInTitle })
    fireEvent.change(within(login).getByLabelText(communityEn.username), { target: { value: 'alice' } })
    fireEvent.change(within(login).getByLabelText(communityEn.password), { target: { value: 'fixture-password' } })
    fireEvent.click(within(login).getByRole('button', { name: communityEn.registerCommunityAccount }))
    expect(await within(login).findByText(communityEn.loginWebsiteFailed)).toBeTruthy()
    expect(screen.queryByText('private-browser-diagnostic')).toBeNull()
    expect(f.api.login).not.toHaveBeenCalled()
    expect(f.api.install).not.toHaveBeenCalled()
    fireEvent.click(within(login).getByRole('button', { name: communityEn.signInContinue }))
    await waitFor(() => { expect(f.api.login).toHaveBeenCalledExactlyOnceWith('alice', 'fixture-password') })
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledExactlyOnceWith(INTENT) })
  })

  it('renders credential-free sign-in failure messages in both product locales', async () => {
    const failures = [
      ['invalid-account', 'loginFields'], ['login-invalid-credentials', 'loginFailed'],
      ['login-forbidden', 'loginForbidden'], ['login-rate-limited', 'loginRateLimited'],
      ['login-network-failed', 'loginNetworkFailed'], ['login-storage-failed', 'loginStorageFailed'],
      ['login-invalid-response', 'loginInvalidResponse'], ['login-server-failed', 'loginServerFailed'],
    ] as const satisfies readonly (readonly [CommunityLoginFailureCode, keyof typeof communityEn])[]
    const observed: Record<string, string[]> = {}
    for (const [locale, copy] of [['en', communityEn], ['zh-CN', communityZh]] as const) {
      const f = fixture({ account: null })
      const view = show(f, locale)
      fireEvent.click(screen.getByRole('button', { name: copy.signIn }))
      const login = await screen.findByRole('dialog', { name: copy.signInTitle })
      fireEvent.change(within(login).getByLabelText(copy.username), { target: { value: 'alice' } })
      fireEvent.change(within(login).getByLabelText(copy.password), { target: { value: 'fixture-password' } })
      const messages: string[] = [
        within(login).getByRole('button', { name: copy.registerCommunityAccount }).textContent ?? '',
        within(login).getByRole('button', { name: copy.openCommunityWebsite }).textContent ?? '',
        within(login).getByText(copy.registrationReturnHint).textContent ?? '',
      ]
      observed[locale] = messages
      for (const [code, key] of failures) {
        f.api.login.mockResolvedValueOnce({ ok: false, problem: { code } })
        fireEvent.click(within(login).getByRole('button', { name: copy.signIn }))
        const message = await within(login).findByText(copy[key])
        messages.push(message.textContent ?? '')
        expect(f.api.install).not.toHaveBeenCalled()
      }
      view.unmount()
    }
    expect(observed).toMatchInlineSnapshot(`
      {
        "en": [
          "Create a community account",
          "Open Stream community",
          "Open in your default browser. After registering, return to this app to sign in and continue any confirmed installation",
          "Enter your email or username and password",
          "Sign-in failed. Check your account details and try again",
          "The community refused this sign-in request. Update the desktop app or try the community website",
          "Too many sign-in attempts. Wait a while and try again",
          "Could not connect to the community. Check your connection and try again",
          "Sign-in could not be saved. Check local storage permissions or available space and try again",
          "The community returned an invalid sign-in response. Try again later",
          "The community sign-in service is unavailable. Try again later",
        ],
        "zh-CN": [
          "注册社区账号",
          "打开深流社区",
          "在系统默认浏览器中打开。注册后请返回桌面登录，继续已确认的安装",
          "请输入邮箱或用户名及密码",
          "登录失败，请检查账号信息后重试",
          "社区拒绝了本次登录请求，请更新桌面客户端或尝试社区网站",
          "登录尝试过于频繁，请稍后重试",
          "无法连接深流社区，请检查网络后重试",
          "登录状态无法保存，请检查本地存储权限或剩余空间后重试",
          "社区返回的登录信息异常，请稍后重试",
          "社区登录服务暂不可用，请稍后重试",
        ],
      }
    `)
  })

  it('keeps failed downloads visible and labels restart-required results without claiming activation', async () => {
    const f = fixture({ tasks: [task({ phase: 'failed', problem: { code: 'download-failed', details: 'HTTP 503' } })] })
    f.api.install.mockImplementation(async () => {
      const result = task({ phase: 'restart-required' })
      f.update({ tasks: [result] })
      return result
    })
    show(f)
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(await screen.findByText(communityEn.downloadFailed)).toBeTruthy()
    expect(screen.getByText('HTTP 503')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.retry }))
    expect(await screen.findByText(communityEn.restartNote)).toBeTruthy()
    expect(screen.getByText(communityEn.restartRequired)).toBeTruthy()
    expect(screen.queryByText(communityEn.installedNote)).toBeNull()
    expect(f.api.install).toHaveBeenCalledWith(INTENT)
  })

  it('shows the retained environment and localized trial failure without replacing it with an AI failure', async () => {
    const output: { locale: string; failure: string; recovery: string; showsAiFailure: boolean }[] = []
    for (const [locale, copy] of [['en', communityEn], ['zh-CN', communityZh]] as const) {
      const f = fixture({ tasks: [task({ phase: 'failed', restored: true, problem: { code: 'trial-failed' } })] })
      show(f, locale)
      fireEvent.click(screen.getByRole('tab', { name: copy.tasks }))
      output.push({ locale, failure: (await screen.findByText(copy.trialFailed)).textContent ?? '',
        recovery: screen.getByText(copy.restored).textContent ?? '', showsAiFailure: screen.queryByText(copy.adaptationFailed) !== null })
      cleanup()
    }
    expect(output).toMatchInlineSnapshot(`
      [
        {
          "failure": "The plugin failed its isolated trial and was not enabled",
          "locale": "en",
          "recovery": "The previous environment has been restored",
          "showsAiFailure": false,
        },
        {
          "failure": "插件未通过独立试运行，未启用",
          "locale": "zh-CN",
          "recovery": "已恢复之前的环境",
          "showsAiFailure": false,
        },
      ]
    `)
  })

  it('offers sign-in when the active download reports an expired account asynchronously', async () => {
    const f = fixture()
    show(f)
    const detail = await openDetails()
    fireEvent.click(within(detail).getByRole('button', { name: communityEn.installConfirm }))
    await screen.findByText(communityEn.queued)
    await act(async () => { f.update({ tasks: [task({ phase: 'failed', problem: { code: 'authentication-required' } })] }) })
    const login = await screen.findByRole('dialog', { name: communityEn.signInTitle })
    expect(within(login).getByText(communityEn.loginRequired)).toBeTruthy()
    fireEvent.change(within(login).getByLabelText(communityEn.username), { target: { value: 'alice' } })
    fireEvent.change(within(login).getByLabelText(communityEn.password), { target: { value: 'new-password' } })
    fireEvent.click(within(login).getByRole('button', { name: communityEn.signInContinue }))
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledTimes(2) })
    expect(f.api.install).toHaveBeenLastCalledWith(INTENT)
  })

  it('signs in before retrying a retained authentication failure even when account metadata remains present', async () => {
    const f = fixture({ tasks: [task({ phase: 'failed', problem: { code: 'authentication-required' } })] })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    fireEvent.click(screen.getByRole('button', { name: communityEn.retry }))
    expect(await screen.findByRole('dialog', { name: communityEn.signInTitle })).toBeTruthy()
    expect(f.api.install).not.toHaveBeenCalled()
  })

  it('keeps the catalog when a refresh fails and exposes a retry beside the retained list', async () => {
    const f = fixture()
    show(f)
    await screen.findByRole('button', { name: 'View details · Notes' })
    f.api.catalog.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: communityEn.refresh }))
    expect(await screen.findByText(communityEn.catalogFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View details · Notes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: communityEn.retry }))
    await waitFor(() => { expect(screen.queryByText(communityEn.catalogFailed)).toBeNull() })
    expect(f.api.catalog).toHaveBeenLastCalledWith(true, expect.objectContaining({ platform: 'desktop-exe', page: 1 }))
  })

  it('shows a retryable initial catalog error without claiming the catalog is empty', async () => {
    const f = fixture()
    f.api.catalog.mockRejectedValueOnce(new Error('offline'))
    show(f)
    expect(await screen.findByText(communityEn.catalogFailed)).toBeTruthy()
    expect(screen.queryByText(communityEn.emptyCatalog)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: communityEn.retry }))
    expect(await screen.findByRole('button', { name: 'View details · Notes' })).toBeTruthy()
  })

  it('shows cached entries and skipped-entry feedback before a background catalog refresh completes', async () => {
    const f = fixture()
    const live = Promise.withResolvers<CommunityCatalog>()
    f.api.catalog.mockImplementation(refresh => refresh
      ? live.promise
      : Promise.resolve({ ...CATALOG, cached: true, skippedCount: 3 }))
    show(f)
    expect(await screen.findByText(/Offline copy ·/)).toBeTruthy()
    expect(screen.getByText('3 entries use an unsupported format and were skipped')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View details · Notes' })).toBeTruthy()
    expect(f.api.catalog.mock.calls.map(call => call[0])).toEqual([false, true])

    await act(async () => {
      live.resolve({ ...CATALOG, plugins: [{ ...PLUGIN, name: 'Updated notes', version: '2.0.0' }] })
    })
    expect(await screen.findByRole('button', { name: 'View details · Updated notes' })).toBeTruthy()
    expect(screen.queryByText(/Offline copy ·/)).toBeNull()
    expect(screen.queryByText('3 entries use an unsupported format and were skipped')).toBeNull()
    expect(f.api.catalog).toHaveBeenCalledTimes(2)
  })

  it('retains the offline catalog with a retry when its background refresh fails', async () => {
    const f = fixture()
    const live = Promise.withResolvers<CommunityCatalog>()
    f.api.catalog.mockImplementation(refresh => refresh
      ? live.promise
      : Promise.resolve({ ...CATALOG, cached: true }))
    show(f)
    expect(await screen.findByRole('button', { name: 'View details · Notes' })).toBeTruthy()
    expect(screen.getByText(/Offline copy ·/)).toBeTruthy()

    await act(async () => { live.reject(new Error('offline')) })
    expect(await screen.findByText(communityEn.catalogFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View details · Notes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: communityEn.retry })).toBeTruthy()
    expect(screen.getByText(/Offline copy ·/)).toBeTruthy()
    expect(screen.queryByText(communityEn.emptyCatalog)).toBeNull()
    expect(f.api.catalog.mock.calls.map(call => call[0])).toEqual([false, true])
  })

  it('uses a fresh in-memory catalog without an extra background request', async () => {
    const f = fixture()
    show(f)
    await screen.findByRole('button', { name: 'View details · Notes' })
    expect(f.api.catalog).toHaveBeenCalledExactlyOnceWith(false, expect.objectContaining({ platform: 'desktop-exe', page: 1 }))
  })

  it('keeps bundle controls and records visible when the host is unavailable', async () => {
    const f = fixture({
      hostProblem: { code: 'host-unavailable' },
      bundles: [{ name: 'dsh-notes', version: '1.2.0', enabled: true, removable: true, readOnly: false }],
      tasks: [task({ phase: 'restart-required' })],
    })
    show(f)
    expect(await screen.findByText(communityEn.hostUnavailable)).toBeTruthy()
    const detail = await openDetails()
    expect(within(detail).getByRole('button', { name: communityEn.installConfirm }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(detail).getByRole('button', { name: communityEn.cancel }))
    fireEvent.click(screen.getByRole('tab', { name: communityEn.installed }))
    expect(screen.getByText('dsh-notes')).toBeTruthy()
    expect(screen.getByRole('button', { name: communityEn.disable }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(screen.getByText(communityEn.restartNote)).toBeTruthy()
  })

  it('retains the last installed inventory when a later Host query fails', async () => {
    const f = fixture({ bundles: [{ name: 'dsh-notes', enabled: true, removable: true, readOnly: false }] })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.installed }))
    expect(screen.getByText('dsh-notes')).toBeTruthy()
    await act(async () => { f.update({ hostProblem: { code: 'host-unavailable' }, bundles: [] }) })
    expect(await screen.findByText(communityEn.hostUnavailable)).toBeTruthy()
    expect(screen.getByText('dsh-notes')).toBeTruthy()
    expect(screen.getByRole('button', { name: communityEn.disable }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(communityEn.emptyInstalled)).toBeNull()
  })

  it('disables and enables installed bundles using the refreshed desktop inventory', async () => {
    const bundle = { name: 'dsh-notes', enabled: true, removable: true, readOnly: false }
    const f = fixture({ bundles: [bundle] })
    f.api.setEnabled.mockImplementation(async (name, enabled) => {
      f.update({ bundles: [{ ...bundle, name, enabled }] })
      return APPLIED
    })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.installed }))
    fireEvent.click(screen.getByRole('button', { name: communityEn.disable }))
    const enable = await screen.findByRole('button', { name: communityEn.enable })
    await waitFor(() => { expect(enable.hasAttribute('disabled')).toBe(false) })
    expect(f.api.setEnabled).toHaveBeenLastCalledWith('dsh-notes', false)
    fireEvent.click(enable)
    await screen.findByRole('button', { name: communityEn.disable })
    expect(f.api.setEnabled).toHaveBeenLastCalledWith('dsh-notes', true)
  })

  it('removes a bundle only after confirmation and refreshes the installed list', async () => {
    const f = fixture({ bundles: [{ name: 'dsh-notes', enabled: true, removable: true, readOnly: false }] })
    f.api.remove.mockImplementation(async () => { f.update({ bundles: [] }); return APPLIED })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.installed }))
    fireEvent.click(screen.getByRole('button', { name: communityEn.remove }))
    const cancelled = screen.getByRole('dialog', { name: 'Remove dsh-notes' })
    expect(f.api.remove).not.toHaveBeenCalled()
    fireEvent.click(within(cancelled).getByRole('button', { name: communityEn.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: communityEn.remove }))
    const confirmed = screen.getByRole('dialog', { name: 'Remove dsh-notes' })
    fireEvent.click(within(confirmed).getByRole('button', { name: communityEn.remove }))
    expect(await screen.findByText(communityEn.emptyInstalled)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.api.remove).toHaveBeenCalledExactlyOnceWith('dsh-notes')
  })

  it('keeps its own sidebar entry protected while allowing other installed bundles to be enabled', async () => {
    const other = { name: 'dsh-notes', enabled: false, removable: true, readOnly: false }
    const f = fixture({ bundles: [{ name: 'dsh-community', enabled: true, removable: true, readOnly: false }, other] })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.installed }))
    const market = screen.getByText('dsh-community').closest('li')
    if (market === null) throw new Error('Market inventory row missing')
    expect(within(market).getByText(communityEn.marketProtected)).toBeTruthy()
    const disable = within(market).getByRole('button', { name: communityEn.disable })
    expect(disable.hasAttribute('disabled')).toBe(true)
    fireEvent.click(disable)
    expect(within(market).queryByRole('button', { name: communityEn.remove })).toBeNull()
    expect(f.api.setEnabled).not.toHaveBeenCalled()
    expect(f.api.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: communityEn.enable }))
    await waitFor(() => { expect(f.api.setEnabled).toHaveBeenCalledExactlyOnceWith('dsh-notes', true) })
  })

  it('cancels an active installation and permits an explicit retry after it settles', async () => {
    const f = fixture({ tasks: [task({ phase: 'downloading' })] })
    f.api.cancel.mockImplementation(async () => { f.update({ tasks: [task({ phase: 'cancelled' })] }) })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    fireEvent.click(screen.getByRole('button', { name: communityEn.cancel }))
    const retry = await screen.findByRole('button', { name: communityEn.retry })
    expect(f.api.cancel).toHaveBeenCalledExactlyOnceWith('task-notes')
    expect(f.api.install).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await waitFor(() => { expect(f.api.install).toHaveBeenCalledExactlyOnceWith(INTENT) })
  })

  it('explains refusal to disable the fixed market in task feedback', async () => {
    const f = fixture({ tasks: [task({ phase: 'failed', problem: { code: 'market-required' } })] })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.tasks }))
    expect(screen.getByText(communityEn.marketProtected)).toBeTruthy()
  })

  it('leaves the bundle and removal confirmation in place when removing fails', async () => {
    const f = fixture({ bundles: [{ name: 'dsh-notes', enabled: true, removable: true, readOnly: false }] })
    f.api.remove.mockResolvedValue({ application: 'failed', changed: false, problem: { code: 'manager-failed' } })
    show(f)
    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('tab', { name: communityEn.installed }))
    fireEvent.click(screen.getByRole('button', { name: communityEn.remove }))
    const dialog = screen.getByRole('dialog', { name: 'Remove dsh-notes' })
    fireEvent.click(within(dialog).getByRole('button', { name: communityEn.remove }))
    await waitFor(() => { expect(within(dialog).getByRole('alert').textContent).toBe(communityEn.changeFailed) })
    expect(screen.getByRole('dialog', { name: 'Remove dsh-notes' })).toBeTruthy()
    expect(screen.getByText('dsh-notes', { selector: 'span' })).toBeTruthy()
  })

  it('uses the native tab keyboard navigation and localizes the confirmation', async () => {
    const f = fixture()
    show(f, 'zh-CN')
    const community = screen.getByRole('tab', { name: communityZh.community })
    community.focus()
    fireEvent.keyDown(community, { key: 'ArrowRight' })
    const installed = screen.getByRole('tab', { name: communityZh.installed })
    expect(document.activeElement).toBe(installed)
    expect(installed.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(installed, { key: 'Home' })
    expect(document.activeElement).toBe(community)
    fireEvent.click(await screen.findByRole('button', { name: '查看详情 · Notes' }))
    const dialog = screen.getByRole('dialog', { name: '安装 Notes' })
    expect(within(dialog).getByText(communityZh.targetName)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: communityZh.installConfirm })).toBeTruthy()
  })

  it('does not resume a dismissed sign-in when a new protocol intent is received', async () => {
    const f = fixture({ account: null })
    show(f)
    const detail = await openDetails()
    fireEvent.click(within(detail).getByRole('button', { name: communityEn.installConfirm }))
    const login = await screen.findByRole('dialog', { name: communityEn.signInTitle })
    fireEvent.click(within(login).getByRole('button', { name: communityEn.cancel }))
    await act(async () => { f.open({ id: 'dsh-other', name: 'Other plugin' }) })
    expect(await screen.findByRole('dialog', { name: 'Install Other plugin' })).toBeTruthy()
    expect(f.api.install).not.toHaveBeenCalled()
  })

  it('releases bridge subscriptions when the panel unmounts', async () => {
    const f = fixture()
    const view = show(f)
    await screen.findByRole('button', { name: 'View details · Notes' })
    expect(f.listenerCount()).toBe(2)
    view.unmount()
    expect(f.listenerCount()).toBe(0)
  })

  it('retains the consumed protocol intent through React StrictMode effect replay', async () => {
    const f = fixture({}, INTENT)
    render(<StrictMode><CommunitySection api={f.api} locale="en" /></StrictMode>)
    expect(await screen.findByRole('dialog', { name: 'Install Notes' })).toBeTruthy()
    expect(f.api.takePending).toHaveBeenCalledTimes(1)
    expect(f.api.install).not.toHaveBeenCalled()
  })
})
