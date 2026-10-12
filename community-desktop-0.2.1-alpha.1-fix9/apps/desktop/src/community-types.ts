/** Credential-free records shared by the desktop community panel and its isolated preload. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One community catalog item; download locations remain owned by the main process. */
export interface CommunityPlugin {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly author?: string
  readonly category?: string
  readonly tags?: readonly string[]
  readonly platform?: string
  readonly source?: string
  readonly icon?: string
  readonly readme?: string
  readonly price?: number
  readonly compatibility?: string
  readonly npmPackage?: string
  readonly permissions?: readonly string[]
  readonly screenshots?: readonly string[]
  readonly harnessVersion?: string
  /** Display-only full-package distribution; downloads and author instructions open on the community website. */
  readonly manualDistribution?: true
  /** Display-only installation boundary; release instructions remain on the community website. */
  readonly installationBoundary?: true
}

/** Server-side directory filters; account authorization never comes from these fields. */
export interface CommunityCatalogQuery {
  readonly query?: string
  readonly category?: string
  readonly tag?: string
  readonly platform?: 'all' | 'desktop-exe' | 'web' | 'linux'
  readonly source?: 'all' | 'official' | 'community' | 'user_upload'
  readonly sortBy?: 'hot' | 'essential' | 'soaring' | 'newest' | 'downloads' | 'stars' | 'rating'
  readonly page?: number
  readonly pageSize?: number
}

/** Validated full plugin metadata returned by the community detail endpoint. */
export interface CommunityPluginDetail extends CommunityPlugin {}

/** A complete validated catalog, including the age and origin of an offline copy. */
export interface CommunityCatalog {
  readonly plugins: readonly CommunityPlugin[]
  readonly updatedAt: number
  readonly cached: boolean
  readonly skippedCount?: number
  readonly total?: number
  readonly page?: number
  readonly pageSize?: number
  readonly totalPages?: number
}

/** Account metadata safe for product renderers. */
export interface CommunityAccountSummary {
  readonly username: string
  readonly email: string
}

/** Sign-in failures safe to transport without credentials or server diagnostics. */
export type CommunityLoginFailureCode = 'invalid-account' | 'login-invalid-credentials' | 'login-forbidden'
  | 'login-rate-limited' | 'login-network-failed' | 'login-storage-failed' | 'login-invalid-response' | 'login-server-failed'

/** A fixed sign-in code selected by the main process. */
export interface CommunityLoginProblem {
  readonly code: CommunityLoginFailureCode
}

/** A persisted sign-in result; success exposes no session token to the renderer. */
export type CommunityLoginResult = { readonly ok: true } | { readonly ok: false; readonly problem: CommunityLoginProblem }

/** Localized failures are selected in the client from this code; details are optional diagnostics. */
export interface CommunityProblem {
  readonly code: string
  readonly details?: string
}

/** The identity of one main-owned installation. */
export type CommunityTaskId = string & { readonly __communityTaskId: unique symbol }

/** A protocol or catalog selection awaiting explicit confirmation in the product panel. */
export interface CommunityInstallIntent {
  readonly id: string
  readonly name: string
  readonly version?: string
  /** Display-only origin supplied by main for an external protocol selection. */
  readonly sourceOrigin?: string
}

/** Main-owned progress survives panel navigation and is never inferred from plugin counts. */
export interface CommunityTask {
  readonly id: CommunityTaskId
  readonly plugin: CommunityInstallIntent
  readonly phase: 'queued' | 'downloading' | 'adapting' | 'validating' | 'packaging' | 'trial' | 'installing' | 'activating' | 'rolling-back' | 'cancelling' | 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly restored?: boolean
  readonly adapted?: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly receivedBytes?: number
  readonly totalBytes?: number
  readonly packageName?: string
  readonly version?: string
  readonly problem?: CommunityProblem
}

/** Sanitized, main-owned diagnostic output retained separately from task summaries. */
export interface CommunityTaskLogEntry {
  readonly sequence: number
  readonly time: number
  readonly phase: CommunityTask['phase']
  readonly level: 'info' | 'warning' | 'error'
  readonly source: 'system' | 'pnpm' | 'host'
  readonly text: string
  readonly code?: string
  readonly exitCode?: number | null
}

