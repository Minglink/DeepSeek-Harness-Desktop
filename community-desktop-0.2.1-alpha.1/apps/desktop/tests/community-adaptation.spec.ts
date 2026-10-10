/** Model adaptation fixtures use private package copies and instance-local fake official API responses. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { extract as extractTar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareCommunityBundle, type CommunityInstallOptions } from '../src/community-install.ts'
import type { CommunityAdaptationOptions } from '../src/community-adaptation.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const intent = { id: 'adapter-test', name: 'Fixture addon', version: '1.2.3', repo: '' }
const identity = { name: '@example/adapter-test', version: '1.2.3', type: 'module', main: './src/index.ts' }
const nativeManifest = { ...identity, main: './lib/index.js', exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }
const source = 'export function apply(ctx: { on: (name: string, fn: () => string) => void }) { ctx.on("fixture/event", () => "feature"); }\n'
const patch = '- insert:\n    - id: adapter-test\n      name: "@example/adapter-test"\n'

function archive(metadata: object = identity, files: Record<string, string> = {}): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries({ 'package/package.json': JSON.stringify(metadata), 'package/src/index.ts': source, ...files })
    .map(([path, text]) => [path, strToU8(text)])))
}

async function fixture(): Promise<{ root: string; artifactDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-adapter-fixture-'))
  roots.push(root)
  return { root, artifactDirectory: join(root, 'artifacts') }
}

function response(files: { path: string; content: string }[]): Response {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ files, summary: 'Adapt real feature registration' }) } }] })
}

function validPatch(): { path: string; content: string }[] {
  return [
    { path: 'package.json', content: JSON.stringify(nativeManifest) },
    { path: 'cordis.patch.yml', content: patch },
    { path: 'lib/index.ts', content: source },
  ]
}

/** First-party fixtures bind the immutable original before the official model receives an extracted candidate. */
function withMetadata(bytes: Uint8Array, fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === 'https://deepseek.stream' && url.pathname === `/api/plugins/${intent.id}`) {
      expect(new Headers(init?.headers).has('authorization') || new Headers(init?.headers).has('cookie')).toBe(false)
      return Response.json({ plugin: { id: intent.id, version: intent.version, status: 'published', installVerification: {
        artifact: { packageVersion: intent.version, sourceVersion: identity.version, packageName: identity.name,
          sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'zip' },
      } } })
    }
    return fetcher(input, init)
  }
}

function options(artifactDirectory: string, bytes: Uint8Array, adaptation: Partial<CommunityAdaptationOptions> = {}): CommunityInstallOptions {
  return {
    artifactDirectory,
    fetch: withMetadata(bytes, async () => new Response(new Uint8Array(bytes))),
    adaptation: { apiKey: 'fixture-official-key', harnessVersion: '0.2.1-alpha.1', limits: { maxAttempts: 1 }, fetch: async () => response(validPatch()), ...adaptation },
  }
}

