/** Main-only failure classification; subprocess output never reaches product state or diagnostic summaries. */
import { CommunityInstallError } from './community-install.ts'
import { CommunityTransactionError } from './community-transaction.ts'

const PACKAGE_KINDS = new Set(['pnpm-missing', 'timeout', 'not-found', 'no-matching-version', 'network', 'disk-full', 'permission', 'build-blocked', 'integrity', 'unknown'])
const MANAGEMENT_CODES = new Set(['management-required', 'unaddressable', 'unknown-plugin', 'invalid-spec', 'ambiguous-install', 'not-bundle', 'not-removable', 'stop-profile', 'bundle-in-use', 'stale-approval', 'incompatible-version', 'operation-error'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pnpmCode(value: string): string | undefined {
  if (value.includes('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE')) return 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE'
  if (value.includes('ERR_PNPM_UNEXPECTED_STORE')) return 'ERR_PNPM_UNEXPECTED_STORE'
  return /\bERR_PNPM(?:_[A-Z0-9_]+)?\b/u.test(value) ? 'ERR_PNPM' : undefined
}

/**
 * Classify a refused native installation without treating dependency deployment as plugin source incompatibility.
 * @param value - Result received through the authenticated native management RPC.
 * @returns A recoverable trial failure with internal model eligibility and bounded main-only context.
 */
export function nativeCommunityTrialFailure(value: unknown): CommunityTransactionError {
  const error = record(value) && record(value.error) ? value.error : undefined
  const result = record(value) && record(value.packageResult) ? value.packageResult : undefined
  const nativeCode = typeof error?.code === 'string' && MANAGEMENT_CODES.has(error.code) ? error.code : undefined
  const kind = typeof result?.kind === 'string' && PACKAGE_KINDS.has(result.kind) ? result.kind : undefined
  const output = typeof result?.output === 'string' ? result.output.slice(0, 16_384) : ''
  const diagnostic = typeof error?.diagnostic === 'string' ? error.diagnostic.slice(0, 4096) : ''
  const pnpm = pnpmCode(output + '\n' + diagnostic)
  const deploymentFailed = result !== undefined && (typeof result.exitCode === 'number' && result.exitCode !== 0 || result.timedOut === true)
  const refused = nativeCode !== undefined && !['operation-error', 'incompatible-version'].includes(nativeCode)
  const invalidReply = !record(value) || !['applied', 'restart-required', 'failed', 'cancelled'].includes(String(value.application))
  const incompatible = Array.isArray(error?.incompatible) && error.incompatible.length > 0
    || Array.isArray(result?.incompatible) && result.incompatible.length > 0
  const compatibilityRefused = nativeCode === 'incompatible-version' && incompatible && pnpm === undefined
    && (kind === undefined || kind === 'unknown') && result?.timedOut !== true && !invalidReply
  const infrastructure = !compatibilityRefused && (pnpm !== undefined || deploymentFailed || kind !== undefined && kind !== 'unknown' || refused || invalidReply)
  const summary = ['Native candidate installation failed', nativeCode, kind, pnpm].filter(Boolean).join('; ')
  return new CommunityTransactionError('trial-failed', true, infrastructure ? summary : diagnostic || summary, !infrastructure)
}

/**
 * Identify a bounded native/process cause without retaining output, paths, account values or arbitrary error text.
 * @param error - First or later installation failure owned by main.
 * @returns Fixed diagnostic fields suitable for main-process developer logs only.
 */
export function communityFailureSummary(error: unknown): { code: string; cause: string; adaptationEligible: boolean; cleanup?: 'stop' } {
  const diagnostic = error instanceof CommunityTransactionError ? error.diagnostic ?? '' : ''
  const pnpm = pnpmCode(diagnostic)
  const stage = ['baseline-start', 'authentication', 'transport', 'stop', 'timeout']
    .find(stage => diagnostic.split('\n').includes(`Candidate Host infrastructure failed: ${stage}`))
  const cause = pnpm ?? stage ?? (error instanceof CommunityTransactionError && !error.adaptationEligible ? 'installation-infrastructure' : 'plugin-or-preparation')
  const code = error instanceof CommunityInstallError ? error.problem
    : error instanceof CommunityTransactionError && ['trial-failed', 'activation-failed', 'active-tasks', 'profile-changed', 'rollback-failed', 'cancelled', 'recovery-required', 'storage-failed'].includes(error.code) ? error.code : 'unclassified'
  return { code, cause, adaptationEligible: error instanceof CommunityTransactionError && error.adaptationEligible,
    ...(diagnostic.split('\n').includes('Candidate Host cleanup failed: stop') ? { cleanup: 'stop' } : {}) }
}

/**
 * Retain the initial failure when the candidate Host cannot confirm exit; recovery remains unfinished.
 * @param first - Earlier main-owned trial failure, if the trial failed before teardown.
 * @returns A non-adaptable recovery failure with bounded diagnostic context retained only in main.
 */
export function communityTrialCleanupFailure(first: unknown): CommunityTransactionError {
  const diagnostic = first instanceof CommunityTransactionError ? first.diagnostic : first instanceof Error ? first.message : undefined
  return new CommunityTransactionError('rollback-failed', false,
    [diagnostic?.slice(0, 4096), 'Candidate Host cleanup failed: stop'].filter(Boolean).join('\n'), false)
}

/**
 * Reject model adaptation for a failure to operate the owned Host or authenticated transport.
 * @param stage - Fixed main-owned operation; no subprocess text is accepted.
 * @returns A trial failure that preserves recovery behavior and prevents source rewriting.
 */
export function communityInfrastructureFailure(stage: 'baseline-start' | 'authentication' | 'transport' | 'stop' | 'timeout'): CommunityTransactionError {
  return new CommunityTransactionError('trial-failed', true, `Candidate Host infrastructure failed: ${stage}`, false)
}
