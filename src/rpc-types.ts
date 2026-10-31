/**
 * The private RPC channel between the dock (browser) and the running plugin: the shapes it carries. Free of runtime
 * imports, because the client bundle includes this file; the server half is `rpc.ts`.
 *
 * Every endpoint except `status` takes the id of the session the dock is showing (`sessionId`). The Host's RPC layer does
 * not say which session a browser is looking at (its Peer only carries the principal, always `owner` for an authenticated
 * browser), so the id travels in the payload and the server checks it: the session must be live, and a call or job must
 * belong to that session. Endpoints:
 *  - `status`: whether foreground control is on and usable on this host;
 *  - `calls`: the session's running foreground tool calls;
 *  - `jobs`: this plugin's background jobs of the session (the dock normally gets these pushed by the Host's own jobs
 *    stream; this endpoint serves clients that have no such stream);
 *  - `transfer`, `interrupt`: act on one running call;
 *  - `killJob`: stop one of this plugin's jobs.
 * @module dsh-background/rpc-types
 */

/** The channel prefix this plugin registers with the Host transport. */
export const RPC_CHANNEL = '/dsh-background'

export type ToolPolicyName = 'wait' | 'background' | 'interrupt'

/** `status` */
export interface StatusView {
  /** The `foregroundControl` setting. */
  foregroundControl: boolean
  /** Whether transfer / interrupt work right now (setting on and the host version gate passed). */
  enabled: boolean
  hostVersion?: string
  verifiedVersions: readonly string[]
  /** What a steering message does to a running tool unless a per-tool policy says otherwise. */
  defaultPolicy: ToolPolicyName
}

/** One running foreground call. */
export interface CallView {
  callId: string
  tool: string
  /** Compact JSON of the arguments, at most 80 characters. */
  summary: string
  /** Epoch milliseconds. */
  startedAt: number
  state: 'running' | 'interrupting'
  transferable: boolean
  interruptible: boolean
  /** What a steering message would do to this call. */
  policy: ToolPolicyName
}

/** `calls` */
export interface CallsView {
  /** Server clock, so a browser with a skewed clock can still show a correct elapsed time. */
  now: number
  calls: CallView[]
}

/** One of this plugin's background jobs. */
export interface JobRowView {
  id: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Live progress line while running. */
  progress?: string
  /** Terminal reason once settled. */
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** `jobs` */
export interface JobsView {
  now: number
  jobs: JobRowView[]
}

/** `transfer`, `interrupt`, `killJob`: a refusal is a value with a reason, so the dock can show it. */
export type ActionResult = { ok: true; jobId?: string } | { ok: false; reason: string }

/** Payload of `calls`, `jobs`. */
export interface SessionRequest {
  sessionId: string
}

/** Payload of `transfer`, `interrupt`. */
export interface CallRequest extends SessionRequest {
  callId: string
}

/** Payload of `killJob`. */
export interface JobRequest extends SessionRequest {
  jobId: string
}
