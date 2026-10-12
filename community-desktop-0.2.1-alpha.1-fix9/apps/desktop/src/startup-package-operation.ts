/** Bounded startup package operations retain output until their owned process tree is quiet. */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { resolveDurationMs } from './duration-env.ts'

export interface DesktopStartupInstallConfig { timeoutMs: number }
/** @param env - Desktop deployment settings. @returns A validated overall package-operation deadline. */
export function resolveDesktopStartupInstallConfig(env: NodeJS.ProcessEnv): DesktopStartupInstallConfig {
  return { timeoutMs: resolveDurationMs(env, 'DSH_DESKTOP_STARTUP_INSTALL_TIMEOUT_MS', 300_000) }
}
export interface StartupPackageDiagnostic {
  source: 'system' | 'pnpm'
  level: 'info' | 'warning' | 'error'
  text: string
  truncated?: boolean
}
/** A false quiescence flag forbids restoring author links or starting a Host. */
export class DesktopStartupPackageError extends Error {
  constructor(readonly code: 'startup-install-timeout' | 'startup-install-aborted' | 'startup-install-failed' | 'startup-install-cleanup-failed',
    readonly quiescent: boolean, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'DesktopStartupPackageError'
  }
}
interface PackageOperationOptions {
  executable: string
  entry: string
  args: readonly string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  /** The sealed runtime's existing first-party subprocess runner; required on Windows. */
  runner?: string
  config: DesktopStartupInstallConfig
  signal?: AbortSignal
  log(diagnostic: StartupPackageDiagnostic): void
}
const CLEANUP_MS = 10_000
const MAX_LINE = 256 * 1024

