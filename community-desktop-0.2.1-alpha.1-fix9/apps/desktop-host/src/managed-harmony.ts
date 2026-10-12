/** Experimental owned Desktop bootstrap for one exact, qualified companion version. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire, findPackageJSON } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { companionFiles, providerFiles, targetFiles } from './managed-harmony-pins.ts'

const PROVIDER = '@ch4acko3/dsh-turn-fold'
const PROVIDER_VERSION = '0.6.4-community.desktop-harmony.4'
const COMPANION_VERSION = '0.8.17-community.desktop-managed.3'

interface PatchStatus {
  owner: string
  key: string
  state: string
  matches: number
  error?: string
  warnings?: string[]
}

interface HarmonyRuntime {
  installModuleHooks(): void
  installFileTransforms(): void
  discoverProfile(profile: string, includeHarmony: boolean, configured: string[]): void
  inspectPatchTargetsAsync(): Promise<unknown[]>
  getPatchStatuses(): PatchStatus[]
  resolveProfilePackageManifest: unknown
  plannedClientDependencies: unknown
}

export interface ManagedHarmony {
  patchFiles: string[]
  assertReady(): void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function json(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!record(value)) throw new Error(`Managed Harmony requires an object manifest: ${file}`)
  return value
}
function nested(value: unknown): Record<string, unknown> { return record(value) ? value : {} }

function pinFiles(root: string, files: readonly { relative: string; bytes: number; sha256: string }[]): void {
  for (const pin of files) {
    const file = join(root, pin.relative)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes) throw new Error(`Managed Harmony file identity refused: ${pin.relative}`)
    const bytes = readFileSync(file)
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error(`Managed Harmony checksum refused: ${pin.relative}`)
  }
}

/** Called before importing any first-party Cordis/Client/Settings application module. */
export async function prepareManagedHarmony(runtimeDir: string, profileDir: string, desktopPatches: string[]): Promise<ManagedHarmony> {
  const profileManifest = join(profileDir, 'package.json')
  const profile = json(profileManifest)
  const installManifest = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const selected = nested(nested(profile.dsh).profile).bundles
  if (!Array.isArray(selected) || !selected.every(name => typeof name === 'string')) throw new Error('Managed Harmony requires a valid selected Desktop bundle list')
  const providers = selected.map((name) => {
    let manifest: string | undefined
    try {
      try { manifest = findPackageJSON(name, pathToFileURL(profileManifest)) }
      catch (error) {
        if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      manifest ??= findPackageJSON(name, pathToFileURL(installManifest))
    }
    catch (error) {
      if (name === PROVIDER) throw error
      return undefined
    }
    if (manifest === undefined) {
      if (name === PROVIDER) throw new Error(`Managed Harmony cannot locate selected provider ${name}`)
      // Ordinary broken selections retain the normal loader's repairable skipped-bundle path.
      return undefined
    }
    let value: Record<string, unknown>
    try { value = json(manifest) }
    catch (error) { if (name === PROVIDER) throw error; return undefined }
    return { manifest, value }
  }).filter((item): item is { manifest: string; value: Record<string, unknown> } => item !== undefined).filter((item) => {
    const patches = nested(nested(item.value.dsh).harmony).patches
    return Array.isArray(patches) && patches.length > 0
  })
  if (providers.length === 0) return { patchFiles: [], assertReady() {} }
  for (const provider of providers) {
    if (provider.value.name !== PROVIDER || provider.value.version !== PROVIDER_VERSION) {
      throw new Error(`Unqualified managed Harmony provider: ${String(provider.value.name)}@${String(provider.value.version)}`)
    }
    if (nested(provider.value.dependencies)['dsh-harmony'] !== COMPANION_VERSION
      || nested(nested(nested(provider.value.dsh).harmony).requires)['dsh-harmony'] !== COMPANION_VERSION) throw new Error('Managed Harmony provider requires its exact real companion dependency')
    pinFiles(realpathSync(dirname(provider.manifest)), providerFiles)
  }
  const firstProvider = providers[0]
  if (firstProvider === undefined) throw new Error('Managed Harmony provider disappeared')
  const companionManifest = createRequire(pathToFileURL(firstProvider.manifest)).resolve('dsh-harmony/package.json')
  const companion = json(companionManifest)
  if (companion.name !== 'dsh-harmony' || companion.version !== COMPANION_VERSION) {
    throw new Error(`Unqualified Harmony companion: ${String(companion.name)}@${String(companion.version)}`)
  }
  const companionRoot = realpathSync(dirname(companionManifest))
  pinFiles(companionRoot, companionFiles)
  pinFiles(resolve(runtimeDir), targetFiles)
  process.env.DSH_HARMONY_DSH_ENTRY = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const harmony = await import(pathToFileURL(join(companionRoot, 'lib', 'runtime.js')).href) as HarmonyRuntime
  harmony.installModuleHooks()
  harmony.installFileTransforms()
  Object.assign(globalThis, {
    __dshHarmonyResolvePackageManifest: harmony.resolveProfilePackageManifest,
    __dshHarmonyClientDependencies: harmony.plannedClientDependencies,
  })
  // Trial candidates are siblings of the live desktop directory. Use their
  // actual directory name for the companion's public profile activation API.
  // Its full layer inventory supplies the real runtime targets and required
  // authored companion service layer without consulting the old live profile.
  if (nested(nested(companion.dsh).bundle).patch !== './harmony.patch.yml') throw new Error('Managed Harmony companion service layer changed')
  harmony.discoverProfile(profileDir, true, selected)
  const integration = await import(pathToFileURL(join(companionRoot, 'lib', 'dsh.js')).href) as {
    configuredProfileActivation(name: string, profileDir: string, patches: string[], userLayer: boolean): {
      candidates: string[]
      patches: string[]
    }
  }
  const activation = integration.configuredProfileActivation(basename(profileDir), profileDir, desktopPatches, true)
  harmony.discoverProfile(profileDir, true, activation.candidates)
  await harmony.inspectPatchTargetsAsync()
  const assertReady = (): void => {
    const statuses = harmony.getPatchStatuses()
    const own = statuses.filter(status => status.owner === PROVIDER)
    if (own.length !== 3 || own.some(status => status.state !== 'bound' || status.matches !== 1)) {
      throw new Error(`Turn Fold exact source patch binding refused: ${JSON.stringify(own)}`)
    }
    const failed = statuses.filter(status => status.state === 'failed')
    if (failed.length > 0) throw new Error(`Harmony source patch failure: ${JSON.stringify(failed)}`)
    console.log('Managed Desktop Harmony patch qualification', JSON.stringify(statuses))
  }
  assertReady()
  return { patchFiles: activation.patches, assertReady }
}
