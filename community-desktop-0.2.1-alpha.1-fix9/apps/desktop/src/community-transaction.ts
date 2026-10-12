/** Candidate-profile trials and recoverable profile promotion owned by Electron, outside the plugin Host. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { PreparedCommunityBundle } from './community-install.ts'
import type { CommunityInstallIntent, CommunityTaskId } from './community-types.ts'
import { observeCommunityOperation } from './community-operation.ts'
import { copyCommunityProfileLinks, rebaseCommunityProfileLinks } from './community-profile-links.ts'

/** Failures distinguish an unchanged or restored profile from unsuccessful recovery. */
export class CommunityTransactionError extends Error {
  /**
   * @param code - Localized failure key.
   * @param restored - Whether the previous package state remains active and recovery is settled.
   * @param diagnostic - Credential-free technical failure context for developer logs.
   * @param adaptationEligible - Whether plugin adaptation can address this failure.
   */
  constructor(readonly code: string, readonly restored: boolean, readonly diagnostic?: string,
    readonly adaptationEligible = true, readonly diagnosticTail?: string) { super(code) }
}

interface Journal {
  version: 1
  id: string
  taskId: CommunityTaskId
  plugin: CommunityInstallIntent
  phase: 'trial' | 'swapping' | 'activating' | 'committed' | 'restored'
  promotedFingerprint?: string
  previous?: Pick<Journal, 'id' | 'taskId' | 'plugin' | 'promotedFingerprint'>
}

/** Main-owned hooks must stop their children before resolving or rejecting. */
export interface CommunityTransactionOptions {
  profile: string
  directory: string
  trial(profile: string, home: string, prepared: PreparedCommunityBundle, signal: AbortSignal): Promise<void>
  pause(recovering?: boolean): Promise<void>
  resume(): Promise<void>
  healthy(signal: AbortSignal): Promise<void>
  /** Deadline for each live or recovery startup, including activation health checks. */
  startupTimeoutMs?: number
}

const PRIVATE_FILES = new Set(['.env', '.credentials.yaml', '.credentials.yml', 'desktop-config.json'])
const STATE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'compatibility.json']

function privateFile(name: string): boolean {
  const normalized = name.toLowerCase()
  return PRIVATE_FILES.has(normalized) || normalized.startsWith('.env.')
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

async function directory(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CommunityTransactionError('invalid-profile', false)
}

async function fingerprint(profile: string): Promise<string> {
  const hash = createHash('sha256')
  const privateNames = (await readdir(profile)).filter(name => privateFile(name)
    || /\.(?:json|ya?ml)$/iu.test(name) || name.toLowerCase() === '.npmrc')
  for (const name of [...new Set([...STATE_FILES, ...privateNames])].sort()) {
    hash.update(name)
    try { hash.update(await readFile(join(profile, name))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update('absent') }
  }
  return hash.digest('hex')
}

/** Credential variables are excluded from candidate Host and package subprocess environments. */
export function communityTrialEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|COOKIE|^DSH_|^DEEPSEEK_|^NODE_OPTIONS$|^NPM_CONFIG_/iu.test(key))),
  DSH_HOME: home, DSH_CLIENT_VERSION: environment.DSH_CLIENT_VERSION,
  NPM_CONFIG_USERCONFIG: join(home, 'trial.npmrc'), NPM_CONFIG_IGNORE_SCRIPTS: 'true' }
}

