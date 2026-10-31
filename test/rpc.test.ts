import test from 'node:test'
import assert from 'node:assert/strict'
import { rig, settle, resultText } from './harness.ts'
import { RPC_CHANNEL } from '../src/rpc-types.ts'
import { createHandler } from '../src/rpc.ts'

type Call = (endpoint: string, payload: unknown, principal?: string) => Promise<any>

/** A rig whose Context has a fake Host connection: the plugin registers its channel there and the test calls it. */
async function rpcRig(config: Record<string, unknown> = { foregroundControl: true }, sessions: string[] = ['sess-A', 'sess-B']) {
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal, peer: any) => Promise<any>) | undefined
  let channel: string | undefined
  let disposed = false
  const known = new Map(sessions.map(id => [id, { id }]))
  const r = await rig(config, {
    extra: (ctx) => {
      ctx.provide('connection', { rpc: { handle(name: string, h: any) { channel = name; handler = h; return async () => { disposed = true } } } })
      ctx.provide('webServer', {})
      ctx.provide('agents', { get: (id: string) => known.get(id) })
    },
  })
  const call: Call = (endpoint, payload, principal = 'owner') => handler!(endpoint, payload, new AbortController().signal, { principal: { kind: principal } })
  return { r, call, channel: () => channel, disposed: () => disposed, known }
}

test('the plugin registers its private channel with the Host connection and unregisters it on unload', async () => {
  const { r, channel, disposed } = await rpcRig()
  assert.equal(channel(), RPC_CHANNEL)
  assert.equal(RPC_CHANNEL, '/dsh-background')
  r.dispose()
  await settle()
  assert.equal(disposed(), true)
})

test('without a Host connection nothing is registered and the plugin still loads', async () => {
  const r = await rig({ foregroundControl: true })
  try { assert.ok(r.tools.get('background_run', r.agent)) } finally { r.dispose() }
})

test('status: enabled when foreground control is on; off or gated otherwise', async () => {
  const on = await rpcRig({ foregroundControl: true, onUserMessageWhileToolRuns: 'background' })
  try {
    const status = (await on.call('status', {})).value
    assert.equal(status.foregroundControl, true)
    assert.equal(status.enabled, true)
    assert.equal(status.defaultPolicy, 'background')
    assert.match(status.hostVersion, /^0\.2\./)
    assert.ok(status.verifiedVersions.includes('0.2.1-rc.5'))
  } finally { on.r.dispose() }
  const off = await rpcRig({})
  try {
    const status = (await off.call('status', {})).value
    assert.deepEqual([status.foregroundControl, status.enabled, status.defaultPolicy], [false, false, 'wait'])
  } finally { off.r.dispose() }
})

test('status on a gated host (hub reports disabled)', async () => {
  const handler = createHandler({
    foregroundControl: true, defaultPolicy: 'wait', jobs: () => undefined, agent: () => undefined,
    hub: { api: { status: () => ({ enabled: false, hostVersion: '9.9.9', verifiedVersions: ['0.2.1-rc.5'] }) } as never, policyFor: () => 'wait' },
  })
  const status = (await handler('status', {}, new AbortController().signal, { principal: { kind: 'owner' } })).value as any
  assert.deepEqual([status.foregroundControl, status.enabled, status.hostVersion], [true, false, '9.9.9'])
})

test('only the owner principal may use the channel', async () => {
  const { r, call } = await rpcRig()
  try {
    const result = await call('status', {}, 'guest')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'forbidden')
  } finally { r.dispose() }
})

test('calls: lists the running foreground calls of that session only, with flags, policy and summary', async () => {
  const { r, call } = await rpcRig({ foregroundControl: true, onUserMessageWhileToolRuns: 'background', toolPolicies: { slow: 'interrupt' } })
  try {
    const mine = r.call('slow', { label: 'a' }, { callId: 'c-a', agent: { id: 'sess-A' } })
    const theirs = r.call('slow', { label: 'b' }, { callId: 'c-b', agent: { id: 'sess-B' } })
    await settle()
    const a = (await call('calls', { sessionId: 'sess-A' })).value
    assert.equal(a.calls.length, 1)
    assert.deepEqual(
      { callId: a.calls[0].callId, tool: a.calls[0].tool, summary: a.calls[0].summary, state: a.calls[0].state, transferable: a.calls[0].transferable, interruptible: a.calls[0].interruptible, policy: a.calls[0].policy },
      { callId: 'c-a', tool: 'slow', summary: '{"label":"a"}', state: 'running', transferable: true, interruptible: true, policy: 'interrupt' },
    )
    assert.ok(a.calls[0].startedAt <= a.now)
    const b = (await call('calls', { sessionId: 'sess-B' })).value
    assert.deepEqual(b.calls.map((c: any) => c.callId), ['c-b'])
    r.probe.release('a'); r.probe.release('b'); await Promise.all([mine, theirs])
    assert.deepEqual((await call('calls', { sessionId: 'sess-A' })).value.calls, [])
  } finally { r.dispose() }
})

