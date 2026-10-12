/** Authenticated HTTP restart capability provided only by the Desktop Host. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Consumer delegates response ownership; no author-controlled process exit is involved. */
export interface DesktopHostRestart {
  /**
   * Own the authenticated HTTP response and commit only after it finishes.
   * @param request - Bodyless POST carrying the existing Connection authority.
   * @param response - Route-owned Node response.
   * @returns Completion of refusal or the committed queue acknowledgement.
   */
  request(request: IncomingMessage, response: ServerResponse): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context { desktopHostRestart: DesktopHostRestart }
}

/** Only the prepared normal Host receives a corresponding shell-owned method. */
export const name = 'desktop-managed-host-restart'
const DEADLINE_MS = 15_000
const MAX_PENDING_CALLS = 64
const MAX_ERROR_CHARACTERS = 4_096
// native-path uses positive integer RPC ids; negative ids keep the two reply listeners disjoint.
let restartSequence = 0

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

function diagnostic(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).slice(0, MAX_ERROR_CHARACTERS)
}

/**
 * Publish authenticated restart request handling with bounded private IPC.
 * @param ctx - Preparation context owning listeners and the provided service.
 */
export function apply(ctx: Context): void {
  let stopped = false
  const pending = new Map<number, Pending>()
  const listen = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'desktop-rpc-response'
      || !('id' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id >= 0) return
    const call = pending.get(value.id)
    if (call === undefined) return
    pending.delete(value.id)
    clearTimeout(call.timer)
    if ('ok' in value && value.ok === true && 'payload' in value) call.resolve(value.payload)
    else call.reject(new Error('error' in value && typeof value.error === 'string' ? value.error.slice(0, MAX_ERROR_CHARACTERS) : 'desktop restart: IPC refused'))
  }
  process.on('message', listen)
  ctx.effect(() => () => {
    stopped = true
    process.off('message', listen)
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('desktop restart: Host stopped')) }
    pending.clear()
  })
  const call = (payload: object): Promise<unknown> => {
    if (stopped || !process.connected || process.send === undefined) return Promise.reject(new Error('desktop restart: shell capability unavailable'))
    if (pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error('desktop restart: too many pending calls'))
    if (restartSequence <= Number.MIN_SAFE_INTEGER) return Promise.reject(new Error('desktop restart: IPC sequence exhausted'))
    const id = --restartSequence
    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        const current = pending.get(id)
        if (current !== undefined) clearTimeout(current.timer)
        pending.delete(id)
        reject(error)
      }
      pending.set(id, { resolve, reject, timer: setTimeout(() => { fail(new Error('desktop restart: IPC deadline exceeded')) }, DEADLINE_MS) })
      try { process.send?.({ type: 'desktop-rpc-request', id, method: 'managed-host-restart', payload }, (error) => { if (error !== null) fail(error) }) }
      catch (error) { fail(new Error(diagnostic(error))) }
    })
  }
  ctx.provide('desktopHostRestart', {
    request: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
      const connection = ctx.get('connection')
      if (connection === undefined) { response.writeHead(503); response.end(); return }
      const admission = connection.admit(request)
      if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return }
      // Restart is bodyless. Reject Transfer-Encoding and payload lengths before asking the shell.
      if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
        response.writeHead(400); response.end(); return
      }
      const requestId = randomUUID()
      let closed = false
      let finished = false
      const isClosed = (): boolean => closed || response.destroyed
      const cancel = (): void => { if (!finished && !closed) { closed = true; void call({ phase: 'cancel', requestId }).catch((error: unknown) => { console.warn('desktop restart cancellation failed', diagnostic(error)) }) } }
      request.once('aborted', cancel)
      response.once('close', cancel)
      try {
        const result = await call({ phase: 'prepare', requestId })
        if (isClosed()) return
        if (typeof result !== 'object' || result === null || !('accepted' in result) || result.accepted !== true
          || !('reservationId' in result) || typeof result.reservationId !== 'string'
          || !/^[a-zA-Z0-9-]{1,128}$/.test(result.reservationId)) throw new Error('desktop restart: invalid reservation response')
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => { response.off('close', onClose); response.off('error', onError); response.off('finish', onFinish) }
          const onClose = (): void => { cleanup(); if (!finished) reject(new Error('desktop restart: response closed before acknowledgement')) }
          const onError = (error: Error): void => { cleanup(); reject(error) }
          const onFinish = (): void => { finished = true; cleanup(); resolve() }
          response.once('close', onClose)
          response.once('error', onError)
          response.once('finish', onFinish)
          try {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
            response.end(JSON.stringify({ status: 'restarting' }))
          } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error(diagnostic(error))) }
        })
        const committed = await call({ phase: 'commit', requestId, reservationId: result.reservationId })
        if (typeof committed !== 'object' || committed === null || !('queued' in committed) || committed.queued !== true) {
          throw new Error('desktop restart: invalid commit response')
        }
      } catch (error) {
        await call({ phase: 'cancel', requestId }).catch((cancelError: unknown) => { console.warn('desktop restart reservation release failed', diagnostic(cancelError)) })
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          response.end(JSON.stringify({ status: 'refused', message: diagnostic(error) }))
        } else console.warn('desktop managed restart failed', diagnostic(error))
      } finally { request.off('aborted', cancel); response.off('close', cancel) }
    },
  })
}
