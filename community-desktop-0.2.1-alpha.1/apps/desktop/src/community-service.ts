/** Main-owned catalog, account summaries, and serialized native plugin operations. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDshUrl, type DshProtocolParams } from './installer.ts'
import { CommunityInstallError, prepareCommunityBundle, type CommunityInstallOptions, type PreparedCommunityBundle } from './community-install.ts'
import type { CommunityAccount } from './api-vault.ts'
import type { CommunityBundle, CommunityCatalog, CommunityCatalogQuery, CommunityChange, CommunityInstallIntent, CommunityPlugin, CommunityPluginDetail, CommunityState, CommunityTask, CommunityTaskId } from './community-types.ts'
import { communityCatalogPlugin, communityCatalogQuery, loadCommunityCatalog, loadCommunityPlugin } from './community-catalog.ts'
import { CommunityTransactionError } from './community-transaction.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { communityFailureSummary } from './community-failure.ts'

const COMMUNITY_MARKET_BUNDLE = 'dsh-community'

/** Dependencies are instance-owned so tests never access the person's profile or account. */
export interface CommunityServiceOptions {
  directory: string
  account(): CommunityAccount | null
  invoke(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  changed(): void
  fetch?: typeof globalThis.fetch
  prepare?: (intent: DshProtocolParams, options: CommunityInstallOptions) => Promise<PreparedCommunityBundle>
  /** Main-only model configuration; never included in product state. */
  adaptation?: () => NonNullable<CommunityInstallOptions['adaptation']>
  /** Candidate trial and recoverable promotion; production always supplies this hook. */
  apply?: (prepared: PreparedCommunityBundle, task: CommunityTask, signal: AbortSignal, phase: (phase: 'trial' | 'activating' | 'rolling-back') => void) => Promise<void>
  /** Grace period before detaching unresponsive native RPC observations during application shutdown. */
  disposeTimeoutMs?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, limit: number, multiline = false): string | undefined {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u
  return typeof value === 'string' && value.length <= limit && !controls.test(value) ? value : undefined
}

/**
 * Validate a renderer or protocol selection without accepting credentials or executable package locations.
 * @param value - Selection received across Electron IPC.
 * @returns The validated intent.
 */
export function communityIntent(value: unknown): CommunityInstallIntent {
  if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || Object.keys(value).some(key => !['id', 'name', 'version'].includes(key))
    || (value.version !== undefined && typeof value.version !== 'string')) throw new Error('Invalid community selection')
  const params = new URLSearchParams({ id: value.id, name: value.name })
  if (value.version !== undefined) params.set('version', value.version)
  const parsed = parseDshUrl(`dsh://plugin/install?${params}`)
  if (parsed === null) throw new Error('Invalid community selection')
  return { id: parsed.id, name: parsed.name, ...(parsed.version === 'latest' ? {} : { version: parsed.version }) }
}

function plugin(value: unknown): CommunityPlugin {
  return communityCatalogPlugin(value)
}

function change(value: unknown): CommunityChange {
  if (!record(value) || typeof value.changed !== 'boolean'
    || !['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(value.application))) throw new Error('Invalid native plugin result')
  const code = record(value.error) ? text(value.error.code, 100) : undefined
  const packageKind = record(value.packageResult) ? text(value.packageResult.kind, 100) : undefined
  return {
    changed: value.changed,
    application: value.application as CommunityChange['application'],
    ...code === undefined && packageKind === undefined ? {} : { problem: { code: packageKind ?? code ?? 'operation-error' } },
  }
}

function bundles(value: unknown): CommunityBundle[] {
  if (!Array.isArray(value)) throw new Error('Invalid native bundle inventory')
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.name !== 'string' || typeof item.enabled !== 'boolean' || typeof item.removable !== 'boolean') throw new Error('Invalid native bundle inventory')
    const version = text(item.version, 100), description = text(item.description, 8_192)
    const market = item.name === COMMUNITY_MARKET_BUNDLE
    return { name: item.name, enabled: item.enabled, removable: !market && item.removable,
      readOnly: market || item.readOnlyReason !== undefined,
      ...(version === undefined ? {} : { version }), ...(description === undefined ? {} : { description }),
      ...record(item.error) && typeof item.error.code === 'string' ? { problem: { code: item.error.code } } : {} }
  })
}

const settled = (task: CommunityTask): boolean => ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(task.phase)

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CommunityInstallError('cancelled', 'Installation cancelled')
}

