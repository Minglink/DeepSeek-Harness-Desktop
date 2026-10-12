/** Download and validate community archives before handing a persistent npm tarball to the native plugin manager. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { chmod, copyFile, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path'
import type { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import extractZip from 'extract-zip'
import { open as openZip, type Entry as ZipEntry, type ZipFile } from 'yauzl'
import { load as loadYaml, JSON_SCHEMA, Type } from 'js-yaml'
import { valid } from 'semver'
import { create as createTar, extract as extractTar, Parser } from 'tar'
import { parseCommunitySourceUrl, parseDshUrl, type DshProtocolParams } from './installer.ts'
import { adaptCommunityCandidate, CommunityAdaptationError, type CommunityAdaptationOptions } from './community-adaptation.ts'
import { BundledDependencyError, validateBundledDependencies } from './community-bundled.ts'

/** Download, extraction, and redirect limits for one community package. */
export interface CommunityInstallLimits {
  /** Overall archive download budget, including attempts and retry waits. */
  timeoutMs: number
  connectTimeoutMs: number
  idleTimeoutMs: number
  maxDownloadAttempts: number
  retryDelayMs: number
  maxDownloadBytes: number
  maxExtractedBytes: number
  maxEntries: number
  maxRedirects: number
}

/** Preparation states; installation and activation are owned by pluginManager. */
export type CommunityInstallProgress = {
  phase: 'downloading' | 'adapting' | 'validating' | 'packaging' | 'prepared'
  receivedBytes?: number
  totalBytes?: number
}

/** Main-process diagnostics; retry.attempt identifies the attempt that just failed. */
export interface CommunityDownloadAttempt {
  phase: 'start' | 'retry' | 'failed'
  attempt: number
  maxAttempts: number
  timeoutMs: number
  connectTimeoutMs: number
  idleTimeoutMs: number
  retryDelayMs?: number
  error?: unknown
}

/** Stable error categories for native localized installation feedback. */
export type CommunityInstallProblem = 'invalid-intent' | 'authentication-required' | 'plugin-unlock-required' | 'manual-install-required' | 'external-installation-required' | 'download-forbidden' | 'download-failed' | 'too-large' | 'timeout' | 'cancelled' | 'invalid-archive' | 'incompatible-package' | 'adaptation-key-required' | 'adaptation-failed'

/** A preparation failure with an optional HTTP status and no credentials. */
export class CommunityInstallError extends Error {
  /**
   * @param problem - the category used by the native client.
   * @param message - a diagnostic naming the rejected input.
   * @param statusCode - the remote HTTP status, when present.
   */
  constructor(readonly problem: CommunityInstallProblem, message: string, readonly statusCode?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CommunityInstallError'
  }
}

/** Main-process options; callers supply credentials from local account storage. */
export interface CommunityInstallOptions {
  artifactDirectory: string
  token?: string
  signal?: AbortSignal
  limits?: Partial<CommunityInstallLimits>
  onProgress?: (event: CommunityInstallProgress) => void
  onDownloadAttempt?: (event: CommunityDownloadAttempt) => void
  /** Instance-local HTTP adapter for deterministic tests; follows the Fetch API. */
  fetch?: typeof globalThis.fetch
  /** Optional official-model adaptation; native packages never require model credentials. */
  adaptation?: CommunityAdaptationOptions
  /** Main-owned immutable original archive reused after a failed isolated trial. */
  originalArchive?: { spec: string; sha256: string; repositoryArchive?: boolean }
}

/** Manifest-derived identity and a persistent local spec accepted by pluginManager.installBundle. */
export interface PreparedCommunityBundle {
  spec: string
  packageName: string
  version: string
  bundle: string
  originalSha256?: string
  originalSpec?: string
  adapted?: boolean
  adaptationTranscript?: string
  sourceAdaptedFor016?: boolean
  /** Trusted final GitHub archive classification retained only by main for immutable-original retries. */
  repositoryArchive?: boolean
}

const DEFAULT_LIMITS: CommunityInstallLimits = {
  timeoutMs: 600_000,
  connectTimeoutMs: 45_000,
  idleTimeoutMs: 45_000,
  maxDownloadAttempts: 3,
  retryDelayMs: 1_000,
  maxDownloadBytes: 64 * 1024 * 1024,
  maxExtractedBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxRedirects: 5,
}
const COMMUNITY_ORIGIN = 'https://deepseek.stream'
const MAX_METADATA_BYTES = 2 * 1024 * 1024
interface MarketArtifact {
  sha256: string
  bytes: number
  format: 'zip' | 'tgz'
  packageName?: string
}
// The native Loader evaluates !!js later; archive validation parses it as inert text.
const PATCH_SCHEMA = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value: unknown) => value }))

function limitsOf(overrides: Partial<CommunityInstallLimits> | undefined): CommunityInstallLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (field === 'maxRedirects' || field === 'retryDelayMs' ? 0 : 1)) {
      throw new CommunityInstallError('invalid-intent', `Community install limit ${field} must be a positive integer`)
    }
  }
  if (limits.maxDownloadAttempts > 5 || limits.retryDelayMs > 60_000
    || [limits.timeoutMs, limits.connectTimeoutMs, limits.idleTimeoutMs].some(value => value > 2_147_483_647)) {
    throw new CommunityInstallError('invalid-intent', 'Community download retry and timer limits exceed their bounded range')
  }
  return limits
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CommunityInstallError('cancelled', 'Community installation was cancelled')
}

