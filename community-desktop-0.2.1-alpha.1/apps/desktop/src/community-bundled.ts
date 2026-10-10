/** Validate explicitly bundled npm dependencies without importing their code or running their hooks. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { satisfies, valid, validRange } from 'semver'

interface ValidationLimits { maxExtractedBytes: number; maxEntries: number }
interface PackageRecord { root: string; name: string; version: string; manifest: Record<string, unknown> }
interface TreeFile { path: string; bytes: number; sha256: string }

/** An inert archive validation failure, translated into the desktop installer's existing categories. */
export class BundledDependencyError extends Error {
  /**
   * @param problem - the rejected archive category.
   * @param message - the rejected file or declaration.
   */
  constructor(readonly problem: 'invalid-archive' | 'incompatible-package' | 'too-large' | 'cancelled', message: string) {
    super(message)
    this.name = 'BundledDependencyError'
  }
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const FORBIDDEN = new Set(['.git', '.bin', '.pnpm', '.npm', '.cache'])
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare']
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
function rejected(message: string): never { throw new BundledDependencyError('incompatible-package', message) }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BundledDependencyError('cancelled', 'Community installation was cancelled')
}
function nameOf(value: unknown): value is string { return typeof value === 'string' && value.length <= 214 && PACKAGE_NAME.test(value) }

function dependencies(manifest: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const declared = manifest[field]
    if (declared === undefined) continue
    if (!object(declared)) rejected(`Bundled package ${String(manifest.name)} has invalid ${field}`)
    for (const [name, spec] of Object.entries(declared)) {
      if (!nameOf(name) || typeof spec !== 'string' || spec.length > 300 || spec.trim() === '' || /[/:\\\u0000-\u001f]/u.test(spec) || validRange(spec) === null) {
        rejected(`Bundled package ${String(manifest.name)} requires a plain semantic-version dependency for ${name}`)
      }
      if (field !== 'peerDependencies') result[name] = spec
    }
  }
  return result
}

function bundleNames(manifest: Record<string, unknown>): string[] {
  const read = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || !value.every(nameOf) || new Set(value).size !== value.length) {
      rejected('bundledDependencies must contain unique canonical npm package names')
    }
    return value
  }
  const first = read(manifest.bundledDependencies), alias = read(manifest.bundleDependencies)
  if (first !== undefined && alias !== undefined && JSON.stringify([...first].sort()) !== JSON.stringify([...alias].sort())) {
    rejected('bundledDependencies and bundleDependencies must name the same packages')
  }
  return first ?? alias ?? []
}

async function declaredFiles(root: string, manifest: Record<string, unknown>): Promise<void> {
  const target = async (value: unknown, exported = false): Promise<void> => {
    if (typeof value !== 'string' || value === '' || isAbsolute(value) || /[\\:\u0000-\u001f]/u.test(value) || (exported && !value.startsWith('./'))) rejected(`Bundled package ${String(manifest.name)} has an unsafe file target`)
    const file = resolve(root, value), local = relative(root, file)
    if (local === '' || local === '..' || local.startsWith('..'+sep)) rejected(`Bundled package ${String(manifest.name)} has a file target outside its own directory`)
    if (value.includes('*')) return
    if (/\.(?:ts|tsx|jsx)$/u.test(value) && !/\.d\.ts$/u.test(value)) rejected(`Bundled package ${String(manifest.name)} must ship compiled JavaScript entry points`)
    try { if (!(await lstat(file)).isFile()) rejected(`Bundled package ${String(manifest.name)} has a missing file target ${value}`) }
    catch (error) {
      if (error instanceof BundledDependencyError) throw error
      rejected(`Bundled package ${String(manifest.name)} has a missing file target ${value}`)
    }
  }
  const exportsOf = async (value: unknown): Promise<void> => {
    if (typeof value === 'string') await target(value, true)
    else if (Array.isArray(value)) { for (const entry of value) await exportsOf(entry) }
    else if (object(value)) { for (const entry of Object.values(value)) await exportsOf(entry) }
    else if (value !== null && value !== undefined) rejected(`Bundled package ${String(manifest.name)} has invalid exports`)
  }
  if (manifest.exports !== undefined) await exportsOf(manifest.exports)
  else if (manifest.main !== undefined) await target(manifest.main)
  if (typeof manifest.bin === 'string') await target(manifest.bin)
  else if (manifest.bin !== undefined) {
    if (!object(manifest.bin)) rejected(`Bundled package ${String(manifest.name)} has invalid bin targets`)
    for (const [name, file] of Object.entries(manifest.bin)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name)) rejected(`Bundled package ${String(manifest.name)} has an unsafe bin name`)
      await target(file)
    }
  }
}

