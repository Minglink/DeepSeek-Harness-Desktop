/** Managed admission rejects unknown payloads while preserving ordinary repairable boot. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManagedHarmony } from '../src/managed-harmony.ts'

let owned: string | undefined
afterEach(() => { if (owned !== undefined) rmSync(owned, { recursive: true, force: true }); owned = undefined })
function fixture(selected: string[]) {
  owned = mkdtempSync(join(tmpdir(), 'managed-admission-'))
  const runtime = join(owned, 'runtime'), profile = join(owned, 'profile')
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true }); mkdirSync(profile)
  writeFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'owned-test-profile', dsh: { profile: { bundles: selected } } }))
  const packageManifest = (name: string, value: unknown) => {
    const dir = join(profile, 'node_modules', name); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return { runtime, profile, packageManifest }
}
describe('exact managed bootstrap admission', () => {
  it('leaves a normal profile without a provider on the existing bootstrap path', async () => {
    const f = fixture(['ordinary-bundle']); f.packageManifest('ordinary-bundle', { name: 'ordinary-bundle', dsh: { bundle: { patch: 'patch.yml' } } })
    const result = await prepareManagedHarmony(f.runtime, f.profile, [])
    expect(result.patchFiles).toEqual([]); expect(() =>{  result.assertReady() }).not.toThrow()
  })
  it('leaves a missing ordinary selection repairable by the normal loader', async () => {
    const f = fixture(['missing-ordinary-bundle'])
    expect((await prepareManagedHarmony(f.runtime, f.profile, [])).patchFiles).toEqual([])
  })
  it('leaves invalid ordinary metadata on the normal skipped-bundle diagnostic path', async () => {
    const f = fixture(['invalid-ordinary-bundle']); f.packageManifest('invalid-ordinary-bundle', '{')
    expect((await prepareManagedHarmony(f.runtime, f.profile, [])).patchFiles).toEqual([])
  })
  it('rejects a missing explicitly managed provider instead of pretending ACTIVE', async () => {
    const f = fixture(['@ch4acko3/dsh-turn-fold'])
    await expect(prepareManagedHarmony(f.runtime, f.profile, [])).rejects.toThrow()
  })
  it('rejects a different author source-patch provider before executing any author module', async () => {
    const f = fixture(['another-provider']); f.packageManifest('another-provider', { name: 'another-provider', version: '1.0.0', dsh: { harmony: { patches: ['patch.cjs'] } } })
    await expect(prepareManagedHarmony(f.runtime, f.profile, [])).rejects.toThrow('Unqualified managed Harmony provider')
  })
  it('rejects an unqualified version of the real provider before executing any author module', async () => {
    const f = fixture(['@ch4acko3/dsh-turn-fold']); f.packageManifest('@ch4acko3/dsh-turn-fold', { name: '@ch4acko3/dsh-turn-fold', version: '0.6.4', dsh: { harmony: { patches: ['patch.cjs'] } } })
    await expect(prepareManagedHarmony(f.runtime, f.profile, [])).rejects.toThrow('Unqualified managed Harmony provider')
  })
  it('requires the exact hook-free community companion dependency', async () => {
    const f = fixture(['@ch4acko3/dsh-turn-fold']); f.packageManifest('@ch4acko3/dsh-turn-fold', { name: '@ch4acko3/dsh-turn-fold', version: '0.6.4-community.desktop-harmony.4', dependencies: { 'dsh-harmony': '^0.8.17' }, dsh: { harmony: { patches: ['patch.cjs'], requires: { 'dsh-harmony': '^0.8.17' } } } })
    await expect(prepareManagedHarmony(f.runtime, f.profile, [])).rejects.toThrow('exact real companion dependency')
  })
  it('publishes the real entry and keeps its index import late in normal bundling', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] }
    expect(manifest.files).toContain('lib/bootstrap.js')
    const configuration = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
    expect(configuration).toContain("'bootstrap'")
    expect(configuration).toContain("name === 'bootstrap' ? { deps: { neverBundle: ['./index.js'] } }")
    const entry = readFileSync(new URL('../src/bootstrap.ts', import.meta.url), 'utf8')
    expect(entry.indexOf('await prepareManagedHarmony(')).toBeLessThan(entry.indexOf("await import('./index.ts')"))
  })
})