describe('official community plugin adaptation', () => {
  it('calls only official Flash, preserves original bytes, compiles candidate TypeScript and logs credential-free model context', async () => {
    const { root, artifactDirectory } = await fixture()
    const bytes = archive(identity, { 'package/.env': 'API_KEY="fixture-embedded-secret"', 'package/config.json': '{"apiKey":"fixture-embedded-secret"}' })
    const phases: string[] = []
    let requestBody = ''
    const result = await prepareCommunityBundle(intent, {
      ...options(artifactDirectory, bytes, { fetch: async (input, init) => {
        expect(String(input)).toBe('https://api.deepseek.com/chat/completions')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-official-key')
        expect(new Headers(init?.headers).has('cookie')).toBe(false)
        requestBody = String(init?.body)
        expect(JSON.parse(requestBody).model).toBe('deepseek-flash')
        expect(requestBody).toContain('Context.inject')
        expect(requestBody).toContain('ctx.tools.register')
        expect(requestBody).toContain('__ModuleLoader__')
        expect(requestBody).not.toContain('fixture-embedded-secret')
        expect(requestBody).not.toContain('.env')
        return response(validPatch())
      } }), onProgress: progress => phases.push(progress.phase),
    })
    expect(result.adapted).toBe(true)
    expect(result.originalSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await readFile(result.originalSpec!)).toEqual(Buffer.from(bytes))
    const transcript = await readFile(result.adaptationTranscript!, 'utf8')
    expect(transcript).toContain('deepseek-flash')
    expect(transcript).not.toContain('fixture-official-key')
    expect(transcript).not.toContain('fixture-embedded-secret')
    expect(JSON.parse(transcript).attempts[0].request.messages[1].content).toBe(JSON.parse(requestBody).messages[1].content)
    const { mkdir } = await import('node:fs/promises')
    const unpacked = join(root, 'prepared')
    await mkdir(unpacked)
    await extractTar({ file: result.spec, cwd: unpacked })
    expect(await readFile(join(unpacked, 'package/lib/index.js'), 'utf8')).toContain('fixture/event')
    expect(await readFile(join(unpacked, 'package/src/index.ts'), 'utf8')).toBe(source)
    expect(phases).toEqual(['downloading', 'downloading', 'validating', 'adapting', 'validating', 'packaging', 'prepared'])
  })

  it('keeps native bundles on the zero-model fast path', async () => {
    const { artifactDirectory } = await fixture()
    let modelCalls = 0
    const result = await prepareCommunityBundle(intent, options(artifactDirectory,
      archive(nativeManifest, { 'package/lib/index.js': 'export function apply(ctx) { ctx.on("fixture/event", () => "feature") }', 'package/cordis.patch.yml': patch }),
      { apiKey: '', fetch: async () => { modelCalls++; throw new Error('Native package must not call model') } }))
    expect(result.adapted).toBe(false)
    expect(modelCalls).toBe(0)
    expect(result.adaptationTranscript).toBeUndefined()
  })

  it('requires a local official key for incompatible packages without touching a live profile', async () => {
    const { artifactDirectory } = await fixture()
    let calls = 0
    await expect(prepareCommunityBundle(intent, options(artifactDirectory, archive(), {
      apiKey: '', fetch: async () => { calls++; return response(validPatch()) },
    }))).rejects.toMatchObject({ problem: 'adaptation-key-required' })
    expect(calls).toBe(0)
    expect(await readdir(join(artifactDirectory, 'originals'))).toHaveLength(1)
    await expect(readdir(join(artifactDirectory, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { label: 'traversal', file: { path: '../outside.js', content: 'bad' } },
    { label: 'absolute path', file: { path: 'C:/outside.js', content: 'bad' } },
    { label: 'script', file: { path: 'install.ps1', content: 'bad' } },
    { label: 'credential file', file: { path: 'tokens.json', content: '{}' } },
    { label: 'changed identity', file: { path: 'package.json', content: JSON.stringify({ ...nativeManifest, name: 'other-package' }) } },
    { label: 'installation script', file: { path: 'package.json', content: JSON.stringify({ ...nativeManifest, scripts: { postinstall: 'node install.js' } }) } },
    { label: 'syntax', file: { path: 'lib/index.js', content: 'export function {' } },
    { label: 'credential echo', file: { path: 'lib/index.js', content: 'export const key = "fixture-official-key"' } },
  ])('rejects $label before publishing the candidate', async ({ file }) => {
    const { root, artifactDirectory } = await fixture()
    await expect(prepareCommunityBundle(intent, options(artifactDirectory, archive(), { fetch: async () => response([file]) })))
      .rejects.toMatchObject({ problem: 'adaptation-failed' })
    await expect(readdir(join(artifactDirectory, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(root, 'outside.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    const paths = await readdir(join(artifactDirectory, 'adaptation'))
    expect(paths).toHaveLength(1)
    expect(await readFile(join(artifactDirectory, 'adaptation', paths[0]!), 'utf8')).not.toContain('fixture-official-key')
  })

  it('uses a bounded retry with native validation diagnostics and retains every model exchange', async () => {
    const { artifactDirectory } = await fixture()
    let calls = 0
    const result = await prepareCommunityBundle(intent, options(artifactDirectory, archive(), {
      limits: { maxAttempts: 2 }, fetch: async (_input, init) => {
        calls++
        if (calls === 1) return response([{ path: 'package.json', content: JSON.stringify(nativeManifest) }])
        expect(String(init?.body)).toContain('declared dsh.bundle patch is missing')
        return response(validPatch())
      },
    }))
    expect(calls).toBe(2)
    expect(JSON.parse(await readFile(result.adaptationTranscript!, 'utf8')).attempts).toHaveLength(2)
  })

  it('reuses checksum-verified immutable original bytes for a native package trial retry', async () => {
    const { artifactDirectory } = await fixture()
    const bytes = archive(nativeManifest, {
      'package/lib/index.js': 'export function apply(ctx) { ctx.on("fixture/event", () => "feature") }', 'package/cordis.patch.yml': patch,
    })
    const first = await prepareCommunityBundle(intent, options(artifactDirectory, bytes))
    const next = options(artifactDirectory, bytes, { force: true, diagnostic: 'Trial registration failure' })
    next.originalArchive = { spec: first.originalSpec!, sha256: first.originalSha256! }
    next.fetch = withMetadata(bytes, async () => { throw new Error('Must not redownload') })
    const second = await prepareCommunityBundle(intent, next)
    expect(second.adapted).toBe(true)
    expect(second.originalSha256).toBe(first.originalSha256)
    expect(second.originalSpec).toBe(first.originalSpec)
  })

  it('rejects saved originals whose checksum no longer matches before a model call', async () => {
    const { root, artifactDirectory } = await fixture()
    const { writeFile } = await import('node:fs/promises')
    const spec = join(root, 'original.zip')
    await writeFile(spec, archive())
    let calls = 0
    await expect(prepareCommunityBundle(intent, { ...options(artifactDirectory, archive(), { force: true, fetch: async () => { calls++; return response(validPatch()) } }),
      originalArchive: { spec, sha256: 'a'.repeat(64) },
    })).rejects.toMatchObject({ problem: 'invalid-archive' })
    expect(calls).toBe(0)
  })

  it('bounds context, response and patch size without changing installed files', async () => {
    for (const limits of [{ maxContextBytes: 32 }, { maxResponseBytes: 32 }, { maxFileBytes: 8 }]) {
      const { artifactDirectory } = await fixture()
      await expect(prepareCommunityBundle(intent, options(artifactDirectory, archive(), { limits: { ...limits, maxAttempts: 1 } })))
        .rejects.toMatchObject({ problem: 'adaptation-failed' })
      await expect(readdir(join(artifactDirectory, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('aborts an official request through its instance signal and waits for its rejection', async () => {
    const { artifactDirectory } = await fixture()
    const controller = new AbortController()
    let settled = false
    await expect(prepareCommunityBundle(intent, { ...options(artifactDirectory, archive(), { fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { settled = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      controller.abort()
    }) }), signal: controller.signal })).rejects.toMatchObject({ problem: 'cancelled' })
    expect(settled).toBe(true)
  })

  it('reports official authentication failure without retrying the same key', async () => {
    const { artifactDirectory } = await fixture()
    let calls = 0
    await expect(prepareCommunityBundle(intent, options(artifactDirectory, archive(), { limits: { maxAttempts: 3 }, fetch: async () => {
      calls++; return Response.json({ error: { message: 'bad key' } }, { status: 401 })
    } }))).rejects.toMatchObject({ problem: 'adaptation-key-required' })
    expect(calls).toBe(1)
  })

  it.each([
    '- id: agent-loop\n  config: {}\n',
    '- insert:\n    - id: adapter-test\n      name: "@deepseek-ai/dsh-agent-loop"\n',
    '- insert:\n    - id: agent-loop\n      name: "@example/adapter-test"\n',
    '- insert:\n    - id: adapter-test\n      name: "@example/adapter-test"\n      config: !!js process.env\n',
    '- insert: []\n',
  ])('refuses AI patches that alter Harness rows or introduce executable configuration', async yaml => {
    const { artifactDirectory } = await fixture()
    await expect(prepareCommunityBundle(intent, options(artifactDirectory, archive(), { fetch: async () => response(validPatch()
      .map(file => file.path === 'cordis.patch.yml' ? { ...file, content: yaml } : file)) }))).rejects.toMatchObject({ problem: 'adaptation-failed' })
    await expect(readdir(join(artifactDirectory, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requests raw website downloads and adapts archives marked with the old server rewrite', async () => {
    const { artifactDirectory } = await fixture()
    const bytes = archive(nativeManifest, { 'package/lib/index.js': 'export function apply(ctx) { ctx.on("fixture/event", () => "feature") }', 'package/cordis.patch.yml': patch })
    let calls = 0
    const result = await prepareCommunityBundle(intent, {
      ...options(artifactDirectory, bytes, { fetch: async (_input, init) => {
        calls++
        expect(String(init?.body)).toContain('rewritten for Harness 0.1.6')
        return response(validPatch())
      } }), fetch: withMetadata(bytes, async input => {
        const url = new URL(String(input))
        expect(url.origin).toBe('https://deepseek.stream')
        expect(url.searchParams.get('raw')).toBe('1')
        return new Response(new Uint8Array(bytes), { headers: { 'X-Plugin-016-Adapted': 'true' } })
      }),
    })
    expect(result.adapted).toBe(true)
    expect(result.sourceAdaptedFor016).toBe(true)
    expect(calls).toBe(1)
  })

  it('does not alter external download URLs or trust a foreign legacy-adaptation header', async () => {
    const { artifactDirectory } = await fixture()
    const url = 'https://cdn.example/plugin.zip?download=1'
    const result = await prepareCommunityBundle({ ...intent, downloadUrl: url }, {
      ...options(artifactDirectory, archive()), fetch: async input => {
        expect(String(input)).toBe(url)
        return new Response(new Uint8Array(archive(nativeManifest, { 'package/lib/index.js': 'export function apply() {}', 'package/cordis.patch.yml': patch })),
          { headers: { 'X-Plugin-016-Adapted': 'true' } })
      },
    })
    expect(result.adapted).toBe(false)
    expect(result.sourceAdaptedFor016).toBe(false)
  })

  it.each([
    'export function apply(ctx) { ctx.on("fixture/event", () => "feature") }',
    'window.__ModuleLoader__.load({id:"other-package",factory:()=>({apply(){}})});',
    'window.__ModuleLoader__.load({id:"@example/adapter-test",factory:(require)=>{require("node:fs");return {apply(){}}}});',
    'window.__ModuleLoader__.load({id:"@example/adapter-test",factory:(require)=>{require("missing-module");return {apply(){}}}});',
  ])('rejects unsupported browser artifacts before publishing an adapted bundle', async clientCode => {
    const { artifactDirectory } = await fixture()
    const clientManifest = { ...nativeManifest, exports: { ...nativeManifest.exports, './client': './lib/client.js' }, dsh: { ...nativeManifest.dsh, client: { platform: 'web', inject: [] } } }
    await expect(prepareCommunityBundle(intent, options(artifactDirectory, archive(clientManifest, {
      'package/lib/index.js': 'export function apply(ctx) { ctx.on("fixture/event", () => "feature") }', 'package/cordis.patch.yml': patch,
      'package/lib/client.js': 'window.__ModuleLoader__.load({id:"@example/adapter-test",factory:()=>({apply(){}})});',
    }), { force: true, fetch: async () => response([...validPatch().map(file => file.path === 'package.json' ? { ...file, content: JSON.stringify(clientManifest) } : file),
      { path: 'lib/client.js', content: clientCode }]) }))).rejects.toMatchObject({ problem: 'adaptation-failed' })
    await expect(readdir(join(artifactDirectory, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a valid browser module-loader factory and refuses dropping the original browser feature', async () => {
    const clientManifest = { ...nativeManifest, exports: { ...nativeManifest.exports, './client': './lib/client.js' }, dsh: { ...nativeManifest.dsh, client: { platform: 'web', inject: [] } } }
    const code = 'window.__ModuleLoader__.load({id:"@example/adapter-test",factory:(require)=>{const React=require("react");return {apply(ctx){ctx.on("fixture/event",()=>React.createElement("span",null,"feature"))}}}});'
    const bytes = archive(clientManifest, { 'package/lib/index.js': 'export function apply(ctx) { ctx.on("fixture/event", () => "feature") }', 'package/cordis.patch.yml': patch, 'package/lib/client.js': code })
    const first = await fixture()
    const result = await prepareCommunityBundle(intent, options(first.artifactDirectory, bytes, { force: true, fetch: async () => response(validPatch()
      .map(file => file.path === 'package.json' ? { ...file, content: JSON.stringify(clientManifest) } : file)) }))
    expect(result.adapted).toBe(true)
    const second = await fixture()
    await expect(prepareCommunityBundle(intent, options(second.artifactDirectory, bytes, { force: true }))).rejects.toMatchObject({ problem: 'adaptation-failed' })
  })

  it('rejects the source-verified old website fallback bodies without making a paid model request', async () => {
    const { artifactDirectory } = await fixture()
    const fallback = `// DeepSeek Harness 0.1.6 Max Compliant Plugin: Fixture addon
export const name = "adapter-test";
export function apply(ctx) {
  if (ctx.logger) { ctx.logger.info('[DSH-0.1.6] Plugin ' + name + ' initialized successfully.'); }
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try { ctx.tools.register({ name: "adapter-test", description: "Tool provided by Fixture addon", parameters: { type: 'object', properties: {} }, async execute() { return { status: 'ready', plugin: "adapter-test" }; } }); }
    catch (e) { ctx.logger?.warn?.('[DSH-0.1.6] Tool registration fallback handled:', e.message); }
  }
}
export default function plugin(ctx) { apply(ctx); }
`
    const clientFallback = `// DeepSeek Harness 0.1.6 Client UI Extension
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  try { window.__ModuleLoader__.load({ id: "adapter-test", factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    exports.apply = exports.apply || function() {}; return module.exports;
  } }); } catch (e) { console.warn('[DSH-0.1.6 Client] ' + "adapter-test" + ' load notice:', e); }
}
export default function setupClient(ctx) {}
`
    let calls = 0
    const bytes = archive(nativeManifest, { 'package/src/index.ts': fallback, 'package/lib/index.js': fallback,
      'package/client.js': clientFallback, 'package/cordis.patch.yml': patch })
    await expect(prepareCommunityBundle(intent, { ...options(artifactDirectory, bytes, { fetch: async () => { calls++; return response(validPatch()) } }),
      fetch: withMetadata(bytes, async () => new Response(new Uint8Array(bytes), { headers: { 'X-Plugin-016-Adapted': 'true' } })),
    })).rejects.toMatchObject({ problem: 'adaptation-failed', message: expect.stringContaining('lacks original functional source') })
    expect(calls).toBe(0)
    expect(await readdir(join(artifactDirectory, 'originals'))).toHaveLength(1)
    await expect(readdir(join(artifactDirectory, 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts genuine source with incidental old fallback markers', async () => {
    const { artifactDirectory } = await fixture()
    let calls = 0
    const bytes = archive(identity, { 'package/src/index.ts': `// DeepSeek Harness 0.1.6 Max Compliant Plugin: Fixture addon\n${source}\nexport const marker="DeepSeek Harness 0.1.6 Client UI Extension";\n` })
    const result = await prepareCommunityBundle(intent, options(artifactDirectory, bytes, { fetch: async () => { calls++; return response(validPatch()) } }))
    expect(result.adapted).toBe(true)
    expect(calls).toBe(1)
  })
})