async function tree(
  root: string, limits: ValidationLimits, signal: AbortSignal | undefined,
): Promise<{ modules: Set<string>; files: TreeFile[]; directories: string[] }> {
  const modules = new Set<string>(), files: TreeFile[] = [], directories: string[] = []
  let expanded = 0, entries = 0
  const walk = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      cancelled(signal)
      const file = join(directory, child.name), local = relative(root, file), parts = local.split(sep)
      if (parts.some(part => FORBIDDEN.has(part.toLowerCase()))) rejected(`Bundled archive contains forbidden metadata at ${local}`)
      const info = await lstat(file)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw new BundledDependencyError('invalid-archive', `Bundled archive contains a link or special file at ${local}`)
      }
      entries++
      if (info.isFile()) expanded += info.size
      if (entries > limits.maxEntries || expanded > limits.maxExtractedBytes) {
        throw new BundledDependencyError('too-large', 'Community archive exceeds the extracted dependency limit')
      }
      if (child.name.toLowerCase() === 'node_modules') {
        if (child.name !== 'node_modules' || !info.isDirectory()) rejected(`Bundled dependencies require a canonical node_modules directory at ${local}`)
        modules.add(file)
      }
      if (info.isDirectory()) {
        if (parts.includes('node_modules')) directories.push(local.split(sep).join('/'))
        await walk(file)
      }
      else if (parts.includes('node_modules')) files.push({ path: local.split(sep).join('/'), bytes: info.size, sha256: digest(await readFile(file)) })
    }
  }
  await walk(root)
  return { modules, files, directories }
}

async function packageAt(directory: string, expectedName: string): Promise<PackageRecord> {
  const file = join(directory, 'package.json')
  let manifest: unknown
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) rejected(`Bundled package ${expectedName} requires a bounded package.json`)
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error instanceof BundledDependencyError) throw error
    rejected(`Bundled package ${expectedName} requires a valid package.json`)
  }
  if (!object(manifest) || !nameOf(manifest.name) || manifest.name !== expectedName || typeof manifest.version !== 'string' || valid(manifest.version) !== manifest.version) {
    rejected(`Bundled package ${expectedName} has a mismatched name or invalid semantic version`)
  }
  const scripts = manifest.scripts
  if (scripts !== undefined && !object(scripts)) rejected(`Bundled package ${expectedName} has invalid scripts`)
  if (object(scripts) && INSTALL_HOOKS.some(hook => scripts[hook] !== undefined)) {
    rejected(`Bundled package ${expectedName} has installation hooks whose native approval has not been verified`)
  }
  try { await lstat(join(directory, 'binding.gyp')); rejected(`Bundled package ${expectedName} requires an unverified native build`) }
  catch (error) {
    if (error instanceof BundledDependencyError) throw error
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  dependencies(manifest)
  await declaredFiles(directory, manifest)
  return { root: directory, name: manifest.name, version: manifest.version, manifest }
}

/**
 * Validate only declared runtime packages below canonical node_modules directories and freeze their contents.
 * @param root - the installer's already identified, private, link-free package root.
 * @param manifest - the selected root package's parsed manifest.
 * @param limits - total extracted entries and bytes; includes files outside node_modules.
 * @param signal - cancellation observed during traversal.
 * @returns a content digest of bundled files and root bundle bindings, or the empty digest when no node_modules exists.
 * @throws {BundledDependencyError} for undeclared contents, identity/spec mismatches, links, hooks, limits or cancellation.
 * No package code, scripts, registries, profiles or user data are accessed.
 */
