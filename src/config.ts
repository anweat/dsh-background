/**
 * Plugin configuration. Edited in the Host's settings card or as `config:` of the `background` row in
 * `cordis.yml` / a profile patch; every field has a default, so no config is needed.
 * @module dsh-background/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Tools that already run in the background by themselves (they take `run_in_background`, or return an id at once
 * and report through the job runtime). Wrapping them again would only add a second layer of ids and notices, so
 * `background_run` refuses them and names the tool's own route. Names checked against DSH 0.2.1-rc.5:
 * `bash` / `pwsh` (`run_in_background`), `workflow` (`run_in_background`), `subagent` (returns the subagent id at
 * once), `terminal_open` (PTY job).
 */
export const DEFAULT_NATIVE_BACKGROUND_TOOLS: readonly string[] = ['bash', 'pwsh', 'workflow', 'subagent', 'terminal_open']

/** Tools that control or start jobs. They are never allowed as a target, whatever `denyTools` says. */
export const JOB_CONTROL_TOOLS: readonly string[] = ['job_output', 'job_list', 'job_kill']

export interface Config {
  /** Model-facing tool name to register (default `background_run`). */
  toolName?: string
  /** Longest result text stored with the job, in characters; longer text is cut with a notice (default 20000). */
  maxResultChars?: number
  /** Optional UTF-8 byte cap for each completion notice or `job_output` read of these jobs. Unset: no cap. */
  outputLimitBytes?: number
  /** Live background tool jobs allowed per agent at the same time (default 4). */
  maxConcurrentJobs?: number
  /** Tool names that may never be run in the background. */
  denyTools?: string[]
  /** Tools that background themselves; `background_run` refuses them and points at their own route. */
  nativeBackgroundTools?: string[]
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('background_run').description('Model-facing tool name.'),
  maxResultChars: z.natural().min(1).default(20_000).description('Longest stored result text, in characters.'),
  outputLimitBytes: z.natural().min(1).description('Optional UTF-8 byte cap for each completion notice or job_output read.'),
  maxConcurrentJobs: z.natural().min(1).default(4).description('Live background tool jobs allowed per agent.'),
  denyTools: z.array(z.string()).default([]).description('Tool names that may never run in the background.'),
  nativeBackgroundTools: z.array(z.string()).default([...DEFAULT_NATIVE_BACKGROUND_TOOLS]).description('Tools that background themselves; refused with a pointer to their own route.'),
})

/** Config after schema defaults. */
export interface ResolvedConfig {
  toolName: string
  maxResultChars: number
  outputLimitBytes: number | undefined
  maxConcurrentJobs: number
  denyTools: ReadonlySet<string>
  nativeBackgroundTools: ReadonlySet<string>
}

/** Fill defaults for a hand-built config (tests); the Loader already applies the schema. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    toolName: config.toolName ?? 'background_run',
    maxResultChars: config.maxResultChars ?? 20_000,
    outputLimitBytes: config.outputLimitBytes,
    maxConcurrentJobs: config.maxConcurrentJobs ?? 4,
    denyTools: new Set(config.denyTools ?? []),
    nativeBackgroundTools: new Set(config.nativeBackgroundTools ?? DEFAULT_NATIVE_BACKGROUND_TOOLS),
  }
}
