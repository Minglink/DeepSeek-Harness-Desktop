/** Bounded per-installation diagnostics. Credentials are removed before disk, IPC, or export. */
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CommunityTask, CommunityTaskId, CommunityTaskLog, CommunityTaskLogEntry } from './community-types.ts'

const MAX_FILE_BYTES = 256 * 1024
const MAX_LINE_CHARS = 16_384
const MAX_ENTRIES = 1_000
const PHASES = new Set(['queued', 'downloading', 'adapting', 'validating', 'packaging', 'trial', 'installing', 'activating', 'rolling-back', 'cancelling', 'applied', 'restart-required', 'overridden', 'failed', 'cancelled'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

/** Validate the only filename selector accepted by the log store. */
export function communityLogTaskId(value: unknown): CommunityTaskId {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid installation task')
  return value as CommunityTaskId
}

/** Apply on whole lines, before truncating; callers buffer split subprocess chunks. */
export function sanitizeCommunityLog(value: string, secrets: readonly string[]): string {
  if (value.length > 256 * 1024) return '[oversized diagnostic omitted]'
  let text = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  for (const secret of [...new Set(secrets)].filter(secret => secret.length > 0).sort((a, b) => b.length - a.length)) {
    let encoded = secret
    try { encoded = encodeURIComponent(secret) }
    catch (_error) { /* The literal still redacts a malformed Unicode credential. */ }
    for (const spelling of new Set([secret, encoded])) text = text.split(spelling).join('[redacted]')
  }
  const urls: string[] = []
  text = text.replace(/https?:\/\/[^\s<>"']+/giu, (raw) => {
    try {
      const url = new URL(raw)
      if (url.username || url.password) { url.username = 'redacted'; url.password = '' }
      for (const key of [...url.searchParams.keys()]) {
        if (/auth|token|key|secret|credential|password|signature|ticket|session|jwt|^sig$|^x-amz-|^x-goog-/iu.test(key)) url.searchParams.set(key, '[redacted]')
      }
      if (/auth|token|key|secret|password|ticket|session|jwt/iu.test(url.hash)) url.hash = '[redacted]'
      urls.push(url.href)
      return `\u0000URL${urls.length - 1}\u0000`
    } catch (_error) { return '[invalid URL omitted]' }
  })
  text = text.replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu,
    match => `${match.split(/[:=]/u, 1)[0]}: [redacted]`)
    .replace(/\bBearer\s+[^\s,;"']+/giu, 'Bearer [redacted]')
    .replace(/(?<![\w.-])(["']?(?:[\w.-]*(?:token|password|passwd|secret|api[_-]?key|credential|_auth|ticket|session|jwt)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, '$1[redacted]')
  text = text.replace(/\u0000URL(\d+)\u0000/gu, (_match: string, index: string) => urls[Number(index)] ?? '[URL omitted]')
  return text.slice(0, MAX_LINE_CHARS)
}

interface StoredLog {
  version: 1
  id: CommunityTaskId
  entries: CommunityTaskLogEntry[]
  nextCursor: number
  truncated: boolean
  unavailable: boolean
}
interface BufferedLine { text: string; dropping: boolean; entry: Omit<CommunityTaskLogEntry, 'time' | 'sequence' | 'text'> }
export type CommunityLogInput = Omit<CommunityTaskLogEntry, 'time' | 'sequence'>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function entry(value: unknown): value is CommunityTaskLogEntry {
  return record(value) && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && typeof value.time === 'number' && Number.isFinite(value.time) && Math.abs(value.time) <= 8.64e15
    && PHASES.has(String(value.phase)) && ['info', 'warning', 'error'].includes(String(value.level))
    && ['system', 'pnpm', 'host'].includes(String(value.source)) && typeof value.text === 'string' && value.text.length <= MAX_LINE_CHARS
    && (value.code === undefined || typeof value.code === 'string' && value.code.length <= 100)
    && (value.exitCode === undefined || value.exitCode === null || Number.isSafeInteger(value.exitCode))
}

/** Logs are independently capped; the service retains 100 finished and at most 20 pending tasks. */
export class CommunityTaskLogStore {
  private readonly logs = new Map<CommunityTaskId, Promise<StoredLog>>()
  private readonly buffers = new Map<string, BufferedLine>()
  private mutations: Promise<void> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private readonly dirty = new Set<CommunityTaskId>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly directory: string, private readonly secrets: () => readonly string[],
    private readonly changed: () => void) {}

  private file(id: CommunityTaskId): string { return join(this.directory, 'task-logs-v1', `${communityLogTaskId(id)}.json`) }
  private load(id: CommunityTaskId): Promise<StoredLog> {
    let loading = this.logs.get(id)
    if (loading !== undefined) return loading
    loading = (async () => {
      const empty: StoredLog = { version: 1, id, entries: [], nextCursor: 0, truncated: false, unavailable: false }
      let content: string
      try {
        const path = this.file(id), info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Invalid log file')
        const handle = await open(path, 'r')
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error('Invalid log file')
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead > MAX_FILE_BYTES) throw new Error('Oversized installation log')
          content = buffer.subarray(0, bytesRead).toString('utf8')
        } finally { await handle.close() }
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') empty.unavailable = true; return empty }
      try {
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Oversized installation log')
        const value: unknown = JSON.parse(content)
        if (!record(value) || value.version !== 1 || value.id !== id || !Array.isArray(value.entries)
          || value.entries.length > MAX_ENTRIES || !value.entries.every(entry)
          || !Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < 0 || typeof value.truncated !== 'boolean') throw new Error('Invalid installation log')
        const entries: CommunityTaskLogEntry[] = value.entries
        if (entries.some((item, index) => item.sequence > Number(value.nextCursor)
          || index > 0 && item.sequence <= (entries[index - 1]?.sequence ?? 0))) throw new Error('Invalid log sequence')
        return { ...empty, entries: entries.map(item => ({ sequence: item.sequence, time: item.time, phase: item.phase,
          level: item.level, source: item.source, text: sanitizeCommunityLog(item.text, this.secrets()),
          ...(item.code === undefined ? {} : { code: sanitizeCommunityLog(item.code, this.secrets()) }),
          ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }) })),
        nextCursor: Number(value.nextCursor), truncated: value.truncated, unavailable: value.unavailable === true }
      } catch (_error) { empty.unavailable = true; return empty }
    })()
    this.logs.set(id, loading)
    return loading
  }

  /** @param immediate - Persist phase and error transitions without waiting for output batching. */
  append(id: CommunityTaskId, input: CommunityLogInput, immediate = false): void {
    communityLogTaskId(id)
    this.mutations = this.mutations.then(async () => {
      const log = await this.load(id)
      const clean = sanitizeCommunityLog(input.text, this.secrets())
      log.entries.push({ ...input, text: clean,
        ...(input.code === undefined ? {} : { code: sanitizeCommunityLog(input.code, this.secrets()).slice(0, 100) }),
        sequence: ++log.nextCursor, time: Date.now() })
      if (input.code === 'output-line-omitted' || input.text.length > MAX_LINE_CHARS) log.truncated = true
      while (log.entries.length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(log)) + 1 > MAX_FILE_BYTES) {
        log.entries.shift(); log.truncated = true
      }
      this.dirty.add(id)
      if (immediate) this.persist()
      else if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.persist() }, 200)
    }).catch(async (_error: unknown) => {
      // An unavailable diagnostic sink must never change a confirmed installation outcome.
      const log = await this.load(id)
      log.unavailable = true
      this.dirty.add(id)
      this.persist()
    })
  }

  /** Buffer complete lines so a credential split across native chunks cannot escape redaction. */
  stream(id: CommunityTaskId, key: string, input: CommunityLogInput, final = false): void {
    const bufferKey = `${id}:${key}`
    const buffer = this.buffers.get(bufferKey) ?? { text: '', dropping: false, entry: input }
    const pieces = input.text.split(/\r\n|\n|\r/u)
    for (const [index, piece] of pieces.entries()) {
      if (!buffer.dropping) {
        if (buffer.text.length + piece.length > MAX_LINE_CHARS) { buffer.text = ''; buffer.dropping = true }
        else buffer.text += piece
      }
      if (index < pieces.length - 1) {
        this.append(id, { ...buffer.entry, text: buffer.dropping ? '[oversized output line omitted]' : buffer.text,
          ...(buffer.dropping ? { level: 'warning', code: 'output-line-omitted' } : {}) })
        buffer.text = ''; buffer.dropping = false; buffer.entry = input
      }
    }
    if (final) {
      if (buffer.text || buffer.dropping) this.append(id, { ...buffer.entry,
        text: buffer.dropping ? '[oversized output line omitted]' : buffer.text, ...(buffer.dropping ? { level: 'warning', code: 'output-line-omitted' } : {}) })
      this.buffers.delete(bufferKey)
    } else this.buffers.set(bufferKey, buffer)
  }

  private persist(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    const ids = [...this.dirty]; this.dirty.clear()
    this.writes = this.writes.then(async () => {
      for (const id of ids) {
        const log = await this.load(id)
        try { await writeFileAtomic(this.file(id), JSON.stringify(log) + '\n', { mode: 0o600, dirMode: 0o700 }) }
        catch (_error) { log.unavailable = true }
      }
      if (ids.length > 0) {
        try { this.changed() }
        catch (_error) { for (const id of ids) (await this.load(id)).unavailable = true }
      }
    })
  }

  /** Flush partial native lines and all durable writes before the service relinquishes a task. */
  async finish(id: CommunityTaskId): Promise<void> {
    for (const [key, buffer] of this.buffers) {
      if (!key.startsWith(`${id}:`)) continue
      if (buffer.text || buffer.dropping) this.append(id, { ...buffer.entry,
        text: buffer.dropping ? '[oversized output line omitted]' : buffer.text, ...(buffer.dropping ? { level: 'warning', code: 'output-line-omitted' } : {}) })
      this.buffers.delete(key)
    }
    await this.flush()
  }

  async flush(): Promise<void> {
    await this.mutations
    this.persist()
    await this.writes
  }

  /** @returns Sanitized tail after the cursor, including explicit loss and persistence flags. */
  async read(id: CommunityTaskId, after = 0): Promise<CommunityTaskLog> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid installation log cursor')
    communityLogTaskId(id)
    await this.mutations
    const log = await this.load(id)
    return { id, entries: log.entries.filter(item => item.sequence > after).map(item => ({ ...item })),
      nextCursor: log.nextCursor, truncated: log.truncated, unavailable: log.unavailable }
  }

  /** Delete only retained task files whose validated identifiers the service has evicted. */
  async remove(id: CommunityTaskId): Promise<void> {
    await this.flush()
    await rm(this.file(id), { force: true })
    this.logs.delete(id)
  }

  /** Startup removes orphaned UUID logs; arbitrary filenames are never touched. */
  async retain(ids: ReadonlySet<CommunityTaskId>): Promise<void> {
    let files: string[]
    try { files = await readdir(join(this.directory, 'task-logs-v1')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const file of files) {
      if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue
      const id = communityLogTaskId(file.slice(0, -5))
      if (!ids.has(id)) await this.remove(id)
    }
  }
}

/** A portable diagnostic report; user-selected export paths stay outside the renderer API. */
export function formatCommunityTaskLog(task: CommunityTask, log: CommunityTaskLog): string {
  const lines = [`DSH community installation ${task.id}`, `Plugin: ${task.plugin.id} ${task.version ?? task.plugin.version ?? 'latest'}`,
    `Phase: ${task.phase}`, `Error: ${task.problem?.code ?? '-'}`, `Previous profile restored: ${String(task.restored ?? false)}`,
    `Log truncated: ${String(log.truncated)}`, `Log storage unavailable: ${String(log.unavailable)}`, '']
  for (const item of log.entries) lines.push(`[${new Date(item.time).toISOString()}] [${item.phase}] [${item.level}] [${item.source}]${item.code === undefined ? '' : ` [${item.code}]`}${item.exitCode === undefined ? '' : ` [exit=${String(item.exitCode)}]`} ${item.text}`)
  return lines.join('\n') + '\n'
}
