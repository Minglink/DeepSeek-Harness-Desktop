import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { communityProfileStockBundles } from '../src/community-profile-bundles.ts'

const stock = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const owner = 'dsh-purge-community-private-runtime-v1'
const token = 'ab450130-75bb-4656-9843-b0697d4ffa90'
const roots: string[] = []
function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value)) }
function fixture(privateIndexes: number[] = []) {
  const profile = mkdtempSync(join(tmpdir(), 'desktop-stock-owner-'))
  roots.push(profile)
  const run = join(profile, '.dsh-purge-runtime', token)
  mkdirSync(run, { recursive: true })
  const dependencies: Record<string, string> = {}
  const bundles = [...stock]
  const replacements = privateIndexes.map((index) => {
    const original = stock[index]
    const alias = `dsh-purge-private-${token}-bundle-${index}`
    const source = join(run, 'bundles', alias)
    const projection = join(profile, 'node_modules', alias)
    mkdirSync(source, { recursive: true })
    json(join(source, 'package.json'), { name: alias, version: '1.0.0', dsh: { bundle: { patch: './bundle.yml' } },
      deepseekStreamPrivateRuntime: { owner, token, originalPackage: original } })
    writeFileSync(join(source, 'bundle.yml'), '[]\n')
    cpSync(source, projection, { recursive: true })
    const dependency = `file:.dsh-purge-runtime/${token}/bundles/${alias}`
    dependencies[alias] = dependency
    bundles[index] = alias
    return { original, alias, aliasDir: projection, aliasSource: source, dependency, aliasVersion: '1.0.0' }
  })
  bundles.push('ordinary-extension')
  json(join(profile, 'package.json'), { dependencies, dsh: { profile: { bundles } } })
  json(join(profile, '.dsh-purge-runtime/owner.json'), { owner, profileDir: profile })
  const state = { owner, token, profileDir: profile, runDir: run, phase: 'installed', overlayKind: 'bundle-alias', bundleReplacements: replacements }
  json(join(profile, '.dsh-purge-runtime/current.json'), state)
  json(join(run, 'state.json'), state)
  return { profile, bundles, replacements }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('explicit Desktop stock anchors with verified private ownership', () => {
  it('retains the public stock prefix and excludes later extensions', () => {
    expect(communityProfileStockBundles(fixture().profile, stock)).toEqual(stock)
  })
  it.each([[0], [1], [0, 1]].map(indexes => ({ indexes })))('maps only fully verified stock replacements $indexes', ({ indexes }) => {
    const test = fixture(indexes)
    expect(communityProfileStockBundles(test.profile, stock)).toEqual(test.bundles.slice(0, 2))
  })
  it('rejects reordered stock bundles instead of placing defaults behind an extension', () => {
    const test = fixture([0, 1])
    json(join(test.profile, 'package.json'), { dependencies: Object.fromEntries(test.replacements.map(row => [row.alias, row.dependency])),
      dsh: { profile: { bundles: [test.bundles[1], test.bundles[0], 'ordinary-extension'] } } })
    expect(() => communityProfileStockBundles(test.profile, stock)).toThrow('verified declared prefix')
  })
  it('rejects a package marker whose real owner journal is missing', () => {
    const test = fixture([0])
    rmSync(join(test.profile, '.dsh-purge-runtime/current.json'))
    expect(() => communityProfileStockBundles(test.profile, stock)).toThrow('requires recovery')
  })
  it('rejects a forged canonical package identity without its original runtime marker', () => {
    const test = fixture([0])
    const file = join(test.replacements[0]!.aliasDir, 'package.json')
    const value = JSON.parse(readFileSync(file, 'utf8')) as { deepseekStreamPrivateRuntime: { originalPackage: string } }
    value.deepseekStreamPrivateRuntime.originalPackage = stock[1]!
    json(file, value)
    expect(() => communityProfileStockBundles(test.profile, stock)).toThrow('requires recovery')
  })
})
