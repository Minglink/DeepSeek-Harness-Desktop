/** Two-phase restart admission for the current Desktop Host only. */
import { randomUUID } from 'node:crypto'

/** Host controls needed to reserve idle work before replacing its process. */
export interface ManagedRestartHost {
  updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean>
  inspectQuit(): Promise<{ readonly activeTasks: boolean; readonly scheduledTasks: boolean }>
}

/** Existing backend lifecycle returned by the normal Host factory. */
export interface ManagedRestartBackendHost extends ManagedRestartHost {
  start(): Promise<void>
  stop(): Promise<void>
}

/** Identity supplied by the shell, never accepted from an author request. */
export interface ManagedRestartOwner<Host> {
  readonly host: Host
  readonly generation: number
}

interface Reservation<Host> {
  readonly owner: ManagedRestartOwner<Host>
  readonly requestId: string
  readonly reservationId: string
  readonly abort: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  phase: 'checking' | 'prepared' | 'committed'
  lockAttempted: boolean
  readonly checkingDone: Promise<void>
  operation?: Promise<void>
  release?: Promise<void>
}

/** Dependencies owned by the normal shell lifecycle, outside trial Hosts. */
export interface ManagedRestartOptions<Host extends ManagedRestartHost> {
  current(): ManagedRestartOwner<Host> | undefined
  blocked(): boolean
  restart(signal: AbortSignal): Promise<void>
  failed(error: unknown): void
  reservationTimeoutMs?: number
  restartTimeoutMs?: number
}

function request(value: unknown): { phase: 'prepare' | 'commit' | 'cancel'; requestId: string; reservationId?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('desktop restart: invalid request')
  const frame = value as Record<string, unknown>
  if (!['prepare', 'commit', 'cancel'].includes(String(frame.phase))
    || typeof frame.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(frame.requestId)
    || (frame.reservationId !== undefined && (typeof frame.reservationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(frame.reservationId)))) {
    throw new Error('desktop restart: invalid request')
  }
  return { phase: frame.phase as 'prepare' | 'commit' | 'cancel', requestId: frame.requestId,
    ...(frame.reservationId === undefined ? {} : { reservationId: frame.reservationId }) }
}

/** Reserves an idle current generation, then replaces it after the HTTP response finishes. */
export class DesktopManagedHostRestart<Host extends ManagedRestartHost> {
  private reservation: Reservation<Host> | undefined
  private disposed = false

  /** @param options - Current owner, admission checks, and actual stop/start/navigation. */
  constructor(private readonly options: ManagedRestartOptions<Host>) {
    for (const value of [options.reservationTimeoutMs ?? 30_000, options.restartTimeoutMs ?? 120_000]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('desktop restart: invalid deadline')
    }
  }

  /** Installation and updater admission must refuse writes while a restart owns the profile. */
  get inProgress(): boolean { return this.reservation !== undefined }

  private assertOwner(owner: ManagedRestartOwner<Host>): void {
    const current = this.options.current()
    if (this.disposed || current?.host !== owner.host || current.generation !== owner.generation) {
      throw new Error('desktop restart: current Host required')
    }
    if (this.options.blocked()) throw new Error('desktop restart: shell is busy')
  }

