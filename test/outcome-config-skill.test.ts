import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Config, DEFAULT_NATIVE_BACKGROUND_TOOLS, resolveConfig } from '../src/config.ts'
import { contentText, oneLine, outcomeOf, truncate } from '../src/outcome.ts'
import { SKILL_DIR, SKILL_NAME, createSkillProvider, parseSkillFile, readSkill } from '../src/skill.ts'
import { rig, settle } from './harness.ts'

test('outcomeOf maps success, error and abort', () => {
  const ok = { isError: false, value: 'v', content: [{ type: 'text', text: 'hello' }] } as never
  assert.deepEqual(outcomeOf(ok, false, 100), { status: 'completed', result: 'hello' })
  assert.deepEqual(outcomeOf(ok, true, 100), { status: 'killed' })
  const empty = { isError: false, value: '', content: [] } as never
  assert.deepEqual(outcomeOf(empty, false, 100), { status: 'completed', result: '(the tool returned no text)' })
  const bad = { isError: true, error: { message: '  first line \nsecond' }, content: [{ type: 'text', text: 'Error: first line \nsecond' }] } as never
  assert.deepEqual(outcomeOf(bad, false, 100), { status: 'failed', detail: 'first line', result: 'Error: first line \nsecond' })
  const aborted = { isError: true, error: { message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } }, content: [{ type: 'text', text: 'Error: tool call aborted' }] } as never
  assert.deepEqual(outcomeOf(aborted, true, 100), { status: 'killed' })
  assert.equal(outcomeOf(aborted, false, 100).status, 'failed', 'an abort this plugin did not request is a failure, not a kill')
})

test('helpers: contentText, truncate, oneLine', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'file' }, { type: 'text', text: 'b' }]), 'a\n[image]\n[file]\nb')
  assert.equal(truncate('abcdef', 6), 'abcdef')
  assert.equal(truncate('abcdef', 4), 'abcd\n… [truncated: 2 more characters]')
  assert.equal(oneLine('\n  \n x \ny'), 'x')
  assert.equal(oneLine('y'.repeat(300)).length, 201)
})

test('Config schema defaults', () => {
  const resolved = Config({}) as Required<{ [K in keyof ReturnType<typeof Config>]: unknown }>
  assert.equal(resolved.toolName, 'background_run')
  assert.equal(resolved.maxResultChars, 20000)
  assert.equal(resolved.maxConcurrentJobs, 4)
  assert.deepEqual(resolved.denyTools, [])
  assert.deepEqual(resolved.nativeBackgroundTools, [...DEFAULT_NATIVE_BACKGROUND_TOOLS])
  assert.equal(resolved.outputLimitBytes, undefined)
  assert.throws(() => Config({ maxConcurrentJobs: 0 }))
  const r = resolveConfig({})
  assert.equal(r.toolName, 'background_run')
  assert.ok(r.nativeBackgroundTools.has('bash') && r.nativeBackgroundTools.has('subagent'))
})

test('the skill is packaged and well-formed', () => {
  assert.ok(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')))
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] }
  assert.ok(pkg.files.includes('assets'))
  const skill = readSkill()
  assert.equal(skill.name, SKILL_NAME)
  assert.match(skill.description, /background_run/)
  assert.ok(skill.body.length < 4000, `skill body is ${skill.body.length} chars`)
  assert.throws(() => parseSkillFile('no front matter'), /front matter/)
  // every tool name the skill mentions must exist in the Host: only these may appear in backticks as calls
  for (const name of ['background_run', 'job_output', 'job_list', 'job_kill', 'bash', 'pwsh', 'workflow', 'subagent', 'terminal_open', 'web_fetch']) assert.ok(skill.body.includes(name), name)
})

test('the skill provider lists and loads the packaged skill', async () => {
  const provider = createSkillProvider()
  const listed = await provider.list()
  assert.equal(listed[0]!.name, 'dsh-background')
  const loaded = await provider.get()
  assert.match(loaded.content, /background_run\(tool, arguments, description\)/)
})

test('the skill and the prompt section are registered only when their services exist', async () => {
  const registered: unknown[] = []
  const withSkills = await rig({}, { extra: ctx => ctx.provide('skills', { registerProvider(create: (c: unknown) => unknown) { registered.push(create({ invalidate() {} })); return () => {} } }) })
  try {
    assert.equal(registered.length, 1)
    assert.equal((registered[0] as { name: string }).name, 'dsh-background')
  } finally { withSkills.dispose() }
  // no skills service: the plugin still loads and registers its tool
  const bare = await rig()
  try { assert.ok(bare.tools.get('background_run', bare.agent)) } finally { bare.dispose() }
})

test('the system prompt section is one short paragraph naming the skill', async () => {
  const ctx = new Context() as any
  ctx.plugin(SystemPrompt as never)
  await settle()
  const sections: { name: string; order: number; text: string }[] = []
  const real = ctx.systemPrompt.section.bind(ctx.systemPrompt)
  ctx.systemPrompt.section = (section: any) => { sections.push(section); return real(section) }
  ctx.provide('tools', { register() { return () => {} } })
  const plugin = await import('../src/index.ts')
  const fiber = ctx.plugin(plugin as never, {})
  await settle()
  try {
    assert.equal(sections.length, 1)
    assert.equal(sections[0]!.name, 'tool:background_run')
    assert.ok(sections[0]!.text.length < 400, `${sections[0]!.text.length} chars`)
    assert.match(sections[0]!.text, /dsh-background skill/)
    assert.equal(sections[0]!.order, ctx.systemPrompt.getSectionOrder('TOOL_JOBS') + 5)
    assert.doesNotMatch(sections[0]!.text, /\{\{/)
  } finally { fiber.dispose() }
})