test('transfer and interrupt act on a call of the session shown; another session\'s call id is unknown', async () => {
  const { r, call } = await rpcRig()
  try {
    const pending = r.call('slow', { label: 'x' }, { callId: 'c-x', agent: { id: 'sess-A' } })
    const other = r.call('slow', { label: 'y' }, { callId: 'c-y', agent: { id: 'sess-A' } })
    await settle()
    // wrong session: refused as an unknown call, nothing happens
    assert.deepEqual((await call('transfer', { sessionId: 'sess-B', callId: 'c-x' })).value, { ok: false, reason: 'no running call c-x' })
    assert.deepEqual((await call('interrupt', { sessionId: 'sess-B', callId: 'c-x' })).value, { ok: false, reason: 'no running call c-x' })
    assert.equal(r.jobs.jobs.length, 0)
    // right session
    const moved = (await call('transfer', { sessionId: 'sess-A', callId: 'c-x' })).value
    assert.equal(moved.ok, true)
    assert.match(moved.jobId, /^tool-/)
    assert.match(resultText(await pending), /^Not a failure, do not retry: slow was moved to the background/)
    assert.deepEqual((await call('interrupt', { sessionId: 'sess-A', callId: 'c-y' })).value, { ok: true })
    assert.equal((await other).error.info.code, 'ABORTED')
    // unknown call id
    assert.deepEqual((await call('transfer', { sessionId: 'sess-A', callId: 'nope' })).value, { ok: false, reason: 'no running call nope' })
    r.probe.release('x')
  } finally { r.dispose() }
})

test('unknown or missing session, bad payloads and unknown endpoints are failures', async () => {
  const { r, call } = await rpcRig(undefined, ['sess-A'])
  try {
    assert.equal((await call('calls', { sessionId: 'ghost' })).error.code, 'not-found')
    assert.equal((await call('calls', {})).error.code, 'bad-request')
    assert.equal((await call('calls', 'text')).error.code, 'bad-request')
    assert.equal((await call('transfer', { sessionId: 'sess-A' })).error.code, 'bad-request')
    assert.equal((await call('killJob', { sessionId: 'sess-A' })).error.code, 'bad-request')
    assert.equal((await call('nope', { sessionId: 'sess-A' })).error.code, 'not-found')
  } finally { r.dispose() }
})

test('gated or off: transfer / interrupt refuse with a reason and calls is empty', async () => {
  const off = await rpcRig({})
  try {
    assert.deepEqual((await off.call('transfer', { sessionId: 'sess-A', callId: 'c' })).value, { ok: false, reason: 'foreground control is off' })
    assert.deepEqual((await off.call('calls', { sessionId: 'sess-A' })).value.calls, [])
  } finally { off.r.dispose() }
  const gated = createHandler({
    foregroundControl: true, defaultPolicy: 'wait', jobs: () => undefined, agent: () => ({ id: 'sess-A' }),
    hub: {
      api: { list: () => [{ callId: 'c', rootCallId: 'c', agentId: 'sess-A', tool: 'slow', summary: '', startedAt: 1, state: 'running', controllable: false }], transfer: () => ({ ok: false, reason: 'transfer is disabled: dsh-tools 9.9.9 was not verified for it' }), interrupt: () => ({ ok: false, reason: 'x' }), status: () => ({ enabled: false, verifiedVersions: [] }) } as never,
      policyFor: () => 'wait',
    },
  })
  const calls = (await gated('calls', { sessionId: 'sess-A' }, new AbortController().signal, { principal: { kind: 'owner' } })).value as any
  assert.deepEqual([calls.calls[0].transferable, calls.calls[0].interruptible], [false, false])
  const moved = (await gated('transfer', { sessionId: 'sess-A', callId: 'c' }, new AbortController().signal, { principal: { kind: 'owner' } })).value
  assert.match((moved as any).reason, /not verified/)
})

test('jobs and killJob: only this plugin\'s jobs of that session; killing another session\'s job is refused', async () => {
  const { r, call } = await rpcRig()
  try {
    await r.call('background_run', { tool: 'slow', arguments: { label: 'j1' }, description: 'first' }, { callId: 'bg-1', agent: { id: 'sess-A' } })
    await r.call('background_run', { tool: 'slow', arguments: { label: 'j2' }, description: 'second' }, { callId: 'bg-2', agent: { id: 'sess-B' } })
    await settle()
    const a = (await call('jobs', { sessionId: 'sess-A' })).value
    assert.equal(a.jobs.length, 1)
    assert.deepEqual([a.jobs[0].label, a.jobs[0].status, a.jobs[0].progress], ['slow: first', 'running', 'running slow'])
    const idB = r.jobs.jobs[1]!.id
    const idA = r.jobs.jobs[0]!.id
    // session A cannot stop session B's job; the fake registry's get() does not fence owners, so make it do what the real one does
    ;(r.jobs as any).get = (id: string, caller?: string) => { const job = r.jobs.jobs.find(j => j.id === id)!; if (job.spec.owner !== caller) throw new Error(`unknown job ${id}`); return { kind: job.spec.kind } }
    assert.deepEqual((await call('killJob', { sessionId: 'sess-A', jobId: idB })).value, { ok: false, reason: `no job ${idB} in this session` })
    assert.deepEqual((await call('killJob', { sessionId: 'sess-A', jobId: idA })).value, { ok: true })
    const done = await r.jobs.finished(idA)
    assert.equal(done.status, 'killed')
    assert.equal(done.killReason, 'stopped by the user')
    r.probe.release('j2')
  } finally { r.dispose() }
})
