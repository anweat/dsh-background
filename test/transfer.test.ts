import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { deliver, fakeAgent, resultText, rig, settle, text } from './harness.ts'
import { installSignalAccessor, installTransfer, interruptedText, summarizeArguments, transferPlaceholder } from '../src/transfer.ts'
import { resolveConfig } from '../src/config.ts'

const unhandled: unknown[] = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

const ON = { foregroundControl: true }

/** Start a call without awaiting it; `settled()` resolves with its result. */
function start(r: Awaited<ReturnType<typeof rig>>, name: string, args: unknown, options: Parameters<typeof r.call>[2] = {}) {
  const pending = r.call(name, args, options)
  return pending
}

test('transfer: the call is released at once with the placeholder; the real result reaches the job', async () => {
  const r = await rig(ON)
  try {
    const seenResults: { isError: boolean; text: string }[] = []
    r.ctx.on('tools/result', (exec: any, result: any) => { if (exec.name === 'slow') seenResults.push({ isError: result.isError, text: resultText(result) }) })
    const pending = start(r, 'slow', { label: 'a' }, { callId: 'c1' })
    await settle()
    const listed = r.ctx.backgroundTransfer.list('sess-A')
    assert.equal(listed.length, 1)
    assert.deepEqual([listed[0]!.callId, listed[0]!.tool, listed[0]!.state, listed[0]!.controllable], ['c1', 'slow', 'running', true])
    assert.equal(listed[0]!.summary, '{"label":"a"}')

    const moved = r.ctx.backgroundTransfer.transfer('c1')
    assert.equal(moved.ok, true)
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(result.error.info.code, 'MOVED_TO_BACKGROUND')
    assert.equal(resultText(result), transferPlaceholder('slow', moved.jobId))
    assert.match(resultText(result), /^Not a failure, do not retry: slow was moved to the background as job tool-\d+ at the user's request; a completion notice arrives when it finishes, read the result with job_output\.$/)

    const job = r.jobs.jobs[0]!
    assert.equal(job.id, moved.jobId)
    assert.equal(job.spec.kind, 'tool')
    assert.equal(job.spec.owner, 'sess-A')
    assert.equal(job.spec.label, 'slow: {"label":"a"}')
    assert.deepEqual(job.spec.toolCall, { callId: 'c1', rootCallId: 'c1' })
    assert.equal(job.status, 'running')
    assert.equal(r.ctx.backgroundTransfer.list('sess-A').length, 0, 'a transferred call is no longer foreground')
    assert.equal(r.probe.seen[0]!.signal.aborted, false)

    // the abandoned next() settles after the call was answered: the real result must reach the job, not throw
    r.probe.release('a')
    const done = await r.jobs.finished(job.id)
    assert.equal(done.status, 'completed')
    assert.equal(done.result, 'slow a done')
    await settle(30)
    assert.deepEqual(seenResults, [{ isError: true, text: transferPlaceholder('slow', moved.jobId) }], 'tools/result fires once, for the placeholder')
    assert.deepEqual(unhandled, [])
  } finally { r.dispose() }
})

test('transfer: killing the job aborts the still-running tool', async () => {
  const r = await rig(ON)
  try {
    const pending = start(r, 'slow', { label: 'k' }, { callId: 'ck' })
    await settle()
    const moved = r.ctx.backgroundTransfer.transfer('ck')
    await pending
    r.jobs.kill(moved.jobId, 'sess-A', 'enough')
    const done = await r.jobs.finished(moved.jobId)
    assert.equal(done.status, 'killed')
    assert.equal(r.probe.seen[0]!.signal.aborted, true)
    assert.deepEqual(unhandled, [])
  } finally { r.dispose() }
})

test('transfer: a failing tool becomes a failed job', async () => {
  const r = await rig(ON)
  try {
    r.ctx.tools.register(defineTool({
      name: 'slow_fail', description: 'x', parameters: {}, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => text(v) },
      async execute() { await new Promise(resolve => setTimeout(resolve, 60)); throw new Error('late failure') },
    }))
    const pending = start(r, 'slow_fail', {}, { callId: 'cf' })
    await settle()
    const moved = r.ctx.backgroundTransfer.transfer('cf')
    await pending
    const done = await r.jobs.finished(moved.jobId)
    assert.equal(done.status, 'failed')
    assert.equal(done.detail, 'late failure')
  } finally { r.dispose() }
})

