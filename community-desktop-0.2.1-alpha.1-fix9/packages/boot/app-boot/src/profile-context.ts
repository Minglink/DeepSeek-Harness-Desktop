/** Launcher-owned profile locations and composition inputs. */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches, loadOverlayPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /**
   * Deployment preference patch files, layered **below** the profile's own patch.
   *
   * Every composition of this profile has to agree on them: the boot tree, the
   * HMR reconcile, and the settings editor's verification all rebuild the layer
   * stack, and a composition that omits them reads as a configuration change —
   * which reloads the tree and re-executes entries that cannot run twice.
   */
  readonly defaultsFiles?: readonly string[]
  /** Exact ordered stock bundle prefix after which deployment defaults apply; omitted keeps defaults below the user patch. */
  readonly defaultsAfterBundles?: readonly string[]
  /** Explicit profile-owned bundle identities; reused by reload, settings and native metadata. */
  readonly profileFirstBundles?: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** Label for the deployment preference layer; it names no resolvable package. */
export const DEPLOYMENT_DEFAULTS_BUNDLE = 'dsh-deployment-defaults'

/**
 * Insert the deployment preference layer directly below the profile's own patch.
 *
 * A layer above `patchPath` outranks every later settings write: ConfigEditor
 * recomposes, still sees the higher layer winning, and refuses the write. These
 * patches also have to reach every composition — see
 * {@link ProfileContext.defaultsFiles} for what an omission costs.
 * @param profile - the loaded profile whose layer array is mutated in place.
 * @param files - absolute patch files, in application order.
 * @param binName - diagnostic prefix for malformed or missing configuration.
 * @param afterBundles - exact ordered stock bundle prefix; later bundles override these defaults.
 */
export function insertDefaultsLayer(
  profile: Profile, files: readonly string[] | undefined, binName: string, afterBundles?: readonly string[],
): void {
  if (files === undefined || files.length === 0) return
  const patches = files.flatMap(file => loadOverlayPatches(binName, file))
  const layer = {
    packageName: DEPLOYMENT_DEFAULTS_BUNDLE,
    packageDir: packageRootOf(files[0] ?? profile.dir),
    patchPaths: [...files],
    patches,
  }
  if (afterBundles !== undefined) {
    if (afterBundles.length === 0 || afterBundles.some((name, index) => profile.layers[index]?.packageName !== name)) {
      throw new Error(`${binName}: deployment defaults require the declared stock bundle prefix ${JSON.stringify(afterBundles)}`)
    }
    profile.layers.splice(afterBundles.length, 0, layer)
    return
  }
  const userIndex = profile.layers.findIndex(candidate => candidate.patchPaths.includes(profile.patchPath))
  if (userIndex < 0) profile.layers.push(layer)
  else profile.layers.splice(userIndex, 0, layer)
}

/**
 * Nearest ancestor directory that holds a `package.json`.
 *
 * A layer's `packageDir` names a package root: the loader and the packaging
 * smoke path read `<packageDir>/package.json`, so a patch file that lives in a
 * subdirectory (the Desktop deployment keeps its patches under `config/`) must
 * not hand the layer that subdirectory.
 * @param file - absolute path of one deployment patch file.
 * @returns the package root above the file, or the file's own directory.
 */
function packageRootOf(file: string): string {
  let dir = dirname(file)
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(file)
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false,
    ...(context.profileFirstBundles === undefined ? {} : { profileFirstBundles: context.profileFirstBundles }),
  })
  // A composition rebuilt from disk (HMR, the settings editor) has to carry the
  // same deployment layer the boot tree was composed with, or the two disagree
  // and the reconcile re-executes entries.
  if (initialProfile === undefined) insertDefaultsLayer(profile, context.defaultsFiles, binName, context.defaultsAfterBundles)
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return patches
}
