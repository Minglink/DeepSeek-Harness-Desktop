/** Main-owned catalog, account summaries, and serialized native plugin operations. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDshUrl, type DshProtocolParams } from './installer.ts'
import { CommunityInstallError, prepareCommunityBundle, type CommunityInstallOptions, type PreparedCommunityBundle } from './community-install.ts'
import type { CommunityAccount } from './api-vault.ts'
import type { CommunityBundle, CommunityCatalog, CommunityCatalogQuery, CommunityChange, CommunityInstallIntent, CommunityInstallLogChunk, CommunityPlugin, CommunityPluginDetail, CommunityState, CommunityTask, CommunityTaskId, CommunityTaskLog } from './community-types.ts'
import { communityCatalogPlugin, communityCatalogQuery, loadCommunityCatalog, loadCommunityPlugin } from './community-catalog.ts'
import { CommunityTransactionError } from './community-transaction.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { communityFailureSummary } from './community-failure.ts'
import { CommunityTaskLogStore, communityLogTaskId, formatCommunityTaskLog } from './community-task-log.ts'
import { CommunityRuntimeLogStore, formatCommunityRuntimeLog, type CommunityRuntimeLogInput } from './community-runtime-log.ts'
import type { CommunityRuntimeLog } from './community-types.ts'

const COMMUNITY_MARKET_BUNDLE = 'dsh-community'

/** Dependencies are instance-owned so tests never access the person's profile or account. */
export interface CommunityServiceOptions {
  directory: string
  /** Main creates the same store before package preparation, so startup and client history have one writer. */
  runtimeLog?: CommunityRuntimeLogStore
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
  private readonly runtimeLog: CommunityRuntimeLogStore
  private readonly log: CommunityTaskLogStore
  private readonly logSecrets = new Set<string>()
  private readonly nativeJobs = new Set<string>()
  private readonly progressTimes = new Map<CommunityTaskId, number>()

