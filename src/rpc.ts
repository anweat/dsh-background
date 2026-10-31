/**
 * Server half of the dock's private RPC channel (see rpc-types.ts). It uses the Host's connection transport the way the
 * dsh-browser and dsh-web-search-pro plugins do (`connection.rpc.handle`, an authenticated absolute channel prefix). When
 * the Host has no `connection` / `webServer` service nothing is registered and the dock simply never appears.
 * @module dsh-background/rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TransferApi } from './transfer.ts'
import { JOB_KIND } from './tool.ts'
import {
  RPC_CHANNEL,
  type ActionResult, type CallView, type CallsView, type JobRowView, type JobsView, type StatusView, type ToolPolicyName,
} from './rpc-types.ts'

type Failure = { ok: false; error: { code: 'bad-request' | 'not-found' | 'forbidden'; message: string; details: Record<string, unknown> } }
type Handler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: { principal: { kind: string } }) => Promise<{ ok: true; value: unknown } | Failure>

/** The slice of the job registry this channel reads and acts on. */
export interface JobsLike {
  list(caller?: any): { id: any; kind: string; label: string; status: JobRowView['status']; progress?: string; detail?: string; startedAt?: number; finishedAt?: number }[]
  get(id: any, caller?: any): { kind: string }
  kill(id: any, caller?: any, reason?: string): 'requested' | 'already-finished'
}

export interface RpcServices {
  /** Present when `foregroundControl` is on. */
  hub?: { api: TransferApi; policyFor(tool: string): ToolPolicyName }
  /** The configured fallback policy (shown by `status`). */
  defaultPolicy: ToolPolicyName
  foregroundControl: boolean
  jobs: () => JobsLike | undefined
  /** Resolve a live session id to its agent; undefined for an unknown or disposed session. */
  agent: (sessionId: string) => { id: any } | undefined
  now?: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code: Failure['error']['code'], message: string): Failure => ({ ok: false, error: { code, message, details: {} } })

/** Handler of the channel. A failure is a value (`ok: false`), never a throw into the transport. */
export function createHandler(services: RpcServices): Handler {
  const now = services.now ?? Date.now
  return async (endpoint, rawPayload, _signal, peer) => {
    try {
      // Only the owner (an authenticated browser) may use the channel; the transport already refuses everyone else.
      if (peer?.principal?.kind !== 'owner') return fail('forbidden', 'only the owner may use this channel')
      const payload = isRecord(rawPayload) ? rawPayload : {}

      if (endpoint === 'status') {
        const status = services.hub?.api.status()
        const view: StatusView = {
          foregroundControl: services.foregroundControl,
          enabled: services.foregroundControl && status?.enabled === true,
          ...status?.hostVersion === undefined ? {} : { hostVersion: status.hostVersion },
          verifiedVersions: status?.verifiedVersions ?? [],
          defaultPolicy: services.defaultPolicy,
        }
        return { ok: true, value: view }
      }

      // Everything else is about one session the dock shows.
      const sessionId = payload.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) return fail('bad-request', 'sessionId must be a non-empty string')
      const agent = services.agent(sessionId)
      if (agent === undefined) return fail('not-found', `no live session "${sessionId}"`)

      switch (endpoint) {
        case 'calls': {
          const hub = services.hub
          const calls: CallView[] = hub === undefined ? [] : hub.api.list(sessionId)
            .filter(call => call.state === 'running' || call.state === 'interrupting')
            .map(call => ({
              callId: call.callId, tool: call.tool, summary: call.summary, startedAt: call.startedAt,
              state: call.state as 'running' | 'interrupting',
              transferable: call.controllable && call.state === 'running',
              interruptible: call.controllable && call.state === 'running',
              policy: hub.policyFor(call.tool),
            }))
          const view: CallsView = { now: now(), calls }
          return { ok: true, value: view }
        }
        case 'jobs': {
          const jobs = services.jobs()
          const rows: JobRowView[] = (jobs?.list(agent.id) ?? [])
            .filter(job => job.kind === JOB_KIND)
            .map(job => ({
              id: String(job.id), label: job.label, status: job.status,
              ...job.progress === undefined ? {} : { progress: job.progress },
              ...job.detail === undefined ? {} : { detail: job.detail },
              startedAt: job.startedAt ?? 0,
              ...job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt },
            }))
          const view: JobsView = { now: now(), jobs: rows }
          return { ok: true, value: view }
        }
        case 'transfer':
        case 'interrupt': {
          const callId = payload.callId
          if (typeof callId !== 'string' || callId.length === 0 || callId.length > 200) return fail('bad-request', 'callId must be a non-empty string')
          const hub = services.hub
          if (hub === undefined) return { ok: true, value: { ok: false, reason: 'foreground control is off' } satisfies ActionResult }
          // The call is looked up inside this session only, so another session's call id is an unknown id here.
          const result = endpoint === 'transfer' ? hub.api.transfer(callId, sessionId) : hub.api.interrupt(callId, sessionId)
          return { ok: true, value: result satisfies ActionResult }
        }
        case 'killJob': {
          const jobId = payload.jobId
          if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 200) return fail('bad-request', 'jobId must be a non-empty string')
          const jobs = services.jobs()
          if (jobs === undefined) return { ok: true, value: { ok: false, reason: 'background jobs unavailable' } satisfies ActionResult }
          let kind: string
          try { kind = jobs.get(jobId, agent.id).kind } catch { return { ok: true, value: { ok: false, reason: `no job ${jobId} in this session` } satisfies ActionResult } }
          if (kind !== JOB_KIND) return { ok: true, value: { ok: false, reason: `${jobId} is not a job of this plugin` } satisfies ActionResult }
          jobs.kill(jobId, agent.id, 'stopped by the user')
          return { ok: true, value: { ok: true } satisfies ActionResult }
        }
        default:
          return fail('not-found', `unknown endpoint: ${endpoint}`)
      }
    } catch (error) {
      return fail('bad-request', String(error instanceof Error ? error.message : error).slice(0, 500))
    }
  }
}

/** Register the channel when the Host has the transport; the effect unregisters it with the plugin. */
export function registerRpc(ctx: Context, services: RpcServices): void {
  ;(ctx as any).inject(['connection', 'webServer'], (connectionCtx: any) => {
    const connection = connectionCtx.root.connection as { rpc: { handle(channel: string, handler: Handler): () => Promise<void> } }
    connectionCtx.effect(() => connection.rpc.handle(RPC_CHANNEL, createHandler(services)), 'dsh-background: dock RPC channel')
  })
}
