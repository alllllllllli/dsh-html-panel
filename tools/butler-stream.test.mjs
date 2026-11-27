/**
 * 0.9.0：assistant-stream hub + SSE handler 单测（node --test，零依赖）。
 *
 * 覆盖（照调研报告 §5-B6）：
 *   - 帧折叠：start/chunk/end、revision 连续/跳号 reset、重复帧幂等、形状异常不抛；
 *   - 合批：40–60ms 窗口只发一帧快照、pending 上限关连接；
 *   - subscriber 增删 / 每 session 2 条 / 全局 8 条上限 / dispose 清理；
 *   - durable tick：只对已订阅 session、100ms 去重；
 *   - SSE handler：假 req/res 的 headers/hello/retry/ping/405/403/404/close 清理/上限。
 *
 * 用法: node --test tools/butler-stream.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  BUTLER_STREAM_FILE, STREAM_MAX_PENDING_BYTES, STREAM_MAX_PER_SESSION, STREAM_MAX_TOTAL,
  createButlerLiveHub, handleButlerStreamRequest, streamFence,
} from '../lib/butler-stream.js'

/** 可控定时器（单测不睡真实毫秒）。 */
function fakeTimers() {
  let nextId = 1
  const timers = new Map()
  const make = (kind) => (fn, ms) => {
    const id = nextId++
    timers.set(id, { fn, ms, kind })
    return id
  }
  const clear = (id) => { timers.delete(id) }
  return {
    setTimeout: make('timeout'),
    clearTimeout: clear,
    setInterval: make('interval'),
    clearInterval: clear,
    pending(kind) { return [...timers.values()].filter(item => !kind || item.kind === kind) },
    runNext(kind) {
      for (const [id, item] of timers) {
        if (kind && item.kind !== kind) continue
        timers.delete(id)
        item.fn()
        return true
      }
      return false
    },
  }
}

/** 一个 hub + 一个记录事件的 sink。 */
function makeHub(options = {}) {
  const timers = fakeTimers()
  const events = []
  const logger = { warns: [], warn(message) { this.warns.push(String(message)) } }
  const hub = createButlerLiveHub({
    ctx: null,
    logger,
    now: options.now || (() => 1000),
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    options: options.options,
  })
  const sink = {
    events,
    send(event, data) { events.push({ event, data }) },
    close(reason) { events.push({ event: 'close', data: reason }) },
  }
  return { hub, timers, events, sink, logger }
}

const at = (kind, attemptId, revision, extra = {}) => ({ kind, attemptId, revision, ...extra })
const chunk = (attemptId, revision, inner, index = revision) => at('chunk', attemptId, revision, { index, chunk: inner })

test('帧折叠：start/chunk 合批成一帧快照（40–60ms 窗口）', () => {
  const { hub, timers, events, sink } = makeHub()
  assert.equal(hub.addSubscriber('session-a', sink).ok, true)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-1', 1, { turn: 3, step: 1 }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'text-delta', index: 0, text: '你' }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 3, { type: 'text-delta', index: 0, text: '好' }) })
  assert.equal(events.filter(item => item.event === 'assistant').length, 0, '未到合批窗口不发')
  timers.runNext('timeout')
  const assistant = events.filter(item => item.event === 'assistant')
  assert.equal(assistant.length, 1, '两次 delta 合成一帧')
  assert.equal(assistant[0].data.text, '你好')
  assert.equal(assistant[0].data.delta.text, '你好')
  assert.equal(assistant[0].data.revision, 3)
  assert.equal(assistant[0].data.turn, 3)
  assert.equal(assistant[0].data.step, 1)
  assert.equal(hub.snapshotOf('session-a').attempt.text, '你好')
})

