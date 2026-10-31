import test from 'node:test'
import assert from 'node:assert/strict'
import { ForegroundController, POLL_MS } from '../src/client/foreground.ts'
import { RPC_CHANNEL } from '../src/rpc-types.ts'
import { en, zh } from '../src/client/locales.ts'

interface Sent { channel: string; endpoint: string; payload: any }

function fakeRpc(handler: (endpoint: string, payload: any) => unknown) {
  const sent: Sent[] = []
  return {
    sent,
    rpc: { call: async (channel: string, endpoint: string, payload: unknown) => {
      sent.push({ channel, endpoint, payload })
      const value = handler(endpoint, payload)
      return value instanceof Error ? { ok: false as const, error: { code: 'x', message: value.message, details: {} } } : { ok: true as const, value }
    } },
  }
}

const call = (id: string, startedAt = 1000) => ({ callId: id, tool: 'slow', summary: '{}', startedAt, state: 'running', transferable: true, interruptible: true, policy: 'wait' })
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('the dictionaries have the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  assert.equal(zh['foreground.transfer'], '转入后台')
  assert.equal(zh['foreground.interrupt'], '打断')
  assert.equal(zh['jobs.header'], '后台任务')
  assert.equal(zh['jobs.stop'], '停止')
})

test('status is asked once; a failed answer leaves the dock disabled', async () => {
  const ok = fakeRpc(() => ({ foregroundControl: true, enabled: true, verifiedVersions: [], defaultPolicy: 'wait' }))
  const controller = new ForegroundController(ok.rpc, 'sess-1')
  await controller.ensureStatus(); await controller.ensureStatus()
  assert.equal(ok.sent.length, 1)
  assert.equal(ok.sent[0]!.channel, RPC_CHANNEL)
  assert.equal(controller.getSnapshot().status?.enabled, true)
  const bad = fakeRpc(() => new Error('no channel'))
  const down = new ForegroundController(bad.rpc, 'sess-1')
  await down.ensureStatus()
  assert.equal(down.getSnapshot().status?.enabled, false)
  controller.dispose(); down.dispose()
})

test('polling runs only while watched, once per watcher set, and clears the calls when the last watcher leaves', async () => {
  const f = fakeRpc((endpoint) => endpoint === 'status'
    ? { foregroundControl: true, enabled: true, verifiedVersions: [], defaultPolicy: 'wait' }
    : { now: 5000, calls: [call('c1')] })
  const controller = new ForegroundController(f.rpc, 'sess-1')
  const calls = () => f.sent.filter(s => s.endpoint === 'calls').length
  assert.equal(calls(), 0, 'nothing polls before a watcher')
  const stopA = controller.watch()
  const stopB = controller.watch()
  await wait(40)
  assert.equal(controller.getSnapshot().calls.length, 1)
  assert.deepEqual(f.sent.find(s => s.endpoint === 'calls')!.payload, { sessionId: 'sess-1' })
  const afterFirst = calls()
  await wait(POLL_MS + 120)
  assert.ok(calls() > afterFirst, 'polls again after about a second')
  stopA()
  const mid = calls()
  await wait(POLL_MS + 120)
  assert.ok(calls() > mid, 'still polling with one watcher left')
  stopB(); stopB()
  assert.deepEqual(controller.getSnapshot().calls, [])
  const after = calls()
  await wait(POLL_MS + 120)
  assert.equal(calls(), after, 'stopped')
  controller.dispose()
})

test('the server clock offset is taken from the answer', async () => {
  const f = fakeRpc(() => ({ now: Date.now() + 60_000, calls: [] }))
  const controller = new ForegroundController(f.rpc, 's')
  await controller.refresh()
  const skew = controller.getSnapshot().skewMs
  assert.ok(skew > 59_000 && skew < 61_000, String(skew))
  controller.dispose()
})

test('act sends the session and call, marks the call pending, keeps a refusal as the notice, then refreshes', async () => {
  const state = { calls: [call('c1')], refuse: false }
  const f = fakeRpc((endpoint, payload) => {
    if (endpoint === 'calls') return { now: 5000, calls: state.calls }
    if (endpoint === 'transfer' || endpoint === 'interrupt') return state.refuse ? { ok: false, reason: 'the call is done' } : { ok: true, jobId: 'tool-1' }
    return {}
  })
  const controller = new ForegroundController(f.rpc, 'sess-1')
  const seen: string[][] = []
  controller.subscribe(() => seen.push([...controller.getSnapshot().pending]))
  const moved = await controller.act('transfer', 'c1')
  assert.deepEqual(moved, { ok: true, jobId: 'tool-1' })
  assert.deepEqual(f.sent.find(s => s.endpoint === 'transfer')!.payload, { sessionId: 'sess-1', callId: 'c1' })
  assert.ok(seen.some(p => p.includes('c1')), 'pending while in flight')
  assert.deepEqual(controller.getSnapshot().pending, [])
  assert.equal(controller.getSnapshot().notice, undefined)
  state.refuse = true
  const refused = await controller.act('interrupt', 'c1')
  assert.deepEqual(refused, { ok: false, reason: 'the call is done' })
  assert.equal(controller.getSnapshot().notice, 'the call is done')
  controller.dismissNotice()
  assert.equal(controller.getSnapshot().notice, undefined)
  const down = new ForegroundController(fakeRpc(() => new Error('boom')).rpc, 's')
  assert.deepEqual(await down.act('transfer', 'x'), { ok: false, reason: 'the request failed' })
  controller.dispose(); down.dispose()
})

test('settings parsers: tool policies and the auto-background delay', async () => {
  const { parseToolPolicies, parseDelay } = await import('../src/client/parse.ts')
  assert.deepEqual(parseToolPolicies(''), {})
  assert.deepEqual(parseToolPolicies('{"web_call":"background","browser_call":"interrupt","x":"wait"}'), { web_call: 'background', browser_call: 'interrupt', x: 'wait' })
  for (const bad of ['[]', '"x"', 'null', '{"a":"later"}', '{"a":1}', '{', 'nope']) assert.equal(parseToolPolicies(bad), undefined, bad)
  assert.equal(parseDelay(''), null)
  assert.equal(parseDelay('  '), null)
  assert.equal(parseDelay('1500'), 1500)
  for (const bad of ['0', '-5', '1.5', 'abc', '1e3x']) assert.equal(parseDelay(bad), undefined, bad)
})
