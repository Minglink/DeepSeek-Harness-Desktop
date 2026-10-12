/** On-demand, cursor-based installation diagnostics for one main-owned task. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityTask, CommunityTaskLog, DesktopCommunityApi } from '../../../../src/community-types.ts'
import { communityText, type CommunityLocaleKey } from './community-locales.ts'
import css from './Community.module.css'

/** Only the log capabilities needed by this task's diagnostic panel. */
export interface CommunityTaskLogPanelProps {
  readonly api: Pick<DesktopCommunityApi, 'getTaskLog' | 'copyTaskLog' | 'exportTaskLog' | 'subscribe'>
  readonly task: CommunityTask
  readonly locale: string
}

const MAX_VISIBLE_ENTRIES = 2_000
const PHASE_KEYS = {
  queued: 'queued', downloading: 'downloading', validating: 'validating', packaging: 'packaging',
  adapting: 'adapting', trial: 'trial', activating: 'activating', 'rolling-back': 'rollingBack',
  installing: 'installing', cancelling: 'cancelling', applied: 'applied',
  'restart-required': 'restartRequired', overridden: 'overridden', failed: 'failed', cancelled: 'cancelled',
} satisfies Record<CommunityTask['phase'], CommunityLocaleKey>
const SOURCE_KEYS = { system: 'taskLogSystem', pnpm: 'taskLogPnpm', host: 'taskLogHost' } as const
const LEVEL_KEYS = { info: 'taskLogInfo', warning: 'taskLogWarning', error: 'taskLogError' } as const

/** Read durable history when expanded, then append notifications without overlapping reads.
 * @param props - Main-owned task identity, log operations and active client locale.
 * @returns A collapsible plain-text diagnostic panel with follow, copy and export controls.
 */