test('帧折叠：reasoning-delta 单独累积；block-end 用完整块覆盖（防漂移）', () => {
  const { hub, timers, events, sink } = makeHub()
  hub.addSubscriber('session-a', sink)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-1', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'reasoning-delta', index: 0, text: '想' }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 3, { type: 'reasoning-delta', index: 0, text: '一下' }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 4, { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一下' } }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 5, { type: 'text-delta', index: 1, text: '答' }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 6, { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } }) })
  timers.runNext('timeout')
  const last = events.filter(item => item.event === 'assistant').pop()
  assert.equal(last.data.thinking, '想一下')
  assert.equal(last.data.text, '答案', 'block-end 的完整块覆盖累积文本')
})

test('帧折叠：revision 跳号 → reset 清空并等 durable，后续增量不再拼、且不 throw', () => {
  const { hub, timers, events, sink } = makeHub()
  hub.addSubscriber('session-a', sink)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-1', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'text-delta', text: 'AB' }) })
  timers.runNext('timeout')
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 9, { type: 'text-delta', text: '丢了' }) })
  const reset = events.filter(item => item.event === 'reset')
  assert.equal(reset.length, 1)
  assert.equal(reset[0].data.reason, 'revision-gap')
  assert.equal(hub.snapshotOf('session-a').attempt.text, '')
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 10, { type: 'text-delta', text: '继续' }) })
  assert.equal(hub.snapshotOf('session-a').attempt.text, '', 'desync 后不拼增量，等 durable')
  assert.equal(events.filter(item => item.event === 'assistant').length, 1, 'reset 只有原来那一帧')
})

test('帧折叠：重复 revision 幂等；旧 attempt 的 end 不猜内容；未知帧类型忽略', () => {
  const { hub, events, sink } = makeHub()
  hub.addSubscriber('session-a', sink)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-1', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'text-delta', text: 'x' }) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'text-delta', text: 'x' }) })
  assert.equal(hub.snapshotOf('session-a').attempt.text, 'x', '重复帧不重复追加')
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('end', 'att-1', 3, { outcome: { kind: 'committed', seq: 7 } }) })
  assert.equal(hub.snapshotOf('session-a').attempt, null)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('end', 'att-late', 4, { outcome: 'abandoned' }) })
  assert.equal(events.filter(item => item.event === 'end').length, 1, '正常 end 只发一次')
  assert.equal(events.filter(item => item.event === 'end')[0].data.outcome.seq, 7)
  assert.equal(events.filter(item => item.event === 'reset').length, 1, '没见过 start 的 end 用 reset 提示页面，不猜内容')
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('future-kind', 'att-2', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: { kind: 'chunk' } })
  hub.onAssistantStream({})
  hub.onAssistantStream(null)
})

test('子代理也要能流（不排除非根会话）', () => {
  const { hub, timers, events, sink } = makeHub()
  hub.addSubscriber('sub-1', sink)
  hub.onAssistantStream({ agent: { session: { id: 'sub-1' } }, frame: at('start', 'att-sub', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'sub-1' } }, frame: chunk('att-sub', 2, { type: 'text-delta', text: '子代理' }) })
  timers.runNext('timeout')
  assert.equal(events.filter(item => item.event === 'assistant').pop().data.text, '子代理')
})

test('背压：单 session pending 超 64KB 关连接并清空缓冲', () => {
  const { hub, events, sink } = makeHub({ options: { maxPendingBytes: 8 } })
  hub.addSubscriber('session-a', sink)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-1', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'text-delta', text: 'x'.repeat(32) }) })
  assert.equal(events.filter(item => item.event === 'close').length, 1)
  assert.equal(events.filter(item => item.event === 'close')[0].data, 'backpressure')
  assert.equal(hub.countFor('session-a'), 0)
  assert.ok(STREAM_MAX_PENDING_BYTES >= 64 * 1024)
})

