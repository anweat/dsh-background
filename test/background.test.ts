import test from 'node:test'
import assert from 'node:assert/strict'
import { resultText, rig, settle } from './harness.ts'

const run = (rigged: Awaited<ReturnType<typeof rig>>, args: Record<string, unknown>, options?: Parameters<typeof rigged.call>[2]) =>
  rigged.call('background_run', args, options)

test('starts the nested call as an owned job and answers at once', async () => {
  const r = await rig()
  try {
    const started = await run(r, { tool: 'slow', arguments: { label: 'a' }, description: 'wait for a' }, { callId: 'call-77' })
    assert.equal(started.isError, false)
    assert.equal(r.jobs.jobs.length, 1)
    const job = r.jobs.jobs[0]!
    assert.match(job.id, /^tool-/)
    assert.equal(resultText(started), `slow started in the background as job ${job.id} (wait for a). Its result arrives with the completion notice; check with job_output, stop with job_kill. Do not wait or poll unless you need the result now.`)
    assert.equal(job.spec.kind, 'tool')
    assert.equal(job.spec.label, 'slow: wait for a')
    assert.equal(job.spec.owner, 'sess-A')
    assert.deepEqual(job.spec.toolCall, { callId: 'call-77', rootCallId: 'call-77' })
    assert.equal(job.progress, 'running slow')
    assert.deepEqual(job.appended, [{ text: '[background] slow: wait for a\n', channel: 'log' }])
    assert.equal(job.status, 'running')
    // The nested call runs through the pipeline under its own id, owned by the same agent.
    await settle()
    assert.equal(r.probe.seen[0]!.callId, 'call-77:bg')
    assert.equal(r.probe.seen[0]!.rootCallId, 'call-77')
    assert.equal(r.probe.seen[0]!.agent, r.agent)
    r.probe.release('a')
    const done = await r.jobs.finished(job.id)
    assert.equal(done.status, 'completed')
    assert.equal(done.result, 'slow a done')
    assert.equal(done.detail, undefined)
  } finally { r.dispose() }
})

test('a nested root call id is kept when the background call is itself nested', async () => {
  const r = await rig()
  try {
    await r.tools.execute({ callId: 'inner-1', rootCallId: 'root-9', name: 'background_run', arguments: { tool: 'echo', arguments: { text: 'x' }, description: 'd' }, agent: r.agent, signal: new AbortController().signal })
    assert.deepEqual(r.jobs.jobs[0]!.spec.toolCall, { callId: 'inner-1', rootCallId: 'root-9' })
    await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.equal(r.probe.seen[0]!.rootCallId, 'root-9')
  } finally { r.dispose() }
})

test('the nested call is decoupled from the calling step signal', async () => {
  const r = await rig()
  try {
    const step = new AbortController()
    await run(r, { tool: 'slow', arguments: { label: 'b' }, description: 'b' }, { signal: step.signal })
    await settle()
    step.abort(new Error('user pressed stop'))
    await settle()
    assert.equal(r.probe.seen[0]!.signal.aborted, false, 'aborting the step must not abort the background call')
    assert.equal(r.jobs.jobs[0]!.status, 'running')
    r.probe.release('b')
    assert.equal((await r.jobs.finished(r.jobs.jobs[0]!.id)).status, 'completed')
  } finally { r.dispose() }
})

test('job_kill (cancel) aborts the nested call and the job settles killed', async () => {
  const r = await rig()
  try {
    await run(r, { tool: 'slow', arguments: { label: 'c' }, description: 'c' })
    const id = r.jobs.jobs[0]!.id
    assert.equal(r.jobs.kill(id, 'sess-A', 'not needed'), 'requested')
    const done = await r.jobs.finished(id)
    assert.equal(done.status, 'killed')
    assert.equal(done.result, undefined)
    assert.equal(r.probe.seen[0]!.signal.aborted, true)
    assert.equal(r.jobs.kill(id), 'already-finished')
  } finally { r.dispose() }
})

test('an error result becomes failed with a one-line detail and the whole error as result', async () => {
  const r = await rig()
  try {
    await run(r, { tool: 'boom', description: 'explode' })
    const done = await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.equal(done.status, 'failed')
    assert.equal(done.detail, 'boom exploded')
    assert.equal(done.result, 'Error: boom exploded\nsecond line')
  } finally { r.dispose() }
})

test('long results are cut at maxResultChars with a notice', async () => {
  const r = await rig({ maxResultChars: 50 })
  try {
    await run(r, { tool: 'big', arguments: { n: 120 }, description: 'big' })
    const done = await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.equal(done.status, 'completed')
    assert.equal(done.result, `${'x'.repeat(50)}\n… [truncated: 70 more characters]`)
  } finally { r.dispose() }
})

