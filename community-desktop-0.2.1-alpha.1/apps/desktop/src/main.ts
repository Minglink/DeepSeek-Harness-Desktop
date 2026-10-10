/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
import { DesktopProjectManager } from './project-manager.ts'
import {
  DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError, type DesktopNativePathHandlers,
} from './host-process.ts'
import { installDesktopDirectoryPicker } from './directory-picker.ts'
import { installMicrophonePermissions } from './microphone-permissions.ts'
import { DesktopBackendController } from './backend-controller.ts'
import { clearProxyEnvironment, directEgressEnabled } from './direct-egress.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender, type DesktopUpdateState } from './ipc.ts'
import { desktopUpdateReadyConfirmation, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { DesktopCommandManager } from './command-management.ts'
import { serveWebDocument, authenticateWebHost, forwardWebRequest } from './web-document.ts'
import { DesktopFatalRecovery } from './fatal-recovery.ts'
import { pruneCrashReports, RendererConsoleTail, writeCrashReport, type CrashReportSource } from './crash-report.ts'
import { openWelcomeWindow } from './welcome-window.ts'
import { needsWelcome } from './welcome-api.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from './welcome-backend.ts'
import { DesktopUpdateJournal } from './update-journal.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from './update-presentation.ts'
import { desktopErrorState } from './startup-error.ts'
import { readDesktopLoginShellEnvironment, resolveDesktopLoginShellConfig } from './login-shell-environment.ts'
import { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig } from './mandatory-update-policy.ts'
import { desktopClientMetadata, desktopClientVersion } from './client-metadata.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import { DesktopMandatoryUpdateWindow } from './mandatory-update-window.ts'
import { DesktopUpdateDialog, type UpdateDialogOptions } from './update-dialog.ts'
import { DesktopBrowserGuests } from './browser-guests.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readCommunityAccount, readConfig, loginCommunityAccount, logoutCommunityAccount } from './api-vault.ts'
import type { CommunityLoginResult } from './community-types.ts'
import { parseDshUrl, type DshProtocolParams } from './installer.ts'
import { DesktopCommunityService } from './community-service.ts'
import { DesktopCommunityNavigation, communityWebsiteDestination } from './community-navigation.ts'
import { invokeCommunityBackend } from './community-backend.ts'
import { CommunityProfileTransaction, CommunityTransactionError, communityTrialEnvironment } from './community-transaction.ts'
import { assertCommunityBundleReady, trialCommunityBundle } from './community-trial.ts'
import type { PreparedCommunityBundle } from './community-install.ts'
import { communityCatalogQuery } from './community-catalog.ts'
import { prepareCommunityTrialProfile } from './community-trial-profile.ts'
import { LOADING_IMAGE_DATA_URL } from './loading-image.ts'
import { WORDMARK_IMAGE_DATA_URL } from './wordmark-image.ts'
import { installDesktopShortcuts } from './keyboard.ts'
import { DesktopUpdateOverlays } from './update-overlay.ts'
import { DesktopQuitConfirmation } from './quit-confirmation.ts'
import { DesktopTray } from './tray.ts'
import { DesktopBackgroundNotice } from './background-notice.ts'

let focusPrimaryWindow = (): void => {}
let stopForRecovery = async (): Promise<void> => {}
let shuttingDown = false
/**
 * Set by quit entries that must not ask: crash recovery exit and restart, and the
 * development restart command. The installer handoff has its own before-quit branch.
 */
let skipQuitConfirmation = false
let windowsLanguage: string | undefined
/**
 * Whether the backend has reached ready: false until the first ready, back to
 * false when a restart returns it to starting, frozen during shutdown so a
 * failure while tearing down a ready backend still reads as `running`.
 */
let backendReady = false
/** Error-level console output of the primary window, attached to crash reports. */
const rendererConsole = new RendererConsoleTail()

// Platform-conventional logs directory (macOS ~/Library/Logs/<name>, otherwise under userData);
// set before ready so the first fatal report already resolves under it.
app.setAppLogsPath()

/**
 * Directory holding the arguments and authorization marker the activation gate owns.
 * @returns Desktop data root inside the shared Harness home.
 */
function desktopDataRoot(): string {
  return join(resolveDshHome(), 'desktop')
}

/** Frameless whale splash shown while the Host runtime comes up. */
let loadingWindow: BrowserWindow | undefined

/** Show the whale loading splash (frameless, centered, always-on-top). */
function showLoadingWhale(): void {
  if (loadingWindow !== undefined) return
  loadingWindow = new BrowserWindow({
    width: 560,
    height: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  loadingWindow.once('ready-to-show', () => { loadingWindow?.show() })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  .wrap{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative}
  .sea{position:absolute;bottom:16px;left:0;right:0;height:60px;opacity:0.35}
  .whale{animation:float 2.2s ease-in-out infinite;position:relative;z-index:2}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-24px)}}
  .wordmark{margin-top:18px;position:relative;z-index:2;display:block}
  </style></head><body>
  <div class="wrap">
    <svg class="sea" viewBox="0 0 760 90" preserveAspectRatio="none">
      <path d="M0 65 Q95 45 190 65 T380 65 T570 65 T760 65 V90 H0 Z" fill="#4f7cff" opacity="0.5">
        <animate attributeName="d" dur="3s" repeatCount="indefinite"
          values="M0 65 Q95 45 190 65 T380 65 T570 65 T760 65 V90 H0 Z;
                  M0 65 Q95 90 190 65 T380 65 T570 65 T760 65 V90 H0 Z;
                  M0 65 Q95 45 190 65 T380 65 T570 65 T760 65 V90 H0 Z"/>
      </path>
    </svg>
    <img class="whale" src="${LOADING_IMAGE_DATA_URL}" alt="" width="466" height="366">
    <img class="wordmark" src="${WORDMARK_IMAGE_DATA_URL}" alt="DeepSeek" width="466" height="102">
  </div>
  </body></html>`
  void loadingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  loadingWindow.on('closed', () => { loadingWindow = undefined })
}

/** Close the splash once the real window owns the screen. */
function hideLoadingWhale(): void {
  if (loadingWindow !== undefined && !loadingWindow.isDestroyed()) loadingWindow.close()
  loadingWindow = undefined
}





/**
 * Whether the whale splash stays out of this launch.
 *
 * The splash is a second top-level window; a harness that drives the shell one
 * window at a time (and the recorded automated checks) turns it off rather than
 * teaching every scenario about an extra window.
 * @param environment - process environment carrying the switch.
 * @returns true when this launch starts without the splash.
 */
function splashDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DSH_DESKTOP_NO_SPLASH === '1'
}

function currentDesktopLocale(): ReturnType<typeof resolveDesktopLocale> {
  return resolveDesktopLocale(windowsLanguage ?? app.getLocale())
}
/** Quit without the task confirmation; the caller has already decided the application must stop. */
function quitWithoutConfirmation(): void {
  skipQuitConfirmation = true
  app.quit()
}
const recovery = new DesktopFatalRecovery({
  messages: () => currentDesktopLocale().messages,
  show: options => dialog.showMessageBox(options),
  stop: () => { shuttingDown = true; return stopForRecovery() },
  disablePlugins: async () => {
    const manager = new DesktopProjectManager(resolveDesktopPaths(), runtimeResources())
    const backupPath = await manager.disableAllPlugins()
    console.info('Desktop profile recovery completed:', { profilePatchBackup: backupPath ?? null, homePatch: 'unchanged' })
  },
  exit: () => { quitWithoutConfirmation() },
  restart: () => { app.relaunch(); quitWithoutConfirmation() },
  writeReport: (error, source) => persistCrashReport(error, source),
})

function persistCrashReport(error: unknown, source: CrashReportSource): Promise<string | undefined> {
  return writeCrashReport(app.getPath('logs'), {
    source,
    phase: backendReady ? 'running' : 'startup',
    error,
    ...(error instanceof DesktopHostFatalError && error.diagnostic !== undefined ? { hostDiagnostic: error.diagnostic } : {}),
    rendererConsole: rendererConsole.snapshot(),
    app: {
      name: app.name, version: app.getVersion(), platform: process.platform, arch: process.arch,
      electron: process.versions.electron, node: process.versions.node, locale: currentDesktopLocale().id,
    },
    time: new Date(),
  })
}

function reportFatal(error: unknown, source: CrashReportSource): void {
  console.error(error)
  // The splash must never cover the dialog that explains the failure.
  hideLoadingWhale()
  if (shuttingDown) {
    // No dialog during shutdown, but the report still records what failed on the way out.
    void persistCrashReport(error, source)
    return
  }
  void recovery.report(error, source).catch((failure: unknown) => { console.error(failure); app.exit(1) })
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

interface RuntimeResources {
  readonly nodeBin: string
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = process.execPath
  const nodeBin = development ? join(app.getAppPath(), 'scripts', 'node-bin') : join(process.resourcesPath, 'runtime', 'bin')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? (development ? join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      : join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))
  return { node, nodeBin, pnpm, dsh }
}

function developmentPrimaryRuntime(): string {
  const directory = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  if (directory === undefined || directory === '') {
    throw new Error('dsh desktop: DSH_DESKTOP_PRIMARY_RUNTIME_DIR is required for an unpackaged launch')
  }
  return directory
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

/**
 * Opaque chrome fallback matching the built-in sidebar palette (the resolved
 * `--dsw-static-neutral-bluish-900` / `-50` tokens). An approximation for
 * custom themes: Windows swaps in the renderer's measured palette over the
 * windowsAppearance IPC, and macOS shows it only while minimized or hidden.
 * @returns the sidebar fill hex for the active system color scheme.
 */
function chromeFallbackFill(): string {
  return nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb'
}

function createWindow(preload: string, show = false, primary = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show,
    ...(process.platform === 'win32' && primary ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: chromeFallbackFill(),
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: primary,
      devTools: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.platform === 'darwin') {
    // macOS hides the traffic lights in fullscreen; the page drops its
    // clearance for them off the html[data-fullscreen] flag this feeds.
    const sendFullscreen = (): void => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.windowFullscreen, window.isFullScreen())
    }
    window.on('enter-full-screen', sendFullscreen)
    window.on('leave-full-screen', sendFullscreen)
    // Reloads and navigations re-register the preload listener; resend the
    // current state so a fullscreen reload does not fall back to windowed CSS.
    window.webContents.on('did-finish-load', sendFullscreen)
    // Deminiaturize reattaches the NSVisualEffectView material late
    // (electron/electron#25368), so a transparent window shows the desktop
    // through the sidebar until then. Paint an opaque base while minimized or
    // hidden so the deminiaturize animation and the reattachment gap show a
    // solid fill; restoring flips back, and the null -> 'sidebar' transition
    // forces the material to reattach.
    const applyBackdrop = (): void => {
      if (window.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) {
        window.setVibrancy(null)
        window.setBackgroundColor(chromeFallbackFill())
      } else {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      }
    }
    window.on('minimize', applyBackdrop)
    window.on('hide', applyBackdrop)
    window.on('restore', applyBackdrop)
    window.on('show', applyBackdrop)
  }
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) {
      const messages = currentDesktopLocale().messages
      Menu.buildFromTemplate(items.map(item => ({
        ...item,
        ...(process.platform === 'win32' && item.role !== undefined && item.role in messages
          ? { label: messages[item.role as keyof typeof messages] } : {}),
        accelerator: '',
      }))).popup({ window })
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    if (destination.protocol !== `${SCHEME}:`
      && !(destination.protocol === 'http:' && destination.origin === current.origin)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  return window
}

/**
 * Native file-manager and default-application integration for the Host child.
 *
 * `shell.showItemInFolder` and `shell.openPath` are Electron's own desktop APIs;
 * an `explorer.exe /select,` spawned from the child exits "successfully" while
 * showing nothing, which is what the deliverables card's "Show in File Explorer"
 * reported. The child reaches these over the process IPC channel it already
 * uses for `ready`/`fatal`/`update-tasks`, by method name.
 * @returns One handler per method the Host child may call.
 */
function desktopNativePathHandlers(): DesktopNativePathHandlers {
  const pathOf = (payload: unknown): string => {
    const path = (payload as { path?: unknown }).path
    if (typeof path !== 'string' || path === '') throw new Error('desktop rpc: native path is required')
    return path
  }
  return {
    'native-reveal-path': (payload) => {
      shell.showItemInFolder(pathOf(payload))
      return Promise.resolve({ revealed: true })
    },
    'native-open-path': async (payload) => {
      const failure = await shell.openPath(pathOf(payload))
      if (failure !== '') throw new Error(`dsh desktop: open failed: ${failure}`)
      return { opened: true }
    },
  }
}

let hubMarketWindow: BrowserWindow | null = null
let openCommunityMarket = (_intent?: DshProtocolParams): void => {}
let rejectCommunityProtocol = (): void => {}
const pendingProtocolUrls: string[] = []
let receiveProtocolUrl = (url: string): void => { pendingProtocolUrls.push(url) }
app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveProtocolUrl(url)
})

async function injectCommunityCookie(): Promise<void> {
  const token = readCommunityAccount()?.token
  if (!token) return
  await session.defaultSession.cookies.set({
    url: 'https://deepseek.stream', name: 'deepseek_hub_auth_token', value: token,
    domain: '.deepseek.stream', path: '/', httpOnly: true, secure: true, sameSite: 'lax',
  })
}

async function openHubMarketWindow(title: string, path?: string): Promise<void> {
  await injectCommunityCookie()
  if (hubMarketWindow !== null && !hubMarketWindow.isDestroyed()) {
    if (hubMarketWindow.isMinimized()) hubMarketWindow.restore()
    hubMarketWindow.show()
    hubMarketWindow.focus()
    if (path !== undefined) await hubMarketWindow.loadURL(new URL(path, 'https://deepseek.stream').href)
    return
  }
  hubMarketWindow = new BrowserWindow({
    width: 1240, height: 840, title,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  const window = hubMarketWindow
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^dsh:/iu.test(url)) handleDshProtocolUrl(url)
    else if (new URL(url).origin === 'https://deepseek.stream') {
      void window.loadURL(url).catch(() => { console.warn('Community link could not be opened') })
    } else if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (/^dsh:/iu.test(url)) {
      event.preventDefault()
      handleDshProtocolUrl(url)
    } else if (new URL(url).origin !== 'https://deepseek.stream') {
      event.preventDefault()
      if (url.startsWith('https://')) void shell.openExternal(url)
    }
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
  window.on('closed', () => { if (hubMarketWindow === window) hubMarketWindow = null })
  await window.loadURL(new URL(path ?? '/', 'https://deepseek.stream').href)
}

function findDshUrl(args: readonly string[]): string | null {
  return args.find(arg => /^dsh:/iu.test(arg)) ?? null
}

function handleDshProtocolUrl(url: string): void {
  const intent = parseDshUrl(url)
  if (intent === null) rejectCommunityProtocol()
  else openCommunityMarket(intent)
}

async function main(): Promise<void> {
  void pruneCrashReports(app.getPath('logs'))
  const resources = runtimeResources()
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  // The custom scheme serves both the shell's own documents and the
  // application, and `protocol.handle` accepts one registration per scheme.
  // Filled in once the Host process reports its authenticated URL.
  let hostUrl: string | undefined
  let hostCookie: string | undefined
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveWebDocument(request, join(app.getAppPath(), 'renderer'))
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
      || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
      return serveWebDocument(request, join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
    }
    if (hostUrl === undefined || hostCookie === undefined) {
      return Promise.resolve(new Response(null, { status: 503 }))
    }
    return forwardWebRequest(request, hostUrl, hostCookie)
  })

  const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const updateJournal = journalDirectory === undefined ? undefined : new DesktopUpdateJournal(journalDirectory, app.getVersion())
  const paths = resolveDesktopPaths()
  const development = !app.isPackaged
  const primaryRuntime = development
    ? developmentPrimaryRuntime()
    : join(process.resourcesPath, 'runtime', 'primary-runtime')
  const activeProject = paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  // Dock and Finder launches inherit only launchd's environment; every Host shares one login-shell read.
  const loginShellRead = new AbortController()
  // The probe runs in its own process group, which outlives Desktop unless the read is aborted.
  app.on('will-quit', () => { loginShellRead.abort() })
  const loginShell = readDesktopLoginShellEnvironment(process.env, resolveDesktopLoginShellConfig(process.env), {
    signal: loginShellRead.signal,
  }).then((result) => {
    for (const failure of result.failures) console.warn(`desktop login shell: ${failure.shell} failed (${failure.reason})`)
    return result.environment
  })
  let hostEnvironment: NodeJS.ProcessEnv = process.env
  const prepareHostEnvironment = async (): Promise<void> => { hostEnvironment = await loginShell }
  let quitting = false
  let startup: Promise<void> | undefined
  let workspaceRecovery: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let welcomeWindow: BrowserWindow | undefined
  let enteredWorkspace = false
  // NSIS passes --updated when it launches the application after installation.
  let raiseAfterUpdate = process.platform === 'win32' && process.argv.includes('--updated')
  let shellInstallerOwnsQuit = false
  let requireCleanStop = false
  let updateStoppedHost = false
  let updateStopFailure: DesktopHostUncleanExitError | undefined
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const systemLanguages = app.getPreferredSystemLanguages()
  let locale = resolveDesktopStartupLocale(null, systemLanguages)
  windowsLanguage = locale.id
  let mandatoryPolicy: DesktopMandatoryUpdatePolicy | undefined
  let mandatoryUI: DesktopMandatoryUpdateWindow | undefined
  let tray: DesktopTray | undefined
  /**
   * The operating system is ending the session: the quit skips its confirmation. Windows sets it
   * on the definitive session-end message. macOS sets it on the power-off notification, which
   * another application can still cancel, so the next focus or show of the main window clears it.
   */
  let sessionEnding = false
  const isQuitting = (): boolean => quitting
  const currentMainWindow = (): BrowserWindow | undefined => mainWindow
  const ordinaryDialogs = new Set<AbortController>()
  const currentDialogWindow = (): BrowserWindow | undefined => welcomeWindow ?? mainWindow
  const updateOverlays = new DesktopUpdateOverlays()
  const updateDialog = new DesktopUpdateDialog(fileURLToPath(new URL('./preload-update-dialog.cjs', import.meta.url)), () => locale, updateOverlays)
  const isMandatory = (): boolean => mandatoryPolicy?.state.blocking === true
  const ordinaryMessageBox = async (options: UpdateDialogOptions): Promise<Electron.MessageBoxReturnValue> => {
    const controller = new AbortController()
    ordinaryDialogs.add(controller)
    try {
      const parent = currentDialogWindow()
      if (parent === undefined) return { response: options.cancelId ?? 0, checkboxChecked: false }
      return await updateDialog.show(parent, { ...options, signal: controller.signal })
    }
    finally { ordinaryDialogs.delete(controller) }
  }
  // Copy comes from the same locale as the update prompts so the dialog
  // chrome and its content never mix languages.
  const showAbout = async (): Promise<void> => {
    await ordinaryMessageBox({ type: 'info', title: locale.messages.aboutMenu, message: locale.messages.aboutProduct,
      detail: formatDesktopMessage(locale.messages.aboutVersion, { version: app.getVersion() }),
      buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
  }
  rejectCommunityProtocol = () => {
    void ordinaryMessageBox({ type: 'error', title: locale.messages.communityLinkTitle,
      message: locale.messages.communityLinkInvalid, buttons: [locale.messages.updateAcknowledge], cancelId: 0 })
      .catch(() => { console.warn('Community link error could not be displayed') })
  }
  const commandManager = new DesktopCommandManager({
    resources: process.resourcesPath,
    isPackaged: app.isPackaged,
    isInstalledLocation: () => process.platform !== 'darwin' || app.isInApplicationsFolder(),
    isInstalling: () => updateState.phase === 'installing',
    isQuitting,
    messages: () => currentDesktopLocale().messages,
    show: ordinaryMessageBox,
  })
  const applicationUrl = `${SCHEME}://app/`
  const browserGuests = new DesktopBrowserGuests(() => hostUrl)
  let injections: readonly unknown[] = []
  let welcomeBackend: DesktopWelcomeBackend | undefined
  const assertProductSender = (event: IpcMainInvokeEvent): void => {
    assertDesktopSender(event, ['app'])
    if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected IPC from an unowned renderer')
    }
  }
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || shuttingDown || window.isDestroyed() || navigation !== next
        || (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED')) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  let communityHostOperation = false
  let backendGeneration = 0
  let recoverCommunityFailure: (generation: number) => Promise<boolean> = () => Promise.resolve(false)
  const backend = new DesktopBackendController((onFailure) => {
    backendGeneration++
    const hostInspectPort = developmentHostInspectPort(development)
    const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject,
      hostInspectPort, { ...hostEnvironment, DSH_CLIENT_VERSION: desktopClientVersion() }, onFailure,
      primaryRuntime,
      resources, desktopNativePathHandlers())
    return {
      start: async () => {
        const ready = await host.start()
        hostCookie = await authenticateWebHost(ready.url)
        hostUrl = ready.url
        if (ready.injections === undefined) throw new Error('Desktop Host did not provide boot injections')
        injections = ready.injections
        welcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init))
      },
      stop: async () => {
        try { await host.stop(requireCleanStop) }
        catch (error) {
          if (!requireCleanStop || !(error instanceof DesktopHostUncleanExitError)) throw error
          // Backend cleanup succeeded; installation still rejects the unsuccessful task teardown.
          updateStopFailure = error
        }
      },
      updateTasks: (action: 'inspect' | 'lock' | 'unlock') => host.updateTasks(action),
      inspectQuit: () => host.inspectQuit(),
    }
  }, (state) => {
    if (state.phase === 'error') {
      if (communityHostOperation) void persistCrashReport(state.failure, 'host')
      else void recoverCommunityFailure(backendGeneration).then((restored) => {
        const current = backend.state
        if (!restored && current.phase === 'error' && current.failure === state.failure) reportFatal(state.failure, 'host')
      }).catch((error: unknown) => {
        if (backend.state.phase !== 'ready') reportFatal(error, 'host')
        else void persistCrashReport(error, 'host')
      })
    }
    else if (!shuttingDown) backendReady = state.phase === 'ready'
  })

  const updateErrors = new WeakMap<DesktopUpdateState, Promise<void>>()
  const showUpdateFailure = (state: DesktopUpdateState): Promise<void> => {
    if (state.phase !== 'error') return Promise.resolve()
    let shown = updateErrors.get(state)
    if (shown === undefined) {
      shown = ordinaryMessageBox({ type: 'error', title: locale.messages.updateFailedTitle,
        message: desktopUpdateErrorSummary(state, locale.messages),
        technicalDetails: state.technicalDetails ?? state.message ?? '' }).then(() => {})
      updateErrors.set(state, shown)
    }
    return shown
  }
  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateJournal?.state(state)
    updateState = state
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesPresentation, presentDesktopUpdate(state))
    }
    if (state.phase === 'error' && state.failedOperation !== 'check') {
      const restoreHost = state.failedOperation === 'install' && updateStoppedHost && !quitting
      shellInstallerOwnsQuit = false
      updateStoppedHost = false
      if (restoreHost) {
        // Only confirmed process exit permits replacement before another installation confirmation.
        const hostReady = backend.start(prepareHostEnvironment)
        startup = hostReady
        const recovery = hostReady.then(async () => {
          if (quitting) return
          // A replacement Host can have a new port, cookie, or boot injections even at the same URL.
          navigation = undefined
          await navigateMain(applicationUrl)
          if (backend.host !== undefined) updateJournal?.action('workspace-ready')
        })
        workspaceRecovery = recovery
        void recovery.catch((error: unknown) => { reportFatal(error, 'main') }).finally(() => {
          if (startup === hostReady) startup = undefined
          if (workspaceRecovery === recovery) workspaceRecovery = undefined
        })
      }
      void showUpdateFailure(state).catch((error: unknown) => { console.error(error) })
    }
    return state
  }

  const readWelcomeState = async () => {
    if (backend.host === undefined || welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    return welcomeBackend.read()
  }
  stopForRecovery = () => backend.close()

  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      await navigateMain(applicationUrl)
      await backend.start(async () => {
        const restored = await communityTransaction.recover()
        if (restored !== undefined) community.recovered(restored)
        await Promise.all([manager.applyRelease(), prepareHostEnvironment()])
      })
      if (backend.host !== undefined) await openInitialWindow()
      if (backend.host !== undefined) updateJournal?.action('workspace-ready')
      // The existing Web document resumes through the boot IPC response.
    })().catch((error: unknown) => {
      updateJournal?.action('workspace-failed')
      if (backend.state.phase !== 'error' && automaticRecovery === undefined) reportFatal(error, 'main')
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      await commandManager.idle()
      await workspaceRecovery
      await startup?.catch(() => undefined)
      const host = backend.host
      if (host === undefined) throw new DesktopUpdatePreparationError('tasks-unavailable', locale.messages.updateTasksUnavailable)
      const active = await host.updateTasks('inspect')
      const ready = desktopUpdateReadyConfirmation(locale.messages, updates.state.version ?? '', process.platform)
      const confirmation: Electron.MessageBoxOptions = {
        type: active ? 'warning' : 'info', title: locale.messages.updateTitle,
        message: active ? locale.messages.updateActiveTasks : ready.message,
        detail: active ? locale.messages.updateActiveTasksDetail : ready.detail,
        buttons: active ? [locale.messages.updateStopTasks, locale.messages.updateLater] : [locale.messages.installAndRestart],
        defaultId: 1, cancelId: 1,
      }
      const parent = currentDialogWindow()
      if (parent === undefined) return false
      const result = await updateDialog.show(parent, confirmation)
      if (result.response !== 0) return false
      if (backend.host !== host) throw new DesktopUpdatePreparationError('tasks-unavailable', locale.messages.updateTasksUnavailable)
      try {
        const stillActive = await host.updateTasks('lock')
        if (stillActive && !active) throw new DesktopUpdatePreparationError('tasks-changed', locale.messages.updateTasksChanged)
        mandatoryUI?.preparingRestart(stillActive)
        requireCleanStop = true
        updateStopFailure = undefined
        await backend.stop()
        updateStoppedHost = true
        // The backend's async cleanup callback can assign this after the reset above.
        const stopFailure = updateStopFailure as DesktopHostUncleanExitError | undefined
        if (stopFailure !== undefined) throw new DesktopUpdatePreparationError('stop-failed', locale.messages.updateStopFailed, stopFailure.message)
        updateJournal?.action('install-confirmed')
        shellInstallerOwnsQuit = true
      } catch (error) {
        if (!updateStoppedHost) await host.updateTasks('unlock').catch((unlockError: unknown) => { console.error(unlockError) })
        throw error
      } finally {
        requireCleanStop = false
      }
      return true
    },
  )

  const updateSchedule = new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))

  const downloadUpdate = async (version: string): Promise<DesktopUpdateState> => {
    updateJournal?.action('download-requested')
    const state = await updates.download(version)
    if (state.phase !== 'ready' || quitting) return state
    // Only a completed user-driven download opens this prompt; cancelling installation does not reopen it.
    // A confirmation on a hidden window would go unseen, so it waits for the next show; the mandatory
    // flow keeps its own taskbar and Dock attention instead.
    if (!isMandatory()) await windowShown()
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- A quit can begin while the show is awaited.
    if (quitting) return state
    return updates.install(version)
  }
  const windowShown = (): Promise<void> => new Promise((resolve) => {
    const window = currentDialogWindow()
    if (window === undefined || window.isDestroyed() || window.isVisible()) { resolve(); return }
    window.once('show', () => { resolve() })
    window.once('closed', () => { resolve() })
  })

  installDesktopDirectoryPicker(() => mainWindow)
  installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)
  const shortcuts = installDesktopShortcuts(() => mainWindow, app.getPath('userData'),
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux', () => { refreshApplicationMenu() }, window => updateOverlays.input(window))
  app.on('will-quit', () => { shortcuts.dispose() })

  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertDesktopSender(event, ['app'])
    await startup
    if (backend.host === undefined || hostUrl === undefined) throw new Error('Desktop Host is unavailable')
    // The application document has everything it needs from here on, so the
    // splash stops covering the slow phase exactly when that phase ends.
    hideLoadingWhale()
    return { injections, streamBaseUrl: new URL(hostUrl).origin }
  })

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: rejected startup failure from a non-primary frame')
    }
    if (typeof message !== 'string') throw new Error('dsh desktop: startup failure must be text')
    reportFatal(new Error(message), 'web-boot')
  })

  ipcMain.handle(DESKTOP_IPC.browserAcquire, (event, workspace: unknown) => {
    assertProductSender(event)
    return browserGuests.acquire(event.sender, workspace)
  })
  ipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease: unknown) => {
    assertProductSender(event)
    return browserGuests.release(event.sender, lease)
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    if (hostUrl === undefined || hostCookie === undefined || details.webContentsId !== mainWindow?.webContents.id) {
      callback({})
      return
    }
    const target = new URL(hostUrl)
    const requested = new URL(details.url)
    if (requested.host !== target.host) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } })
  })

  // Only the main window may synchronize its palette with the native material.
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })
  ipcMain.handle(DESKTOP_IPC.localeBootstrap, async (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== new URL(applicationUrl).origin) {
      throw new Error('desktop welcome: rejected locale request from an unowned frame')
    }
    if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    return { languages: systemLanguages, preference: await welcomeBackend.readLocalePreference() }
  })
  ipcMain.on(DESKTOP_IPC.localeChanged, (event, next: unknown) => {
    const window = mainWindow
    if (window === undefined || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || typeof next !== 'string') return
    const current = resolveDesktopStartupLocale(next, systemLanguages)
    if (current.id === locale.id) return
    locale = current
    windowsLanguage = locale.id
    refreshApplicationMenu()
  })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertProductSender(event)
    return presentDesktopUpdate(updates.state)
  })
  ipcMain.handle(DESKTOP_IPC.onboardingApiKey, async (event) => {
    assertProductSender(event)
    return (await readWelcomeState()).hasApiKey
  })
  ipcMain.on(DESKTOP_IPC.onboardingActive, (event, active: unknown) => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || !event.senderFrame.url.startsWith(`${SCHEME}://app/`) || typeof active !== 'boolean') return
    window.setMinimumSize(active ? 960 : 520, 600)
    if (active) {
      const { width, height } = window.getBounds()
      if (width < 960) window.setSize(960, height)
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
    assertProductSender(event)
    await openUpdatePrompt()
  })

  let promptOperation: Promise<void> | undefined
  const openUpdatePrompt = (manual = false): Promise<void> => {
    let failedOperation: 'check' | 'download' | 'install' = 'check'
    promptOperation ??= Promise.resolve().then(async () => {
      if (manual) updateJournal?.action('check-requested')
      let controller: AbortController | undefined
      let progress: Promise<unknown> | undefined
      try {
        let state = updates.state
        if (manual || state.phase === 'idle' || (state.phase === 'error' && state.failedOperation === 'check')) {
          controller = new AbortController()
          ordinaryDialogs.add(controller)
          const parent = currentDialogWindow()
          progress = parent === undefined ? Promise.resolve() : updateDialog.show(parent, { type: 'info', title: locale.messages.updateCheckTitle,
            message: locale.messages.updateChecking, buttons: [locale.messages.later], cancelId: 0, signal: controller.signal })
          state = await updateSchedule.check(true)
        }
        if (state.phase === 'error' && state.failedOperation === 'check') { await showUpdateFailure(state); return }
        if (state.phase === 'idle') {
          await ordinaryMessageBox({ type: 'info', title: locale.messages.updateCheckTitle,
            message: formatDesktopMessage(locale.messages.updateCurrent, { version: app.getVersion() }) })
          return
        }
        if (state.phase === 'ready' || (state.phase === 'error' && state.failedOperation === 'install')) {
          if (state.version !== undefined) {
            failedOperation = 'install'
            await showUpdateFailure(await updates.install(state.version))
          }
          return
        }
        if (state.phase !== 'available' && !(state.phase === 'error' && state.failedOperation === 'download')) return
        if (manual) {
          const result = await ordinaryMessageBox({ title: locale.messages.updateCheckTitle, message: locale.messages.updateAvailable,
            detail: formatDesktopMessage(locale.messages.updateDetail, { version: state.version ?? '' }),
            buttons: [locale.messages.updateDownload], cancelId: 1 })
          if (result.response !== 0) return
        }
        if (state.version !== undefined) {
          controller?.abort()
          failedOperation = 'download'
          await showUpdateFailure(await downloadUpdate(state.version))
        }
      } finally {
        controller?.abort()
        if (controller !== undefined) ordinaryDialogs.delete(controller)
        await progress
      }
    }).catch((error: unknown) => showUpdateFailure({ phase: 'error', failedOperation,
      message: desktopErrorState(error).message }))
      .finally(() => { promptOperation = undefined })
    return promptOperation
  }

  const automaticCheck = (): void => {
    if (!quitting) void updateSchedule.check().catch((error: unknown) => { console.error(error) })
  }
  powerMonitor.on('resume', automaticCheck)
  app.on('will-quit', () => {
    updateSchedule.dispose()
    powerMonitor.off('resume', automaticCheck)
    updates.dispose()
  })

  const applicationIconPath = development ? join(app.getAppPath(), 'resources', 'icon-windows.png')
    : join(process.resourcesPath, 'icon.png')
  app.setAboutPanelOptions({
    applicationName: 'DeepSeek Harness',
    applicationVersion: app.getVersion(),
    // The release has no separate build number; omit Electron's bundle version.
    version: '',
    copyright: '',
    iconPath: applicationIconPath,
  })
  // A custom application menu replaces Electron's default menu, so macOS needs
  // its standard menus and application hide commands declared explicitly.
  // Keep app.name stable: Electron derives its default userData directory from it.
  const darwin = process.platform === 'darwin'
  const platformMenus = (): MenuItemConstructorOptions[] => darwin
    ? [shortcuts.fileMenu(currentDesktopLocale().messages), { role: 'editMenu' }, { role: 'windowMenu' }]
    : [{ role: 'editMenu' }]
  const hideCommands: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'hide', label: currentDesktopLocale().messages.hideApplication },
      { role: 'hideOthers', label: currentDesktopLocale().messages.hideOtherApplications },
      { role: 'unhide', label: currentDesktopLocale().messages.showAllApplications }, { type: 'separator' }]
    : []
  let promotionPackage: PreparedCommunityBundle | undefined
  const communityTransaction = new CommunityProfileTransaction({
    profile: activeProject, directory: join(resolveDshHome(), 'desktop', 'community'),
    trial: async (profile, home, prepared, signal) => {
      const restore = await prepareCommunityTrialProfile(profile, home)
      try {
        await trialCommunityBundle(failed => new DesktopHostProcess(
          resources.node, resources.dsh, profile, undefined,
          communityTrialEnvironment({ ...hostEnvironment, DSH_CLIENT_VERSION: desktopClientVersion() }, home),
          failed, primaryRuntime, resources), prepared, signal)
      } finally { await restore() }
    },
    pause: async (recovering) => {
      communityHostOperation = true
      const host = backend.host
      if (!recovering && host !== undefined && await host.updateTasks('lock')) {
        await host.updateTasks('unlock')
        throw new CommunityTransactionError('active-tasks', true)
      }
      await backend.stop()
      hostUrl = undefined
      hostCookie = undefined
    },
    resume: () => backend.start(prepareHostEnvironment),
    healthy: async (signal) => {
      const prepared = promotionPackage
      if (prepared === undefined) throw new CommunityTransactionError('activation-failed', false)
      const host = hostUrl === undefined || hostCookie === undefined ? undefined : { url: hostUrl, cookie: hostCookie }
      const [inventory, entries] = await Promise.all([
        invokeCommunityBackend(host, 'listBundles', {}, undefined, signal),
        invokeCommunityBackend(host, 'listPlugins', {}, undefined, signal),
      ])
      assertCommunityBundleReady(inventory, prepared.packageName, prepared.version, entries)
    },
  })
  const community = new DesktopCommunityService({
    directory: join(resolveDshHome(), 'desktop', 'community'),
    account: readCommunityAccount,
    adaptation: () => {
      const config = readConfig()
      return { apiKey: config.apiKey, harnessVersion: app.getVersion(),
        ...(config.communityAdaptation === undefined ? {} : { limits: config.communityAdaptation }),
        redactValues: [readCommunityAccount()?.token ?? ''] }
    },
    apply: async (prepared, task, signal, phase) => {
      const generation = backendGeneration
      promotionPackage = prepared
      try { await communityTransaction.install(prepared, task, signal, phase) }
      finally {
        promotionPackage = undefined
        if (communityHostOperation) {
          communityHostOperation = false
          if (generation !== backendGeneration || backend.state.phase !== 'ready') {
            navigation = undefined
            await navigateMain(applicationUrl)
            marketNavigation.request()
            mainWindow?.webContents.send(DESKTOP_IPC.communityOpen)
          }
        }
      }
    },
    invoke: (method, args, signal) => invokeCommunityBackend(
      hostUrl === undefined || hostCookie === undefined ? undefined : { url: hostUrl, cookie: hostCookie },
      method, args, undefined, signal),
    changed: () => {
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_IPC.communityChanged)
    },
  })
  const marketNavigation = new DesktopCommunityNavigation()
  let automaticRecovery: Promise<boolean> | undefined
  recoverCommunityFailure = (generation) => {
    if (automaticRecovery !== undefined) return automaticRecovery.then(() =>
      generation === backendGeneration && backend.state.phase === 'error' ? recoverCommunityFailure(generation) : true)
    automaticRecovery = (async () => {
      const restored = await communityTransaction.rollbackLast(() => generation === backendGeneration)
      if (restored === undefined) return false
      community.recovered(restored, 'activation-failed')
      navigation = undefined
      await navigateMain(applicationUrl)
      marketNavigation.request()
      mainWindow?.webContents.send(DESKTOP_IPC.communityOpen)
      return true
    })().finally(() => { communityHostOperation = false; automaticRecovery = undefined })
    return automaticRecovery
  }
  openCommunityMarket = (intent) => {
    community.open(intent)
    marketNavigation.request()
    if (mainWindow === undefined) return
    focusPrimaryWindow()
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_IPC.communityOpen)
  }
  const communityHandler = (channel: string, run: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => { assertProductSender(event); return run(...args) })
  }
  communityHandler(DESKTOP_IPC.communityState, () => community.getState())
  communityHandler(DESKTOP_IPC.communityCatalog, (refresh, query) => {
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new Error('Invalid catalog request')
    return community.catalog(refresh, communityCatalogQuery(query))
  })
  communityHandler(DESKTOP_IPC.communityDetail, (id) => {
    if (typeof id !== 'string') throw new Error('Invalid community item')
    return community.detail(id)
  })
  communityHandler(DESKTOP_IPC.communityWebsite, async (path, target) => {
    const destination = communityWebsiteDestination(path, target)
    if (destination.target === 'system-browser') await shell.openExternal(destination.url)
    else await openHubMarketWindow(currentDesktopLocale().messages.communityHubTitle, destination.path)
  })
  communityHandler(DESKTOP_IPC.communityInstall, intent => community.install(intent))
  communityHandler(DESKTOP_IPC.communityCancel, id => community.cancel(id))
  communityHandler(DESKTOP_IPC.communityEnable, (name, enabled) => community.setEnabled(name, enabled))
  communityHandler(DESKTOP_IPC.communityRemove, name => community.remove(name))
  communityHandler(DESKTOP_IPC.communityPending, () => community.takePending())
  communityHandler(DESKTOP_IPC.communityClaimOpen, () => marketNavigation.claim())
  communityHandler(DESKTOP_IPC.communityAcknowledgeOpen, (request) => { marketNavigation.acknowledge(request) })
  communityHandler(DESKTOP_IPC.communityLogin, async (email, password): Promise<CommunityLoginResult> => {
    if (typeof email !== 'string' || email.length < 1 || email.length > 320
      || typeof password !== 'string' || password.length < 1 || password.length > 4096) return { ok: false, problem: { code: 'invalid-account' } }
    const result = await loginCommunityAccount(email, password)
    if (!result.success) return { ok: false, problem: result.problem }
    try { await injectCommunityCookie() }
    catch (_error) { console.warn('Community Hub cookie could not be updated') }
    mainWindow?.webContents.send(DESKTOP_IPC.communityChanged)
    return { ok: true }
  })
  communityHandler(DESKTOP_IPC.communityLogout, async () => {
    logoutCommunityAccount()
    await session.defaultSession.cookies.remove('https://deepseek.stream', 'deepseek_hub_auth_token')
    mainWindow?.webContents.send(DESKTOP_IPC.communityChanged)
  })

  const applicationItems = (): MenuItemConstructorOptions[] => [
    // Windows has no system About panel; Electron's fallback is a plain
    // message box, so the shell shows its own dimmed dialog instead.
    process.platform === 'win32'
      ? { label: currentDesktopLocale().messages.aboutMenu,
        click: () => { void showAbout().catch((error: unknown) => { console.error(error) }) } }
      : { label: currentDesktopLocale().messages.aboutMenu, role: 'about' },
    { type: 'separator' },
    { label: currentDesktopLocale().messages.communityMenu, submenu: [
      { label: currentDesktopLocale().messages.communityMarketMenu, accelerator: 'CmdOrCtrl+M', click: () => { openCommunityMarket() } },
      { label: currentDesktopLocale().messages.communityHubMenu, accelerator: 'CmdOrCtrl+Shift+M', click: () => {
        void openHubMarketWindow(currentDesktopLocale().messages.communityHubTitle).catch(() => { console.warn('Community Hub could not be opened') })
      } },
      { label: currentDesktopLocale().messages.communityGuideMenu, click: () => {
        void openHubMarketWindow(currentDesktopLocale().messages.communityHubTitle, '/guide')
          .catch(() => { console.warn('Community guide could not be opened') })
      } },
    ] },
    { type: 'separator' },
    { label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true) } },
    ...process.platform === 'darwin' || process.platform === 'win32'
      ? [{ label: currentDesktopLocale().messages.cliCommandMenu, click: () => { void commandManager.show() } }] : [],
    ...development ? [
      { type: 'separator' as const },
      { label: currentDesktopLocale().messages.reloadPageMenu, role: 'reload' as const },
      { label: currentDesktopLocale().messages.restartAppHostMenu, click: () => {
        if (quitting) return
        app.relaunch()
        quitWithoutConfirmation()
      } },
    ] : [],
    { type: 'separator' },
    ...hideCommands,
    { role: 'quit', ...(darwin ? { label: currentDesktopLocale().messages.quitApplication }
      : process.platform === 'win32' ? { label: currentDesktopLocale().messages.exitApplication } : {}) },
  ]
  const devToolsItems: MenuItemConstructorOptions[] = [
    { role: 'toggleDevTools', visible: false },
    { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
  ]
  const refreshApplicationMenu = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: darwin ? app.name : currentDesktopLocale().messages.application,
        submenu: [...applicationItems(), ...devToolsItems],
      },
      ...platformMenus(),
    ]))
    tray?.relabel()
  }
  refreshApplicationMenu()
  const trayIconPath = development ? join(app.getAppPath(), 'resources', 'tray-windows.ico') : join(process.resourcesPath, 'tray.ico')
  if (process.platform === 'win32') {
    // The tray is the way back to a hidden window; without it, relaunching the application still focuses it.
    try {
      tray = new DesktopTray({ iconPath: trayIconPath, locale: currentDesktopLocale,
        open: () => { focusPrimaryWindow() }, quit: () => { app.quit() } })
    } catch (error) { console.warn('desktop tray: unavailable', error) }
  }
  const backgroundNotice = process.platform === 'win32'
    ? new DesktopBackgroundNotice({ markerPath: join(app.getPath('userData'), 'background-close-confirmed'),
      locale: () => locale, show: ordinaryMessageBox, focus: () => { updateDialog.focus() } })
    : undefined
  const quitConfirmation = new DesktopQuitConfirmation({
    locale: () => locale,
    inspect: () => backend.host?.inspectQuit(),
    // No owner window: a hidden window stays hidden and the native box is its own top-level window.
    show: options => dialog.showMessageBox(options),
    // macOS raises the open alert with the application; Electron exposes no handle to the Windows task
    // dialog, so a repeated request there only joins the open decision.
    focus: () => { if (process.platform === 'darwin') app.focus({ steal: true }) },
    // The task dialog draws its main icon at the system icon size; the multi-size ICO yields that
    // size directly, where the 1024 px PNG would be scaled down by GDI.
    ...(process.platform === 'win32' ? { icon: nativeImage.createFromPath(trayIconPath) } : {}),
  })

  if (process.platform === 'win32') {
    ipcMain.handle(DESKTOP_IPC.windowsMenu, (event, name: unknown, x: unknown, y: unknown) => {
      assertDesktopSender(event, ['app'])
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('desktop menu: rejected sender')
      if ((name !== 'application' && name !== 'edit')
        || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('desktop menu: invalid popup request')
      const window = mainWindow
      // Editor-owned history listens to key events rather than Chromium's native undo stack.
      const editItem = (label: string, keyCode: string, modifiers: Array<'control'>, accelerator?: string): MenuItemConstructorOptions => ({
        label,
        ...(accelerator === undefined ? {} : { accelerator }),
        click: () => {
          shortcuts.sendEditingKey(keyCode, modifiers)
        },
      })
      const items: MenuItemConstructorOptions[] = name === 'application' ? applicationItems() : [
        editItem(currentDesktopLocale().messages.undo, 'Z', ['control'], 'Ctrl+Z'),
        editItem(currentDesktopLocale().messages.redo, 'Y', ['control'], 'Ctrl+Y'),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.cut, 'X', ['control'], 'Ctrl+X'),
        editItem(currentDesktopLocale().messages.copy, 'C', ['control'], 'Ctrl+C'),
        editItem(currentDesktopLocale().messages.paste, 'V', ['control'], 'Ctrl+V'),
        editItem(currentDesktopLocale().messages.delete, 'Delete', []),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.selectAll, 'A', ['control'], 'Ctrl+A'),
      ]
      const zoom = mainWindow.webContents.getZoomFactor()
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: resolve })
      })
    })
    ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, language: unknown, color: unknown, symbolColor: unknown) => {
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) return
      if (!event.senderFrame.url.startsWith(`${SCHEME}://app/`)) return
      if (typeof language === 'string' && /^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(language)) {
        windowsLanguage = language
      }
      // Empty colors precede client stylesheet installation; only CSS color values cross IPC.
      const validColor = (value: unknown): value is string => typeof value === 'string'
        && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }

  const hideMainWindow = (window: BrowserWindow): void => {
    if (process.platform === 'darwin' && window.isFullScreen()) {
      // Hiding a fullscreen window leaves an empty black space; leave fullscreen first.
      window.once('leave-full-screen', () => { if (!window.isDestroyed()) window.hide() })
      window.setFullScreen(false)
    } else {
      window.hide()
    }
  }
  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, false, true)
    mainWindow = window
    browserGuests.bind(window, (guest, name) => shortcuts.attachGuest(window, guest, name))
    shortcuts.attach(window)
    window.on('focus', automaticCheck)
    // Closing hides: the page and the Host keep running, and the next show resumes the same document.
    window.on('close', (event) => {
      if (quitting || shellInstallerOwnsQuit || sessionEnding) return
      event.preventDefault()
      if (updateDialog.isOpen) { updateDialog.focus(); return }
      const hide = (): void => {
        if (!quitting && !shellInstallerOwnsQuit && !sessionEnding && !window.isDestroyed()) hideMainWindow(window)
      }
      if (backgroundNotice === undefined) hide()
      else backgroundNotice.close(hide)
    })
    if (process.platform === 'win32') {
      // Shutdown, restart, and log-off must not wait on a confirmation. query-session-end is only a
      // question that another application can veto without any follow-up message, so it does not count.
      window.on('session-end', () => { sessionEnding = true })
    } else {
      // The macOS power-off notification arrives before the terminate request; a cancelled shutdown
      // leaves the process running, and user attention on the window shows the session continues.
      window.on('focus', () => { sessionEnding = false })
      window.on('show', () => { sessionEnding = false })
    }
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    window.webContents.on('console-message', (details) => {
      if (details.level !== 'error') return
      rendererConsole.push(`${details.sourceId}:${String(details.lineNumber)} ${details.message}`)
    })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !quitting && !window.isDestroyed()) {
        reportFatal(new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`), 'renderer')
      }
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      if (!quitting && !window.isDestroyed()) reportFatal(error, 'renderer')
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), 'renderer')
      }
    })
    return window
  }
  const enterWorkspace = async ({ activate = true }: { activate?: boolean } = {}): Promise<void> => {
    if (quitting) return
    const window = mainWindow ?? createMainWindow()
    await navigateMain(applicationUrl)
    if (isQuitting() || recovery.active || window.isDestroyed()) return
    if (activate) window.show()
    else window.showInactive()
    enteredWorkspace = true
    if (welcomeWindow !== undefined) {
      welcomeWindow.close()
      window.webContents.send(DESKTOP_IPC.enterWorkspace)
    }
    welcomeWindow = undefined
    if (raiseAfterUpdate) {
      raiseAfterUpdate = false
      window.moveTop()
      window.focus()
    }
    if (activate && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
      window.webContents.openDevTools({ mode: 'detach' })
    }
  }
  let openingWelcome: Promise<void> | undefined
  const showWelcome = (): Promise<void> => {
    if (quitting) return Promise.resolve()
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) {
      welcomeWindow.show()
      welcomeWindow.focus()
      return Promise.resolve()
    }
    openingWelcome ??= (async () => {
      welcomeWindow = await openWelcomeWindow(locale, {
        saveApiKey: async (apiKey) => {
          if (backend.host === undefined || welcomeBackend === undefined) return { ok: false }
          const saved = await welcomeBackend.save(apiKey)
          if (!saved.ok) return saved
          await enterWorkspace()
          return { ok: true }
        },
        skip: enterWorkspace,
      })
      const window = welcomeWindow
      window.once('closed', () => {
        if (welcomeWindow === window) welcomeWindow = undefined
        if (enteredWorkspace || recovery.active) return
        // Nothing runs before the workspace opens. macOS keeps the Dock convention and drops the
        // unused main window so the next activation rebuilds the welcome; elsewhere the close quits.
        if (process.platform === 'darwin') mainWindow?.destroy()
        else app.quit()
      })
      if (isQuitting() || recovery.active || enteredWorkspace) window.close()
      else mainWindow?.hide()
    })().finally(() => { openingWelcome = undefined })
    return openingWelcome
  }
  const openInitialWindow = async (): Promise<void> => {
    if (quitting || recovery.active) return
    const state = await readWelcomeState()
    if (isQuitting() || backend.state.phase !== 'ready') return
    locale = resolveDesktopStartupLocale(state.localePreference, systemLanguages)
    windowsLanguage = locale.id
    refreshApplicationMenu()
    if (!enteredWorkspace && needsWelcome({ hasApiKey: state.hasApiKey })) {
      // A later login must retain its own activation policy instead of replaying startup focus.
      raiseAfterUpdate = false
      await showWelcome()
    } else {
      await enterWorkspace()
    }
  }
  focusPrimaryWindow = () => {
    if (quitting) return
    const window = welcomeWindow ?? mainWindow
    if (window === undefined || window.isDestroyed()) {
      try { createMainWindow() } catch (error) { reportFatal(error, 'main'); return }
      void (backend.state.phase === 'ready' ? openInitialWindow() : navigateMain(applicationUrl)).catch((error: unknown) => { reportFatal(error, 'main') })
      return
    }
    // Startup and sign-out select the visible window before activation may reveal the workspace.
    if (window === mainWindow && !enteredWorkspace) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  try {
    app.setAsDefaultProtocolClient('dsh')
  } catch {}
  receiveProtocolUrl = (url) => {
    if (url.startsWith('dsh://') || url.startsWith('dsh:')) {
      if (url === 'dsh://open' || url === 'dsh://open/') {
        if (mainWindow !== undefined) focusPrimaryWindow()
      } else {
        handleDshProtocolUrl(url)
      }
    }
  }
  for (const url of pendingProtocolUrls.splice(0)) receiveProtocolUrl(url)
  app.on('second-instance', (_event, argv) => {
    focusPrimaryWindow()
    const dshUrl = findDshUrl(argv)
    if (dshUrl) {
      handleDshProtocolUrl(dshUrl)
    }
  })
  const startupDshUrl = findDshUrl(process.argv)

  app.on('activate', (_event, hasVisibleWindows) => {
    if (!hasVisibleWindows) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  if (process.platform !== 'win32') powerMonitor.on('shutdown', () => { sessionEnding = true })
  const finishQuit = (): void => {
    quitting = true
    shuttingDown = true
    updateJournal?.action('quit-requested')
    quitConfirmation.dispose()
    backgroundNotice?.dispose()
    tray?.dispose()
    if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.hide()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.hide()
    updateSchedule.dispose()
    updateDialog.dispose()
    mandatoryUI?.dispose()
    void Promise.all([Promise.resolve(mandatoryPolicy?.dispose()), community.dispose().then(() => backend.close())])
      .catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  }
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit) {
      shuttingDown = true
      quitConfirmation.dispose()
      backgroundNotice?.dispose()
      updateJournal?.action('quit-requested')
      tray?.dispose()
      updateDialog.dispose()
      mandatoryUI?.dispose()
      return
    }
    if (quitting) return
    event.preventDefault()
    if (skipQuitConfirmation || sessionEnding) { finishQuit(); return }
    void quitConfirmation.confirm().then((approved) => {
      if (quitting || shellInstallerOwnsQuit) return
      if (approved) { finishQuit(); return }
      // A quit that started from closing the welcome window destroyed it; a cancelled quit needs it back.
      if (!enteredWorkspace && !recovery.active) void showWelcome().catch((error: unknown) => { reportFatal(error, 'main') })
    }).catch((error: unknown) => { console.error(error); if (!quitting && !shellInstallerOwnsQuit) finishQuit() })
  })

  // Whale splash: it covers the slow part of startup (profile preparation and
  // the Host coming up) once the gate has passed. It closes when the boot IPC
  // answers — the moment the application document has everything it needs —
  // and on every path that takes the screen for itself instead.
  mainWindow = createMainWindow()
  if (startupDshUrl) handleDshProtocolUrl(startupDshUrl)
  if (!splashDisabled()) showLoadingWhale()
  const manifest: unknown = JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop policy: invalid application manifest')
  const developmentPolicy = app.isPackaged ? undefined : process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG
  const policyInput: unknown = app.isPackaged
    ? ('dshMandatoryUpdatePolicy' in manifest ? manifest.dshMandatoryUpdatePolicy : undefined)
    : developmentPolicy === undefined ? undefined : JSON.parse(developmentPolicy) as unknown
  const policyConfig = resolveDesktopPolicyConfig(policyInput, !app.isPackaged)
  if (policyConfig !== undefined) {
    if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('desktop policy: unsupported platform')
    let wasBlocking = false
    mandatoryPolicy = new DesktopMandatoryUpdatePolicy(policyConfig, {
      platform: process.platform as 'win32' | 'darwin', arch: process.arch as 'x64' | 'arm64',
      bundledDshVersion: app.isPackaged ? readDesktopRuntime(resources.dsh).release.version : app.getVersion(),
    }, (state) => {
      if (state.blocking) {
        for (const controller of ordinaryDialogs) controller.abort()
        if (!wasBlocking) updateDialog.cancel()
      }
      mandatoryUI?.sync()
      if (state.blocking && !wasBlocking) void updateSchedule.check(false, true).catch((error: unknown) => { console.error(error) })
      wasBlocking = state.blocking
    }, undefined, () => desktopClientMetadata(locale.id))
    const policy = mandatoryPolicy
    mandatoryUI = new DesktopMandatoryUpdateWindow({
      overlays: updateOverlays,
      preload: fileURLToPath(new URL('./preload-mandatory.cjs', import.meta.url)), locale,
      allowedPageOrigins: policyConfig.allowedPageOrigins, parent: () => mainWindow,
      policy: () => policy.state, update: () => updates.state,
      refresh: async () => { await Promise.all([policy.check('manual', true), updateSchedule.check(true)]) },
      download: downloadUpdate, install: version => updates.install(version),
    })
    // A sign-in-required policy state existed only for the removed platform account
    // transport, so a launch check now reports its own failure and nothing else.
    void mandatoryPolicy.check('launch').catch((error: unknown) => { console.error(error) })
  }
  automaticCheck()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  if (isQuitting()) return
  const window = currentMainWindow()
  if (window !== undefined && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
}

// Direct egress is opt-in: `DSH_DESKTOP_DIRECT_EGRESS=1` or `direct-egress.txt`
// in the Desktop root takes proxies out of the path. It stays off by default —
// clearing a proxy this deployment needs would cut the Host, the plugin market
// and the package manager off the network. The switch must be applied before
// Electron is ready, and clearing the environment here also reaches the Host
// child and the package manager, which build their environments from this one.
if (directEgressEnabled(desktopDataRoot())) {
  const removed = clearProxyEnvironment(process.env)
  app.commandLine.appendSwitch('no-proxy-server')
  console.log(`direct egress: cleared ${removed.length === 0 ? 'no proxy variables' : removed.join(', ')}`)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  reportFatal(error, 'main')
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