test('subscriber 增删与上限：每 session 2 条、全局 8 条', () => {
  const { hub } = makeHub()
  const makeSink = () => ({ send() {}, close() {} })
  const first = hub.addSubscriber('session-a', makeSink())
  assert.equal(first.ok, true)
  assert.equal(hub.addSubscriber('session-a', makeSink()).ok, true)
  const third = hub.addSubscriber('session-a', makeSink())
  assert.equal(third.ok, false)
  assert.equal(third.code, 'stream-limit-session')
  assert.equal(STREAM_MAX_PER_SESSION, 2)
  first.unsubscribe()
  assert.equal(hub.countFor('session-a'), 1)
  let last = null
  for (let i = 0; i < 7; i += 1) last = hub.addSubscriber('session-' + i, makeSink())
  assert.equal(hub.countAll(), 8)
  assert.equal(last.ok, true)
  const ninth = hub.addSubscriber('session-overflow', makeSink())
  assert.equal(ninth.ok, false)
  assert.equal(ninth.code, 'stream-limit-total')
  assert.equal(STREAM_MAX_TOTAL, 8)
  const empty = hub.addSubscriber('', makeSink())
  assert.equal(empty.ok, false)
})

test('dispose：关闭所有订阅、清定时器、之后不再接受订阅/帧', () => {
  const { hub, events, sink } = makeHub()
  hub.addSubscriber('session-a', sink)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-1', 1) })
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: chunk('att-1', 2, { type: 'text-delta', text: 'x' }) })
  hub.dispose()
  assert.equal(events.some(item => item.event === 'close' && item.data === 'disposed'), true)
  assert.equal(hub.countAll(), 0)
  assert.equal(hub.addSubscriber('session-a', sink).ok, false)
  hub.onAssistantStream({ agent: { session: { id: 'session-a' } }, frame: at('start', 'att-2', 1) })
  assert.equal(hub.snapshotOf('session-a').attempt, null)
})

test('durable tick：只对已订阅 session、100ms 去重、不带内容', () => {
  let now = 1000
  const { hub, events, sink } = makeHub({ now: () => now })
  hub.addSubscriber('session-a', sink)
  hub.onSessionEvent({ id: 'session-b' }, { seq: 1, type: 'assistant/message' })
  assert.equal(events.length, 0, '未订阅的 session 不发 tick')
  hub.onSessionEvent({ id: 'session-a' }, { seq: 2, type: 'assistant/message' })
  hub.onSessionEvent({ id: 'session-a' }, { seq: 3, type: 'tool/call' })
  assert.equal(events.filter(item => item.event === 'tick').length, 1, '100ms 内只发一次')
  now += 101
  hub.onSessionEvent({ id: 'session-a' }, { seq: 4, type: 'tool/result' })
  const ticks = events.filter(item => item.event === 'tick')
  assert.equal(ticks.length, 2)
  assert.equal(ticks[1].data.seq, 4, 'tick 只带 seq/type，不搬内容')
  assert.equal(ticks[1].data.type, 'tool/result')
})

/* ─────────────────────────── SSE handler（假 req/res） ─────────────────────────── */

class FakeRequest extends EventEmitter {
  constructor({ method = 'GET', url = '/dsh-html-panel/api/butler/dialog/stream?sessionId=session-a', headers = { host: '127.0.0.1:51610' } } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.status = null
    this.headers = {}
    this.chunks = []
    this.writableEnded = false
    this.headersSent = false
  }
  writeHead(status, headers) { this.status = status; this.headers = { ...headers }; this.headersSent = true }
  setHeader(key, value) { this.headers[key] = value }
  write(text) { this.chunks.push(String(text)); return true }
  end(body) { if (body !== undefined && !this.writableEnded) this.chunks.push(String(body)); if (!this.writableEnded) { this.writableEnded = true; this.emit('close') } }
  flushHeaders() {}
  text() { return this.chunks.join('') }
}

function handlerDeps(overrides = {}) {
  const timers = fakeTimers()
  const hub = overrides.hub || makeHub().hub
  return {
    hub,
    targetOf: overrides.targetOf || (async () => ({ sessionId: 'session-a' })),
    logger: { warn() {} },
    now: () => 1234,
    timers: {
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      pingMs: 15000,
      idleMs: 1800000,
      retryMs: 3000,
    },
    timersControl: timers,
  }
}

