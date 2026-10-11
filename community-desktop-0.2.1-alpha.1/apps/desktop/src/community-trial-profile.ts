/** Temporary candidate configuration removes recognized credentials and disables scripts without changing promoted bundle selections. */
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load, Type } from 'js-yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { planCommunityTrialBundles } from './community-trial-bundles.ts'
import { communityInfrastructureFailure } from './community-failure.ts'

class InertExpression {
  constructor(readonly text: string) {}
}

const SCHEMA = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value: string) => new InertExpression(value),
  instanceOf: InertExpression,
  represent: (value: object) => {
    if (!(value instanceof InertExpression)) throw new Error('Unsupported candidate YAML expression')
    return value.text
  },
}))
const PRIVATE_FILES = new Set(['.credentials.yaml', '.credentials.yml', 'desktop-config.json'])
const SECRET_KEYS = new Set(['apikey', 'key', 'password', 'token', 'accesstoken', 'refreshtoken', 'sessiontoken', 'clientsecret',
  'secret', 'auth', 'authorization', 'cookie', 'cookies', 'privatekey', 'credential', 'credentials', 'authtoken', 'authpassword'])

interface Snapshot {
  readonly path: string
  readonly bytes?: Buffer
}

interface JsonReplacement {
  readonly path: readonly string[]
  readonly original: unknown
  readonly sanitized: unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof InertExpression)
}

function secretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/gu, '')
  return SECRET_KEYS.has(normalized) || normalized.endsWith('authtoken') || normalized.endsWith('password')
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Candidate configuration must be a regular file')
    const bytes = await readFile(path)
    // Atomic restoration writes UTF-8 text; reject undecodable configuration before changing the candidate.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { path, bytes }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path }
    throw error
  }
}

