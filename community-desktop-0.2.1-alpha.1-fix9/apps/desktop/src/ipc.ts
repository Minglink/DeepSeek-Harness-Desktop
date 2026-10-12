/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopCommunityApi } from './community-types.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  rendererConsole: 'dsh-desktop:primary-renderer-console',
  communityState: 'dsh-desktop:community-state',
  communityCatalog: 'dsh-desktop:community-catalog',
  communityDetail: 'dsh-desktop:community-detail',
  communityWebsite: 'dsh-desktop:community-website',
  communityInstall: 'dsh-desktop:community-install',
  communityCancel: 'dsh-desktop:community-cancel',
  communityRuntimeLog: 'dsh-desktop:community-runtime-log',
  communityCopyRuntimeLog: 'dsh-desktop:community-copy-runtime-log',
  communityExportRuntimeLog: 'dsh-desktop:community-export-runtime-log',
  communityTaskLog: 'dsh-desktop:community-task-log',
  communityCopyTaskLog: 'dsh-desktop:community-copy-task-log',
  communityExportTaskLog: 'dsh-desktop:community-export-task-log',
  communityEnable: 'dsh-desktop:community-enable',
  communityRemove: 'dsh-desktop:community-remove',
  communityLogin: 'dsh-desktop:community-login',
  communityLogout: 'dsh-desktop:community-logout',
  communityPending: 'dsh-desktop:community-pending',
  communityClaimOpen: 'dsh-desktop:community-claim-open',
  communityAcknowledgeOpen: 'dsh-desktop:community-acknowledge-open',
  communityChanged: 'dsh-desktop:community-changed',
  communityOpen: 'dsh-desktop:community-open',
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  boot: 'dsh-desktop:boot',
  enterWorkspace: 'dsh-desktop:enter-workspace',
  onboardingActive: 'dsh-desktop:onboarding-active',
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  bootFailed: 'dsh-desktop:boot-failed',
  browserAcquire: 'dsh-desktop:browser-acquire',
  browserRelease: 'dsh-desktop:browser-release',
  browserOpenRequested: 'dsh-desktop:browser-open-requested',
  directoryPick: 'dsh-desktop:directory-pick',
  localeBootstrap: 'dsh-desktop:locale-bootstrap',
  localeChanged: 'dsh-desktop:locale-changed',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly community: DesktopCommunityApi
  readonly browser: DesktopBrowserBridge
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Narrow bridge exposed through context isolation. */
/** 激活窗口（首次启动）与主进程之间的契约。 */

/** 启动激活（客户机）：机器码 + 激活码。 */
export interface DshDesktopActivationApi {
  /** 本机机器码；读不到时给原因。 */
  info: () => Promise<{ machineCode?: string; reason?: string }>
  /** 提交激活码；通过后写授权标记并放行，不通过由主进程立刻销毁。 */
  submit: (code: string) => Promise<{ ok: boolean; reason?: string }>
  /** 退出：未激活时关掉程序。 */
  quit: () => Promise<void>
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'dsh-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