function sourceOf(intent: DshProtocolParams): URL {
  const fields = new URLSearchParams({ id: intent.id, version: intent.version })
  fields.set('name', intent.name)
  if (intent.repo) fields.set('repo', intent.repo)
  if (intent.downloadUrl !== undefined) fields.set('downloadUrl', intent.downloadUrl)
  if (!parseDshUrl(`dsh://plugin/install?${fields}`)) throw new CommunityInstallError('invalid-intent', 'Invalid community installation request')
  const source = parseCommunitySourceUrl(intent.downloadUrl ?? `${COMMUNITY_ORIGIN}/api/plugins/download?id=${encodeURIComponent(intent.id)}&version=${encodeURIComponent(intent.version)}`)
  if (source === null) throw new CommunityInstallError('invalid-intent', 'Community downloads require an HTTPS URL without credentials')
  if (source.origin === COMMUNITY_ORIGIN && source.pathname === '/api/plugins/download') source.searchParams.set('raw', '1')
  return source
}

/** First-party selection uses the catalogue label; archive identity uses its recorded source release. */
async function resolveMetadata(
  intent: DshProtocolParams, source: URL, options: CommunityInstallOptions, limits: CommunityInstallLimits,
): Promise<{ intent: DshProtocolParams; artifact?: MarketArtifact }> {
  const firstParty = [COMMUNITY_ORIGIN, 'https://www.deepseek.stream'].includes(source.origin)
  const ticket = /^\/api\/plugins\/install-artifact\/[a-f0-9]{64}$/u.test(source.pathname)
  const frozen = /^\/api\/plugins\/artifacts\/([^/]+)\/([^/]+)\/([a-f0-9]{64})\.tgz$/u.exec(source.pathname)
  if (!firstParty || (source.pathname !== '/api/plugins/download' && !ticket && frozen === null)) return { intent }
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort() }, Math.min(limits.timeoutMs, limits.connectTimeoutMs))
  const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal])
  try {
    cancelled(options.signal)
    const response = await (options.fetch ?? globalThis.fetch)(new URL(`/api/plugins/${encodeURIComponent(intent.id)}`, source.origin), {
      headers: { Accept: 'application/json', 'User-Agent': 'DeepSeek-Harness-Community' },
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
    })
    if (!response.ok || response.body === null) {
      await assertDownloadResponse(response, signal)
      throw new CommunityInstallError('download-failed', 'Community release metadata is unavailable')
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    const length = response.headers.get('content-length')
    if (contentType !== 'application/json' || (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_METADATA_BYTES))) {
      await response.body.cancel()
      throw new CommunityInstallError('download-failed', 'Community release metadata is missing or invalid')
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let received = 0
    try {
      for (;;) {
        cancelled(options.signal)
        const item = await reader.read()
        if (item.done) break
        received += item.value.byteLength
        if (received > MAX_METADATA_BYTES) throw new CommunityInstallError('download-failed', 'Community release metadata exceeds its size limit')
        chunks.push(item.value)
      }
    } finally {
      await reader.cancel().catch((_error: unknown) => { /* A settled metadata stream is already closed. */ })
      reader.releaseLock()
    }
    let payload: unknown
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_error) {
      throw new CommunityInstallError('download-failed', 'Community release metadata is not valid JSON')
    }
    const plugin = record(payload) && record(payload.plugin) ? payload.plugin : undefined
    if (plugin !== undefined && plugin.id === intent.id && plugin.status === 'published' && plugin.installationBoundary !== undefined) {
      throw new CommunityInstallError('external-installation-required', 'This release cannot be installed as a native community plugin; open its community detail page for release instructions')
    }
    if (plugin !== undefined && plugin.id === intent.id && plugin.status === 'published' && plugin.manualDistribution !== undefined) {
      throw new CommunityInstallError('manual-install-required', 'This plugin requires its complete package and author installation instructions; open its community detail page')
    }
    const verification = plugin !== undefined && record(plugin.installVerification) ? plugin.installVerification : undefined
    const artifact = verification !== undefined && record(verification.artifact) ? verification.artifact : undefined
    if (plugin === undefined || plugin.id !== intent.id || plugin.status !== 'published' || typeof plugin.version !== 'string'
      || (plugin.version !== 'latest' && valid(plugin.version) !== plugin.version) || artifact === undefined
      || artifact.packageVersion !== plugin.version || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || typeof artifact.bytes !== 'number' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
      || (artifact.format !== 'zip' && artifact.format !== 'tgz')) {
      throw new CommunityInstallError('download-failed', 'Community release requires a complete immutable archive record')
    }
    if (artifact.bytes > limits.maxDownloadBytes) throw new CommunityInstallError('too-large', 'Community archive exceeds the download limit')
    const version = artifact.sourceVersion ?? artifact.packageVersion
    if (typeof version !== 'string' || valid(version) !== version) {
      throw new CommunityInstallError('download-failed', 'Community release requires a recorded exact package version')
    }
    const packageName = artifact.packageName
    if (packageName !== undefined && packageName !== null && (typeof packageName !== 'string' || packageName.length > 214
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName))) {
      throw new CommunityInstallError('download-failed', 'Community release has an invalid recorded package name')
    }
    if (intent.downloadUrl === undefined) {
      if (intent.version !== plugin.version) throw new CommunityInstallError('download-failed', 'The selected catalogue release has changed; refresh the market', 409)
    } else if (ticket) {
      if (source.search || source.hash || intent.version !== version) {
        throw new CommunityInstallError('invalid-intent', 'The installation ticket selection does not match the recorded package version')
      }
    } else {
      const selectedId = frozen === null ? source.searchParams.get('id') : decodeURIComponent(frozen[1]!)
      const selectedVersion = frozen === null ? source.searchParams.get('version') : decodeURIComponent(frozen[2]!)
      const selectedHash = frozen === null ? source.searchParams.get('sha256') : frozen[3]
      if (selectedId !== plugin.id || selectedVersion !== plugin.version || (selectedHash !== null && selectedHash !== artifact.sha256)
        || (frozen !== null && (source.search || source.hash || artifact.format !== 'tgz'))
        || (intent.version !== version && intent.version !== plugin.version)) {
        throw new CommunityInstallError('invalid-intent', 'The download selection does not match the current immutable release')
      }
    }
    if (source.pathname === '/api/plugins/download') source.searchParams.set('sha256', artifact.sha256)
    return { intent: { ...intent, version }, artifact: { sha256: artifact.sha256, bytes: artifact.bytes, format: artifact.format,
      ...(typeof packageName === 'string' ? { packageName } : {}) } }
  } catch (error) {
    if (options.signal?.aborted) throw new CommunityInstallError('cancelled', 'Community installation was cancelled')
    if (timeout.signal.aborted) throw new CommunityInstallError('timeout', 'Community release metadata timed out; retry the installation')
    if (error instanceof CommunityInstallError) throw error
    throw new CommunityInstallError('download-failed', 'Community release metadata could not be verified; refresh the market', undefined, { cause: error })
  } finally { clearTimeout(timer) }
}