export function CommunityTaskLogPanel({ api, task, locale }: CommunityTaskLogPanelProps): ReactNode {
  const t = (key: CommunityLocaleKey, values?: Readonly<Record<string, string>>): string => communityText(locale, key, values)
  const supportsLogs = typeof api.getTaskLog === 'function'
    && typeof api.copyTaskLog === 'function' && typeof api.exportTaskLog === 'function'
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<CommunityTaskLog | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [follow, setFollow] = useState(true)
  const [operation, setOperation] = useState<'copy' | 'export' | null>(null)
  const [feedback, setFeedback] = useState<CommunityLocaleKey | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const refreshLog = useRef<() => void>(() => {})
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!open || !supportsLogs) return
    let disposed = false
    let reading = false
    let pending = false
    let current: CommunityTaskLog | null = null
    let cursor: number | undefined
    setLog(null)
    setLoading(true)
    setFailed(false)
    const refresh = (): void => {
      if (disposed) return
      if (reading) { pending = true; return }
      reading = true
      void (async () => {
        try {
          const value = await api.getTaskLog(task.id, cursor)
          if (disposed) return
          if (value.id !== task.id) throw new Error('Mismatched installation log identity')
          const entries = new Map((current?.entries ?? []).map(entry => [entry.sequence, entry]))
          for (const entry of value.entries) entries.set(entry.sequence, entry)
          const ordered = [...entries.values()].sort((left, right) => left.sequence - right.sequence)
          current = { ...value, entries: ordered.slice(-MAX_VISIBLE_ENTRIES),
            truncated: value.truncated || current?.truncated === true || ordered.length > MAX_VISIBLE_ENTRIES }
          cursor = value.nextCursor
          setLog(current)
          setFailed(false)
        } catch {
          if (!disposed) setFailed(true)
        } finally {
          reading = false
          if (!disposed) setLoading(false)
          if (pending && !disposed) { pending = false; refresh() }
        }
      })()
    }
    refreshLog.current = refresh
    const unsubscribe = api.subscribe(refresh)
    refresh()
    return () => { disposed = true; unsubscribe(); refreshLog.current = () => {} }
  }, [api, open, supportsLogs, task.id])

  useEffect(() => {
    if (open && follow && viewport.current !== null) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [open, follow, log?.nextCursor, log?.entries.length])

  const operate = async (action: 'copy' | 'export'): Promise<void> => {
    setOperation(action)
    setFeedback(null)
    try {
      const exported = action === 'copy' ? await api.copyTaskLog(task.id) : await api.exportTaskLog(task.id)
      if (mounted.current) setFeedback(action === 'copy' ? 'taskLogCopied' : exported === false ? 'taskLogExportCancelled' : 'taskLogExported')
    } catch {
      if (mounted.current) setFeedback(action === 'copy' ? 'taskLogCopyFailed' : 'taskLogExportFailed')
    } finally {
      if (mounted.current) setOperation(null)
    }
  }

  return <div className={css.taskLog}>
    <Button size="sm" variant="outline" aria-expanded={open} aria-controls={panelId}
      onClick={() => { setOpen(value => !value) }}>{t(open ? 'taskLogHide' : 'taskLogShow')}</Button>
    {open && <section id={panelId} className={css.taskLogPanel} aria-label={t('taskLogTitle', { name: task.plugin.name })}>
      <div className={css.taskLogControls}>
        <Button size="sm" variant="outline" aria-pressed={!follow} disabled={!supportsLogs}
          onClick={() => { setFollow(value => !value) }}>{t(follow ? 'taskLogPause' : 'taskLogResume')}</Button>
        <Button size="sm" variant="outline" disabled={!supportsLogs || operation !== null}
          onClick={() => { void operate('copy') }}>{t('taskLogCopy')}</Button>
        <Button size="sm" variant="outline" disabled={!supportsLogs || operation !== null}
          onClick={() => { void operate('export') }}>{t('taskLogExport')}</Button>
        <Button size="sm" variant="outline" disabled={!supportsLogs || loading}
          onClick={() => { refreshLog.current() }}>{t('refresh')}</Button>
      </div>
      {!supportsLogs && <p className={css.meta} role="status">{t('taskLogUnsupported')}</p>}
      {loading && log === null && <p className={css.meta} role="status">{t('taskLogLoading')}</p>}
      {failed && <p className={css.problem} role="alert">{t('taskLogReadFailed')}</p>}
      {log?.unavailable === true && <p className={css.problem} role="alert">{t('taskLogUnavailable')}</p>}
      {log?.truncated === true && <p className={css.meta} role="status">{t('taskLogTruncated')}</p>}
      {log !== null && log.entries.length === 0 && !loading && !failed && !log.unavailable
        && <p className={css.meta}>{t('taskLogEmpty')}</p>}
      {feedback !== null && <p className={feedback === 'taskLogCopyFailed' || feedback === 'taskLogExportFailed' ? css.problem : css.meta}
        role={feedback === 'taskLogCopyFailed' || feedback === 'taskLogExportFailed' ? 'alert' : 'status'}>{t(feedback)}</p>}
      <div className={css.taskLogOutput} ref={viewport} role="log" aria-live="off" tabIndex={0}
        aria-label={t('taskLogTitle', { name: task.plugin.name })}>
        <ol className={css.taskLogEntries}>{log?.entries.map(entry => <li key={entry.sequence} data-level={entry.level}>
          <div className={css.taskLogMetadata}>
            <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString(locale)}</time>
            <span>{t(PHASE_KEYS[entry.phase])}</span><span>{t(SOURCE_KEYS[entry.source])}</span><span>{t(LEVEL_KEYS[entry.level])}</span>
            {entry.code !== undefined && <span>{entry.code}</span>}
            {entry.exitCode !== undefined && <span>{t('taskLogExit', { code: entry.exitCode === null ? t('taskLogUnknownExit') : String(entry.exitCode) })}</span>}
          </div>
          <pre>{entry.text}</pre>
        </li>)}</ol>
      </div>
    </section>}
  </div>
}