function secretStrings(value: unknown, values: Set<string>, seen = new Set<object>()): void {
  if (typeof value === 'string') { if (value.length > 0) values.add(value); return }
  if (value instanceof InertExpression) {
    if (/^(['"])[^\r\n]*\1$/u.test(value.text)) values.add(value.text.slice(1, -1))
    return
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const item of Object.values(value)) secretStrings(item, values, seen)
}

function collect(value: unknown, values: Set<string>, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || value instanceof InertExpression || seen.has(value)) return
  seen.add(value)
  for (const [key, item] of Object.entries(value)) {
    if (secretKey(key)) secretStrings(item, values)
    else collect(item, values, seen)
  }
}

function scrubText(value: string, secrets: ReadonlySet<string>): string {
  if (secrets.has(value)) return '[redacted]'
  let result = value
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join('[redacted]')
  result = result.replace(/\bBearer\s+[a-z0-9._~-]+/giu, 'Bearer [redacted]')
  return result.replace(/https?:\/\/[^\s"'<>]+/giu, (source) => {
    try {
      const url = new URL(source)
      let changed = false
      if (url.username || url.password) { url.username = ''; url.password = ''; changed = true }
      for (const key of [...url.searchParams.keys()]) {
        if (secretKey(key)) { url.searchParams.delete(key); changed = true }
      }
      return changed ? url.href : source
    } catch (error) {
      if (error instanceof TypeError) return source
      throw error
    }
  })
}

function scrub(value: unknown, secrets: ReadonlySet<string>, replacements?: JsonReplacement[], path: readonly string[] = [],
  seen = new Map<object, unknown>()): unknown {
  if (typeof value === 'string') {
    const sanitized = scrubText(value, secrets)
    if (sanitized !== value) replacements?.push({ path, original: value, sanitized })
    return sanitized
  }
  if (value instanceof InertExpression) return new InertExpression(scrubText(value.text, secrets))
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return seen.get(value)
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
  seen.set(value, result)
  for (const [key, item] of Object.entries(value)) {
    const current = [...path, key]
    const sanitized = secretKey(key) ? item instanceof InertExpression ? new InertExpression('""') : Array.isArray(item) ? [] : record(item) ? {} : ''
      : scrub(item, secrets, replacements, current, seen)
    if (secretKey(key)) replacements?.push({ path: current, original: item, sanitized })
    Object.defineProperty(result, key, { value: sanitized, enumerable: true, writable: true, configurable: true })
  }
  return result
}

function putBack(root: unknown, replacement: JsonReplacement): void {
  let value: unknown = root
  for (const key of replacement.path.slice(0, -1)) {
    if (typeof value !== 'object' || value === null) return
    const next: unknown = Reflect.get(value, key)
    value = next
  }
  const key = replacement.path.at(-1)
  if (key === undefined || typeof value !== 'object' || value === null) return
  const current: unknown = Reflect.get(value, key)
  if (JSON.stringify(current) !== JSON.stringify(replacement.sanitized)) return
  Object.defineProperty(value, key, { value: replacement.original, enumerable: true, writable: true, configurable: true })
}

async function restoreFile(value: Snapshot): Promise<void> {
  if (value.bytes !== undefined) await writeFileAtomic(value.path, value.bytes.toString('utf8'), { mode: 0o600 })
  else {
    const current = await snapshot(value.path)
    if (current.bytes !== undefined) await rm(value.path)
  }
}

/**
 * Temporarily sanitize a private candidate's known credential fields and disable pnpm lifecycle scripts.
 * @param profile - Copied candidate profile, never the live desktop profile.
 * @param home - Private trial data home; trial.npmrc becomes the child user config.
 * @param liveProfile - Trusted active profile used to validate copied private bundle ownership.
 * @returns Idempotent restoration of exact YAML/private-file bytes and unchanged sanitized manifest fields,
 * preserving trial bundle updates.
 * Unknown credential names and opaque JavaScript expressions are not comprehensively identified; YAML expressions are never evaluated here.
 */
export async function prepareCommunityTrialProfile(profile: string, home: string, liveProfile?: string): Promise<() => Promise<void>> {
  const bundlePlan = await planCommunityTrialBundles(profile, liveProfile)
  const patch = await snapshot(join(profile, 'cordis.patch.yml')), workspace = await snapshot(join(profile, 'pnpm-workspace.yaml'))
  const manifest = await snapshot(join(profile, 'package.json')), npmrc = await snapshot(join(profile, '.npmrc'))
  const privateFiles = (await readdir(profile)).filter((name) => {
    const normalized = name.toLowerCase()
    return normalized === '.env' || normalized.startsWith('.env.') || PRIVATE_FILES.has(normalized)
  })
  const privateSnapshots = await Promise.all(privateFiles.map(name => snapshot(join(profile, name))))
  const patchValue: unknown = patch.bytes === undefined ? undefined : load(patch.bytes.toString('utf8'), { schema: SCHEMA })
  const workspaceValue: unknown = workspace.bytes === undefined ? {} : load(workspace.bytes.toString('utf8'), { schema: SCHEMA })
  if (!record(workspaceValue)) throw new Error('Candidate pnpm workspace must contain a YAML mapping')
  const manifestValue: unknown = manifest.bytes === undefined ? undefined : JSON.parse(manifest.bytes.toString('utf8'))
  if (manifestValue !== undefined && !record(manifestValue)) throw new Error('Candidate package manifest must contain a JSON object')
  const secrets = new Set<string>()
  collect(patchValue, secrets); collect(workspaceValue, secrets); collect(manifestValue, secrets)
  const sanitizedWorkspace = scrub(workspaceValue, secrets)
  if (!record(sanitizedWorkspace)) throw new Error('Candidate pnpm workspace must contain a YAML mapping')
  sanitizedWorkspace.ignoreScripts = true
  const replacements: JsonReplacement[] = [], sanitizedManifest = scrub(manifestValue, secrets, replacements)
  const sanitizedPatch = scrub(patchValue, secrets)
  await bundlePlan.rewriteNames(sanitizedPatch)
  let restoration: Promise<void> | undefined
  const restore = (): Promise<void> => {
    restoration ??= (async () => {
      await bundlePlan.restore()
      await restoreFile(patch)
      await restoreFile(workspace)
      await restoreFile(npmrc)
      for (const item of privateSnapshots) await restoreFile(item)
      if (replacements.length > 0) {
        const current: unknown = JSON.parse(await readFile(manifest.path, 'utf8'))
        if (!record(current)) throw new Error('Candidate package manifest must contain a JSON object')
        for (const replacement of replacements) putBack(current, replacement)
        await writeFileAtomic(manifest.path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
      }
    })().catch(() => { throw communityInfrastructureFailure('restoration') })
    return restoration
  }
  try {
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFileAtomic(join(home, 'trial.npmrc'), 'ignore-scripts=true\n', { mode: 0o600 })
    await writeFileAtomic(npmrc.path, 'ignore-scripts=true\n', { mode: 0o600 })
    for (const item of privateSnapshots) await rm(item.path)
    if (patchValue !== undefined) {
      await writeFileAtomic(patch.path, dump(sanitizedPatch, { schema: SCHEMA, noRefs: false }), { mode: 0o600 })
    }
    await writeFileAtomic(workspace.path, dump(sanitizedWorkspace, { schema: SCHEMA, noRefs: false }), { mode: 0o600 })
    if (replacements.length > 0) await writeFileAtomic(manifest.path, `${JSON.stringify(sanitizedManifest, null, 2)}\n`, { mode: 0o600 })
    await bundlePlan.apply()
    return restore
  } catch (error) {
    await restore()
    throw error
  }
}
