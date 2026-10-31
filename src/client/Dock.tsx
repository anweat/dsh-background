/**
 * The dock above the composer: the foreground tools that are running (move to background, interrupt) and this plugin's
 * background jobs (stop). It renders nothing when there is nothing to show, or when foreground control is off or gated.
 * @module dsh-background/client/Dock
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type { JobView } from '@deepseek-ai/dsh-jobs/view'
import type { ActionResult, CallView } from '../rpc-types.ts'
import type { ForegroundState } from './foreground.ts'
import { NS } from './locales.ts'
import { styles as css } from './styles.ts'

/** What the registration injects for one session. */
export interface DockInjected {
  hooks: {
    foreground: { getSnapshot(): ForegroundState; subscribe(listener: () => void): () => void }
    jobs: { getSnapshot(): JobsSnapshot; subscribe(listener: () => void): () => void }
  }
  /** Start polling the running calls; returns the stop function. */
  watch: () => () => void
  /** Read the plugin status once (also needed while idle, to know whether background jobs may be shown). */
  ensureStatus: () => void
  /** Keep the session's job roster current while the dock is mounted (the Host reference-counts it). */
  watchJobs: () => () => void
  transfer: (callId: string) => Promise<ActionResult>
  interrupt: (callId: string) => Promise<ActionResult>
  killJob: (jobId: string) => Promise<boolean>
}

export type DockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<typeof NS> & InjectFace<DockInjected>

const NO_JOBS: readonly JobView[] = []
/** How many settled jobs the section keeps listing (the Host's own job list has the full history). */
const SETTLED_SHOWN = 3

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(ms: number, t: TranslateNS<typeof NS>): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? t('time.hmmss', { h, m: String(m).padStart(2, '0'), s }) : t('time.mmss', { m, s })
}

function dotState(status: JobView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': case 'killed': return 'warning'
    case 'completed': return 'done'
    default: return 'error'
  }
}

function isLive(job: JobView): boolean { return job.status === 'running' || job.status === 'stopping' }

/** Re-render once a second while `active`, and return the browser clock. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [active])
  return now
}

export function Dock(props: DockProps) {
  const { sessionId, useSession, useForeground, useJobs, watch, ensureStatus, watchJobs, transfer, interrupt, killJob, t } = props
  const running = useSession(s => s.running)
  const status = useForeground(s => s.status)
  const calls = useForeground(s => s.calls)
  const skewMs = useForeground(s => s.skewMs)
  const pending = useForeground(s => s.pending)
  const notice = useForeground(s => s.notice)
  const rows = useJobs(s => s.rows[sessionId as string]) ?? NO_JOBS
  const [open, setOpen] = useState(true)
  const [stopFailed, setStopFailed] = useState<string | null>(null)

  useEffect(() => { ensureStatus() }, [ensureStatus])
  const enabled = status?.enabled === true
  // Poll the running calls only while the session is busy and foreground control is usable.
  useEffect(() => (running && enabled ? watch() : undefined), [running, enabled, watch])
  useEffect(() => (enabled ? watchJobs() : undefined), [enabled, watchJobs])

  const ours = useMemo(() => rows.filter(job => job.kind === 'tool'), [rows])
  const shown = useMemo(() => {
    const live = ours.filter(isLive)
    const settled = ours.filter(job => !isLive(job)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, SETTLED_SHOWN)
    return [...live, ...settled]
  }, [ours])
  const liveCount = ours.filter(isLive).length
  const visibleCalls = running ? calls : []

  const now = useNow(enabled && (visibleCalls.length > 0 || liveCount > 0))
  if (!enabled || (visibleCalls.length === 0 && shown.length === 0)) return null
  const serverNow = now + skewMs

  return (
    <div className={css.dock} data-background-dock="">
      <div className={css.panel}>
        {visibleCalls.length > 0 && (
          <section className={css.section} aria-label={t('foreground.aria')} data-background-foreground="">
            <ul className={css.list}>
              {visibleCalls.map((call: CallView) => {
                const busy = pending.includes(call.callId) || call.state === 'interrupting'
                const elapsed = formatElapsed(serverNow - call.startedAt, t)
                return (
                  <li key={call.callId} className={css.row} data-call-id={call.callId} data-tool={call.tool}>
                    <span className={css.lead} aria-hidden><StateDot state="ongoing" /></span>
                    <span className={css.tool}>{call.tool}</span>
                    <span className={css.args} title={call.summary}>{call.summary}</span>
                    <span className={css.time} title={t('foreground.elapsed', { time: elapsed })} data-elapsed="">{elapsed}</span>
                    <div className={css.actions}>
                      <Button
                        size="sm" variant="ghost" className={css.action} data-action="transfer"
                        title={t('foreground.transfer.hint')}
                        disabled={busy || !call.transferable}
                        onClick={() => { void transfer(call.callId) }}
                      >{t('foreground.transfer')}</Button>
                      <Button
                        size="sm" variant="ghost" className={css.action} data-action="interrupt"
                        title={t('foreground.interrupt.hint')}
                        disabled={busy || !call.interruptible}
                        onClick={() => { void interrupt(call.callId) }}
                      >{call.state === 'interrupting' ? t('foreground.interrupting') : t('foreground.interrupt')}</Button>
                    </div>
                  </li>
                )
              })}
            </ul>
            {notice !== undefined && <p className={css.notice} role="status" data-background-notice="">{t('foreground.failed', { reason: notice })}</p>}
          </section>
        )}
        {shown.length > 0 && (
          <section className={css.section} data-background-jobs="">
            <button
              type="button" className={css.header} aria-expanded={open}
              aria-label={open ? t('jobs.toggle.close') : t('jobs.toggle.open')}
              onClick={() => { setOpen(value => !value) }}
            >
              <span className={css.headerText}>{t('jobs.header')}{liveCount > 0 ? ` · ${t('jobs.live', { n: liveCount })}` : ''}</span>
              <span className={css.chevron} aria-hidden />
            </button>
            {open && (
              <ul className={css.list}>
                {shown.map(job => {
                  const live = isLive(job)
                  const elapsed = formatElapsed(((job.finishedAt ?? serverNow) - job.startedAt), t)
                  const meta = live ? job.progress : job.detail
                  return (
                    <li key={job.id} className={`${css.row} ${live ? '' : css.settled}`} data-job-id={job.id} data-job-status={job.status}>
                      <span className={css.lead} aria-hidden><StateDot state={dotState(job.status)} /></span>
                      <span className={css.label} title={job.label}>{job.label}</span>
                      {meta !== undefined && meta !== '' && <span className={css.meta} title={meta}>{meta}</span>}
                      <span className={css.status}>{t(`status.${job.status}`)}</span>
                      <span className={css.time}>{elapsed}</span>
                      <div className={css.actions}>
                        {live && (
                          <Button
                            size="sm" variant="ghost" className={css.action} data-action="stop"
                            aria-label={t('jobs.stop.aria', { label: job.label })}
                            disabled={job.status === 'stopping'}
                            onClick={() => {
                              setStopFailed(null)
                              void killJob(job.id).then(ok => { if (!ok) setStopFailed(job.id) })
                            }}
                          >{t('jobs.stop')}</Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {stopFailed !== null && <p className={css.notice} role="status">{t('jobs.stop.failed')}</p>}
          </section>
        )}
      </div>
    </div>
  )
}