test('image blocks become [image] placeholders', async () => {
  const r = await rig()
  try {
    await run(r, { tool: 'pic', description: 'pic' })
    const done = await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.equal(done.result, 'caption\n[image]')
  } finally { r.dispose() }
})

test('outputLimitBytes is forwarded to the job spec only when set', async () => {
  const unset = await rig()
  const set = await rig({ outputLimitBytes: 4096 })
  try {
    await run(unset, { tool: 'echo', arguments: { text: 'x' }, description: 'd' })
    await run(set, { tool: 'echo', arguments: { text: 'x' }, description: 'd' })
    assert.equal('outputLimitBytes' in unset.jobs.jobs[0]!.spec, false)
    assert.equal(set.jobs.jobs[0]!.spec.outputLimitBytes, 4096)
  } finally { unset.dispose(); set.dispose() }
})

test('a tool omitting arguments runs with an empty object', async () => {
  const r = await rig()
  try {
    await run(r, { tool: 'boom', description: 'no args' })
    assert.equal(r.jobs.jobs.length, 1)
  } finally { r.dispose() }
})

// --- preflight refusals: INVALID_ARGS, no job registered -----------------------------------------------------

async function refused(r: Awaited<ReturnType<typeof rig>>, args: Record<string, unknown>, pattern: RegExp, options?: Parameters<typeof r.call>[2]): Promise<void> {
  const result = await run(r, args, options)
  assert.equal(result.isError, true, resultText(result))
  assert.equal(result.error.info?.code, 'INVALID_ARGS')
  assert.match(resultText(result), pattern)
  assert.equal(r.jobs.jobs.length, 0, 'a refusal must not register a job')
}

