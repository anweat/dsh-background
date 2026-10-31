/**
 * Mapping from a finished nested tool call onto the job vocabulary.
 * @module dsh-background/outcome
 */

import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Longest one-line terminal detail kept for a failed job. */
const DETAIL_LIMIT = 200

/** Text of a nested result: text blocks joined by newlines, every other block as a short placeholder. */
export function contentText(content: readonly { type: string; text?: string }[]): string {
  return content
    .map(block => block.type === 'text' ? (block.text ?? '') : block.type === 'image' ? '[image]' : `[${block.type}]`)
    .join('\n')
}

/** Cut `text` to `max` characters and say how much was dropped. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters]`
}

/** First non-empty line of `text`, cut to {@link DETAIL_LIMIT} characters. */
export function oneLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? ''
  return line.length <= DETAIL_LIMIT ? line : `${line.slice(0, DETAIL_LIMIT)}…`
}

/**
 * Map a nested result to the job outcome.
 * - success: `completed`, `result` is the result text (capped at `maxChars`; an empty text becomes a marker so the
 *   completion read is never blank);
 * - error while this plugin's own controller was aborted (`job_kill`, owner teardown, plugin unload): `killed`;
 * - any other error: `failed`, with the first line of the message as `detail` and the whole error text as `result`.
 * @param result - what `ctx.tools.execute` resolved with.
 * @param aborted - whether the job's own abort controller fired.
 * @param maxChars - result cap in characters.
 */
export function outcomeOf(result: ToolExecutionResult, aborted: boolean, maxChars: number): JobOutcome {
  if (aborted) return { status: 'killed' }
  const text = contentText(result.content)
  if (!result.isError) {
    return { status: 'completed', result: truncate(text.length > 0 ? text : '(the tool returned no text)', maxChars) }
  }
  const message = result.error.message
  return {
    status: 'failed',
    detail: oneLine(message.length > 0 ? message : text) || 'tool call failed',
    result: truncate(text.length > 0 ? text : `Error: ${message}`, maxChars),
  }
}
