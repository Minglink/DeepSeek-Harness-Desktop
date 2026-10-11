/** Recognize profile-owned community runtime replacements without loading plugin code. */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const OWNER = 'dsh-purge-community-private-runtime-v1'
const ORIGINALS = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const TOKEN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u
const MAX_METADATA_BYTES = 16 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function patchFiles(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(patch => typeof patch === 'string' && patch.length > 0)
}

function json(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return value
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

function sameDirectory(left: unknown, right: string): boolean {
  return typeof left === 'string' && realpathSync.native(left) === realpathSync.native(right)
}

function ownedDirectory(root: string, path: string): string {
  const canonical = realpathSync.native(path)
  if (!inside(root, canonical) || !lstatSync(canonical).isDirectory()) throw new Error('private bundle path leaves its profile')
  return canonical
}

function ownedJson(root: string, path: string): unknown {
  const stat = lstatSync(path)
  if (!inside(root, realpathSync.native(path)) || !stat.isFile()) throw new Error('private bundle metadata leaves its profile')
  if (stat.size > MAX_METADATA_BYTES) throw new Error('private bundle metadata exceeds its read limit')
  return json(path)
}

function bundlePackage(root: string, directory: string, name: string, token: string, original: string, version: string): readonly string[] {
  const canonical = ownedDirectory(root, directory)
  const value = ownedJson(canonical, join(canonical, 'package.json'))
  const marker = record(value) ? value.deepseekStreamPrivateRuntime : undefined
  const dsh = record(value) ? value.dsh : undefined
  const bundle = record(dsh) ? dsh.bundle : undefined
  if (!record(value) || value.name !== name || value.version !== version || !record(marker)
    || marker.owner !== OWNER || marker.token !== token || marker.originalPackage !== original || !record(bundle)) {
    throw new Error('private bundle package identity differs from its runtime marker')
  }
  const patches: unknown = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!patchFiles(patches)) {
    throw new Error('private bundle patch declaration is unavailable')
  }
  for (const patch of patches) {
    if (isAbsolute(patch)) throw new Error('private bundle patch leaves its package')
    const path = resolve(canonical, patch)
    if (!inside(canonical, realpathSync.native(path)) || !lstatSync(path).isFile()) throw new Error('private bundle patch leaves its package')
  }
  return patches
}

/** Public identity of a selected runtime-owned bundle; contains no plugin configuration. */
export interface CommunityPrivateBundle {
  readonly alias: string
  readonly token: string
  readonly original: string
  readonly version: string
  readonly dependency: string
  readonly patches: readonly string[]
}

function replacement(state: Record<string, unknown>, alias: string): Record<string, unknown> {
  if (!Array.isArray(state.bundleReplacements)) throw new Error('private bundle replacement list is unavailable')
  const rows = state.bundleReplacements.filter(row => record(row) && row.alias === alias)
  if (rows.length !== 1 || !record(rows[0])) throw new Error('private bundle replacement is ambiguous')
  return rows[0]
}

function runtimeState(root: string, value: unknown, token: string, run: string): Record<string, unknown> {
  if (!record(value) || value.owner !== OWNER || value.token !== token || value.phase !== 'installed'
    || value.overlayKind !== 'bundle-alias' || !sameDirectory(value.profileDir, root) || !sameDirectory(value.runDir, run)) {
    throw new Error('private bundle runtime is incomplete or belongs to another profile')
  }
  return value
}

function registeredAliases(root: string): ReadonlySet<string> {
  try {
    const directory = ownedDirectory(root, join(root, '.dsh-purge-runtime'))
    const owner = ownedJson(directory, join(directory, 'owner.json'))
    const current = ownedJson(directory, join(directory, 'current.json'))
    if (!record(owner) || owner.owner !== OWNER || !sameDirectory(owner.profileDir, root)
      || !record(current) || current.owner !== OWNER || !sameDirectory(current.profileDir, root)
      || !Array.isArray(current.bundleReplacements)) return new Set()
    return new Set(current.bundleReplacements.flatMap(row => record(row) && typeof row.alias === 'string' ? [row.alias] : []))
  } catch (_error) {
    // Package owner markers below still require recovery when a runtime journal cannot be read.
    return new Set()
  }
}

function materializedOwnerAliases(root: string, selected: readonly string[]): ReadonlySet<string> {
  const known = new Set<string>()
  for (const alias of selected) {
    try {
      const value = ownedJson(root, join(root, 'node_modules', alias, 'package.json'))
      const marker = record(value) ? value.deepseekStreamPrivateRuntime : undefined
      if (record(marker) && marker.owner === OWNER) known.add(alias)
    } catch (_error) {
      // Missing ordinary packages remain repairable; journal/source owner evidence is checked separately.
    }
  }
  return known
}

function recovery(alias: string, cause: unknown): Error {
  return new Error(`desktop project: community private bundle ${alias} requires recovery before startup reconciliation`, { cause })
}

