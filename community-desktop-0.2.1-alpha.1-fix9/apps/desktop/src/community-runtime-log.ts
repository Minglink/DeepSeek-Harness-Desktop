/** Durable startup and renderer diagnostics are independent of installation tasks and Host availability. */
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { sanitizeCommunityLog } from './community-task-log.ts'
import type { CommunityRuntimeLog, CommunityRuntimeLogEntry } from './community-types.ts'

const MAX_BYTES = 256 * 1024
const MAX_ENTRIES = 1_000
const MAX_TEXT = 16_384

/** Only main-owned observers and package operations may append; no public renderer API exposes this input. */
export type CommunityRuntimeLogInput = Omit<CommunityRuntimeLogEntry, 'sequence' | 'time' | 'source'>
  & {
    source?: CommunityRuntimeLogEntry['source']
    truncated?: boolean
  }
interface StoredLog {
  version: 1
  entries: CommunityRuntimeLogEntry[]
  nextCursor: number
  truncated: boolean
  unavailable: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function entry(value: unknown): value is CommunityRuntimeLogEntry {
  return record(value) && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && typeof value.time === 'number' && Number.isFinite(value.time) && Math.abs(value.time) <= 8.64e15
    && ['renderer', 'system', 'pnpm'].includes(String(value.source)) && ['info', 'warning', 'error'].includes(String(value.level))
    && typeof value.text === 'string' && value.text.length <= MAX_TEXT
    && (value.file === undefined || typeof value.file === 'string' && value.file.length <= 1_024)
    && (value.line === undefined || Number.isSafeInteger(value.line) && Number(value.line) >= 0)
}

/** A single bounded stream retains startup and client failures across Desktop restarts. */
export class CommunityRuntimeLogStore {
  private readonly file: string
  private loading: Promise<StoredLog> | undefined
  private mutations: Promise<void> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private dirty = false
  private pendingBytes = 0
  private pendingTruncated = false
  private readonly pending: { item: CommunityRuntimeLogEntry; bytes: number; truncated: boolean }[] = []
  private draining = false
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param directory - Private Desktop diagnostic directory.
   * @param secrets - Main-owned credentials to remove.
   * @param changed - Notify read-only subscribers after persistence.
   */
  constructor(directory: string, private readonly secrets: () => readonly string[], private readonly changed: () => void) {
    this.file = join(directory, 'runtime-log-v1.json')
  }

  private clean(item: CommunityRuntimeLogEntry): CommunityRuntimeLogEntry {
    return { sequence: item.sequence, time: item.time, source: item.source, level: item.level,
      text: sanitizeCommunityLog(item.text, this.secrets()),
      ...(item.file === undefined ? {} : { file: sanitizeCommunityLog(item.file, this.secrets()).slice(0, 1_024) }),
      ...(item.line === undefined ? {} : { line: item.line }) }
  }

