/** Two physically different versions retain one explicit profile ownership policy. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, createRuntimeResolution, loadProfileDirectory, readProfilePatches, resolveBundleDir, type ProfileContext } from '../src/index.ts'
import { desktopProfileOwnedBundles } from '../../../../apps/desktop-host/src/profile-owned-bundles.ts'

let owned: string | undefined
afterEach(() => { if (owned !== undefined) rmSync(owned, { recursive: true, force: true }); owned = undefined })

function fixture() {
  owned = mkdtempSync(join(tmpdir(), 'explicit-profile-owner-'))
  const installation = join(owned, 'installation')
  const profile = join(owned, 'profiles', 'desktop')
  mkdirSync(installation, { recursive: true }); mkdirSync(profile, { recursive: true })
  const installationManifest = join(installation, 'package.json')
  writeFileSync(installationManifest, JSON.stringify({ name: 'test-dsh', version: '1.0.0', dependencies: { 'dsh-context': '0.62.1' } }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', dependencies: { 'dsh-context': '0.66.1' }, dsh: { profile: { bundles: ['dsh-context'] } } }))
  for (const [root, version] of [[installation, '0.62.1'], [profile, '0.66.1']]) {
    const dir = join(root!, 'node_modules', 'dsh-context'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-context', version, main: 'index.cjs', dsh: { bundle: { patch: 'patch.yml' } } }))
    writeFileSync(join(dir, 'index.cjs'), `module.exports = ${JSON.stringify(version)}\n`)
    writeFileSync(join(dir, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'context', name: 'dsh-context', config: { sourceVersion: version } }] }]))
  }
  const context: ProfileContext = { name: 'desktop', dir: profile, installAnchor: installationManifest, patchPath: join(profile, 'cordis.patch.yml'), cwd: profile, home: owned,
    startedBundles: ['dsh-context'], overlays: [], telemetryDisabledEnv: undefined, profileFirstBundles: ['dsh-context'] }
  return { installation, profile, installationManifest, context }
}

describe('explicit installed profile bundle ownership', () => {
  it('keeps omitted CLI-style resolution installation first', () => {
    const f = fixture()
    expect(resolveBundleDir('test', 'dsh-context', f.installationManifest, f.profile)).toBe(join(f.installation, 'node_modules', 'dsh-context'))
    expect(loadProfileDirectory('test', f.profile, f.installationManifest).layers[0]?.packageDir).toBe(join(f.installation, 'node_modules', 'dsh-context'))
  })
  it('selects the exact installed manifest, patch and actual Node module path together', () => {
    const f = fixture(), preferred = desktopProfileOwnedBundles(f.profile, [])
    const profile = loadProfileDirectory('test', f.profile, f.installationManifest, { profileFirstBundles: preferred })
    const actualModule = createRequire(join(f.profile, 'package.json')).resolve('dsh-context')
    expect(realpathSync.native(profile.layers[0]!.packageDir)).toBe(realpathSync.native(dirname(actualModule)))
    expect(composeEntries(profile.layers.map(layer => layer.patches))[0]?.config).toEqual({ sourceVersion: '0.66.1' })
    expect(Object.isFrozen(profile.profileFirstBundles)).toBe(true)
  })
  it('uses the same explicit identity when settings or HMR reread files', () => {
    const f = fixture()
    expect(composeEntries([readProfilePatches('test', f.context)])[0]?.config).toEqual({ sourceVersion: '0.66.1' })
    writeFileSync(join(f.profile, 'node_modules', 'dsh-context', 'patch.yml'), JSON.stringify([{ insert: [{ id: 'context', name: 'dsh-context', config: { sourceVersion: 'updated-profile' } }] }]))
    expect(composeEntries([readProfilePatches('test', f.context)])[0]?.config).toEqual({ sourceVersion: 'updated-profile' })
  })
  it('preserves exact profile-local resolution across a new resolver generation', async () => {
    const f = fixture()
    const profile = loadProfileDirectory('test', f.profile, f.installationManifest, { profileFirstBundles: ['dsh-context'] })
    const resolution = await createRuntimeResolution({ installAnchor: f.installationManifest, profile, home: f.context.home })
    expect(resolution.localPackageNames).toContain('dsh-context')
    const latest = await resolution.computeLatestResolution()
    expect(latest.localPackageNames).toContain('dsh-context')
    expect(latest.profileDir).toBe(f.profile)
  })
  it('excludes only the actual validated stock anchors supplied by the owner', () => {
    const f = fixture()
    expect(desktopProfileOwnedBundles(f.profile, ['dsh-context'])).toEqual([])
    expect(desktopProfileOwnedBundles(f.profile, ['another-package'])).toEqual(['dsh-context'])
  })
  it('does not infer ownership for an undeclared installed package', () => {
    const f = fixture()
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ name: 'test-profile', dependencies: {}, dsh: { profile: { bundles: ['dsh-context'] } } }))
    expect(desktopProfileOwnedBundles(f.profile, [])).toEqual([])
  })
  it('rejects an installed dependency whose actual package identity differs', () => {
    const f = fixture()
    writeFileSync(join(f.profile, 'node_modules', 'dsh-context', 'package.json'), JSON.stringify({ name: 'another-package', version: '0.66.1' }))
    expect(() => desktopProfileOwnedBundles(f.profile, [])).toThrow('different installed identity')
  })
  it('rejects malformed dependency declarations without importing author code', () => {
    const f = fixture()
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-context': null } }))
    expect(() => desktopProfileOwnedBundles(f.profile, [])).toThrow('package-spec mapping')
  })
})