/** A bounded log tail; cursors are monotonic even when older entries have been discarded. */
export interface CommunityTaskLog {
  readonly id: CommunityTaskId
  readonly entries: readonly CommunityTaskLogEntry[]
  readonly nextCursor: number
  readonly truncated: boolean
  /** Reading or saving this task's durable log failed. */
  readonly unavailable: boolean
}

/** Output from an owned native installer; never transported directly to the renderer. */
export interface CommunityInstallLogChunk {
  readonly requestId?: string
  readonly jobId: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
  readonly exitCode?: number | null
}

/** The current desktop profile's bundle controls, projected from the native plugin manager. */
export interface CommunityBundle {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly enabled: boolean
  readonly removable: boolean
  readonly readOnly: boolean
  readonly problem?: CommunityProblem
}

/** One persisted native management result, without subprocess credentials or raw log streams. */
export interface CommunityChange {
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly changed: boolean
  readonly problem?: CommunityProblem
}

/** State queries fail explicitly when the Host is unavailable; account and tasks remain readable. */
export interface CommunityState {
  readonly account: CommunityAccountSummary | null
  readonly bundles: readonly CommunityBundle[]
  readonly tasks: readonly CommunityTask[]
  readonly hostProblem?: CommunityProblem
}

/** The identity of a main-owned market request; replacement renderers may claim the same pending request. */
export type CommunityNavigationId = Branded<'CommunityNavigationId'>

/** Client failures captured by the owned Desktop window; unrelated to installation tasks. */
export interface CommunityRuntimeLogEntry {
  readonly sequence: number
  readonly time: number
  readonly source: 'renderer' | 'system' | 'pnpm'
  readonly level: 'info' | 'warning' | 'error'
  readonly text: string
  readonly file?: string
  readonly line?: number
}

/** Bounded durable client diagnostics, readable while the Host is unavailable. */
export interface CommunityRuntimeLog {
  readonly entries: readonly CommunityRuntimeLogEntry[]
  readonly nextCursor: number
  readonly truncated: boolean
  readonly unavailable: boolean
}

/** Narrow community capability exposed only to the application's owning top-level renderer. */
export interface DesktopCommunityApi {
  getState(): Promise<CommunityState>
  catalog(refresh?: boolean, query?: CommunityCatalogQuery): Promise<CommunityCatalog>
  detail(id: string): Promise<CommunityPluginDetail>
  /** @param target - Opens only the community homepage or registration page in the system browser when selected. */
  openWebsite(path?: string, target?: 'system-browser'): Promise<void>
  install(intent: Pick<CommunityInstallIntent, 'id' | 'name' | 'version'>): Promise<CommunityTask>
  cancel(id: CommunityTaskId): Promise<void>
  /** Optional for market UI loaded by an older Desktop package. */
  getRuntimeLog?(after?: number): Promise<CommunityRuntimeLog>
  copyRuntimeLog?(): Promise<void>
  /** @returns False when the native save dialog was cancelled. */
  exportRuntimeLog?(): Promise<boolean>
  getTaskLog(id: CommunityTaskId, after?: number): Promise<CommunityTaskLog>
  copyTaskLog(id: CommunityTaskId): Promise<void>
  /** @returns False when the native save dialog was cancelled. */
  exportTaskLog(id: CommunityTaskId): Promise<boolean>
  setEnabled(name: string, enabled: boolean): Promise<CommunityChange>
  remove(name: string): Promise<CommunityChange>
  login(email: string, password: string): Promise<CommunityLoginResult>
  logout(): Promise<void>
  takePending(): Promise<CommunityInstallIntent | null>
  /** @returns The current pending request, without consuming it during a renderer reload. */
  claimOpen(): Promise<CommunityNavigationId | null>
  /** @param request - Request selected by this live client before acknowledgement. */
  acknowledgeOpen(request: CommunityNavigationId): Promise<void>
  subscribe(listener: () => void): () => void
  subscribeOpen(listener: () => void): () => void
}
