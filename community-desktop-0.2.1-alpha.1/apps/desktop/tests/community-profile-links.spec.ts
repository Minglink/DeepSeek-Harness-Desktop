/** Profile relocation fixtures use owned directories and actual directory links without traversing external targets. */
import { randomUUID } from 'node:crypto'
import { cp, link, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, toNamespacedPath } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyCommunityProfileLinks, rebaseCommunityProfileLinks } from '../src/community-profile-links.ts'

const roots: string[] = []
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<{ root: string; live: string; candidate: string; backup: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-links-'))
  roots.push(root)
  const live = join(root, 'profile'), candidate = join(root, 'candidate'), backup = join(root, 'backup')
  const outside = join(root, 'profile-other')
  await mkdir(join(live, 'node_modules'), { recursive: true })
  await mkdir(join(live, 'store', 'addon'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(live, 'store', 'addon', 'value.txt'), 'original')
  await writeFile(join(outside, 'value.txt'), 'external')
  await symlink(join(live, 'store', 'addon'), join(live, 'node_modules', 'addon'), directoryLink)
  await symlink(join(live, 'node_modules', 'addon'), join(live, 'node_modules', 'alias'), directoryLink)
  await symlink(outside, join(live, 'node_modules', 'external'), directoryLink)
  return { root, live, candidate, backup, outside }
}

async function copyProfile(source: string, destination: string): Promise<void> {
  const links: string[] = []
  await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: async (path) => {
      if (!(await lstat(path)).isSymbolicLink()) return true
      links.push(path)
      return false
    } })
  await copyCommunityProfileLinks(source, destination, links)
}

