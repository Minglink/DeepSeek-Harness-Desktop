/** Desktop profile initialization and native recovery. */

import { createHash } from 'node:crypto'
import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { dump as dumpYaml, load as loadYaml, JSON_SCHEMA, Type } from 'js-yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import { desktopNodeEnvironment } from './node-environment.ts'
import { DesktopStartupPackageError, resolveDesktopStartupInstallConfig, runDesktopStartupPackageOperation,
  type DesktopStartupInstallConfig, type StartupPackageDiagnostic } from './startup-package-operation.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import { communityProfileBundleReplacements } from './community-profile-bundles.ts'
import {
  captureProfileLocalLinks, detachProfileLocalLinks, restoreProfileLocalLinks, ProfileLocalLinkError, type ProfileLocalLink,
} from './profile-local-links.ts'
import {
  initProfile, PROFILE_TEMPLATES, removeLinkProjections, resolveBundleDir, sanitizeProfile, type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const COMMUNITY_PACKAGE = 'dsh-community'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
/**
 * Plugins this build bundles into every profile. They ship as tarballs inside
 * the runtime's `desktop-packages/`, are installed by the profile, and stay
 * profile-owned: sealing them into the runtime's shared-package list would make
 * the profile link them from the runtime, which the plugin-graph check reads as
 * a plugin that left its own profile.
 */
export const DESKTOP_BUNDLED_PLUGINS = [
  'dsh-pocket', 'dsh-community',
  // Preset-scoped bridges: a preset row resolves plugin names through the profile, so a
  // bridge that used to sit inside the preset directory ships here and is named by package.
  'dsh-learning-bridge', 'dsh-pentest-learning-bridge', 'dsh-modwatch-bridge',
  'dsh-context',
] as const
/** Complete profile bundle list: built-in base/web-app plus bundled plugins. */
const DESKTOP_FULL_BUNDLES = [...WEB_PROFILE.bundles, ...DESKTOP_BUNDLED_PLUGINS] as const
/**
 * Plugins this build deliberately retired. A profile upgraded from an older
 * build may still carry one, and re-adding it would ask the registry (or the
 * offline mirror) for metadata the deployment cannot supply — which fails the
 * whole package operation and leaves the app unable to start.
 */
const DESKTOP_RETIRED_PLUGINS: readonly string[] = [
  'deepseek-ai-cordis',
  'dshmarket',
]
/** Folder, inside the bundled runtime, that carries the bundled plugin tarballs. */
const DESKTOP_BUNDLED_PACKAGE_DIR = 'desktop-packages'
/** Profile-relative folder those tarballs are copied into. */
const PROFILE_PACKAGE_DIR = 'desktop-packages'
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Profile manifest fields the bundled-plugin machinery reads and rewrites. */
interface DesktopProfileManifest {
  readonly dependencies: Record<string, string>
  readonly dsh: { readonly profile: { readonly bundles: readonly string[] } }
}

function projectManifest(projectDir: string): DesktopProfileManifest {
  const path = join(projectDir, 'package.json')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  if (!isRecord(value) || (value.dependencies !== undefined && !isRecord(value.dependencies))
    || !Array.isArray(profile?.bundles) || !profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error(`desktop project: invalid desktop profile manifest ${path}`)
  }
  return {
    ...value,
    dependencies: (value.dependencies ?? {}) as Record<string, string>,
    dsh: { ...dsh, profile: { ...profile, bundles: profile.bundles } },
  }
}

/**
 * Resolve the runtime folder carrying the bundled plugin tarballs.
 * @param runtimeDir - runtime directory that also serves the dsh entry point.
 * @returns the tarball folder, or undefined when this runtime ships none.
 */
function bundledPackageDirectory(runtimeDir: string): string | undefined {
  const source = join(runtimeDir, DESKTOP_BUNDLED_PACKAGE_DIR)
  return existsSync(source) ? source : undefined
}

/**
 * Bundled plugins the profile declares but has not materialized.
 *
 * A recorded profile is only reusable once the bundled plugins it names are
 * materialized: `resolveBundleDir` reads a named bundle straight out of the
 * profile, so a profile recorded before its first install — a cleaned or
 * migrated tree — would otherwise start a host child with no plugin to load.
 * A plugin that goes missing after a refresh is the same failure, and it is
 * invisible at the model surface: a profile without `dsh-infinite-gen-3` still
 * starts, and every session simply loses the plugin's prompt section.
 * @param projectDir - profile directory being reconciled.
 * @returns declared-but-absent plugin names, empty when the profile is complete.
 */
export function missingBundledPlugins(projectDir: string): string[] {
  const dependencies = projectManifest(projectDir).dependencies
  return DESKTOP_BUNDLED_PLUGINS.filter(plugin => plugin in dependencies
    && !existsSync(join(projectDir, 'node_modules', ...plugin.split('/'))))
}

/**
 * Whether a profile still needs its first bundled-plugin install.
 * @param projectDir - profile directory being reconciled.
 * @returns true when the profile still needs its first install.
 */
function profileAwaitingFirstInstall(projectDir: string): boolean {
  return missingBundledPlugins(projectDir).length > 0
}

/**
 * The tarball for one bundled plugin inside the runtime's package folder.
 *
 * Multiple shipped plugin versions use numeric version segments to select the newest tarball.
 * @param source - the runtime's `desktop-packages` folder.
 * @param plugin - the bundled plugin's package name.
 * @returns the tarball's file name, or undefined when the plugin is not bundled.
 */
function bundledTarball(source: string, plugin: string): string | undefined {
  const candidates = readdirSync(source)
    .filter(entry => entry.startsWith(`${plugin}-`) && entry.endsWith('.tgz'))
  if (candidates.length <= 1) return candidates[0]
  return candidates.reduce((best, entry) => compareVersions(entry, best) > 0 ? entry : best)
}

/** Compare two `<plugin>-<version>.tgz` names by numeric version segments. */
function compareVersions(left: string, right: string): number {
  const segments = (name: string): number[] => (name.slice(0, -'.tgz'.length).split('-').filter(part => /^\d/u.test(part)))
    .flatMap(part => part.split('.').map(Number))
  const a = segments(left); const b = segments(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Copy the bundled plugin tarballs into a profile and return their dependency rows.
 * @param projectDir - profile being created.
 * @param source - the runtime's `desktop-packages` folder, when this build ships one.
 * @returns dependency rows for the bundled plugins that were available.
 */
function copyBundledPackageTarballs(
  projectDir: string,
  source: string | undefined,
): Record<string, string> {
  const dependencies: Record<string, string> = {}
  if (source === undefined) return dependencies
  const target = join(projectDir, PROFILE_PACKAGE_DIR)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const plugin of DESKTOP_BUNDLED_PLUGINS) {
    const file = bundledTarball(source, plugin)
    if (file === undefined) continue
    const bytes = readFileSync(join(source, file))
    const ownedFile = profileTarballName(file, bytes)
    writeFileSync(join(target, ownedFile), bytes, { mode: 0o600 })
    dependencies[plugin] = `file:./${PROFILE_PACKAGE_DIR}/${ownedFile}`
  }
  return dependencies
}

/** A changed archive gets a new pnpm file identity even when its package version is unchanged. */
function profileTarballName(file: string, bytes: Buffer): string {
  return `${file.slice(0, -'.tgz'.length)}-sha256-${createHash('sha256').update(bytes).digest('hex')}.tgz`
}

/** Remove a materialized package without traversing a profile's package junction. */
function removeBundledPackage(projectDir: string, plugin: string): void {
  const path = join(projectDir, 'node_modules', ...plugin.split('/'))
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) unlinkSync(path)
  else if (stat?.isDirectory()) rmSync(path, { recursive: true, force: true })
}

/** Keep existing optional selections while selecting newly shipped bundles and the required market. */
function shippedProfileBundles(manifest: DesktopProfileManifest, dependencies: Readonly<Record<string, string>>,
  replacements: ReadonlySet<string>): string[] {
  const required = [...WEB_PROFILE.bundles.filter(bundle => !replacements.has(bundle)),
    ...DESKTOP_BUNDLED_PLUGINS.filter(plugin => plugin in dependencies
      && (plugin === COMMUNITY_PACKAGE || !(plugin in manifest.dependencies))),
  ]
  return mergeProfileBundles(manifest.dsh.profile.bundles.filter(bundle => !replacements.has(bundle)), required)
}

/**
 * Bring a profile's bundled plugin tarballs up to the ones this build ships.
 *
 * A profile keeps its own copy of every bundled tarball, so a release that
 * ships a new plugin build would otherwise keep installing the copy the profile
 * captured when it was created. Each archive's content digest is part of its
 * profile dependency path, so pnpm installs changed same-version archives.
 * @param projectDir - active desktop profile.
 * @param source - the runtime's `desktop-packages` folder, when this build ships one.
 * @param replacements - Original bundles replaced by verified selected private aliases.
 * @returns whether the profile manifest changed.
 */
function refreshBundledPackages(projectDir: string, source: string | undefined, replacements?: ReadonlySet<string>): boolean {
  if (source === undefined) return false
  const manifest = projectManifest(projectDir)
  const replaced = replacements ?? communityProfileBundleReplacements(projectDir, manifest.dependencies, manifest.dsh.profile.bundles)
  const dependencies = { ...manifest.dependencies }
  const target = join(projectDir, PROFILE_PACKAGE_DIR)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  let changed = false
  for (const plugin of DESKTOP_BUNDLED_PLUGINS) {
    const file = bundledTarball(source, plugin)
    if (file === undefined) continue
    const bytes = readFileSync(join(source, file))
    const ownedFile = profileTarballName(file, bytes)
    const installed = join(target, ownedFile)
    const current = existsSync(installed) ? readFileSync(installed) : undefined
    const spec = `file:./${PROFILE_PACKAGE_DIR}/${ownedFile}`
    if (current === undefined || !current.equals(bytes)) {
      writeFileSync(installed, bytes, { mode: 0o600 })
      removeBundledPackage(projectDir, plugin)
      changed = true
    }
    if (dependencies[plugin] !== spec) {
      dependencies[plugin] = spec
      removeBundledPackage(projectDir, plugin)
      changed = true
    }
  }
  const bundles = shippedProfileBundles(manifest, dependencies, replaced)
  const selectionChanged = bundles.length !== manifest.dsh.profile.bundles.length
    || bundles.some((name, index) => name !== manifest.dsh.profile.bundles[index])
  if (changed || selectionChanged) {
    // Existing optional dependencies keep their selections; new bundles and
    // the required market enter the profile's ordered bundle list.
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies,
      dsh: {
        ...manifest.dsh,
        profile: { ...manifest.dsh.profile, bundles },
      },
    })
    // Changed file dependency paths require fresh lockfile resolutions for
    // the shipped archives and their recorded integrity.
    if (changed) rmSync(join(projectDir, 'pnpm-lock.yaml'), { force: true })
  }
  return changed
}

