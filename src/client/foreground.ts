/**
 * React-free state of one session's dock: the plugin status and the running foreground calls, fed by the plugin's private RPC
 * channel. The Host offers no push stream to a plugin's private channel (Remote streams belong to the typed gateway), so the
 * controller polls once a second, and only while somebody is watching (the dock is mounted and the session is busy).
 * Background jobs are not polled here: the Host's own `job.list` stream pushes them, and the dock reads that.
 * @module dsh-background/client/foreground
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { RPC_CHANNEL, type ActionResult, type CallView, type CallsView, type StatusView } from '../rpc-types.ts'

export interface ForegroundState {
  /** Undefined until the first `status` answer; a failed call leaves it at `{enabled: false}` (the dock stays hidden). */
  status: StatusView | undefined
  calls: readonly CallView[]
  /** Server clock minus browser clock at the last answer, so elapsed times do not depend on the two clocks agreeing. */
  skewMs: number
  /** The call ids with an action in flight. */
  pending: readonly string[]
  /** The last refusal, shown until the next action. */
  notice: string | undefined
}

const INITIAL: ForegroundState = { status: undefined, calls: [], skewMs: 0, pending: [], notice: undefined }
export const POLL_MS = 1_000

export class ForegroundController {
  private state: ForegroundState = INITIAL
  private readonly listeners = new Set<() => void>()
  private watchers = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private statusRequested = false
  private disposed = false
  private inflight = false

  constructor(private readonly rpc: Pick<ClientConnectionRpc, 'call'>, readonly sessionId: string) {}

  getSnapshot = (): ForegroundState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<ForegroundState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private async call<T>(endpoint: string, payload: unknown): Promise<T | undefined> {
    try {
      const result = await this.rpc.call(RPC_CHANNEL, endpoint, payload)
      return result.ok ? result.value as T : undefined
    } catch {
      return undefined
    }
  }

  /** Ask the plugin whether foreground control is on (once; a later `watch` does not repeat it). */
  async ensureStatus(): Promise<void> {
    if (this.statusRequested) return
    this.statusRequested = true
    const status = await this.call<StatusView>('status', {})
    this.set({ status: status ?? { foregroundControl: false, enabled: false, verifiedVersions: [], defaultPolicy: 'wait' } })
  }

  /** Re-read the running calls now. */
  async refresh(): Promise<void> {
    if (this.inflight || this.disposed) return
    this.inflight = true
    try {
      const sent = Date.now()
      const view = await this.call<CallsView>('calls', { sessionId: this.sessionId })
      if (view === undefined) return
      // Midpoint of the round trip against the server's clock.
      const skewMs = view.now - Math.round((sent + Date.now()) / 2)
      const live = new Set(view.calls.map(call => call.callId))
      this.set({ calls: view.calls, skewMs, pending: this.state.pending.filter(id => live.has(id)) })
    } finally { this.inflight = false }
  }

  /** Poll while at least one watcher is registered. Returns the unwatch function. */
  watch(): () => void {
    this.watchers += 1
    if (this.watchers === 1) {
      void this.ensureStatus().then(() => this.refresh())
      this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.watchers -= 1
      if (this.watchers === 0) {
        if (this.timer !== undefined) clearInterval(this.timer)
        this.timer = undefined
        this.set({ calls: [], pending: [] })
      }
    }
  }

  /** `transfer` or `interrupt` one call; a refusal is kept as the notice. */
  async act(kind: 'transfer' | 'interrupt', callId: string): Promise<ActionResult> {
    this.set({ pending: [...this.state.pending, callId], notice: undefined })
    const result = await this.call<ActionResult>(kind, { sessionId: this.sessionId, callId })
      ?? { ok: false as const, reason: 'the request failed' }
    this.set({ pending: this.state.pending.filter(id => id !== callId), notice: result.ok ? undefined : result.reason })
    await this.refresh()
    return result
  }

  dismissNotice(): void { this.set({ notice: undefined }) }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.disposed = true
    this.listeners.clear()
  }
}