/** Serializes community installs while the native manager owns package writes, rollback, and activation. */
export class DesktopCommunityService {
  private readonly tasks = new Map<CommunityTaskId, CommunityTask>()
  private readonly controls = new Map<CommunityTaskId, AbortController>()
  private readonly completions = new Map<CommunityTaskId, Promise<void>>()
  private readonly sources = new Map<string, DshProtocolParams>()
  private queue: Promise<void> = Promise.resolve()
  private pending: CommunityInstallIntent | null = null
  private catalogRead: Promise<CommunityCatalog> | undefined
  private cached: CommunityCatalog | undefined
  private disposed = false
  private readonly shutdown = new AbortController()
  private readonly disposeTimeoutMs: number
  private disposal: Promise<void> | undefined
  private readonly historyReady: Promise<void>
  private historyWrite: Promise<void> = Promise.resolve()
  private historyProblem: unknown

  /** @param options - Main-owned services and persistent artifact location. */
  constructor(private readonly options: CommunityServiceOptions) {
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.disposeTimeoutMs) || this.disposeTimeoutMs < 1) throw new Error('Invalid community shutdown grace period')
    this.historyReady = this.readHistory()
    void this.historyReady.catch(() => { /* Calls await historyReady and report an invalid durable record explicitly. */ })
  }

  private async readHistory(): Promise<void> {
    let content: string
    try { content = await readFile(join(this.options.directory, 'tasks-v1.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Community history exceeds its size limit')
    const value: unknown = JSON.parse(content)
    if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid community task history')
    for (const item of value) {
      if (!record(item) || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.id)
        || !record(item.plugin) || typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number'
        || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)
        || typeof item.phase !== 'string' || !['queued', 'downloading', 'adapting', 'validating', 'packaging', 'trial', 'installing', 'activating', 'rolling-back', 'cancelling', 'applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(item.phase)) throw new Error('Invalid community task history')
      const plugin = communityIntent({ id: item.plugin.id, name: item.plugin.name,
        ...(item.plugin.version === undefined ? {} : { version: item.plugin.version }) })
      const id = item.id as CommunityTaskId
      if (this.tasks.has(id)) continue
      const task: CommunityTask = { id, plugin, phase: item.phase as CommunityTask['phase'], createdAt: item.createdAt, updatedAt: item.updatedAt,
        ...(typeof item.packageName === 'string' ? { packageName: item.packageName } : {}),
        ...(typeof item.version === 'string' ? { version: item.version } : {}),
        ...(item.adapted === true ? { adapted: true } : {}), ...(item.restored === true ? { restored: true } : {}),
        ...(record(item.problem) && typeof item.problem.code === 'string' ? { problem: { code: item.problem.code.slice(0, 100) } } : {}) }
      this.tasks.set(id, settled(task) ? task : { ...task, phase: 'failed', problem: { code: 'installation-interrupted' } })
    }
  }

  private saveHistory(): void {
    this.historyWrite = this.historyWrite.then(async () => {
      await this.historyReady
      await writeFileAtomic(join(this.options.directory, 'tasks-v1.json'), JSON.stringify([...this.tasks.values()].slice(-200)) + '\n', { mode: 0o600, dirMode: 0o700 })
    }).catch((error: unknown) => { this.historyProblem = error })
  }

  private async flushHistory(): Promise<void> {
    await this.historyReady
    await this.historyWrite
    if (this.historyProblem !== undefined) throw new CommunityTransactionError('storage-failed', true)
  }

  private invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    return this.options.invoke(method, args, this.shutdown.signal)
  }

  /** @param intent - An already parsed operating-system link. */
  open(intent?: DshProtocolParams): void {
    if (intent !== undefined) {
      this.pending = {
        ...communityIntent({ id: intent.id, name: intent.name, version: intent.version }),
        sourceOrigin: new URL(intent.downloadUrl ?? 'https://deepseek.stream').origin,
      }
      const version = this.pending.version ?? 'latest'
      this.sources.set(`${intent.id}@${version}`, { ...intent, version })
    }
  }

  /** @returns The next protocol selection, consumed only by the product panel. */
  takePending(): CommunityInstallIntent | null {
    const intent = this.pending
    this.pending = null
    return intent
  }

  /** @returns Safe account data, current-profile bundles, and all retained task outcomes. */
  async getState(): Promise<CommunityState> {
    await this.historyReady
    const account = this.options.account()
    const base = {
      account: account === null ? null : { username: account.username, email: account.email }, tasks: [...this.tasks.values()],
    }
    try { return { ...base, bundles: bundles(await this.invoke('listBundles', {})) } }
    catch (_error) {
      // Host failures must never turn an unavailable inventory into an apparent empty profile.
      return { ...base, bundles: [], hostProblem: { code: 'host-unavailable' } }
    }
  }

  /**
   * @param refresh - Ignore the local snapshot and fetch every server page.
   * @returns A complete catalog or an explicitly marked offline copy.
   */
  async catalog(refresh = false, query?: CommunityCatalogQuery): Promise<CommunityCatalog> {
    if (query !== undefined) return loadCommunityCatalog(communityCatalogQuery(query), {
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }), signal: this.shutdown.signal })
    if (!refresh && this.cached !== undefined) return this.cached
    if (!refresh) {
      try {
        const value: unknown = JSON.parse(await readFile(join(this.options.directory, 'catalog-v1.json'), 'utf8'))
        if (record(value) && typeof value.updatedAt === 'number' && Array.isArray(value.plugins)) {
          const skippedCount = typeof value.skippedCount === 'number' && Number.isSafeInteger(value.skippedCount)
            && value.skippedCount > 0 ? value.skippedCount : 0
          const result = {
            updatedAt: value.updatedAt, plugins: value.plugins.map(plugin), cached: true,
            ...(skippedCount === 0 ? {} : { skippedCount }),
          }
          this.cached = result
          return result
        }
      } catch (_error) {
        // A missing or invalid optional snapshot is replaced by a validated network response.
      }
    }
    if (this.catalogRead !== undefined) return this.catalogRead
    const request = this.loadCatalog()
    this.catalogRead = request
    try { return await request }
    finally { if (this.catalogRead === request) this.catalogRead = undefined }
  }

  /** @param id - Community item identity. @returns Validated full details from the website. */
  detail(id: string): Promise<CommunityPluginDetail> {
    return loadCommunityPlugin(id, {
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }), signal: this.shutdown.signal })
  }

  /** @param task - An interrupted promotion restored before normal application startup. */
  recovered(task: { taskId: CommunityTaskId; plugin: CommunityInstallIntent }, code = 'installation-interrupted'): void {
    const now = Date.now()
    this.tasks.set(task.taskId, { id: task.taskId, plugin: task.plugin, phase: 'failed', restored: true,
      createdAt: now, updatedAt: now, problem: { code } })
    this.options.changed()
    this.saveHistory()
  }

  private async loadCatalog(): Promise<CommunityCatalog> {
    const items = new Map<string, CommunityPlugin>()
    const seen = new Set<string>()
    let received = 0, skippedCount = 0
    let downloadedBytes = 0
    const signal = AbortSignal.timeout(30_000)
    const request = this.options.fetch ?? globalThis.fetch
    let expectedTotal: number | undefined
    for (let page = 1; page <= 200; page++) {
      const response = await request(`https://deepseek.stream/api/plugins?pageSize=50&page=${page}&sortBy=hot`, { signal, redirect: 'error', credentials: 'omit' })
      if (!response.ok) throw new Error('Community catalog is unavailable')
      const body = response.body?.getReader()
      if (body === undefined) throw new Error('Invalid community catalog')
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const next = await body.read()
          if (next.done) break
          length += next.value.byteLength
          downloadedBytes += next.value.byteLength
          if (length > 8 * 1024 * 1024 || downloadedBytes > 64 * 1024 * 1024) throw new Error('Community catalog exceeds its response limit')
          chunks.push(next.value)
        }
      } finally { await body.cancel() }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!record(value) || !Array.isArray(value.plugins) || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || Number(value.total) > 10_000) throw new Error('Invalid community catalog')
      const total = Number(value.total)
      if (expectedTotal === undefined) expectedTotal = total
      else if (total !== expectedTotal) throw new Error('Community catalog changed during pagination; refresh it again')
      for (const entry of value.plugins) {
        if (record(entry) && typeof entry.id === 'string') {
          if (seen.has(entry.id)) throw new Error('Community catalog repeated an item during pagination; refresh it again')
          seen.add(entry.id)
        }
        received++
        try {
          const item = plugin(entry)
          items.set(item.id, item)
        } catch (_error) {
          // One unsupported record remains visible through the skipped count without hiding valid packages.
          skippedCount++
        }
      }
      if (received >= expectedTotal || value.plugins.length === 0) {
        if (received !== expectedTotal) throw new Error('Incomplete community catalog')
        if (items.size === 0 && skippedCount > 0) throw new Error('Community catalog contains no compatible package records')
        const catalog: CommunityCatalog = {
          plugins: [...items.values()], updatedAt: Date.now(), cached: false,
          ...(skippedCount === 0 ? {} : { skippedCount }),
        }
        await mkdir(this.options.directory, { recursive: true })
        const temporary = join(this.options.directory, `catalog-${randomUUID()}.tmp`)
        await writeFile(temporary, JSON.stringify(catalog) + '\n', { mode: 0o600 })
        await rename(temporary, join(this.options.directory, 'catalog-v1.json'))
        this.cached = catalog
        return catalog
      }
    }
    throw new Error('Incomplete community catalog')
  }

  /** @param value - Confirmed product selection. @returns The existing active task or a newly queued task. */
  install(value: unknown): CommunityTask {
    if (this.disposed) throw new Error('Community service is stopping')
    const intent = communityIntent(value)
    const existing = [...this.tasks.values()].find(task =>
      !settled(task) && task.plugin.id === intent.id && task.plugin.version === intent.version)
    if (existing !== undefined) return existing
    const id = randomUUID() as CommunityTaskId
    const now = Date.now()
    const task: CommunityTask = { id, plugin: intent, phase: 'queued', createdAt: now, updatedAt: now }
    this.tasks.set(id, task)
    this.controls.set(id, new AbortController())
    this.options.changed()
    this.saveHistory()
    const source = this.sources.get(`${intent.id}@${intent.version ?? 'latest'}`)
    this.queue = this.queue.then(() => this.run(task, source)).catch((_error: unknown) => {
      // Unexpected service failures terminate this task and leave the serialization queue usable.
      this.update(id, { phase: 'failed', problem: { code: 'operation-error' } })
    })
    this.completions.set(id, this.queue)
    return task
  }

  private update(id: CommunityTaskId, patch: Partial<CommunityTask>): void {
    const task = this.tasks.get(id)
    if (task === undefined) return
    this.tasks.set(id, { ...task, ...patch, updatedAt: Date.now() })
    this.options.changed()
    this.saveHistory()
  }

  private async run(task: CommunityTask, source: DshProtocolParams | undefined): Promise<void> {
    const control = this.controls.get(task.id)
    if (control === undefined) return
    let firstTrialFailure: CommunityTransactionError | undefined
    let reportedFailure: unknown
    try {
      await this.flushHistory()
      checkCancelled(control.signal)
      const version = task.plugin.version ?? 'latest'
      const intent = source ?? { ...task.plugin, version, repo: '' }
      const account = this.options.account()
      this.update(task.id, { phase: 'downloading' })
      const preparationOptions: CommunityInstallOptions = {
        artifactDirectory: join(this.options.directory, 'artifacts'), signal: control.signal,
        ...(account === null ? {} : { token: account.token }),
        onProgress: (progress) => {
          if (progress.phase !== 'prepared' && !control.signal.aborted) this.update(task.id, { ...progress, phase: progress.phase })
        },
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.adaptation === undefined ? {} : { adaptation: this.options.adaptation() }),
      }
      let prepared = await (this.options.prepare ?? prepareCommunityBundle)(intent, preparationOptions)
      checkCancelled(control.signal)
      this.update(task.id, { phase: 'installing', packageName: prepared.packageName, version: prepared.version })
      if (this.options.apply !== undefined) {
        try { await this.options.apply(prepared, task, control.signal, (phase) => { this.update(task.id, { phase }) }) }
        catch (error) {
          if (!control.signal.aborted) {
            console.warn('[community] Initial installation failure', { taskId: task.id, ...communityFailureSummary(error) })
            reportedFailure = error
          }
          if (error instanceof CommunityTransactionError) firstTrialFailure = error
          if (!(error instanceof CommunityTransactionError) || error.code !== 'trial-failed' || control.signal.aborted
            || !error.adaptationEligible
            || prepared.adapted === true || preparationOptions.adaptation?.apiKey === undefined
            || prepared.originalSpec === undefined || prepared.originalSha256 === undefined) throw error
          this.update(task.id, { phase: 'adapting' })
          prepared = await (this.options.prepare ?? prepareCommunityBundle)(intent, { ...preparationOptions,
            originalArchive: { spec: prepared.originalSpec, sha256: prepared.originalSha256,
              ...(prepared.repositoryArchive === undefined ? {} : { repositoryArchive: prepared.repositoryArchive }) },
            adaptation: { ...preparationOptions.adaptation, force: true, diagnostic: error.diagnostic ?? 'Candidate plugin failed isolated Harness startup or active registration checks. Repair version and dependency compatibility while preserving its features.' } })
          await this.options.apply(prepared, task, control.signal, (phase) => { this.update(task.id, { phase }) })
        }
        this.update(task.id, { phase: 'applied', adapted: prepared.adapted === true })
      } else {
        const result = change(await this.invoke('installBundle', { spec: prepared.spec, options: { enabled: true, requestId: task.id } }))
        this.update(task.id, { phase: result.application, ...(result.problem === undefined ? {} : { problem: result.problem }) })
      }
    } catch (error) {
      if (error !== reportedFailure && !control.signal.aborted) {
        console.warn('[community] Installation failure', { taskId: task.id, ...communityFailureSummary(error) })
      }
      const code = error instanceof CommunityInstallError ? error.problem : error instanceof CommunityTransactionError ? error.code : 'host-unavailable'
      this.update(task.id, { phase: code === 'cancelled' ? 'cancelled' : 'failed', problem: { code },
        ...(error instanceof CommunityTransactionError ? { restored: error.restored }
          : firstTrialFailure === undefined ? {} : { restored: firstTrialFailure.restored }) })
    } finally {
      this.controls.delete(task.id)
      this.completions.delete(task.id)
      const completed = [...this.tasks.values()].filter(settled)
      for (const old of completed.slice(0, Math.max(0, completed.length - 100))) this.tasks.delete(old.id)
    }
  }

  /** @param value - Task id returned by this service. @returns After active work settles; queued tasks are cancelled immediately. */
  async cancel(value: unknown): Promise<void> {
    if (typeof value !== 'string') throw new Error('Invalid installation task')
    const id = value as CommunityTaskId, task = this.tasks.get(id), control = this.controls.get(id)
    if (task === undefined || control === undefined || settled(task)) return
    const completion = this.completions.get(id)
    if (task.phase === 'cancelling') { await completion; return }
    control.abort()
    if (task.phase === 'installing' && this.options.apply === undefined) {
      this.update(id, { phase: 'cancelling' })
      try { await this.invoke('cancelInstall', { requestId: id }) }
      catch (_error) {
        // The original request still determines success, failure, or cancellation.
        const current = this.tasks.get(id)
        if (current !== undefined && !settled(current)) this.update(id, { phase: 'installing' })
      }
    } else if (task.phase === 'queued') { this.update(id, { phase: 'cancelled' }); return }
    else this.update(id, { phase: 'cancelling' })
    await completion
  }

  /**
   * @param name - Native inventory name.
   * @param enabled - Desired selection.
   * @returns Native application outcome, or refusal to disable the market's own interface.
   */
  async setEnabled(name: unknown, enabled: unknown): Promise<CommunityChange> {
    if (this.controls.size > 0) return { changed: false, application: 'failed', problem: { code: 'installation-active' } }
    if (typeof name !== 'string' || name.length > 214 || typeof enabled !== 'boolean') throw new Error('Invalid bundle selection')
    if (name === COMMUNITY_MARKET_BUNDLE && !enabled) return { changed: false, application: 'failed', problem: { code: 'market-required' } }
    const result = change(await this.invoke('setBundleEnabled', { name, enabled }))
    this.options.changed()
    return result
  }

  /** @param name - Native inventory name. @returns Native removal outcome, or refusal to remove the market's own interface. */
  async remove(name: unknown): Promise<CommunityChange> {
    if (this.controls.size > 0) return { changed: false, application: 'failed', problem: { code: 'installation-active' } }
    if (typeof name !== 'string' || name.length > 214) throw new Error('Invalid bundle selection')
    if (name === COMMUNITY_MARKET_BUNDLE) return { changed: false, application: 'failed', problem: { code: 'market-required' } }
    const result = change(await this.invoke('removeBundle', { name }))
    this.options.changed()
    return result
  }

  /**
   * @returns After owned preparations settle and native cancellation finishes, or the shutdown grace period aborts its HTTP observations.
   * The Host shutdown owns unfinished package transactions; a lost native result remains a failed task.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = this.stop()
    return this.disposal
  }

  private async stop(): Promise<void> {
    const deadline = setTimeout(() => { this.shutdown.abort(new Error('Community shutdown grace period expired')) }, this.disposeTimeoutMs)
    try {
      await Promise.allSettled([...this.controls.keys()].map(id => this.cancel(id)))
      await this.queue
      await this.historyWrite
    } finally {
      clearTimeout(deadline)
      this.shutdown.abort(new Error('Community service stopped'))
    }
  }
}
