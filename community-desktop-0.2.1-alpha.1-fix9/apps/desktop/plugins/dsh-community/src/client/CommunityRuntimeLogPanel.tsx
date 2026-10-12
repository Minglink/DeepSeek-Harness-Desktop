/** On-demand durable client diagnostics independent of installation task outcomes. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CommunityRuntimeLog, DesktopCommunityApi } from '../../../../src/community-types.ts'
import { communityText, type CommunityLocaleKey } from './community-locales.ts'
import css from './Community.module.css'

/** Only read/copy/export capabilities; the renderer cannot append diagnostics. */
export interface CommunityRuntimeLogPanelProps {
  readonly api: Pick<DesktopCommunityApi, 'getRuntimeLog' | 'copyRuntimeLog' | 'exportRuntimeLog' | 'subscribe'>
  readonly locale: string
}

const MAX_VISIBLE_ENTRIES = 2_000
const SOURCE_KEYS = { renderer: 'runtimeLogRenderer', system: 'runtimeLogSystem', pnpm: 'runtimeLogPnpm' } as const
const LEVEL_KEYS = { info: 'taskLogInfo', warning: 'taskLogWarning', error: 'taskLogError' } as const

/** Read durable history when expanded, then append notifications without overlapping reads.
 * @param props - Optional Desktop log operations and active client locale.
 * @returns A collapsible plain-text diagnostic panel with follow, copy and export controls.
 */
export function CommunityRuntimeLogPanel({ api, locale }: CommunityRuntimeLogPanelProps): ReactNode {
  const t = (key: CommunityLocaleKey, values?: Readonly<Record<string, string>>): string => communityText(locale, key, values)
  const supportsLogs = typeof api.getRuntimeLog === 'function'
    && typeof api.copyRuntimeLog === 'function' && typeof api.exportRuntimeLog === 'function'
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<CommunityRuntimeLog | null>(null)
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
    const read = api.getRuntimeLog
    if (!open || !supportsLogs || typeof read !== 'function') return
    let disposed = false
    let reading = false
    let pending = false
    let current: CommunityRuntimeLog | null = null
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
          const value = await read(cursor)
          if (disposed) return
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
  }, [api, open, supportsLogs])

  useEffect(() => {
    if (open && follow && viewport.current !== null) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [open, follow, log?.nextCursor, log?.entries.length])

  const operate = async (action: 'copy' | 'export'): Promise<void> => {
    const copy = api.copyRuntimeLog, exportLog = api.exportRuntimeLog
    if (typeof copy !== 'function' || typeof exportLog !== 'function') return
    setOperation(action)
    setFeedback(null)
    try {
      const exported = action === 'copy' ? await copy() : await exportLog()
      if (mounted.current) setFeedback(action === 'copy' ? 'runtimeLogCopied' : exported === false ? 'taskLogExportCancelled' : 'runtimeLogExported')
    } catch {
      if (mounted.current) setFeedback(action === 'copy' ? 'runtimeLogCopyFailed' : 'runtimeLogExportFailed')
    } finally {
      if (mounted.current) setOperation(null)
    }
  }

  return <div className={css.taskLog}>
    <Button size="sm" variant="outline" aria-expanded={open} aria-controls={panelId}
      onClick={() => { setOpen(value => !value) }}>{t(open ? 'runtimeLogHide' : 'runtimeLogShow')}</Button>
    {open && <section id={panelId} className={css.taskLogPanel} aria-label={t('runtimeLogTitle')}>
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
      {!supportsLogs && <p className={css.meta} role="status">{t('runtimeLogUnsupported')}</p>}
      {loading && log === null && <p className={css.meta} role="status">{t('runtimeLogLoading')}</p>}
      {failed && <p className={css.problem} role="alert">{t('runtimeLogReadFailed')}</p>}
      {log?.unavailable === true && <p className={css.problem} role="alert">{t('taskLogUnavailable')}</p>}
      {log?.truncated === true && <p className={css.meta} role="status">{t('taskLogTruncated')}</p>}
      {log !== null && log.entries.length === 0 && !loading && !failed && !log.unavailable
        && <p className={css.meta}>{t('runtimeLogEmpty')}</p>}
      {feedback !== null && <p className={feedback === 'runtimeLogCopyFailed' || feedback === 'runtimeLogExportFailed' ? css.problem : css.meta}
        role={feedback === 'runtimeLogCopyFailed' || feedback === 'runtimeLogExportFailed' ? 'alert' : 'status'}>{t(feedback)}</p>}
      <div className={css.taskLogOutput} ref={viewport} role="log" aria-live="off" tabIndex={0}
        aria-label={t('runtimeLogTitle')}>
        <ol className={css.taskLogEntries}>{log?.entries.map(entry => <li key={entry.sequence} data-level={entry.level}>
          <div className={css.taskLogMetadata}>
            <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString(locale)}</time>
            <span>{t(SOURCE_KEYS[entry.source])}</span><span>{t(LEVEL_KEYS[entry.level])}</span>
            {entry.file !== undefined && <span>{entry.file}{entry.line === undefined ? '' : `:${String(entry.line)}`}</span>}
          </div>
          <pre>{entry.text}</pre>
        </li>)}</ol>
      </div>
    </section>}
  </div>
}