  /**
   * Answer a private IPC call from the Host allocated for this owner.
   * @param value - Validated wire prepare/commit/cancel request.
   * @param owner - Main-owned Host identity captured when it was allocated.
   * @returns Reservation or queue acknowledgement; rejection never authorizes process exit.
   */
  async handle(value: unknown, owner: ManagedRestartOwner<Host>): Promise<object> {
    const frame = request(value)
    if (frame.phase === 'prepare') {
      this.assertOwner(owner)
      if (this.reservation !== undefined) throw new Error('desktop restart: another restart is reserved')
      const abort = new AbortController()
      const checking = Promise.withResolvers<void>()
      const reservation: Reservation<Host> = { owner, requestId: frame.requestId, reservationId: randomUUID(), abort,
        phase: 'checking', lockAttempted: false, checkingDone: checking.promise,
        timer: setTimeout(() => {
          void this.cancel(reservation).catch((error: unknown) => { this.notifyFailure(error) })
        }, this.options.reservationTimeoutMs ?? 30_000) }
      this.reservation = reservation
      try {
        reservation.lockAttempted = true
        if (await owner.host.updateTasks('lock')) throw new Error('desktop restart: active tasks')
        abort.signal.throwIfAborted()
        this.assertOwner(owner)
        const inspection = await owner.host.inspectQuit()
        abort.signal.throwIfAborted()
        this.assertOwner(owner)
        if (inspection.activeTasks || inspection.scheduledTasks) throw new Error('desktop restart: active or scheduled tasks')
        reservation.phase = 'prepared'
        return { accepted: true, reservationId: reservation.reservationId }
      } catch (error) {
        try { await this.release(reservation) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'desktop restart admission and unlock failed') }
        throw error
      } finally { checking.resolve() }
    }
    const reservation = this.reservation
    if (reservation === undefined || reservation.owner.host !== owner.host || reservation.owner.generation !== owner.generation
      || reservation.requestId !== frame.requestId) throw new Error('desktop restart: no matching reservation')
    if (frame.phase === 'cancel') {
      if (reservation.phase === 'committed') throw new Error('desktop restart: replacement has committed')
      await this.cancel(reservation)
      return { cancelled: true }
    }
    this.assertOwner(owner)
    if (reservation.phase !== 'prepared' || frame.reservationId !== reservation.reservationId) throw new Error('desktop restart: prepared reservation required')
    reservation.abort.signal.throwIfAborted()
    reservation.phase = 'committed'
    clearTimeout(reservation.timer)
    // The handler's reply is queued on IPC before this next event-loop turn replaces the child.
    reservation.operation = new Promise<void>((resolve) => { setImmediate(resolve) }).then(async () => {
      this.assertOwner(owner)
      reservation.abort.signal.throwIfAborted()
      const timeout = setTimeout(() => { reservation.abort.abort(new Error('desktop restart: replacement deadline exceeded')) }, this.options.restartTimeoutMs ?? 120_000)
      try { await this.options.restart(reservation.abort.signal) }
      finally { clearTimeout(timeout) }
    }).catch(async (error: unknown) => {
      try { await this.release(reservation) } catch (cleanupError) { error = new AggregateError([error, cleanupError], 'desktop restart failed and could not unlock') }
      this.notifyFailure(error)
    }).finally(() => {
      if (this.reservation === reservation) this.reservation = undefined
    })
    return { queued: true }
  }

  private async cancel(reservation: Reservation<Host>): Promise<void> {
    reservation.abort.abort(new Error('desktop restart: request cancelled'))
    if (reservation.phase === 'checking') await reservation.checkingDone
    await this.release(reservation)
  }

  private release(reservation: Reservation<Host>): Promise<void> {
    if (reservation.release !== undefined) return reservation.release
    if (this.reservation !== reservation) return Promise.resolve()
    reservation.release = Promise.resolve().then(async () => {
      clearTimeout(reservation.timer)
      reservation.abort.abort(new Error('desktop restart: request cancelled'))
      try {
        const current = this.options.current()
        if (reservation.lockAttempted && current?.host === reservation.owner.host && current.generation === reservation.owner.generation) {
          await reservation.owner.host.updateTasks('unlock')
        }
      } finally { if (this.reservation === reservation) this.reservation = undefined }
    }).catch((error: unknown) => {
      // An unsuccessful unlock must enter the shell's failure/recovery policy;
      // clearing the reservation alone cannot prove the original Host is usable.
      this.notifyFailure(error)
      throw error
    })
    return reservation.release
  }

  private notifyFailure(error: unknown): void {
    try { this.options.failed(error) }
    catch (listenerError) { console.error('desktop restart failure listener failed', listenerError) }
  }

  /** @returns Admission unlocked, or committed replacement quiescent after cancellation. */
  async dispose(): Promise<void> {
    this.disposed = true
    const reservation = this.reservation
    if (reservation === undefined) return
    if (reservation.phase === 'committed') {
      reservation.abort.abort(new Error('desktop restart: shell is closing'))
      await reservation.operation
    } else await this.cancel(reservation)
  }
}