async function assertDownloadResponse(response: Response, signal: AbortSignal): Promise<void> {
  if (response.ok && response.body !== null) return
  let problem: CommunityInstallProblem = response.status === 401 ? 'authentication-required' : response.status === 403 ? 'download-forbidden' : 'download-failed'
  if (response.status === 403 && response.body !== null) {
    const reader = response.body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const item = await abortable(() => reader.read(), signal)
        if (item.done) break
        bytes += item.value.byteLength
        if (bytes > 8_192) break
        chunks.push(item.value)
      }
      if (bytes <= 8_192) {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (record(body) && body.needUnlock === true) problem = 'plugin-unlock-required'
        } catch (_error) { /* A non-JSON denial retains the HTTP permission category. */ }
      }
    } finally {
      await reader.cancel().catch((_error: unknown) => { /* A completed or aborted denial body is already closed. */ })
      reader.releaseLock()
    }
  } else await response.body?.cancel()
  throw new CommunityInstallError(problem, `Community download returned HTTP ${response.status}`, response.status)
}

class TransientDownloadError extends CommunityInstallError {}

function transientNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>()
  const codes = new Set(['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])
  for (let item: unknown = error; item !== null && typeof item === 'object' && !seen.has(item);) {
    seen.add(item)
    if ('code' in item && typeof item.code === 'string' && codes.has(item.code)) return true
    if (item instanceof Error && (item.name === 'TimeoutError'
      || (item instanceof TypeError && /^(?:fetch failed|terminated)$/u.test(item.message)))) return true
    item = 'cause' in item ? item.cause : undefined
  }
  return false
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let aborted: (() => void) | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return work() }), new Promise<never>((_resolve, reject) => {
        aborted = () => { reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')) }
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      }),
    ])
    signal.throwIfAborted()
    return result
  } finally {
    if (aborted !== undefined) signal.removeEventListener('abort', aborted)
  }
}

function downloadEvent(options: CommunityInstallOptions, event: CommunityDownloadAttempt): void {
  try { options.onDownloadAttempt?.(event) } catch (_error) { /* Diagnostic observers cannot change installation. */ }
}