/** Creates its private directory before acquiring the journal lock; unfinished promotion is restored before the normal Host boots. */
export class CommunityProfileTransaction {
  private readonly journalFile: string
  /** @param options - Profile paths and owned Host lifecycle hooks. */
  constructor(private readonly options: CommunityTransactionOptions) {
    if (options.startupTimeoutMs !== undefined && (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 1)) {
      throw new Error('Community startup deadline must be a positive integer')
    }
    this.journalFile = join(options.directory, 'installation-v1.json')
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.journalFile), { recursive: true, mode: 0o700 })
    return withFileLock(this.journalFile, operation, { waitMs: 180_000 })
  }

  private startupSignal(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.options.startupTimeoutMs ?? 120_000)
    return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  }

  private async resume(): Promise<void> {
    await observeCommunityOperation(this.options.resume(), this.startupSignal())
  }

  private paths(id: string): { candidate: string; backup: string; home: string; rejected: string } {
    const parent = dirname(resolve(this.options.profile))
    return { candidate: join(parent, `.community-candidate-${id}`), backup: join(parent, `.community-backup-${id}`),
      home: join(parent, `.community-trial-${id}`), rejected: join(parent, `.community-rejected-${id}`) }
  }

  private async save(journal: Journal): Promise<void> {
    await writeFileAtomic(this.journalFile, JSON.stringify(journal) + '\n', { mode: 0o600, dirMode: 0o700 })
    const file = await open(this.journalFile, 'r+')
    try { await file.sync() } finally { await file.close() }
  }

  private async read(): Promise<Journal | undefined> {
    if (!await present(this.journalFile)) return undefined
    const content = await readFile(this.journalFile, 'utf8')
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Community installation journal exceeds its size limit')
    const value: unknown = JSON.parse(content)
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('id' in value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id)
      || !('taskId' in value) || typeof value.taskId !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.taskId)
      || !('phase' in value) || !['trial', 'swapping', 'activating', 'committed', 'restored'].includes(String(value.phase))
      || !('plugin' in value) || typeof value.plugin !== 'object' || value.plugin === null
      || !('id' in value.plugin) || typeof value.plugin.id !== 'string'
      || !('name' in value.plugin) || typeof value.plugin.name !== 'string') throw new Error('Invalid community installation journal')
    if ('promotedFingerprint' in value && (typeof value.promotedFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.promotedFingerprint))) throw new Error('Invalid community installation fingerprint')
    if ('previous' in value) {
      const previous = value.previous
      if (typeof previous !== 'object' || previous === null || !('id' in previous) || typeof previous.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(previous.id)
        || !('taskId' in previous) || typeof previous.taskId !== 'string' || !/^[a-f0-9-]{36}$/u.test(previous.taskId)
        || !('plugin' in previous) || typeof previous.plugin !== 'object' || previous.plugin === null
        || !('id' in previous.plugin) || typeof previous.plugin.id !== 'string' || !('name' in previous.plugin) || typeof previous.plugin.name !== 'string'
        || !('promotedFingerprint' in previous) || typeof previous.promotedFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(previous.promotedFingerprint)) throw new Error('Invalid previous community installation')
    }
    return value as Journal
  }

  private async restore(journal: Journal): Promise<void> {
    const paths = this.paths(journal.id)
    if (await present(paths.backup)) {
      await directory(paths.backup)
      await rebaseCommunityProfileLinks(paths.backup, paths.backup, this.options.profile)
      if (await present(this.options.profile)) { await directory(this.options.profile); await rename(this.options.profile, paths.rejected) }
      await rename(paths.backup, this.options.profile)
    } else if (!await present(this.options.profile)) throw new CommunityTransactionError('rollback-failed', false)
    await directory(this.options.profile)
    if (journal.previous !== undefined && journal.previous.promotedFingerprint === await fingerprint(this.options.profile)) {
      await this.save({ version: 1, ...journal.previous, phase: 'committed' })
    } else await this.save({ ...journal, phase: 'restored' })
  }

  private async cleanup(journal: Journal, keepBackup = false): Promise<void> {
    const paths = this.paths(journal.id)
    for (const path of [paths.candidate, paths.home, paths.rejected, ...keepBackup ? [] : [paths.backup]]) {
      if (!await present(path)) continue
      const entry = await lstat(path)
      if (entry.isSymbolicLink()) throw new Error('Community transaction directory is a link')
      await rm(path, { recursive: true, force: true })
    }
  }

  /** @returns Interrupted task metadata after restoring its package state; committed tasks require no recovery. */
  async recover(): Promise<{ taskId: CommunityTaskId; plugin: CommunityInstallIntent } | undefined> {
    return this.withLock(async () => {
      const journal = await this.read()
      if (journal === undefined) return undefined
      if (journal.phase === 'committed' || journal.phase === 'restored') { await this.cleanup(journal, journal.phase === 'committed'); return undefined }
      await this.restore(journal)
      await this.cleanup(journal)
      return { taskId: journal.taskId, plugin: journal.plugin }
    })
  }

  /**
   * @param eligible - Whether the failing Host is still current; checked after waiting for installation and after stopping it.
   * @returns The last installation restored after a current Host failure, only if its promoted package files remain unchanged.
   */
  async rollbackLast(eligible: () => boolean = () => true):
  Promise<{ taskId: CommunityTaskId; plugin: CommunityInstallIntent } | undefined> {
    return this.withLock(async () => {
      const journal = await this.read()
      if (!eligible() || journal?.phase !== 'committed' || journal.promotedFingerprint !== await fingerprint(this.options.profile)
        || !await present(this.paths(journal.id).backup)) return undefined
      await this.options.pause(true)
      if (!eligible() || journal.promotedFingerprint !== await fingerprint(this.options.profile)) { await this.resume(); return undefined }
      await this.restore(journal)
      try { await this.resume() }
      catch (_startupError) { await this.options.pause(true); throw new CommunityTransactionError('rollback-failed', false) }
      await this.cleanup(journal)
      return { taskId: journal.taskId, plugin: journal.plugin }
    })
  }

  /**
   * Trial a package in a copied profile, then replace the stopped live profile and confirm Host health.
   * @param prepared - Validated local artifact.
   * @param task - Persisted task identity and credential-free selection.
   * @param signal - Cancellation includes recovery before settlement.
   * @param phase - Product progress callback.
   * @returns After healthy promotion; failure throws only after recovery finishes.
   */
  async install(prepared: PreparedCommunityBundle, task: { id: CommunityTaskId; plugin: CommunityInstallIntent }, signal: AbortSignal,
    phase: (value: 'trial' | 'activating' | 'rolling-back') => void): Promise<void> {
    await this.withLock(async () => {
      const previous = await this.read()
      if (previous !== undefined) {
        if (previous.phase !== 'committed' && previous.phase !== 'restored') throw new CommunityTransactionError('recovery-required', false)
        await this.cleanup(previous, previous.phase === 'committed')
      }
      const journal: Journal = { version: 1, id: randomUUID(), taskId: task.id, plugin: task.plugin, phase: 'trial',
        ...(previous?.phase === 'committed' && previous.promotedFingerprint !== undefined ? { previous: {
          id: previous.id, taskId: previous.taskId, plugin: previous.plugin, promotedFingerprint: previous.promotedFingerprint,
        } } : {}) }
      const paths = this.paths(journal.id)
      let paused = false, swapping = false, trialStarted = false, trialFinished = false
      const privateFiles: string[] = []
      const profileLinks: string[] = []
      await this.save(journal)
      try {
        signal.throwIfAborted()
        phase('trial')
        await directory(this.options.profile)
        const original = await withFileLock(join(this.options.profile, 'package.json'), async () => {
          const before = await fingerprint(this.options.profile)
          await cp(this.options.profile, paths.candidate, { recursive: true, dereference: false, verbatimSymlinks: true,
            filter: async (source) => {
              if (privateFile(basename(source))) { privateFiles.push(source); return false }
              if (basename(source).endsWith('.lock') || basename(source) === 'lock') return false
              if ((await lstat(source)).isSymbolicLink()) { profileLinks.push(source); return false }
              return true
            } })
          await copyCommunityProfileLinks(this.options.profile, paths.candidate, profileLinks)
          await rebaseCommunityProfileLinks(paths.candidate, this.options.profile, paths.candidate)
          return before
        })
        await mkdir(paths.home, { recursive: true, mode: 0o700 })
        trialStarted = true
        await this.options.trial(paths.candidate, paths.home, prepared, signal)
        trialFinished = true
        signal.throwIfAborted()
        if (await fingerprint(this.options.profile) !== original) throw new CommunityTransactionError('profile-changed', true)
        await this.options.pause()
        paused = true
        signal.throwIfAborted()
        if (await fingerprint(this.options.profile) !== original) throw new CommunityTransactionError('profile-changed', true)
        for (const source of privateFiles) {
          await cp(source, join(paths.candidate, relative(this.options.profile, source)), { dereference: false, verbatimSymlinks: true })
        }
        await rebaseCommunityProfileLinks(paths.candidate, paths.candidate, this.options.profile)
        await this.save({ ...journal, phase: 'swapping' })
        swapping = true
        await directory(this.options.profile)
        await directory(paths.candidate)
        await rename(this.options.profile, paths.backup)
        await rebaseCommunityProfileLinks(paths.backup, this.options.profile, paths.backup)
        await rename(paths.candidate, this.options.profile)
        await this.save({ ...journal, phase: 'activating' })
        phase('activating')
        const activation = this.startupSignal(signal)
        await observeCommunityOperation(this.options.resume(), activation)
        await observeCommunityOperation(this.options.healthy(activation), activation)
        signal.throwIfAborted()
        await this.save({ version: 1, id: journal.id, taskId: journal.taskId, plugin: journal.plugin,
          phase: 'committed', promotedFingerprint: await fingerprint(this.options.profile) })
        await this.cleanup(journal, true)
        if (previous !== undefined) await this.cleanup(previous)
      } catch (error) {
        // An unconfirmed trial child exit keeps its directories and unfinished journal for recovery.
        if (error instanceof CommunityTransactionError && error.code === 'rollback-failed' && !error.restored) throw error
        if (swapping) {
          phase('rolling-back')
        }
        try {
          if (swapping) await this.options.pause(true)
          await this.restore(journal)
          if (paused) await this.resume()
          await this.cleanup(journal)
        } catch (recoveryError) {
          try { await this.options.pause(true) }
          catch (_stopError) { /* Keep the journal for startup recovery when child exit cannot be confirmed. */ }
          const earlier = error instanceof CommunityTransactionError ? error.diagnosticTail ?? error.diagnostic
            : error instanceof Error ? error.message : undefined
          const restoration = recoveryError instanceof Error ? recoveryError.message : 'Profile restoration failed'
          throw new CommunityTransactionError('rollback-failed', false, undefined, false,
            [earlier, `Restoration: ${restoration}`].filter(Boolean).join('\n'))
        }
        const code = signal.aborted ? 'cancelled' : error instanceof CommunityTransactionError ? error.code
          : swapping || trialFinished ? 'activation-failed' : 'trial-failed'
        const diagnostic = error instanceof CommunityTransactionError ? error.diagnostic
          : error instanceof Error ? error.message.slice(0, 4096) : undefined
        const adaptationEligible = error instanceof CommunityTransactionError ? error.adaptationEligible : trialStarted
        const diagnosticTail = error instanceof CommunityTransactionError ? error.diagnosticTail
          : error instanceof Error ? error.stack ?? error.message : undefined
        throw new CommunityTransactionError(code, true, diagnostic, adaptationEligible,
          diagnosticTail)
      }
    })
  }
}
