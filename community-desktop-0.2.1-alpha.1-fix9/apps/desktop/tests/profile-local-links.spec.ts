/** A package operation may replace local projections but must never traverse or retire their source. */
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { captureProfileLocalLinks, detachProfileLocalLinks, restoreProfileLocalLinks } from '../src/profile-local-links.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(name = 'local-plugin', selected = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-link-test-'))
  roots.push(root)
  const profile = join(root, 'home/profiles/desktop')
  const target = join(root, 'home/plugins/local-plugin')
  const installed = join(profile, 'node_modules', ...name.split('/'))
  mkdirSync(target, { recursive: true })
  mkdirSync(dirname(installed), { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  writeFileSync(join(target, 'runtime.exe'), 'complete bundled engine bytes')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [name]: 'file:../../plugins/local-plugin' },
    dsh: { profile: { bundles: selected ? [name] : [] } } }))
  symlinkSync(target, installed, process.platform === 'win32' ? 'junction' : 'dir')
  return { root, profile, target, installed }
}

describe('desktop local directory source protection', () => {
  it.each([true, false])('protects source resources before cleanup and restores the original directory projection (selected=%s)', (selected) => {
    const f = fixture('local-plugin', selected)
    const manifest = readFileSync(join(f.profile, 'package.json'), 'utf8')
    const links = captureProfileLocalLinks(f.profile)
    expect(links).toHaveLength(1)
    detachProfileLocalLinks(f.profile, links)
    expect(existsSync(f.installed)).toBe(false)
    // Simulate pnpm's clean/recreate pass after all external junctions were detached.
    rmSync(join(f.profile, 'node_modules'), { recursive: true })
    mkdirSync(f.installed, { recursive: true })
    writeFileSync(join(f.installed, 'copied-runtime'), 'pnpm materialized copy')
    restoreProfileLocalLinks(f.profile, links)
    expect(lstatSync(f.installed).isSymbolicLink()).toBe(true)
    expect(realpathSync(f.installed)).toBe(realpathSync(f.target))
    expect(readFileSync(join(f.target, 'runtime.exe'), 'utf8')).toBe('complete bundled engine bytes')
    expect(existsSync(join(f.installed, 'copied-runtime'))).toBe(false)
    expect(readFileSync(join(f.profile, 'package.json'), 'utf8')).toBe(manifest)
    expect(captureProfileLocalLinks(f.profile)).toEqual(links)
  })

  it('restores a scoped package after a failed installer leaves no projection', () => {
    const f = fixture('@author/local-plugin')
    const links = captureProfileLocalLinks(f.profile)
    detachProfileLocalLinks(f.profile, links)
    restoreProfileLocalLinks(f.profile, links)
    expect(realpathSync(f.installed)).toBe(realpathSync(f.target))
    expect(readFileSync(join(f.target, 'runtime.exe'), 'utf8')).toBe('complete bundled engine bytes')
  })

  it('unlinks a replacement symlink without deleting its other source', () => {
    const f = fixture()
    const links = captureProfileLocalLinks(f.profile)
    detachProfileLocalLinks(f.profile, links)
    const other = join(f.root, 'other-source')
    mkdirSync(other)
    writeFileSync(join(other, 'sentinel'), 'retain unrelated source')
    symlinkSync(other, f.installed, process.platform === 'win32' ? 'junction' : 'dir')
    restoreProfileLocalLinks(f.profile, links)
    expect(realpathSync(f.installed)).toBe(realpathSync(f.target))
    expect(readFileSync(join(other, 'sentinel'), 'utf8')).toBe('retain unrelated source')
  })

  it('refuses a mismatched file dependency before detaching its installed source', () => {
    const f = fixture()
    const other = join(f.root, 'home/plugins/other')
    mkdirSync(other)
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'local-plugin': 'file:../../plugins/other' } }))
    expect(() => captureProfileLocalLinks(f.profile)).toThrow('link does not match')
    expect(realpathSync(f.installed)).toBe(realpathSync(f.target))
    expect(readFileSync(join(f.target, 'runtime.exe'), 'utf8')).toBe('complete bundled engine bytes')
  })

  it('refuses a changed source identity without removing the replacement directory', () => {
    const f = fixture()
    const links = captureProfileLocalLinks(f.profile)
    detachProfileLocalLinks(f.profile, links)
    mkdirSync(f.installed)
    writeFileSync(join(f.installed, 'sentinel'), 'leave replacement available for recovery')
    writeFileSync(join(f.target, 'package.json'), JSON.stringify({ name: 'another-plugin' }))
    expect(() => restoreProfileLocalLinks(f.profile, links)).toThrow('identity')
    expect(readFileSync(join(f.installed, 'sentinel'), 'utf8')).toBe('leave replacement available for recovery')
    expect(readFileSync(join(f.target, 'runtime.exe'), 'utf8')).toBe('complete bundled engine bytes')
  })

  it('rejects a scoped parent redirected outside node_modules without touching its target', () => {
    const f = fixture('@author/local-plugin')
    const links = captureProfileLocalLinks(f.profile)
    detachProfileLocalLinks(f.profile, links)
    rmSync(dirname(f.installed), { recursive: true })
    const outside = join(f.root, 'outside-profile')
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel'), 'retain outside')
    symlinkSync(outside, dirname(f.installed), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => restoreProfileLocalLinks(f.profile, links)).toThrow('escapes')
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('retain outside')
    unlinkSync(dirname(f.installed))
  })

  it('ignores shipped packages, archives and undeclared installation links', () => {
    const f = fixture()
    expect(captureProfileLocalLinks(f.profile, ['local-plugin'])).toEqual([])
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: {} }))
    expect(captureProfileLocalLinks(f.profile)).toEqual([])
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'local-plugin': 'file:./package.tgz' } }))
    writeFileSync(join(f.profile, 'package.tgz'), 'archive')
    expect(captureProfileLocalLinks(f.profile)).toEqual([])
    expect(readFileSync(join(f.target, 'runtime.exe'), 'utf8')).toBe('complete bundled engine bytes')
  })

  it.each(['replace', 'remove'])('keeps the new declared package when an installer deliberately changes the dependency (%s)', (change) => {
    const f = fixture()
    const links = captureProfileLocalLinks(f.profile)
    detachProfileLocalLinks(f.profile, links)
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: change === 'replace' ? { 'local-plugin': '2.0.0' } : {} }))
    mkdirSync(f.installed)
    writeFileSync(join(f.installed, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '2.0.0' }))
    restoreProfileLocalLinks(f.profile, links)
    expect(lstatSync(f.installed).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(join(f.installed, 'package.json'), 'utf8'))).toMatchObject({ version: '2.0.0' })
    expect(readFileSync(join(f.target, 'runtime.exe'), 'utf8')).toBe('complete bundled engine bytes')
  })

  it('preserves a declared file URL and decodes its escaped path safely', () => {
    const f = fixture()
    const manifest = { dependencies: { 'local-plugin': pathToFileURL(f.target).href } }
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify(manifest))
    const links = captureProfileLocalLinks(f.profile)
    expect(links).toHaveLength(1)
    detachProfileLocalLinks(f.profile, links)
    restoreProfileLocalLinks(f.profile, links)
    expect(realpathSync(f.installed)).toBe(realpathSync(f.target))
    expect(readFileSync(join(f.profile, 'package.json'), 'utf8')).toBe(JSON.stringify(manifest))
  })

  it.each(['null', '{"dependencies":null}', '{"dependencies":[]}'])('rejects malformed profile dependency state before touching local links (%s)', (json) => {
    const f = fixture()
    writeFileSync(join(f.profile, 'package.json'), json)
    expect(() => captureProfileLocalLinks(f.profile)).toThrow('dependency mapping')
    expect(realpathSync(f.installed)).toBe(realpathSync(f.target))
  })
})
