/**
 * The `background_run` tool: start any other tool call as an owned job and return at once.
 *
 * The nested call goes through the full tool pipeline (`ctx.tools.execute`: pre-execute with approval, guards,
 * `tools/execute`, post-execute) under an abort controller owned by the job, not by the calling step. So the
 * work outlives the turn, and only `job_kill`, owner teardown or this plugin unloading cancels it.
 * @module dsh-background/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import { defineTool, ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { JOB_CONTROL_TOOLS } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { oneLine, outcomeOf } from './outcome.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    tool: 'tool'
  }
}

/** Job kind of every job this plugin registers. */
export const JOB_KIND = 'tool'

/** The tool's own state, exposed so tests and the plugin entry can stop live work. */
export interface BackgroundTool {
  definition: ToolDefinition
  /** Abort every live nested call (plugin unload). */
  abortAll(reason: string): void
}

/** Why `background_run` refuses `name` before registering a job, or undefined when it may proceed. */
export function refusalFor(name: string, config: ResolvedConfig, definitionParams: unknown): string | undefined {
  if (name === config.toolName || name === 'background_run') return `${name} cannot run itself in the background`
  if (JOB_CONTROL_TOOLS.includes(name)) return `${name} controls background jobs and cannot run in the background; call it directly`
  if (config.denyTools.has(name)) return `${name} is not allowed to run in the background on this deployment`
  const hasOwnFlag = typeof definitionParams === 'object' && definitionParams !== null
    && 'properties' in definitionParams
    && typeof definitionParams.properties === 'object' && definitionParams.properties !== null
    && 'run_in_background' in definitionParams.properties
  if (config.nativeBackgroundTools.has(name) || hasOwnFlag) {
    return name === 'subagent' || name === 'terminal_open'
      ? `${name} already runs in the background and reports through the job runtime; call it directly`
      : `${name} has its own background mode; call it directly with run_in_background: true`
  }
  return undefined
}

/** Build the tool definition for one plugin instance. */
export function createBackgroundTool(ctx: Context, config: ResolvedConfig): BackgroundTool {
  const live = new Set<AbortController>()

  const definition = defineTool({
    name: config.toolName,
    description: 'Run another tool call in the background. Returns a job id at once, so you can keep working or answer the user; '
      + 'the tool\'s result arrives later with the job\'s completion notice (read it with job_output, stop it with job_kill). '
      + 'Give the target tool name, the arguments exactly as that tool\'s own schema defines them, and a one-line description. '
      + 'Do not use it for tools that write the same files or state as other tools you are running, or for tools that need the user\'s answer.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Name of the tool to run, exactly as listed in your tools.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Arguments for that tool, following its own schema. Omit for a tool without arguments.' },
      description: { type: 'string', required: true, description: 'One line saying what this run does; shown in job_list and in the completion notice.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.tool} started in the background as job ${value.jobId} (${value.description}). `
          + 'Its result arrives with the completion notice; check with job_output, stop with job_kill. '
          + 'Do not wait or poll unless you need the result now.',
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `background: ${args.tool}`,
      rawInput: JSON.stringify({ description: args.description, arguments: args.arguments ?? {} }, null, 2),
    }),
    presentResult: () => ({ card: 'generic' }),
    async execute(args, exec) {
      const invalid = (...violations: string[]): never => { throw new ToolArgsError(violations) }
      const agent: Agent | undefined = exec.agent
      if (agent === undefined) return invalid('background_run needs a calling agent (exec.agent was undefined)')
      const jobs = ctx.get('jobs')
      if (jobs === undefined) return invalid('background jobs unavailable: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')

      const target = args.tool.trim()
      const description = args.description.trim()
      if (target.length === 0) return invalid('tool must not be empty')
      if (description.length === 0) return invalid('description must not be empty')
      const targetArguments = args.arguments ?? {}

      const found = ctx.tools.get(target, agent)
      // Name-based refusals first: they hold even when the target is not visible to this agent.
      const refusal = refusalFor(target, config, found?.parameters)
      if (refusal !== undefined) return invalid(refusal)
      if (found === undefined) return invalid(`tool "${target}" is not available to this agent; use a name from your tool list`)

      // Check the nested arguments now so a typo is reported to the model instead of becoming a failed job.
      try {
        const violations = validateJsonSchemaValue(found.parameters as never, targetArguments, 'arguments')
        if (violations.length > 0) return invalid(...violations.map(violation => `${target}: ${violation}`))
      } catch (error) {
        if (error instanceof ToolArgsError) throw error
        // An unsupported schema shape must not block the call; the nested execution validates again.
      }

      const owned = jobs.list(agent.id).filter(job => job.kind === JOB_KIND && (job.status === 'running' || job.status === 'stopping'))
      if (owned.length >= config.maxConcurrentJobs) {
        return invalid(`too many background tool jobs for this agent (${owned.length} of ${config.maxConcurrentJobs} running); wait for one to finish or stop one with job_kill`)
      }

      const callId = `${exec.callId}:bg` as typeof exec.callId
      const jobId: JobId = jobs.start({
        kind: JOB_KIND,
        label: `${target}: ${description}`,
        owner: agent.id,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
        ...config.outputLimitBytes === undefined ? {} : { outputLimitBytes: config.outputLimitBytes },
        run: (job): JobHooks => {
          const controller = new AbortController()
          live.add(controller)
          job.append(`[background] ${target}: ${description}\n`, { channel: 'log' })
          job.updateProgress(`running ${target}`)
          const done: Promise<JobOutcome> = (async (): Promise<JobOutcome> => {
            try {
              const result = await ctx.tools.execute({
                callId,
                rootCallId: exec.rootCallId ?? exec.callId,
                name: target,
                arguments: targetArguments,
                agent,
                signal: controller.signal,
              })
              return outcomeOf(result, controller.signal.aborted, config.maxResultChars)
            } catch (error) {
              // execute() resolves failures as results; a rejection means the pipeline itself broke.
              if (controller.signal.aborted) return { status: 'killed' }
              return { status: 'failed', detail: oneLine(error instanceof Error ? error.message : String(error)) || 'tool pipeline error' }
            } finally {
              live.delete(controller)
            }
          })()
          return {
            cancel: (reason?: string): void => { controller.abort(new Error(reason ?? 'background job killed')) },
            done,
          }
        },
      })
      return { kind: 'background' as const, jobId, tool: target, description }
    },
  })

  return {
    definition,
    abortAll(reason: string): void {
      for (const controller of [...live]) controller.abort(new Error(reason))
    },
  }
}