/**
 * Drop every retired plugin from a profile's dependencies and bundles.
 * @param projectDir - existing profile directory.
 * @returns true when the manifest was rewritten.
 */
async function pruneRetiredPlugins(projectDir: string): Promise<boolean> {
  const manifest = projectManifest(projectDir)
  const retired = new Set(DESKTOP_RETIRED_PLUGINS)
  const bundles = manifest.dsh.profile.bundles.filter(bundle => !retired.has(bundle))
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies).filter(([name]) => !retired.has(name)),
  )
  const changed = bundles.length !== manifest.dsh.profile.bundles.length
    || Object.keys(dependencies).length !== Object.keys(manifest.dependencies).length
  const patchChanged = await pruneRetiredPatchRows(projectDir, retired)
  if (changed) {
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } },
    })
    rmSync(join(projectDir, 'pnpm-lock.yaml'), { force: true })
  }
  for (const name of retired) {
    const path = join(projectDir, 'node_modules', ...name.split('/'))
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) unlinkSync(path)
    else if (stat?.isDirectory()) rmSync(path, { recursive: true, force: true })
  }
  return changed || patchChanged
}

const PROFILE_PATCH_SCHEMA = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: (value: unknown) => isRecord(value) && typeof value.__jsExpr === 'string',
  represent: (value: object) => (value as { __jsExpr: string }).__jsExpr,
}))

