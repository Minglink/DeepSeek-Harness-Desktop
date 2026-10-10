/** Native management failures keep diagnostic classifications without exposing package-manager output. */
import { describe, expect, it } from 'vitest'
import { CommunityTransactionError } from '../src/community-transaction.ts'
import { CommunityInstallError } from '../src/community-install.ts'
import { communityFailureSummary, communityInfrastructureFailure, communityTrialCleanupFailure, nativeCommunityTrialFailure } from '../src/community-failure.ts'

const incompatible = [{ name: '@example/plugin', version: '1.2.3', runtimeVersion: '0.2.1-alpha.1', peers: { '@deepseek-ai/dsh-settings': '^0.1.0' } }]

describe('main-only community failure classification', () => {
  it.each(['pnpm-missing', 'timeout', 'network', 'disk-full', 'permission', 'build-blocked', 'integrity', 'not-found', 'no-matching-version'])('does not adapt source after a native %s deployment failure', (kind) => {
    const error = nativeCommunityTrialFailure({ application: 'failed', error: { code: 'operation-error' }, packageResult: { kind, exitCode: 1, output: 'private-output' } })
    expect(error.adaptationEligible).toBe(false)
    expect(error.diagnostic).not.toContain('private-output')
  })

  it('retains only known pnpm identifiers from output rather than its paths or arbitrary identifier suffixes', () => {
    const known = nativeCommunityTrialFailure({ application: 'failed', packageResult: { output: '[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE] C:/private-home apiKey=private-key', exitCode: 1 } })
    expect(communityFailureSummary(known)).toEqual({ code: 'trial-failed', cause: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', adaptationEligible: false })
    const future = nativeCommunityTrialFailure({ application: 'failed', error: { diagnostic: 'ERR_PNPM_PRIVATE_CREDENTIAL_SUFFIX', code: 'operation-error' } })
    expect(communityFailureSummary(future).cause).toBe('ERR_PNPM')
    expect(future.diagnostic).not.toContain('PRIVATE_CREDENTIAL_SUFFIX')
    expect(known.diagnostic).not.toMatch(/private-home|private-key/)
  })

  it.each(['invalid-spec', 'ambiguous-install', 'not-bundle', 'management-required', 'stale-approval'])('does not use AI to bypass a native %s refusal', (code) => {
    expect(nativeCommunityTrialFailure({ application: 'failed', error: { code } }).adaptationEligible).toBe(false)
  })

  it('keeps native compatibility and genuine plugin-runtime diagnostics eligible without putting their text in developer summaries', () => {
    expect(nativeCommunityTrialFailure({ application: 'failed', error: { code: 'incompatible-version', incompatible },
      packageResult: { exitCode: 1, kind: 'unknown', output: '', truncated: false, logPath: '/private/log', incompatible } }).adaptationEligible).toBe(true)
    const error = nativeCommunityTrialFailure({ application: 'failed', error: { code: 'operation-error', diagnostic: 'plugin import failed with private-value' }, packageResult: { exitCode: 0 } })
    expect(error).toMatchObject({ adaptationEligible: true, diagnostic: 'plugin import failed with private-value' })
    expect(communityFailureSummary(error)).toEqual({ code: 'trial-failed', cause: 'plugin-or-preparation', adaptationEligible: true })
  })

  it('keeps a real compatibility exit eligible when only the package result carries the rejected peers', () => {
    expect(nativeCommunityTrialFailure({ application: 'failed', error: { code: 'incompatible-version' },
      packageResult: { exitCode: 1, kind: 'unknown', output: '', incompatible } }).adaptationEligible).toBe(true)
  })

  it.each([
    { output: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE' }, { output: 'ERR_PNPM_OTHER_ENVIRONMENT' },
    { output: '', timedOut: true }, { output: '', kind: 'permission' },
  ])('does not override concrete deployment failures with a compatibility marker: %j', (result) => {
    expect(nativeCommunityTrialFailure({ application: 'failed', error: { code: 'incompatible-version', incompatible },
      packageResult: { exitCode: 1, kind: 'unknown', incompatible, ...result } }).adaptationEligible).toBe(false)
  })

  it('still refuses adaptation when a native nonzero exit has no actual compatibility rejection', () => {
    const error = nativeCommunityTrialFailure({ application: 'failed', error: { code: 'incompatible-version', incompatible: [] },
      packageResult: { exitCode: 1, kind: 'unknown', output: 'x'.repeat(20_000) + 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE' } })
    expect(error.adaptationEligible).toBe(false)
  })

  it('retains the initial pnpm classification and separately reports unconfirmed cleanup without claiming restoration', () => {
    const first = nativeCommunityTrialFailure({ application: 'failed', packageResult: { exitCode: 1, output: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE private-key' } })
    const failure = communityTrialCleanupFailure(first)
    expect(failure).toMatchObject({ code: 'rollback-failed', restored: false, adaptationEligible: false })
    expect(communityFailureSummary(failure)).toEqual({ code: 'rollback-failed', cause: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', cleanup: 'stop', adaptationEligible: false })
    expect(failure.diagnostic).not.toContain('private-key')
  })

  it.each([undefined, new Error('private-runtime-message'), new CommunityTransactionError('trial-failed', true, 'x'.repeat(5000))])('bounds main-only initial context when cleanup fails: %j', (first) => {
    const failure = communityTrialCleanupFailure(first)
    expect(failure.diagnostic?.length).toBeLessThanOrEqual(4096 + '\nCandidate Host cleanup failed: stop'.length)
    expect(communityFailureSummary(failure)).toEqual({ code: 'rollback-failed', cause: 'installation-infrastructure', cleanup: 'stop', adaptationEligible: false })
  })

  it.each([null, {}, { application: 'overridden' }])('does not treat invalid or overridden native replies as source compatibility: %j', (value) => {
    expect(nativeCommunityTrialFailure(value).adaptationEligible).toBe(false)
  })

  it.each(['baseline-start', 'authentication', 'transport', 'stop', 'timeout'] as const)('keeps %s infrastructure context fixed and internal', (stage) => {
    const error = communityInfrastructureFailure(stage)
    expect(communityFailureSummary(error)).toEqual({ code: 'trial-failed', cause: stage, adaptationEligible: false })
  })

  it('never copies arbitrary errors, unknown transaction codes or adaptation messages into log summaries', () => {
    expect(communityFailureSummary(new Error('private-output'))).toEqual({ code: 'unclassified', cause: 'plugin-or-preparation', adaptationEligible: false })
    expect(communityFailureSummary(new CommunityTransactionError('private-code', true, 'private-diagnostic')).code).toBe('unclassified')
    expect(communityFailureSummary(new CommunityInstallError('adaptation-failed', 'private-key'))).toEqual({ code: 'adaptation-failed', cause: 'plugin-or-preparation', adaptationEligible: false })
  })
})
