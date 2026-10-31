/**
 * dsh-background — run any tool call as a background job.
 *
 * Adds one tool, `background_run`. The host already owns everything around it: the job registry (`ctx.jobs`), the
 * `job_output` / `job_list` / `job_kill` tools and the completion notice (`dsh-tool-jobs`).
 * @module dsh-background
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig } from './config.ts'
import { createBackgroundTool } from './tool.ts'
import { registerSkillWhenAvailable } from './skill.ts'

export const name = 'dsh-background'
// Only `tools` is required. `jobs` is read with ctx.get() at call time (the call then fails with the missing piece
// named), and the skill / system prompt are optional scoped injections, so a smaller composition still loads.
export const inject = ['tools']

export { Config }
export type { Config as BackgroundConfig } from './config.ts'

/** One short sentence in the system prompt; the details live in the skill. */
function promptText(toolName: string): string {
  return `${toolName}(tool, arguments, description) runs one other tool call in the background and returns a job id at once; a completion notice tells you when it is done, then read the result with job_output. `
    + 'Use it for a slow call you do not need yet, so the user can keep talking to you; otherwise call the tool directly. See the dsh-background skill.'
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const tool = createBackgroundTool(ctx, resolved)
  // Registered under this plugin's context, so unloading the plugin (HMR, disable) unregisters the tool.
  ctx.tools.register(tool.definition)
  // Work that outlives the call must not outlive the code: unloading aborts every live nested call.
  ctx.effect(() => () => tool.abortAll('dsh-background was unloaded'))

  registerSkillWhenAvailable(ctx)
  ;(ctx as any).inject(['systemPrompt'], (promptCtx: any) => {
    const order = promptCtx.systemPrompt.getSectionOrder?.('TOOL_JOBS')
    promptCtx.systemPrompt.section({
      name: `tool:${resolved.toolName}`,
      order: typeof order === 'number' ? order + 5 : 1605,
      text: promptText(resolved.toolName),
    })
  })
}
