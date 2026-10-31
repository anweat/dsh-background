/**
 * Foreground control (prototype): track every foreground tool call and, while it runs, move it to the background
 * or interrupt just that tool.
 *
 * One `tools/execute` wrapper per plugin instance. It races the tool body against two triggers:
 * - `transfer`: register an owned `kind: 'tool'` job whose `done` waits for the still-running body, and release the
 *   call at once with an `isError` placeholder that says it is not a failure;
 * - `interrupt`: abort a signal the wrapper substituted into `exec.signal`, so only this tool (not the turn) stops.
 *
 * ## Host internals this depends on (R1)
 * `ToolRuntime.dispatchToolBody` ends with `finally { exec.signal = wrapperSignal }`, and `notifyResult` freezes the
 * execution once the call has been answered. After an early return that assignment hits a frozen object and throws,
 * so the abandoned `next()` rejects and the real result is lost. Before returning early the wrapper therefore turns
 * `exec.signal` into an accessor property (`configurable: false`); `Object.freeze` leaves accessors callable, so the
 * registry's assignment goes to our setter. Verified on DSH 0.2.1-rc.5 (dispatch code identical in rc.2 to rc.4) and
 * 0.2.0-rc.2. This is not an API: if a host stops matching, {@link TransferHub.transfer} refuses (the call keeps
 * running in the foreground), and a detached `next()` that still rejects turns the job `failed` with the reason.
 * @module dsh-background/transfer
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig, ToolPolicy } from './config.ts'
import { JOB_CONTROL_TOOLS } from './config.ts'
import { JOB_KIND, liveToolJobs } from './tool.ts'
import { oneLine, outcomeOf } from './outcome.ts'

/** Host `@deepseek-ai/dsh-tools` versions this prototype was checked against. */
export const VERIFIED_TOOLS_VERSIONS: readonly string[] = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']

export type CallState = 'running' | 'transferred' | 'interrupting' | 'done'

/** What a UI or RPC handler sees about one running foreground call. */
export interface RunningCallView {
  callId: string
  rootCallId: string
  agentId: string
  tool: string
  /** One-line summary of the arguments. */
  summary: string
  startedAt: number
  state: CallState
  /** Set once the call was moved to the background. */
  jobId?: string
  /** Whether this call may be moved or interrupted at all. */
  controllable: boolean
}

export type TransferResult = { ok: true; jobId: string } | { ok: false; reason: string }
export type InterruptResult = { ok: true } | { ok: false; reason: string }

/** The programmatic API a later RPC handler or button calls. */
export interface TransferApi {
  /** Whether transfer / interrupt work on this host (version gate) and which dsh-tools version was seen. */
  status(): { enabled: boolean; hostVersion?: string; verifiedVersions: readonly string[] }
  /** Running foreground calls, optionally of one agent (session id). */
  list(agentId?: string): RunningCallView[]
  /** Move one running call to the background. */
  transfer(callId: string, agentId?: string): TransferResult
  /** Cancel just that tool, not the turn. */
  interrupt(callId: string, agentId?: string): InterruptResult
  /** Apply the configured steering policy for one agent as if the user had just sent a steering message. */
  applyPolicy(agentId: string): { transferred: string[]; interrupted: string[] }
}

interface Entry {
  /** The signal the call arrived with (turn / caller, plus any outer wrapper's). */
  outerSignal: AbortSignal
  view: RunningCallView
  agent: any
  exec: any
  own: AbortController
  nextPromise: Promise<ToolExecutionResult>
  release: (decision: Release) => void
  timers: ReturnType<typeof setTimeout>[]
}

type Release =
  | { kind: 'transferred'; jobId: string; cause: 'user' | 'auto' }
  | { kind: 'interrupt-timeout' }

/** Text of the placeholder a transferred call returns to the model. */
export function transferPlaceholder(tool: string, jobId: string, cause: 'user' | 'auto' = 'user', afterMs = 0): string {
  const why = cause === 'user' ? "at the user's request" : `because it ran longer than ${Math.round(afterMs / 1000)} seconds`
  return `Not a failure, do not retry: ${tool} was moved to the background as job ${jobId} ${why}; `
    + 'a completion notice arrives when it finishes, read the result with job_output.'
}

