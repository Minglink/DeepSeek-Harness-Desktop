/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'
import { desktopProfileOwnedBundles } from './profile-owned-bundles.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installDesktopInstallLog } from './install-log.ts'
import { installOfficeEngineResolution } from './office-engine.ts'
import * as desktopHostLog from './host-log.ts'
import * as desktopServices from './services.ts'
import * as desktopNativePath from './native-path.ts'
import * as desktopManagedRestart from './managed-restart.ts'
import * as desktopProfileLinks from './profile-links.ts'

/**
 * The Desktop deployment's own composition layer, packaged beside this module.
 * It carries the preferences that belong to the desktop product rather than to
 * the Web bundle it reuses: the unconfined permission baseline with the
 * auto-granting approval policy, the opt-in `无限制` preset, the raised shell
 * timeouts, and the compaction rows the Web bundle disables.
 */
const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))

/**
 * The deployment's own preference values, applied **below** the profile's patch.
 *
 * An overlay outranks the reader's layer, so a preference shipped in one cannot
 * be written back through the settings surface: ConfigEditor recomposes, sees the
 * overlay still winning, and refuses. These rows are preferences a reader is
 * expected to be able to change, so they ride a layer and stay overridable.
 */
const DESKTOP_DEFAULTS = fileURLToPath(new URL('../config/desktop-defaults.patch.yml', import.meta.url))

/**
 * The operator's own agent presets, migrated from the 0.1.6 preset directories to
 * 0.1.7's declarative rows. Applied after the deployment patch so a preset row
 * can be reviewed as one file.
 */
const DESKTOP_PRESETS = fileURLToPath(new URL('../config/desktop-presets.patch.yml', import.meta.url))

export async function startDesktopHost(options: { additionalPatchFiles?: string[]; beforeReady?: () => void } = {}): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  // The service row is a patch entry, so its configuration is composed before
  // this process holds a context: the profile and package-manager entry points
  // are published here and read back by `!!js` expressions in the patch file.
  process.env.DSH_DESKTOP_PROFILE_DIR = projectDir
  process.env.DSH_DESKTOP_HOST_EXECUTABLE = process.execPath
  process.env.DSH_DESKTOP_PNPM_ENTRY = process.argv[5] ?? ''
  process.env.DSH_DESKTOP_NODE_BIN_DIR = process.argv[6] ?? ''
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const suppliedAnchors: unknown = process.env.DSH_DESKTOP_STOCK_BUNDLES === undefined
    ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    : JSON.parse(process.env.DSH_DESKTOP_STOCK_BUNDLES)
  if (!Array.isArray(suppliedAnchors) || suppliedAnchors.length !== 2
    || !suppliedAnchors.every(name => typeof name === 'string' && name.length > 0)) throw new Error('Desktop owner supplied invalid stock bundle anchors')
  const profileFirstBundles = desktopProfileOwnedBundles(projectDir, suppliedAnchors)
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor, { profileFirstBundles })
  reportSkippedBundles('dsh', profile)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [...(options.additionalPatchFiles ?? []), DESKTOP_PATCH, DESKTOP_PRESETS],
    defaultsFiles: [DESKTOP_DEFAULTS],
    defaultsAfterBundles: suppliedAnchors,
    // Host-owned glue runs here, before any config-tree entry mounts, for two
    // reasons: a logger exporter installed later misses the records a refused
    // entry writes while the tree settles, and a row naming
    // `@deepseek-ai/dsh-desktop-host/…` cannot resolve at all — composition rows
    // resolve package names against the profile directory, where this package
    // does not exist.
    prepareHost: (ctx) => {
      installDesktopInstallLog(ctx, (chunk) => {
        if (process.connected) process.send?.({ type: 'install-log', chunk }, (error) => {
          if (error !== null) console.error('Desktop installation log IPC failed')
        })
      })
      desktopHostLog.apply(ctx, { profileDir: projectDir })
      desktopServices.apply(ctx, {
        profileDir: projectDir,
        nodeExecutable: process.execPath,
        pnpmEntry: process.argv[5] ?? '',
        nodeBinDir: process.argv[6] ?? '',
      })
      desktopNativePath.apply(ctx)
      desktopManagedRestart.apply(ctx)
      desktopProfileLinks.apply(ctx, { profileDir: projectDir, runtimeDir: runtimeDir })
    },
    args: ['--no-open', '--port', '0'],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  options.beforeReady?.()
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  startDesktopHost().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