describe('community profile dependency link relocation', () => {
  it('rebases copied absolute dependencies while leaving the running original profile unchanged', async () => {
    const files = await fixture()
    const original = await readlink(join(files.live, 'node_modules', 'addon'))
    await copyProfile(files.live, files.candidate)
    await rebaseCommunityProfileLinks(files.candidate, files.live, files.candidate)
    await writeFile(join(files.candidate, 'store', 'addon', 'value.txt'), 'candidate')
    expect(await readFile(join(files.candidate, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('candidate')
    expect(await readFile(join(files.live, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('original')
    expect(await readlink(join(files.live, 'node_modules', 'addon'))).toBe(original)
  })

  it('keeps transitive dependencies valid through promotion, retained backup, and rollback renames', async () => {
    const files = await fixture()
    await copyProfile(files.live, files.candidate)
    await rebaseCommunityProfileLinks(files.candidate, files.live, files.candidate)
    await writeFile(join(files.candidate, 'store', 'addon', 'value.txt'), 'candidate')
    await rebaseCommunityProfileLinks(files.candidate, files.candidate, files.live)
    await rename(files.live, files.backup)
    await rebaseCommunityProfileLinks(files.backup, files.live, files.backup)
    await rename(files.candidate, files.live)
    expect(await readFile(join(files.live, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('candidate')
    expect(await readFile(join(files.backup, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('original')
    await rebaseCommunityProfileLinks(files.backup, files.backup, files.live)
    await rename(files.live, join(files.root, 'rejected'))
    await rename(files.backup, files.live)
    expect(await readFile(join(files.live, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('original')
  })

  it('preserves external links and never visits directories reached through links', async () => {
    const files = await fixture()
    await symlink(join(files.live, 'store', 'addon'), join(files.outside, 'untouched'), directoryLink)
    const untouched = await readlink(join(files.outside, 'untouched'))
    const outside = await readlink(join(files.live, 'node_modules', 'external'))
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect(await readlink(join(files.live, 'node_modules', 'external'))).toBe(outside)
    expect(await readlink(join(files.outside, 'untouched'))).toBe(untouched)
  })

  it('copies omitted directory links with internal targets in the candidate and unchanged external targets', async () => {
    const files = await fixture()
    const original = await readlink(join(files.live, 'node_modules', 'external'))
    await copyProfile(files.live, files.candidate)
    expect(await readFile(join(files.candidate, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('original')
    expect(await readlink(join(files.candidate, 'node_modules', 'external'))).toBe(original)
    expect(await readFile(join(files.candidate, 'node_modules', 'external', 'value.txt'), 'utf8')).toBe('external')
  })

  it('rejects copy entries outside the source and ordinary files without modifying the source', async () => {
    const files = await fixture()
    await mkdir(files.candidate)
    await expect(copyCommunityProfileLinks(files.live, files.candidate, [files.outside])).rejects.toThrow('outside its source')
    await expect(copyCommunityProfileLinks(files.live, files.candidate, [files.live])).rejects.toThrow('outside its source')
    await expect(copyCommunityProfileLinks(files.live, files.candidate,
      [join(files.live, 'store', 'addon', 'value.txt')])).rejects.toThrow('must be a link')
    expect(await readFile(join(files.live, 'node_modules', 'addon', 'value.txt'), 'utf8')).toBe('original')
  })

  it('repairs an interrupted backup link replacement before restoring the profile directory', async () => {
    const files = await fixture()
    await rename(files.live, files.backup)
    const links = join(files.backup, 'node_modules')
    const pending = join(links, '.community-link-' + randomUUID() + '-' + Buffer.from('addon').toString('hex'))
    await symlink(join(files.backup, 'store', 'addon'), pending, directoryLink)
    await unlink(join(links, 'addon'))
    await rebaseCommunityProfileLinks(files.backup, files.backup, files.live)
    expect((await readdir(links)).some(name => name.startsWith('.community-link-'))).toBe(false)
    await rename(files.backup, files.live)
    expect(await readFile(join(files.live, 'node_modules', 'alias', 'value.txt'), 'utf8')).toBe('original')
  })

  it('removes a pending replacement when its original link exists and remains retryable', async () => {
    const files = await fixture()
    const links = join(files.live, 'node_modules')
    const pending = join(links, '.community-link-' + randomUUID() + '-' + Buffer.from('addon').toString('hex'))
    await symlink(files.outside, pending, directoryLink)
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect((await readdir(links)).some(name => name.startsWith('.community-link-'))).toBe(false)
    await rebaseCommunityProfileLinks(files.live, files.candidate, files.live)
    expect(await readFile(join(files.live, 'node_modules', 'addon', 'value.txt'), 'utf8')).toBe('original')
  })

  it.skipIf(process.platform === 'win32')('preserves relative links and rebases absolute file links', async () => {
    const files = await fixture()
    const target = join(files.live, 'store', 'addon', 'value.txt')
    const relativeLink = join(files.live, 'node_modules', 'relative')
    const original = relative(join(files.live, 'node_modules'), join(files.live, 'store', 'addon'))
    await symlink(original, relativeLink, 'dir')
    await symlink(target, join(files.live, 'node_modules', 'file'), 'file')
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect(await readlink(relativeLink)).toBe(original)
    expect(await readlink(join(files.live, 'node_modules', 'file'))).toBe(join(files.candidate, 'store', 'addon', 'value.txt'))
  })

  it.skipIf(process.platform !== 'win32')('matches Windows namespace and case variants and recreates directory junctions', async () => {
    const files = await fixture()
    const namespaced = join(files.live, 'node_modules', 'namespaced')
    await symlink(toNamespacedPath(join(files.live, 'store', 'addon')), namespaced, 'junction')
    await rebaseCommunityProfileLinks(files.live, toNamespacedPath(files.live.toUpperCase()), files.candidate)
    expect((await lstat(namespaced)).isSymbolicLink()).toBe(true)
    expect(resolve(await readlink(namespaced)).toLowerCase()).toBe(join(files.candidate, 'store', 'addon').toLowerCase())
  })

  it('rejects linked roots and missing internal targets before changing any dependency links', async () => {
    const files = await fixture()
    const linkedRoot = join(files.root, 'linked-root')
    await symlink(files.live, linkedRoot, directoryLink)
    await expect(rebaseCommunityProfileLinks(linkedRoot, files.live, files.candidate)).rejects.toThrow('real directory')
    const original = await readlink(join(files.live, 'node_modules', 'addon'))
    await symlink(join(files.live, 'missing'), join(files.live, 'node_modules', 'missing'), directoryLink)
    await expect(rebaseCommunityProfileLinks(files.live, files.live, files.candidate)).rejects.toThrow('does not exist')
    expect(await readlink(join(files.live, 'node_modules', 'addon'))).toBe(original)
  })
})

describe('community profile pnpm virtual-store relocation', () => {
  const metadataPath = (profile: string): string => join(profile, 'node_modules', '.modules.yaml')
  const metadata = (profile: string): string => JSON.stringify({
    layoutVersion: 5, nodeLinker: 'hoisted', storeDir: 'unchanged-external-store', virtualStoreDirMaxLength: 60,
    virtualStoreDir: join(profile, 'node_modules', '.pnpm'), publicHoistPattern: [], included: { dependencies: true },
  }, null, 2) + '\n'

  it('relocates actual Windows pnpm JSON metadata through copy, promotion, backup and rollback without changing other bytes', async () => {
    const files = await fixture(), original = metadata(files.live)
    await writeFile(metadataPath(files.live), original)
    await copyProfile(files.live, files.candidate)
    await rebaseCommunityProfileLinks(files.candidate, files.live, files.candidate)
    expect(await readFile(metadataPath(files.candidate), 'utf8')).toBe(metadata(files.candidate))
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(original)
    await rebaseCommunityProfileLinks(files.candidate, files.candidate, files.live)
    await rename(files.live, files.backup)
    await rebaseCommunityProfileLinks(files.backup, files.live, files.backup)
    await rename(files.candidate, files.live)
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(original)
    expect(await readFile(metadataPath(files.backup), 'utf8')).toBe(metadata(files.backup))
    await rebaseCommunityProfileLinks(files.backup, files.backup, files.live)
    await rename(files.live, join(files.root, 'rejected'))
    await rename(files.backup, files.live)
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(original)
  })

  it.each(['QUOTE_SINGLE', 'QUOTE_DOUBLE', 'PLAIN'])('preserves YAML comments and untouched fields for %s paths', async (style) => {
    const files = await fixture(), old = join(files.live, 'node_modules', '.pnpm')
    const token = (path: string): string => style === 'QUOTE_DOUBLE' ? JSON.stringify(path)
      : style === 'QUOTE_SINGLE' ? "'" + path.replace(/'/gu, "''") + "'" : path
    const original = '# pnpm metadata\r\nvirtualStoreDir: ' + token(old) + ' # location\r\n'
      + 'storeDir: unchanged\r\nvirtualStoreDirMaxLength: 60\r\nlayoutVersion: 5\r\npublicHoistPattern: []\r\n'
    await writeFile(metadataPath(files.live), original)
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(original.replace(token(old), token(join(files.candidate, 'node_modules', '.pnpm'))))
  })

  it('keeps a UTF-8 BOM and the original JSON bytes after a reverse relocation', async () => {
    const files = await fixture(), original = Buffer.from('\ufeff' + metadata(files.live))
    await writeFile(metadataPath(files.live), original)
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect((await readFile(metadataPath(files.live))).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    await rebaseCommunityProfileLinks(files.live, files.candidate, files.live)
    expect(await readFile(metadataPath(files.live))).toEqual(original)
  })

  it('quotes a plain path when the new directory contains YAML comment syntax', async () => {
    const files = await fixture(), target = join(files.root, 'candidate # one')
    const original = 'virtualStoreDir: ' + join(files.live, 'node_modules', '.pnpm') + '\nlayoutVersion: 5\n'
    await writeFile(metadataPath(files.live), original)
    await rebaseCommunityProfileLinks(files.live, files.live, target)
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe('virtualStoreDir: '
      + JSON.stringify(join(target, 'node_modules', '.pnpm')) + '\nlayoutVersion: 5\n')
  })

  it.each(['relative', 'external', 'sibling-prefix', 'missing'])('leaves %s virtual-store metadata byte-identical', async (kind) => {
    const files = await fixture()
    const path = kind === 'relative' ? '.pnpm' : kind === 'sibling-prefix' ? join(files.outside, 'node_modules', '.pnpm')
      : join(files.root, 'external-store')
    const original = kind === 'missing' ? '{"layoutVersion":5}\n' : JSON.stringify({ virtualStoreDir: path, layoutVersion: 5 })
    await writeFile(metadataPath(files.live), original)
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(original)
  })

  it.skipIf(process.platform !== 'win32')('recognizes namespaced and case-varied Windows virtual-store roots', async () => {
    const files = await fixture()
    await writeFile(metadataPath(files.live), JSON.stringify({ virtualStoreDir: toNamespacedPath(join(files.live, 'node_modules', '.pnpm')) }))
    await rebaseCommunityProfileLinks(files.live, toNamespacedPath(files.live.toUpperCase()), files.candidate)
    expect(JSON.parse(await readFile(metadataPath(files.live), 'utf8')).virtualStoreDir).toBe(join(files.candidate, 'node_modules', '.pnpm'))
  })

  it('rejects a linked metadata file before changing dependencies or its external target', async () => {
    const files = await fixture(), external = join(files.outside, '.modules.yaml')
    const original = metadata(files.live), link = await readlink(join(files.live, 'node_modules', 'addon'))
    await writeFile(external, original)
    await symlink(external, metadataPath(files.live), 'file')
    await expect(rebaseCommunityProfileLinks(files.live, files.live, files.candidate)).rejects.toThrow('regular file')
    expect(await readFile(external, 'utf8')).toBe(original)
    expect(await readlink(join(files.live, 'node_modules', 'addon'))).toBe(link)
  })

  it('never follows a node_modules junction to rewrite another owner’s metadata', async () => {
    const files = await fixture(), original = metadata(files.live)
    await writeFile(join(files.outside, '.modules.yaml'), original)
    const linkedProfile = join(files.root, 'linked-modules-profile')
    await mkdir(linkedProfile)
    await symlink(files.outside, join(linkedProfile, 'node_modules'), directoryLink)
    await rebaseCommunityProfileLinks(linkedProfile, files.live, files.candidate)
    expect(await readFile(join(files.outside, '.modules.yaml'), 'utf8')).toBe(original)
  })

  it('replaces a hardlinked metadata entry without modifying its other owner’s inode', async () => {
    const files = await fixture(), original = metadata(files.live), external = join(files.outside, '.modules.yaml')
    await writeFile(external, original)
    await link(external, metadataPath(files.live))
    await rebaseCommunityProfileLinks(files.live, files.live, files.candidate)
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(metadata(files.candidate))
    expect(await readFile(external, 'utf8')).toBe(original)
  })

  it('keeps metadata and links unchanged when no root relocation is requested', async () => {
    const files = await fixture(), original = Buffer.from([0xff, 0xfe])
    const dependency = await readlink(join(files.live, 'node_modules', 'addon'))
    await writeFile(metadataPath(files.live), original)
    await rebaseCommunityProfileLinks(files.live, files.live, files.live)
    expect(await readFile(metadataPath(files.live))).toEqual(original)
    expect(await readlink(join(files.live, 'node_modules', 'addon'))).toBe(dependency)
  })

  it('refuses a replacement exceeding the metadata limit before changing any link', async () => {
    const files = await fixture(), text = metadata(files.live)
    const original = text + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(text))
    const dependency = await readlink(join(files.live, 'node_modules', 'addon'))
    await writeFile(metadataPath(files.live), original)
    await expect(rebaseCommunityProfileLinks(files.live, files.live, join(files.root, 'much-longer-new-profile'))).rejects.toThrow('byte limit')
    expect(await readFile(metadataPath(files.live), 'utf8')).toBe(original)
    expect(await readlink(join(files.live, 'node_modules', 'addon'))).toBe(dependency)
  })

  it.each([
    ['oversized', Buffer.alloc(2 * 1024 * 1024 + 1, 32), 'byte limit'],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe]), 'valid UTF-8'],
    ['malformed', Buffer.from('{virtualStoreDir: [broken'), 'inert YAML or JSON mapping'],
    ['duplicate keys', Buffer.from('virtualStoreDir: first\nvirtualStoreDir: second\n'), 'inert YAML or JSON mapping'],
    ['executable tag', Buffer.from('virtualStoreDir: !!js/function "function () { throw new Error(\'never execute\') }"\n'), 'inert YAML or JSON mapping'],
    ['array root', Buffer.from('[one, two]'), 'inert YAML or JSON mapping'],
    ['non-string value', Buffer.from('virtualStoreDir: 42\n'), 'must be a string'],
    ['map value', Buffer.from('virtualStoreDir: {path: value}\n'), 'must be a string'],
    ['alias value', Buffer.from('base: &base /somewhere\nvirtualStoreDir: *base\n'), 'must be a string'],
  ])('rejects %s metadata before changing dependencies and without echoing its contents', async (_name, content, expected) => {
    const files = await fixture(), original = await readlink(join(files.live, 'node_modules', 'addon'))
    await writeFile(metadataPath(files.live), content)
    await expect(rebaseCommunityProfileLinks(files.live, files.live, files.candidate)).rejects.toThrow(expected)
    expect(await readFile(metadataPath(files.live))).toEqual(content)
    expect(await readlink(join(files.live, 'node_modules', 'addon'))).toBe(original)
  })
})
