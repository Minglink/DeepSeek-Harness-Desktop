/** Owned bootstrap; keeps the original Desktop positional and IPC protocols. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { prepareManagedHarmony } from './managed-harmony.ts'

async function bootstrap(): Promise<void> {
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  if (runtimeDir === undefined || projectDir === undefined) throw new Error('Desktop bootstrap requires its owned runtime and profile paths')
  process.env.DSH_DESKTOP_PROFILE_DIR = projectDir
  process.env.DSH_DESKTOP_HOST_EXECUTABLE = process.execPath
  process.env.DSH_DESKTOP_PNPM_ENTRY = process.argv[5] ?? ''
  process.env.DSH_DESKTOP_NODE_BIN_DIR = process.argv[6] ?? ''
  const configuration = fileURLToPath(new URL('../config/', import.meta.url))
  const harmony = await prepareManagedHarmony(runtimeDir, projectDir, [join(configuration, 'desktop.cordis.patch.yml'), join(configuration, 'desktop-presets.patch.yml')])
  // Import only after the managed companion's genuine module/file hooks exist.
  const { startDesktopHost } = await import('./index.ts')
  await startDesktopHost({ additionalPatchFiles: harmony.patchFiles, beforeReady: () => { harmony.assertReady() } })
}

if (import.meta.main) bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, 64 * 1024)
  if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (sendError) => { if (sendError !== null) console.error(sendError) })
  console.error(error)
  process.exitCode = 1
  if (process.connected) process.disconnect()
})