export async function validateBundledDependencies(
  root: string, manifest: Record<string, unknown>, limits: ValidationLimits, signal?: AbortSignal,
): Promise<string> {
  const inspected = await tree(root, limits, signal)
  if (inspected.modules.size === 0) return digest('no-bundled-dependencies')
  const names = bundleNames(manifest), rootDependencies = dependencies(manifest)
  await declaredFiles(root, manifest)
  if (names.length === 0) rejected('Archives containing node_modules require explicit bundledDependencies')
  const packages = new Map<string, PackageRecord>(), ownedModules = new Set<string>()
  const collect = async (owner: string): Promise<void> => {
    const modules = join(owner, 'node_modules')
    if (!inspected.modules.has(modules)) return
    ownedModules.add(modules)
    for (const child of await readdir(modules, { withFileTypes: true })) {
      cancelled(signal)
      if (!child.isDirectory()) rejected(`node_modules contains a non-package member ${child.name}`)
      const candidates = child.name.startsWith('@')
        ? (await readdir(join(modules, child.name), { withFileTypes: true })).map(entry => ({ name: child.name+'/'+entry.name, directory: join(modules, child.name, entry.name), directoryEntry: entry.isDirectory() }))
        : [{ name: child.name, directory: join(modules, child.name), directoryEntry: true }]
      if (candidates.length === 0) rejected(`node_modules contains an empty scope ${child.name}`)
      for (const candidate of candidates) {
        if (!candidate.directoryEntry || !nameOf(candidate.name)) rejected(`node_modules contains an invalid package directory ${candidate.name}`)
        const pkg = await packageAt(candidate.directory, candidate.name)
        packages.set(pkg.root, pkg)
        await collect(pkg.root)
      }
    }
  }
  await collect(root)
  if ([...inspected.modules].some(directory => !ownedModules.has(directory))) rejected('node_modules must be immediately owned by the root or a canonical bundled package')
  const resolvePackage = (owner: string, name: string): PackageRecord | undefined => {
    let current = owner
    for (;;) {
      const found = packages.get(join(current, 'node_modules', name))
      if (found !== undefined) return found
      if (current === root) return undefined
      const parent = dirname(current)
      if (relative(root, parent).startsWith('..') || parent === current) return undefined
      current = parent
    }
  }
  const reached = new Set<string>(), queue: PackageRecord[] = []
  for (const name of names) {
    const spec = rootDependencies[name], pkg = packages.get(join(root, 'node_modules', name))
    if (!Object.hasOwn(rootDependencies, name) || spec === undefined || pkg === undefined || !satisfies(pkg.version, spec)) rejected(`Bundled dependency ${name} does not match its root declaration`)
    queue.push(pkg)
  }
  while (queue.length !== 0) {
    cancelled(signal)
    const pkg = queue.pop()
    if (pkg === undefined || reached.has(pkg.root)) continue
    reached.add(pkg.root)
    for (const [name, spec] of Object.entries(dependencies(pkg.manifest))) {
      const dependency = resolvePackage(pkg.root, name)
      if (dependency === undefined) continue
      if (!satisfies(dependency.version, spec)) rejected(`Bundled dependency ${name}@${dependency.version} does not satisfy ${pkg.name}'s ${spec}`)
      queue.push(dependency)
    }
  }
  if (packages.size !== reached.size) rejected('Archive contains node_modules packages outside its declared bundled dependency closure')
  const bindings = names.sort().map(name => ({ name, spec: rootDependencies[name] }))
  return digest(JSON.stringify({
    bindings, directories: inspected.directories.sort(), files: inspected.files.sort((a,b) => a.path.localeCompare(b.path)),
  }))
}