/**
 * Read selected, materialized bundle replacements owned by this profile's community runtime.
 * Known owner metadata must agree with its installed journal and package copies; invalid state stops reconciliation.
 * Unknown packages remain ordinary selections. No plugin code, configuration expressions, or lifecycle hooks execute.
 * @param profile - Desktop profile directory.
 * @param dependencies - Direct dependency specifications from the profile manifest.
 * @param selected - Ordered bundle selections from that manifest.
 * @returns Public identities and patch declarations of verified, selected private bundles.
 */
export function communityProfilePrivateBundles(
  profile: string,
  dependencies: Readonly<Record<string, string>>,
  selected: readonly string[],
): readonly CommunityPrivateBundle[] {
  const root = realpathSync.native(profile)
  const registered = new Set([...registeredAliases(root), ...materializedOwnerAliases(root, selected)])
  const originals = new Set<string>()
  const bundles: CommunityPrivateBundle[] = []
  for (const alias of selected) {
    const spec = dependencies[alias]
    if (typeof spec !== 'string' || !spec.startsWith('file:') || spec.endsWith('.tgz')) {
      if (registered.has(alias)) throw recovery(alias, new Error('private bundle dependency differs from its installed journal'))
      continue
    }
    const sourcePath = resolve(root, spec.slice('file:'.length))
    if (!inside(root, sourcePath)) {
      if (registered.has(alias)) throw recovery(alias, new Error('private bundle source leaves its profile'))
      continue
    }
    let value: unknown
    try {
      value = ownedJson(root, join(sourcePath, 'package.json'))
    } catch (error) {
      if (registered.has(alias)) throw recovery(alias, error)
      // Unavailable ordinary dependencies remain repairable through the native manager.
      continue
    }
    const marker = record(value) ? value.deepseekStreamPrivateRuntime : undefined
    if (!record(marker) || marker.owner !== OWNER) {
      if (registered.has(alias)) throw recovery(alias, new Error('private bundle source lost its owner metadata'))
      continue
    }
    try {
      const token = marker.token
      const original = marker.originalPackage
      if (typeof token !== 'string' || !TOKEN.test(token) || typeof original !== 'string' || !ORIGINALS.has(original)) {
        throw new Error('private bundle owner metadata is invalid')
      }
      if (alias !== `dsh-purge-private-${token}-bundle-0` && alias !== `dsh-purge-private-${token}-bundle-1`) {
        throw new Error('private bundle alias name differs from its runtime marker')
      }
      if (originals.has(original)) throw new Error('private bundle has multiple selected replacements')
      const privateRoot = ownedDirectory(root, join(root, '.dsh-purge-runtime'))
      const run = ownedDirectory(privateRoot, join(privateRoot, token))
      const owner = ownedJson(privateRoot, join(privateRoot, 'owner.json'))
      if (!record(owner) || owner.owner !== OWNER || !sameDirectory(owner.profileDir, root)) {
        throw new Error('private bundle owner does not match the profile')
      }
      const current = runtimeState(root, ownedJson(privateRoot, join(privateRoot, 'current.json')), token, run)
      const saved = runtimeState(root, ownedJson(run, join(run, 'state.json')), token, run)
      const row = replacement(current, alias)
      const recorded = replacement(saved, alias)
      const source = join(run, 'bundles', alias)
      const projection = join(root, 'node_modules', alias)
      ownedDirectory(run, source)
      const expected = `file:.dsh-purge-runtime/${token}/bundles/${alias}`
      if (row.original !== original || recorded.original !== original || row.dependency !== expected || recorded.dependency !== expected
        || spec !== expected || row.aliasVersion !== recorded.aliasVersion || typeof row.aliasVersion !== 'string'
        || !sameDirectory(row.aliasSource, source) || !sameDirectory(recorded.aliasSource, source)
        || !sameDirectory(row.aliasDir, projection) || !sameDirectory(recorded.aliasDir, projection)) {
        throw new Error('private bundle replacement differs from its installed journal')
      }
      const patches = bundlePackage(root, source, alias, token, original, row.aliasVersion)
      const projected = bundlePackage(root, projection, alias, token, original, row.aliasVersion)
      if (JSON.stringify(patches) !== JSON.stringify(projected)) throw new Error('private bundle patch declarations differ')
      originals.add(original)
      bundles.push({ alias, token, original, version: row.aliasVersion, dependency: expected, patches })
    } catch (error) {
      throw recovery(alias, error)
    }
  }
  return bundles
}

/** Original base bundles replaced by verified, selected profile-owned private bundles. */
export function communityProfileBundleReplacements(profile: string, dependencies: Readonly<Record<string, string>>,
  selected: readonly string[]): ReadonlySet<string> {
  return new Set(communityProfilePrivateBundles(profile, dependencies, selected).map(bundle => bundle.original))
}