async function downloadAttempt(
  source: URL, destination: string, options: CommunityInstallOptions, limits: CommunityInstallLimits, overall: AbortSignal,
): Promise<{ legacyAdapted: boolean; repositoryArchive: boolean }> {
  const inactivity = new AbortController()
  const signal = AbortSignal.any([overall, inactivity.signal])
  let inactivityKind: 'connection' | 'idle' = 'connection'
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (kind: 'connection' | 'idle', duration: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    inactivityKind = kind
    if (duration <= 0) inactivity.abort()
    else timer = setTimeout(() => { inactivity.abort() }, duration)
  }
  const network = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await abortable(work, signal) } catch (error) {
      if (overall.aborted) throw error
      if (inactivity.signal.aborted) {
        throw new TransientDownloadError('timeout', `Community package download ${inactivityKind} timed out`, undefined, { cause: error })
      }
      if (transientNetworkError(error)) {
        throw new TransientDownloadError('download-failed', 'Community package download was interrupted by a transient network error', undefined, { cause: error })
      }
      throw error
    }
  }
  const request = options.fetch ?? globalThis.fetch
  let url = source
  let authenticate = source.origin === COMMUNITY_ORIGIN
  try {
    for (let redirects = 0; ; redirects++) {
      cancelled(options.signal)
      const headers: Record<string, string> = { Accept: 'application/octet-stream', 'User-Agent': 'DeepSeek-Harness-Community' }
      if (authenticate && options.token) {
        if (/[\u0000-\u0020\u007f;]/u.test(options.token)) throw new CommunityInstallError('authentication-required', 'The saved community session is invalid; sign in again')
        headers.Authorization = `Bearer ${options.token}`
        headers.Cookie = `deepseek_hub_auth_token=${options.token}`
      }
      arm('connection', limits.connectTimeoutMs)
      const response = await network(() => request(url, { headers, redirect: 'manual', signal, credentials: 'omit', referrerPolicy: 'no-referrer' }))
      if (timer !== undefined) clearTimeout(timer)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (redirects >= limits.maxRedirects || location === null) throw new CommunityInstallError('download-failed', 'Community download exceeded its redirect limit')
        const next = parseCommunitySourceUrl(new URL(location, url).href)
        if (next === null) throw new CommunityInstallError('download-failed', 'Community download redirected to an unsupported source')
        authenticate = authenticate && next.origin === url.origin
        url = next
        continue
      }
      arm('idle', limits.idleTimeoutMs)
      if (response.status === 401 || response.status === 403) {
        try { await assertDownloadResponse(response, signal) } catch (error) {
          if (error instanceof CommunityInstallError) throw error
          throw new CommunityInstallError(response.status === 401 ? 'authentication-required' : 'download-forbidden',
            `Community download returned HTTP ${response.status}`, response.status, { cause: error })
        }
      } else await network(() => assertDownloadResponse(response, signal))
      if (timer !== undefined) clearTimeout(timer)
      if (response.body === null) throw new CommunityInstallError('download-failed', 'Community archive response is empty')
      const declared = response.headers.get('content-length')
      const totalBytes = declared === null ? undefined : Number(declared)
      if (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > limits.maxDownloadBytes)) {
        await response.body.cancel()
        throw new CommunityInstallError('too-large', 'Community archive exceeds the download limit')
      }
      const reader = response.body.getReader()
      let file: Awaited<ReturnType<typeof open>> | undefined
      let receivedBytes = 0
      let idleDeadline = Date.now() + limits.idleTimeoutMs
      try {
        file = await open(destination, 'wx', 0o600)
        for (;;) {
          cancelled(options.signal)
          arm('idle', idleDeadline - Date.now())
          const item = await network(() => reader.read())
          if (timer !== undefined) clearTimeout(timer)
          if (item.done) break
          receivedBytes += item.value.byteLength
          if (receivedBytes > limits.maxDownloadBytes) throw new CommunityInstallError('too-large', 'Community archive exceeds the download limit')
          await file.writeFile(item.value)
          if (item.value.byteLength > 0) idleDeadline = Date.now() + limits.idleTimeoutMs
          options.onProgress?.({ phase: 'downloading', receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) })
        }
        if (totalBytes !== undefined && totalBytes !== receivedBytes) throw new TransientDownloadError('download-failed', 'Community archive download ended before its declared length')
      } finally {
        await reader.cancel().catch(() => { /* An aborted Fetch stream is already closed. */ })
        reader.releaseLock()
        await file?.close()
      }
      signal.throwIfAborted()
      return { legacyAdapted: url.origin === COMMUNITY_ORIGIN && response.headers.get('x-plugin-016-adapted') === 'true',
        repositoryArchive: repositoryArchiveUrl(url) }
    }
  } catch (error) {
    if (options.signal?.aborted) throw new CommunityInstallError('cancelled', 'Community installation was cancelled')
    if (overall.aborted) throw new CommunityInstallError('timeout', 'Community package download exceeded its overall time limit', undefined, { cause: error })
    if (error instanceof CommunityInstallError) throw error
    throw new CommunityInstallError('download-failed', 'Community package download failed; check the connection and retry', undefined, { cause: error })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function download(
  source: URL, destination: string, options: CommunityInstallOptions, limits: CommunityInstallLimits,
): Promise<{ legacyAdapted: boolean; repositoryArchive: boolean }> {
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort() }, limits.timeoutMs)
  const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal])
  const settings = { maxAttempts: limits.maxDownloadAttempts, timeoutMs: limits.timeoutMs,
    connectTimeoutMs: limits.connectTimeoutMs, idleTimeoutMs: limits.idleTimeoutMs }
  try {
    for (let attempt = 1; attempt <= limits.maxDownloadAttempts; attempt++) {
      cancelled(options.signal)
      downloadEvent(options, { ...settings, phase: 'start', attempt })
      try {
        return await downloadAttempt(source, destination, options, limits, signal)
      } catch (error) {
        const retryable = error instanceof TransientDownloadError || (error instanceof CommunityInstallError
          && error.statusCode !== undefined && (error.statusCode === 408 || error.statusCode === 429
            || (error.statusCode >= 500 && error.statusCode <= 599)))
        if (!retryable || signal.aborted || attempt === limits.maxDownloadAttempts) {
          downloadEvent(options, { ...settings, phase: 'failed', attempt, error })
          throw error
        }
        // destination belongs to the private mkdtemp directory and contains only this attempt's bytes.
        await rm(destination, { force: true })
        const retryDelayMs = limits.retryDelayMs * attempt
        downloadEvent(options, { ...settings, phase: 'retry', attempt, retryDelayMs, error })
        let retryTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await abortable(() => new Promise<void>((resolve) => { retryTimer = setTimeout(resolve, retryDelayMs) }), signal)
        } catch (waitError) {
          if (options.signal?.aborted) throw new CommunityInstallError('cancelled', 'Community installation was cancelled', undefined, { cause: waitError })
          throw new CommunityInstallError('timeout', 'Community package download exceeded its overall time limit', undefined, { cause: waitError })
        } finally {
          if (retryTimer !== undefined) clearTimeout(retryTimer)
        }
      }
    }
    throw new CommunityInstallError('download-failed', 'Community package download exhausted its attempts')
  } finally {
    clearTimeout(timer)
  }
}

function repositoryArchiveUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  const parts = url.pathname.split('/').slice(1)
  if (parts.length < 4 || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/u.test(parts[0] ?? '')
    || !/^[a-zA-Z0-9_.-]+$/u.test(parts[1] ?? '') || parts[1] === '.' || parts[1] === '..') return false
  if (url.origin === 'https://codeload.github.com') return parts[2] === 'zip' || parts[2] === 'tar.gz'
  return url.origin === 'https://github.com' && parts[2] === 'archive' && /\.(?:zip|tar\.gz)$/u.test(url.pathname)
}

function repositoryMetadata(path: string): boolean {
  const ignored = new Set(['node_modules', '.git', '.github', '.gitignore', '.gitattributes', '.gitmodules'])
  return path.split('/').some(part => ignored.has(part.toLowerCase()))
}

function archiveGuard(
  limits: CommunityInstallLimits, repositoryArchive: boolean,
): (path: string, bytes: number, kind: 'file' | 'directory') => boolean {
  const paths = new Set<string>()
  let expanded = 0, entries = 0
  return (file, bytes, kind) => {
    const normalized = file.replace(/^\.\//u, '').replace(/\/$/u, '')
    expanded += bytes
    entries++
    if (!Number.isSafeInteger(bytes) || bytes < 0 || expanded > limits.maxExtractedBytes || entries > limits.maxEntries) {
      throw new CommunityInstallError('too-large', 'Community archive exceeds the extraction limit')
    }
    if (normalized === '' && kind === 'directory') return true
    const parts = normalized.split('/')
    if (normalized.length > 1_024 || parts.some(part => !part || part === '..' || part === '.' || part.length > 255 || /[\\:\u0000-\u001f<>"|?*]/u.test(part) || /[ .]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
      throw new CommunityInstallError('invalid-archive', 'Community archive contains an unsafe file path')
    }
    if (!repositoryArchive && parts.some(part => part.toLowerCase() === '.git')) {
      throw new CommunityInstallError('incompatible-package', 'Publish a package without repository metadata')
    }
    const key = normalized.toLowerCase()
    if (paths.has(key)) throw new CommunityInstallError('invalid-archive', 'Community archive contains duplicate file paths')
    paths.add(key)
    return !repositoryArchive || !repositoryMetadata(normalized)
  }
}

async function nextZipEntry(zip: ZipFile): Promise<ZipEntry | undefined> {
  return new Promise((resolveEntry, reject) => {
    const cleanup = (): void => {
      zip.removeListener('entry', entry)
      zip.removeListener('end', end)
      zip.removeListener('error', error)
    }
    const entry = (value: ZipEntry): void => { cleanup(); resolveEntry(value) }
    const end = (): void => { cleanup(); resolveEntry(undefined) }
    const error = (value: Error): void => { cleanup(); reject(value) }
    zip.once('entry', entry)
    zip.once('end', end)
    zip.once('error', error)
    zip.readEntry()
  })
}

async function unpackRepositoryZip(
  archive: string, destination: string, guard: ReturnType<typeof archiveGuard>, signal: AbortSignal | undefined,
): Promise<void> {
  const zip = await new Promise<ZipFile>((resolveZip, reject) => {
    openZip(archive, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, value) => { if (error !== null) reject(error); else resolveZip(value) })
  })
  try {
    for (;;) {
      cancelled(signal)
      const entry = await nextZipEntry(zip)
      if (entry === undefined) break
      cancelled(signal)
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000
      if (entry.isEncrypted() || (kind !== 0 && kind !== 0o100000 && kind !== 0o040000)) {
        throw new CommunityInstallError('invalid-archive', 'Community ZIP packages require unencrypted regular files and directories')
      }
      const directory = kind === 0o040000 || entry.fileName.endsWith('/')
        || (entry.versionMadeBy >>> 8 === 0 && entry.externalFileAttributes === 16)
      if (!guard(entry.fileName, entry.uncompressedSize, directory ? 'directory' : 'file')) continue
      const file = join(destination, entry.fileName)
      await mkdir(directory ? file : dirname(file), { recursive: true, mode: 0o700 })
      if (directory) continue
      const source = await new Promise<Readable>((resolveStream, reject) => {
        zip.openReadStream(entry, (error, stream) => { if (error !== null) reject(error); else resolveStream(stream) })
      })
      const mode = (entry.externalFileAttributes >>> 16) & 0o777
      await pipeline(source, createWriteStream(file, { flags: 'wx', mode: mode || 0o600 }),
        signal === undefined ? {} : { signal })
    }
  } finally {
    const closed = once(zip, 'close')
    zip.close()
    await closed
  }
}

async function validateTar(archive: string, guard: ReturnType<typeof archiveGuard>, signal: AbortSignal | undefined): Promise<void> {
  const input = createReadStream(archive)
  const closed = finished(input).catch(() => { /* The parser's rejection retains the stream failure. */ })
  const parser = new Parser({ strict: true, onReadEntry(entry) {
    try {
      cancelled(signal)
      if (entry.type !== 'File' && entry.type !== 'Directory' && entry.type !== 'OldFile') throw new CommunityInstallError('invalid-archive', 'Community tarballs may contain only regular files and directories')
      guard(entry.path, entry.size, entry.type === 'Directory' ? 'directory' : 'file')
    } catch (error) {
      // Parser callbacks run on the file stream; abort forwards failures to the awaited error event.
      parser.abort(error instanceof Error ? error : new Error(String(error)))
    }
    entry.resume()
  } })
  const abort = (): void =>{  parser.abort(new CommunityInstallError('cancelled', 'Community installation was cancelled')) }
  try {
    await new Promise<void>((resolveRead, reject) => {
      parser.once('end', resolveRead)
      parser.on('error', (error: Error) => { input.destroy(); reject(error) })
      input.once('error', reject)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else input.pipe(parser)
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    input.destroy()
    await closed
  }
}

async function unpack(
  archive: string, destination: string, limits: CommunityInstallLimits, signal: AbortSignal | undefined, repositoryArchive: boolean,
): Promise<void> {
  const handle = await open(archive, 'r')
  const signature = Buffer.alloc(4)
  try { await handle.read(signature, 0, 4, 0) } finally { await handle.close() }
  const guard = archiveGuard(limits, repositoryArchive)
  try {
    if (signature[0] === 0x50 && signature[1] === 0x4b) {
      if (repositoryArchive) {
        await unpackRepositoryZip(archive, destination, guard, signal)
      } else {
        await extractZip(archive, {
          dir: destination,
          onEntry(entry) {
            cancelled(signal)
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000
            if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) throw new CommunityInstallError('invalid-archive', 'Community ZIP packages may contain only regular files and directories')
            guard(entry.fileName, entry.uncompressedSize, entry.fileName.endsWith('/') ? 'directory' : 'file')
          },
        })
      }
    } else if (signature[0] === 0x1f && signature[1] === 0x8b) {
      await validateTar(archive, guard, signal)
      cancelled(signal)
      // Extraction has no third-party callbacks; cancellation waits for all file handles to close.
      await extractTar({ file: archive, cwd: destination, strict: true, noMtime: true,
        filter: path => !repositoryArchive || !repositoryMetadata(path) })
    } else {
      throw new CommunityInstallError('invalid-archive', 'Community downloads must be ZIP or npm tgz packages')
    }
    cancelled(signal)
  } catch (error) {
    if (error instanceof CommunityInstallError) throw error
    throw new CommunityInstallError('invalid-archive', 'The community archive cannot be extracted; ask its author to republish it')
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageFile(root: string, value: string): string {
  if (isAbsolute(value) || value.includes('\\') || value.includes(':')) throw new CommunityInstallError('incompatible-package', 'Package entry points and patches must use relative paths')
  const file = resolve(root, value)
  const local = relative(root, file)
  if (local === '..' || local.startsWith(`..${sep}`) || local === '') throw new CommunityInstallError('incompatible-package', 'Package entry points and patches must stay inside the package')
  return file
}

async function packageIdentity(
  directory: string, intent: DshProtocolParams, expectedName?: string,
): Promise<{ root: string; name: string; version: string; manifest: Record<string, unknown> }> {
  const children = await readdir(directory, { withFileTypes: true })
  const root = children.some(child => child.name === 'package.json' && child.isFile()) ? directory
    : children.length === 1 && children[0]?.isDirectory() ? join(directory, children[0].name) : undefined
  if (root === undefined) throw new CommunityInstallError('incompatible-package', 'Community archive must contain one npm package root')
  let manifest: unknown
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) } catch (_error) {
    throw new CommunityInstallError('incompatible-package', 'Community package requires a valid package.json')
  }
  if (!record(manifest) || typeof manifest.name !== 'string' || manifest.name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(manifest.name) || typeof manifest.version !== 'string' || valid(manifest.version) !== manifest.version) throw new CommunityInstallError('incompatible-package', 'Community package requires a valid npm name and semantic version')
  if (intent.version !== 'latest' && manifest.version !== intent.version) throw new CommunityInstallError('incompatible-package', 'Downloaded package version does not match the selected version')
  if (expectedName !== undefined && manifest.name !== expectedName) throw new CommunityInstallError('incompatible-package', 'Downloaded package name does not match the recorded release')
  return { root, name: manifest.name, version: manifest.version, manifest }
}

async function bundledDigest(
  root: string, manifest: Record<string, unknown>, limits: CommunityInstallLimits, signal: AbortSignal | undefined,
): Promise<string> {
  try { return await validateBundledDependencies(root, manifest, limits, signal) }
  catch (error) {
    if (error instanceof BundledDependencyError) throw new CommunityInstallError(error.problem, error.message)
    throw error
  }
}

async function validatePackage(
  directory: string, intent: DshProtocolParams, expectedName: string | undefined,
  limits: CommunityInstallLimits, signal: AbortSignal | undefined,
): Promise<{ root: string; name: string; version: string; bundledDigest: string }> {
  const { root, manifest } = await packageIdentity(directory, intent, expectedName)
  const dependenciesDigest = await bundledDigest(root, manifest, limits, signal)
  if (!record(manifest.dsh) || !record(manifest.dsh.bundle)) throw new CommunityInstallError('incompatible-package', 'Community package requires a native dsh.bundle declaration or official-model adaptation')
  const declared = manifest.dsh.bundle.patch
  const patches = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(patches) || patches.length === 0 || !patches.every((patch): patch is string => typeof patch === 'string')) throw new CommunityInstallError('incompatible-package', 'dsh.bundle.patch must name one or more package-relative YAML files')
  for (const patch of patches) {
    try {
      const parsed: unknown = loadYaml(await readFile(packageFile(root, patch), 'utf8'), { schema: PATCH_SCHEMA })
      if (!Array.isArray(parsed)) throw new Error('Patch is not a list')
    } catch (error) {
      if (error instanceof CommunityInstallError) throw error
      throw new CommunityInstallError('incompatible-package', 'The declared dsh.bundle patch is missing or invalid YAML')
    }
  }
  const entries: string[] = []
  const exportsOf = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.startsWith('./')) throw new CommunityInstallError('incompatible-package', 'Package exports must use relative entry points')
      if (!value.includes('*')) entries.push(value)
      else packageFile(root, value)
    } else if (Array.isArray(value)) value.forEach(exportsOf)
    else if (record(value)) Object.values(value).forEach(exportsOf)
    else if (value !== null && value !== undefined) throw new CommunityInstallError('incompatible-package', 'Package exports contain an unsupported entry point')
  }
  if (manifest.exports !== undefined) exportsOf(manifest.exports)
  else if (typeof manifest.main === 'string') entries.push(manifest.main)
  for (const entry of entries) {
    const file = packageFile(root, entry)
    if (/\.(?:ts|tsx|jsx)$/u.test(entry) && !/\.d\.ts$/u.test(entry)) throw new CommunityInstallError('incompatible-package', 'Community packages must ship compiled JavaScript entry points')
    try {
      if (!(await stat(file)).isFile()) throw new Error('Entry is not a file')
    } catch (_error) {
      throw new CommunityInstallError('incompatible-package', `Package entry ${entry} is missing from the archive`)
    }
  }
  return { root, name: String(manifest.name), version: String(manifest.version), bundledDigest: dependenciesDigest }
}

