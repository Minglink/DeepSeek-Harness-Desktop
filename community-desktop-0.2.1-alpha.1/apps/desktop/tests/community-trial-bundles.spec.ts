/** Private runtime trial fixtures are synthetic; no user profile or plugin code is executed. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareCommunityTrialProfile } from '../src/community-trial-profile.ts'
import { CommunityTransactionError } from '../src/community-transaction.ts'
import { communityFailureSummary } from '../src/community-failure.ts'

const roots: string[] = [], OWNER = 'dsh-purge-community-private-runtime-v1', TOKEN = 'ab450130-75bb-4656-9843-b0697d4ffa90'
interface Replacement {
  original: string
  alias: string
  aliasDir: string
  aliasSource: string
  dependency: string
  aliasVersion: string
}
function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
function fixture(privateRuntime = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'desktop-owned-trial-')))
  roots.push(root)
  const live = join(root, 'live'), candidate = join(root, 'candidate'), home = join(root, 'trial-home')
  mkdirSync(live)
  const manifest = { name: 'desktop', dependencies: {} as Record<string, string>, dsh: { profile: { bundles: [] as string[] } } }
  const replacements: Replacement[] = []
  const modulePath = join(live, '.dsh-purge-runtime', TOKEN, 'node_modules', '@deepseek-ai', 'private-fixture', 'lib', 'index.js')
  const url = pathToFileURL(modulePath).href
  const patch = `# keep exact bytes\r\n- insert:\r\n    - id: private-module\r\n      name: "${url}"\r\n      config:\r\n        note: "${url}"\r\n    - id: ordinary\r\n      name: ordinary-package\r\n`
  if (privateRuntime) {
    mkdirSync(join(live, '.dsh-purge-runtime', TOKEN), { recursive: true })
    mkdirSync(join(modulePath, '..'), { recursive: true })
    writeFileSync(modulePath, 'throw new Error("module-must-not-execute")\n')
    for (const [index, original] of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].entries()) {
      const alias = `dsh-purge-private-${TOKEN}-bundle-${index}`
      const source = join(live, '.dsh-purge-runtime', TOKEN, 'bundles', alias), projection = join(live, 'node_modules', alias)
      mkdirSync(join(source, 'presets'), { recursive: true })
      writeJson(join(source, 'package.json'), { name: alias, version: '1.0.0', dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] } },
        deepseekStreamPrivateRuntime: { owner: OWNER, token: TOKEN, originalPackage: original } })
      writeFileSync(join(source, 'cordis.patch.yml'), patch)
      writeFileSync(join(source, 'presets', 'standard.patch.yml'), patch)
      cpSync(source, projection, { recursive: true })
      const dependency = `file:.dsh-purge-runtime/${TOKEN}/bundles/${alias}`
      manifest.dependencies[alias] = dependency
      manifest.dsh.profile.bundles.push(alias)
      replacements.push({ original, alias, aliasDir: projection, aliasSource: source, dependency, aliasVersion: '1.0.0' })
    }
    writeJson(join(live, '.dsh-purge-runtime', 'owner.json'), { owner: OWNER, profileDir: live })
    const state = { owner: OWNER, token: TOKEN, profileDir: live, runDir: join(live, '.dsh-purge-runtime', TOKEN), phase: 'installed', overlayKind: 'bundle-alias', bundleReplacements: replacements }
    writeJson(join(live, '.dsh-purge-runtime', 'current.json'), state)
    writeJson(join(live, '.dsh-purge-runtime', TOKEN, 'state.json'), state)
  }
  writeJson(join(live, 'package.json'), manifest)
  writeFileSync(join(live, 'cordis.patch.yml'), patch)
  cpSync(live, candidate, { recursive: true })
  const aliases = replacements.map(row => row.alias)
  const patches = aliases.flatMap(alias => [join(candidate, '.dsh-purge-runtime', TOKEN, 'bundles', alias), join(candidate, 'node_modules', alias)]
    .flatMap(directory => [join(directory, 'cordis.patch.yml'), join(directory, 'presets', 'standard.patch.yml')]))
  const markerPaths = ['owner.json', 'current.json', `${TOKEN}/state.json`].map(name => join(live, '.dsh-purge-runtime', name))
  return { root, live, candidate, home, manifest, aliases, patches, markerPaths, patch, url, modulePath, candidateModule: join(candidate, '.dsh-purge-runtime', TOKEN, 'node_modules', '@deepseek-ai', 'private-fixture', 'lib', 'index.js') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('verified private bundle candidate module relocation', () => {
  it('keeps first installation selections intact when no private runtime exists', async () => {
    const test = fixture(false), original = readFileSync(join(test.candidate, 'package.json'))
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    await restore()
    expect(readFileSync(join(test.candidate, 'package.json'))).toEqual(original)
    expect(readFileSync(join(test.live, 'cordis.patch.yml'), 'utf8')).toBe(test.patch)
  })

  it('accepts a normal first-install manifest with no dependency field without adding one', async () => {
    const test = fixture(false), manifest = { name: 'desktop', dsh: test.manifest.dsh }
    writeJson(join(test.live, 'package.json'), manifest); writeJson(join(test.candidate, 'package.json'), manifest)
    const original = readFileSync(join(test.candidate, 'package.json'))
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    await restore()
    expect(readFileSync(join(test.candidate, 'package.json'))).toEqual(original)
  })

  it('runs the copied private graph through candidate names, restores exact patches and preserves new installation selections', async () => {
    const test = fixture(), all = [...test.patches, join(test.candidate, 'cordis.patch.yml')]
    const originals = all.map(path => readFileSync(path)), markers = test.markerPaths.map(path => readFileSync(path))
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    for (const path of all) {
      const value = load(readFileSync(path, 'utf8')) as Array<{ insert: Array<{ name: string; config?: { note: string } }> }>
      expect(value[0]?.insert[0]?.name).toBe(pathToFileURL(test.candidateModule).href)
      expect(value[0]?.insert[0]?.config?.note).toBe(test.url)
      expect(value[0]?.insert[1]?.name).toBe('ordinary-package')
    }
    const installed = structuredClone(test.manifest)
    installed.dependencies['dsh-purge'] = '1.1.67'
    installed.dsh.profile.bundles.push('dsh-purge')
    writeJson(join(test.candidate, 'package.json'), installed)
    await restore(); await restore()
    expect(all.map(path => readFileSync(path))).toEqual(originals)
    expect(JSON.parse(readFileSync(join(test.candidate, 'package.json'), 'utf8'))).toEqual(installed)
    expect(test.markerPaths.map(path => readFileSync(path))).toEqual(markers)
    expect(readFileSync(join(test.live, 'cordis.patch.yml'), 'utf8')).toBe(test.patch)
  })

  it('restores private patches when a failed trial exits and pnpm replaced projections with candidate-owned junctions', async () => {
    const test = fixture(), before = test.patches.map(path => readFileSync(path))
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    try {
      for (const alias of test.aliases) {
        const projection = join(test.candidate, 'node_modules', alias)
        rmSync(projection, { recursive: true })
        symlinkSync(join(test.candidate, '.dsh-purge-runtime', TOKEN, 'bundles', alias), projection, 'junction')
      }
      throw new Error('synthetic-native-failure')
    } catch (error) { expect((error as Error).message).toBe('synthetic-native-failure') }
    finally { await restore() }
    expect(test.patches.map(path => readFileSync(path))).toEqual(before)
    expect(readFileSync(join(test.live, 'cordis.patch.yml'), 'utf8')).toBe(test.patch)
  })

  it('does not interpret ordinary aliases with an unknown owner as private replacements', async () => {
    const test = fixture(false), alias = 'ordinary-alias', directory = join(test.live, 'ordinary')
    mkdirSync(directory)
    writeJson(join(directory, 'package.json'), { name: alias, deepseekStreamPrivateRuntime: { owner: 'another-owner' } })
    test.manifest.dependencies[alias] = 'file:ordinary'
    test.manifest.dsh.profile.bundles.push(alias)
    writeJson(join(test.live, 'package.json'), test.manifest)
    cpSync(test.live, test.candidate, { recursive: true })
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    await restore()
    expect(JSON.parse(readFileSync(join(test.candidate, 'package.json'), 'utf8'))).toEqual(test.manifest)
  })

  it.each(['query', 'hash', 'encoded-traversal', 'encoded-separator', 'other-token', 'foreign-file'])(
    'refuses a known private alias patch with %s module URLs before any write', async (problem) => {
      const test = fixture(), outside = join(test.root, 'outside.js')
      writeFileSync(outside, 'must remain inert\n')
      let url = test.url
      if (problem === 'query') url += '?module=other'
      if (problem === 'hash') url += '#other'
      if (problem === 'encoded-traversal') url = `${pathToFileURL(join(test.live, '.dsh-purge-runtime', TOKEN)).href}/%2e%2e/%2e%2e/package.json`
      if (problem === 'encoded-separator') url = test.url.replace('/lib/', '/lib%2f')
      if (problem === 'other-token') {
        const path = join(test.live, '.dsh-purge-runtime', 'other-token', 'index.js')
        mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'must remain inert\n'); url = pathToFileURL(path).href
      }
      if (problem === 'foreign-file') url = pathToFileURL(outside).href
      const changed = `- insert:\n    - id: private-module\n      name: "${url}"\n`
      for (const path of test.patches) {
        writeFileSync(path, changed)
        writeFileSync(path.replace(test.candidate, test.live), changed)
      }
      const original = test.patches.map(path => readFileSync(path))
      let failure: unknown
      try { await prepareCommunityTrialProfile(test.candidate, test.home, test.live) } catch (error) { failure = error }
      expect(communityFailureSummary(failure)).toMatchObject({ cause: 'preparation', adaptationEligible: false })
      expect(test.patches.map(path => readFileSync(path))).toEqual(original)
      expect(existsSync(test.home)).toBe(false)
    })

  it('leaves ordinary root file names unchanged and still relocates nested private names', async () => {
    const test = fixture(), outside = join(test.root, 'ordinary.js')
    writeFileSync(outside, 'must remain inert\n')
    const patch = `- name: "${pathToFileURL(outside).href}"\n  children:\n    - name: "${test.url}"\n- name: file:invalid%\n  children:\n    - name: "${test.url}"\n`
    writeFileSync(join(test.candidate, 'cordis.patch.yml'), patch)
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    const value = load(readFileSync(join(test.candidate, 'cordis.patch.yml'), 'utf8')) as Array<{ name: string; children: Array<{ name: string }> }>
    expect(value[0]?.name).toBe(pathToFileURL(outside).href)
    expect(value[1]?.name).toBe('file:invalid%')
    expect(value.map(row => row.children[0]?.name)).toEqual([
      pathToFileURL(test.candidateModule).href, pathToFileURL(test.candidateModule).href,
    ])
    await restore()
    expect(readFileSync(join(test.candidate, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('round-trips tagged JavaScript scalars without evaluating or relocating expressions', async () => {
    const test = fixture(), alias = test.aliases[0]!
    const patch = `- name: !!js '(() => { throw new Error("must-not-run") })()'\n- name: "${test.url}"\n`
    const source = join(test.live, '.dsh-purge-runtime', TOKEN, 'bundles', alias, 'cordis.patch.yml')
    const projection = join(test.live, 'node_modules', alias, 'cordis.patch.yml')
    for (const path of [source, projection, source.replace(test.live, test.candidate), projection.replace(test.live, test.candidate)]) {
      writeFileSync(path, patch)
    }
    const restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    expect(readFileSync(source.replace(test.live, test.candidate), 'utf8')).toContain('must-not-run')
    await restore()
    expect(readFileSync(source.replace(test.live, test.candidate), 'utf8')).toBe(patch)
  })

  it.each(['prepared-live', 'bad-candidate-marker', 'changed-journal', 'source-escape', 'projection-escape', 'module-escape', 'missing-module'])(
    'rejects %s before changing candidate files or sending arbitrary diagnostic text to adaptation', async (problem) => {
      const test = fixture(), alias = test.aliases[0]!
      if (problem === 'prepared-live') {
        const path = join(test.live, '.dsh-purge-runtime', 'current.json'), value = JSON.parse(readFileSync(path, 'utf8')) as { phase: string }
        value.phase = 'prepared'; writeJson(path, value)
      }
      if (problem === 'bad-candidate-marker') writeJson(join(test.candidate, 'node_modules', alias, 'package.json'), { name: alias, deepseekStreamPrivateRuntime: { owner: 'wrong' } })
      if (problem === 'changed-journal') writeJson(join(test.candidate, '.dsh-purge-runtime', 'current.json'), { owner: OWNER, token: TOKEN })
      if (problem === 'source-escape' || problem === 'projection-escape') {
        const path = problem === 'source-escape' ? join(test.candidate, '.dsh-purge-runtime', TOKEN, 'bundles', alias) : join(test.candidate, 'node_modules', alias)
        const outside = join(test.root, 'outside')
        cpSync(path, outside, { recursive: true }); rmSync(path, { recursive: true }); symlinkSync(outside, path, 'junction')
      }
      if (problem === 'module-escape') {
        const outside = join(test.root, 'outside.js')
        writeFileSync(outside, 'must stay untouched\n'); rmSync(test.candidateModule); symlinkSync(outside, test.candidateModule, 'file')
      }
      if (problem === 'missing-module') rmSync(test.candidateModule)
      const observed = [...test.patches, join(test.candidate, 'cordis.patch.yml'), join(test.candidate, 'package.json')]
      const original = observed.map(path => readFileSync(path))
      let failure: unknown
      try { await prepareCommunityTrialProfile(test.candidate, test.home, test.live) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(CommunityTransactionError)
      expect(communityFailureSummary(failure)).toMatchObject({ cause: 'preparation', adaptationEligible: false })
      expect((failure as CommunityTransactionError).diagnostic).toBe('Candidate Host infrastructure failed: preparation')
      expect(observed.map(path => readFileSync(path))).toEqual(original)
      expect(existsSync(join(test.candidate, '.npmrc'))).toBe(false)
      expect(existsSync(test.home)).toBe(false)
    })

  it('refuses an escaped post-install projection before any restoration writes and preserves the live tree', async () => {
    const test = fixture(), restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    const alias = test.aliases[0]!, projection = join(test.candidate, 'node_modules', alias), outside = join(test.root, 'outside')
    cpSync(projection, outside, { recursive: true })
    rmSync(projection, { recursive: true }); symlinkSync(outside, projection, 'junction')
    const before = readFileSync(join(outside, 'cordis.patch.yml')), source = readFileSync(test.patches[0]!)
    let failure: unknown
    try { await restore() } catch (error) { failure = error }
    expect(communityFailureSummary(failure)).toMatchObject({ cause: 'restoration', adaptationEligible: false })
    expect(readFileSync(join(outside, 'cordis.patch.yml'))).toEqual(before)
    expect(readFileSync(test.patches[0]!)).toEqual(source)
    expect(readFileSync(join(test.live, 'cordis.patch.yml'), 'utf8')).toBe(test.patch)
  })

  it('refuses a source moved outside its token even within candidate before restoring any patches', async () => {
    const test = fixture(), restore = await prepareCommunityTrialProfile(test.candidate, test.home, test.live)
    const alias = test.aliases[0]!, source = join(test.candidate, '.dsh-purge-runtime', TOKEN, 'bundles', alias), moved = join(test.candidate, 'moved-source')
    cpSync(source, moved, { recursive: true }); rmSync(source, { recursive: true }); symlinkSync(moved, source, 'junction')
    const before = readFileSync(join(moved, 'cordis.patch.yml'))
    await expect(restore()).rejects.toMatchObject({ code: 'trial-failed', adaptationEligible: false })
    expect(readFileSync(join(moved, 'cordis.patch.yml'))).toEqual(before)
  })
})