  /** @param options - Main-owned services and persistent artifact location. */
  constructor(private readonly options: CommunityServiceOptions) {
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.disposeTimeoutMs) || this.disposeTimeoutMs < 1) throw new Error('Invalid community shutdown grace period')
    this.log = new CommunityTaskLogStore(options.directory,
      () => [...this.logSecrets, options.account()?.token ?? ''], () => { options.changed() })
    this.runtimeLog = options.runtimeLog ?? new CommunityRuntimeLogStore(options.directory,
      () => [...this.logSecrets, options.account()?.token ?? ''], () => { options.changed() })
    this.historyReady = this.readHistory()
    void this.historyReady.catch(() => { /* Calls await historyReady and report an invalid durable record explicitly. */ })
  }

  private async readHistory(): Promise<void> {
    let content: string
    try { content = await readFile(join(this.options.directory, 'tasks-v1.json'), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.log.retain(new Set(this.tasks.keys()))
      return
    }
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
    const completed = [...this.tasks.values()].filter(settled)
    for (const task of completed.slice(0, Math.max(0, completed.length - 100))) this.tasks.delete(task.id)
    await this.log.retain(new Set(this.tasks.keys()))
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

  /** Admission for a Host restart must include queued/downloading preparations, before native trial begins. */
  get hasPendingInstallation(): boolean { return this.disposed || this.controls.size > 0 }

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
    this.log.append(task.taskId, { phase: 'failed', level: 'warning', source: 'system', code,
      text: 'Interrupted installation recovered; previous profile restored.' }, true)
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
    if (this.controls.size >= 20) throw new Error('Too many pending installations')
    const id = randomUUID() as CommunityTaskId
    const now = Date.now()
    const task: CommunityTask = { id, plugin: intent, phase: 'queued', createdAt: now, updatedAt: now }
    this.tasks.set(id, task)
    this.log.append(id, { phase: 'queued', level: 'info', source: 'system', text: '' }, true)
    this.controls.set(id, new AbortController())
    this.options.changed()
    this.saveHistory()
    const source = this.sources.get(`${intent.id}@${intent.version ?? 'latest'}`)
    this.queue = this.queue.then(() => this.run(task, source)).catch((error: unknown) => {
      // Unexpected service failures terminate this task and leave the serialization queue usable.
      this.recordFailure(id, error, 'operation-error')
      this.update(id, { phase: 'failed', problem: { code: 'operation-error' } })
      return this.log.finish(id)
    })
    this.completions.set(id, this.queue)
    return task
  }

  private update(id: CommunityTaskId, patch: Partial<CommunityTask>): void {
    const task = this.tasks.get(id)
    if (task === undefined) return
    if (patch.phase !== undefined && patch.phase !== task.phase) this.log.append(id, {
      phase: patch.phase, level: patch.phase === 'failed' ? 'error' : patch.phase === 'cancelled' || patch.phase === 'rolling-back' ? 'warning' : 'info',
      source: 'system', text: '', ...(patch.problem === undefined ? {} : { code: patch.problem.code }),
    }, true)
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
      if (account !== null) this.logSecrets.add(account.token)
      const adaptation = this.options.adaptation?.()
      if (adaptation?.apiKey !== undefined) this.logSecrets.add(adaptation.apiKey)
      this.update(task.id, { phase: 'downloading' })
      const preparationOptions: CommunityInstallOptions = {
        artifactDirectory: join(this.options.directory, 'artifacts'), signal: control.signal,
        ...(account === null ? {} : { token: account.token }),
        onDownloadAttempt: (attempt) => {
          if (control.signal.aborted) return
          if (attempt.phase === 'start') {
            this.progressTimes.delete(task.id)
            const current = this.tasks.get(task.id)
            if (current !== undefined) {
              const reset = { ...current }
              delete reset.totalBytes
              this.tasks.set(task.id, reset)
            }
            this.update(task.id, { phase: 'downloading', receivedBytes: 0 })
            this.log.append(task.id, { phase: 'downloading', level: 'info', source: 'system',
              text: `Download attempt ${attempt.attempt} / ${attempt.maxAttempts}; total budget ${attempt.timeoutMs} ms; connection timeout ${attempt.connectTimeoutMs} ms; idle timeout ${attempt.idleTimeoutMs} ms` }, true)
          } else if (attempt.phase === 'retry') {
            this.log.append(task.id, { phase: 'downloading', level: 'warning', source: 'system', code: 'download-retry',
              text: `Download attempt ${attempt.attempt} failed; retrying attempt ${attempt.attempt + 1} / ${attempt.maxAttempts} after ${attempt.retryDelayMs ?? 0} ms; discarded the partial archive` }, true)
            this.recordFailure(task.id, attempt.error, 'download-retry', 'warning')
          } else {
            this.log.append(task.id, { phase: 'downloading', level: 'error', source: 'system', code: 'download-failed',
              text: `Download attempt ${attempt.attempt} / ${attempt.maxAttempts} failed; stopped without another automatic retry` }, true)
          }
        },
        onProgress: (progress) => {
          if (progress.phase === 'prepared' || control.signal.aborted) return
          const current = this.tasks.get(task.id)
          const now = Date.now(), last = this.progressTimes.get(task.id) ?? 0
          const done = progress.totalBytes !== undefined && progress.receivedBytes === progress.totalBytes
          if (current?.phase !== progress.phase || now - last >= 500 || done) {
            this.progressTimes.set(task.id, now)
            this.update(task.id, { ...progress, phase: progress.phase })
            if (progress.receivedBytes !== undefined) this.log.append(task.id, { phase: progress.phase, level: 'info', source: 'system',
              text: `Downloaded ${progress.receivedBytes}${progress.totalBytes === undefined ? '' : ` / ${progress.totalBytes}`} bytes` })
          }
        },
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input)
          const phase = this.tasks.get(task.id)?.phase ?? 'downloading'
          this.log.append(task.id, { phase, level: 'info', source: 'system', text: `${init?.method ?? 'GET'} ${url}` })
          try {
            const response = await (this.options.fetch ?? globalThis.fetch)(input, init)
            this.log.append(task.id, { phase, level: response.ok ? 'info' : 'warning', source: 'system', text: `HTTP ${response.status} ${url}` })
            return response
          } catch (error) {
            this.recordFailure(task.id, error, 'network')
            throw error
          }
        },
        ...(adaptation === undefined ? {} : { adaptation }),
      }
      let prepared = await (this.options.prepare ?? prepareCommunityBundle)(intent, preparationOptions)
      checkCancelled(control.signal)
      this.update(task.id, { phase: 'installing', packageName: prepared.packageName, version: prepared.version })
      if (this.options.apply !== undefined) {
        try { await this.options.apply(prepared, task, control.signal, (phase) => { this.update(task.id, { phase }) }) }
        catch (error) {
          if (!control.signal.aborted) {
            console.warn('[community] Initial installation failure', { taskId: task.id, ...communityFailureSummary(error) })
            this.recordFailure(task.id, error)
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
        this.log.append(task.id, { phase: 'applied', level: 'info', source: 'system',
          text: `Active package: ${prepared.packageName}@${prepared.version}; adapted=${String(prepared.adapted === true)}` }, true)
      } else {
        const result = change(await this.invoke('installBundle', { spec: prepared.spec, options: { enabled: true, requestId: task.id } }))
        this.update(task.id, { phase: result.application, ...(result.problem === undefined ? {} : { problem: result.problem }) })
      }
    } catch (error) {
      if (error !== reportedFailure && !control.signal.aborted) {
        console.warn('[community] Installation failure', { taskId: task.id, ...communityFailureSummary(error) })
        this.recordFailure(task.id, error)
      }
      const code = error instanceof CommunityInstallError ? error.problem : error instanceof CommunityTransactionError ? error.code : 'host-unavailable'
      this.update(task.id, { phase: code === 'cancelled' ? 'cancelled' : 'failed', problem: { code },
        ...(error instanceof CommunityTransactionError ? { restored: error.restored }
          : firstTrialFailure === undefined ? {} : { restored: firstTrialFailure.restored }) })
      const outcome = this.tasks.get(task.id)
      if (outcome !== undefined) this.log.append(task.id, { phase: outcome.phase, level: outcome.phase === 'cancelled' ? 'warning' : 'error', source: 'system', code,
        text: `Previous profile restored: ${String(outcome.restored ?? false)}; adaptation eligible: ${String(error instanceof CommunityTransactionError && error.adaptationEligible)}` }, true)
    } finally {
      try { await this.log.finish(task.id) }
      catch (_error) { /* Diagnostic failures do not change a confirmed installation or recovery outcome. */ }
      this.controls.delete(task.id)
      this.completions.delete(task.id)
      this.progressTimes.delete(task.id)
      for (const job of this.nativeJobs) if (job.startsWith(`${task.id}:`)) this.nativeJobs.delete(job)
      const completed = [...this.tasks.values()].filter(settled)
      for (const old of completed.slice(0, Math.max(0, completed.length - 100))) {
        this.tasks.delete(old.id)
        await this.log.remove(old.id).catch((_error: unknown) => { /* A missing evicted log does not change the installation outcome. */ })
      }
      this.saveHistory()
    }
  }

  private recordFailure(id: CommunityTaskId, error: unknown, code?: string, level: 'error' | 'warning' = 'error'): void {
    const task = this.tasks.get(id)
    if (task === undefined) return
    const summary = communityFailureSummary(error)
    const explanation = summary.cause === 'baseline-start'
      ? ['Existing profile failed to start before the new plugin was loaded. 已有环境启动失败，新插件尚未加载。'] : []
    const details: string[] = []
    if (error instanceof CommunityInstallError && error.statusCode !== undefined) details.push(`HTTP ${error.statusCode}`)
    if (error instanceof CommunityTransactionError) details.push(error.diagnosticTail ?? error.diagnostic ?? error.message)
    let cause: unknown = error
    for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
      const nativeCode = 'code' in cause && typeof cause.code === 'string' ? ` [${cause.code}]` : ''
      details.push(`${cause.name}${nativeCode}: ${cause.message}`)
      cause = cause.cause
    }
    this.log.stream(id, 'failure', { phase: task.phase, level, source: 'system', code: code ?? summary.code,
      text: [`Cause: ${summary.cause}`, ...explanation, ...details].join('\n') }, true)
  }

  /** Only the current owned task can receive native pnpm output. */
  recordInstallLog(id: CommunityTaskId, chunk: CommunityInstallLogChunk): void {
    const task = this.tasks.get(id)
    if (chunk.requestId !== id || task === undefined || settled(task) || !this.controls.has(id)) return
    const job = `${id}:${chunk.jobId}`
    if (!this.nativeJobs.has(job)) {
      if (this.nativeJobs.size >= 100) return
      this.nativeJobs.add(job)
      this.log.append(id, { phase: task.phase, level: 'info', source: 'pnpm',
        text: `pnpm ${chunk.argv.join(' ')}\ncwd: ${chunk.cwd}` }, true)
    }
    const input = { phase: task.phase, level: chunk.stream === 'stderr' ? 'warning' as const : 'info' as const, source: 'pnpm' as const, text: chunk.text }
    this.log.stream(id, `${chunk.jobId}:${chunk.stream}`, input, chunk.exitCode !== undefined)
    if (chunk.exitCode !== undefined) {
      // The final event flushes both streams, including stdout that never ended in a newline.
      this.log.stream(id, `${chunk.jobId}:${chunk.stream === 'stdout' ? 'stderr' : 'stdout'}`, { ...input, text: '' }, true)
      this.log.append(id, { phase: task.phase, level: chunk.exitCode === 0 ? 'info' : 'error', source: 'pnpm',
        text: `pnpm process exited: ${String(chunk.exitCode)}`, exitCode: chunk.exitCode }, true)
    }
  }

  /** Candidate and activation Host output is assigned by the main-owned process closure. */
  recordHostOutput(id: CommunityTaskId, output: { stream: 'stdout' | 'stderr'; text: string }): void {
    const task = this.tasks.get(id)
    if (task === undefined || settled(task) || !this.controls.has(id)) return
    this.log.stream(id, `host:${output.stream}`, { phase: task.phase, level: output.stream === 'stderr' ? 'warning' : 'info', source: 'host', text: output.text })
  }

  /** @param input - The owned window's complete event; no installation task is selected. */
  recordRendererLog(input: CommunityRuntimeLogInput): void {
    if (this.disposed) return
    const account = this.options.account()
    if (account !== null) this.logSecrets.add(account.token)
    try {
      const key = this.options.adaptation?.().apiKey
      if (key !== undefined) this.logSecrets.add(key)
    } catch (_error) { /* A configuration error must not prevent an observed client failure from being recorded. */ }
    this.runtimeLog.append(input)
  }

  /** @param after - Last observed sequence, or zero for retained history. @returns Client events without invoking the Host. */
  getRuntimeLog(after = 0): Promise<CommunityRuntimeLog> { return this.runtimeLog.read(after) }

  /** @returns The same sanitized client report used for native copy and export. */
  async runtimeLogText(): Promise<string> {
    await this.runtimeLog.flush()
    return formatCommunityRuntimeLog(await this.runtimeLog.read())
  }

  /** Logs remain readable without a running Host; the renderer can select only a retained task. */
  async getTaskLog(value: unknown, after = 0): Promise<CommunityTaskLog> {
    await this.historyReady
    const id = communityLogTaskId(value)
    if (!this.tasks.has(id)) throw new Error('Unknown installation task')
    return this.log.read(id, after)
  }

  /** Copy and export share the same sanitized report, including status and restoration outcome. */
  async taskLogText(value: unknown): Promise<string> {
    const log = await this.getTaskLog(value)
    await this.log.flush()
    const task = this.tasks.get(log.id)
    if (task === undefined) throw new Error('Unknown installation task')
    return formatCommunityTaskLog(task, await this.log.read(log.id))
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
      await this.log.flush()
      await this.runtimeLog.flush()
    } finally {
      clearTimeout(deadline)
      this.shutdown.abort(new Error('Community service stopped'))
    }
  }
}
