/** Deployment preferences preserve declared stock, extension, and user ordering. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory, insertDefaultsLayer, readProfilePatches, type ProfileContext } from '../src/index.ts'

let home: string | undefined
afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }); home = undefined })
function fixture() {
  home = mkdtempSync(join(tmpdir(), 'deployment-layer-'))
  const dir = join(home, 'profile'); mkdirSync(dir)
  const bundles = ['stock-base', 'stock-web', 'third-party']
  for (const name of bundles) {
    const packageDir = join(dir, 'node_modules', name); mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: 'patch.yml' } } }))
    const patch = name === 'stock-base' ? [{ insert: [{ id: 'backend', name: 'stock-backend' }] }]
      : [{ id: 'backend', disabled: name === 'stock-web' || name === 'third-party' }]
    writeFileSync(join(packageDir, 'patch.yml'), JSON.stringify(patch))
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles } } }))
  const defaults = join(home, 'defaults.yml'); writeFileSync(defaults, JSON.stringify([{ id: 'backend', disabled: false }]))
  const context: ProfileContext = { name: 'desktop', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(dir, 'package.json'), cwd: home, home, startedBundles: bundles,
    defaultsFiles: [defaults], defaultsAfterBundles: ['stock-base', 'stock-web'], overlays: [], telemetryDisabledEnv: undefined }
  return { dir, defaults, context, profile: loadProfileDirectory('test', dir, context.installAnchor) }
}
describe('deployment defaults position', () => {
  it('keeps the legacy caller position immediately below user preferences', () => {
    const { profile, defaults } = fixture(); insertDefaultsLayer(profile, [defaults], 'test')
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['stock-base', 'stock-web', 'third-party', 'dsh-deployment-defaults'])
    expect(composeEntries(profile.layers.map(layer => layer.patches))[0]?.disabled).toBe(false)
  })
  it('lets an extension disable the same stock logical row after defaults', () => {
    const { profile, defaults, context } = fixture(); insertDefaultsLayer(profile, [defaults], 'test', context.defaultsAfterBundles)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['stock-base', 'stock-web', 'dsh-deployment-defaults', 'third-party'])
    expect(composeEntries(profile.layers.map(layer => layer.patches))).toHaveLength(1)
    expect(composeEntries(profile.layers.map(layer => layer.patches))[0]?.disabled).toBe(true)
  })
  it('uses the same extension precedence when settings or HMR reread current files', () => {
    const { context } = fixture(); expect(composeEntries([readProfilePatches('test', context)])[0]?.disabled).toBe(true)
    writeFileSync(context.patchPath, JSON.stringify([{ id: 'backend', disabled: false }]))
    expect(composeEntries([readProfilePatches('test', context)])[0]?.disabled).toBe(false)
  })
  it.each([[], ['stock-web'], ['stock-base', 'unknown'], ['third-party', 'stock-base']].map(prefix => ({ prefix })))('rejects an undeclared or misplaced stock prefix ', ({ prefix }) => {
    const { profile, defaults } = fixture(); expect(() =>{  insertDefaultsLayer(profile, [defaults], 'test', prefix) }).toThrow('declared stock bundle prefix')
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['stock-base', 'stock-web', 'third-party'])
  })
})