/** Remove retired package rows and their id-targeted overrides without evaluating YAML expressions. */
async function pruneRetiredPatchRows(projectDir: string, retired: ReadonlySet<string>): Promise<boolean> {
  const path = join(projectDir, 'cordis.patch.yml')
  if (!existsSync(path)) return false
  const original = readFileSync(path, 'utf8')
  // Avoid parsing unrelated user patches, including a damaged patch recoverable through the native recovery dialog.
  const ids = new Set([...retired, 'dsh-market', 'dsh-theme'])
  if (![...ids].some(id => original.includes(id))) return false
  const parsed: unknown = loadYaml(original, { schema: PROFILE_PATCH_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error('desktop project: profile patch must contain a YAML array')
  const migration = { changed: false }
  const filterRows = (rows: readonly unknown[]): unknown[] => rows.flatMap((row) => {
    if (!isRecord(row)) throw new Error('desktop project: profile patch entries must be YAML mappings')
    if (typeof row.name === 'string' && retired.has(row.name)
      || typeof row.id === 'string' && ids.has(row.id)) { migration.changed = true; return [] }
    const next = { ...row }
    if (Array.isArray(row.insert)) {
      const inserted = filterRows(row.insert)
      next.insert = inserted
      if (inserted.length === 0 && Object.keys(next).length === 1) return []
    }
    if (row.group === true && Array.isArray(row.config)) next.config = filterRows(row.config)
    return [next]
  })
  const filtered = filterRows(parsed)
  if (!migration.changed) return false
  let backup = `${path}.bak-community-${Date.now()}`
  let ordinal = 0
  while (existsSync(backup)) backup = `${path}.bak-community-${Date.now()}-${++ordinal}`
  writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  await writeFileAtomic(path, `${dumpYaml(filtered, { schema: PROFILE_PATCH_SCHEMA, noRefs: true }).trimEnd()}\n`, { mode: 0o600 })
  return true
}

/** Restore only the required market's disabled overrides, preserving unrelated profile configuration. */
async function restoreCommunityPatch(projectDir: string): Promise<void> {
  const path = join(projectDir, 'cordis.patch.yml')
  if (!existsSync(path)) return
  const original = readFileSync(path, 'utf8')
  if (!original.includes(COMMUNITY_PACKAGE) || !original.includes('disabled')) return
  const parsed: unknown = loadYaml(original, { schema: PROFILE_PATCH_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error('desktop project: profile patch must contain a YAML array')
  const migration = { changed: false }
  const restoreRows = (rows: readonly unknown[]): unknown[] => rows.map((row) => {
    if (!isRecord(row)) throw new Error('desktop project: profile patch entries must be YAML mappings')
    const next = { ...row }
    if ((row.id === COMMUNITY_PACKAGE || row.name === COMMUNITY_PACKAGE) && 'disabled' in row && row.disabled !== false) {
      delete next.disabled
      migration.changed = true
    }
    if (Array.isArray(row.insert)) next.insert = restoreRows(row.insert)
    if (row.group === true && Array.isArray(row.config)) next.config = restoreRows(row.config)
    return next
  })
  const restored = restoreRows(parsed)
  if (!migration.changed) return
  let backup = `${path}.bak-market-${Date.now()}`
  let ordinal = 0
  while (existsSync(backup)) backup = `${path}.bak-market-${Date.now()}-${++ordinal}`
  writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
  await writeFileAtomic(path, `${dumpYaml(restored, { schema: PROFILE_PATCH_SCHEMA, noRefs: true }).trimEnd()}\n`, { mode: 0o600 })
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime, with the pnpm entry
   *   that materializes the bundled plugin tarballs.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: {
      readonly dsh: string
      /** Bundled `pnpm.mjs`, used only for bundled plugin package operations. */
      readonly pnpm?: string
    },
    private readonly options: {
      config?: DesktopStartupInstallConfig
      signal?: AbortSignal
      log?: (diagnostic: StartupPackageDiagnostic) => void
      /** Explicit first-party runner for isolated source tests; production resolves it in the sealed runtime. */
      runner?: string
    } = {},
  ) {}

  /** Publish diagnostics through the main-owned bounded, sanitized runtime store. */
  private logDiagnostic(line: string): void {
    this.options.log?.({ source: 'system', level: 'warning', text: line })
  }

  /**
   * Back up the profile patch and disable third-party bundles while retaining a resolvable community market.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => {
      const bundles = [...WEB_PROFILE.bundles]
      if (existsSync(join(this.paths.profile, 'package.json'))) {
        const manifest = projectManifest(this.paths.profile)
        if (COMMUNITY_PACKAGE in manifest.dependencies) {
          try {
            const directory = resolveBundleDir('dsh', COMMUNITY_PACKAGE,
              join(this.runtime.dsh, 'node_modules', DSH_PACKAGE, 'package.json'), this.paths.profile)
            const candidate: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
            if (isRecord(candidate) && isRecord(candidate.dsh) && isRecord(candidate.dsh.bundle)
              && typeof candidate.dsh.bundle.patch === 'string' && existsSync(join(directory, candidate.dsh.bundle.patch))) {
              bundles.push(COMMUNITY_PACKAGE)
            }
          } catch (error) {
            // Recovery excludes a missing or damaged community package without loading its code.
            this.logDiagnostic(`community recovery bundle: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return sanitizeProfile('dsh', this.paths.profile, bundles)
    })
  }

  /**
   * Prepare the external profile and reconcile bundled packages after creation, refresh, or retirement.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(async () => {
      // Validation only: an unreadable or mismatched runtime descriptor stops preparation before the Host starts.
      readDesktopRuntime(this.runtime.dsh)
      const manifest = existsSync(join(this.paths.profile, 'package.json')) ? projectManifest(this.paths.profile) : undefined
      const replacements = manifest === undefined ? new Set<string>()
        : communityProfileBundleReplacements(this.paths.profile, manifest.dependencies, manifest.dsh.profile.bundles)
      migrateProfileSettings(this.paths.profile)
      // A refreshed bundled plugin is new content in an already installed
      // profile, so the shipped tarballs are reconciled on every launch: a
      // profile that skips this keeps installing the copy it captured when it
      // was created.
      const bundled = bundledPackageDirectory(this.runtime.dsh)
      const refreshed = existsSync(join(this.paths.profile, 'package.json'))
        && refreshBundledPackages(this.paths.profile, bundled, replacements)
      // A profile whose plugins are already installed needs no package
      // operation: the profile manifest is what a launch reuses. It still gets
      // its metadata normalized first — the profile file and the patch layer it
      // reads are written only when missing, so this costs nothing a launch
      // would not have written anyway.
      const installed = existsSync(join(this.paths.profile, 'package.json')) && !refreshed
        && !profileAwaitingFirstInstall(this.paths.profile)
      createPluginProfile(this.paths.profile, bundled, replacements)
      removeLinkProjections(this.paths.profile)
      const retiredChanged = await pruneRetiredPlugins(this.paths.profile)
      if (bundled !== undefined && bundledTarball(bundled, COMMUNITY_PACKAGE) !== undefined) {
        await restoreCommunityPatch(this.paths.profile)
      }
      if (installed && !retiredChanged) return
      try {
        await this.installBundledPlugins(this.paths.profile, bundled)
        // A package operation can exit successfully and still leave a declared
        // plugin unmaterialized — the profile then starts a Host whose armor,
        // theme, and market are silently absent. Verify, retry once with the
        // early return disabled, and leave a trace either way.
        const missing = missingBundledPlugins(this.paths.profile)
        if (missing.length === 0) return
        this.logDiagnostic(`bundled plugin install left ${missing.join(', ')} missing; retrying`)
        await this.installBundledPlugins(this.paths.profile, bundled, true)
        const stillMissing = missingBundledPlugins(this.paths.profile)
        this.logDiagnostic(stillMissing.length === 0
          ? `bundled plugin install recovered ${missing.join(', ')}`
          : `bundled plugin install still missing: ${stillMissing.join(', ')}`)
      } catch (error) {
        if (error instanceof ProfileLocalLinkError || error instanceof DesktopStartupPackageError
          && error.code !== 'startup-install-failed') throw error
        // Advisory by request: a failed plugin install must not brick the
        // launch. The plugins already materialized still load, the profile
        // still reports those dependencies, and the next launch retries.
        this.logDiagnostic(`bundled plugin install: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /**
   * Materialize the bundled plugin tarballs a profile declares.
   *
   * Creation writes the `file:` dependency rows immediately so a first launch
   * already mounts the bundled plugins; this step is what turns those rows into
   * `node_modules` entries. It is idempotent: a profile whose dependencies are
   * all present installs nothing.
   * @param projectDir - active desktop profile.
   * @param source - the runtime's `desktop-packages` folder, when this build ships one.
   * @param force - run the install even when every declared plugin looks present.
   */
  private async installBundledPlugins(projectDir: string, source: string | undefined, force = false): Promise<void> {
    const dependencies = projectManifest(projectDir).dependencies
    const bundled = DESKTOP_BUNDLED_PLUGINS.filter(plugin => plugin in dependencies)
    if (bundled.length === 0) return
    // Archive changes drop the lockfile so the next install records the new dependency paths.
    const stale = !existsSync(join(projectDir, 'pnpm-lock.yaml'))
    if (!force && !stale
      && bundled.every(plugin => existsSync(join(projectDir, 'node_modules', ...plugin.split('/'))))) return
    // pnpm 11's optimistic repeat check runs before --force and can skip a missing package.
    let localLinks: readonly ProfileLocalLink[]
    try { localLinks = captureProfileLocalLinks(projectDir, [...DESKTOP_BUNDLED_PLUGINS, ...DESKTOP_RETIRED_PLUGINS]) }
    catch (error) { throw new ProfileLocalLinkError(error) }
    let safeToRestore = true
    try {
      try { detachProfileLocalLinks(projectDir, localLinks) }
      catch (error) { throw new ProfileLocalLinkError(error) }
      await this.runPnpm(projectDir, ['install', '--ignore-scripts', ...(force ? ['--force', '--no-optimistic-repeat-install'] : [])])
    } catch (error) {
      if (error instanceof DesktopStartupPackageError && !error.quiescent) safeToRestore = false
      throw error
    } finally {
      if (safeToRestore) {
        try { restoreProfileLocalLinks(projectDir, localLinks) }
        catch (error) { throw new ProfileLocalLinkError(error) }
      }
    }
    // pnpm can purge and rebuild `node_modules`, so the bundled tarballs are
    // reconciled again before the profile is handed to the Host.
    refreshBundledPackages(projectDir, source)
  }

  /**
   * Run the bundled pnpm entry inside a profile.
   * @param projectDir - profile directory owning the package manifest.
   * @param args - pnpm arguments after the bundled entry.
   */
  private async runPnpm(projectDir: string, args: readonly string[]): Promise<void> {
    const pnpm = this.runtime.pnpm
    if (pnpm === undefined) throw new Error('this build supplies no pnpm entry')
    await runDesktopStartupPackageOperation({
      executable: process.execPath, entry: pnpm,
      args: ['--config.confirm-modules-purge=false', ...args], cwd: projectDir,
      environment: desktopNodeEnvironment(process.execPath, undefined, process.env),
      runner: this.options.runner ?? join(this.runtime.dsh, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'runner.js'),
      config: this.options.config ?? resolveDesktopStartupInstallConfig(process.env),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      log: (diagnostic) => { this.options.log?.(diagnostic) },
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    let descriptor: number
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(lockPath)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: profile lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another profile operation is active')
        unlinkSync(lockPath)
        descriptor = openSync(lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      writeSync(descriptor, `${String(process.pid)}\n`)
      fsyncSync(descriptor)
      return await operation()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/**
 * Create the first external plugin profile without running a package manager.
 *
 * The bundled plugins are listed and pinned the moment the profile exists, so a
 * first launch already mounts them; the caller's bundled package step then
 * materializes the `file:` tarballs that were copied in beside the manifest.
 * @param projectDir - profile directory to create.
 * @param source - the runtime's `desktop-packages` folder, when this build ships one.
 */
/**
 * Merge a profile's declared bundle list with the bundles this build always mounts.
 *
 * The declared list is the operator's: a bundle enabled from the plugin manager
 * lives only here, so replacing it with the fixed set silently disabled that
 * switch at the next launch. Fixed bundles the manifest is missing (a new
 * release's own bundle) are appended behind them.
 * @param declared - bundles the profile manifest currently names, in order.
 * @param required - bundles this operation requires; defaults to the complete shipped list.
 * @returns the merged list, declaration order first.
 */
export function mergeProfileBundles(declared: readonly string[], required: readonly string[] = DESKTOP_FULL_BUNDLES): string[] {
  // A duplicate row would mount the bundle twice; the declared order is what
  // decides, so the first occurrence wins.
  const ordered = [...new Set(declared)]
  return [...ordered, ...required.filter(name => !ordered.includes(name))]
}

/**
 * Initialize profile metadata while retaining installed packages and verified private bundle selections.
 * @param projectDir - Profile directory to initialize.
 * @param source - Bundled plugin tarball directory, when available.
 * @param replacements - Original bundles already verified as replaced by selected private aliases.
 */
export function createPluginProfile(projectDir: string, source?: string, replacements?: ReadonlySet<string>): void {
  initProfile(projectDir, WEB_PROFILE.bundles)
  const manifest = projectManifest(projectDir)
  const replaced = replacements ?? communityProfileBundleReplacements(projectDir, manifest.dependencies, manifest.dsh.profile.bundles)
  const bundled = copyBundledPackageTarballs(projectDir, source)
  if (Object.keys(bundled).length === 0 && replaced.size === 0) return
  // An existing profile keeps the plugins the operator installed: the bundled
  // rows are merged into them rather than replacing the manifest, so an upgrade
  // never uninstalls a marketplace plugin by rewriting package.json.
  const previous = manifest.dependencies
  const dependencies: Record<string, string> = {}
  for (const plugin of [...Object.keys(previous), ...Object.keys(bundled)]) {
    const spec = previous[plugin] ?? bundled[plugin]
    if (spec !== undefined) dependencies[plugin] = spec
  }
  // The bundle list is merged for the same reason the dependencies are: a
  // bundle the operator enabled from the plugin manager (智能体团队, 语音输入, a
  // marketplace surface) lives ONLY in this list, so writing the fixed set here
  // silently disabled it at the next launch — the switch looked like it did not
  // stick. Declared bundles keep their order; a fixed bundle the manifest is
  // missing (a new release's own bundle) is appended.
  const bundles = shippedProfileBundles(manifest, dependencies, replaced)
  if (Object.keys(bundled).length === 0 && bundles.length === manifest.dsh.profile.bundles.length
    && bundles.every((bundle, index) => bundle === manifest.dsh.profile.bundles[index])) return
  writeJson(join(projectDir, 'package.json'), {
    ...manifest,
    dependencies,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } },
  })
}
