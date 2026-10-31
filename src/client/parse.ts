/** Parsing of the two free-text settings; React-free so tests can import it. @module dsh-background/client/parse */

export const POLICIES = ['wait', 'background', 'interrupt'] as const

/** The tool policy object the text describes, or undefined when it is not a valid one. */
export function parseToolPolicies(text: string): Record<string, string> | undefined {
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.every(([, policy]) => typeof policy === 'string' && (POLICIES as readonly string[]).includes(policy))) return undefined
    return Object.fromEntries(entries) as Record<string, string>
  } catch { return undefined }
}

/** The delay the text describes: a positive whole number, `null` for empty (off), undefined when invalid. */
export function parseDelay(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 1 ? value : undefined
}
