/** Durable runtime diagnostics never infer installation task ownership. */
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityRuntimeLogStore, formatCommunityRuntimeLog } from '../src/community-runtime-log.ts'
import { DesktopCommunityService } from '../src/community-service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(secrets: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-log-'))
  roots.push(root)
  const changed = vi.fn()
  return { root, changed, store: new CommunityRuntimeLogStore(root, () => secrets, changed) }
}

describe('durable client runtime diagnostics', () => {
  it('shares already durable startup output with an offline service and retains event-time credentials on logout', async () => {
    const { root } = await fixture()
    let secrets = ['ephemeral-bare-credential']
    const store = new CommunityRuntimeLogStore(root, () => secrets, () => {})
    store.append({ source: 'pnpm', level: 'warning', text: 'ephemeral-bare-credential original UND_ERR_SOCKET' })
    secrets = []
    await store.flush()
    const service = new DesktopCommunityService({ directory: root, runtimeLog: store, account: () => null,
      changed: () => {}, invoke: () => Promise.reject(new Error('Host unavailable')) })
    const history = await service.getRuntimeLog()
    expect(history.entries[0]).toMatchObject({ source: 'pnpm', text: '[redacted] original UND_ERR_SOCKET' })
    expect(await service.runtimeLogText()).toContain('[pnpm]')
    await service.dispose()
    expect(await readFile(join(root, 'runtime-log-v1.json'), 'utf8')).not.toContain('ephemeral-bare-credential')
    const reopened = new CommunityRuntimeLogStore(root, () => [], () => {})
    expect((await reopened.read()).entries[0]?.text).toContain('original UND_ERR_SOCKET')
  })

  it('keeps the latest exit when a synchronous output flood exceeds the pending buffer', async () => {
    const { root, store } = await fixture()
    for (let index = 0; index < 500; index++) store.append({ source: 'pnpm', level: 'info', text: `line ${index} ` + 'data '.repeat(1000) })
    store.append({ source: 'system', level: 'error', text: 'startup pnpm exit: 7; process tree quiet: true' })
    await store.flush()
    expect((await store.read()).entries.at(-1)?.text).toContain('exit: 7')
    expect(await store.read()).toMatchObject({ truncated: true, unavailable: false })
    expect((await stat(join(root, 'runtime-log-v1.json'))).size).toBeLessThanOrEqual(256 * 1024)
  })

  it('drains events queued during an earlier batch completion', async () => {
    const { store } = await fixture()
    store.append({ source: 'system', level: 'info', text: 'before await' })
    await store.read()
    store.append({ source: 'pnpm', level: 'warning', text: 'after read' })
    await Promise.resolve()
    store.append({ source: 'system', level: 'error', text: 'last exit' })
    await store.flush()
    expect((await store.read()).entries.map(item => item.text)).toEqual(['before await', 'after read', 'last exit'])
  })
  it('saves the original error and location with credentials redacted before disk, read and export', async () => {
    const { root, changed, store } = await fixture(['saved-token', 'model-key'])
    store.append({ level: 'error', text: 'Timeline order invariant failed\nAuthorization: Bearer hidden\nmodel-key saved-token',
      file: 'http://127.0.0.1/client.js?token=saved-token&version=1', line: 244 })
    await store.flush()
    const disk = await readFile(join(root, 'runtime-log-v1.json'), 'utf8')
    const history = await new CommunityRuntimeLogStore(root, () => [], () => {}).read()
    expect(history.entries).toHaveLength(1)
    expect(history.entries[0]).toMatchObject({ source: 'renderer', level: 'error', line: 244 })
    expect(history.entries[0]?.file).toContain('version=1')
    const text = formatCommunityRuntimeLog(history)
    expect(text).toContain('Timeline order invariant failed')
    expect(text).toContain(':244')
    for (const secret of ['hidden', 'saved-token', 'model-key']) { expect(disk).not.toContain(secret); expect(text).not.toContain(secret) }
    expect(text).not.toContain('Plugin:')
    expect(changed).toHaveBeenCalled()
  })

  it('keeps monotonic cursors and a bounded tail across restart', async () => {
    const { root, store } = await fixture()
    for (let index = 0; index < 1_010; index++) store.append({ level: 'warning', text: `remote.session unavailable ${index}` })
    await store.flush()
    const log = await store.read()
    expect(log).toMatchObject({ nextCursor: 1_010, truncated: true, unavailable: false })
    expect(log.entries).toHaveLength(1_000)
    expect(log.entries[0]?.sequence).toBe(11)
    const reopened = new CommunityRuntimeLogStore(root, () => [], () => {})
    expect((await reopened.read(1_008)).entries.map(item => item.sequence)).toEqual([1_009, 1_010])
    reopened.append({ level: 'error', text: 'next launch' })
    await reopened.flush()
    expect((await reopened.read(1_010)).entries[0]?.sequence).toBe(1_011)
    expect((await stat(join(root, 'runtime-log-v1.json'))).size).toBeLessThanOrEqual(256 * 1024)
  })

  it('projects only allowed durable fields and sanitizes credentials introduced since the previous launch', async () => {
    const { root } = await fixture()
    await writeFile(join(root, 'runtime-log-v1.json'), JSON.stringify({ version: 1, nextCursor: 1, truncated: false,
      entries: [{ sequence: 1, time: 1, source: 'renderer', level: 'error', text: 'new-known-secret remote.session error',
        file: 'ModelSwitcher.js', line: 9, cookie: 'hidden-extra', taskId: 'wrong-task' }] }))
    const log = await new CommunityRuntimeLogStore(root, () => ['new-known-secret'], () => {}).read()
    expect(JSON.stringify(log)).not.toContain('new-known-secret')
    expect(JSON.stringify(log)).not.toContain('hidden-extra')
    expect(JSON.stringify(log)).not.toContain('wrong-task')
    expect(log.entries[0]?.text).toContain('remote.session error')
  })

  it('reports a failed sink without throwing or losing the in-memory failure', async () => {
    const { root, store } = await fixture()
    await writeFile(join(root, 'occupied'), 'file')
    const unavailable = new CommunityRuntimeLogStore(join(root, 'occupied'), () => [], () => {})
    unavailable.append({ level: 'error', text: 'original renderer failure' })
    await unavailable.flush()
    expect(await unavailable.read()).toMatchObject({ unavailable: true })
    expect((await unavailable.read()).entries[0]?.text).toBe('original renderer failure')
    await expect(store.read(-1)).rejects.toThrow('cursor')
    await expect(store.read(0.5)).rejects.toThrow('cursor')
  })

  it.each(['oversized', 'bad sequence', 'bad source', 'invalid timestamp'])('rejects %s durable records with a readable unavailable result', async (kind) => {
    const { root, store } = await fixture()
    const item = { sequence: 1, time: 1, source: kind === 'bad source' ? 'untrusted-ipc' : 'renderer', level: 'error', text: 'error' }
    if (kind === 'bad sequence') item.sequence = 2
    if (kind === 'invalid timestamp') item.time = 1e20
    await writeFile(join(root, 'runtime-log-v1.json'), kind === 'oversized' ? 'x'.repeat(256 * 1024 + 1)
      : JSON.stringify({ version: 1, nextCursor: 1, truncated: false, entries: [item] }))
    expect(await store.read()).toEqual({ entries: [], nextCursor: 0, truncated: false, unavailable: true })
    expect(() => formatCommunityRuntimeLog({ entries: [], nextCursor: 0, truncated: false, unavailable: true })).not.toThrow()
  })

  it('refuses a log symlink without reading its target', async () => {
    const { root, store } = await fixture()
    const target = join(root, 'unrelated-secret.json')
    await writeFile(target, JSON.stringify({ version: 1, nextCursor: 1, truncated: false,
      entries: [{ sequence: 1, time: 1, source: 'renderer', level: 'error', text: 'must-not-read-target' }] }))
    await symlink(target, join(root, 'runtime-log-v1.json'), 'file')
    expect(await store.read()).toMatchObject({ entries: [], unavailable: true })
    expect(await readFile(target, 'utf8')).toContain('must-not-read-target')
  })
})