test('interrupt: only the tool is cancelled, the caller signal stays alive, the result is ABORTED', async () => {
  const r = await rig(ON)
  try {
    const turn = new AbortController()
    const pending = start(r, 'slow', { label: 'i' }, { callId: 'ci', signal: turn.signal })
    await settle()
    assert.deepEqual(r.ctx.backgroundTransfer.interrupt('ci'), { ok: true })
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(result.error.info.code, 'ABORTED')
    assert.equal(resultText(result), interruptedText('slow'))
    assert.equal(r.probe.seen[0]!.signal.aborted, true)
    assert.equal(turn.signal.aborted, false, 'the turn signal is not touched')
    assert.equal(r.jobs.jobs.length, 0, 'an interrupt registers no job')
    assert.equal(r.ctx.backgroundTransfer.list().length, 0)
  } finally { r.dispose() }
})

test('interrupt: a tool that ignores the signal is released after the grace period', async () => {
  const r = await rig({ ...ON, interruptGraceMs: 40 })
  try {
    let finished = false
    r.ctx.tools.register(defineTool({
      name: 'stubborn', description: 'x', parameters: {}, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => text(v) },
      async execute() { await new Promise(resolve => setTimeout(resolve, 200)); finished = true; return 'late' },
    }))
    const started = Date.now()
    const pending = start(r, 'stubborn', {}, { callId: 'cs' })
    await settle()
    r.ctx.backgroundTransfer.interrupt('cs')
    const result = await pending
    assert.ok(Date.now() - started < 150, 'released before the tool finished')
    assert.equal(finished, false)
    assert.match(resultText(result), /had not stopped yet/)
    assert.equal(result.error.info.code, 'ABORTED')
    await settle(250)
    assert.equal(finished, true)
    assert.deepEqual(unhandled, [], 'the late completion of the released body does not throw')
  } finally { r.dispose() }
})

test('a call that finishes normally is untouched and leaves the table', async () => {
  const r = await rig(ON)
  try {
    const result = await start(r, 'echo', { text: 'hello' })
    assert.equal(result.isError, false)
    assert.equal(resultText(result), 'hello')
    assert.equal(r.ctx.backgroundTransfer.list().length, 0)
    assert.deepEqual(r.ctx.backgroundTransfer.transfer('nope'), { ok: false, reason: 'no running call nope' })
    assert.deepEqual(r.ctx.backgroundTransfer.interrupt('nope'), { ok: false, reason: 'no running call nope' })
  } finally { r.dispose() }
})

test('excluded tools are not tracked: background_run, job tools, denyTools, native background tools', async () => {
  const r = await rig({ ...ON, denyTools: ['slow'], nativeBackgroundTools: ['echo'] })
  try {
    const hold = start(r, 'slow', { label: 'd' }, { callId: 'cd' })
    await settle()
    assert.equal(r.ctx.backgroundTransfer.list().length, 0, 'denyTools')
    r.probe.release('d'); await hold
    await start(r, 'echo', { text: 'x' })
    const bg = await r.call('background_run', { tool: 'boom', description: 'd' })
    assert.equal(bg.isError, false)
    assert.equal(r.ctx.backgroundTransfer.list().length, 0)
  } finally { r.dispose() }
})