test('refuses a call without a calling agent', async () => {
  const r = await rig()
  try { await refused(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' }, /calling agent/, { agent: undefined }) } finally { r.dispose() }
})

test('refuses when no job registry is loaded and names the missing piece', async () => {
  const r = await rig({}, { withJobs: false })
  try { await refused(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' }, /dsh-jobs-local.*dsh-tool-jobs/) } finally { r.dispose() }
})

test('refuses unknown or invisible tools', async () => {
  const r = await rig()
  try { await refused(r, { tool: 'nope', description: 'd' }, /"nope" is not available to this agent/) } finally { r.dispose() }
})

test('refuses itself and the job tools, even when they are not registered', async () => {
  const r = await rig()
  try {
    await refused(r, { tool: 'background_run', description: 'd' }, /cannot run itself/)
    for (const name of ['job_output', 'job_list', 'job_kill']) await refused(r, { tool: name, description: 'd' }, /controls background jobs/)
  } finally { r.dispose() }
})

test('refuses a renamed tool referring to itself', async () => {
  const r = await rig({ toolName: 'bg' })
  try {
    const result = await r.call('bg', { tool: 'bg', description: 'd' })
    assert.equal(result.isError, true)
    assert.match(resultText(result), /cannot run itself/)
  } finally { r.dispose() }
})

test('refuses denyTools', async () => {
  const r = await rig({ denyTools: ['echo'] })
  try { await refused(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' }, /echo is not allowed to run in the background/) } finally { r.dispose() }
})

test('refuses tools with their own background mode and says which route to take', async () => {
  const r = await rig({ nativeBackgroundTools: ['bash', 'pwsh', 'workflow', 'subagent', 'terminal_open'] })
  try {
    await refused(r, { tool: 'bash', arguments: { command: 'ls' }, description: 'd' }, /bash has its own background mode.*run_in_background: true/)
    await refused(r, { tool: 'subagent', description: 'd' }, /subagent already runs in the background/)
    await refused(r, { tool: 'terminal_open', description: 'd' }, /terminal_open already runs in the background/)
    // detected from the target's own schema, not only from the list
    await refused(r, { tool: 'own_bg', description: 'd' }, /own_bg has its own background mode/)
  } finally { r.dispose() }
})

test('the native list is configurable', async () => {
  const r = await rig({ nativeBackgroundTools: ['echo'] })
  try { await refused(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' }, /echo has its own background mode/) } finally { r.dispose() }
})

test('refuses bad arguments for the target now, naming the tool', async () => {
  const r = await rig()
  try { await refused(r, { tool: 'echo', arguments: {}, description: 'd' }, /echo: .*text/) } finally { r.dispose() }
})

test('refuses an empty description or tool name', async () => {
  const r = await rig()
  try {
    await refused(r, { tool: 'echo', arguments: { text: 'x' }, description: '   ' }, /description must not be empty/)
    await refused(r, { tool: ' ', description: 'd' }, /tool must not be empty/)
  } finally { r.dispose() }
})

test('maxConcurrentJobs counts per owner and frees a slot when a job settles', async () => {
  const r = await rig({ maxConcurrentJobs: 2 })
  try {
    await run(r, { tool: 'slow', arguments: { label: '1' }, description: 'one' })
    await run(r, { tool: 'slow', arguments: { label: '2' }, description: 'two' })
    const third = await run(r, { tool: 'slow', arguments: { label: '3' }, description: 'three' })
    assert.equal(third.isError, true)
    assert.match(resultText(third), /too many background tool jobs for this agent \(2 of 2 running\)/)
    assert.equal(r.jobs.jobs.length, 2)
    // another owner has its own budget
    const other = await run(r, { tool: 'slow', arguments: { label: '4' }, description: 'four' }, { agent: { id: 'sess-B' } })
    assert.equal(other.isError, false)
    // a settled job frees its slot
    r.probe.release('1')
    await r.jobs.finished(r.jobs.jobs[0]!.id)
    const again = await run(r, { tool: 'slow', arguments: { label: '5' }, description: 'five' })
    assert.equal(again.isError, false)
    r.probe.release('2'); r.probe.release('4'); r.probe.release('5')
  } finally { r.dispose() }
})

test('a jobs.start failure (no controller serves the owner) surfaces as the tool error', async () => {
  const r = await rig()
  try {
    r.jobs.failNextStart = new Error('no job controller serves this owner')
    const result = await run(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' })
    assert.equal(result.isError, true)
    assert.match(resultText(result), /no job controller/)
  } finally { r.dispose() }
})

// --- approval and policy ---------------------------------------------------------------------------------------

test('a pre-execute denial of the nested call ends the job as failed with the reason', async () => {
  const r = await rig({}, {
    extra: ctx => ctx.on('tools/pre-execute', async (exec: any, next: any) => {
      const downstream = await next()
      return exec.name === 'echo' ? { kind: 'deny', reason: 'echo is forbidden here' } : downstream
    }),
  })
  try {
    const started = await run(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' })
    assert.equal(started.isError, false, 'the background_run call itself was allowed')
    const done = await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.equal(done.status, 'failed')
    assert.equal(done.detail, 'echo is forbidden here')
    assert.match(done.result!, /echo is forbidden here/)
  } finally { r.dispose() }
})

test('an ask with no approval channel (headless) is denied and the job fails with the reason', async () => {
  const r = await rig({}, {
    extra: ctx => ctx.on('tools/pre-execute', async (exec: any, next: any) => {
      const downstream = await next()
      return exec.name === 'echo' ? { kind: 'ask', reason: 'echo wants approval' } : downstream
    }),
  })
  try {
    await run(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' })
    const done = await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.equal(done.status, 'failed')
    assert.ok(done.detail && done.detail.length > 0)
    assert.equal(r.probe.seen.length, 0, 'the tool body never ran')
  } finally { r.dispose() }
})

test('the nested call passes through the same pre-execute hooks as a direct call, with the owning agent', async () => {
  const seenByHook: { name: string; callId: string; agent: unknown }[] = []
  const r = await rig({}, {
    extra: ctx => ctx.on('tools/pre-execute', async (exec: any, next: any) => {
      seenByHook.push({ name: exec.name, callId: exec.callId, agent: exec.agent })
      return next()
    }),
  })
  try {
    await run(r, { tool: 'echo', arguments: { text: 'x' }, description: 'd' }, { callId: 'c5' })
    await r.jobs.finished(r.jobs.jobs[0]!.id)
    assert.deepEqual(seenByHook.map(entry => [entry.name, entry.callId]), [['background_run', 'c5'], ['echo', 'c5:bg']])
    assert.equal(seenByHook[1]!.agent, r.agent)
  } finally { r.dispose() }
})

// --- lifecycle -------------------------------------------------------------------------------------------------

test('unloading the plugin (HMR) unregisters the tool and aborts live nested calls', async () => {
  const r = await rig()
  await run(r, { tool: 'slow', arguments: { label: 'u' }, description: 'u' })
  await settle()
  assert.ok(r.tools.get('background_run', r.agent))
  r.dispose()
  await settle()
  assert.equal(r.tools.get('background_run', r.agent), undefined)
  assert.equal(r.probe.seen[0]!.signal.aborted, true)
  assert.equal((await r.jobs.finished(r.jobs.jobs[0]!.id)).status, 'killed')
  // reloading registers it again
  const again = r.ctx.plugin((await import('../src/index.ts')) as never, {})
  await settle()
  assert.ok(r.tools.get('background_run', r.agent))
  again.dispose()
})

test('toolName renames the registered tool', async () => {
  const r = await rig({ toolName: 'run_later' })
  try {
    assert.ok(r.tools.get('run_later', r.agent))
    assert.equal(r.tools.get('background_run', r.agent), undefined)
  } finally { r.dispose() }
})
