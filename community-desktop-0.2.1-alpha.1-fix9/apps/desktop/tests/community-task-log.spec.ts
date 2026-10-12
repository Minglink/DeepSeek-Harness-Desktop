import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommunityTaskLogStore, communityLogTaskId, formatCommunityTaskLog, sanitizeCommunityLog } from '../src/community-task-log.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const output = { phase: 'installing' as const, level: 'info' as const, source: 'pnpm' as const, text: '' }
async function fixture(secrets: readonly string[] = []): Promise<{
  root: string
  id: ReturnType<typeof communityLogTaskId>
  store: CommunityTaskLogStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-log-'))
  roots.push(root)
  return { root, id: communityLogTaskId(randomUUID()), store: new CommunityTaskLogStore(root, () => secrets, () => {}) }
}

describe('installation diagnostics', () => {
  it('retains long plain words and redacts credential assignments only from complete key boundaries', () => {
    const prefix = 'x'.repeat(8_000)
    const clean = sanitizeCommunityLog(`${prefix} access-token=hidden_1 "API_KEY":"hidden_2" app.secret='hidden_3'`, [])
    expect(clean).toContain(prefix)
    for (const secret of ['hidden_1', 'hidden_2', 'hidden_3']) expect(clean).not.toContain(secret)
    expect(clean).toContain('access-token=[redacted]')
  })
  it('redacts whole-line secrets and URL credentials while retaining the failure code', () => {
    const line = '\x1b[31mERR_PNPM_FETCH_404\x1b[0m https://reader:password@registry.example/pkg?token=private&version=1.0.0\nAuthorization: Bearer hidden\n{"apiKey":"another-key"}\naccount=known-secret'
    const clean = sanitizeCommunityLog(line, ['known-secret'])
    for (const secret of ['password@', 'private', 'hidden', 'another-key', 'known-secret', '\x1b']) expect(clean).not.toContain(secret)
    expect(clean).toContain('ERR_PNPM_FETCH_404')
    expect(clean).toContain('version=1.0.0')
  })

  it('buffers credentials split across stdout chunks and flushes partial final lines', async () => {
    const { root, id, store } = await fixture(['model-secret'])
    store.stream(id, 'job:stdout', { ...output, text: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE\nAuthorization: Bea' })
    store.stream(id, 'job:stdout', { ...output, text: 'rer user-token\nkey=model-' })
    store.stream(id, 'job:stdout', { ...output, text: 'secret' })
    await store.finish(id)
    const disk = await readFile(join(root, 'task-logs-v1', `${id}.json`), 'utf8')
    expect(disk).not.toContain('user-token')
    expect(disk).not.toContain('model-secret')
    expect(disk).toContain('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE')
    const reopened = new CommunityTaskLogStore(root, () => [], () => {})
    const log = await reopened.read(id)
    expect(log.entries).toHaveLength(3)
    expect(log.nextCursor).toBe(3)
    expect(formatCommunityTaskLog({ id, plugin: { id: 'purge', name: 'Purge' }, phase: 'failed', createdAt: 1, updatedAt: 1,
      problem: { code: 'trial-failed' }, restored: true }, log)).toContain('Previous profile restored: true')
  })

  it('discards an entire oversized line without exposing its trailing split credential', async () => {
    const { root, id, store } = await fixture(['private-value'])
    store.stream(id, 'job:stderr', { ...output, text: 'x'.repeat(16_380) + 'private-' })
    store.stream(id, 'job:stderr', { ...output, text: 'value\nERR_PNPM_FETCH_404\n' }, true)
    await store.flush()
    const log = await store.read(id)
    expect(log.truncated).toBe(true)
    expect(log.entries[0]).toMatchObject({ code: 'output-line-omitted', level: 'warning' })
    expect(JSON.stringify(log)).not.toContain('private-')
    expect(await readFile(join(root, 'task-logs-v1', `${id}.json`), 'utf8')).not.toContain('private-')
    expect(log.entries.map(entry => entry.text)).toContain('ERR_PNPM_FETCH_404')
  })

  it('retains monotonic cursors when a bounded tail discards old output', async () => {
    const { root, id, store } = await fixture()
    for (let index = 0; index < 1_010; index++) store.append(id, { ...output, text: `line ${index}` })
    await store.flush()
    const log = await store.read(id)
    expect(log.truncated).toBe(true)
    expect(log.entries).toHaveLength(1_000)
    expect(log.entries[0]?.sequence).toBe(11)
    expect(log.nextCursor).toBe(1_010)
    expect((await store.read(id, 1_005)).entries.map(entry => entry.sequence)).toEqual([1_006, 1_007, 1_008, 1_009, 1_010])
    expect((await stat(join(root, 'task-logs-v1', `${id}.json`))).size).toBeLessThanOrEqual(256 * 1024)
    expect((await new CommunityTaskLogStore(root, () => [], () => {}).read(id)).unavailable).toBe(false)
  })

  it('projects only allowed durable fields and rejects invalid timestamps without throwing during export', async () => {
    const { root, id, store } = await fixture()
    await mkdir(join(root, 'task-logs-v1'))
    const value = { version: 1, id, nextCursor: 1, truncated: false, entries: [{ ...output, sequence: 1, time: 1,
      authorization: 'Bearer hidden-extra', text: 'ERR_PNPM' }] }
    await writeFile(join(root, 'task-logs-v1', `${id}.json`), JSON.stringify(value))
    expect(JSON.stringify(await store.read(id))).not.toContain('hidden-extra')
    value.entries[0]!.time = 1e20
    await writeFile(join(root, 'task-logs-v1', `${id}.json`), JSON.stringify(value))
    const invalid = await new CommunityTaskLogStore(root, () => [], () => {}).read(id)
    expect(invalid).toMatchObject({ entries: [], unavailable: true })
    expect(() => formatCommunityTaskLog({ id, plugin: { id: 'addon', name: 'Addon' }, phase: 'failed', createdAt: 1, updatedAt: 1 }, invalid)).not.toThrow()
  })

  it('exposes storage failures and rejects arbitrary file selectors', async () => {
    const { root, id, store } = await fixture()
    await writeFile(join(root, 'task-logs-v1'), 'occupied')
    store.append(id, { ...output, text: 'ERR_PNPM' }, true)
    await store.flush()
    expect((await store.read(id)).unavailable).toBe(true)
    expect(() => communityLogTaskId('../../credentials')).toThrow('Invalid installation task')
    await expect(store.read(id, -1)).rejects.toThrow('cursor')
  })

  it('removes orphaned UUID logs while preserving unrelated files', async () => {
    const { root, id, store } = await fixture()
    const other = communityLogTaskId(randomUUID())
    store.append(id, output)
    store.append(other, output)
    await store.flush()
    await writeFile(join(root, 'task-logs-v1', 'notes.txt'), 'keep')
    await store.retain(new Set([id]))
    await expect(readFile(join(root, 'task-logs-v1', `${other}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'task-logs-v1', 'notes.txt'), 'utf8')).toBe('keep')
    expect((await store.read(id)).entries).toHaveLength(1)
  })
})
