/** Preserve externally installed file-directory packages across a stopped profile's pnpm operation. */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** An existing profile projection whose source directory belongs to a separate local installer. */
export interface ProfileLocalLink {
  readonly profile: string
  readonly name: string
  readonly dependency: string
  readonly target: string
  readonly device: number
  readonly inode: number
  readonly manifestSha256: string
}

/** Local source protection failures must stop a launch rather than become advisory pnpm failures. */
export class ProfileLocalLinkError extends Error {
  /** @param cause - Validation, detach or restoration failure of an existing local source. */
  constructor(cause: unknown) {
    super('desktop local package source protection failed: ' + (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'ProfileLocalLinkError'
  }
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function dependencies(profile: string): Readonly<Record<string, string>> {
  const manifest: unknown = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  if (!isRecord(manifest) || (manifest.dependencies !== undefined && !isRecord(manifest.dependencies))) {
    throw new Error('desktop local package profile manifest must contain a dependency mapping')
  }
  const entries = Object.entries(manifest.dependencies ?? {})
  if (entries.some(([, spec]) => typeof spec !== 'string')) throw new Error('desktop local package dependency must be a string')
  return Object.fromEntries(entries) as Readonly<Record<string, string>>
}
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix)
}
function manifestHash(target: string, name: string): string {
  const path = join(target, 'package.json')
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('desktop local package manifest must be a regular file')
  const bytes = readFileSync(path)
  const manifest: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isRecord(manifest) || manifest.name !== name) throw new Error('desktop local package identity does not match its dependency')
  return createHash('sha256').update(bytes).digest('hex')
}
function projection(profile: string, link: ProfileLocalLink): string {
  if (!PACKAGE_NAME.test(link.name) || !samePath(realpathSync(profile), link.profile)) {
    throw new Error('desktop local package projection belongs to a different profile')
  }
  const modules = join(link.profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  if (lstatSync(modules).isSymbolicLink() || !samePath(realpathSync(modules), modules)) {
    throw new Error('desktop local package node_modules must be a real profile directory')
  }
  const path = join(modules, ...link.name.split('/'))
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  if (!inside(modules, path) || !samePath(realpathSync(parent), parent)) {
    throw new Error('desktop local package projection escapes profile node_modules')
  }
  return path
}
function assertTarget(link: ProfileLocalLink): void {
  const entry = statSync(link.target)
  if (!entry.isDirectory() || !samePath(realpathSync(link.target), link.target)
    || entry.dev !== link.device || entry.ino !== link.inode || manifestHash(link.target, link.name) !== link.manifestSha256) {
    throw new Error('desktop local package source changed during installation')
  }
}

/** Capture only declared external file-directory dependencies whose installed link already targets that exact package.
 * Disabled packages remain protected because pnpm still processes their declared dependencies.
 * @param profile - Stopped profile whose package operation is protected by its owner lock.
 * @param excluded - Shipped or deliberately retired packages managed by the profile owner.
 * @returns Validated source identities; no package code or resource tree is read or executed.
 */
export function captureProfileLocalLinks(profile: string, excluded: readonly string[] = []): readonly ProfileLocalLink[] {
  const manifestPath = join(profile, 'package.json')
  if (!existsSync(manifestPath)) return []
  const root = realpathSync(profile)
  const links: ProfileLocalLink[] = []
  for (const [name, spec] of Object.entries(dependencies(profile))) {
    if (excluded.includes(name) || !PACKAGE_NAME.test(name) || typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const installed = join(root, 'node_modules', ...name.split('/'))
    if (lstatSync(installed, { throwIfNoEntry: false })?.isSymbolicLink() !== true) continue
    const targetPath = spec.startsWith('file://') ? fileURLToPath(spec) : resolve(root, spec.slice('file:'.length))
    if (!existsSync(targetPath)) throw new Error('desktop local package file dependency target does not exist')
    if (!statSync(targetPath).isDirectory()) continue
    const target = realpathSync(targetPath)
    if (inside(root, target) || samePath(root, target)) continue
    if (!samePath(realpathSync(installed), target)) throw new Error('desktop local package link does not match its file dependency')
    const entry = statSync(target)
    const link = { profile: root, name, dependency: spec, target,
      device: entry.dev, inode: entry.ino, manifestSha256: manifestHash(target, name) }
    projection(root, link)
    links.push(link)
  }
  return links
}

/** Unlink source projections before pnpm can recursively clean through Windows junctions.
 * @param profile - Stopped profile from which these snapshots were captured.
 * @param links - Exact pre-installation local package projections.
 */
export function detachProfileLocalLinks(profile: string, links: readonly ProfileLocalLink[]): void {
  for (const link of links) {
    if (dependencies(profile)[link.name] !== link.dependency) throw new Error('desktop local package dependency changed before installation')
    assertTarget(link)
    const path = projection(profile, link)
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry === undefined) continue
    if (!entry.isSymbolicLink() || !samePath(realpathSync(path), link.target)) {
      throw new Error('desktop local package projection changed before installation')
    }
    unlinkSync(path)
  }
}

/** Restore original sources after every package attempt, removing only pnpm's owned replacement projection.
 * @param profile - Stopped profile from which these snapshots were captured.
 * @param links - Validated pre-installation local source identities.
 */
export function restoreProfileLocalLinks(profile: string, links: readonly ProfileLocalLink[]): void {
  for (const link of links) {
    // Native installation may intentionally replace or remove this same package.
    if (dependencies(profile)[link.name] !== link.dependency) continue
    assertTarget(link)
    const path = projection(profile, link)
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry?.isSymbolicLink() === true && samePath(realpathSync(path), link.target)) continue
    const temporary = join(dirname(path), '.desktop-local-link-' + randomUUID())
    const backup = join(dirname(path), '.desktop-local-replaced-' + randomUUID())
    symlinkSync(link.target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
    let backedUp = false
    try {
      if (entry !== undefined) { renameSync(path, backup); backedUp = true }
      renameSync(temporary, path)
      if (!samePath(realpathSync(path), link.target)) throw new Error('desktop local package source could not be restored')
    } catch (error) {
      if (lstatSync(temporary, { throwIfNoEntry: false })?.isSymbolicLink() === true) unlinkSync(temporary)
      if (backedUp && !existsSync(path)) renameSync(backup, path)
      throw error
    }
    if (backedUp) {
      const replaced = lstatSync(backup)
      if (replaced.isSymbolicLink()) unlinkSync(backup)
      else {
        const modules = join(link.profile, 'node_modules')
        if (!inside(modules, backup) || !samePath(realpathSync(backup), backup)) {
          throw new Error('desktop local package replacement cleanup escapes profile node_modules')
        }
        rmSync(backup, { recursive: true, force: true })
      }
    }
  }
}
