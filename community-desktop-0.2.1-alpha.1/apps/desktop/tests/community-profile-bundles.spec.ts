import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { communityProfileBundleReplacements } from '../src/community-profile-bundles.ts'
import { createPluginProfile, DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
const OWNER = 'dsh-purge-community-private-runtime-v1'
const TOKEN = 'ab450130-75bb-4656-9843-b0697d4ffa90'
const ORIGINALS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const MARKET_PLUGINS = ['dsh-purge', 'dsh-infinite-gen-3', 'dsh-infinite-gen-4', 'dsh-prompt-enhancer',
  'dsh-prompt-enhancer-local', 'dsh-prompt-enhancer-local-organized']

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

interface Manifest {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

interface Replacement {
  original: string
  alias: string
  aliasDir: string
  aliasSource: string
  dependency: string
  aliasVersion: string
  originalSlot: number
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-bundle-restart-'))
  roots.push(root)
  const runtime = join(root, 'runtime')
  runtimeFixture(runtime)
  const paths = resolveDesktopPaths(join(root, 'home'))
  createPluginProfile(paths.profile)
  const manager = () => new DesktopProjectManager(paths, { dsh: runtime })
  const manifestPath = join(paths.profile, 'package.json')
  const readManifest = (): Manifest => JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  return { root, runtime, paths, manager, manifestPath, readManifest }
}

function privateFixture() {
  const result = fixture()
  const profile = result.paths.profile
  const privateRoot = join(profile, '.dsh-purge-runtime')
  const run = join(privateRoot, TOKEN)
  mkdirSync(run, { recursive: true })
  writeJson(join(privateRoot, 'owner.json'), { owner: OWNER, profileDir: profile })
  const manifest = result.readManifest()
  const replacements: Replacement[] = ORIGINALS.map((original, index) => {
    const alias = `dsh-purge-private-${TOKEN}-bundle-${index}`
    const source = join(run, 'bundles', alias)
    const projection = join(profile, 'node_modules', alias)
    mkdirSync(source, { recursive: true })
    writeJson(join(source, 'package.json'), { name: alias, version: '1.0.0',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './preset.patch.yml'] } },
      deepseekStreamPrivateRuntime: { owner: OWNER, token: TOKEN, originalPackage: original } })
    writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(source, 'preset.patch.yml'), '[]\n')
    cpSync(source, projection, { recursive: true })
    const dependency = `file:.dsh-purge-runtime/${TOKEN}/bundles/${alias}`
    manifest.dependencies[alias] = dependency
    return { original, alias, aliasDir: projection, aliasSource: source, dependency, aliasVersion: '1.0.0', originalSlot: index }
  })
  manifest.dsh.profile.bundles = [...replacements.map(row => row.alias), 'operator-extra']
  writeJson(result.manifestPath, manifest)
  const state = { owner: OWNER, token: TOKEN, profileDir: profile, runDir: run, phase: 'installed',
    overlayKind: 'bundle-alias', bundleReplacements: replacements }
  const currentPath = join(privateRoot, 'current.json')
  const statePath = join(run, 'state.json')
  writeJson(currentPath, { ...state, privateConfiguration: 'current private fields are not compared' })
  writeJson(statePath, { ...state, privateConfiguration: 'saved private fields may differ' })
  const recognized = () => communityProfileBundleReplacements(profile, result.readManifest().dependencies,
    result.readManifest().dsh.profile.bundles)
  return { ...result, replacements, state, currentPath, statePath, recognized }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('market plugin persistence across desktop cold starts', () => {
  it.each(MARKET_PLUGINS)('keeps a newly installed %s through two complete startup preparations', async (name) => {
    const { paths, manager, manifestPath, readManifest } = fixture()
    const manifest = readManifest()
    manifest.dependencies[name] = name === 'dsh-purge' ? '1.1.67' : '1.0.0'
    manifest.dsh.profile.bundles.push(name)
    writeJson(manifestPath, manifest)
    const directory = join(paths.profile, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeJson(join(directory, 'package.json'), { name, version: manifest.dependencies[name], dsh: { bundle: { patch: './bundle.yml' } } })
    writeFileSync(join(directory, 'bundle.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`)
    writeFileSync(join(paths.profile, 'cordis.patch.yml'), `- id: ${name}\n  config:\n    userOption: retained\n`)
    writeFileSync(join(paths.profile, 'pnpm-lock.yaml'), 'operator lockfile\n')
    const files = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
      `node_modules/${name}/package.json`, `node_modules/${name}/bundle.yml`]
    const before = files.map(file => readFileSync(join(paths.profile, file)))

    await manager().applyRelease()
    await manager().applyRelease()

    expect(files.map(file => readFileSync(join(paths.profile, file)))).toEqual(before)
    expect(readManifest().dsh.profile.bundles).toContain(name)
  })
})

describe('community private base bundle selections', () => {
  it('preserves selected aliases and user files through two cold starts without adding original base bundles', async () => {
    const test = privateFixture()
    writeFileSync(join(test.paths.profile, 'cordis.patch.yml'), '- id: operator-extra\n  config:\n    retained: true\n')
    const files = [test.manifestPath, join(test.paths.profile, 'cordis.patch.yml'), test.currentPath, test.statePath]
    const before = files.map(path => readFileSync(path))

    await test.manager().applyRelease()
    await test.manager().applyRelease()

    expect(test.readManifest().dsh.profile.bundles).toEqual([...test.replacements.map(row => row.alias), 'operator-extra'])
    expect(files.map(path => readFileSync(path))).toEqual(before)
    expect([...test.recognized()]).toEqual(ORIGINALS)
  })

  it('removes only original base selections previously appended beside verified aliases', async () => {
    const test = privateFixture()
    const manifest = test.readManifest()
    manifest.dependencies['operator-extra'] = '1.2.3'
    manifest.dsh.profile.bundles.push(...ORIGINALS)
    writeJson(test.manifestPath, manifest)
    const dependencies = { ...manifest.dependencies }

    await test.manager().applyRelease()
    await test.manager().applyRelease()

    expect(test.readManifest().dependencies).toEqual(dependencies)
    expect(test.readManifest().dsh.profile.bundles).toEqual([...test.replacements.map(row => row.alias), 'operator-extra'])
  })

  it('does not add original base bundles while adding the required bundled community market', () => {
    const test = privateFixture()
    const source = join(test.runtime, 'desktop-packages')
    mkdirSync(source)
    writeFileSync(join(source, 'dsh-community-1.0.0.tgz'), 'unexecuted bundled archive fixture')

    createPluginProfile(test.paths.profile, source)

    expect(test.readManifest().dsh.profile.bundles).toEqual([...test.replacements.map(row => row.alias), 'operator-extra', 'dsh-community'])
  })

  it('keeps original base selections when a private-looking package has an unknown owner', () => {
    const test = privateFixture()
    unlinkSync(join(test.paths.profile, '.dsh-purge-runtime', 'owner.json'))
    unlinkSync(test.currentPath)
    unlinkSync(test.statePath)
    for (const row of test.replacements) {
      for (const directory of [row.aliasSource, row.aliasDir]) {
        const path = join(directory, 'package.json')
        const value = JSON.parse(readFileSync(path, 'utf8')) as { deepseekStreamPrivateRuntime: { owner: string } }
        value.deepseekStreamPrivateRuntime.owner = 'another-plugin-owner'
        writeJson(path, value)
      }
    }
    const manifest = test.readManifest()
    manifest.dsh.profile.bundles.push(...ORIGINALS)
    writeJson(test.manifestPath, manifest)

    createPluginProfile(test.paths.profile)

    expect(test.recognized().size).toBe(0)
    expect(test.readManifest()).toEqual(manifest)
  })

  it.each(['prepared', 'wrong-token', 'wrong-profile', 'missing-owner', 'wrong-saved-replacement', 'invalid-projection', 'outside-source', 'outside-patch', 'missing-source-manifest', 'broken-source-manifest', 'missing-dependency', 'registry-dependency', 'archive-dependency'])(
    'leaves the profile untouched and requests recovery for a known owner with %s', async (problem) => {
      const test = privateFixture()
      if (problem === 'prepared') writeJson(test.currentPath, { ...test.state, phase: 'prepared' })
      if (problem === 'wrong-token') writeJson(test.currentPath, { ...test.state, token: 'a different runtime' })
      if (problem === 'wrong-profile') writeJson(test.currentPath, { ...test.state, profileDir: test.root })
      if (problem === 'missing-owner') unlinkSync(join(test.paths.profile, '.dsh-purge-runtime', 'owner.json'))
      if (problem === 'missing-source-manifest') unlinkSync(join(test.replacements[0]!.aliasSource, 'package.json'))
      if (problem === 'broken-source-manifest') writeFileSync(join(test.replacements[0]!.aliasSource, 'package.json'), '{broken')
      if (['missing-dependency', 'registry-dependency', 'archive-dependency'].includes(problem)) {
        const manifest = test.readManifest()
        const alias = test.replacements[0]!.alias
        if (problem === 'missing-dependency') {
          manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => name !== alias))
        }
        else manifest.dependencies[alias] = problem === 'registry-dependency' ? '1.0.0' : 'file:./owned-archive.tgz'
        writeJson(test.manifestPath, manifest)
      }
      if (problem === 'wrong-saved-replacement') writeJson(test.statePath, { ...test.state,
        bundleReplacements: [{ ...test.replacements[0], original: ORIGINALS[1] }, test.replacements[1]] })
      if (problem === 'invalid-projection') {
        const row = test.replacements[0]!
        writeJson(join(row.aliasDir, 'package.json'), { name: row.alias, version: '1.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } }, deepseekStreamPrivateRuntime: { owner: 'different owner' } })
      }
      if (problem === 'outside-source') {
        const row = test.replacements[0]!
        const outside = join(test.root, 'outside-owned-profile')
        cpSync(row.aliasSource, outside, { recursive: true })
        const manifest = test.readManifest()
        manifest.dependencies[row.alias] = `file:${outside}`
        writeJson(test.manifestPath, manifest)
      }
      if (problem === 'outside-patch') {
        const row = test.replacements[0]!
        const path = join(row.aliasSource, 'package.json')
        const value = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { bundle: { patch: string[] } } }
        value.dsh.bundle.patch = ['../../../../package.json']
        writeJson(path, value)
      }
      const files = [test.manifestPath, join(test.paths.profile, 'cordis.patch.yml'), join(test.paths.profile, 'pnpm-workspace.yaml')]
      const before = files.map(path => readFileSync(path))

      await expect(test.manager().applyRelease()).rejects.toThrow('requires recovery before startup reconciliation')

      expect(files.map(path => readFileSync(path))).toEqual(before)
      expect(existsSync(test.replacements[0]!.aliasDir)).toBe(true)
    })

  it.each(['missing-dependency', 'registry-dependency', 'archive-dependency', 'missing-source-manifest'])(
    'recognizes materialized owner evidence when a damaged journal also has %s', async (problem) => {
      const test = privateFixture(), manifest = test.readManifest(), alias = test.replacements[0]!.alias
      writeFileSync(test.currentPath, '{damaged journal')
      if (problem === 'missing-dependency') manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => name !== alias))
      if (problem === 'registry-dependency') manifest.dependencies[alias] = '1.0.0'
      if (problem === 'archive-dependency') manifest.dependencies[alias] = 'file:owned.tgz'
      if (problem === 'missing-source-manifest') unlinkSync(join(test.replacements[0]!.aliasSource, 'package.json'))
      writeJson(test.manifestPath, manifest)
      const before = readFileSync(test.manifestPath)
      await expect(test.manager().applyRelease()).rejects.toThrow('requires recovery before startup reconciliation')
      expect(readFileSync(test.manifestPath)).toEqual(before)
    })
})
