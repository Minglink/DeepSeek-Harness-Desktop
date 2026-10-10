/** Internal dependency links and pnpm virtual-store metadata follow a stopped profile when it is copied or renamed. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readlink, readdir, rename, stat, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const MAX_MODULES_METADATA_BYTES = 2 * 1024 * 1024

interface ModulesRelocation {
  readonly path: string
  readonly original: Buffer
  readonly replacement: string
  readonly mode: number
}

interface ProfileLink {
  readonly path: string
  readonly original: string
  readonly replacement: string
  readonly actualTarget: string
  type?: 'dir' | 'file'
}

function plainPath(path: string): string {
  if (process.platform !== 'win32') return path
  return path.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '')
}

function pathKey(path: string): string {
  const normalized = resolve(plainPath(path))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function inside(root: string, target: string): string | undefined {
  const suffix = relative(root, target)
  return suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix) ? undefined : suffix
}

function modulesDocument(text: string): ReturnType<typeof parseDocument> {
  const document = parseDocument(text, { uniqueKeys: true, customTags: [] })
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    throw new Error('Community profile pnpm metadata must contain an inert YAML or JSON mapping')
  }
  return document
}

function modulesPathScalar(path: string, type: string | undefined): string {
  if (type === 'QUOTE_SINGLE') return "'" + path.replace(/'/gu, "''") + "'"
  if (type === 'PLAIN') {
    const text = 'virtualStoreDir: ' + path + '\n'
    const document = parseDocument(text, { uniqueKeys: true, customTags: [] })
    if (document.errors.length === 0 && document.warnings.length === 0 && isMap(document.contents)
      && document.get('virtualStoreDir') === path && document.contents.items.length === 1) return path
  }
  return JSON.stringify(path)
}

async function modulesRelocation(actual: string, previous: string, next: string): Promise<ModulesRelocation | undefined> {
  const modules = join(actual, 'node_modules'), path = join(modules, '.modules.yaml')
  let entry
  try { entry = await lstat(modules) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
  // An external node_modules link belongs to its target owner and is never followed for metadata writes.
  if (entry.isSymbolicLink()) return undefined
  if (!entry.isDirectory()) throw new Error('Community profile node_modules must be a directory')
  try { entry = await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Community profile pnpm metadata must be a regular file')
  if (entry.size > MAX_MODULES_METADATA_BYTES) throw new Error('Community profile pnpm metadata exceeds its byte limit')
  const handle = await open(path, 'r')
  let original: Buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > MAX_MODULES_METADATA_BYTES) {
      throw new Error('Community profile pnpm metadata changed before reading')
    }
    original = await handle.readFile()
  } finally { await handle.close() }
  if (original.length > MAX_MODULES_METADATA_BYTES) throw new Error('Community profile pnpm metadata exceeds its byte limit')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original) }
  catch { throw new Error('Community profile pnpm metadata must contain valid UTF-8') }
  const document = modulesDocument(text)
  const scalar = document.get('virtualStoreDir', true)
  if (scalar === undefined) return undefined
  if (!isScalar(scalar) || typeof scalar.value !== 'string') throw new Error('Community profile pnpm virtualStoreDir must be a string')
  if (!isAbsolute(plainPath(scalar.value))) return undefined
  const suffix = inside(previous, resolve(plainPath(scalar.value)))
  if (suffix === undefined) return undefined
  const replacement = join(next, suffix)
  if (pathKey(scalar.value) === pathKey(replacement)) return undefined
  if (/[\u0000\r\n]/u.test(replacement) || scalar.range === undefined || scalar.range === null) {
    throw new Error('Community profile pnpm virtualStoreDir is not a supported path scalar')
  }
  const [start, end] = scalar.range
  const updated = text.slice(0, start) + modulesPathScalar(replacement, scalar.type) + text.slice(end)
  if (Buffer.byteLength(updated) > MAX_MODULES_METADATA_BYTES) throw new Error('Community profile pnpm metadata exceeds its byte limit')
  if (modulesDocument(updated).get('virtualStoreDir') !== replacement) throw new Error('Community profile pnpm virtualStoreDir could not be relocated')
  return { path, original, replacement: updated, mode: entry.mode & 0o777 }
}

async function linkType(link: ProfileLink, links: ReadonlyMap<string, ProfileLink>, visiting: Set<ProfileLink>): Promise<'dir' | 'file'> {
  if (link.type !== undefined) return link.type
  if (visiting.has(link)) throw new Error('Community profile dependency links contain a cycle')
  visiting.add(link)
  for (const target of [link.actualTarget, link.path]) {
    try {
      const entry = await stat(target)
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Community profile dependency target is not a file or directory')
      link.type = entry.isDirectory() ? 'dir' : 'file'
      return link.type
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // A renamed profile can leave every link in an absolute chain pointing at its absent previous directory.
  const targetLink = links.get(pathKey(link.actualTarget))
  if (targetLink === undefined) throw new Error('Community profile dependency target does not exist')
  link.type = await linkType(targetLink, links, visiting)
  return link.type
}

async function replaceLink(link: ProfileLink): Promise<void> {
  if (link.type === undefined) throw new Error('Community profile dependency link type is unresolved')
  const type = process.platform === 'win32' && link.type === 'dir' ? 'junction' : link.type
  const temporary = join(dirname(link.path), '.community-link-' + randomUUID() + '-' + Buffer.from(basename(link.path)).toString('hex'))
  await symlink(link.replacement, temporary, type)
  try { await unlink(link.path) }
  catch (unlinkError) { await unlink(temporary); throw unlinkError }
  try { await rename(temporary, link.path) }
  catch (replacementError) {
    try { await symlink(link.original, link.path, type) }
    catch (restoreError) {
      throw new AggregateError([replacementError, restoreError], 'Community dependency link restoration failed')
    }
    await unlink(temporary)
    throw replacementError
  }
}

async function repairPendingLinks(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const match = /^\.community-link-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-((?:[a-f0-9]{2})+)$/u.exec(name)
    if (match === null) continue
    const encoded = match[1]
    if (encoded === undefined) throw new Error('Invalid pending community dependency link')
    const original = Buffer.from(encoded, 'hex').toString('utf8')
    if (Buffer.from(original).toString('hex') !== encoded || original === '.' || original === '..'
      || /[/\\\0]/u.test(original) || basename(original) !== original) throw new Error('Invalid pending community dependency link')
    const pending = join(directory, name), destination = join(directory, original)
    if (!(await lstat(pending)).isSymbolicLink()) throw new Error('Pending community dependency entry must be a link')
    let exists = true
    try { await lstat(destination) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false }
    if (exists) await unlink(pending)
    else await rename(pending, destination)
  }
}

/**
 * Clone links omitted by a profile copy, using unprivileged Windows directory junctions.
 * @param sourceRoot - Real original profile directory; its targets remain unchanged.
 * @param destinationRoot - Real copied profile directory with all source links omitted.
 * @param links - Absolute source link paths collected by the copy filter without traversing links.
 * @returns After internal targets point into the copy; unsupported or inaccessible targets reject the candidate copy.
 */
