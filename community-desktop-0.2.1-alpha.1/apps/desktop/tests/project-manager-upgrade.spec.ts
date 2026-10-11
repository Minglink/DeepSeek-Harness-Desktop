/** Existing Desktop profiles must load the shipped community bundle after package reconciliation. */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { create as createTar } from 'tar'
import { composeEntries, loadProfileDirectory } from '../../../packages/boot/app-boot/src/profile.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const verification = resolve('work/verification')
const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin', 'pnpm.mjs')
const resources: string[] = []
const archiveName = 'dsh-community-0.2.1-alpha.1.tgz'

afterEach(async () => {
  for (const root of resources.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
  }
})

async function fixture() {
  await mkdir(verification, { recursive: true })
  const root = await mkdtemp(join(verification, 'profile-upgrade-'))
  resources.push(root)
  const runtime = join(root, 'runtime')
  runtimeFixture(runtime)
  const packages = join(runtime, 'desktop-packages')
  await mkdir(packages)
  const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, 'home')), { dsh: runtime, pnpm })
  await mkdir(manager.paths.profile, { recursive: true })
  await writeFile(join(manager.paths.profile, '.npmrc'), `store-dir=${join(root, 'store').replaceAll('\\', '/')}\nregistry=http://127.0.0.1:1\nfetch-retries=0\nfetch-timeout=1000\n`)
  const pack = async (legacy = false) => {
    const staging = join(root, 'staging')
    await rm(staging, { recursive: true, force: true })
    await cp(resolve('apps/desktop/plugins/dsh-community'), join(staging, 'package'), { recursive: true })
    if (legacy) {
      await writeFile(join(staging, 'package', 'cordis.patch.yml'), '[]\n')
      await writeFile(join(staging, 'package', 'index.js'), "export const name = 'dsh-community'\n")
    }
    await createTar({ cwd: staging, gzip: true, file: join(packages, archiveName) }, ['package'])
  }
  const load = () => {
    const profile = loadProfileDirectory('dsh', manager.paths.profile, join(runtime, 'node_modules', '@deepseek-ai/dsh', 'package.json'))
    const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
    return { entries, profile }
  }
  return { root, manager, pack, load }
}

