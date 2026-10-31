/**
 * Test harness: a real `ToolRuntime` (and `SystemPrompt`) from the Host packages, a fake job registry that
 * implements just the `ctx.jobs` contract this plugin uses, and a few probe tools.
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../src/index.ts'

export const settle = (ms = 20): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface FakeJob {
  id: string
  spec: any
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  progress?: string
  detail?: string
  result?: string
  appended: { text: string; channel?: string }[]
  hooks: { cancel(reason?: string): void; done: Promise<any> }
  killReason?: string
}

/** The slice of `JobRegistry` the plugin touches: start / list / kill, with real settle semantics. */
export class FakeJobs {
  jobs: FakeJob[] = []
  failNextStart: Error | undefined
  start(spec: any): string {
    if (this.failNextStart) { const error = this.failNextStart; this.failNextStart = undefined; throw error }
    const id = `${spec.kind}-${String(this.jobs.length + 1).padStart(4, '0')}`
    const job: FakeJob = { id, spec, status: 'running', appended: [], hooks: undefined as never }
    const handle = {
      id,
      append: (text: string, options?: { channel?: string }) => { job.appended.push({ text, channel: options?.channel }) },
      updateProgress: (line: string) => { job.progress = line },
    }
    job.hooks = spec.run(handle)
    this.jobs.push(job)
    void job.hooks.done.then((outcome: any) => {
      job.status = outcome.status
      job.detail = outcome.detail
      job.result = outcome.result
      job.progress = undefined
    })
    return id
  }
  list(caller?: string): { id: string; kind: string; status: string; owner?: string }[] {
    return this.jobs.filter(job => job.spec.owner === undefined || job.spec.owner === caller)
      .map(job => ({ id: job.id, kind: job.spec.kind, status: job.status, owner: job.spec.owner }))
  }
  kill(id: string, _caller?: string, reason?: string): 'requested' | 'already-finished' {
    const job = this.jobs.find(candidate => candidate.id === id)!
    if (job.status !== 'running') return 'already-finished'
    job.status = 'stopping'
    job.killReason = reason
    job.hooks.cancel(reason)
    return 'requested'
  }
  /** Resolves once the job settled. */
  async finished(id: string): Promise<FakeJob> {
    const job = this.jobs.find(candidate => candidate.id === id)!
    await job.hooks.done
    await settle(0)
    return job
  }
}

export const text = (value: string) => [{ type: 'text' as const, text: value }]

/** Probe tools: instant echo, controllable slow tool, failing tool, image tool, tool with its own run_in_background. */
export function probeTools() {
  const gates = new Map<string, () => void>()
  const seen: { name: string; callId: string; rootCallId?: string; signal: AbortSignal; agent?: unknown }[] = []
  const stringOut = { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => text(v) }
  const tools = [
    defineTool({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string', required: true } },
      output: stringOut,
      async execute(args, exec) { seen.push({ name: 'echo', callId: exec.callId, rootCallId: exec.rootCallId, signal: exec.signal, agent: exec.agent }); return args.text },
    }),
    defineTool({
      name: 'slow', description: 'waits for release() or abort', parameters: { label: { type: 'string', required: true } },
      output: stringOut,
      async execute(args, exec) {
        seen.push({ name: 'slow', callId: exec.callId, rootCallId: exec.rootCallId, signal: exec.signal, agent: exec.agent })
        await new Promise<void>((resolve, reject) => {
          gates.set(args.label, resolve)
          exec.signal.addEventListener('abort', () => reject(new Error('slow aborted')), { once: true })
        })
        return `slow ${args.label} done`
      },
    }),
    defineTool({
      name: 'boom', description: 'always fails', parameters: {},
      output: stringOut,
      async execute() { throw new Error('boom exploded\nsecond line') },
    }),
    defineTool({
      name: 'big', description: 'long text', parameters: { n: { type: 'integer', required: true } },
      output: stringOut,
      async execute(args) { return 'x'.repeat(args.n) },
    }),
    defineTool({
      name: 'pic', description: 'text and image', parameters: {},
      output: {
        schema: { type: 'string' as const },
        render: (_a, v) => [{ type: 'text' as const, text: v }, { type: 'image' as const, attachment: { id: 'att-1' } } as never],
      },
      async execute() { return 'caption' },
    }),
    defineTool({
      name: 'own_bg', description: 'has its own background flag', parameters: { run_in_background: { type: 'boolean' } },
      output: stringOut,
      async execute() { return 'ok' },
    }),
  ]
  return { tools, gates, seen, release: (label: string) => gates.get(label)!() }
}

export interface Rig {
  ctx: any
  tools: any
  jobs: FakeJobs
  probe: ReturnType<typeof probeTools>
  agent: { id: string }
  fiber: { dispose(): void }
  /** Run one tool call as the model would (through the full pipeline). */
  call(name: string, args: unknown, options?: { agent?: unknown; signal?: AbortSignal; callId?: string }): Promise<any>
  dispose(): void
}

export async function rig(config: Record<string, unknown> = {}, options: { withJobs?: boolean; extra?: (ctx: any) => void } = {}): Promise<Rig> {
  const ctx = new Context() as any
  ctx.plugin(SystemPrompt as never)
  await settle()
  ctx.plugin(ToolRuntime as never)
  await settle()
  const jobs = new FakeJobs()
  if (options.withJobs !== false) ctx.provide('jobs', jobs)
  const probe = probeTools()
  for (const tool of probe.tools) ctx.tools.register(tool)
  options.extra?.(ctx)
  const fiber = ctx.plugin(plugin as never, config)
  await settle()
  const agent = { id: 'sess-A' }
  let counter = 0
  return {
    ctx, tools: ctx.tools, jobs, probe, agent, fiber,
    call: (name, args, opts = {}) => ctx.tools.execute({
      callId: opts.callId ?? `call-${++counter}`, name, arguments: args,
      agent: 'agent' in opts ? opts.agent : agent, signal: opts.signal ?? new AbortController().signal,
    }),
    dispose: () => fiber.dispose(),
  }
}

export const resultText = (result: any): string => (result.content as { text?: string }[]).map(block => block.text ?? '').join('\n')
