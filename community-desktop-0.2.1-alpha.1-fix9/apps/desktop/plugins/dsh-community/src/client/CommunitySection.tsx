/** Native desktop community catalog, account sign-in, and main-owned installation tasks. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconDownloadOutlineRegular, IconLoadingOutlineRegular, IconRefreshOutlineRegular,
  IconSearchOutlineRegular, Input, MarkdownText, Menu, Modal, Pill, PluginArtworkDefault, SegmentedTabs, StateDot, Tag,
  type SegmentedTab, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CommunityBundle, CommunityCatalog, CommunityChange, CommunityInstallIntent,
  CommunityPlugin, CommunityProblem, CommunityState, CommunityTask, DesktopCommunityApi,
  CommunityTaskId, CommunityCatalogQuery, CommunityPluginDetail, CommunityLoginFailureCode,
} from '../../../../src/community-types.ts'
import { communityText, type CommunityLocaleKey } from './community-locales.ts'
import { CommunityTaskLogPanel } from './CommunityTaskLogPanel.tsx'
import { CommunityRuntimeLogPanel } from './CommunityRuntimeLogPanel.tsx'
import css from './Community.module.css'

/** Explicit capabilities and locale supplied by the host-owned market registration. */
export interface CommunitySectionProps {
  readonly api: DesktopCommunityApi
  readonly locale: string
}

type CommunityTab = 'community' | 'installed' | 'tasks'
type Translate = (key: CommunityLocaleKey, values?: Readonly<Record<string, string>>) => string

const PHASE_KEYS = {
  queued: 'queued', downloading: 'downloading', validating: 'validating', packaging: 'packaging',
  adapting: 'adapting', trial: 'trial', activating: 'activating', 'rolling-back': 'rollingBack',
  installing: 'installing', cancelling: 'cancelling', applied: 'applied',
  'restart-required': 'restartRequired', overridden: 'overridden', failed: 'failed', cancelled: 'cancelled',
} satisfies Record<CommunityTask['phase'], CommunityLocaleKey>

const ACTIVE_PHASES: ReadonlySet<CommunityTask['phase']> = new Set([
  'queued', 'downloading', 'adapting', 'validating', 'packaging', 'trial', 'installing', 'activating', 'rolling-back', 'cancelling',
])

const CHANGE_KEYS = {
  applied: 'changed', 'restart-required': 'restartNote', overridden: 'overrideNote',
  failed: 'changeFailed', cancelled: 'cancelledNote',
} satisfies Record<CommunityChange['application'], CommunityLocaleKey>

const TASK_NOTE_KEYS: Partial<Record<CommunityTask['phase'], CommunityLocaleKey>> = {
  applied: 'installedNote', 'restart-required': 'restartNote', overridden: 'overrideNote',
}

function isActive(task: CommunityTask): boolean {
  return ACTIVE_PHASES.has(task.phase)
}

function stateDot(task: CommunityTask): StateDotState {
  if (isActive(task)) return 'ongoing'
  if (task.phase === 'failed') return 'error'
  if (task.phase === 'applied') return 'done'
  return 'warning'
}

function requiresLogin(problem: CommunityProblem | undefined): boolean {
  return problem !== undefined && /auth|login|unauthori[sz]ed|session-expired/.test(problem.code)
}

function releaseGuide(problem: CommunityProblem | undefined, plugin: CommunityPlugin | undefined): 'external' | 'manual' | undefined {
  if (problem?.code === 'external-installation-required' || plugin?.installationBoundary === true) return 'external'
  if (problem?.code === 'manual-install-required' || plugin?.manualDistribution === true) return 'manual'
  return undefined
}

const LOGIN_FAILURE_KEYS = {
  'invalid-account': 'loginFields', 'login-invalid-credentials': 'loginFailed',
  'login-forbidden': 'loginForbidden', 'login-rate-limited': 'loginRateLimited',
  'login-network-failed': 'loginNetworkFailed', 'login-storage-failed': 'loginStorageFailed',
  'login-invalid-response': 'loginInvalidResponse', 'login-server-failed': 'loginServerFailed',
} satisfies Record<CommunityLoginFailureCode, CommunityLocaleKey>

function problemCopy(problem: CommunityProblem | undefined, t: Translate, fallback: CommunityLocaleKey): string {
  if (problem === undefined) return t(fallback)
  if (problem.code === 'manual-install-required') return t('manualInstallRequired')
  if (problem.code === 'external-installation-required') return t('externalInstallRequired')
  if (problem.code === 'market-required') return t('marketProtected')
  if (requiresLogin(problem)) return t('loginRequired')
  if (/unlock|purchase|payment/.test(problem.code)) return t('unlockRequired')
  if (/adaptation-key-required/.test(problem.code)) return t('adaptationKeyRequired')
  if (/adapt/.test(problem.code)) return t('adaptationFailed')
  if (/trial/.test(problem.code)) return t('trialFailed')
  if (/rollback-failed|recovery-required/.test(problem.code)) return t('recoveryRequired')
  if (/activation-failed/.test(problem.code)) return t('activationFailed')
  if (/profile-changed/.test(problem.code)) return t('profileChanged')
  if (/installation-interrupted/.test(problem.code)) return t('interrupted')
  if (/storage-failed/.test(problem.code)) return t('storageFailed')
  if (/invalid-profile/.test(problem.code)) return t('invalidProfile')
  if (/download|network|timeout|fetch/.test(problem.code)) return t('downloadFailed')
  if (/incompatib|peer/.test(problem.code)) return t('incompatible')
  if (/not-found|catalog.*missing|unavailable-plugin/.test(problem.code)) return t('unavailablePlugin')
  if (/busy|conflict|active-task|installation-active/.test(problem.code)) return t('busy')
  if (/package|archive|manifest|entry|zip/.test(problem.code)) return t('invalidPackage')
  return t(fallback)
}