describe('existing Desktop community profile upgrades', () => {
  it('replaces a same-version empty bundle with the shipped Host entry and client files', async () => {
    const { manager, pack, load } = await fixture()
    await pack(true)
    await manager.applyRelease()
    const installed = join(manager.paths.profile, 'node_modules', 'dsh-community')
    expect(await readFile(join(installed, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(load().entries.some(entry => entry.name === 'dsh-community')).toBe(false)

    await pack()
    await manager.applyRelease()

    const shippedPatch = await readFile(join(installed, 'cordis.patch.yml'), 'utf8').catch(async (error: unknown) => {
      throw new Error(await readFile(join(manager.paths.profile, 'desktop-packages.log'), 'utf8'), { cause: error })
    })
    expect(shippedPatch).toContain('name: dsh-community')
    const upgraded = load()
    expect(upgraded.profile.skippedBundles.some(bundle => bundle.packageName === 'dsh-community')).toBe(false)
    expect(upgraded.entries.find(entry => entry.name === 'dsh-community')).toMatchObject({ id: 'dsh-community' })
    expect(await readFile(join(installed, 'index.js'), 'utf8')).toContain('export function apply')
    expect(await readFile(join(installed, 'client', 'client.js'), 'utf8')).toContain('__ModuleLoader__.load')
    await new DesktopProjectManager(manager.paths, { dsh: manager.runtime.dsh }).applyRelease()
    expect(await readFile(join(installed, 'cordis.patch.yml'), 'utf8')).toContain('name: dsh-community')
    expect(await readdir(manager.paths.profile)).not.toContain('desktop-packages.log')
  })

  it('adds the native market to a legacy profile while preserving custom metadata and patches', async () => {
    const { root, manager, pack, load } = await fixture()
    await pack()
    const purgeStaging = join(root, 'purge-staging')
    await mkdir(join(purgeStaging, 'package'), { recursive: true })
    await writeFile(join(purgeStaging, 'package', 'package.json'), JSON.stringify({ name: 'dsh-purge', version: '1.1.67',
      type: 'module', exports: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(purgeStaging, 'package', 'index.js'), "export const name = 'dsh-purge'\n")
    await writeFile(join(purgeStaging, 'package', 'cordis.patch.yml'), '- insert:\n    - id: dsh-purge\n      name: dsh-purge\n')
    await mkdir(join(manager.paths.profile, 'operator-packages'))
    await createTar({ cwd: purgeStaging, gzip: true, file: join(manager.paths.profile, 'operator-packages', 'dsh-purge-1.1.67.tgz') }, ['package'])
    const purgeDependency = 'file:./operator-packages/dsh-purge-1.1.67.tgz'
    const manifest = { name: 'legacy-desktop', private: true, description: 'operator metadata',
      dependencies: { dshmarket: '1.66.8', 'deepseek-ai-cordis': '4.0.5', 'dsh-purge': purgeDependency },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'deepseek-ai-cordis', 'dsh-purge'], custom: 'retained' } } }
    await writeFile(join(manager.paths.profile, 'package.json'), JSON.stringify(manifest))
    const patch = '[]\n'
    await writeFile(join(manager.paths.profile, 'cordis.patch.yml'), patch)

    await manager.applyRelease()

    const next = JSON.parse(await readFile(join(manager.paths.profile, 'package.json'), 'utf8')) as typeof manifest
    expect(next.description).toBe('operator metadata')
    expect(next.dsh.profile.custom).toBe('retained')
    expect(next.dsh.profile.bundles).toContain('dsh-community')
    expect(next.dependencies['dsh-purge']).toBe(purgeDependency)
    expect(next.dsh.profile.bundles).toContain('dsh-purge')
    expect(next.dependencies).not.toHaveProperty('dshmarket')
    expect(next.dependencies).not.toHaveProperty('deepseek-ai-cordis')
    expect(await readFile(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(load().entries.find(entry => entry.name === 'dsh-community')).toMatchObject({ id: 'dsh-community' })
    expect(load().entries.find(entry => entry.name === 'dsh-purge')).toMatchObject({ id: 'dsh-purge' })
    await new DesktopProjectManager(manager.paths, { dsh: manager.runtime.dsh }).applyRelease()
    expect(load().entries.find(entry => entry.name === 'dsh-purge')).toMatchObject({ id: 'dsh-purge' })
  })

  it('restores the required market while preserving unrelated disabled rows and expressions', async () => {
    const { manager, pack, load } = await fixture()
    await pack(true)
    await manager.applyRelease()
    const patch = '- id: dsh-community\n  disabled: true\n- id: operator-tool\n  disabled: true\n  config:\n    value: !!js ctx.neverExecute()\n'
    await writeFile(join(manager.paths.profile, 'cordis.patch.yml'), patch)
    await pack()

    await manager.applyRelease()

    const nextPatch = await readFile(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')
    expect(nextPatch).toContain('id: operator-tool\n  disabled: true')
    expect(nextPatch).toContain('!!js ctx.neverExecute()')
    const backup = (await readdir(manager.paths.profile)).find(name => name.startsWith('cordis.patch.yml.bak-market-'))
    if (backup === undefined) throw new Error('Market patch recovery backup unavailable')
    expect(await readFile(join(manager.paths.profile, backup), 'utf8')).toBe(patch)
    expect(load().entries.find(entry => entry.name === 'dsh-community')?.disabled).not.toBe(true)
  })

  it('preserves optional bundle deselection and keeps the market during recovery', async () => {
    const { manager, pack } = await fixture()
    await pack()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies['dsh-context'] = '1.0.0'
    await mkdir(join(manager.paths.profile, 'node_modules', 'dsh-context'), { recursive: true })
    await writeFile(join(manager.paths.profile, 'node_modules', 'dsh-context', 'package.json'), '{"name":"dsh-context","version":"1.0.0"}\n')
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-context' && name !== 'dsh-community')
    await writeFile(path, JSON.stringify(manifest))
    await manager.applyRelease()
    const next = JSON.parse(await readFile(path, 'utf8')) as typeof manifest
    expect(next.dsh.profile.bundles).toContain('dsh-community')
    expect(next.dsh.profile.bundles).not.toContain('dsh-context')
    await manager.disableAllPlugins()
    const recovered = JSON.parse(await readFile(path, 'utf8')) as typeof manifest
    expect(recovered.dsh.profile.bundles).toContain('dsh-community')
    expect(recovered.dsh.profile.bundles).not.toContain('dsh-context')
  })

  it('repairs a missing materialized package even when pnpm has cached its unchanged file dependency', async () => {
    const { manager, pack } = await fixture()
    await pack()
    await manager.applyRelease()
    const installed = join(manager.paths.profile, 'node_modules', 'dsh-community')
    await rm(installed, { recursive: true })

    await manager.applyRelease()

    const patch = await readFile(join(installed, 'cordis.patch.yml'), 'utf8').catch(async (error: unknown) => {
      throw new Error(await readFile(join(manager.paths.profile, 'desktop-packages.log'), 'utf8'), { cause: error })
    })
    expect(patch).toContain('name: dsh-community')
    expect(await readFile(join(manager.paths.profile, 'desktop-packages.log'), 'utf8')).toContain('bundled plugin install recovered dsh-community')
  })
})
