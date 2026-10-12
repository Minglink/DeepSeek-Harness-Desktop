/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  DEPLOYMENT_DEFAULTS_BUNDLE,
  insertDefaultsLayer,
  readProfilePatches,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadProfile,
  reportSkippedBundles,
  PluginPackages,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  resolveProfileDir,
  type ProfileContext,
  type Profile,
  type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The empty root entry list every profile tree patches over. */
export const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Write the empty root entry list the Loader anchors `baseUrl` on, keeping any
 * root config that carries entries.
 *
 * This file is a composition root, not an edit surface, so boot rewrites it —
 * but a profile that grew its rows here (a hand-assembled tree, or one an
 * out-of-tree manager wrote) would otherwise lose them on the next launch, with
 * nothing left to restore from. Entries found here are moved to a timestamped
 * sibling first, so the tree survives the boot that replaces it. The caller
 * must already hold the profile's write exclusion.
 * @param profileDir - the profile directory whose root config to seed.
 * @returns the backup path when an entry-carrying root config was kept, else
 *   undefined when the file was already the empty template or did not exist.
 */
export function seedProfileRoot(profileDir: string): string | undefined {
  const rootPath = join(profileDir, PROFILE_ROOT_FILENAME)
  let existing: string | undefined
  try {
    existing = readFileSync(rootPath, 'utf8')
  } catch {
    // Absent or unreadable: there is nothing to preserve, and the write below
    // either seeds a fresh profile or fails loudly on an unusable directory.
    existing = undefined
  }
  let backupPath: string | undefined
  if (existing !== undefined && existing !== PROFILE_ROOT_CONFIG && hasRootEntries(existing)) {
    const backupBase = `${rootPath}.bak-${Date.now()}`
    backupPath = backupBase
    let ordinal = 0
    while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`
    renameSync(rootPath, backupPath)
  }
  writeFileSync(rootPath, PROFILE_ROOT_CONFIG)
  return backupPath
}

/**
 * Whether a root config lists entries rather than only comments and an empty
 * list. Comments are stripped and a bare `[]` counts as empty, so neither the
 * shipped template nor a hand-annotated empty root is treated as content.
 * @param source - the root config text.
 * @returns true when at least one entry remains.
 */
function hasRootEntries(source: string): boolean {
  const body = source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .join('\n')
  return body !== '' && body !== '[]'
}

/**
 * Initialize a missing profile from one shipped template. This copies only
 * the template's bundle list; local state from the
 * same-named shipped profile is not read, and no inheritance metadata is
 * persisted. Shipped profile names are reserved, and the target directory is
 * claimed exclusively so existing or concurrent state is never reused.
 * @param name - the new profile name.
 * @param fromDefaultProfile - shipped profile template to copy.
 * @param home - Harness home containing the profile directory.
 * @throws when the template is unknown, the target name is shipped, or the target directory exists.
 */
export function initializeProfileFromDefault(
  name: string,
  fromDefaultProfile: string,
  home: string = resolveDshHome(),
): void {
  const dir = resolveProfileDir(name, home)
  const template = Object.hasOwn(PROFILE_TEMPLATES, fromDefaultProfile)
    ? PROFILE_TEMPLATES[fromDefaultProfile]
    : undefined
  if (template === undefined) {
    const expected = Object.keys(PROFILE_TEMPLATES).sort().map(value => JSON.stringify(value)).join(', ')
    throw new Error(
      `${NAME}: unknown default profile ${JSON.stringify(fromDefaultProfile)}; expected one of ${expected}`,
    )
  }
  if (Object.hasOwn(PROFILE_TEMPLATES, name)) {
    throw new Error(
      `${NAME}: profile ${JSON.stringify(name)} is shipped and cannot be a custom profile target; `
      + 'omit --from-default-profile to use it',
    )
  }
  mkdirSync(dirname(dir), { recursive: true })
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      throw new Error(
        `${NAME}: profile ${JSON.stringify(name)} already exists at ${manifestPath}; `
        + 'omit --from-default-profile to use it',
      )
    }
    throw new Error(
      `${NAME}: profile directory ${dir} already exists; choose an unused profile name`,
    )
  }
  try {
    initProfile(dir, template.bundles)
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${NAME}: profile initialization failed and ${dir} could not be removed`,
      )
    }
    throw error
  }
}
/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * vendored Loader's tree write-back (a plugin self-disposing persists the
 * current tree) can bake composed rows into this file — which would duplicate
 * every bundle insert on the next boot. The file exists on disk only because
 * the Loader needs a real include root to anchor `baseUrl` at the profile
 * directory (the config dump anchors on the same file, so both compose over
 * the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @param fromDefaultProfile - shipped template used once to initialize a missing profile.
 * @returns the loaded profile.
 * @throws when explicit initialization names an unknown template or an existing profile.
 */
export function prepareProfile(name: string, userLayer = true, fromDefaultProfile?: string): Profile {
  if (fromDefaultProfile !== undefined) initializeProfileFromDefault(name, fromDefaultProfile)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  reportSkippedBundles(NAME, profile)
  reportKeptRoot(seedProfileRoot(profile.dir), profile.dir)
  return profile
}

/** Report a root config the boot preserved instead of silently replacing. */
function reportKeptRoot(backupPath: string | undefined, profileDir: string): void {
  if (backupPath === undefined) return
  process.stderr.write(
    `${NAME}: warning: ${join(profileDir, PROFILE_ROOT_FILENAME)} listed entries, which this build composes from `
    + `package.json's dsh.profile.bundles and cordis.patch.yml instead; kept them at ${backupPath} and `
    + 'rewrote the composition root. Move those rows into cordis.patch.yml to mount them again.\n',
  )
}

/** One profile's patch layers, in application order. */
interface ComposedProfile {
  profile: Profile
  /** Immutable runtime resolution computed before any plugin imports. */
  resolution: RuntimeResolution
  /** Command-line overlay contents, frozen for this invocation. */
  overlays: PatchOptions[]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @param fromDefaultProfile - shipped template for a missing named profile.
 * @param resolvedProfile - application-owned profile and installation.
 * @returns the profile and its patch layers.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
  defaultsFiles: readonly string[] | undefined,
  defaultsAfterBundles: readonly string[] | undefined,
  fromDefaultProfile?: string,
  resolvedProfile?: ResolvedProfileRuntime,
): Promise<ComposedProfile> {
  const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile)
  if (resolvedProfile !== undefined) reportKeptRoot(seedProfileRoot(profile.dir), profile.dir)
  insertDefaultsLayer(profile, defaultsFiles, NAME, defaultsAfterBundles)
  const resolutionOptions = { installAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, profile }
  const resolution = await createRuntimeResolution(resolutionOptions)
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  return { profile, resolution, overlays }
}