export async function copyCommunityProfileLinks(sourceRoot: string, destinationRoot: string, links: readonly string[]): Promise<void> {
  const source = resolve(plainPath(sourceRoot)), destination = resolve(plainPath(destinationRoot))
  for (const root of [source, destination]) {
    const entry = await lstat(root)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Community profile link root must be a real directory')
  }
  const copies: { target: string; path: string; type: 'dir' | 'file' | 'junction' }[] = []
  for (const path of links) {
    const absolute = resolve(plainPath(path)), suffix = inside(source, absolute)
    if (!isAbsolute(path) || suffix === undefined || suffix === '') throw new Error('Community profile link is outside its source')
    if (!(await lstat(absolute)).isSymbolicLink()) throw new Error('Community profile copy entry must be a link')
    const original = await readlink(absolute), entry = await stat(absolute)
    if (!entry.isDirectory() && !entry.isFile()) throw new Error('Community profile dependency target is not a file or directory')
    const destinationPath = join(destination, suffix)
    const internal = isAbsolute(original) ? inside(source, resolve(plainPath(original))) : undefined
    const target = internal === undefined ? original : join(destination, internal)
    copies.push({ path: destinationPath,
      target: process.platform === 'win32' && entry.isDirectory() ? resolve(dirname(destinationPath), plainPath(target)) : target,
      type: process.platform === 'win32' && entry.isDirectory() ? 'junction' : entry.isDirectory() ? 'dir' : 'file' })
  }
  for (const copy of copies) {
    await mkdir(dirname(copy.path), { recursive: true })
    await symlink(copy.target, copy.path, copy.type)
  }
}

/**
 * Repoint internal absolute links and pnpm virtualStoreDir without following linked directories.
 * Other pnpm metadata and relative or external paths remain unchanged.
 * @param directory - Existing real profile directory with no running process modifying its contents.
 * @param fromRoot - Previous absolute root referenced by dependency links, which may already have been renamed.
 * @param toRoot - Absolute root the profile will occupy after its next rename.
 * @returns After interrupted link replacements are repaired and matching links are replaced; failures leave journal recovery to the caller.
 */
export async function rebaseCommunityProfileLinks(directory: string, fromRoot: string, toRoot: string): Promise<void> {
  const actual = resolve(plainPath(directory)), previous = resolve(plainPath(fromRoot)), next = resolve(plainPath(toRoot))
  const root = await lstat(actual)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Community profile link root must be a real directory')
  const metadata = pathKey(previous) === pathKey(next) ? undefined : await modulesRelocation(actual, previous, next)
  const links = new Map<string, ProfileLink>()
  async function visit(path: string): Promise<void> {
    await repairPendingLinks(path)
    for (const name of await readdir(path)) {
      const child = join(path, name), entry = await lstat(child)
      if (entry.isSymbolicLink()) {
        const original = await readlink(child)
        if (!isAbsolute(original)) continue
        const suffix = inside(previous, resolve(plainPath(original)))
        if (suffix === undefined) continue
        const replacement = join(next, suffix)
        if (pathKey(original) === pathKey(replacement)) continue
        links.set(pathKey(child), { path: child, original, replacement, actualTarget: join(actual, suffix) })
      } else if (entry.isDirectory()) await visit(child)
    }
  }
  await visit(actual)
  // Capture target types before any replacement can temporarily make another link in the same chain dangling.
  for (const link of links.values()) await linkType(link, links, new Set())
  for (const link of links.values()) await replaceLink(link)
  if (metadata !== undefined) {
    const current = await lstat(metadata.path)
    if (!current.isFile() || current.isSymbolicLink() || !(await readFile(metadata.path)).equals(metadata.original)) {
      throw new Error('Community profile pnpm metadata changed before relocation')
    }
    await writeFileAtomic(metadata.path, metadata.replacement, { mode: metadata.mode })
  }
}
