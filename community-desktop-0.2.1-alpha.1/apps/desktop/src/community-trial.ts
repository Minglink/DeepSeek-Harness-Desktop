/** Readiness and bundle-registration probes for a credential-free candidate Host. */
import type { DesktopHostProcess, DesktopHostReady } from './host-process.ts'
import { authenticateWebHost } from './web-document.ts'
import { invokeCommunityBackend } from './community-backend.ts'
import { CommunityTransactionError } from './community-transaction.ts'
import type { PreparedCommunityBundle } from './community-install.ts'
import { observeCommunityOperation } from './community-operation.ts'
import { communityInfrastructureFailure, communityTrialCleanupFailure, nativeCommunityTrialFailure } from './community-failure.ts'
export { observeCommunityOperation } from './community-operation.ts'

/** One Host allocation; fatal events remain local to the candidate instead of invoking desktop recovery dialogs. */
export type CommunityTrialHostFactory = (failed: (error: Error) => void) => Pick<DesktopHostProcess, 'start' | 'stop'>

/**
 * Install and restart a candidate profile, rejecting packages that do not register runnable bundle entries.
 * @param createHost - Allocate a fresh process over the same candidate profile on every call.
 * @param prepared - Local candidate artifact and exact expected identity.
 * @param signal - User cancellation; a bounded trial deadline also covers startup and RPC.
 * @returns Once both candidate processes have exited and the activated bundle passed inventory checks.
 */
export async function trialCommunityBundle(createHost: CommunityTrialHostFactory, prepared: PreparedCommunityBundle,
  signal: AbortSignal): Promise<void> {
  const failure = new AbortController()
  const observation = AbortSignal.any([signal, failure.signal, AbortSignal.timeout(120_000)])
  const start = async (host: ReturnType<CommunityTrialHostFactory>, baseline = false): Promise<{ url: string; cookie: string }> => {
    let ready: DesktopHostReady
    try { ready = await observeCommunityOperation(host.start(), observation) }
    catch (error) {
      if (baseline) throw communityInfrastructureFailure('baseline-start')
      if (error instanceof Error && error.name === 'TimeoutError') throw communityInfrastructureFailure('timeout')
      throw error
    }
    try { return { url: ready.url, cookie: await authenticateWebHost(ready.url, observation) } }
    catch (_error) { throw communityInfrastructureFailure('authentication') }
  }
  const invoke = async (backend: { url: string; cookie: string }, method: string, args: Record<string, unknown>): Promise<unknown> => {
    try { return await invokeCommunityBackend(backend, method, args, undefined, observation) }
    catch (_error) { throw communityInfrastructureFailure('transport') }
  }
  const stop = async (): Promise<void> => {
    try { await host.stop() }
    catch (_error) { throw communityInfrastructureFailure('stop') }
  }
  let host = createHost((error) => { failure.abort(error) })
  let trialFailure: unknown
  try {
    const backend = await start(host, true)
    const value = await invoke(backend, 'installBundle', { spec: prepared.spec, options: { enabled: true } })
    if (typeof value !== 'object' || value === null || !('application' in value)
      || !['applied', 'restart-required'].includes(String(value.application))
      || ('error' in value && value.error !== undefined)) {
      throw nativeCommunityTrialFailure(value)
    }
    await stop()
    host = createHost((error) => { failure.abort(error) })
    const running = await start(host)
    const inventory = await invoke(running, 'listBundles', {})
    const entries = await invoke(running, 'listPlugins', {})
    assertCommunityBundleReady(inventory, prepared.packageName, prepared.version, entries)
  } catch (error) {
    trialFailure = error
    throw error
  } finally {
    try { await stop() }
    catch (_stopError) { throw communityTrialCleanupFailure(trialFailure) }
  }
}

/**
 * Validate the exact enabled package and its declared live rows, including Loader failures.
 * @param value - Native manager inventory received over authenticated HTTP.
 * @param name - Manifest-derived package identity.
 * @param version - Exact prepared package version.
 */
export function assertCommunityBundleReady(value: unknown, name: string, version: string, entries: unknown): void {
  if (!Array.isArray(value)) throw new CommunityTransactionError('trial-failed', true)
  const bundle: unknown = value.find((entry: unknown) => typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === name)
  if (typeof bundle !== 'object' || bundle === null || !('enabled' in bundle) || bundle.enabled !== true
    || !('version' in bundle) || bundle.version !== version || ('error' in bundle && bundle.error !== undefined)
    || !('rows' in bundle) || !Array.isArray(bundle.rows) || bundle.rows.length === 0) throw new CommunityTransactionError('trial-failed', true)
  if (!Array.isArray(entries)) throw new CommunityTransactionError('trial-failed', true)
  let active = 0
  const rows: unknown[] = bundle.rows
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !('entryId' in row) || typeof row.entryId !== 'string') throw new CommunityTransactionError('trial-failed', true)
    const entry: unknown = entries.find((item: unknown) => typeof item === 'object' && item !== null && 'entryId' in item && item.entryId === row.entryId)
    if (typeof entry !== 'object' || entry === null || !('enabled' in entry) || !('fiberPhase' in entry)
      || !('moduleName' in row) || !('moduleName' in entry) || entry.moduleName !== row.moduleName
      || typeof entry.enabled !== 'boolean'
      || entry.fiberPhase === 'failed' || (entry.enabled && entry.fiberPhase !== 'active')) throw new CommunityTransactionError('trial-failed', true)
    if (entry.enabled) active++
  }
  if (active === 0) throw new CommunityTransactionError('trial-failed', true)
}