/** An application-owned profile and its independent installation fallback. */
export interface ResolvedProfileRuntime {
  /** Profile already loaded from the application's own directory. */
  profile: Profile
  /** Absolute package.json path of the application's dsh installation. */
  installAnchor: string
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** Loaded application profile; bypasses named profile initialization when supplied. */
  resolvedProfile?: ResolvedProfileRuntime | undefined
  /** Shipped template used once to initialize a missing profile. */
  fromDefaultProfile?: string | undefined
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /**
   * Deployment preference patch files, applied **below** the profile's own patch.
   *
   * An overlay outranks the reader's layer, so a preference shipped there cannot
   * be written back by the settings service. Preferences belong here; structural
   * rows (inserts, disables) stay in {@link RunProfileOptions.patchFiles}.
   */
  defaultsFiles?: readonly string[] | undefined
  /** Exact ordered stock bundle prefix below deployment defaults; later bundles retain precedence. */
  defaultsAfterBundles?: readonly string[] | undefined
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
  /** Application-owned package runtime, scoped to plugin package operations. */
  packageManager?: ProfileContext['packageManager']
  /**
   * Host glue that must be in place before the first config-tree entry mounts.
   *
   * A logger exporter has to attach here rather than after boot: an entry that
   * refuses to mount logs its reason while the tree is still settling, and a
   * sink installed afterwards would miss exactly those records.
   */
  prepareHost?: (ctx: Context) => void
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 * @throws after disposing startup resources; cleanup failures retain the original error.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  // Before the first plugin mounts and before anything can issue a request: Node's fetch ignores the
  // proxy environment on its own, so every profile would otherwise connect directly. Resolving from
  // the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer
  // work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start.
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )

  const app: { current?: Context } = {}
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const failures: unknown[] = []
    for (const release of [() => app.current?.fiber.dispose(), disposeProxy]) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh: profile cleanup failed')
  })()
  try {
    const composed = await composeProfile(
      options.profile, options.patchFiles, options.defaultsFiles, options.defaultsAfterBundles,
      options.fromDefaultProfile, options.resolvedProfile,
    )
    const appReady = createAppReady()
    const shutdown = createProcessShutdown(dispose)
    const signalShutdown = new AbortController()
    const interrupt = (code: number): void => {
      signalShutdown.abort()
      shutdown.interrupt(code)
    }
    // Signals own teardown throughout the startup window, not only after boot()
    // settles: an inserted provider can publish before sibling rows finish mounting.
    // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
    // surface — the launcher does not know whether the app considered its work
    // complete; SIGINT is a user interrupt and reports 130.
    process.on('SIGTERM', () => { interrupt(0) })
    process.on('SIGINT', () => { interrupt(130) })
    installFailLoud(NAME, process, async () => {
      await app.current?.fiber.dispose()
    })

    const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
    const profileContext: ProfileContext = {
      name: options.profile,
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
      dir: composed.profile.dir, patchPath: composed.profile.patchPath,
      installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,
      // The deployment preference layer names no package, so it stays out of
      // `startedBundles`: HMR fingerprints that list to decide whether a reload
      // is due, and a synthetic name there reads as a bundle-set change on every
      // boot — which reloads the whole tree, re-executing entries that register
      // on their own instance and cannot be run twice (`session-controller`
      // fails that way with "file-upload: Agent resolver is already registered").
      startedBundles: composed.profile.layers
        .map(layer => layer.packageName)
        .filter(name => name !== DEPLOYMENT_DEFAULTS_BUNDLE),
      ...(options.defaultsFiles === undefined ? {} : { defaultsFiles: options.defaultsFiles }),
      ...(options.defaultsAfterBundles === undefined ? {} : { defaultsAfterBundles: options.defaultsAfterBundles }),
      ...(composed.profile.profileFirstBundles === undefined ? {} : { profileFirstBundles: composed.profile.profileFirstBundles }),
      cwd: process.cwd(), home: resolveDshHome(),
      overlays: composed.overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    }
    const ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), async (hostCtx) => {
      app.current = hostCtx
      options.prepareHost?.(hostCtx)
      hostCtx.provide('profileContext', profileContext)
      // Before any config-tree entry mounts, so plugins resolve all launch-time
      // environment values from the same immutable launch snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
      await hostCtx.plugin(PluginPackages, {
        resolution: composed.resolution,
      })
      // The command line and bounded exit request are launcher facts available
      // to every app plugin that injects the argument snapshot.
      provideCmdline(hostCtx, {
        args: options.args,
        exit: code => void shutdown.shutdown(code),
        ready: appReady.service,
      })
    })
    app.current = ctx
    if (!signalShutdown.signal.aborted
      && ctx.fiber.state === FiberState.ACTIVE
      && ctx.get('loader') !== undefined) {
      appReady.commit()
    }
    return { ctx, shutdown }
  } catch (error) {
    try { await dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'dsh: profile startup and cleanup failed')
    }
    throw error
  }
}