test('SSE：200 精确头 + retry 3000 + hello 快照；ping/close 清理', async () => {
  assert.equal(BUTLER_STREAM_FILE, 'api/butler/dialog/stream')
  const deps = handlerDeps()
  const req = new FakeRequest()
  const res = new FakeResponse()
  await handleButlerStreamRequest(req, res, deps)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-cache, no-store')
  assert.equal(res.headers.connection, 'keep-alive')
  assert.equal(res.headers['x-accel-buffering'], 'no')
  const body = res.text()
  assert.match(body, /^retry: 3000\n\n/)
  assert.match(body, /event: hello\ndata: \{"sessionId":"session-a"/)
  assert.equal(deps.hub.countAll(), 1, 'hello 后已订阅')
  const interval = deps.timersControl.pending('interval')[0]
  interval.fn()
  assert.match(res.text(), /: ping 1234/)
  req.emit('close')
  assert.equal(res.writableEnded, true)
  assert.equal(deps.hub.countAll(), 0, 'close 后订阅被清理')
})

test('SSE：405（非 GET）/ 403（跨站、非回环 Host/Origin）/ 404（无会话）/ 429（连接上限）', async () => {
  const post = new FakeRequest({ method: 'POST' })
  const postRes = new FakeResponse()
  await handleButlerStreamRequest(post, postRes, handlerDeps())
  assert.equal(postRes.status, 405)
  assert.match(postRes.text(), /method-not-allowed/)

  const crossSite = new FakeRequest({ headers: { host: '127.0.0.1:51610', 'sec-fetch-site': 'cross-site' } })
  const crossRes = new FakeResponse()
  await handleButlerStreamRequest(crossSite, crossRes, handlerDeps())
  assert.equal(crossRes.status, 403)

  const foreignHost = new FakeRequest({ headers: { host: '10.0.0.5:51610' } })
  const foreignRes = new FakeResponse()
  await handleButlerStreamRequest(foreignHost, foreignRes, handlerDeps())
  assert.equal(foreignRes.status, 403)

  const noSession = new FakeRequest({ url: '/dsh-html-panel/api/butler/dialog/stream' })
  const noSessionRes = new FakeResponse()
  const deps404 = handlerDeps({ targetOf: async () => ({ error: '没有可用的会话绑定' }) })
  await handleButlerStreamRequest(noSession, noSessionRes, deps404)
  assert.equal(noSessionRes.status, 404)

  const hub = makeHub().hub
  hub.addSubscriber('session-a', { send() {}, close() {} })
  hub.addSubscriber('session-a', { send() {}, close() {} })
  const limitedRes = new FakeResponse()
  await handleButlerStreamRequest(new FakeRequest(), limitedRes, handlerDeps({ hub }))
  assert.equal(limitedRes.status, 429)
  assert.match(limitedRes.text(), /stream-limit-session/)
})

test('SSE：空闲超时自动关闭', async () => {
  const deps = handlerDeps()
  const req = new FakeRequest()
  const res = new FakeResponse()
  await handleButlerStreamRequest(req, res, deps)
  assert.equal(deps.hub.countAll(), 1)
  const idle = deps.timersControl.pending('timeout')[0]
  idle.fn()
  assert.equal(res.writableEnded, true)
  assert.equal(deps.hub.countAll(), 0)
})

test('streamFence：回环 Host 放行；缺 Host/非法 Origin/cross-site 拒绝', () => {
  const base = headers => ({ headers })
  assert.equal(streamFence(base({ host: '127.0.0.1:51610' })), undefined)
  assert.equal(streamFence(base({ host: 'localhost:51610', origin: 'http://localhost:51610' })), undefined)
  assert.match(streamFence(base({})), /Host/)
  assert.match(streamFence(base({ host: '192.168.1.2:51610' })), /回环/)
  assert.match(streamFence(base({ host: '127.0.0.1:51610', origin: 'http://127.0.0.1:9999' })), /Origin/)
  assert.match(streamFence(base({ host: '127.0.0.1:51610', 'sec-fetch-site': 'cross-site' })), /跨站/)
  assert.match(streamFence(base({ host: '127.0.0.1:51610', origin: 'not a url' })), /Origin/)
})