test('transfer refuses and the call keeps running when the job cannot be registered', async () => {
  const r = await rig(ON)
  try {
    const pending = start(r, 'slow', { label: 'f' }, { callId: 'cf2' })
    await settle()
    r.jobs.failNextStart = new Error('no job controller serves this owner')
    assert.deepEqual(r.ctx.backgroundTransfer.transfer('cf2'), { ok: false, reason: 'no job controller serves this owner' })
    assert.equal(r.ctx.backgroundTransfer.list()[0]!.state, 'running')
    r.probe.release('f')
    const result = await pending
    assert.equal(result.isError, false)
    assert.equal(resultText(result), 'slow f done')
  } finally { r.dispose() }
})

test('transfer refuses without a jobs service and over maxConcurrentJobs', async () => {
  const none = await rig(ON, { withJobs: false })
  try {
    const pending = start(none, 'slow', { label: 'n' }, { callId: 'cn' })
    await settle()
    const result = none.ctx.backgroundTransfer.transfer('cn')
    assert.equal(result.ok, false)
    assert.match(result.reason, /dsh-jobs-local.*dsh-tool-jobs/)
    none.probe.release('n'); await pending
  } finally { none.dispose() }
  const capped = await rig({ ...ON, maxConcurrentJobs: 1 })
  try {
    const first = start(capped, 'slow', { label: '1' }, { callId: 'c-1' })
    const second = start(capped, 'slow', { label: '2' }, { callId: 'c-2' })
    await settle()
    assert.equal(capped.ctx.backgroundTransfer.transfer('c-1').ok, true)
    const refused = capped.ctx.backgroundTransfer.transfer('c-2')
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /too many background tool jobs/)
    await first
    capped.probe.release('2'); await second; capped.probe.release('1')
  } finally { capped.dispose() }
})

test('fail safe: if exec.signal cannot become an accessor the transfer is refused and the call finishes in the foreground', async () => {
  const r = await rig(ON, {
    extra: (ctx) => ctx.on('tools/execute', async (exec: any, next: any) => {
      // an outer wrapper that pins the property the way a different host version might
      Object.defineProperty(exec, 'signal', { value: exec.signal, writable: true, enumerable: true, configurable: false })
      return next()
    }, true),
  })
  try {
    const pending = start(r, 'slow', { label: 'p' }, { callId: 'cp' })
    await settle()
    const view = r.ctx.backgroundTransfer.list()
    assert.equal(view.length, 1)
    const refused = r.ctx.backgroundTransfer.transfer('cp')
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /does not allow detaching/)
    assert.equal(r.jobs.jobs.length, 0)
    r.probe.release('p')
    assert.equal(resultText(await pending), 'slow p done')
  } finally { r.dispose() }
})

test('installSignalAccessor: assignment after Object.freeze goes to the setter instead of throwing', () => {
  const plain: any = { signal: 1 }
  assert.throws(() => { Object.freeze(plain); 'use strict'; plain.signal = 2 }, TypeError)
  const exec: any = { signal: 1 }
  assert.equal(installSignalAccessor(exec), true)
  Object.freeze(exec)
  exec.signal = 2
  assert.equal(exec.signal, 2)
  assert.equal(installSignalAccessor(exec), true, 'idempotent')
  assert.equal(installSignalAccessor(Object.freeze({ signal: 1 })), false)
  assert.equal(installSignalAccessor({}), false)
})

test('summarizeArguments is compact and bounded', () => {
  assert.equal(summarizeArguments({}), '')
  assert.equal(summarizeArguments({ a: 1 }), '{"a":1}')
  assert.equal(summarizeArguments({ a: 'x'.repeat(200) }).length, 80)
})

// --- triggers ----------------------------------------------------------------------------------------------------