/** Buffer split stdout/stderr credentials until a complete line, dropping oversized lines in full. */
function lines(emit: (text: string, omitted: boolean) => void): { append(chunk: string): void; finish(): void } {
  let pending = ''
  let dropping = false
  return {
    append(chunk) {
      for (const part of chunk.split(/(?<=\n)/u)) {
        if (!dropping) {
          if (pending.length + part.length > MAX_LINE) { pending = ''; dropping = true }
          else pending += part
        }
        if (part.endsWith('\n')) {
          emit(dropping ? '[oversized diagnostic omitted]' : pending.replace(/[\r\n]+$/u, ''), dropping)
          pending = ''; dropping = false
        }
      }
    },
    finish() { if (dropping || pending.length > 0) emit(dropping ? '[oversized diagnostic omitted]' : pending, dropping); pending = ''; dropping = false },
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try { process.kill(-pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

/**
 * Run only the first-party bundled pnpm entry; a Windows runner owns a kill-on-close Job before target resume.
 * @param options - Owned profile, sealed entries, validated deadline, and a main-owned diagnostic sink.
 * @returns Only after the target and its descendants have exited; never infers Job emptiness from target exit alone.
 */
export async function runDesktopStartupPackageOperation(options: PackageOperationOptions): Promise<void> {
  const config = resolveDesktopStartupInstallConfig({ DSH_DESKTOP_STARTUP_INSTALL_TIMEOUT_MS: String(options.config.timeoutMs) })
  if (options.signal?.aborted) throw new DesktopStartupPackageError('startup-install-aborted', true, 'cancelled before spawn')
  if (process.platform === 'win32' && options.runner === undefined) throw new DesktopStartupPackageError('startup-install-failed', true, 'sealed Windows subprocess runner is missing')
  const emit = (diagnostic: StartupPackageDiagnostic): void => { options.log(diagnostic) }
  emit({ source: 'system', level: 'info', text: `startup pnpm command: ${JSON.stringify([options.executable, options.entry, ...options.args])}; cwd: ${options.cwd}; deadline: ${String(config.timeoutMs)}ms` })
  let child: ChildProcess
  // libuv ignore does not create CRT fd 4; the Win32 carrier needs an actual null-device descriptor.
  const nullInput = process.platform === 'win32' ? openSync('\\\\.\\NUL', 'r') : undefined
  try {
    child = process.platform === 'win32'
      ? spawn(options.executable, [options.runner as string, '--', options.executable, options.entry, ...options.args], {
        cwd: options.cwd, env: { ...options.environment, DSH_SUBPROCESS_RUNNER: 'windows' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc', nullInput, 'pipe', 'pipe'], windowsHide: true,
      })
      : spawn(options.executable, [options.entry, ...options.args], {
        cwd: options.cwd, env: options.environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
      })
  } catch (cause) { throw new DesktopStartupPackageError('startup-install-failed', true, 'could not spawn package operation', { cause }) }
  finally { if (nullInput !== undefined) closeSync(nullInput) }
  let stopped: 'startup-install-timeout' | 'startup-install-aborted' | undefined
  let spawnFailure: Error | undefined
  let targetCode: number | undefined
  let runnerFailure: string | undefined
  let invalidResult = false
  const invalidRunnerResult = (): boolean => invalidResult
  let forcedCleanup = false
  const cleanupFailed = (): boolean => forcedCleanup
  let cleanup: ReturnType<typeof setTimeout> | undefined
  const cleanupDeadline = Promise.withResolvers<null>()
  const buffers = [lines((text, omitted) => { emit({ source: 'pnpm', level: 'info', text, truncated: omitted }) }),
    lines((text, omitted) => { emit({ source: 'pnpm', level: 'warning', text, truncated: omitted }) })]
  const targetOutputs = process.platform === 'win32' ? [child.stdio.at(5), child.stdio.at(6)] : [child.stdout, child.stderr]
  for (const [index, output] of targetOutputs.entries()) {
    if (output !== null && output !== undefined && 'setEncoding' in output) {
      output.setEncoding('utf8'); output.on('data', (chunk: string) => { buffers[index]?.append(chunk) })
    }
  }
  const runnerBuffers = [lines((text, omitted) => { emit({ source: 'system', level: 'info', text, truncated: omitted }) }),
    lines((text, omitted) => { emit({ source: 'system', level: 'warning', text, truncated: omitted }) })]
  if (process.platform === 'win32') for (const [index, output] of [child.stdout, child.stderr].entries()) {
    output?.setEncoding('utf8'); output?.on('data', (chunk: string) => { runnerBuffers[index]?.append(chunk) })
  }
  const terminate = (): void => {
    if (process.platform === 'win32') {
      if (child.connected) child.send({ type: 'terminate' }, (error) => { if (error !== null) runnerFailure ??= 'runner cancellation transport failed' })
    } else if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') runnerFailure ??= 'process group termination failed' }
    }
  }
  const requestStop = (reason: typeof stopped): void => {
    if (stopped !== undefined) return
    stopped = reason
    emit({ source: 'system', level: 'error', text: `${reason}: stopping startup pnpm and waiting for its owned process tree` })
    terminate()
    cleanup = setTimeout(() => {
      // The Job is kill-on-close, but a forced runner exit cannot certify its quiescence to this parent.
      forcedCleanup = true; child.kill('SIGKILL')
      cleanupDeadline.resolve(null)
    }, CLEANUP_MS)
  }
  const abort = (): void => { requestStop('startup-install-aborted') }
  const deadline = setTimeout(() => { requestStop('startup-install-timeout') }, config.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  // An observer may have cancelled synchronously during the command diagnostic.
  if (options.signal?.aborted) abort()
  const closed = new Promise<number | null>((resolveClose) => {
    child.once('error', (error) => { spawnFailure = error })
    child.once('close', (code) => { resolveClose(code) })
  })
  if (process.platform === 'win32') {
    child.on('message', (value: unknown) => {
      if (!record(value) || targetCode !== undefined || runnerFailure !== undefined) { invalidResult = true; return }
      if (value.type === 'target-exit' && Number.isSafeInteger(value.exitCode)) targetCode = Number(value.exitCode)
      else if (value.type === 'error' && record(value.error) && typeof value.error.message === 'string') runnerFailure = value.error.message
      else invalidResult = true
    })
    child.send({ type: 'start', cwd: options.cwd,
      env: Object.fromEntries(Object.entries(options.environment).filter((item): item is [string, string] => item[1] !== undefined)) },
    (error) => { if (error !== null) runnerFailure ??= 'runner start transport failed' })
  }
  let code: number | null
  try {
    code = await Promise.race([closed, cleanupDeadline.promise])
    if (process.platform !== 'win32') {
      while (groupAlive(child.pid) && !cleanupFailed()) {
        if (stopped !== undefined) terminate()
        await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 20) })
      }
    }
  } finally {
    clearTimeout(deadline); if (cleanup !== undefined) clearTimeout(cleanup)
    options.signal?.removeEventListener('abort', abort)
    for (const buffer of [...buffers, ...runnerBuffers]) buffer.finish()
  }
  const quiescent = !cleanupFailed() && (process.platform !== 'win32' || code === 0 || spawnFailure !== undefined)
  const exitCode = process.platform === 'win32' ? targetCode : code
  emit({ source: 'system', level: exitCode === 0 && quiescent ? 'info' : 'error',
    text: `startup pnpm exit: ${String(exitCode)}; runner exit: ${String(code)}; process tree quiet: ${String(quiescent)}${runnerFailure === undefined ? '' : `; cause: ${runnerFailure}`}` })
  if (!quiescent) throw new DesktopStartupPackageError('startup-install-cleanup-failed', false, 'owned package process tree did not confirm exit; author links remain detached')
  if (stopped !== undefined) throw new DesktopStartupPackageError(stopped, true, 'owned package process tree stopped')
  if (spawnFailure !== undefined || runnerFailure !== undefined || invalidRunnerResult() || exitCode !== 0) {
    throw new DesktopStartupPackageError('startup-install-failed', true, `pnpm exited with ${String(exitCode)}${runnerFailure === undefined ? '' : `: ${runnerFailure}`}`,
      spawnFailure === undefined ? undefined : { cause: spawnFailure })
  }
}