  private load(): Promise<StoredLog> {
    return this.loading ??= (async () => {
      const empty: StoredLog = { version: 1, entries: [], nextCursor: 0, truncated: false, unavailable: false }
      let content: string
      try {
        const info = await lstat(this.file)
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Invalid runtime log')
        const handle = await open(this.file, 'r')
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid runtime log')
          const buffer = Buffer.alloc(MAX_BYTES + 1)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead > MAX_BYTES) throw new Error('Oversized runtime log')
          content = buffer.subarray(0, bytesRead).toString('utf8')
        } finally { await handle.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') empty.unavailable = true
        return empty
      }
      try {
        const value: unknown = JSON.parse(content)
        if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
          || !value.entries.every(entry) || !Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < 0
          || typeof value.truncated !== 'boolean') throw new Error('Invalid runtime log')
        const entries: CommunityRuntimeLogEntry[] = value.entries
        if (entries.some((item, index) => item.sequence > Number(value.nextCursor)
          || index > 0 && item.sequence <= (entries[index - 1]?.sequence ?? 0))) throw new Error('Invalid runtime log sequence')
        return { ...empty, entries: entries.map(item => this.clean(item)), nextCursor: Number(value.nextCursor),
          truncated: value.truncated, unavailable: value.unavailable === true }
      } catch (_error) { empty.unavailable = true; return empty }
    })()
  }

  /** Append complete events, sanitizing message and location before queuing, persistence, or notifications.
   * @param input - Main-owned startup output or console event and source location.
   */
  append(input: CommunityRuntimeLogInput): void {
    // Clean synchronously: logout and credential rotation cannot expose a previously queued event.
    // Bound the pending queue as well as disk history; raw subprocess chunks are never retained here.
    const cleaned = this.clean({ ...input, source: input.source ?? 'renderer', sequence: 1, time: Date.now() })
    const size = Buffer.byteLength(JSON.stringify(cleaned))
    this.pendingBytes += size
    const truncated = input.truncated === true || input.text.length > MAX_TEXT || (input.file?.length ?? 0) > 1_024
    this.pending.push({ item: cleaned, bytes: size, truncated })
    while (this.pendingBytes > MAX_BYTES) {
      const removed = this.pending.shift()
      if (removed === undefined) break
      this.pendingBytes -= removed.bytes; this.pendingTruncated = true
    }
    this.drain()
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    this.mutations = this.mutations.then(async () => {
      const log = await this.load()
      for (let pending = this.pending.shift(); pending !== undefined; pending = this.pending.shift()) {
        this.pendingBytes -= pending.bytes
        log.entries.push({ ...pending.item, sequence: ++log.nextCursor })
        if (pending.truncated) log.truncated = true
      }
      if (this.pendingTruncated) { log.truncated = true; this.pendingTruncated = false }
      while (log.entries.length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(log)) + 1 > MAX_BYTES) {
        log.entries.shift(); log.truncated = true
      }
      this.dirty = true
      if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.persist() }, 200)
    }).catch(async (_error: unknown) => {
      const log = await this.load(); log.unavailable = true; this.dirty = true; this.persist()
    }).finally(() => { this.draining = false; if (this.pending.length > 0) this.drain() })
  }

  private persist(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.dirty) return
    this.dirty = false
    this.writes = this.writes.then(async () => {
      const log = await this.load()
      try { await writeFileAtomic(this.file, JSON.stringify(log) + '\n', { mode: 0o600, dirMode: 0o700 }) }
      catch (_error) { log.unavailable = true }
      try { this.changed() }
      catch (_error) { log.unavailable = true }
    })
  }

  /** @returns After queued events and durable writes settle, including unavailable-storage reporting. */
  async flush(): Promise<void> {
    do { await this.mutations } while (this.draining || this.pending.length > 0)
    if (this.pendingTruncated) { const log = await this.load(); log.truncated = true; this.pendingTruncated = false; this.dirty = true }
    this.persist(); await this.writes
  }

  /** @param after - Last observed sequence, or zero for retained history.
   * @returns Sanitized entries and explicit loss/persistence flags.
   */
  async read(after = 0): Promise<CommunityRuntimeLog> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid runtime log cursor')
    do { await this.mutations } while (this.draining || this.pending.length > 0)
    const log = await this.load()
    if (this.pendingTruncated) { log.truncated = true; this.pendingTruncated = false; this.dirty = true }
    return { entries: log.entries.filter(item => item.sequence > after).map(item => this.clean(item)),
      nextCursor: log.nextCursor, truncated: log.truncated, unavailable: log.unavailable }
  }
}

/** @param log - Sanitized retained client history. @returns A portable report without an inferred installation task association. */
export function formatCommunityRuntimeLog(log: CommunityRuntimeLog): string {
  const lines = ['DSH runtime log', `Log truncated: ${String(log.truncated)}`,
    `Log storage unavailable: ${String(log.unavailable)}`, '']
  for (const item of log.entries) lines.push(`[${new Date(item.time).toISOString()}] [${item.source}] [${item.level}]${item.file === undefined ? '' : ` [${item.file}${item.line === undefined ? '' : `:${String(item.line)}`}]`} ${item.text}`)
  return lines.join('\n') + '\n'
}
