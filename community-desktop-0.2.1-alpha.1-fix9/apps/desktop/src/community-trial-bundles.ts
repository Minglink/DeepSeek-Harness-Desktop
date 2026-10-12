/** Rebase only verified private module names while a copied profile is under independent trial. */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dump, JSON_SCHEMA, load, Type } from 'js-yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { communityProfilePrivateBundles, type CommunityPrivateBundle } from './community-profile-bundles.ts'
import { communityInfrastructureFailure } from './community-failure.ts'

const OWNER = 'dsh-purge-community-private-runtime-v1'
const MAX_BYTES = 16 * 1024 * 1024
class InertExpression {
  constructor(readonly text: string) {}
}
const SCHEMA = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (text: string) => new InertExpression(text), instanceOf: InertExpression,
  represent: (value: object) => {
    if (!(value instanceof InertExpression)) throw new Error('Unsupported candidate YAML expression')
    return value.text
  },
}))

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}
async function directory(root: string, path: string): Promise<string> {
  const canonical = await realpath(path)
  if (!inside(root, canonical) || !(await lstat(canonical)).isDirectory()) throw new Error('Candidate directory boundary differs')
  return canonical
}
async function bytes(root: string, path: string): Promise<Buffer> {
  const canonical = await realpath(path), stat = await lstat(canonical)
  if (!inside(root, canonical) || !stat.isFile() || stat.size > MAX_BYTES) throw new Error('Candidate file boundary differs')
  const result = await readFile(canonical)
  new TextDecoder('utf-8', { fatal: true }).decode(result)
  return result
}
async function json(root: string, path: string): Promise<unknown> {
  const value: unknown = JSON.parse((await bytes(root, path)).toString('utf8'))
  return value
}
function manifest(value: unknown): { dependencies: Record<string, string>; selected: string[] } {
  const dsh = record(value) ? value.dsh : undefined, profile = record(dsh) ? dsh.profile : undefined
  const dependencies = record(value) ? value.dependencies ?? {} : undefined, selected = record(profile) ? profile.bundles : undefined
  if (!record(dependencies) || !Object.values(dependencies).every(spec => typeof spec === 'string')
    || !Array.isArray(selected) || !selected.every(name => typeof name === 'string')) throw new Error('Candidate manifest identity differs')
  return { dependencies: dependencies as Record<string, string>, selected }
}
async function packageDirectory(root: string, path: string, bundle: CommunityPrivateBundle): Promise<string> {
  const canonical = await directory(root, path), value = await json(canonical, join(canonical, 'package.json'))
  const marker = record(value) ? value.deepseekStreamPrivateRuntime : undefined
  const dsh = record(value) ? value.dsh : undefined, declaration = record(dsh) ? dsh.bundle : undefined
  const patches: unknown = record(declaration) && typeof declaration.patch === 'string' ? [declaration.patch]
    : record(declaration) ? declaration.patch : undefined
  if (!record(value) || value.name !== bundle.alias || value.version !== bundle.version || !record(marker)
    || marker.owner !== OWNER || marker.token !== bundle.token || marker.originalPackage !== bundle.original
    || JSON.stringify(patches) !== JSON.stringify(bundle.patches)) throw new Error('Candidate private package marker differs')
  return canonical
}

interface PatchSnapshot {
  readonly bundle: CommunityPrivateBundle
  readonly packagePath: string
  readonly patch: string
  readonly original: Buffer
  readonly trial: string
}
interface ModuleMapping { readonly live: string; readonly candidate: string }
interface JournalSnapshot { readonly path: string; readonly original: Buffer; readonly trial: Buffer }
export interface CommunityTrialBundlePlan {
  /** Mutates only ordinary inert YAML name scalars, before the candidate's first write. */
  rewriteNames(value: unknown): Promise<void>
  apply(): Promise<void>
  restore(): Promise<void>
}

/**
 * Plan a bounded trial-only relocation of verified private module URLs and ownership journals.
 * @param candidate - Copied profile whose journals retain the live owner's identity.
 * @param liveProfile - Trusted active profile supplied by main, never inferred from copied metadata.
 * @returns Prepared candidate-only writes and exact restoration; initial validation precedes any mutation.
 */