async function validateAdaptedBundle(directory: string, intent: DshProtocolParams): Promise<void> {
  const { root, name, manifest } = await packageIdentity(directory, intent)
  const dsh = manifest.dsh
  const bundle = record(dsh) ? dsh.bundle : undefined
  const declared = record(bundle) ? bundle.patch : undefined
  const patches = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  const namespace = name.slice(name.lastIndexOf('/') + 1)
  let mounted = 0
  for (const patch of patches) {
    if (typeof patch !== 'string') throw new CommunityInstallError('adaptation-failed', 'Adapted bundle patch paths must be strings')
    let parsed: unknown
    try { parsed = loadYaml(await readFile(packageFile(root, patch), 'utf8'), { schema: JSON_SCHEMA }) }
    catch (_error) { throw new CommunityInstallError('adaptation-failed', 'Adapted bundle patches require literal YAML without executable expressions') }
    if (!Array.isArray(parsed)) throw new CommunityInstallError('adaptation-failed', 'Adapted bundle patch must be a YAML list')
    for (const operation of parsed) {
      if (!record(operation) || Object.keys(operation).some(key => key !== 'insert') || !Array.isArray(operation.insert)) {
        throw new CommunityInstallError('adaptation-failed', 'AI adaptation may insert its own plugin rows but cannot override Harness configuration')
      }
      for (const row of operation.insert) {
        if (!record(row) || typeof row.id !== 'string' || (row.id !== namespace && !row.id.startsWith(`${namespace}-`))
          || typeof row.name !== 'string' || (row.name !== name && !row.name.startsWith(`${name}/`))
          || Object.keys(row).some(key => !['id', 'name', 'config', 'disabled'].includes(key))
          || (row.disabled !== undefined && typeof row.disabled !== 'boolean')) {
          throw new CommunityInstallError('adaptation-failed', 'AI adaptation must mount only its own package exports with package-prefixed row ids')
        }
        mounted++
      }
    }
  }
  if (mounted === 0) throw new CommunityInstallError('adaptation-failed', 'Adapted bundles must declare actual plugin rows')
}

