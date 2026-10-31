/**
 * The bundled `dsh-background` skill: when and how to use `background_run`.
 *
 * Registered with the Host's skill registry only when that service exists. It is never a declared `inject`: Cordis
 * treats every declared inject as required, so a Host without skills would leave the whole plugin pending. The
 * plugin asks through a scoped, optional `ctx.inject(['skills'], …)` instead.
 * @module dsh-background/skill
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

export const SKILL_NAME = 'dsh-background'
/** Same rank the Host gives packaged skills (`BUNDLED_SKILL_RANK`). */
const BUNDLED_SKILL_RANK = 600

/** `assets/skills/dsh-background/`, resolved next to `src/` or the built `lib/`. */
export const SKILL_DIR = fileURLToPath(new URL('../assets/skills/dsh-background/', import.meta.url))

/** Split a SKILL.md into its front matter fields and body. */
export function parseSkillFile(raw: string): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('SKILL.md is missing its front matter')
  const field = (key: string): string => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(match[1]!)
    return line ? line[1]!.trim().replace(/^["']|["']$/g, '') : ''
  }
  return { name: field('name'), description: field('description'), body: match[2]!.replace(/^\s+/, '') }
}

export function readSkill(dir = SKILL_DIR): { name: string; description: string; body: string } {
  return parseSkillFile(fs.readFileSync(dir + 'SKILL.md', 'utf8'))
}

/** A provider shaped like the Host's `SkillProvider` (declared locally to avoid a build-time dependency). */
export function createSkillProvider(dir = SKILL_DIR) {
  const resourceBase = { kind: 'directory' as const, path: dir }
  const invocation = { modelInvocable: true, userInvocable: true }
  readSkill(dir) // fail at creation when the packaged file is missing or malformed
  return {
    name: SKILL_NAME,
    list: async () => {
      const skill = readSkill(dir)
      return [{ name: skill.name, description: skill.description, invocation, provider: SKILL_NAME, source: 'bundled', resourceBase, rank: BUNDLED_SKILL_RANK, locator: dir + 'SKILL.md' }]
    },
    get: async () => {
      const skill = readSkill(dir)
      return { name: skill.name, description: skill.description, invocation, provider: SKILL_NAME, source: 'bundled', resourceBase, content: skill.body }
    },
  }
}

/** Register the skill when the Host provides a skill registry; returns whether that happened (live). */
export function registerSkillWhenAvailable(ctx: Context, dir = SKILL_DIR): { isAvailable: () => boolean } {
  let available = false
  ;(ctx as any).inject(['skills'], (skillCtx: any) => {
    let provider: ReturnType<typeof createSkillProvider>
    try { provider = createSkillProvider(dir) } catch (error) {
      skillCtx.logger?.(SKILL_NAME)?.warn?.('dsh-background skill not registered: ' + String(error))
      return
    }
    skillCtx.skills.registerProvider(() => provider)
    available = true
    skillCtx.effect(() => () => { available = false })
  })
  return { isAvailable: () => available }
}
