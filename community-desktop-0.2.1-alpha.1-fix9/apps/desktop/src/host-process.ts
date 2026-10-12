/** Electron Node-mode child lifecycle for the shared Web application. */

import { spawn, type ChildProcess } from 'node:child_process'
import { communityProfileStockBundles } from './community-profile-bundles.ts'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { desktopNodeEnvironment } from './node-environment.ts'
import type { CommunityInstallLogChunk } from './community-types.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

type DesktopHostEvent = ReadyEvent | FatalEvent | { readonly type: 'install-log'; readonly chunk: CommunityInstallLogChunk }
  | { readonly type: 'shutdown-complete' } | {
    readonly type: 'update-tasks'
    readonly requestId: number
    readonly active: boolean
    readonly error?: string
  } | {
    readonly type: 'quit-inspection'
    readonly requestId: number
    readonly activeTasks: boolean
    readonly scheduledTasks: boolean
    readonly error?: string
  }

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly requestId: number }>

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
const MAX_INSTALL_LOG_CHARS = 64 * 1024

/** One raw child stream chunk, delivered only to main for task-owned sanitization. */
export interface DesktopHostOutput {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

function isInstallLogChunk(value: unknown): value is CommunityInstallLogChunk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const chunk = value as Record<string, unknown>
  return (chunk.requestId === undefined || typeof chunk.requestId === 'string' && chunk.requestId.length <= 128)
    && typeof chunk.jobId === 'string' && chunk.jobId.length <= 128
    && typeof chunk.cwd === 'string' && chunk.cwd.length <= 32_768
    && Array.isArray(chunk.argv) && chunk.argv.length <= 256
    && chunk.argv.every((arg: unknown) => typeof arg === 'string' && arg.length <= 4096)
    && (chunk.stream === 'stdout' || chunk.stream === 'stderr')
    && typeof chunk.text === 'string' && chunk.text.length <= MAX_INSTALL_LOG_CHARS
    && (chunk.exitCode === undefined || chunk.exitCode === null || Number.isSafeInteger(chunk.exitCode))
}

interface DesktopHostCall {
  readonly type: 'desktop-rpc-request'
  readonly id: number
  readonly method: string
  readonly payload: unknown
}

function isDesktopHostCall(message: unknown): message is DesktopHostCall {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  return candidate.type === 'desktop-rpc-request'
    && Number.isSafeInteger(candidate.id)
    && typeof candidate.method === 'string'
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'install-log':
      return isInstallLogChunk(candidate.chunk)
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

/** One call the Host child makes into this process; a missing method is refused, not ignored. */
export type DesktopNativePathHandlers = Readonly<Record<string, (payload: unknown) => Promise<unknown>>>

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private readonly controlRequests = new Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param methods - Host-initiated calls this process answers, e.g. native path actions.
   * @param onInstallLog - Raw package output on private IPC; main associates and sanitizes the owned task.
   * @param onOutput - Raw Host stdout/stderr for an owned task; callback failures do not stop the child.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly methods: DesktopNativePathHandlers = {},
    private readonly onInstallLog?: (chunk: CommunityInstallLogChunk) => void,
    private readonly onOutput?: (chunk: DesktopHostOutput) => void,
  ) {}

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'bootstrap.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      env: { ...desktopNodeEnvironment(this.node, undefined, this.environment),
        DSH_DESKTOP_STOCK_BUNDLES: JSON.stringify(communityProfileStockBundles(this.projectDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    for (const stream of ['stdout', 'stderr'] as const) {
      const output = child[stream]
      const decoder = new StringDecoder('utf8')
      let ended = false
      let incompleteLine = false
      const deliver = (text: string): void => {
        if (stream === 'stderr') this.stderr = (this.stderr + text).slice(-MAX_HOST_DIAGNOSTIC_CHARS)
        if (text !== '') {
          incompleteLine = !text.endsWith('\n')
          this.reportOutput({ stream, text })
        }
      }
      output?.on('data', (chunk: Buffer) => { deliver(decoder.write(chunk)) })
      const end = (): void => {
        if (ended) return
        ended = true
        deliver(decoder.end())
        if (incompleteLine) this.reportOutput({ stream, text: '\n' })
      }
      output?.once('end', end)
      output?.once('close', end)
    }
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (isDesktopHostCall(message) && child.connected) {
        void this.answer(message, child)
        return
      }
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'install-log') {
        try { this.onInstallLog?.(message.chunk) }
        catch (_error) { console.error('Desktop installation log callback failed') }
      }
      else if (message.type === 'ready') this.readyResolve({ url: message.url, injections: message.injections })
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  private reportOutput(chunk: DesktopHostOutput): void {
    try { this.onOutput?.(chunk) }
    catch (_error) { console.error('Desktop Host output callback failed') }
  }

  /**
   * Run one Host-initiated call and answer it on the same channel.
   *
   * The reply always carries its own id, so a rejection reaches the Host as a
   * failed call instead of leaving the caller waiting: a native path action
   * that never answers is the silent no-op this channel exists to remove.
   * @param call - the decoded request.
   * @param child - the connected child that asked.
   */
  private async answer(call: DesktopHostCall, child: ChildProcess): Promise<void> {
    const method = this.methods[call.method]
    const reply = (frame: { ok: boolean; payload?: unknown; error?: string }): void => {
      child.send({ type: 'desktop-rpc-response', id: call.id, ...frame }, (error) => {
        if (error !== null) console.error(`desktop host method ${call.method} reply failed`, error)
      })
    }
    if (method === undefined) {
      reply({ ok: false, error: `desktop rpc: unknown method ${call.method}` })
      return
    }
    try {
      reply({ ok: true, payload: await method(call.payload) })
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' } | { readonly type: 'quit-inspection' },
    deadlineMs: number, deadlineMessage: string,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error(`${request.type === 'update-tasks' ? 'desktop update' : 'desktop quit'}: Host is unavailable`)
    }
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => { reject(new Error(deadlineMessage)) }, deadlineMs)
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      this.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private fail(error: Error): void {
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
