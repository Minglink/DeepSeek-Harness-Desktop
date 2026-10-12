/** Public deepseek.stream catalog queries remain credential-free and expose no installation source authority. */
import { valid } from 'semver'
import { parseCommunitySourceUrl } from './installer.ts'
import type { CommunityCatalog, CommunityCatalogQuery, CommunityPlugin, CommunityPluginDetail } from './community-types.ts'

const ORIGIN = 'https://deepseek.stream'
const SORTS = ['hot', 'essential', 'soaring', 'newest', 'downloads', 'stars', 'rating'] as const
const PLATFORMS = ['all', 'desktop-exe', 'web', 'linux'] as const
const SOURCES = ['all', 'official', 'community', 'user_upload'] as const
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024

/** Server paging defaults resolved before an external request is sent. */
export interface ResolvedCommunityCatalogQuery extends CommunityCatalogQuery {
  readonly page: number
  readonly pageSize: number
  readonly sortBy: NonNullable<CommunityCatalogQuery['sortBy']>
}

/** HTTP and cancellation adapters owned by one catalog request. */
export interface CommunityCatalogOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
}

/** Stable catalog failures carry no response bodies, account claims, or credential-bearing URLs. */
export class CommunityCatalogError extends Error {
  /**
   * Create a failure for localized catalog feedback.
   * @param code - Public failure classification.
   * @param message - Credential-free diagnostic.
   */
  constructor(readonly code: 'invalid-query' | 'catalog-unavailable' | 'plugin-not-found' | 'invalid-catalog', message: string) {
    super(message)
    this.name = 'CommunityCatalogError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, limit: number, multiline = false): string | undefined {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u
  return typeof value === 'string' && value.length <= limit && !controls.test(value) ? value : undefined
}

function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some(item => item === value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[_a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
}

/**
 * Validate query fields received across IPC and resolve website pagination defaults.
 * @param value - Optional query object; extra fields and invalid filter values are refused.
 * @returns Bounded query filters with explicit page, page size, and ordering.
 */
export function communityCatalogQuery(value: unknown): ResolvedCommunityCatalogQuery {
  const input = value === undefined ? {} : value
  if (!record(input) || Object.keys(input).some(key => !['query', 'category', 'tag', 'platform', 'source', 'sortBy', 'page', 'pageSize'].includes(key))) {
    throw new CommunityCatalogError('invalid-query', 'Unsupported community catalog query fields')
  }
  const strings: { query?: string; category?: string; tag?: string } = {}
  for (const field of ['query', 'category', 'tag'] as const) {
    if (input[field] === undefined) continue
    const parsed = text(input[field], field === 'query' ? 256 : 100)
    if (parsed === undefined) throw new CommunityCatalogError('invalid-query', `Invalid community catalog ${field}`)
    strings[field] = parsed.trim()
  }
  if ((input.platform !== undefined && !member(input.platform, PLATFORMS))
    || (input.source !== undefined && !member(input.source, SOURCES))
    || (input.sortBy !== undefined && !member(input.sortBy, SORTS))) {
    throw new CommunityCatalogError('invalid-query', 'Unsupported community catalog filter')
  }
  const page = input.page ?? 1, pageSize = input.pageSize ?? 15
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 100_000
    || typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new CommunityCatalogError('invalid-query', 'Community catalog pagination is outside its supported range')
  }
  return { ...strings, page, pageSize, sortBy: member(input.sortBy, SORTS) ? input.sortBy : 'hot',
    ...(member(input.platform, PLATFORMS) ? { platform: input.platform } : {}),
    ...(member(input.source, SOURCES) ? { source: input.source } : {}) }
}

function strings(value: unknown, limit: number, length: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined
  const items = value.map((item: unknown) => text(item, length))
  return items.every((item): item is string => item !== undefined) ? items : undefined
}

function image(value: unknown): string | undefined {
  const supplied = text(value, 2_048)
  if (supplied === undefined || supplied === '') return undefined
  const url = parseCommunitySourceUrl(supplied.startsWith('/') && !supplied.startsWith('//') ? `${ORIGIN}${supplied}` : supplied)
  return url?.href
}

/**
 * Project one external catalog record into display metadata; download links and account fields are omitted.
 * @param value - Website record or cached external item.
 * @returns A validated catalog item; malformed identity, name, or description throws.
 */
export function communityCatalogPlugin(value: unknown): CommunityPlugin {
  if (!record(value) || !identifier(value.id)) throw new CommunityCatalogError('invalid-catalog', 'Invalid community plugin identity')
  const name = text(value.displayName ?? value.name, 160), description = text(value.description ?? '', 8_192, true)
  if (name === undefined || name.trim() === '' || description === undefined) throw new CommunityCatalogError('invalid-catalog', 'Invalid community plugin display metadata')
  const rawVersion = text(value.version, 100)
  const version = rawVersion === undefined || rawVersion === 'latest' ? undefined : valid(rawVersion)
  if (version === null) throw new CommunityCatalogError('invalid-catalog', 'Invalid community plugin version')
  const manual = value.manualDistribution
  if (manual !== undefined && manual !== true && (!record(manual) || manual.kind !== 'github-release'
    || manual.installMethod !== 'author-script' || manual.platform !== 'windows-x64')) {
    throw new CommunityCatalogError('invalid-catalog', 'Unsupported manual community distribution')
  }
  const result: CommunityPlugin = { id: value.id, name, description,
    ...(version === undefined ? {} : { version }), ...(manual === undefined ? {} : { manualDistribution: true }),
    ...(value.installationBoundary === undefined ? {} : { installationBoundary: true }) }
  const author = text(value.author, 160), category = text(value.category, 100), tags = strings(value.tags, 32, 100)
  const readme = text(value.readme, 100_000, true), compatibility = text(value.compatibilityNote, 8_192, true)
  const harnessVersion = text(value.harnessVersion, 100)
  const npmPackage = text(value.npmPackage, 214), permissions = strings(value.permissions, 32, 160)
  const iconUrl = image(value.icon), plainIcon = text(value.icon, 32)
  const icon = iconUrl ?? (plainIcon !== undefined && !/[<>/:]/u.test(plainIcon) ? plainIcon : undefined)
  const screenshots = Array.isArray(value.screenshots) && value.screenshots.length <= 12
    ? value.screenshots.map((item: unknown) => image(item)).filter((item): item is string => item !== undefined) : undefined
  const price = typeof value.price === 'number' && Number.isFinite(value.price) && value.price >= 0 && value.price <= 1_000_000 ? value.price : undefined
  return { ...result,
    ...(author === undefined ? {} : { author }), ...(category === undefined ? {} : { category }), ...(tags === undefined ? {} : { tags }),
    ...(member(value.platform, PLATFORMS) ? { platform: value.platform } : {}), ...(member(value.source, SOURCES) && value.source !== 'all' ? { source: value.source } : {}),
    ...(icon === undefined ? {} : { icon }), ...(readme === undefined ? {} : { readme }), ...(price === undefined ? {} : { price }),
    ...(compatibility === undefined ? {} : { compatibility }), ...(harnessVersion === undefined ? {} : { harnessVersion }),
    ...(npmPackage !== undefined && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(npmPackage) ? { npmPackage } : {}),
    ...(permissions === undefined ? {} : { permissions }), ...(screenshots === undefined ? {} : { screenshots }) }
}

async function readJson(url: URL, options: CommunityCatalogOptions): Promise<unknown> {
  const signal = options.signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
  signal.throwIfAborted()
  const response = await (options.fetch ?? globalThis.fetch)(url, { signal, redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } })
  if (!response.ok) throw new CommunityCatalogError(response.status === 404 ? 'plugin-not-found' : 'catalog-unavailable', `Community catalog returned HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel()
    throw new CommunityCatalogError('invalid-catalog', 'Community catalog response exceeds its size limit')
  }
  if (response.body === null) throw new CommunityCatalogError('invalid-catalog', 'Community catalog response is empty')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > MAX_RESPONSE_BYTES) throw new CommunityCatalogError('invalid-catalog', 'Community catalog response exceeds its size limit')
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch((cancelError: unknown) => {
      // Preserve the response failure when cancelling an already-failed stream also rejects.
      void cancelError
    })
    throw error
  } finally {
    reader.releaseLock()
  }
  try {
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return payload
  } catch (error) {
    if (error instanceof SyntaxError) throw new CommunityCatalogError('invalid-catalog', 'Community catalog response is not valid JSON')
    throw error
  }
}

async function json(url: URL, options: CommunityCatalogOptions): Promise<unknown> {
  try {
    return await readJson(url, options)
  } catch (error) {
    if (error instanceof CommunityCatalogError || options.signal?.aborted) throw error
    throw new CommunityCatalogError('catalog-unavailable', 'Community catalog request failed; check the connection and retry')
  }
}

/**
 * Request one website page with its search, category, scenario, platform, source, and ranking filters.
 * @param query - Bounded query options; defaults are resolved before fetching.
 * @param options - Optional instance-owned fetch and cancellation adapters.
 * @returns Validated display records and authoritative server pagination; malformed records are counted and omitted.
 */
export async function loadCommunityCatalog(query: CommunityCatalogQuery, options: CommunityCatalogOptions = {}): Promise<CommunityCatalog> {
  const resolved = communityCatalogQuery(query), url = new URL('/api/plugins', ORIGIN)
  for (const [key, value] of Object.entries(resolved)) url.searchParams.set(key, String(value))
  const payload = await json(url, options)
  if (!record(payload) || !Array.isArray(payload.plugins) || typeof payload.total !== 'number' || !Number.isSafeInteger(payload.total)
    || payload.total < 0 || payload.total > 1_000_000 || payload.page !== resolved.page || payload.pageSize !== resolved.pageSize
    || payload.totalPages !== Math.max(1, Math.ceil(payload.total / resolved.pageSize)) || payload.plugins.length > resolved.pageSize
    || payload.plugins.length !== Math.max(0, Math.min(resolved.pageSize, payload.total - (resolved.page - 1) * resolved.pageSize))) {
    throw new CommunityCatalogError('invalid-catalog', 'Invalid community catalog pagination')
  }
  const plugins: CommunityPlugin[] = [], ids = new Set<string>()
  let skippedCount = 0
  for (const item of payload.plugins) {
    try {
      const parsed = communityCatalogPlugin(item)
      if (ids.has(parsed.id)) throw new CommunityCatalogError('invalid-catalog', 'Repeated community plugin identity')
      ids.add(parsed.id)
      plugins.push(parsed)
    } catch (error) {
      if (!(error instanceof CommunityCatalogError)) throw error
      skippedCount += 1
    }
  }
  if (payload.plugins.length > 0 && plugins.length === 0) throw new CommunityCatalogError('invalid-catalog', 'Community catalog contains no compatible package records')
  return { plugins, updatedAt: Date.now(), cached: false, total: payload.total, page: resolved.page, pageSize: resolved.pageSize,
    totalPages: Math.max(1, Math.ceil(payload.total / resolved.pageSize)), ...(skippedCount === 0 ? {} : { skippedCount }) }
}

/**
 * Load one public website plugin detail, including README, compatibility notes, and permission labels.
 * @param id - Catalog identity selected in the desktop panel.
 * @param options - Optional instance-owned fetch and cancellation adapters.
 * @returns Validated display metadata; a different response identity or hidden/missing plugin is refused.
 */
export async function loadCommunityPlugin(id: string, options: CommunityCatalogOptions = {}): Promise<CommunityPluginDetail> {
  if (!identifier(id)) throw new CommunityCatalogError('invalid-query', 'Invalid community plugin identity')
  const payload = await json(new URL(`/api/plugins/${encodeURIComponent(id)}`, ORIGIN), options)
  if (!record(payload)) throw new CommunityCatalogError('invalid-catalog', 'Invalid community plugin detail')
  const plugin = communityCatalogPlugin(payload.plugin)
  if (plugin.id !== id) throw new CommunityCatalogError('invalid-catalog', 'Community plugin detail identity changed')
  return plugin
}