function intentFor(plugin: CommunityPlugin): CommunityInstallIntent {
  return { id: plugin.id, name: plugin.name, ...(plugin.version === undefined ? {} : { version: plugin.version }) }
}

function resultCopy(result: CommunityChange, t: Translate): string {
  return result.application === 'failed'
    ? problemCopy(result.problem, t, 'changeFailed')
    : t(CHANGE_KEYS[result.application])
}

function TaskDetails({ task, t }: { readonly task: CommunityTask; readonly t: Translate }): ReactNode {
  const noteKey = TASK_NOTE_KEYS[task.phase]
  const text = task.phase === 'failed'
    ? problemCopy(task.problem, t, 'installFailed')
    : noteKey === undefined ? undefined : t(noteKey)
  const total = task.totalBytes
  const received = task.receivedBytes
  const progress = total !== undefined && total > 0 && received !== undefined
    ? Math.min(100, Math.max(0, Math.round(received / total * 100)))
    : undefined
  return <>
    {task.restored === true && <p className={css.restored} role="status">{t('restored')}</p>}
    {text !== undefined && <p className={`${css.meta} ${task.phase === 'failed' ? css.problem : ''}`}>{text}</p>}
    {task.phase === 'downloading' && progress !== undefined && <progress
      className={css.progress} max={100} value={progress} aria-label={t('progress')} />}
    {task.problem?.details !== undefined && <details className={css.taskDetails}>
      <summary>{t('technicalDetails')}</summary>
      <pre className={css.diagnostic}>{task.problem.details}</pre>
    </details>}
  </>
}