test('inbox trigger: a user steering message moves the running tool to the background (policy background)', async () => {
  const agent = fakeAgent('sess-A')
  const r = await rig({ ...ON, onUserMessageWhileToolRuns: 'background' })
  try {
    const pending = start(r, 'slow', { label: 't' }, { callId: 'ct', agent })
    await settle()
    // not triggers: a completion notice, a plugin injection, a user follow-up (next-turn)
    deliver(r.ctx, agent, { kind: 'tool-jobs', form: 'notice', summary: 'x' })
    deliver(r.ctx, agent, { kind: 'system-prompt' })
    deliver(r.ctx, agent, { kind: 'user' }, 'nextTurn')
    await settle()
    assert.equal(r.jobs.jobs.length, 0)
    assert.equal(r.ctx.backgroundTransfer.list()[0]!.state, 'running')
    // trigger: user message in next-step
    deliver(r.ctx, agent, { kind: 'user', rpcId: 'rpc-1' })
    const result = await pending
    assert.equal(result.error.info.code, 'MOVED_TO_BACKGROUND')
    assert.equal(r.jobs.jobs.length, 1)
    r.probe.release('t')
    assert.equal((await r.jobs.finished(r.jobs.jobs[0]!.id)).result, 'slow t done')
  } finally { r.dispose() }
})

test('inbox trigger: policy interrupt cancels just the tool; policy wait (default) does nothing', async () => {
  const agent = fakeAgent('sess-A')
  const intr = await rig({ ...ON, onUserMessageWhileToolRuns: 'interrupt' })
  try {
    const turn = new AbortController()
    const pending = start(intr, 'slow', { label: 'u' }, { callId: 'cu', agent, signal: turn.signal })
    await settle()
    deliver(intr.ctx, agent, { kind: 'user' })
    const result = await pending
    assert.equal(result.error.info.code, 'ABORTED')
    assert.equal(turn.signal.aborted, false)
  } finally { intr.dispose() }
  const wait = await rig(ON)
  try {
    const pending = start(wait, 'slow', { label: 'w' }, { callId: 'cw', agent })
    await settle()
    deliver(wait.ctx, agent, { kind: 'user' })
    await settle()
    assert.equal(wait.ctx.backgroundTransfer.list()[0]!.state, 'running')
    wait.probe.release('w')
    assert.equal(resultText(await pending), 'slow w done')
  } finally { wait.dispose() }
})

test('policies: toolPolicies override, waitOnlyTools default, and parallel calls are handled one by one', async () => {
  const agent = fakeAgent('sess-A')
  const r = await rig({ ...ON, onUserMessageWhileToolRuns: 'background', toolPolicies: { heavy: 'interrupt' }, waitOnlyTools: ['slow'] })
  try {
    r.ctx.tools.register(defineTool({
      name: 'slow2', description: 'x', parameters: { label: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => text(v) },
      async execute(args, exec) { await new Promise<void>((resolve, reject) => { r.probe.gates.set(args.label, resolve); exec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }); return `slow2 ${args.label} done` },
    }))
    r.ctx.tools.register(defineTool({
      name: 'heavy', description: 'x', parameters: { label: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => text(v) },
      async execute(args, exec) { await new Promise<void>((resolve, reject) => { r.probe.gates.set(args.label, resolve); exec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }); return 'big done' },
    }))
    const a = start(r, 'slow', { label: 'A' }, { callId: 'pa', agent })    // waitOnly -> keeps running
    const b = start(r, 'slow2', { label: 'B' }, { callId: 'pb', agent })   // global background
    const c = start(r, 'heavy', { label: 'C' }, { callId: 'pc', agent })     // toolPolicies: interrupt
    await settle()
    deliver(r.ctx, agent, { kind: 'user' })
    const [rb, rc] = await Promise.all([b, c])
    assert.equal(rb.error.info.code, 'MOVED_TO_BACKGROUND')
    assert.equal(rc.error.info.code, 'ABORTED')
    assert.equal(r.ctx.backgroundTransfer.list()[0]!.tool, 'slow', 'the wait-only tool is still running in the foreground')
    r.probe.release('A')
    assert.equal(resultText(await a), 'slow A done')
    r.probe.release('B')
    assert.equal((await r.jobs.finished(r.jobs.jobs[0]!.id)).result, 'slow2 B done')
  } finally { r.dispose() }
})