export async function planCommunityTrialBundles(candidate: string, liveProfile?: string): Promise<CommunityTrialBundlePlan> {
  try {
    if (liveProfile === undefined) return { rewriteNames: async () => {}, apply: async () => {}, restore: async () => {} }
    const root = await realpath(candidate), live = await realpath(liveProfile)
    if (root === live || inside(root, live) || inside(live, root)) throw new Error('Candidate must be an independent profile')
    const selected = manifest(await json(live, join(live, 'package.json')))
    const bundles = communityProfilePrivateBundles(live, selected.dependencies, selected.selected)
    if (bundles.length === 0) return { rewriteNames: async () => {}, apply: async () => {}, restore: async () => {} }
    const copied = manifest(await json(root, join(root, 'package.json')))
    const mappings: ModuleMapping[] = [], snapshots: PatchSnapshot[] = [], journals = new Map<string, JournalSnapshot>()
    for (const token of new Set(bundles.map(bundle => bundle.token))) {
      const liveRun = await directory(live, join(live, '.dsh-purge-runtime', token))
      const candidateRun = await directory(root, join(root, '.dsh-purge-runtime', token))
      mappings.push({ live: liveRun, candidate: candidateRun })
      for (const name of ['.dsh-purge-runtime/owner.json', '.dsh-purge-runtime/current.json', `.dsh-purge-runtime/${token}/state.json`]) {
        const original = await bytes(live, join(live, name)), path = join(root, name)
        const entry = await lstat(path)
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Candidate runtime journal must be a regular file')
        if (!original.equals(await bytes(root, path))) throw new Error('Candidate runtime journal differs')
        if (journals.has(path)) continue
        const value: unknown = JSON.parse(original.toString('utf8'))
        if (!record(value) || value.owner !== OWNER || typeof value.profileDir !== 'string'
          || await realpath(value.profileDir) !== live) throw new Error('Candidate runtime owner differs')
        value.profileDir = root
        if (name !== '.dsh-purge-runtime/owner.json') {
          if (value.token !== token || typeof value.runDir !== 'string' || await realpath(value.runDir) !== liveRun
            || !Array.isArray(value.bundleReplacements)) throw new Error('Candidate runtime generation differs')
          value.runDir = candidateRun
          for (const item of value.bundleReplacements) {
            const bundle = record(item) ? bundles.find(row => row.alias === item.alias && row.token === token) : undefined
            if (bundle === undefined) continue
            if (!record(item) || typeof item.aliasDir !== 'string' || typeof item.aliasSource !== 'string'
              || await realpath(item.aliasDir) !== await realpath(join(live, 'node_modules', bundle.alias))
              || await realpath(item.aliasSource) !== await realpath(join(liveRun, 'bundles', bundle.alias))) {
              throw new Error('Candidate runtime replacement ownership differs')
            }
            item.aliasDir = join(root, 'node_modules', bundle.alias)
            item.aliasSource = join(candidateRun, 'bundles', bundle.alias)
          }
        }
        // Other journal fields remain opaque: configuration, rollback snapshots and runtime payloads are not rewritten.
        const trial = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
        if (trial.length > MAX_BYTES) throw new Error('Candidate runtime journal exceeds its byte limit')
        journals.set(path, { path, original, trial })
      }
    }
    const rewriteNames = async (value: unknown, strict = false): Promise<void> => {
      const seen = new Set<object>()
      const visit = async (item: unknown): Promise<void> => {
        if ((!record(item) && !Array.isArray(item)) || seen.has(item)) return
        seen.add(item)
        if (record(item) && typeof item.name === 'string' && item.name.startsWith('file:')) {
          const name = item.name
          const claimed = mappings.some(mapping => name.startsWith(`${pathToFileURL(mapping.live).href}/`))
          let matched = false
          try {
            const url = new URL(name), path = fileURLToPath(url), liveCanonical = await realpath(path)
            for (const mapping of mappings) {
              if (!inside(mapping.live, liveCanonical)) continue
              if (url.search || url.hash || url.hostname || !(await lstat(liveCanonical)).isFile()) throw new Error('Private module URL is not a local module path')
              const target = resolve(mapping.candidate, relative(mapping.live, liveCanonical)), targetCanonical = await realpath(target)
              if (!inside(mapping.candidate, targetCanonical) || !(await lstat(targetCanonical)).isFile()) throw new Error('Candidate private module boundary differs')
              item.name = pathToFileURL(target).href
              matched = true
              break
            }
          } catch (_error) { if (strict || claimed) throw new Error('Private module URL is invalid') }
          if (!matched && (strict || claimed)) throw new Error('Private module URL leaves its verified runtime')
        }
        for (const child of Object.values(item)) await visit(child)
      }
      await visit(value)
    }
    for (const bundle of bundles) {
      if (copied.dependencies[bundle.alias] !== bundle.dependency || copied.selected.filter(name => name === bundle.alias).length !== 1) {
        throw new Error('Candidate selected private bundle differs')
      }
      const source = join(root, '.dsh-purge-runtime', bundle.token, 'bundles', bundle.alias)
      const projection = join(root, 'node_modules', bundle.alias)
      const sourceCanonical = await packageDirectory(root, source, bundle)
      const projectionCanonical = await packageDirectory(root, projection, bundle)
      const run = await realpath(join(root, '.dsh-purge-runtime', bundle.token))
      if (!inside(run, sourceCanonical)) throw new Error('Candidate source leaves its verified runtime')
      for (const patch of bundle.patches) {
        const original = await bytes(sourceCanonical, resolve(sourceCanonical, patch))
        const projected = await bytes(projectionCanonical, resolve(projectionCanonical, patch))
        const liveSource = join(live, '.dsh-purge-runtime', bundle.token, 'bundles', bundle.alias)
        if (!original.equals(projected) || !original.equals(await bytes(liveSource, resolve(liveSource, patch)))) {
          throw new Error('Candidate private patch copies differ')
        }
        const value: unknown = load(original.toString('utf8'), { schema: SCHEMA })
        await rewriteNames(value, true)
        const trial = dump(value, { schema: SCHEMA, noRefs: false })
        snapshots.push({ bundle, packagePath: source, patch, original, trial }, { bundle, packagePath: projection, patch, original, trial })
      }
    }
    const destinations = async (): Promise<Map<string, PatchSnapshot>> => {
      const targets = new Map<string, PatchSnapshot>()
      for (const snapshot of snapshots) {
        const canonical = await packageDirectory(root, snapshot.packagePath, snapshot.bundle)
        if (snapshot.packagePath !== join(root, 'node_modules', snapshot.bundle.alias)) {
          const run = await directory(root, join(root, '.dsh-purge-runtime', snapshot.bundle.token))
          if (!inside(run, canonical)) throw new Error('Candidate source leaves its verified runtime')
        }
        const path = await realpath(resolve(canonical, snapshot.patch))
        await bytes(canonical, path)
        const previous = targets.get(path)
        if (previous !== undefined && !previous.original.equals(snapshot.original)) throw new Error('Candidate restoration copies conflict')
        targets.set(path, snapshot)
      }
      return targets
    }
    const journalDestinations = async (): Promise<readonly JournalSnapshot[]> => {
      const targets: JournalSnapshot[] = []
      for (const snapshot of journals.values()) {
        const entry = await lstat(snapshot.path)
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Candidate runtime journal must remain a regular file')
        const current = await bytes(root, snapshot.path)
        if (!current.equals(snapshot.original) && !current.equals(snapshot.trial)) throw new Error('Candidate runtime journal changed during trial')
        targets.push(snapshot)
      }
      return targets
    }
    let restoration: Promise<void> | undefined
    return {
      rewriteNames: async (value) => {
        try { await rewriteNames(value) }
        catch (error) { throw communityInfrastructureFailure('preparation', error) }
      },
      apply: async () => {
        try {
          const targets = await destinations()
          const metadata = await journalDestinations()
          for (const [path, snapshot] of targets) await writeFileAtomic(path, snapshot.trial, { mode: 0o600 })
          for (const snapshot of metadata) await writeFileAtomic(snapshot.path, snapshot.trial.toString('utf8'), { mode: 0o600 })
          // Use the same strict identity boundary as DesktopHostProcess.start before either trial child can spawn.
          communityProfilePrivateBundles(root, copied.dependencies, copied.selected)
        } catch (error) { throw communityInfrastructureFailure('preparation', error) }
      },
      restore: () => {
        restoration ??= (async () => {
          try {
            const targets = await destinations()
            const metadata = await journalDestinations()
            for (const [path, snapshot] of targets) await writeFileAtomic(path, snapshot.original.toString('utf8'), { mode: 0o600 })
            for (const snapshot of metadata) await writeFileAtomic(snapshot.path, snapshot.original.toString('utf8'), { mode: 0o600 })
          } catch (error) { throw communityInfrastructureFailure('restoration', error) }
        })()
        return restoration
      },
    }
  } catch (error) { throw communityInfrastructureFailure('preparation', error) }
}
