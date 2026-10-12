/** Archive adaptation uses private fixtures and an instance-local HTTP adapter; no plugin code or credentials are used. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { create as createTar, extract as extractTar, Header, list as listTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCommunityBundle, type CommunityDownloadAttempt, type CommunityInstallOptions } from '../src/community-install.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const intent = { id: 'addon', name: 'Untrusted catalogue title', version: 'latest', repo: '' }
const sourceIntent = { ...intent, downloadUrl: 'https://codeload.github.com/example/community-addon/zip/refs/heads/main' }
const manifest = {
  name: '@example/community-addon', version: '1.2.3', type: 'module',
  exports: { '.': './lib/index.js', './cordis.patch.yml': './cordis.patch.yml' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}

function bundledFiles(name = '@fixture/one', version = '1.0.0', dependencies: Record<string, string> = {}, prefix = 'package/node_modules'): Record<string, string> {
  return {
    [`${prefix}/${name}/package.json`]: JSON.stringify({ name, version, type: 'module', exports: { '.': './index.js' }, dependencies }),
    [`${prefix}/${name}/index.js`]: 'throw new Error("Bundled fixture code must never execute")\n',
  }
}

function bundledZip(files: Record<string, string> = {}, changes: Record<string, unknown> = {}): Uint8Array {
  return zip({ ...bundledFiles(), ...files }, { ...manifest, dependencies: { '@fixture/one': '1.0.0' }, bundledDependencies: ['@fixture/one'], ...changes })
}

async function fixture(): Promise<{ root: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-community-fixture-'))
  roots.push(root)
  return { root, artifacts: join(root, 'artifacts') }
}

function zip(files: Record<string, string> = {}, metadata: object = manifest): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries({
    'package/package.json': JSON.stringify(metadata),
    'package/lib/index.js': 'export default function plugin() {}\n',
    'package/cordis.patch.yml': '- insert:\n    - id: addon\n      name: "@example/community-addon"\n',
    ...files,
  }).map(([name, contents]) => [name, strToU8(contents)])))
}

function options(artifacts: string, bytes = zip()): CommunityInstallOptions {
  return {
    artifactDirectory: artifacts,
    fetch: withMetadata(async () => new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }), bytes),
  }
}

function release(bytes: Uint8Array, overrides: Record<string, unknown> = {}): Response {
  return Response.json({ plugin: { id: intent.id, version: intent.version, status: 'published',
    installVerification: { artifact: { packageVersion: intent.version, sourceVersion: manifest.version,
      packageName: manifest.name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      format: bytes[0] === 0x1f && bytes[1] === 0x8b ? 'tgz' : 'zip' } }, ...overrides } })
}

function withMetadata(fetcher: typeof fetch, bytes = zip()): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/api/plugins/addon' && ['https://deepseek.stream', 'https://www.deepseek.stream'].includes(url.origin)) {
      const headers = new Headers(init?.headers)
      expect(headers.has('authorization') || headers.has('cookie')).toBe(false)
      return release(bytes)
    }
    return fetcher(input, init)
  }
}

function tarEntry(path: string, type: 'File' | 'SymbolicLink' | 'Link', data = ''): Uint8Array {
  const content = Buffer.from(data)
  const header = Buffer.alloc(512)
  new Header({ path, type, size: content.length, mode: 0o600, linkpath: type === 'File' ? '' : '../outside' }).encode(header)
  return new Uint8Array(gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)])))
}

describe('Windows community archive storage in deep directories', () => {
  it.skipIf(process.platform !== 'win32')('publishes, verifies and reuses archives beyond the legacy Windows path limit', async () => {
    const { root } = await fixture(), bytes = zip()
    const artifacts = join(root, 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80), 'artifacts')
    expect(artifacts.length).toBeGreaterThan(260)
    const prepared = await prepareCommunityBundle(intent, options(artifacts, bytes))
    expect(await readFile(prepared.originalSpec ?? '')).toEqual(Buffer.from(bytes))
    const repeated = await prepareCommunityBundle(intent, options(artifacts, bytes))
    expect(repeated.spec).toBe(prepared.spec)
    const digest = createHash('sha256').update(await readFile(prepared.spec)).digest('hex')
    expect(createHash('sha256').update(await readFile(repeated.spec)).digest('hex')).toBe(digest)
    expect(await readdir(join(artifacts, 'v1'))).toEqual([`${digest}.tgz`])
    expect(await readdir(join(artifacts, 'originals'))).toEqual([`${prepared.originalSha256}.archive`])
  })

  it.skipIf(process.platform !== 'win32')('extracts and cleans up with a private TEMP beyond the legacy Windows path limit', async () => {
    const { root, artifacts } = await fixture()
    const temporary = join(root, 't'.repeat(80), 'u'.repeat(80), 'v'.repeat(80))
    await mkdir(temporary, { recursive: true })
    const previous = process.env.TEMP, previousTmp = process.env.TMP
    process.env.TEMP = temporary
    process.env.TMP = temporary
    try {
      const prepared = await prepareCommunityBundle(intent, options(artifacts))
      expect(prepared.packageName).toBe(manifest.name)
      expect(await readdir(temporary)).toEqual([])
      expect((await readFile(prepared.spec)).length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env.TEMP
      else process.env.TEMP = previous
      if (previousTmp === undefined) delete process.env.TMP
      else process.env.TMP = previousTmp
    }
  })
})

describe('bounded community archive download retries', () => {
  it('allows steady body progress beyond the connection timeout and reports the default overall budget', async () => {
    const { artifacts } = await fixture(), bytes = zip(), events: CommunityDownloadAttempt[] = []
    let cursor = 0
    const started = Date.now()
    const stream = new ReadableStream<Uint8Array>({
      async pull(owner) {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (cursor === bytes.length) { owner.close(); return }
        const end = Math.min(cursor + Math.ceil(bytes.length / 5), bytes.length)
        owner.enqueue(bytes.slice(cursor, end))
        cursor = end
      },
    })
    const prepared = await prepareCommunityBundle(intent, {
      artifactDirectory: artifacts, limits: { connectTimeoutMs: 45, idleTimeoutMs: 100 },
      fetch: withMetadata(async () => new Response(stream, { headers: { 'content-length': String(bytes.length) } }), bytes),
      onDownloadAttempt: (event) => { events.push(event) },
    })
    expect(Date.now() - started).toBeGreaterThan(45)
    expect(prepared.originalSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(events).toEqual([expect.objectContaining({ phase: 'start', attempt: 1, maxAttempts: 3, timeoutMs: 600_000,
      connectTimeoutMs: 45, idleTimeoutMs: 100 })])
  })

  it('discards partial bytes and retries a socket failure against the same frozen release', async () => {
    const { artifacts } = await fixture(), bytes = zip(), events: CommunityDownloadAttempt[] = []
    const cause = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' })
    let attempts = 0, metadataCalls = 0
    const prepared = await prepareCommunityBundle(intent, {
      artifactDirectory: artifacts, limits: { retryDelayMs: 0 }, onDownloadAttempt: (event) => { events.push(event) },
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
        if (url.pathname === '/api/plugins/addon') { metadataCalls++; return release(bytes) }
        expect(url.searchParams.get('sha256')).toBe(createHash('sha256').update(bytes).digest('hex'))
        if (++attempts === 1) {
          let pulls = 0
          return new Response(new ReadableStream<Uint8Array>({
            pull(owner) { if (++pulls === 1) owner.enqueue(bytes.slice(0, 20)); else owner.error(cause) },
          }), { headers: { 'content-length': String(bytes.length) } })
        }
        return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } })
      },
    })
    expect(metadataCalls).toBe(1)
    expect(attempts).toBe(2)
    expect(events.map(event => [event.phase, event.attempt])).toEqual([['start', 1], ['retry', 1], ['start', 2]])
    expect(events[1]).toMatchObject({ retryDelayMs: 0, error: { cause } })
    if (prepared.originalSpec === undefined) throw new Error('A verified archive must be retained')
    expect(await readFile(prepared.originalSpec)).toEqual(Buffer.from(bytes))
  })

  it('restarts redirect credential decisions on each attempt and never sends credentials across origins', async () => {
    const { artifacts } = await fixture(), bytes = zip(), requests: { origin: string; authenticated: boolean }[] = []
    let completed = 0
    await prepareCommunityBundle(intent, {
      artifactDirectory: artifacts, token: 'fixture-account-token', limits: { retryDelayMs: 0 },
      fetch: withMetadata(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
        const headers = new Headers(init?.headers)
        requests.push({ origin: url.origin, authenticated: headers.has('authorization') || headers.has('cookie') })
        if (url.origin === 'https://deepseek.stream') return new Response(null, { status: 302, headers: { location: 'https://cdn.example/package.zip' } })
        if (++completed === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
        return new Response(new Uint8Array(bytes))
      }, bytes),
    })
    expect(requests).toEqual([
      { origin: 'https://deepseek.stream', authenticated: true }, { origin: 'https://cdn.example', authenticated: false },
      { origin: 'https://deepseek.stream', authenticated: true }, { origin: 'https://cdn.example', authenticated: false },
    ])
  })

  it.each([408, 429, 500, 503])('retries transient HTTP %s and retains its status in diagnostics', async (status) => {
    const { artifacts } = await fixture(), events: CommunityDownloadAttempt[] = []
    let attempts = 0
    await prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts, limits: { retryDelayMs: 0 },
      onDownloadAttempt: (event) => { events.push(event) }, fetch: async () => ++attempts === 1
        ? new Response(null, { status }) : new Response(new Uint8Array(zip())),
    })
    expect(attempts).toBe(2)
    expect(events[1]).toMatchObject({ phase: 'retry', attempt: 1, error: { statusCode: status } })
  })

  it.each([401, 403, 404])('does not retry HTTP %s', async (status) => {
    const { artifacts } = await fixture()
    let attempts = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts, limits: { retryDelayMs: 0 },
      fetch: async () => { attempts++; return new Response(null, { status }) },
    })).rejects.toMatchObject({ statusCode: status })
    expect(attempts).toBe(1)
  })

  it('does not retry a stalled permission denial body', async () => {
    const { artifacts } = await fixture()
    let attempts = 0, closed = false
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts, limits: { idleTimeoutMs: 5, retryDelayMs: 0 },
      fetch: async () => { attempts++; return new Response(new ReadableStream({ cancel() { closed = true } }), { status: 403 }) },
    })).rejects.toMatchObject({ problem: 'download-forbidden', statusCode: 403 })
    expect(attempts).toBe(1)
    expect(closed).toBe(true)
  })

  it('retries an idle body, closes it, and bounds repeated failures to the configured attempts', async () => {
    const { artifacts } = await fixture(), events: CommunityDownloadAttempt[] = []
    let closed = 0, attempts = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts,
      limits: { idleTimeoutMs: 5, retryDelayMs: 0, maxDownloadAttempts: 2 }, onDownloadAttempt: (event) => { events.push(event) },
      fetch: async () => { attempts++; return new Response(new ReadableStream({ cancel() { closed++ } })) },
    })).rejects.toMatchObject({ problem: 'timeout', message: 'Community package download idle timed out' })
    expect(attempts).toBe(2)
    expect(closed).toBe(2)
    expect(events.map(event => event.phase)).toEqual(['start', 'retry', 'start', 'failed'])
  })

  it('retries a connection timeout within the same overall budget', async () => {
    const { artifacts } = await fixture(), events: CommunityDownloadAttempt[] = []
    let attempts = 0
    await prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts,
      limits: { connectTimeoutMs: 5, retryDelayMs: 0 }, onDownloadAttempt: (event) => { events.push(event) },
      fetch: async () => ++attempts === 1 ? new Promise(() => {}) : new Response(new Uint8Array(zip())),
    })
    expect(attempts).toBe(2)
    expect(events[1]).toMatchObject({ phase: 'retry', error: { problem: 'timeout', message: 'Community package download connection timed out' } })
  })

  it('retries a declared length mismatch without appending its incomplete bytes', async () => {
    const { artifacts } = await fixture(), bytes = zip()
    let attempts = 0
    const prepared = await prepareCommunityBundle(intent, { artifactDirectory: artifacts, limits: { retryDelayMs: 0 },
      fetch: withMetadata(async () => new Response(++attempts === 1 ? bytes.slice(0, 20) : new Uint8Array(bytes),
        { headers: { 'content-length': String(bytes.length) } }), bytes),
    })
    expect(attempts).toBe(2)
    expect(prepared.originalSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('stops a progressing body at the explicit overall deadline and closes it without retrying', async () => {
    const { artifacts } = await fixture()
    let attempts = 0, closed = false
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts,
      limits: { timeoutMs: 30, idleTimeoutMs: 100 }, fetch: async () => {
        attempts++
        return new Response(new ReadableStream<Uint8Array>({
          async pull(owner) { await new Promise(resolve => setTimeout(resolve, 5)); if (!closed) owner.enqueue(strToU8('progress')) },
          cancel() { closed = true },
        }))
      },
    })).rejects.toMatchObject({ problem: 'timeout', message: 'Community package download exceeded its overall time limit' })
    expect(attempts).toBe(1)
    expect(closed).toBe(true)
  })

  it('does not allow empty chunks to renew the idle deadline', async () => {
    const { artifacts } = await fixture()
    let closed = false
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts,
      limits: { idleTimeoutMs: 15, maxDownloadAttempts: 1 },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        async pull(owner) { await new Promise(resolve => setTimeout(resolve, 5)); if (!closed) owner.enqueue(new Uint8Array()) },
        cancel() { closed = true },
      })),
    })).rejects.toMatchObject({ problem: 'timeout' })
    expect(closed).toBe(true)
  })

  it('keeps an explicit timeout as one overall deadline without waiting for another attempt', async () => {
    const { artifacts } = await fixture(), events: CommunityDownloadAttempt[] = []
    let attempts = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts,
      limits: { timeoutMs: 5 }, onDownloadAttempt: (event) => { events.push(event) },
      fetch: async () => { attempts++; return new Promise(() => {}) },
    })).rejects.toMatchObject({ problem: 'timeout', message: 'Community package download exceeded its overall time limit' })
    expect(attempts).toBe(1)
    expect(events.map(event => event.phase)).toEqual(['start', 'failed'])
  })

  it('cancels promptly during retry backoff without another request', async () => {
    const { artifacts } = await fixture(), controller = new AbortController()
    let attempts = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts, signal: controller.signal,
      limits: { retryDelayMs: 60_000 }, onDownloadAttempt: (event) => { if (event.phase === 'retry') controller.abort() },
      fetch: async () => { attempts++; throw Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' }) },
    })).rejects.toMatchObject({ problem: 'cancelled' })
    expect(attempts).toBe(1)
  })

  it.each(['EIO', 'EACCES', 'ERR_INVALID_ARG_TYPE'])('does not retry non-network failure %s', async (code) => {
    const { artifacts } = await fixture()
    let attempts = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts, limits: { retryDelayMs: 0 },
      fetch: async () => { attempts++; throw Object.assign(new Error('local failure'), { code }) },
    })).rejects.toMatchObject({ problem: 'download-failed', cause: { code } })
    expect(attempts).toBe(1)
  })

  it('does not retry an archive that fails its frozen SHA after a completed body', async () => {
    const { artifacts } = await fixture(), bytes = zip()
    let attempts = 0
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts, limits: { retryDelayMs: 0 },
      fetch: withMetadata(async () => { attempts++; return new Response(new Uint8Array(zip({ 'package/extra.js': 'bad' }))) }, bytes),
    })).rejects.toMatchObject({ problem: 'invalid-archive' })
    expect(attempts).toBe(1)
  })

  it('contains diagnostic callback exceptions without changing successful preparation', async () => {
    const { artifacts } = await fixture()
    const prepared = await prepareCommunityBundle(intent, { ...options(artifacts), onDownloadAttempt: () => { throw new Error('observer failed') } })
    expect(prepared.packageName).toBe(manifest.name)
  })
})

describe('explicit bundled community dependencies', () => {
  it('retains a scoped declared package in ZIP preparation without importing its code', async () => {
    const { root, artifacts } = await fixture(), bytes = bundledZip()
    const prepared = await prepareCommunityBundle(intent, options(artifacts, bytes))
    const destination = join(root, 'prepared')
    await mkdir(destination)
    await extractTar({ file: prepared.spec, cwd: destination })
    expect(await readFile(join(destination, 'package/node_modules/@fixture/one/index.js'), 'utf8')).toBe(bundledFiles()['package/node_modules/@fixture/one/index.js'])
    if (prepared.originalSpec === undefined) throw new Error('Preparation must retain its immutable original archive')
    expect(await readFile(prepared.originalSpec)).toEqual(Buffer.from(bytes))
  })

  it('retains the same declared closure when preparing a tarball', async () => {
    const { artifacts } = await fixture()
    const first = await prepareCommunityBundle(intent, options(artifacts, bundledZip()))
    const prepared = await prepareCommunityBundle(intent, options(artifacts, new Uint8Array(await readFile(first.spec))))
    const names: string[] = []
    await listTar({ file: prepared.spec, onReadEntry: (entry) => { names.push(entry.path) } })
    expect(names).toContain('package/node_modules/@fixture/one/package.json')
    expect(prepared).toMatchObject({ packageName: manifest.name, version: manifest.version })
  })

  it('validates same-name packages at different physical depths using nearest dependency resolution', async () => {
    const { artifacts } = await fixture()
    const bytes = bundledZip({
      ...bundledFiles('@fixture/one', '1.0.0', { shared: '^2.0.0' }),
      ...bundledFiles('other', '1.0.0', { shared: '^1.0.0' }),
      ...bundledFiles('shared', '1.0.0'),
      ...bundledFiles('shared', '2.0.0', {}, 'package/node_modules/@fixture/one/node_modules'),
    }, { dependencies: { '@fixture/one': '1.0.0', other: '1.0.0' }, bundledDependencies: ['@fixture/one', 'other'] })
    await expect(prepareCommunityBundle(intent, options(artifacts, bytes))).resolves.toMatchObject({ packageName: manifest.name })
  })

  it('terminates a declared runtime dependency cycle', async () => {
    const { artifacts } = await fixture(), bytes = bundledZip({
      ...bundledFiles('@fixture/one', '1.0.0', { other: '1.0.0' }),
      ...bundledFiles('other', '1.0.0', { '@fixture/one': '1.0.0' }),
    })
    await expect(prepareCommunityBundle(intent, options(artifacts, bytes))).resolves.toMatchObject({ packageName: manifest.name })
  })

  it('preserves unbundled external semantic-version declarations and the standard alias', async () => {
    const { root, artifacts } = await fixture(), bytes = bundledZip(bundledFiles('@fixture/one', '1.0.0', { external: '^1.0.0 || ^2.0.0' }), { bundledDependencies: undefined, bundleDependencies: ['@fixture/one'] })
    const prepared = await prepareCommunityBundle(intent, options(artifacts, bytes)), destination = join(root, 'prepared')
    await mkdir(destination)
    await extractTar({ file: prepared.spec, cwd: destination })
    const child: unknown = JSON.parse(await readFile(join(destination, 'package/node_modules/@fixture/one/package.json'), 'utf8'))
    expect(child).toMatchObject({ dependencies: { external: '^1.0.0 || ^2.0.0' } })
  })

  it.each([
    { label: 'absent bundle declaration', files: {}, changes: { bundledDependencies: undefined } },
    { label: 'boolean bundle declaration', files: {}, changes: { bundledDependencies: true } },
    { label: 'duplicate bundle names', files: {}, changes: { bundledDependencies: ['@fixture/one', '@fixture/one'] } },
    { label: 'disagreeing bundle aliases', files: {}, changes: { bundleDependencies: ['other'] } },
    { label: 'root runtime package without bundle reachability', files: bundledFiles('other'), changes: { dependencies: { '@fixture/one': '1.0.0', other: '1.0.0' } } },
    { label: 'undeclared package name', files: { 'package/node_modules/@fixture/one/package.json': JSON.stringify({ name: 'other', version: '1.0.0' }) }, changes: {} },
    { label: 'version outside root pin', files: bundledFiles('@fixture/one', '2.0.0'), changes: {} },
    { label: 'prototype name without own dependency declaration', files: bundledFiles('constructor'), changes: { bundledDependencies: ['constructor'] } },
    { label: 'noncanonical nested module directory', files: bundledFiles('hidden', '1.0.0', {}, 'package/lib/node_modules'), changes: {} },
    { label: 'file dependency transport', files: bundledFiles('@fixture/one', '1.0.0', { external: 'file:../../../outside' }), changes: {} },
    { label: 'npm dependency alias', files: bundledFiles('@fixture/one', '1.0.0', { external: 'npm:other@1.0.0' }), changes: {} },
    { label: 'escaping export target', files: { 'package/node_modules/@fixture/one/package.json': JSON.stringify({ name: '@fixture/one', version: '1.0.0', exports: { '.': '../outside.js' } }) }, changes: {} },
    { label: 'escaping bin name', files: { 'package/node_modules/@fixture/one/package.json': JSON.stringify({ name: '@fixture/one', version: '1.0.0', bin: { '../outside': './index.js' } }) }, changes: {} },
    { label: 'unverified postinstall hook', files: { 'package/node_modules/@fixture/one/package.json': JSON.stringify({ name: '@fixture/one', version: '1.0.0', scripts: { postinstall: 'node index.js' } }) }, changes: {} },
    { label: 'implicit native build', files: { 'package/node_modules/@fixture/one/binding.gyp': '{}' }, changes: {} },
    { label: 'duplicate outer package root', files: { 'other/package.json': '{}' }, changes: {} },
  ])('refuses $label before model adaptation or publication', async ({ files, changes }) => {
    const { artifacts } = await fixture(), bytes = bundledZip(files, changes)
    let modelCalls = 0
    await expect(prepareCommunityBundle(intent, { ...options(artifacts, bytes), adaptation: {
      apiKey: 'fixture-key', harnessVersion: '0.2.1-alpha.1', fetch: async () => { modelCalls++; throw new Error('Dependency refusal must not call a model') },
    } })).rejects.toMatchObject({ problem: 'incompatible-package' })
    expect(modelCalls).toBe(0)
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['.bin', '.pnpm', '.cache', '.npm', '.git'])('refuses bundled %s metadata', async (reserved) => {
    const { artifacts } = await fixture(), bytes = bundledZip({ [`package/node_modules/${reserved}/file`]: 'forbidden' })
    await expect(prepareCommunityBundle(intent, options(artifacts, bytes))).rejects.toMatchObject({ problem: 'incompatible-package' })
  })

  it('refuses a bundled package whose manifest is absent', async () => {
    const { artifacts } = await fixture(), bytes = bundledZip({ 'package/node_modules/other/index.js': 'not executed' }, { dependencies: { '@fixture/one': '1.0.0', other: '1.0.0' }, bundledDependencies: ['@fixture/one', 'other'] })
    await expect(prepareCommunityBundle(intent, options(artifacts, bytes))).rejects.toMatchObject({ problem: 'incompatible-package' })
  })

  it('refuses a nested version mismatch even when the same name at the root matches', async () => {
    const { artifacts } = await fixture(), bytes = bundledZip({
      ...bundledFiles('@fixture/one', '1.0.0', { shared: '^1.0.0' }),
      ...bundledFiles('shared', '1.0.0'),
      ...bundledFiles('shared', '2.0.0', {}, 'package/node_modules/@fixture/one/node_modules'),
    })
    await expect(prepareCommunityBundle(intent, options(artifacts, bytes))).rejects.toMatchObject({ problem: 'incompatible-package' })
  })

  it('rejects root bundled declaration changes across an otherwise valid isolated adaptation', async () => {
    const { artifacts } = await fixture(), bytes = bundledZip()
    await expect(prepareCommunityBundle(intent, { ...options(artifacts, bytes), adaptation: {
      apiKey: 'fixture-key', harnessVersion: '0.2.1-alpha.1', force: true, limits: { maxAttempts: 1 },
      fetch: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ files: [{ path: 'package.json', content: JSON.stringify({ ...manifest, dependencies: { '@fixture/one': '^1.0.0' }, bundledDependencies: ['@fixture/one'] }) }], summary: 'Keep existing fixture behavior' }) } }] }),
    } })).rejects.toThrow('Bundled dependency contents or declarations changed')
    await expect(readdir(join(artifacts, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(artifacts, 'originals'))).toHaveLength(1)
  })

  it('does not publish a bundled package when cancellation arrives before packaging', async () => {
    const { root, artifacts } = await fixture(), controller = new AbortController(), installed = join(root, 'installed')
    await writeFile(installed, 'previous environment')
    await expect(prepareCommunityBundle(intent, { ...options(artifacts, bundledZip()), signal: controller.signal,
      onProgress: (progress) => { if (progress.phase === 'packaging') controller.abort() },
    })).rejects.toMatchObject({ problem: 'cancelled' })
    expect(await readFile(installed, 'utf8')).toBe('previous environment')
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('counts bundled files toward extraction limits', async () => {
    const { artifacts } = await fixture(), bytes = bundledZip({ 'package/node_modules/@fixture/one/large': 'x'.repeat(2048) })
    await expect(prepareCommunityBundle(intent, { ...options(artifacts, bytes), limits: { maxExtractedBytes: 1024 } })).rejects.toMatchObject({ problem: 'too-large' })
  })

  it.each(['SymbolicLink', 'Link'] as const)('refuses bundled tar %s entries', async (type) => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, options(artifacts, tarEntry('package/node_modules/@fixture/one/link', type)))).rejects.toMatchObject({ problem: 'invalid-archive' })
  })
})

describe('community bundle preparation', () => {
  it('publishes an immutable npm tarball using manifest identity without touching installed files', async () => {
    const { root, artifacts } = await fixture()
    const installed = join(root, 'installed.js')
    await writeFile(installed, 'previous installation')
    const result = await prepareCommunityBundle(intent, options(artifacts))
    expect(result).toMatchObject({ packageName: manifest.name, version: manifest.version, bundle: manifest.name })
    expect(result.spec).toMatch(/[\\/]v1[\\/][a-f0-9]{64}\.tgz$/u)
    const files: string[] = []
    await listTar({ file: result.spec, onReadEntry: (entry) => { files.push(entry.path) } })
    expect(files).toContain('package/package.json')
    expect(files).toContain('package/lib/index.js')
    expect(await readFile(installed, 'utf8')).toBe('previous installation')
    expect(await readdir(join(artifacts, 'v1'))).toHaveLength(1)
  })

  it('shares a complete content-addressed artifact between overlapping preparations', async () => {
    const { artifacts } = await fixture()
    const [first, second] = await Promise.all([
      prepareCommunityBundle(intent, options(artifacts)), prepareCommunityBundle(intent, options(artifacts)),
    ])
    expect(first.spec).toBe(second.spec)
    expect(await readdir(join(artifacts, 'v1'))).toHaveLength(1)
  })

  it('omits tracked dependencies and repository metadata from a canonical GitHub ZIP while retaining the original and real plugin source', async () => {
    const { root, artifacts } = await fixture()
    const feature = 'export function double(value) { return value * 2 }\n'
    const bytes = zip({ 'package/lib/index.js': feature, 'package/src/feature.ts': 'export const feature = 42\n',
      'package/node_modules/stale/index.js': 'throw new Error("Tracked dependency must never execute")',
      'package/.git/config': 'local repository metadata', 'package/.github/workflows/ci.yml': 'workflow metadata',
      'package/.gitignore': 'node_modules\n', 'package/.gitattributes': '*.js text\n', 'package/.gitmodules': 'submodule metadata' })
    const result = await prepareCommunityBundle(sourceIntent, options(artifacts, bytes))
    expect(result.repositoryArchive).toBe(true)
    expect(result.originalSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.originalSpec).toBeDefined()
    if (result.originalSpec === undefined) throw new Error('Expected retained source archive')
    expect(await readFile(result.originalSpec)).toEqual(Buffer.from(bytes))
    const candidate = join(root, 'candidate')
    await mkdir(candidate)
    await extractTar({ file: result.spec, cwd: candidate })
    expect(await readFile(join(candidate, 'package/lib/index.js'), 'utf8')).toBe(feature)
    expect(await readFile(join(candidate, 'package/src/feature.ts'), 'utf8')).toBe('export const feature = 42\n')
    const names: string[] = []
    await listTar({ file: result.spec, onReadEntry: entry => { names.push(entry.path) } })
    expect(names.some(name => /node_modules|\.git/u.test(name))).toBe(false)
  })

  it('preserves GitHub source classification for an immutable-original retry without downloading again', async () => {
    const { artifacts } = await fixture()
    const bytes = zip({ 'package/node_modules/stale/index.js': 'tracked dependency' })
    const first = await prepareCommunityBundle(sourceIntent, options(artifacts, bytes))
    if (first.originalSpec === undefined || first.originalSha256 === undefined || first.repositoryArchive !== true) {
      throw new Error('Expected retained GitHub source archive')
    }
    let requests = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts,
      originalArchive: { spec: first.originalSpec, sha256: first.originalSha256, repositoryArchive: first.repositoryArchive },
      adaptation: { harnessVersion: '0.2.1-alpha.1', apiKey: '', force: true },
      fetch: async () => { requests++; throw new Error('Retry must reuse immutable bytes') },
    })).rejects.toMatchObject({ problem: 'adaptation-key-required' })
    expect(requests).toBe(0)
  })

  it.each([
    'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
    'https://codeload.github.com.evil.example/example/addon/zip/refs/heads/main',
    'https://codeload.github.com/example/addon/releases/download/main.zip',
  ])('retains strict package refusal when the final source is not a canonical GitHub archive: %s', async downloadUrl => {
    const { artifacts } = await fixture()
    const bytes = zip({ 'package/node_modules/stale/index.js': 'tracked dependency' })
    await expect(prepareCommunityBundle({ ...intent, downloadUrl }, options(artifacts, bytes)))
      .rejects.toMatchObject({ problem: 'incompatible-package' })
  })

  it('classifies the actual final redirect rather than the initial GitHub URL or an untrusted archive header', async () => {
    const { artifacts } = await fixture()
    let requests = 0
    await expect(prepareCommunityBundle(sourceIntent, { artifactDirectory: artifacts, fetch: async () => {
      if (++requests === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/source.zip' } })
      return new Response(new Uint8Array(zip({ 'package/node_modules/stale/index.js': 'tracked dependency' })),
        { headers: { 'x-repository-archive': 'true' } })
    } })).rejects.toMatchObject({ problem: 'incompatible-package' })
    expect(requests).toBe(2)
  })

  it.each([
    { path: 'package/node_modules/../escape.js', problem: 'invalid-archive' },
    { path: 'package/node_modules/CON.js', problem: 'invalid-archive' },
    { path: 'package/.git/../escape.js', problem: 'invalid-archive' },
  ])('validates an ignored repository path before skipping it: $path', async ({ path, problem }) => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(sourceIntent, options(artifacts, zip({ [path]: 'must remain ignored' }))))
      .rejects.toMatchObject({ problem })
  })

  it.each(['bytes', 'entries'])('counts skipped repository files toward expanded %s limits', async kind => {
    const { artifacts } = await fixture()
    const bytes = zip({ 'package/node_modules/large/index.js': 'x'.repeat(2_048), 'package/.git/config': 'metadata' })
    await expect(prepareCommunityBundle(sourceIntent, { ...options(artifacts, bytes),
      limits: kind === 'bytes' ? { maxExtractedBytes: 1_024 } : { maxEntries: 3 },
    })).rejects.toMatchObject({ problem: 'too-large' })
  })

  it('rejects duplicate skipped metadata entries instead of bypassing duplicate validation', async () => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(sourceIntent, options(artifacts, zip({
      'package/.git/config': 'first', 'package/.GIT/config': 'second',
    })))).rejects.toMatchObject({ problem: 'invalid-archive' })
  })

  it('closes a canonical source ZIP when cancellation arrives before extraction', async () => {
    const { artifacts } = await fixture(), controller = new AbortController()
    await expect(prepareCommunityBundle(sourceIntent, { ...options(artifacts), signal: controller.signal,
      onProgress: progress => { if (progress.phase === 'validating') controller.abort() },
    })).rejects.toMatchObject({ problem: 'cancelled' })
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('filters a canonical source tgz after validating every tar entry and preserves its compiled source', async () => {
    const { root, artifacts } = await fixture(), source = join(root, 'source')
    await mkdir(join(source, 'lib'), { recursive: true })
    await mkdir(join(source, 'node_modules', 'stale'), { recursive: true })
    await mkdir(join(source, '.git'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(source, 'cordis.patch.yml'), '- insert: []\n')
    await writeFile(join(source, 'lib/index.js'), 'export const feature = 42\n')
    await writeFile(join(source, 'node_modules/stale/index.js'), 'tracked dependency')
    await writeFile(join(source, '.git/config'), 'metadata')
    const archive = join(root, 'source.tgz')
    await createTar({ cwd: source, file: archive, gzip: true, prefix: 'package/' }, ['.'])
    const prepared = await prepareCommunityBundle({ ...intent,
      downloadUrl: 'https://codeload.github.com/example/community-addon/tar.gz/refs/heads/main',
    }, options(artifacts, new Uint8Array(await readFile(archive))))
    const names: string[] = []
    await listTar({ file: prepared.spec, onReadEntry: entry => { names.push(entry.path) } })
    expect(names).toContain('package/lib/index.js')
    expect(names.some(name => /node_modules|\.git/u.test(name))).toBe(false)
  })

  it('rejects a symbolic link in skipped repository dependencies', async () => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle({ ...sourceIntent,
      downloadUrl: 'https://codeload.github.com/example/community-addon/tar.gz/refs/heads/main',
    }, options(artifacts, tarEntry('package/node_modules/link', 'SymbolicLink'))))
      .rejects.toMatchObject({ problem: 'invalid-archive' })
  })

  it('accepts standard tgz packages and inert !!js configuration without changing source', async () => {
    const { root, artifacts } = await fixture()
    const source = join(root, 'source')
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify(manifest))
    const patch = '- insert:\n    - id: addon\n      name: "@example/community-addon"\n      config:\n        endpoint: !!js process.env.COMMUNITY_ENDPOINT\n'
    await writeFile(join(source, 'cordis.patch.yml'), patch)
    await writeFile(join(source, 'lib/index.js'), 'export default function plugin() {}\n')
    const archive = join(root, 'source.tgz')
    await createTar({ cwd: source, file: archive, gzip: true, prefix: 'package/' }, ['.'])
    const prepared = await prepareCommunityBundle(intent, options(artifacts, new Uint8Array(await readFile(archive))))
    expect(prepared.packageName).toBe(manifest.name)
    expect(await readFile(join(source, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('strips saved credentials permanently after a cross-origin redirect', async () => {
    const { artifacts } = await fixture()
    const requests: { url: string; authorization: string | null; cookie: string | null }[] = []
    const bytes = zip()
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, authorization: headers.get('authorization'), cookie: headers.get('cookie') })
      if (requests.length === 1) return new Response(null, { status: 302, headers: { location: '/download-next' } })
      if (requests.length === 2) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/package.zip' } })
      if (requests.length === 3) return new Response(null, { status: 302, headers: { location: 'https://deepseek.stream/download-final' } })
      return new Response(new Uint8Array(bytes))
    }
    await prepareCommunityBundle(intent, { artifactDirectory: artifacts, token: 'fixture-account-token', fetch: withMetadata(fetcher, bytes) })
    expect(requests.slice(0, 2).every(request => request.authorization === 'Bearer fixture-account-token')).toBe(true)
    expect(requests.slice(2).every(request => request.authorization === null && request.cookie === null)).toBe(true)
  })

  it('does not send saved account credentials to an explicit third-party source', async () => {
    const { artifacts } = await fixture()
    await prepareCommunityBundle({ ...intent, downloadUrl: 'https://example.com/plugin.zip' }, {
      artifactDirectory: artifacts, token: 'fixture-account-token', fetch: async (_input, init) => {
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        expect(new Headers(init?.headers).has('cookie')).toBe(false)
        return new Response(new Uint8Array(zip()))
      },
    })
  })

  it('reports HTTP 401 as an account action', async () => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts, fetch: async () => new Response(null, { status: 401 }) }))
      .rejects.toMatchObject({ problem: 'authentication-required', statusCode: 401 })
  })

  it.each([
    { body: JSON.stringify({ needUnlock: true }), problem: 'plugin-unlock-required' },
    { body: JSON.stringify({ error: 'forbidden' }), problem: 'download-forbidden' },
    { body: 'permission denied', problem: 'download-forbidden' },
    { body: 'x'.repeat(9_000), problem: 'download-forbidden' },
  ])('keeps HTTP 403 separate from sign-in: $problem', async ({ body, problem }) => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts, fetch: async () => new Response(body, { status: 403 }) }))
      .rejects.toMatchObject({ problem, statusCode: 403 })
  })

  it('bounds redirect loops', async () => {
    const { artifacts } = await fixture()
    let calls = 0
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts, limits: { maxRedirects: 2 }, fetch: withMetadata(async () => {
      calls++
      return new Response(null, { status: 302, headers: { location: '/again' } })
    }) })).rejects.toMatchObject({ problem: 'download-failed' })
    expect(calls).toBe(3)
  })

  it.each(['declared', 'streamed'])('enforces the %s download byte limit', async (kind) => {
    const { artifacts } = await fixture()
    const bytes = zip()
    await expect(prepareCommunityBundle({ ...intent, downloadUrl: 'https://example.com/limited.zip' }, {
      artifactDirectory: artifacts, limits: { maxDownloadBytes: 8 },
      fetch: async () => new Response(new Uint8Array(bytes), kind === 'declared' ? { headers: { 'content-length': String(bytes.length) } } : {}),
    })).rejects.toMatchObject({ problem: 'too-large' })
  })

  it('cancels and closes the response stream before rejecting', async () => {
    const { artifacts } = await fixture()
    const controller = new AbortController()
    let streamClosed = false
    const stream = new ReadableStream<Uint8Array>({
      start(owner) { owner.enqueue(strToU8('partial archive')) },
      cancel() { streamClosed = true },
    })
    await expect(prepareCommunityBundle(intent, {
      artifactDirectory: artifacts, signal: controller.signal, fetch: withMetadata(async () => new Response(stream)),
      onProgress: (progress) => { if ((progress.receivedBytes ?? 0) > 0) controller.abort() },
    })).rejects.toMatchObject({ problem: 'cancelled' })
    expect(streamClosed).toBe(true)
  })

  it('times out an unresponsive request through its own AbortSignal', async () => {
    const { artifacts } = await fixture()
    const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>{  reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts, fetch: fetcher, limits: { timeoutMs: 5 } }))
      .rejects.toMatchObject({ problem: 'timeout' })
  })

  it.each([
    { label: 'traversal', files: { '../escape.js': 'bad' }, problem: 'invalid-archive' },
    { label: 'Windows path alias', files: { 'package/CON.js': 'bad' }, problem: 'invalid-archive' },
    { label: 'case-folded duplicate', files: { 'package/LIB/index.js': 'bad' }, problem: 'invalid-archive' },
    { label: 'undeclared node_modules', files: { 'package/node_modules/other/index.js': 'bad' }, problem: 'incompatible-package' },
    { label: 'multiple package roots', files: { 'other/package.json': '{}' }, problem: 'incompatible-package' },
    { label: 'malformed patch', files: { 'package/cordis.patch.yml': '[invalid' }, problem: 'incompatible-package' },
  ])('refuses $label', async ({ files, problem }) => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, options(artifacts, zip(files)))).rejects.toMatchObject({ problem })
  })

  it.each([
    { ...manifest, name: '../plugin' },
    { ...manifest, version: 'latest' },
    { ...manifest, dsh: {} },
    { ...manifest, dsh: { bundle: { patch: '../../outside.yml' } } },
    { ...manifest, exports: { '.': './src/index.ts' } },
    { ...manifest, exports: { '.': './missing.js' } },
  ])('refuses an incompatible package manifest: %j', async (metadata) => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, options(artifacts, zip({}, metadata)))).rejects.toMatchObject({ problem: 'incompatible-package' })
  })

  it('rejects a mismatched selected version', async () => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle({ ...intent, version: '9.0.0', downloadUrl: 'https://example.com/versioned.zip' }, options(artifacts)))
      .rejects.toMatchObject({ problem: 'incompatible-package' })
  })

  it('bounds expanded archive bytes independently of compressed size', async () => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, { ...options(artifacts), limits: { maxExtractedBytes: 10 } }))
      .rejects.toMatchObject({ problem: 'too-large' })
  })

  it.each([
    { path: '../outside', type: 'File' as const, data: 'unsafe path', problem: 'invalid-archive' },
    { path: 'package/link', type: 'SymbolicLink' as const, data: '', problem: 'invalid-archive' },
    { path: 'package/link', type: 'Link' as const, data: '', problem: 'invalid-archive' },
    { path: 'package/large', type: 'File' as const, data: 'x'.repeat(1024), problem: 'too-large' },
  ])('rejects tar $type entries at $path without an unhandled stream exception', async ({ path, type, data, problem }) => {
    const { artifacts } = await fixture()
    await expect(prepareCommunityBundle(intent, { ...options(artifacts, tarEntry(path, type, data)), limits: { maxExtractedBytes: 128 } }))
      .rejects.toMatchObject({ problem })
  })

  it('does not publish a package when cancelled after validation', async () => {
    const { artifacts } = await fixture()
    const controller = new AbortController()
    await expect(prepareCommunityBundle(intent, {
      ...options(artifacts), signal: controller.signal,
      onProgress: (progress) => { if (progress.phase === 'packaging') controller.abort() },
    })).rejects.toMatchObject({ problem: 'cancelled' })
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('first-party immutable release selection', () => {
  it.each([true, false, null, {}, { kind: 'author-application', docsUrl: 'https://private.invalid/?token=secret', reason: 'private-author-command' }])('rejects an explicit external installation boundary before artifact or model requests: %j', async (installationBoundary) => {
    const { root, artifacts } = await fixture()
    const request = vi.fn<typeof fetch>(async () => Response.json({ plugin: { id: intent.id, version: '1.0.0', status: 'published', installationBoundary } }))
    const model = vi.fn<typeof fetch>()
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts, fetch: request,
      adaptation: { apiKey: 'fixture-key', harnessVersion: '0.2.1-alpha.1', fetch: model },
    })).rejects.toMatchObject({ problem: 'external-installation-required' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(model).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('reports manual installation before requiring an automatic artifact, downloading bytes or calling a model', async () => {
    const { root, artifacts } = await fixture()
    const requests: string[] = []
    let modelCalls = 0
    await expect(prepareCommunityBundle(intent, { artifactDirectory: artifacts,
      adaptation: { apiKey: 'fixture-key', harnessVersion: '0.2.1-alpha.1', fetch: async () => { modelCalls++; throw new Error('No model for manual installation') } },
      fetch: async (input) => {
        requests.push(new URL(String(input)).pathname)
        return Response.json({ plugin: { id: intent.id, version: '1.0.0', status: 'published',
          manualDistribution: { kind: 'github-release', installMethod: 'author-script', platform: 'windows-x64', bytes: 1_073_741_824 } } })
      },
    })).rejects.toMatchObject({ problem: 'manual-install-required', message: expect.stringContaining('community detail page') })
    expect(requests).toEqual(['/api/plugins/addon'])
    expect(modelCalls).toBe(0)
    expect(await readdir(root)).toEqual([])
  })

  const legacyIntent = { id: 'dsh-voice-wake-1-1-0', name: 'Voice wake', version: '1.0.1', repo: '' }
  const packageManifest = { ...manifest, name: 'dsh-voice-wake', version: '1.27.0' }
  const packageZip = (): Uint8Array => zip({ 'package/cordis.patch.yml': '- insert:\n    - id: voice-wake\n      name: dsh-voice-wake\n' }, packageManifest)
  function metadata(bytes: Uint8Array, artifactChanges: Record<string, unknown> = {}, pluginChanges: Record<string, unknown> = {}): Response {
    return Response.json({ plugin: { ...legacyIntent, status: 'published', installVerification: { artifact: {
      packageVersion: legacyIntent.version, sourceVersion: packageManifest.version, packageName: packageManifest.name,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'zip', ...artifactChanges,
    } }, ...pluginChanges } })
  }

  it('keeps the old catalogue selector while validating the recorded voice-wake 1.27.0 archive without a model call', async () => {
    const { artifacts } = await fixture(), bytes = packageZip()
    const requests: string[] = []
    let modelCalls = 0
    const result = await prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts, token: 'fixture-account-token',
      adaptation: { apiKey: 'fixture-official-key', harnessVersion: '0.2.1-alpha.1', fetch: async () => { modelCalls++; throw new Error('Native release must not call a model') } },
      fetch: async (input, init) => {
        const url = new URL(String(input)), headers = new Headers(init?.headers)
        requests.push(url.pathname)
        if (url.pathname === `/api/plugins/${legacyIntent.id}`) {
          expect(headers.has('authorization') || headers.has('cookie')).toBe(false)
          expect(init?.redirect).toBe('error')
          return metadata(bytes)
        }
        expect(url.searchParams.get('id')).toBe(legacyIntent.id)
        expect(url.searchParams.get('version')).toBe('1.0.1')
        expect(url.searchParams.get('sha256')).toBe(createHash('sha256').update(bytes).digest('hex'))
        expect(headers.get('cookie')).toBe('deepseek_hub_auth_token=fixture-account-token')
        return new Response(new Uint8Array(bytes))
      } })
    expect(result).toMatchObject({ packageName: 'dsh-voice-wake', version: '1.27.0', adapted: false })
    expect(modelCalls).toBe(0)
    expect(requests).toEqual([`/api/plugins/${legacyIntent.id}`, '/api/plugins/download'])
  })

  it('refuses a changed catalogue release before downloading or adapting it', async () => {
    const { artifacts } = await fixture(), bytes = packageZip()
    let downloads = 0
    await expect(prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts, fetch: async input => {
      if (new URL(String(input)).pathname === `/api/plugins/${legacyIntent.id}`) {
        return metadata(bytes, { packageVersion: '1.0.2' }, { version: '1.0.2' })
      }
      downloads++
      return new Response(new Uint8Array(bytes))
    } })).rejects.toMatchObject({ problem: 'download-failed', statusCode: 409 })
    expect(downloads).toBe(0)
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { sha256: 'a'.repeat(64) },
    { bytes: 1 },
    { format: 'tgz' },
  ])('refuses bytes inconsistent with immutable metadata without invoking a model: %j', async changes => {
    const { artifacts } = await fixture(), bytes = packageZip()
    let modelCalls = 0
    await expect(prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts,
      adaptation: { apiKey: 'fixture-official-key', harnessVersion: '0.2.1-alpha.1', fetch: async () => { modelCalls++; throw new Error('Checksum errors are not adaptable') } },
      fetch: async input => new URL(String(input)).pathname === `/api/plugins/${legacyIntent.id}`
        ? metadata(bytes, changes) : new Response(new Uint8Array(bytes)),
    })).rejects.toMatchObject({ problem: 'invalid-archive' })
    expect(modelCalls).toBe(0)
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([{ sourceVersion: '1.27.1' }, { packageName: 'other-plugin' }])('refuses a manifest that differs from the recorded release without AI renaming: %j', async changes => {
    const { artifacts } = await fixture(), bytes = packageZip()
    let modelCalls = 0
    await expect(prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts,
      adaptation: { apiKey: 'fixture-official-key', harnessVersion: '0.2.1-alpha.1', fetch: async () => { modelCalls++; throw new Error('Identity errors are not adaptable') } },
      fetch: async input => new URL(String(input)).pathname === `/api/plugins/${legacyIntent.id}`
        ? metadata(bytes, changes) : new Response(new Uint8Array(bytes)),
    })).rejects.toMatchObject({ problem: 'incompatible-package' })
    expect(modelCalls).toBe(0)
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { sha256: undefined }, { bytes: undefined }, { format: 'rar' }, { packageVersion: '9.0.0' },
    { sourceVersion: 'latest' }, { packageName: '../other-plugin' },
  ])('requires complete, exact first-party release metadata: %j', async changes => {
    const { artifacts } = await fixture(), bytes = packageZip()
    let downloads = 0
    await expect(prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts, fetch: async input => {
      if (new URL(String(input)).pathname === `/api/plugins/${legacyIntent.id}`) return metadata(bytes, changes)
      downloads++
      return new Response(new Uint8Array(bytes))
    } })).rejects.toMatchObject({ problem: 'download-failed' })
    expect(downloads).toBe(0)
  })

  it('refuses latest without a recorded exact source release', async () => {
    const { artifacts } = await fixture(), bytes = packageZip()
    await expect(prepareCommunityBundle({ ...legacyIntent, version: 'latest' }, { artifactDirectory: artifacts,
      fetch: async () => metadata(bytes, { packageVersion: 'latest', sourceVersion: undefined }, { version: 'latest' }),
    })).rejects.toMatchObject({ problem: 'download-failed', message: expect.stringContaining('exact package version') })
  })

  it.each([{ id: 'other-plugin' }, { status: 'unlisted' }])('refuses metadata for a different or unpublished listing: %j', async changes => {
    const { artifacts } = await fixture(), bytes = packageZip()
    await expect(prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts,
      fetch: async () => metadata(bytes, {}, changes),
    })).rejects.toMatchObject({ problem: 'download-failed' })
  })

  it('accepts a frozen TGZ selector with the recorded source identity and exact digest', async () => {
    const { root, artifacts } = await fixture(), source = join(root, 'source')
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify(packageManifest))
    await writeFile(join(source, 'lib/index.js'), 'export default function plugin() {}\n')
    await writeFile(join(source, 'cordis.patch.yml'), '- insert: []\n')
    const archive = join(root, 'source.tgz')
    await createTar({ cwd: source, file: archive, gzip: true, prefix: 'package/' }, ['.'])
    const bytes = new Uint8Array(await readFile(archive)), sha256 = createHash('sha256').update(bytes).digest('hex')
    const downloadUrl = `https://www.deepseek.stream/api/plugins/artifacts/${legacyIntent.id}/${legacyIntent.version}/${sha256}.tgz`
    const result = await prepareCommunityBundle({ ...legacyIntent, version: packageManifest.version, downloadUrl }, {
      artifactDirectory: artifacts, fetch: async input => new URL(String(input)).pathname === `/api/plugins/${legacyIntent.id}`
        ? metadata(bytes, { format: 'tgz' }) : new Response(new Uint8Array(bytes)),
    })
    expect(result).toMatchObject({ packageName: packageManifest.name, version: packageManifest.version, originalSha256: sha256 })
  })

  it('preserves a paid signed download URL on www without sending account credentials there', async () => {
    const { artifacts } = await fixture(), bytes = packageZip()
    const downloadUrl = `https://www.deepseek.stream/api/plugins/install-artifact/${'f'.repeat(64)}`
    let downloads = 0
    const result = await prepareCommunityBundle({ ...legacyIntent, version: packageManifest.version, downloadUrl }, {
      artifactDirectory: artifacts, token: 'fixture-account-token', fetch: async (input, init) => {
        const url = new URL(String(input))
        expect(new Headers(init?.headers).has('authorization') || new Headers(init?.headers).has('cookie')).toBe(false)
        if (url.pathname === `/api/plugins/${legacyIntent.id}`) return metadata(bytes, {}, { price: 50 })
        expect(url.href).toBe(downloadUrl)
        downloads++
        return new Response(new Uint8Array(bytes))
      },
    })
    expect(result.version).toBe(packageManifest.version)
    expect(downloads).toBe(1)
  })

  it('refuses a signed-link version that differs from the recorded source version', async () => {
    const { artifacts } = await fixture(), bytes = packageZip()
    let downloads = 0
    await expect(prepareCommunityBundle({ ...legacyIntent,
      downloadUrl: `https://deepseek.stream/api/plugins/install-artifact/${'f'.repeat(64)}` }, {
      artifactDirectory: artifacts, fetch: async input => {
        if (new URL(String(input)).pathname === `/api/plugins/${legacyIntent.id}`) return metadata(bytes)
        downloads++
        return new Response(new Uint8Array(bytes))
      },
    })).rejects.toMatchObject({ problem: 'invalid-intent' })
    expect(downloads).toBe(0)
  })

  it.each(['other-plugin', 'dsh-voice-wake-1-1-0'])('binds explicit download selectors to the current catalogue: %s', async selectedId => {
    const { artifacts } = await fixture(), bytes = packageZip()
    const version = selectedId === legacyIntent.id ? '1.0.2' : legacyIntent.version
    await expect(prepareCommunityBundle({ ...legacyIntent, version: packageManifest.version,
      downloadUrl: `https://deepseek.stream/api/plugins/download?id=${selectedId}&version=${version}` }, {
      artifactDirectory: artifacts, fetch: async () => metadata(bytes),
    })).rejects.toMatchObject({ problem: 'invalid-intent' })
  })

  it('times out metadata acquisition without allocating or publishing an archive', async () => {
    const { artifacts } = await fixture()
    let settled = false
    const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        settled = true
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
    await expect(prepareCommunityBundle(legacyIntent, { artifactDirectory: artifacts, fetch: fetcher, limits: { timeoutMs: 5 } }))
      .rejects.toMatchObject({ problem: 'timeout', message: expect.stringContaining('metadata timed out') })
    expect(settled).toBe(true)
    await expect(readdir(artifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { label: 'foreign redirect', response: () => new Response(null, { status: 302, headers: { location: 'https://foreign.example/metadata' } }) },
    { label: 'invalid content type', response: () => new Response('not JSON', { headers: { 'content-type': 'text/plain' } }) },
  ])('refuses $label metadata without exposing a signed URL', async supplied => {
    const { artifacts } = await fixture()
    const token = 'f'.repeat(64)
    await expect(prepareCommunityBundle({ ...legacyIntent, version: packageManifest.version,
      downloadUrl: `https://deepseek.stream/api/plugins/install-artifact/${token}` }, {
      artifactDirectory: artifacts, fetch: async () => supplied.response(),
    })).rejects.toMatchObject({ problem: 'download-failed', message: expect.not.stringContaining(token) })
  })
})