test('default wait-only tools are not moved even under policy background', async () => {
  const agent = fakeAgent('sess-A')
  const r = await rig({ ...ON, onUserMessageWhileToolRuns: 'background' })
  try {
    r.ctx.tools.register(defineTool({
      name: 'write', description: 'x', parameters: {}, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => text(v) },
      async execute() { await new Promise(resolve => setTimeout(resolve, 80)); return 'written' },
    }))
    const pending = start(r, 'write', {}, { callId: 'cwr', agent })
    await settle()
    deliver(r.ctx, agent, { kind: 'user' })
    assert.equal(resultText(await pending), 'written')
    assert.equal(r.jobs.jobs.length, 0)
  } finally { r.dispose() }
})

test('autoBackgroundAfterMs moves a long call; a per-tool 0 disables it', async () => {
  const r = await rig({ ...ON, autoBackgroundAfterMs: 50, toolAutoBackgroundMs: { echo2: 0 } })
  try {
    r.ctx.tools.register(defineTool({
      name: 'echo2', description: 'x', parameters: {}, output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => text(v) },
      async execute() { await new Promise(resolve => setTimeout(resolve, 150)); return 'echo2 done' },
    }))
    const long = await start(r, 'slow', { label: 'z' }, { callId: 'cz' })
    assert.equal(long.error.info.code, 'MOVED_TO_BACKGROUND')
    assert.match(resultText(long), /^Not a failure, do not retry: slow was moved to the background as job tool-\d+ because it ran longer than 0 seconds; /)
    assert.equal(r.jobs.jobs.length, 1)
    assert.equal(resultText(await start(r, 'echo2', {})), 'echo2 done')
    assert.equal(r.jobs.jobs.length, 1)
    r.probe.release('z')
  } finally { r.dispose() }
})

test('foregroundControl off: no wrapper, no service', async () => {
  const r = await rig({})
  try {
    assert.equal(r.ctx.backgroundTransfer, undefined)
    const pending = start(r, 'slow', { label: 'o' })
    await settle()
    r.probe.release('o')
    assert.equal(resultText(await pending), 'slow o done')
  } finally { r.dispose() }
})

test('version gate: an unverified host version turns transfer off unless allowUnverifiedHost', async () => {
  for (const [allow, expected] of [[false, false], [true, true]] as const) {
    const r = await rig({})
    try {
      const ctx = r.ctx as Context & { backgroundTransfer?: unknown }
      const hub = installTransfer(ctx, resolveConfig({ foregroundControl: true, allowUnverifiedHost: allow }), { hostVersion: '0.9.9' })
      const pending = r.call('slow', { label: 'g' }, { callId: 'cg' })
      await settle()
      const view = hub.api.list()[0]!
      assert.equal(view.controllable, expected)
      const result = hub.api.transfer('cg')
      assert.equal(result.ok, expected)
      if (!expected) assert.match((result as { reason: string }).reason, /not verified/)
      r.probe.release('g')
      await pending
      await settle(30)
    } finally { r.dispose() }
  }
})

test('unloading the plugin aborts calls it moved to the background', async () => {
  const r = await rig(ON)
  const pending = start(r, 'slow', { label: 'x' }, { callId: 'cx' })
  await settle()
  const moved = r.ctx.backgroundTransfer.transfer('cx')
  await pending
  r.dispose()
  const done = await r.jobs.finished(moved.jobId)
  assert.equal(done.status, 'killed')
})

test('R3: a user stop (caller signal) after the transfer still ends the tool; the job settles killed with the reason', async () => {
  const r = await rig(ON)
  try {
    const turn = new AbortController()
    const pending = start(r, 'slow', { label: 's' }, { callId: 'cstop', signal: turn.signal })
    await settle()
    const moved = r.ctx.backgroundTransfer.transfer('cstop')
    await pending
    turn.abort(new Error('user pressed stop'))
    const done = await r.jobs.finished(moved.jobId)
    assert.equal(done.status, 'killed')
    assert.equal(done.detail, 'stopped together with the turn (user stop)')
    assert.equal(r.probe.seen[0]!.signal.aborted, true)
  } finally { r.dispose() }
})