async function publishArtifact(
  source: string, directory: string, filename: string, digest: string, signal: AbortSignal | undefined,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(toNamespacedPath(join(directory, '.publish-')))
  const spec = join(directory, filename)
  try {
    const staged = join(staging, 'artifact')
    await copyFile(source, staged)
    await chmod(staged, 0o600)
    cancelled(signal)
    try { await link(staged, spec) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (createHash('sha256').update(await readFile(spec)).digest('hex') !== digest) throw new CommunityInstallError('invalid-archive', 'Stored community artifact has unexpected contents')
    }
    return spec
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Prepare a validated npm tarball, retaining declared runtime bundles unchanged across optional source adaptation.
 * @param intent - selection from the protocol or catalogue; first-party archive identity and bytes must match its current immutable release record.
 * @param options - local artifact storage, account credentials, cancellation, and resource limits.
 * @returns manifest identity and a content-addressed local tgz spec; callers retain it while their profile references it.
 * @throws {CommunityInstallError} for refused downloads, incompatible packages, timeouts, or cancellation.
 * Temporary files are removed before settlement.
 * Preparation executes no package code or hooks and changes no profiles.
 * Bundled dependency installation hooks are refused pending native approval coverage.
 */
export async function prepareCommunityBundle(
  intent: DshProtocolParams, options: CommunityInstallOptions,
): Promise<PreparedCommunityBundle> {
  const limits = limitsOf(options.limits)
  const source = sourceOf(intent)
  cancelled(options.signal)
  const selection = await resolveMetadata(intent, source, options, limits)
  const validationIntent = selection.intent
  const expectedName = selection.artifact?.packageName
  const temporary = await mkdtemp(toNamespacedPath(join(tmpdir(), 'dsh-community-')))
  try {
    await chmod(temporary, 0o700)
    const archive = join(temporary, 'download')
    let sourceAdaptedFor016 = false, repositoryArchive = false
    if (options.originalArchive === undefined) {
      options.onProgress?.({ phase: 'downloading', receivedBytes: 0 })
      const downloaded = await download(source, archive, options, limits)
      sourceAdaptedFor016 = downloaded.legacyAdapted
      repositoryArchive = downloaded.repositoryArchive
    } else {
      const original = await stat(options.originalArchive.spec)
      if (!original.isFile() || original.size > limits.maxDownloadBytes) throw new CommunityInstallError('invalid-archive', 'Saved original community artifact exceeds the archive limit')
      await copyFile(options.originalArchive.spec, archive)
      if (createHash('sha256').update(await readFile(archive)).digest('hex') !== options.originalArchive.sha256) throw new CommunityInstallError('invalid-archive', 'Saved original community artifact failed its checksum')
      repositoryArchive = options.originalArchive.repositoryArchive === true
    }
    const archiveBytes = await readFile(archive)
    const originalSha256 = createHash('sha256').update(archiveBytes).digest('hex')
    if (selection.artifact !== undefined) {
      const format = archiveBytes[0] === 0x50 && archiveBytes[1] === 0x4b ? 'zip'
        : archiveBytes[0] === 0x1f && archiveBytes[1] === 0x8b ? 'tgz' : undefined
      if (originalSha256 !== selection.artifact.sha256 || archiveBytes.length !== selection.artifact.bytes
        || format !== selection.artifact.format) {
        throw new CommunityInstallError('invalid-archive', `Downloaded archive does not match its recorded checksum, length or format\nSHA-256 expected=${selection.artifact.sha256} actual=${originalSha256}\nBytes expected=${selection.artifact.bytes} actual=${archiveBytes.length}\nFormat expected=${selection.artifact.format} actual=${format ?? 'unknown'}`)
      }
    }
    options.onProgress?.({ phase: 'validating' })
    const extracted = join(temporary, 'extracted')
    await mkdir(extracted, { mode: 0o700 })
    await unpack(archive, extracted, limits, options.signal, repositoryArchive)
    const identity = await packageIdentity(extracted, validationIntent, expectedName)
    // Dependency contents and root bindings stay fixed across any optional source adaptation.
    const originalBundledDigest = await bundledDigest(identity.root, identity.manifest, limits, options.signal)
    const validateCandidate = async (): Promise<Awaited<ReturnType<typeof validatePackage>>> => {
      const candidate = await validatePackage(extracted, validationIntent, expectedName, limits, options.signal)
      if (candidate.bundledDigest !== originalBundledDigest) throw new CommunityInstallError('invalid-archive', 'Bundled dependency contents or declarations changed after validation')
      return candidate
    }
    let originalSpec: string | undefined
    let adaptationTranscript: string | undefined
    let adapted = false
    let manifest: Awaited<ReturnType<typeof validatePackage>>
    try {
      manifest = await validateCandidate()
      if (options.adaptation?.force) throw new CommunityInstallError('incompatible-package', options.adaptation.diagnostic ?? 'The native plugin failed its isolated Harness trial')
      if (sourceAdaptedFor016) throw new CommunityInstallError('incompatible-package', 'The community server marked this archive as rewritten for Harness 0.1.6; adapt its actual source for the current Harness version and reject generated placeholder functionality')
    } catch (error) {
      if (!(error instanceof CommunityInstallError) || error.problem !== 'incompatible-package' || options.adaptation === undefined) throw error
      originalSpec = await publishArtifact(archive, resolve(options.artifactDirectory, 'originals'), `${originalSha256}.archive`, originalSha256, options.signal)
      options.onProgress?.({ phase: 'adapting' })
      try {
        const result = await adaptCommunityCandidate({
          root: identity.root, artifactDirectory: options.artifactDirectory, packageName: identity.name, version: identity.version,
          diagnostic: error.message, ...(options.signal === undefined ? {} : { signal: options.signal }),
          validate: async () => { await validateCandidate(); await validateAdaptedBundle(extracted, validationIntent) },
        }, { ...options.adaptation,
          redactValues: [...(options.adaptation.redactValues ?? []), ...(options.token === undefined ? [] : [options.token])] })
        adaptationTranscript = result.transcriptPath
        adapted = true
      } catch (adaptationError) {
        if (adaptationError instanceof CommunityAdaptationError) {
          throw new CommunityInstallError(adaptationError.problem, adaptationError.message)
        }
        throw adaptationError
      }
      options.onProgress?.({ phase: 'validating' })
      manifest = await validateCandidate()
    }
    cancelled(options.signal)
    options.onProgress?.({ phase: 'packaging' })
    const packaged = join(temporary, 'package.tgz')
    await validateCandidate()
    await createTar({ file: packaged, cwd: manifest.root, gzip: true, portable: true, prefix: 'package/', noMtime: true }, ['.'])
    cancelled(options.signal)
    const digest = createHash('sha256').update(await readFile(packaged)).digest('hex')
    originalSpec ??= await publishArtifact(archive, resolve(options.artifactDirectory, 'originals'), `${originalSha256}.archive`, originalSha256, options.signal)
    const spec = await publishArtifact(packaged, resolve(options.artifactDirectory, 'v1'), `${digest}.tgz`, digest, options.signal)
    options.onProgress?.({ phase: 'prepared' })
    return {
      spec, packageName: manifest.name, version: manifest.version, bundle: manifest.name,
      originalSha256, originalSpec, adapted, sourceAdaptedFor016, repositoryArchive,
      ...(adaptationTranscript === undefined ? {} : { adaptationTranscript }) }
  } finally {
    // mkdtemp exclusively owns this real directory; archive links are refused before extraction.
    await rm(temporary, { recursive: true, force: true })
  }
}