/** Text of the result an interrupted call returns to the model. */
export function interruptedText(tool: string): string {
  return `Interrupted by the user: ${tool} was cancelled at the user's request before it finished. It did not complete; run it again only if the user asks.`
}

/** The summary shown in lists and job labels: compact JSON of the arguments. */
export function summarizeArguments(args: unknown): string {
  let text: string
  try { text = JSON.stringify(args) ?? '' } catch { text = '' }
  if (text === '{}' || text === 'null') return ''
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`
}

/** Version of the host's `@deepseek-ai/dsh-tools`, or undefined when it cannot be resolved from here. */
export function hostToolsVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return (require('@deepseek-ai/dsh-tools/package.json') as { version?: string }).version
  } catch {
    return undefined
  }
}

/**
 * Turn `exec.signal` into an accessor so the registry's later `exec.signal = x` cannot throw on the frozen object.
 * @returns whether the accessor is in place afterwards.
 */
export function installSignalAccessor(exec: any): boolean {
  try {
    const current = Object.getOwnPropertyDescriptor(exec, 'signal')
    if (current === undefined) return false
    if (current.get !== undefined && current.set !== undefined) return true // already an accessor (ours or another wrapper's)
    if (!current.configurable || !Object.isExtensible(exec)) return false
    let stored = exec.signal
    Object.defineProperty(exec, 'signal', {
      get: () => stored,
      set: (value) => { stored = value },
      enumerable: true,
      configurable: false,
    })
    return true
  } catch {
    return false
  }
}

export interface TransferHub {
  api: TransferApi
  /** Tools the wrapper never touches (this plugin's own tool, job controls, denyTools, natively backgrounding tools). */
  excluded(tool: string): boolean
  /** Abort the tools of every call this hub moved to the background (plugin unload). */
  abortDetached(reason: string): void
  /** The steering policy that applies to one tool. */
  policyFor(tool: string): ToolPolicy
}

/**
 * Register the wrapper and the inbox trigger on `ctx`. Everything is an effect of `ctx`, so unloading the plugin
 * removes them; calls still running at that moment are aborted by the caller's `abortAll`.
 */
export function installTransfer(ctx: Context, config: ResolvedConfig, options: { hostVersion?: string | null } = {}): TransferHub {
  const calls = new Map<string, Map<string, Entry>>()
  const detached = new Set<AbortController>()
  const log = (ctx as any).logger?.('dsh-background')

  const version = options.hostVersion === undefined ? hostToolsVersion() : options.hostVersion ?? undefined
  const hostOk = version === undefined ? true : VERIFIED_TOOLS_VERSIONS.includes(version)
  const allowed = hostOk || config.allowUnverifiedHost
  if (!hostOk) {
    log?.warn?.(`foreground control is OFF: dsh-tools ${version} was not verified (verified: ${VERIFIED_TOOLS_VERSIONS.join(', ')}); set allowUnverifiedHost to override`)
  }

  const excluded = (tool: string): boolean => tool === config.toolName || tool === 'background_run'
    || JOB_CONTROL_TOOLS.includes(tool) || config.denyTools.has(tool) || config.nativeBackgroundTools.has(tool)

  const policyFor = (tool: string): ToolPolicy => {
    const explicit = config.toolPolicies[tool]
    if (explicit !== undefined) return explicit
    if (config.waitOnlyTools.has(tool)) return 'wait'
    return config.onUserMessageWhileToolRuns
  }

  const find = (callId: string, agentId?: string): Entry | undefined => {
    if (agentId !== undefined) return calls.get(agentId)?.get(callId)
    for (const perAgent of calls.values()) {
      const hit = perAgent.get(callId)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  const transfer = (entry: Entry, cause: 'user' | 'auto' = 'user'): TransferResult => {
    if (!allowed) return { ok: false, reason: `transfer is disabled: dsh-tools ${version} was not verified for it` }
    if (entry.view.state !== 'running') return { ok: false, reason: `the call is ${entry.view.state}` }
    if (!entry.view.controllable) return { ok: false, reason: `${entry.view.tool} cannot be moved to the background` }
    const jobs = ctx.get('jobs')
    if (jobs === undefined) return { ok: false, reason: 'background jobs unavailable: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs' }
    const live = liveToolJobs(jobs, entry.agent.id)
    if (live >= config.maxConcurrentJobs) return { ok: false, reason: `too many background tool jobs for this agent (${live} of ${config.maxConcurrentJobs})` }
    if (!installSignalAccessor(entry.exec)) return { ok: false, reason: 'this host version does not allow detaching a running call (exec.signal could not be made an accessor)' }

    const { own, nextPromise, view, outerSignal } = entry
    let jobId: string
    try {
      jobId = jobs.start({
        kind: JOB_KIND,
        label: `${view.tool}: ${view.summary || 'moved to the background'}`,
        owner: entry.agent.id,
        toolCall: { callId: entry.exec.callId, rootCallId: entry.exec.rootCallId ?? entry.exec.callId },
        ...config.outputLimitBytes === undefined ? {} : { outputLimitBytes: config.outputLimitBytes },
        run: (job) => {
          job.append(`[background] ${view.tool} moved to the background after ${Math.round((Date.now() - view.startedAt) / 1000)}s (${cause})\n`, { channel: 'log' })
          job.updateProgress(`running ${view.tool}`)
          // The host fuses the turn's signal into the body for good (R3): a user "stop" after the transfer still ends it.
          const stoppedWithTurn = (): boolean => !own.signal.aborted && outerSignal.aborted
          const done = nextPromise.then(
            (result) => {
              const outcome = outcomeOf(result, own.signal.aborted || outerSignal.aborted, config.maxResultChars)
              return stoppedWithTurn() ? { ...outcome, detail: 'stopped together with the turn (user stop)' } : outcome
            },
            (error: unknown) => {
              // The host rejected the detached call (R1 workaround no longer matches): the real result is lost.
              if (own.signal.aborted || outerSignal.aborted) return { status: 'killed' as const }
              const reason = error instanceof Error ? error.message : String(error)
              log?.warn?.(`detached ${view.tool} call ${view.callId} rejected: ${reason}`)
              return { status: 'failed' as const, detail: oneLine(`the host rejected the detached call: ${reason}`), result: `The ${view.tool} call ended but the host could not hand over its result: ${reason}` }
            },
          )
          return { cancel: (reason?: string): void => { own.abort(new Error(reason ?? 'background job killed')) }, done }
        },
      })
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    view.state = 'transferred'
    view.jobId = jobId
    detached.add(own)
    void nextPromise.finally(() => detached.delete(own)).catch(() => {})
    entry.release({ kind: 'transferred', jobId, cause })
    return { ok: true, jobId }
  }

  const interrupt = (entry: Entry): InterruptResult => {
    if (entry.view.state !== 'running') return { ok: false, reason: `the call is ${entry.view.state}` }
    if (!entry.view.controllable) return { ok: false, reason: `${entry.view.tool} cannot be interrupted` }
    entry.view.state = 'interrupting'
    entry.own.abort(new Error('interrupted by the user'))
    // A body that ignores the signal must not hold the step forever.
    entry.timers.push(setTimeout(() => entry.release({ kind: 'interrupt-timeout' }), config.interruptGraceMs))
    return { ok: true }
  }

  const applyPolicy = (agentId: string): { transferred: string[]; interrupted: string[] } => {
    const out = { transferred: [] as string[], interrupted: [] as string[] }
    for (const entry of [...calls.get(agentId)?.values() ?? []]) {
      if (entry.view.state !== 'running') continue
      const policy = policyFor(entry.view.tool)
      if (policy === 'background' && transfer(entry).ok) out.transferred.push(entry.view.callId)
      else if (policy === 'interrupt' && interrupt(entry).ok) out.interrupted.push(entry.view.callId)
    }
    return out
  }

  const api: TransferApi = {
    status: () => ({ enabled: allowed, ...version === undefined ? {} : { hostVersion: version }, verifiedVersions: VERIFIED_TOOLS_VERSIONS }),
    list: (agentId) => [...calls.entries()]
      .filter(([id]) => agentId === undefined || id === agentId)
      .flatMap(([, perAgent]) => [...perAgent.values()].map(entry => ({ ...entry.view }))),
    transfer(callId, agentId) {
      const entry = find(callId, agentId)
      return entry === undefined ? { ok: false, reason: `no running call ${callId}` } : transfer(entry)
    },
    interrupt(callId, agentId) {
      const entry = find(callId, agentId)
      return entry === undefined ? { ok: false, reason: `no running call ${callId}` } : interrupt(entry)
    },
    applyPolicy,
  }

  ctx.on('tools/execute', async (exec: any, next: () => Promise<ToolExecutionResult>) => {
    const agent = exec.agent
    if (agent === undefined || excluded(exec.name)) return next()

    const outerSignal: AbortSignal = exec.signal
    const own = new AbortController()
    // Fused so another wrapper's signal (timeout) keeps working; the registry fuses the original caller signal again.
    exec.signal = AbortSignal.any([outerSignal, own.signal])

    let release!: (decision: Release) => void
    const released = new Promise<Release>((resolve) => { release = resolve })
    const view: RunningCallView = {
      callId: exec.callId,
      rootCallId: exec.rootCallId ?? exec.callId,
      agentId: agent.id,
      tool: exec.name,
      summary: summarizeArguments(exec.arguments),
      startedAt: Date.now(),
      state: 'running',
      controllable: allowed,
    }
    const nextPromise = next()
    nextPromise.catch(() => {}) // observed below or by the job; never an unhandled rejection
    const entry: Entry = { outerSignal, view, agent, exec, own, nextPromise, release, timers: [] }

    let perAgent = calls.get(agent.id)
    if (perAgent === undefined) calls.set(agent.id, perAgent = new Map())
    perAgent.set(exec.callId, entry)

    const autoMs = config.toolAutoBackgroundMs[exec.name] ?? config.autoBackgroundAfterMs
    if (allowed && autoMs !== undefined && autoMs > 0) {
      entry.timers.push(setTimeout(() => { if (view.state === 'running') transfer(entry, 'auto') }, autoMs))
    }

    try {
      const winner = await Promise.race([
        nextPromise.then(result => ({ kind: 'done' as const, result }), error => ({ kind: 'rejected' as const, error })),
        released,
      ])
      if (winner.kind === 'done') {
        exec.signal = outerSignal
        if (view.state === 'interrupting') return interruptedResult(view.tool, winner.result)
        return winner.result
      }
      if (winner.kind === 'rejected') throw winner.error
      if (winner.kind === 'transferred') {
        return placeholder(view.tool, winner.jobId, winner.cause, Date.now() - view.startedAt)
      }
      // interrupt-timeout: the body ignored the signal; release the call and let it finish unseen.
      if (!installSignalAccessor(exec)) return nextPromise // cannot detach safely: keep waiting
      view.state = 'done'
      return interruptedResult(view.tool, undefined, true)
    } finally {
      for (const timer of entry.timers) clearTimeout(timer)
      if (view.state === 'running' || view.state === 'interrupting') view.state = 'done'
      perAgent.delete(exec.callId)
      if (perAgent.size === 0 && calls.get(agent.id) === perAgent) calls.delete(agent.id)
    }
  })

  // Steering messages typed while a tool runs. Only user-authored messages in the next-step inbox qualify:
  // completion notices and plugin injections carry other sources, follow-ups go to next-turn.
  ctx.on('agent/inbox/inserted', (payload: any) => {
    const { agent, message } = payload
    if (message?.source?.kind !== 'user') return
    if (!agent.inbox.nextStep.some((queued: any) => queued.id === message.id)) return
    if (!calls.has(agent.id)) return
    applyPolicy(agent.id)
  })

  return {
    api, excluded, policyFor,
    abortDetached(reason) { for (const controller of [...detached]) controller.abort(new Error(reason)) },
  }
}

function placeholder(tool: string, jobId: string, cause: 'user' | 'auto', ranMs: number): ToolExecutionResult {
  const text = transferPlaceholder(tool, jobId, cause, ranMs)
  return {
    isError: true,
    error: { message: text, info: { name: 'MovedToBackground', code: 'MOVED_TO_BACKGROUND' } },
    content: [{ type: 'text', text }],
  } as ToolExecutionResult
}

function interruptedResult(tool: string, original: ToolExecutionResult | undefined, released = false): ToolExecutionResult {
  const text = interruptedText(tool) + (released ? ' The tool had not stopped yet when the call was released.' : '')
  const additionalContexts = original?.additionalContexts
  return {
    isError: true,
    error: { message: text, info: { name: 'AbortError', code: 'ABORTED' } },
    content: [{ type: 'text', text }],
    ...additionalContexts !== undefined && additionalContexts.length > 0 ? { additionalContexts } : {},
  } as ToolExecutionResult
}