function FilterMenu<T extends string>({ value, values, keys, labelKey, onChange, t }: {
  readonly value: T; readonly values: readonly T[]; readonly keys: Record<T, CommunityLocaleKey>
  readonly labelKey: CommunityLocaleKey; readonly onChange: (value: T) => void; readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal autoFocus selectedId={value}
    anchor={<Button size="sm" variant="outline" aria-label={`${t(labelKey)} · ${t(keys[value])}`}
      aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>{t(keys[value])}</Button>}
    items={values.map(id => ({ id, label: t(keys[id]) }))} onClose={() => { setOpen(false) }}
    onSelect={id => { const selected = values.find(item => item === id); if (selected !== undefined) onChange(selected); setOpen(false) }} />
}

const CATEGORIES = ['all', 'tools', 'models', 'prompt', 'workflow', 'ui', 'dev'] as const
const CATEGORY_KEYS = { all: 'allCategories', tools: 'toolsCategory', models: 'modelsCategory', prompt: 'promptCategory',
  workflow: 'workflowCategory', ui: 'uiCategory', dev: 'devCategory' } satisfies Record<typeof CATEGORIES[number], CommunityLocaleKey>
const PLATFORMS = ['all', 'desktop-exe', 'web', 'linux'] as const
const PLATFORM_KEYS = { all: 'allPlatforms', 'desktop-exe': 'desktopPlatform', web: 'webPlatform', linux: 'linuxPlatform' } satisfies
  Record<typeof PLATFORMS[number], CommunityLocaleKey>
const SOURCES = ['all', 'official', 'community', 'user_upload'] as const
const SOURCE_KEYS = { all: 'allSources', official: 'officialSource', community: 'communitySource', user_upload: 'uploadedSource' } satisfies
  Record<typeof SOURCES[number], CommunityLocaleKey>
const SORTS = ['hot', 'essential', 'soaring', 'newest', 'downloads', 'stars', 'rating'] as const
const SORT_KEYS = { hot: 'hotSort', essential: 'essentialSort', soaring: 'soaringSort', newest: 'newestSort',
  downloads: 'downloadsSort', stars: 'starsSort', rating: 'ratingSort' } satisfies Record<typeof SORTS[number], CommunityLocaleKey>

function Skeleton({ label }: { readonly label: string }): ReactNode {
  return <ul className={css.list} aria-busy="true" aria-label={label}>
    {[0, 1, 2, 3, 4].map(index => <li className={css.row} key={index} aria-hidden="true">
      <span className={`${css.artwork} ${css.skeletonIcon} ${css.skeleton}`} />
      <div className={css.rowBody}>
        <div className={`${css.skeletonTitle} ${css.skeleton}`} />
        <div className={`${css.skeletonDescription} ${css.skeleton}`} />
      </div>
    </li>)}
  </ul>
}

function Empty({ title, description }: { readonly title: string; readonly description?: string }): ReactNode {
  return <div className={css.empty}>
    <PluginArtworkDefault size={36} aria-hidden="true" />
    <span>{title}</span>
    {description !== undefined && <p>{description}</p>}
  </div>
}

/**
 * Render community installation and bundle management against the current desktop profile.
 * Protocol requests open confirmation; sign-in resumes only an installation already confirmed by the user.
 * @param props - Isolated desktop operations and current locale.
 * @returns The native market panel and its body-portaled confirmation dialogs.
 */
export function CommunitySection({ api, locale }: CommunitySectionProps): ReactNode {
  const t: Translate = (key, values) => communityText(locale, key, values)
  const prefix = useId()
  const [state, setState] = useState<CommunityState | null>(null)
  const [stateError, setStateError] = useState(false)
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [tab, setTab] = useState<CommunityTab>('community')
  const [query, setQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [category, setCategory] = useState<typeof CATEGORIES[number]>('all')
  const [platform, setPlatform] = useState<typeof PLATFORMS[number]>('desktop-exe')
  const [source, setSource] = useState<typeof SOURCES[number]>('all')
  const [sortBy, setSortBy] = useState<typeof SORTS[number]>('hot')
  const [tag, setTag] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<CommunityInstallIntent | null>(null)
  const [detailPlugin, setDetailPlugin] = useState<CommunityPluginDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [detailRetry, setDetailRetry] = useState(0)
  const [removeBundle, setRemoveBundle] = useState<CommunityBundle | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<CommunityLocaleKey | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  const [busyBundle, setBusyBundle] = useState<string | null>(null)
  const [accountBusy, setAccountBusy] = useState(false)
  const [notice, setNotice] = useState<{ key?: CommunityLocaleKey; result?: CommunityChange; failed: boolean } | null>(null)
  const mounted = useRef(false)
  const catalogSequence = useRef(0)
  const refreshState = useRef<() => void>(() => {})
  const resumedIntent = useRef<CommunityInstallIntent | null>(null)
  const submittedTask = useRef<CommunityTaskId | null>(null)
  const installing = useRef(false)
  const pendingRead = useRef<Promise<CommunityInstallIntent | null> | null>(null)
  const pendingSequence = useRef(0)
  const filters = useMemo<CommunityCatalogQuery>(() => ({
    query: committedQuery, category, platform, source, sortBy, tag: tag.trim(), page, pageSize: 15,
  }), [committedQuery, category, platform, source, sortBy, tag, page])

  useEffect(() => {
    if (composing || query.trim() === committedQuery) return
    const timer = window.setTimeout(() => { setCommittedQuery(query.trim()); setPage(1) }, 300)
    return () => { window.clearTimeout(timer) }
  }, [query, committedQuery, composing])

  useEffect(() => {
    if (composing || tagDraft.trim() === tag) return
    const timer = window.setTimeout(() => { setTag(tagDraft.trim()); setPage(1) }, 300)
    return () => { window.clearTimeout(timer) }
  }, [tagDraft, tag, composing])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // One in-flight state query folds progress notifications while preserving the latest invalidation.
  useEffect(() => {
    let disposed = false
    let reading = false
    let pending = false
    const refresh = (): void => {
      if (disposed) return
      if (reading) { pending = true; return }
      reading = true
      void api.getState().then(value => {
        if (!disposed) {
          setState(previous => value.hostProblem === undefined ? value : { ...value, bundles: previous?.bundles ?? value.bundles })
          setStateError(false)
        }
      }, () => {
        if (!disposed) setStateError(true)
      }).finally(() => {
        reading = false
        if (pending && !disposed) { pending = false; refresh() }
      })
    }
    refreshState.current = refresh
    const off = api.subscribe(refresh)
    refresh()
    return () => { disposed = true; off(); refreshState.current = () => {} }
  }, [api])

  useEffect(() => {
    if (submittedTask.current === null) return
    const task = state?.tasks.find(item => item.id === submittedTask.current)
    if (task === undefined || isActive(task)) return
    submittedTask.current = null
    if (task.phase === 'failed' && requiresLogin(task.problem)) {
      resumedIntent.current = task.plugin
      setLoginError('loginRequired')
      setLoginOpen(true)
    }
  }, [state?.tasks])

  const loadCatalog = useCallback(async (refresh = false): Promise<void> => {
    const sequence = ++catalogSequence.current
    setCatalogLoading(true)
    setCatalogError(false)
    try {
      const value = await api.catalog(refresh, filters)
      if (!mounted.current || sequence !== catalogSequence.current) return
      setCatalog(value)
      if (!refresh && value.cached) {
        const fresh = await api.catalog(true, filters)
        if (mounted.current && sequence === catalogSequence.current) setCatalog(fresh)
      }
    } catch {
      if (mounted.current && sequence === catalogSequence.current) setCatalogError(true)
    } finally {
      if (mounted.current && sequence === catalogSequence.current) setCatalogLoading(false)
    }
  }, [api, filters])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

  useEffect(() => {
    if (detail === null) { setDetailPlugin(null); setDetailError(false); return }
    let disposed = false
    setDetailLoading(true)
    setDetailError(false)
    setDetailPlugin(null)
    void api.detail(detail.id).then(value => {
      if (!disposed) setDetailPlugin(value)
    }, () => { if (!disposed) setDetailError(true) })
      .finally(() => { if (!disposed) setDetailLoading(false) })
    return () => { disposed = true }
  }, [api, detail?.id, detailRetry])

  useEffect(() => {
    let disposed = false
    const receive = (reuse: boolean): void => {
      const request = reuse && pendingRead.current !== null ? pendingRead.current : api.takePending()
      const sequence = ++pendingSequence.current
      pendingRead.current = request
      void request.then(intent => {
        if (disposed || sequence !== pendingSequence.current || intent === null) return
        resumedIntent.current = null
        setLoginOpen(false)
        setRemoveBundle(null)
        setDetail(intent)
        setTab('community')
      }, () => {
        if (!disposed) setStateError(true)
      }).finally(() => {
        if (pendingRead.current === request) pendingRead.current = null
      })
    }
    const off = api.subscribeOpen(() => { receive(false) })
    receive(true)
    return () => { disposed = true; off() }
  }, [api])

  const tasks = state?.tasks ?? []
  const bundles = state?.bundles ?? []
  const activeTask = tasks.find(isActive)
  const operationBusy = activeTask !== undefined || installBusy || busyBundle !== null
  const needle = query.trim().toLocaleLowerCase()
  const visiblePlugins = catalog?.plugins ?? []
  const visibleBundles = bundles.filter(bundle =>
    `${bundle.name} ${bundle.description ?? ''}`.toLocaleLowerCase().includes(needle))
  const selectedPlugin = detailPlugin ?? catalog?.plugins.find(plugin => plugin.id === detail?.id)
  const selectedManual = selectedPlugin?.manualDistribution === true
  const selectedBoundary = selectedPlugin?.installationBoundary === true
  const selectedGuide = selectedManual || selectedBoundary
  const selectedIntent = detail === null || selectedPlugin === undefined ? detail : {
    id: selectedPlugin.id,
    name: selectedPlugin.name,
    ...detail.version === undefined && selectedPlugin.version === undefined
      ? {} : { version: detail.version ?? selectedPlugin.version },
    ...(detail.sourceOrigin === undefined ? {} : { sourceOrigin: detail.sourceOrigin }),
  }
  const selectedSource = selectedIntent?.sourceOrigin ?? 'https://deepseek.stream'
  const selectedInstalled = selectedIntent !== null && bundles.some(bundle => bundle.name === selectedIntent.id)
  const noticeText = notice?.result === undefined
    ? notice?.key === undefined ? '' : t(notice.key)
    : resultCopy(notice.result, t)
  const tabs: [SegmentedTab<CommunityTab>, ...SegmentedTab<CommunityTab>[]] = [
    { value: 'community', label: t('community'), id: `${prefix}-community`, panelId: `${prefix}-community-panel` },
    { value: 'installed', label: t('installed'), id: `${prefix}-installed`, panelId: `${prefix}-installed-panel` },
    { value: 'tasks', label: t('tasks'), id: `${prefix}-tasks`, panelId: `${prefix}-tasks-panel` },
  ]

  const performInstall = async (intent: CommunityInstallIntent): Promise<void> => {
    if (installing.current) return
    installing.current = true
    setInstallBusy(true)
    setNotice(null)
    try {
      const task = await api.install({
        id: intent.id,
        name: intent.name,
        ...(intent.version === undefined ? {} : { version: intent.version }),
      })
      if (!mounted.current) return
      submittedTask.current = isActive(task) ? task.id : null
      setState(value => ({
        account: value?.account ?? null,
        bundles: value?.bundles ?? [],
        tasks: [task, ...(value?.tasks ?? []).filter(existing => existing.id !== task.id)],
        ...(value?.hostProblem === undefined ? {} : { hostProblem: value.hostProblem }),
      }))
      setDetail(null)
      setTab('tasks')
      if (task.phase === 'failed' && requiresLogin(task.problem)) {
        resumedIntent.current = intent
        setLoginError('loginRequired')
        setLoginOpen(true)
      }
      refreshState.current()
    } catch {
      if (mounted.current) setNotice({ key: 'installFailed', failed: true })
    } finally {
      installing.current = false
      if (mounted.current) setInstallBusy(false)
    }
  }

  const requestInstall = (intent: CommunityInstallIntent, problem?: CommunityProblem): void => {
    if (releaseGuide(problem, catalog?.plugins.find(plugin => plugin.id === intent.id)) !== undefined) {
      openWebsite(`/plugins/${encodeURIComponent(intent.id)}`)
      return
    }
    if (operationBusy) return
    if (state?.account === null || requiresLogin(problem)) {
      resumedIntent.current = intent
      setDetail(null)
      setLoginError(null)
      setLoginOpen(true)
      return
    }
    void performInstall(intent)
  }

  const closeLogin = (): void => {
    resumedIntent.current = null
    setLoginOpen(false)
    setPassword('')
    setLoginError(null)
  }

  const openAccountWebsite = (path: '/' | '/auth/register'): void => {
    void api.openWebsite(path, 'system-browser').catch(() => {
      if (mounted.current) setLoginError('loginWebsiteFailed')
    })
  }

  const signIn = async (): Promise<void> => {
    if (loginBusy) return
    if (email.trim() === '' || password === '') { setLoginError('loginFields'); return }
    setLoginBusy(true)
    setLoginError(null)
    try {
      const result = await api.login(email.trim(), password)
      if (!mounted.current) return
      if (!result.ok) { setLoginError(LOGIN_FAILURE_KEYS[result.problem.code]); return }
      const intent = resumedIntent.current
      resumedIntent.current = null
      setPassword('')
      setLoginOpen(false)
      refreshState.current()
      if (intent !== null) await performInstall(intent)
    } catch {
      if (mounted.current) setLoginError('loginServerFailed')
    } finally {
      if (mounted.current) setLoginBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setAccountBusy(true)
    try {
      await api.logout()
      if (mounted.current) setState(value => value === null ? value : { ...value, account: null })
      refreshState.current()
    } catch {
      if (mounted.current) setNotice({ key: 'actionFailed', failed: true })
    } finally {
      if (mounted.current) setAccountBusy(false)
    }
  }

  const changeBundle = async (bundle: CommunityBundle, remove: boolean): Promise<void> => {
    if (operationBusy) return
    setBusyBundle(bundle.name)
    setNotice(null)
    try {
      const result = await (remove ? api.remove(bundle.name) : api.setEnabled(bundle.name, !bundle.enabled))
      if (!mounted.current) return
      setNotice({ result, failed: result.application === 'failed' })
      if (result.application !== 'failed') setRemoveBundle(null)
      refreshState.current()
    } catch {
      if (mounted.current) setNotice({ key: 'changeFailed', failed: true })
    } finally {
      if (mounted.current) setBusyBundle(null)
    }
  }

  const cancelTask = async (task: CommunityTask): Promise<void> => {
    try { await api.cancel(task.id) } catch {
      if (mounted.current) setNotice({ key: 'actionFailed', failed: true })
    } finally { refreshState.current() }
  }

  const openWebsite = (path = '/'): void => {
    void api.openWebsite(path).catch(() => { if (mounted.current) setNotice({ key: 'actionFailed', failed: true }) })
  }

  const account = state?.account

  return <div className={css.page}>
    <header className={css.head} data-window-drag>
      <div><h1 className={css.title}>{t('title')}</h1><p className={css.intro}>{t('intro')}</p></div>
      <div className={css.tools}>
        <Button variant="outline" aria-label={t('website')} aria-description={t('websiteDestination')}
          onClick={() => { openWebsite() }}>
          <span>{t('website')}</span><span>{t('websiteDestination')}</span>
        </Button>
        {account === null || account === undefined
          ? <Button variant="primary" onClick={() => { setLoginError(null); setLoginOpen(true) }}>{t('signIn')}</Button>
          : <Button variant="outline" aria-label={t('profile')} onClick={() => { openWebsite('/dashboard') }}>
            <span className={css.avatar} aria-hidden="true">{(account.username || account.email).slice(0, 1).toUpperCase()}</span>
            {account.username || account.email}
          </Button>}
      </div>
    </header>

    <div className={css.account}>
      <div className={css.accountCopy}>
        <p className={css.accountLabel}>{t('account')}</p>
        <p>{account === null || account === undefined ? t('signInHint') : t('accountConnected')}</p>
      </div>
      <div className={css.tools}>
        {account !== null && account !== undefined && <Button size="sm" disabled={accountBusy}
          onClick={() => { void signOut() }}>{t('signOut')}</Button>}
      </div>
    </div>

    <CommunityRuntimeLogPanel api={api} locale={locale} />

    <div className={css.navigation}>
      <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('navigation')} className={css.tabs} />
      {tab !== 'tasks' && <Input className={css.search ?? ''} icon={<IconSearchOutlineRegular size={16} />}
        aria-label={t('search')} placeholder={t('searchPlaceholder')} value={query}
        onCompositionStart={() => { setComposing(true) }} onCompositionEnd={() => { setComposing(false) }}
        onChange={event => { setQuery(event.target.value) }} />}
      {tab === 'community' && <>
        <div className={css.filters} role="group" aria-label={t('category')}>
          {CATEGORIES.map(value => <Pill key={value} active={category === value} aria-pressed={category === value}
            onClick={() => { setCategory(value); setPage(1) }}>{t(CATEGORY_KEYS[value])}</Pill>)}
        </div>
        <div className={css.filterTools}>
          <FilterMenu value={platform} values={PLATFORMS} keys={PLATFORM_KEYS} labelKey="platform" t={t}
            onChange={value => { setPlatform(value); setPage(1) }} />
          <FilterMenu value={source} values={SOURCES} keys={SOURCE_KEYS} labelKey="source" t={t}
            onChange={value => { setSource(value); setPage(1) }} />
          <FilterMenu value={sortBy} values={SORTS} keys={SORT_KEYS} labelKey="sort" t={t}
            onChange={value => { setSortBy(value); setPage(1) }} />
          <Input className={css.tagSearch ?? ''} aria-label={t('tagSearch')} placeholder={t('tagSearchPlaceholder')}
            value={tagDraft} onCompositionStart={() => { setComposing(true) }} onCompositionEnd={() => { setComposing(false) }}
            onChange={event => { setTagDraft(event.target.value) }} />
          <Button size="sm" aria-label={t('refresh')} disabled={catalogLoading} icon={<IconRefreshOutlineRegular size={14} />}
            onClick={() => { refreshState.current(); void loadCatalog(true) }} />
        </div>
      </>}
    </div>

    {(stateError || state?.hostProblem !== undefined) && <div className={css.notice} data-tone="error" role="alert">
      <p>{t(state?.hostProblem === undefined ? 'stateFailed' : 'hostUnavailable')}</p>
      <Button size="sm" onClick={() => { refreshState.current() }}>{t('retry')}</Button>
    </div>}
    {notice !== null && <div className={css.notice} data-tone={notice.failed ? 'error' : 'info'} role="status" aria-label={t('result')}>
      <p>{noticeText}</p>
      <Button size="sm" onClick={() => { setNotice(null) }}>{t('close')}</Button>
    </div>}

    <section className={css.panel} role="tabpanel" id={`${prefix}-${tab}-panel`} aria-labelledby={`${prefix}-${tab}`}>
      {tab === 'community' && <>
        <div className={css.sectionHead}>
          <span>{t('catalogCount', { count: String(catalog?.total ?? catalog?.plugins.length ?? 0) })}</span>
          {catalog !== null && <span>{t(catalog.cached ? 'cached' : 'liveCatalog', {
            time: new Date(catalog.updatedAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          })}</span>}
        </div>
        {catalogError && catalog !== null && <div className={css.notice} data-tone="error" role="alert">
          <p>{t('catalogFailed')}</p><Button size="sm" onClick={() => { void loadCatalog(true) }}>{t('retry')}</Button>
        </div>}
        {catalog?.skippedCount !== undefined && catalog.skippedCount > 0
          && <p className={css.meta} role="status">{t('skippedEntries', { count: String(catalog.skippedCount) })}</p>}
        {catalogLoading && catalog === null ? <Skeleton label={t('loading')} />
          : catalogError && catalog === null
            ? <div className={css.empty} role="alert"><span>{t('catalogFailed')}</span>
              <Button size="sm" variant="outline" onClick={() => { void loadCatalog(true) }}>{t('retry')}</Button></div>
          : visiblePlugins.length === 0
            ? <Empty title={t(needle === '' ? 'emptyCatalog' : 'emptySearch')} />
            : <ul className={css.list} aria-busy={catalogLoading}>
              {visiblePlugins.map(plugin => {
                const installed = bundles.some(bundle => bundle.name === plugin.id)
                const task = tasks.find(item => item.plugin.id === plugin.id && isActive(item))
                return <li className={css.row} key={plugin.id}>
                  <span className={css.artwork} aria-hidden="true"><PluginArtworkDefault size={32} />
                    {plugin.icon !== undefined && <img src={plugin.icon} alt="" loading="lazy" referrerPolicy="no-referrer"
                      onError={event => { event.currentTarget.hidden = true }} />}
                  </span>
                  <div className={css.rowBody}>
                    <div className={css.rowTitle}>
                      <Button className={css.nameButton} aria-label={`${t('details')} · ${plugin.name}`}
                        onClick={() => { setDetail(intentFor(plugin)) }}><span className={css.name}>{plugin.name}</span></Button>
                      {installed && <Tag tone="success">{t('alreadyInstalled')}</Tag>}
                    </div>
                    {plugin.description !== '' && <p className={css.description}>{plugin.description}</p>}
                    <div className={css.rowMeta}>
                      <span>{plugin.author || t('publisherUnknown')}</span>
                      {plugin.version !== undefined && <span>{plugin.version}</span>}
                      {plugin.category !== undefined && <span>{(() => {
                        const category = CATEGORIES.find(value => value === plugin.category)
                        return category === undefined ? plugin.category : t(CATEGORY_KEYS[category])
                      })()}</span>}
                    </div>
                    {(plugin.tags?.length ?? 0) > 0 && <div className={css.pluginTags}>{plugin.tags?.slice(0, 4).map(value =>
                      <Pill key={value} onClick={() => { setTag(value); setTagDraft(value); setPage(1) }}>{value}</Pill>)}</div>}
                  </div>
                  <div className={css.actions}>
                    <Button size="sm" variant="outline" disabled={task !== undefined}
                      icon={task === undefined ? <IconDownloadOutlineRegular size={14} /> : <IconLoadingOutlineRegular size={14} />}
                      onClick={() => { setDetail(intentFor(plugin)) }}>{task === undefined
                        ? t(plugin.installationBoundary === true ? 'releaseInstructions' : plugin.manualDistribution === true ? 'manualDownload' : installed ? 'reinstall' : 'install') : t(PHASE_KEYS[task.phase])}</Button>
                  </div>
                </li>
              })}
            </ul>}
        {catalog !== null && (catalog.totalPages ?? 1) > 1 && <nav className={css.pagination} aria-label={t('navigation')}>
          <Button size="sm" variant="outline" disabled={catalogLoading || page <= 1}
            onClick={() => { setPage(value => value - 1) }}>{t('previousPage')}</Button>
          <span>{t('pageCount', { page: String(catalog.page ?? page), pages: String(catalog.totalPages ?? 1) })}</span>
          <Button size="sm" variant="outline" disabled={catalogLoading || page >= (catalog.totalPages ?? 1)}
            onClick={() => { setPage(value => value + 1) }}>{t('nextPage')}</Button>
        </nav>}
      </>}

      {tab === 'installed' && <>
        <div className={css.sectionHead}><span>{t('installedCount', { count: String(bundles.length) })}</span></div>
        {state === null && !stateError ? <Skeleton label={t('loading')} />
          : visibleBundles.length === 0
            ? state?.hostProblem === undefined && !stateError && <Empty title={t(needle === '' ? 'emptyInstalled' : 'emptySearch')} />
            : <ul className={css.list}>{visibleBundles.map(bundle => <li className={css.row} key={bundle.name}>
              <span className={css.artwork} aria-hidden="true"><PluginArtworkDefault size={32} /></span>
              <div className={css.rowBody}>
                <div className={css.rowTitle}><span className={css.name}>{bundle.name}</span>
                  <Tag tone={bundle.enabled ? 'success' : 'neutral'}>{t(bundle.enabled ? 'enabled' : 'disabled')}</Tag>
                  {(!bundle.removable || bundle.name === 'dsh-community') && <Tag>{t('builtIn')}</Tag>}
                </div>
                {bundle.description !== undefined && <p className={css.description}>{bundle.description}</p>}
                <div className={css.rowMeta}>
                  {bundle.version !== undefined && <span>{bundle.version}</span>}
                  {bundle.readOnly && <span>{t('readOnly')}</span>}
                </div>
                {bundle.problem !== undefined && <p className={css.problem}>{problemCopy(bundle.problem, t, 'changeFailed')}</p>}
                {bundle.name === 'dsh-community' && <p className={css.meta}>{t('marketProtected')}</p>}
              </div>
              <div className={css.actions}>
                <Button size="sm" variant="outline"
                  disabled={operationBusy || bundle.readOnly || bundle.name === 'dsh-community' || state?.hostProblem !== undefined}
                  onClick={() => { void changeBundle(bundle, false) }}>{t(bundle.enabled ? 'disable' : 'enable')}</Button>
                {bundle.removable && bundle.name !== 'dsh-community'
                  && <Button size="sm" disabled={operationBusy || bundle.readOnly || state?.hostProblem !== undefined}
                  onClick={() => { setRemoveBundle(bundle) }}>{t('remove')}</Button>}
              </div>
            </li>)}</ul>}
      </>}

      {tab === 'tasks' && <>
        <div className={css.sectionHead}><span>{t('taskCount', { count: String(tasks.length) })}</span></div>
        {tasks.length === 0 ? <Empty title={t('emptyTasks')} description={t('emptyTasksHint')} />
          : <ul className={css.list} aria-live="polite">{[...tasks].sort((a, b) => b.createdAt - a.createdAt).map(task => {
            const guide = releaseGuide(task.problem, catalog?.plugins.find(plugin => plugin.id === task.plugin.id))
            return <li className={`${css.row} ${css.task}`} key={task.id}>
              <span className={css.artwork} aria-hidden="true"><PluginArtworkDefault size={32} /></span>
              <div className={css.rowBody}>
                <div className={css.rowTitle}><span className={css.name}>{task.plugin.name}</span>
                  <span className={css.taskStatus}><StateDot state={stateDot(task)} size={6} />{t(PHASE_KEYS[task.phase])}</span>
                  {task.adapted === true && <Tag>{t('adapted')}</Tag>}
                </div>
                <div className={css.rowMeta}>
                  {task.version !== undefined && <span>{task.version}</span>}
                  {task.packageName !== undefined && <span>{task.packageName}</span>}
                  <span>{new Date(task.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <TaskDetails task={task} t={t} />
                <CommunityTaskLogPanel api={api} task={task} locale={locale} />
              </div>
              <div className={css.actions}>
                {isActive(task) && <Button size="sm" disabled={task.phase === 'cancelling' || task.phase === 'rolling-back'}
                  onClick={() => { void cancelTask(task) }}>{t('cancel')}</Button>}
                {(task.phase === 'failed' || task.phase === 'cancelled') && <Button size="sm" variant="outline"
                  disabled={guide === undefined && (operationBusy || state?.hostProblem !== undefined)}
                  onClick={() => { requestInstall(task.plugin, task.problem) }}>{t(guide === 'external' ? 'openReleaseInstructions' : guide === 'manual' ? 'manualInstructions' : 'retry')}</Button>}
              </div>
            </li>
          })}</ul>}
      </>}
    </section>

    {selectedIntent !== null && <Modal open className={css.modal ?? ''} contentClassName={css.modalContent ?? ''} closeLabel={t('close')}
      title={t(selectedBoundary ? 'releaseInstructionsTitle' : selectedManual ? 'manualInstallTitle' : 'installTitle', { name: selectedPlugin?.name ?? selectedIntent.name })} onClose={() => { setDetail(null) }}
      footer={<>
        <Button onClick={() => { setDetail(null) }}>{t('cancel')}</Button>
        {selectedGuide
          ? <Button variant="primary" onClick={() => { openWebsite(`/plugins/${encodeURIComponent(selectedIntent.id)}`) }}>{t(selectedBoundary ? 'openReleaseInstructions' : 'manualInstructions')}</Button>
          : <Button variant="primary" disabled={operationBusy || state === null || stateError || state.hostProblem !== undefined}
            onClick={() => { requestInstall(selectedIntent) }}>{t('installConfirm')}</Button>}
      </>}>
      {selectedPlugin?.description && <p className={css.detailDescription}>{selectedPlugin.description}</p>}
      {detailLoading && <p className={css.meta} role="status">{t('loading')}</p>}
      {detailError && <div className={css.notice} data-tone="error" role="alert"><p>{t('detailFailed')}</p>
        <Button size="sm" onClick={() => { setDetailRetry(value => value + 1) }}>{t('retry')}</Button></div>}
      <dl className={css.facts}>
        <dt>{t('source')}</dt><dd>{selectedSource === 'https://deepseek.stream'
          ? `${t('sourceName')} · ${t('websiteDestination')}`
          : `${t('externalSource')} · ${selectedSource}`}</dd>
        <dt>{t('publisher')}</dt><dd>{selectedPlugin?.author || t('publisherUnknown')}</dd>
        <dt>{t('version')}</dt><dd>{selectedIntent.version || t('latest')}</dd>
        <dt>{t('packageName')}</dt><dd>{selectedPlugin?.npmPackage ?? selectedIntent.id}</dd>
        {selectedPlugin?.compatibility !== undefined && <><dt>{t('compatibility')}</dt><dd>{selectedPlugin.compatibility}</dd></>}
        {selectedPlugin?.harnessVersion !== undefined && <><dt>{t('compatibility')}</dt><dd>{selectedPlugin.harnessVersion}</dd></>}
        {(selectedPlugin?.permissions?.length ?? 0) > 0 && <><dt>{t('permissions')}</dt><dd>{selectedPlugin?.permissions?.join(', ')}</dd></>}
        <dt>{t('price')}</dt><dd>{(selectedPlugin?.price ?? 0) > 0
          ? <Button size="sm" variant="outline" onClick={() => { openWebsite(`/plugins/${encodeURIComponent(selectedIntent.id)}`) }}>{t('unlock')}</Button>
          : t('free')}</dd>
        {!selectedGuide && <><dt>{t('target')}</dt><dd>{t('targetName')}</dd></>}
      </dl>
      {selectedGuide ? <p className={css.targetNote}>{t(selectedBoundary ? 'externalInstallRequired' : 'manualInstallRequired')}</p> : <>
        <p className={css.targetNote}>{t('targetNote')}</p>
        <p className={css.meta}>{t('verificationNote')}</p>
      </>}
      {detailPlugin !== null && <section className={css.readme} aria-label={t('readme')}>
        <h2>{t('readme')}</h2>
        {detailPlugin.readme ? <MarkdownText text={detailPlugin.readme}
          labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />
          : <p className={css.meta}>{t('noReadme')}</p>}
      </section>}
      {(selectedPlugin?.screenshots?.length ?? 0) > 0 && <section className={css.screenshots} aria-label={t('screenshots')}>
        {selectedPlugin?.screenshots?.map((url, index) => <img key={url} src={url} loading="lazy" referrerPolicy="no-referrer"
          alt={t('screenshot', { index: String(index + 1) })} />)}
      </section>}
      {selectedInstalled && <p className={css.meta}>{t('alreadyInstalled')}</p>}
      {operationBusy && <p className={css.meta}>{t('busy')}</p>}
      {notice?.failed && <p className={css.problem} role="alert">{noticeText}</p>}
    </Modal>}

    {loginOpen && <Modal open className={css.modal ?? ''} contentClassName={css.modalContent ?? ''} closeLabel={t('close')}
      title={t('signInTitle')} description={t('signInDescription')} onClose={closeLogin}
      footer={<>
        <Button onClick={closeLogin}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={`${prefix}-login-form`} disabled={loginBusy}>
          {t(resumedIntent.current === null ? 'signIn' : 'signInContinue')}
        </Button>
      </>}>
      <form id={`${prefix}-login-form`} className={css.form} onSubmit={event => { event.preventDefault(); void signIn() }}>
        <label className={css.field}>{t('username')}
          <Input value={email} autoComplete="username" data-modal-autofocus
            disabled={loginBusy} onChange={event => { setEmail(event.target.value) }} />
        </label>
        <label className={css.field}>{t('password')}
          <Input type="password" value={password} autoComplete="current-password"
            disabled={loginBusy} onChange={event => { setPassword(event.target.value) }} />
        </label>
        <div className={css.actions}>
          <Button size="sm" variant="outline" type="button" disabled={loginBusy}
            onClick={() => { openAccountWebsite('/auth/register') }}>{t('registerCommunityAccount')}</Button>
          <Button size="sm" variant="ghost" type="button" disabled={loginBusy}
            onClick={() => { openAccountWebsite('/') }}>{t('openCommunityWebsite')}</Button>
        </div>
        <p className={css.meta}>{t('registrationReturnHint')}</p>
        {loginError !== null && <p className={css.problem} role="alert">{t(loginError)}</p>}
      </form>
    </Modal>}

    {removeBundle !== null && <Modal open className={css.modal ?? ''} contentClassName={css.modalContent ?? ''} closeLabel={t('close')}
      title={t('removeTitle', { name: removeBundle.name })} description={t('removeDescription')}
      onClose={() => { setRemoveBundle(null) }} footer={<>
        <Button onClick={() => { setRemoveBundle(null) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={operationBusy} onClick={() => { void changeBundle(removeBundle, true) }}>{t('remove')}</Button>
      </>}>
      <dl className={css.facts}><dt>{t('target')}</dt><dd>{t('targetName')}</dd></dl>
      {notice?.failed && <p className={css.problem} role="alert">{noticeText}</p>}
    </Modal>}
  </div>
}
