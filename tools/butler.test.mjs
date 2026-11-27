#!/usr/bin/env node
/**
 * tools/butler.test.mjs —— `lib/butler.js`（大管家驾驶舱 M0+M1）的单元测试。
 *
 * 零依赖，`node --test`：不需要起 DSH、不需要真的会话/网络；全部用假 Host 服务 mock，
 * **不碰任何真实会话**（本文件不 import 写 API，也不调用 prompt/cancel/interrupt）。
 *
 * 覆盖：
 *   M0 可管理对象清单
 *   - 本机活会话 + 官方子代理血缘复用 tiers（不复制第二套）、状态映射（运行/排队/等审批/等回答/空闲）；
 *   - 冷会话来自 sessionController.list()（updatedAt、父会话、mode），空会话不冒充可管理对象；
 *   - 会话状态读失败时保留层级快照状态并如实降级（不编状态）；
 *   - 跨机对端只读不可控（readonly/controllable/note/session 行）；
 *   - binding：config pinned / recent-root（最近主人消息）/ 找不到时 available:false 不编造；
 *   - list 不可用时退回 tiers 选根，并写明降级原因；原始异常文本不外泄。
 *   M1 真实对话
 *   - events() 归一化：主人/系统注入/助手/思考/工具卡 callId 配对/大输出截断；
 *   - sessionId 选择与子代理地址契约 {parentSessionId, childSessionId, mode:'unknown'}；
 *   - limit/before 窗口收敛、cursor/hasMore 透传、分页从工具中间开始不丢事实；
 *   - 无 controller / 会话不存在 / 跨机会话 → available:false + 人话原因（不编对话）；
 *   - 冷会话不激活（不调 state()），活会话状态进响应；
 *   - reader 4 秒缓存 + 单飞：对话轮询不重复打 sessionController.list()。
 *   路由 / 配置
 *   - GET|HEAD api/butler/sessions 与 api/butler/dialog 的契约、405、JSON 404；
 *   - 服务全缺时仍是 200 + 结构化降级（页面不白屏）；
 *   - readButlerConfig 默认 recent-root、配置 sessionId 即 pinned。
 *
 * 用法: node --test tools/butler.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUTLER_DIALOG_DEFAULT_LIMIT, BUTLER_DIALOG_MAX_LIMIT,
  MESSAGE_TEXT_MAX, NOTICE_SUMMARY_MAX, TOOL_ARG_MAX, TOOL_RESULT_MAX,
  buildButlerDialog, buildButlerSessions, createButlerReader, foldSessionState,
  injectionLabel, normalizeDialogEvents, readButlerConfig, resolveBinding, resolveStreamTarget,
  summarizeInjection,
} from '../lib/butler.js'
import {
  BUTLER_LABEL_DEFAULT, SAY_CONTENT_MAX, SAY_RATE_LIMIT, SAY_RATE_WINDOW_MS,
  createWriteChannel, persistButlerSessionId, readWriteOptions, rewriteButlerSessionId,
  stampOf, CONFIG_BACKUP_INFIX,
} from '../lib/butler-write.js'
import {
  TOOL_DENY, TOOL_WHITELIST, apply as applyButlerPreset,
  inject as BUTLER_PRESET_INJECT, name as BUTLER_PRESET_NAME, planRestriction,
} from '../lib/agent-preset-auto-team.js'
import {
  BUTLER_DIALOG_FILE, BUTLER_SAY_FILE, BUTLER_SESSIONS_FILE, BUTLER_SESSION_FILE,
  ROUTE_PREFIX, apply, injectWriteConfig,
} from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AT = Date.parse('2026-11-21T12:00:00.000Z')
const MIN = 60000
const HOUR = 60 * MIN

/* ─────────────────────────── A. stub 工具 ─────────────────────────── */

/** tiers 形状的假快照：T0 + 3 个本机节点 + 1 个远端节点。 */
function tierBody() {
  return {
    generatedAt: new Date(AT).toISOString(),
    source: {
      local: 'sessions+agents',
      subagents: 'session-header(origin+parentSession)',
      subagentMode: 'official-projection',
      remote: [
        { instanceId: 'server', link: 'up', sessions: 1 },
        { instanceId: 's5', link: 'down', sessions: 0 },
      ],
      cached: false,
      ageMs: 0,
    },
    root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: new Date(AT - HOUR).toISOString() },
    nodes: [
      { id: 's-main', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '主控会话', status: 'run', startedAt: new Date(AT - 3 * HOUR).toISOString(), childSessionId: 's-main', parentSessionId: null, mode: null },
      { id: 's-child', parentId: 's-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '子代理 子任务', status: 'run', startedAt: new Date(AT - 2 * HOUR).toISOString(), childSessionId: 's-child', parentSessionId: 's-main', mode: 'unknown' },
      { id: 's-grand', parentId: 's-child', tier: 3, kind: 'subagent', device: 'pc-ky614', title: '孙代理 复核', status: 'idle', startedAt: new Date(AT - HOUR).toISOString(), childSessionId: 's-grand', parentSessionId: 's-child', mode: 'one-shot' },
      { id: 's-flaky', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '状态读不到的会话', status: 'run', startedAt: new Date(AT - 4 * HOUR).toISOString(), childSessionId: 's-flaky', parentSessionId: null, mode: null },
      { id: 'server:remote-1', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: '对端会话', status: 'idle', startedAt: null },
    ],
  }
}

function summary(id, options = {}) {
  const row = {
    sessionId: id,
    updatedAt: options.updatedAt ?? AT - MIN,
    running: options.running === true,
    blank: options.blank === true,
    agentAvailable: options.agentAvailable !== false,
  }
  if (options.origin !== undefined) row.origin = options.origin
  if (options.parentSessionId !== undefined) row.parentSessionId = options.parentSessionId
  const values = { ...(options.values || {}) }
  row.projections = { kind: 'sequenced', asOfSeq: 1, values }
  return row
}

function sessionState(options = {}) {
  return {
    cursor: 10,
    active: options.active !== false,
    running: options.running === true,
    queue: options.queue ?? [],
    pendingInput: options.pendingInput ?? [],
  }
}

/** 一组典型数据：活会话 + 子代理 + 冷会话 + 空会话。 */
function happyDeps(overrides = {}) {
  const summaries = [
    summary('s-main', {
      running: true,
      values: { title: '主控会话', sessionListMetadata: { blank: false, lastPromptAt: AT - 2 * MIN } },
    }),
    summary('s-child', {
      origin: 'subagent',
      parentSessionId: 's-main',
      values: { subagent: { mode: 'continuable', label: '实现子代理', seq: 3 } },
    }),
    summary('s-grand', {
      origin: 'subagent',
      parentSessionId: 's-child',
      agentAvailable: false,
      values: { subagent: { mode: 'one-shot', label: '复核', seq: 4 } },
    }),
    summary('s-flaky', { running: true, values: { title: '状态读不到的会话' } }),
    summary('s-cold', {
      agentAvailable: false,
      updatedAt: AT - 20 * HOUR,
      values: { title: '昨天的会话', sessionListMetadata: { blank: false, lastPromptAt: AT - 20 * HOUR } },
    }),
    summary('s-blank', { blank: true, agentAvailable: false, values: {} }),
  ]
  const states = {
    's-main': sessionState({ running: true, queue: [{ id: 'q1' }, { id: 'q2' }] }),
    's-child': sessionState({ running: false, pendingInput: ['approval'] }),
    's-flaky': null, // 由 state() 抛错
  }
  const calls = { list: 0, state: [], events: [] }
  const deps = {
    tiers: { read: async () => tierBody() },
    controller: () => ({
      async list(_request, signal) {
        calls.list += 1
        return { items: summaries }
      },
      async state(request) {
        calls.state.push(request.sessionId)
        if (request.sessionId === 's-flaky') {
          const error = new Error('SECRET internal path C:\\temp\\x')
          error.code = 'gateway/internal'
          throw error
        }
        const value = states[request.sessionId]
        if (value === undefined) throw Object.assign(new Error('not found'), { code: 'session/not-found' })
        return value
      },
      async events(request) {
        calls.events.push(request)
        return dialogPage()
      },
    }),
    now: () => AT,
    config: {},
  }
  return { deps: { ...deps, ...overrides }, summaries, calls }
}

/** 一页真实形状的事件：主人消息 / 系统注入 / 助手(思考) / 工具调用+结果 / 失败尝试。 */
function dialogPage() {
  const event = (seq, type, data, time) => ({ type: 'event', event: { type, seq, time: time ?? AT - MIN + seq * 10, data } })
  return {
    cursor: 8,
    hasMore: true,
    records: [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', {
        role: 'user',
        id: 'm1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '把面板改成驾驶舱' }],
      }),
      event(2, 'user/message', {
        role: 'user',
        id: 'm2',
        source: { kind: 'context', form: 'notice', summary: 'AGENTS.md 注入' },
        content: [{ type: 'text', text: '注入的上下文很长……' }],
      }),
      event(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'm3',
          source: { kind: 'model' },
          content: [
            { type: 'reasoning', text: '先读可行性报告，再改 lib。' },
            { type: 'text', text: '好，先做 M0/M1，只读。' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"C:\\\\a.md"}' },
          ],
        },
        stream: [],
      }),
      event(4, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"C:\\\\a.md"}' }, AT - MIN + 100),
      event(5, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          id: 'm4',
          source: { kind: 'tool', toolName: 'read' },
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'X'.repeat(TOOL_RESULT_MAX * 3) }],
        },
      }),
      event(6, 'assistant/attempt', { turn: 1, step: 2, stream: [] }),
      event(7, 'assistant/message', {
        turn: 1,
        step: 2,
        message: { role: 'assistant', id: 'm5', source: { kind: 'model' }, content: [{ type: 'text', text: '改完了。' }] },
        stream: [],
      }),
      event(8, 'tool/result', {
        turn: 1,
        step: 3,
        message: {
          role: 'tool',
          id: 'm6',
          source: { kind: 'tool', toolName: 'bash' },
          toolCallId: 'orphan-call',
          isError: true,
          content: [{ type: 'text', text: '报错：ENOENT' }],
        },
        error: { name: 'ToolError', code: 'ENOENT' },
      }),
    ],
  }
}

/** 假 ctx：apply() 只需要 webServer；其余服务通过 ctx.get 注入。 */
function mount(services = {}) {
  let resource = null
  const handlers = new Map()
  const resolveService = name => {
    const value = services[name]
    return typeof value === 'function' ? value() : value
  }
  const ctx = {
    effect(fn) {
      return fn()
    },
    get(name) {
      return resolveService(name)
    },
    webServer: {
      register(options) {
        if (typeof options.resource === 'function') resource = options.resource
        if (typeof options.handler === 'function' && typeof options.path === 'string') handlers.set(options.path, options.handler)
        return () => {}
      },
    },
  }
  if ('interconnect' in services) ctx.interconnect = resolveService('interconnect')
  apply(ctx, services.config ?? {})
  assert.equal(typeof resource, 'function')
  resource.handlers = handlers
  return resource
}

/** 给 raw handler（Node req/res）起一个临时 HTTP 服务，跑一个函数后关掉。 */
async function withHandlerServer(handler, run) {
  let port = 0
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(done => server.close(done))
  }
}

async function withRouteServer(resource, run) {
  let port = 0
  const server = createServer(async (req, res) => {
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers })
    const response = await resource(request)
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    const body = response.body === null ? Buffer.from('') : Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, headers)
    res.end(body)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(done => server.close(done))
  }
}

async function hit(baseUrl, path, options = {}) {
  const response = await fetch(baseUrl + path, options)
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

function byId(nodes) {
  const map = new Map()
  for (const node of nodes) map.set(node.id, node)
  return map
}

/* ─────────────────────────── B. 配置 ─────────────────────────── */

test('配置：默认 recent-root；给了 sessionId 就是 pinned；非法段回落默认', () => {
  const defaults = { sessionId: '', targetMode: 'recent-root', allowWrite: false, configPath: '', label: '大管家 · 常驻', agentPreset: '' }
  assert.deepEqual(readButlerConfig(undefined), defaults)
  assert.deepEqual(readButlerConfig({}), defaults)
  assert.deepEqual(readButlerConfig({ butler: {} }), defaults)
  assert.deepEqual(readButlerConfig({ butler: { sessionId: '  s-main  ' } }), { ...defaults, sessionId: 's-main', targetMode: 'pinned' })
  assert.deepEqual(readButlerConfig({ butler: { targetMode: 'pinned' } }), { ...defaults, targetMode: 'pinned' })
  assert.deepEqual(readButlerConfig({ butler: { sessionId: 42 } }), defaults)
  assert.deepEqual(readButlerConfig({ butler: { sessionId: 'x'.repeat(500) } }).sessionId.length, 160)
})

test('配置 0.8.0：allowWrite 只认 true；configPath / label 读入；写通道目标只认 sessionId', () => {
  const parsed = readButlerConfig({
    butler: { sessionId: 'session-butler', allowWrite: true, configPath: 'C:\\x\\cordis.patch.yml', label: '  我的管家  ' },
  })
  assert.equal(parsed.allowWrite, true)
  assert.equal(parsed.configPath, 'C:\\x\\cordis.patch.yml')
  assert.equal(parsed.label, '我的管家')
  assert.equal(parsed.targetMode, 'pinned')
  for (const value of ['true', 1, 'yes', {}]) {
    assert.equal(readButlerConfig({ butler: { allowWrite: value } }).allowWrite, false, 'allowWrite=' + JSON.stringify(value))
  }
})

/* ─────────────────────────── C. 状态折叠 ─────────────────────────── */

test('状态折叠：等审批 / 等回答 > 运行中 > 排队 > 空闲，冷会话回落层级状态', () => {
  assert.equal(foldSessionState(sessionState({ running: true })).status, 'run')
  assert.equal(foldSessionState(sessionState({ running: true })).statusText, '运行中')
  assert.equal(foldSessionState(sessionState({ running: false, queue: [{ id: 'q' }] })).status, 'queue')
  assert.equal(foldSessionState(sessionState({ running: false, queue: [{ id: 'q' }] })).statusText, '排队')
  const approval = foldSessionState(sessionState({ running: true, pendingInput: ['approval'] }))
  assert.equal(approval.status, 'blocked')
  assert.equal(approval.statusText, '等审批')
  const question = foldSessionState(sessionState({ running: true, pendingInput: ['question'] }))
  assert.equal(question.statusText, '等回答')
  assert.equal(foldSessionState(sessionState({ active: false, running: false }), 'queue').status, 'queue')
  assert.equal(foldSessionState(null, 'blocked').status, 'blocked')
  assert.equal(foldSessionState(null).stateKnown, false)
})

/* ─────────────────────────── D. M0 可管理对象清单 ─────────────────────────── */

test('M0：本机活会话 + 子代理血缘 + 冷会话 + 跨机行，结构给页面直接用', async () => {
  const { deps } = happyDeps()
  const body = await buildButlerSessions(deps)
  assert.equal(body.generatedAt, new Date(AT).toISOString())
  assert.equal(body.root.id, 'pc-ky614')
  assert.deepEqual(body.counts, { 0: 1, 1: 4, 2: 1, 3: 1 }, 'T1 = s-main + s-flaky + s-cold + 远端；T2 = s-child；T3 = s-grand')
  assert.equal(body.total, 6)
  const map = byId(body.nodes)

  const main = map.get('s-main')
  assert.equal(main.kind, 'session')
  assert.equal(main.status, 'run')
  assert.equal(main.statusText, '运行中')
  assert.equal(main.queue, 2)
  assert.equal(main.stateKnown, true)
  assert.equal(main.updatedAt, new Date(AT - MIN).toISOString(), 'updatedAt 来自 sessionController.list()')
  assert.equal(main.readonly, false)

  const child = map.get('s-child')
  assert.equal(child.kind, 'subagent')
  assert.equal(child.tier, 2)
  assert.equal(child.parentId, 's-main')
  assert.equal(child.status, 'blocked')
  assert.equal(child.statusText, '等审批')
  assert.equal(child.mode, 'continuable', '官方 subagent 投影 mode 覆盖 tiers 的 unknown')

  const grand = map.get('s-grand')
  assert.equal(grand.tier, 3)
  assert.equal(grand.parentSessionId, 's-child')
  assert.equal(grand.statusText, '空闲', '冷子代理不读 state，保留层级快照状态')

  const cold = map.get('s-cold')
  assert.equal(cold.cold, true)
  assert.equal(cold.status, 'idle')
  assert.match(cold.statusText, /未激活/)
  assert.equal(cold.updatedAt, new Date(AT - 20 * HOUR).toISOString())

  assert.equal(map.has('s-blank'), false, '从没开始过的空会话不是可管理对象')
  assert.equal(body.source.sessions, 'sessionController.list')
  assert.equal(body.source.states, 'sessionController.state')
  assert.match(body.source.lineage, /api\/tiers/)

  const flaky = map.get('s-flaky')
  assert.equal(flaky.stateKnown, false)
  assert.equal(flaky.status, 'run', '状态读不到时保留 tiers 的运行态，不编新的')
  assert.match(body.degraded.reason, /状态读取失败/)
  assert.equal(JSON.stringify(body).includes('SECRET'), false, '原始异常文本不进响应')
})

test('M0：跨机会话标注只读不可控，远端分组带 only-read 说明', async () => {
  const { deps } = happyDeps()
  const body = await buildButlerSessions(deps)
  const remoteNode = byId(body.nodes).get('server:remote-1')
  assert.equal(remoteNode.readonly, true)
  assert.equal(remoteNode.controllable, false)
  assert.equal(remoteNode.device, 'server')

  const server = body.remote.find(row => row.instanceId === 'server')
  assert.equal(server.link, 'up')
  assert.equal(server.readonly, true)
  assert.equal(server.controllable, false)
  assert.match(server.note, /只读不可控/)
  assert.equal(server.sessions.length, 1)
  assert.equal(server.sessions[0].sessionId, 'remote-1')
  assert.equal(server.sessions[0].readonly, true)
  assert.match(body.remoteNote, /只读/)

  const s5 = body.remote.find(row => row.instanceId === 's5')
  assert.equal(s5.link, 'down')
  assert.deepEqual(s5.sessions, [])
})

test('M0 binding：默认最近有主人消息的根会话；配置 pinned 优先；找不到如实 available:false', async () => {
  const { deps } = happyDeps()
  const recent = await buildButlerSessions(deps)
  assert.equal(recent.binding.available, true)
  assert.equal(recent.binding.sessionId, 's-main', 'lastPromptAt 最新的根会话；子代理/空会话不参与')
  assert.equal(recent.binding.targetMode, 'recent-root')
  assert.equal(recent.binding.resolvedBy, 'recent-root')
  assert.equal(recent.binding.title, '主控会话')

  const pinnedDeps = happyDeps({ config: { butler: { sessionId: 's-cold', agentPreset: 'butler-lead' } } }).deps
  const pinned = await buildButlerSessions(pinnedDeps)
  assert.equal(pinned.binding.sessionId, 's-cold')
  assert.equal(pinned.binding.targetMode, 'pinned')
  assert.equal(pinned.binding.resolvedBy, 'config')
  assert.equal(pinned.binding.agentPreset, 'butler-lead', '领导预设随 binding 给页面标注')
  assert.equal(pinned.write.agentPreset, 'butler-lead')
  assert.equal(pinned.write.enabled, false)

  const missing = await buildButlerSessions(happyDeps({ config: { butler: { sessionId: 'no-such-session' } } }).deps)
  assert.equal(missing.binding.available, false)
  assert.equal(missing.binding.sessionId, 'no-such-session')
  assert.match(missing.binding.reason, /不在可见会话列表/)
  assert.equal(missing.binding.title, null, '找不到就不编标题')
})

test('M0：sessionController.list 不可用时退回 tiers 选根，并如实降级', async () => {
  const { deps } = happyDeps()
  delete deps.controller
  const body = await buildButlerSessions(deps)
  assert.equal(body.binding.available, true)
  assert.equal(body.binding.sessionId, 's-main')
  assert.equal(body.binding.resolvedBy, 'recent-root(tiers)')
  assert.match(body.degraded.reason, /sessionController.list/)
  // 没有 list 时仍显示 tiers 的活会话，但不冒充有 updatedAt
  const map = byId(body.nodes)
  assert.equal(map.get('s-main').updatedAt, null)
  assert.equal(body.nodes.some(node => node.id === 's-cold'), false)
})

test('M0：会话列表为空时 binding 不编会话', async () => {
  const { deps } = happyDeps({
    tiers: { read: async () => ({ ...tierBody(), nodes: [], source: { ...tierBody().source, remote: [] } }) },
  })
  deps.controller = () => ({ async list() { return { items: [] } }, async state() { throw new Error('n/a') } })
  const body = await buildButlerSessions(deps)
  assert.equal(body.binding.available, false)
  assert.equal(body.binding.sessionId, null)
  assert.match(body.binding.reason, /没有可见的根会话/)
  assert.deepEqual(body.nodes, [])
  assert.deepEqual(body.counts, { 0: 1, 1: 0, 2: 0, 3: 0 })
})

test('M0：兜底契约字段齐全（服务全缺也不抛）', async () => {
  const body = await buildButlerSessions({})
  assert.equal(typeof body.generatedAt, 'string')
  assert.equal(body.binding.available, false)
  assert.ok(Array.isArray(body.nodes))
  assert.ok(Array.isArray(body.remote))
  assert.equal(typeof body.degraded.reason, 'string')
})

test('M0：resolveBinding 直接调用也遵守同一口径', () => {
  const summaries = [summary('root-a', { values: { title: 'A', sessionListMetadata: { blank: false, lastPromptAt: AT - 5 * MIN } } })]
  const summaryById = new Map(summaries.map(row => [row.sessionId, row]))
  const binding = resolveBinding({ config: { sessionId: '', targetMode: 'recent-root' }, summaries, summaryById, nodeById: new Map(), rootId: 'pc-ky614', degraded: [] })
  assert.equal(binding.sessionId, 'root-a')
  assert.equal(binding.available, true)
})

/* ─────────────────────────── E. M1 真实对话 ─────────────────────────── */

test('M1：events 归一化——主人/系统注入/助手思考/工具卡配对/大输出截断', () => {
  const page = dialogPage()
  const out = normalizeDialogEvents(page.records)
  const roles = out.messages.map(message => message.role)
  assert.deepEqual(roles, ['user', 'notice', 'assistant', 'assistant'], '工具卡挂在所属助手消息里，不额外占一条消息')
  assert.equal(out.tools, 2, '一条正常配对 + 一条无对应调用的结果（partial）')

  const human = out.messages[0]
  assert.equal(human.text, '把面板改成驾驶舱')
  assert.equal(human.injected, undefined)
  const injected = out.messages[1]
  assert.equal(injected.injected, true)
  assert.equal(injected.source, 'context')

  const first = out.messages[2]
  assert.equal(first.text, '好，先做 M0/M1，只读。')
  assert.match(first.thinking, /可行性报告/)
  assert.equal(first.tools.length, 1)
  assert.equal(first.tools[0].name, 'read')
  assert.match(first.tools[0].args, /a\.md/)
  assert.match(first.tools[0].result.summary, /^X+…$/)
  assert.ok(first.tools[0].result.summary.length <= TOOL_RESULT_MAX, '结果摘要被截断到上限内')
  assert.ok(first.tools[0].args.length <= TOOL_ARG_MAX, '参数摘要被截断到上限内')
  assert.equal(first.tools[0].result.isError, false)

  const second = out.messages[3]
  assert.equal(second.text, '改完了。')
  assert.equal(second.tools.length, 1, '无对应 tool/call 的结果挂在当前步的助手消息上')
  assert.equal(second.tools[0].partial, true)
  assert.equal(second.tools[0].result.isError, true)
  assert.equal(second.tools[0].result.code, 'ENOENT')
})

test('M1：正文/思考超长截断；非文本块用占位符；未知事件不渲染', () => {
  const long = 'A'.repeat(MESSAGE_TEXT_MAX * 2)
  const out = normalizeDialogEvents([
    { type: 'event', event: { type: 'user/message', seq: 1, time: AT, data: { source: { kind: 'user' }, content: [{ type: 'text', text: long }, { type: 'image' }] } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: AT, data: { message: { content: [{ type: 'reasoning', text: 'T'.repeat(9999) }, { type: 'text', text: 'ok' }] } } } },
    { type: 'event', event: { type: 'turn/start', seq: 3, time: AT, data: { turn: 1 } } },
    { type: 'event', event: { type: 'weird/future', seq: 4, time: AT, data: {} } },
  ])
  assert.equal(out.messages.length, 2)
  assert.ok(out.messages[0].text.length <= MESSAGE_TEXT_MAX)
  assert.ok(out.messages[1].thinking.length <= 4000)
  const imageOnly = normalizeDialogEvents([
    { type: 'event', event: { type: 'user/message', seq: 1, time: AT, data: { source: { kind: 'user' }, content: [{ type: 'image' }] } } },
  ])
  assert.equal(imageOnly.messages[0].text, '[图片]', '图片/文件用占位符，不塞二进制')
})

/* ─────────────────────── 0.9.0 A：系统注入折叠（host 字段） ─────────────────────── */

test('0.9.0 A：summarizeInjection 去包装行 → 首行 → 去 Markdown → 压空白 → 截 80 码点', () => {
  const text = '<openviking-context source="profile">\n# 用户画像与偏好\n\n- 用户名 ky614\n</openviking-context>'
  const folded = summarizeInjection(text)
  assert.equal(folded.summary, '用户画像与偏好')
  assert.equal(folded.headline, '用户画像与偏好')
  assert.equal(folded.lines, 5)
  assert.equal(folded.chars, Array.from(text).length)

  const long = summarizeInjection('x'.repeat(NOTICE_SUMMARY_MAX + 30))
  assert.equal(Array.from(long.summary).length, NOTICE_SUMMARY_MAX, '摘要截到 80 码点')

  const noHeadline = summarizeInjection('<openviking-context source="profile">\n\n</openviking-context>')
  assert.match(noHeadline.summary, /^\d+ 行 · \d+ 字符$/, '没有可读首行用「N 行 · M 字符」兜底')
  assert.equal(noHeadline.headline, '')

  assert.deepEqual(summarizeInjection(undefined), { summary: '', headline: '', lines: 0, chars: 0 }, '空文本不编摘要')
  assert.deepEqual(summarizeInjection('   \n  '), { summary: '', headline: '', lines: 0, chars: 6 })
})

test('0.9.0 A：injectionLabel 按 source/form 映射中文标签', () => {
  assert.equal(injectionLabel('plugin:openviking-memory', 'instructions'), '记忆画像')
  assert.equal(injectionLabel('plugin:openviking-memory', 'recall'), '记忆召回')
  assert.equal(injectionLabel('plugin:openviking-memory', 'session-history'), '会话历史指针')
  assert.equal(injectionLabel('plugin:something-else', ''), '插件注入')
  assert.equal(injectionLabel('agent-instructions', 'instructions'), '指令文件')
  assert.equal(injectionLabel('skill-invocation', ''), '技能注入')
  assert.equal(injectionLabel('session-reference', ''), '跨会话召回')
  assert.equal(injectionLabel('time-context', ''), '时间上下文')
  assert.equal(injectionLabel('', ''), '系统注入')
  assert.equal(injectionLabel('future-kind', ''), '系统注入', '未知 source 不抛')
})

test('0.9.0 A：normalizeDialogEvents 的 notice 带全字段且保留完整 text', () => {
  const text = '<openviking-context source="profile">\n用户画像与偏好\n' + '长'.repeat(1000) + '\n</openviking-context>'
  const out = normalizeDialogEvents([{
    type: 'event',
    event: {
      type: 'user/message', seq: 1, time: AT,
      data: { source: { kind: 'plugin:openviking-memory', form: 'instructions' }, content: [{ type: 'text', text }] },
    },
  }])
  const notice = out.messages[0]
  assert.equal(notice.role, 'notice')
  assert.equal(notice.injected, true)
  assert.equal(notice.source, 'plugin:openviking-memory')
  assert.equal(notice.sourceLabel, '记忆画像')
  assert.equal(notice.form, 'instructions')
  assert.equal(notice.summary, '用户画像与偏好')
  assert.equal(notice.headline, '用户画像与偏好')
  assert.equal(notice.lines, 4)
  assert.equal(notice.chars, Array.from(text).length)
  assert.equal(notice.text, text, '折叠只影响展示，host 不丢原文')
})

test('0.9.0：assistant/message 带出合法 turn/step（缺省不带）', () => {
  const out = normalizeDialogEvents([
    { type: 'event', event: { type: 'assistant/message', seq: 1, time: AT, data: { turn: 2, step: 3, message: { content: [{ type: 'text', text: 'x' }] } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: AT, data: { message: { content: [{ type: 'text', text: 'y' }] } } } },
  ])
  assert.equal(out.messages[0].turn, 2)
  assert.equal(out.messages[0].step, 3)
  assert.equal(out.messages[1].turn, undefined)
  assert.equal(out.messages[1].step, undefined)
})

test('0.9.0：SSE 目标解析——query 优先、否则 binding、都没有给 error', () => {
  assert.deepEqual(resolveStreamTarget(null, 'session-a'), { sessionId: 'session-a' })
  assert.deepEqual(resolveStreamTarget({ binding: { available: true, sessionId: 'bound' } }, ''), { sessionId: 'bound' })
  assert.deepEqual(resolveStreamTarget({ binding: { available: true, sessionId: 'bound' } }, '  '), { sessionId: 'bound' })
  assert.ok(resolveStreamTarget({ binding: { available: false } }, '').error)
  assert.ok(resolveStreamTarget(null, '').error)
})

test('M1：绑定最近根会话，返回 state/messages/cursor/hasMore 且不留内部异常', async () => {
  const { deps } = happyDeps()
  const body = await buildButlerDialog(deps)
  assert.equal(body.available, true)
  assert.equal(body.sessionId, 's-main')
  assert.equal(body.title, '主控会话')
  assert.equal(body.resolvedBy, 'recent-root')
  assert.equal(body.cursor, 8)
  assert.equal(body.hasMore, true)
  assert.equal(body.state.running, true)
  assert.equal(body.state.queue, 2)
  assert.equal(body.counts.messages, 4)
  assert.equal(JSON.stringify(body).includes('SECRET'), false)
})

test('M1：sessionId 选择 + 子代理地址契约（parentSessionId/childSessionId/mode）', async () => {
  const { deps, calls } = happyDeps()
  await buildButlerDialog(deps, { sessionId: 's-child' })
  assert.equal(calls.events.length, 1)
  const request = calls.events[0]
  assert.equal(request.address.kind, 'subagent')
  assert.equal(request.address.parentSessionId, 's-main')
  assert.equal(request.address.childSessionId, 's-child')
  assert.equal(request.address.mode, 'unknown', '缓存缺 mode 时给 unknown，交给官方 address 校验')

  const { deps: deps2, calls: calls2 } = happyDeps()
  await buildButlerDialog(deps2, { sessionId: 's-main' })
  assert.equal(calls2.events[0].address.kind, 'session')
  assert.equal(calls2.events[0].address.sessionId, 's-main')
})

test('M1：limit/before 窗口收敛并透传到 events()', async () => {
  const { deps, calls } = happyDeps()
  await buildButlerDialog(deps, { limit: '7', before: '42' })
  assert.equal(calls.events[0].maxMessages, 7)
  assert.equal(calls.events[0].beforeSeq, 42)

  await buildButlerDialog(deps, { limit: '999', before: '-3' })
  assert.equal(calls.events[1].maxMessages, BUTLER_DIALOG_MAX_LIMIT)
  assert.equal('beforeSeq' in calls.events[1], false)

  await buildButlerDialog(deps, { limit: '0', before: 'abc' })
  assert.equal(calls.events[2].maxMessages, BUTLER_DIALOG_DEFAULT_LIMIT)
})

test('M1：冷会话不激活（不调 state()）且对话照常可读', async () => {
  const { deps, calls } = happyDeps({ config: { butler: { sessionId: 's-cold' } } })
  const body = await buildButlerDialog(deps)
  assert.equal(body.available, true)
  assert.equal(body.sessionId, 's-cold')
  assert.equal(body.stateKnown, true)
  assert.match(body.state.statusText, /未激活/)
  assert.equal(calls.state.includes('s-cold'), false, '冷会话不调 state()，不碰磁盘/不激活')
})

test('M1：跨机会话与不存在的会话都给 available:false + 人话原因，不编对话', async () => {
  const { deps } = happyDeps()
  const remote = await buildButlerDialog(deps, { sessionId: 'server:remote-1' })
  assert.equal(remote.available, false)
  assert.match(remote.reason, /跨机会话只读/)
  assert.deepEqual(remote.messages, [])

  const { deps: deps2 } = happyDeps()
  deps2.controller = () => ({
    async list() { return { items: [] } },
    async state() { throw Object.assign(new Error('n/a'), { code: 'session/not-found' }) },
    async events() { throw Object.assign(new Error('session "x" not found at C:\\secret'), { code: 'session/not-found' }) },
  })
  const missing = await buildButlerDialog(deps2, { sessionId: 'ghost' })
  assert.equal(missing.available, false)
  assert.match(missing.reason, /会话不存在/)
  assert.equal(JSON.stringify(missing).includes('C:\\\\secret'), false, '原始异常文本不外泄')
})

test('M1：没有 controller / 没有绑定 / 事件结构不符 → available:false', async () => {
  const noController = await buildButlerDialog({})
  assert.equal(noController.available, false)
  assert.match(noController.reason, /sessionController\.events/)

  const empty = happyDeps({ tiers: { read: async () => ({ ...tierBody(), nodes: [], source: { ...tierBody().source, remote: [] } }) } })
  empty.deps.controller = () => ({
    async list() { return { items: [] } },
    async state() { return sessionState() },
    async events() { return dialogPage() },
  })
  const noBinding = await buildButlerDialog(empty.deps)
  assert.equal(noBinding.available, false)
  assert.match(noBinding.reason, /没有可见的根会话/)

  const broken = happyDeps()
  broken.deps.controller = () => ({
    async list() { return { items: broken.summaries } },
    async state() { return sessionState() },
    async events() { return { nope: true } },
  })
  const mismatch = await buildButlerDialog(broken.deps)
  assert.equal(mismatch.available, false)
  assert.match(mismatch.reason, /结构不符/)
})

test('M1：状态读取失败时对话仍显示，并如实降级', async () => {
  const { deps, summaries } = happyDeps()
  deps.controller = () => ({
    async list() { return { items: summaries } },
    async state() { throw Object.assign(new Error('state down'), { code: 'gateway/internal' }) },
    async events() { return dialogPage() },
  })
  const body = await buildButlerDialog(deps, { sessionId: 's-main' })
  assert.equal(body.available, true)
  assert.equal(body.messages.length, 4)
  assert.equal(body.state, null)
  assert.match(body.degraded.reason, /状态读取失败/)
  assert.equal(JSON.stringify(body).includes('state down'), false)
})

test('M1：分页开头的孤儿工具结果仍保留事实（partial）', () => {
  const out = normalizeDialogEvents(dialogPage().records.filter(record => record.event.seq === 8))
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].role, 'tool')
  assert.equal(out.messages[0].tools[0].partial, true)
})

/* ─────────────────────────── F. reader 缓存 / 单飞 ─────────────────────────── */

test('reader：M0 缓存 4 秒、单飞；对话轮询复用同一份会话清单不重复 list()', async () => {
  let now = AT
  const { deps, calls } = happyDeps()
  const reader = createButlerReader({ ...deps, now: () => now })
  const [a, b] = await Promise.all([reader.readSessions(), reader.readSessions()])
  assert.equal(a.generatedAt, b.generatedAt)
  assert.equal(calls.list, 1, '并发 M0 单飞：只打一次 sessionController.list()')
  const dialog1 = await reader.readDialog()
  const dialog2 = await reader.readDialog({ sessionId: 's-child' })
  assert.equal(calls.list, 1, '对话轮询复用 M0 缓存，不再列会话')
  assert.equal(dialog1.sessionId, 's-main')
  assert.equal(dialog2.sessionId, 's-child')

  const cachedRead = await reader.readSessions()
  assert.equal(cachedRead.source.cached, true)
  now = AT + 5000
  await reader.readSessions()
  assert.equal(calls.list, 2, '过了缓存窗口才重新读')
  reader.clear()
  await reader.readSessions()
  assert.equal(calls.list, 3, 'clear 后强制重读')
})

test('reader：组装层意外异常时给兜底而不是抛错', async () => {
  const reader = createButlerReader({
    controller: () => { throw new Error('boom') },
    tiers: () => { throw new Error('also boom') },
    sessions: () => { throw new Error('sessions boom') },
    now: () => AT,
  })
  const body = await reader.readSessions()
  assert.equal(body.binding.available, false)
  assert.equal(typeof body.degraded.reason, 'string')
  assert.equal(body.nodes.length, 0)
  assert.equal(JSON.stringify(body).includes('boom'), false, '原始异常文本不进响应')
})

/* ─────────────────────────── G. 路由 ─────────────────────────── */

test('路由：GET api/butler/sessions 200 JSON，HEAD 无体，POST 405 带 Allow', async () => {
  const { deps } = happyDeps()
  const resource = mount({
    sessions: () => ({
      list: () => [
        { id: 's-main', header: { version: 4, id: 's-main', createdAt: AT - 1000 } },
      ],
    }),
    agents: () => ({ list: () => [{ id: 's-main', status: 'running' }] }),
    projections: () => ({ snapshot: session => ({ asOfSeq: 1, values: { title: '主控会话' } }) }),
    sessionController: () => deps.controller(),
  })
  await withRouteServer(resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_SESSIONS_FILE}`)
    assert.equal(got.status, 200)
    assert.match(got.headers.get('content-type'), /^application\/json/)
    assert.equal(got.headers.get('cache-control'), 'no-store')
    const body = JSON.parse(got.text)
    for (const key of ['generatedAt', 'root', 'source', 'counts', 'nodes', 'remote', 'binding']) {
      assert.ok(key in body, '缺字段 ' + key)
    }
    assert.equal(body.root.id, 'pc-ky614')
    assert.ok(body.nodes.some(node => node.id === 's-main' && node.status === 'run'))

    const head = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_SESSIONS_FILE}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.text, '')

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const rejected = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_SESSIONS_FILE}`, { method })
      assert.equal(rejected.status, 405)
      assert.equal(rejected.headers.get('allow'), 'GET, HEAD')
      assert.deepEqual(JSON.parse(rejected.text), { ok: false, error: 'method-not-allowed' })
    }
  })
})

test('路由：GET api/butler/dialog 读真实形状；query 透传；405 与 JSON 404', async () => {
  const { deps, calls } = happyDeps()
  const resource = mount({
    sessions: () => ({
      list: () => [{ id: 's-main', header: { version: 4, id: 's-main', createdAt: AT - 1000 } }],
    }),
    agents: () => ({ list: () => [{ id: 's-main', status: 'running' }] }),
    projections: () => ({ snapshot: () => ({ asOfSeq: 1, values: { title: '主控会话' } }) }),
    sessionController: () => deps.controller(),
  })
  await withRouteServer(resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_DIALOG_FILE}?sessionId=s-main&limit=5&before=9`)
    assert.equal(got.status, 200)
    const body = JSON.parse(got.text)
    assert.equal(body.available, true)
    assert.equal(body.sessionId, 's-main')
    assert.equal(body.title, '主控会话')
    assert.equal(body.cursor, 8)
    assert.equal(body.hasMore, true)
    assert.ok(body.messages.length > 0)
    assert.equal(calls.events[0].maxMessages, 5)
    assert.equal(calls.events[0].beforeSeq, 9)

    const rejected = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_DIALOG_FILE}`, { method: 'POST' })
    assert.equal(rejected.status, 405)
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD')

    const unknown = await hit(baseUrl, `${ROUTE_PREFIX}/api/butler/nope`)
    assert.equal(unknown.status, 404)
    assert.deepEqual(JSON.parse(unknown.text), { ok: false, error: 'not-found' })
  })
})

test('路由：服务全缺时两个新路由仍是 200 + 结构化降级（页面不白屏）', async () => {
  const resource = mount({})
  await withRouteServer(resource, async baseUrl => {
    const sessions = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_SESSIONS_FILE}`)
    assert.equal(sessions.status, 200)
    const sessionsBody = JSON.parse(sessions.text)
    assert.equal(sessionsBody.binding.available, false)
    assert.equal(sessionsBody.nodes.length, 0)

    const dialog = await hit(baseUrl, `${ROUTE_PREFIX}/${BUTLER_DIALOG_FILE}`)
    assert.equal(dialog.status, 200)
    const dialogBody = JSON.parse(dialog.text)
    assert.equal(dialogBody.available, false)
    assert.ok(dialogBody.reason.length > 0)
    assert.deepEqual(dialogBody.messages, [])
  })
})

/* ─────────────────────────── H. 零写操作红线 ─────────────────────────── */

test('零写操作：lib/butler.js 不出现任何写 API 名字（M0/M1 只读）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(resolve(ROOT, 'lib', 'butler.js'), 'utf8')
  const forbidden = ['.prompt({', '.prompt(', '.cancel(', '.interrupt(', 'archiveSession(', 'updateTask(', 'drainDescendants(', 'subagents.prompt', 'subagents.interrupt']
  for (const name of forbidden) {
    assert.equal(source.includes(name), false, 'butler.js 不得调用写 API：' + name)
  }
  assert.match(source, /sessionController\.events|controller\.events/, '只读对话走 events')
})

/* ─────────────────────────── I. 0.8.0 M2 写通道 ─────────────────────────── */

const BUTLER_CONFIG = { butler: { sessionId: 's-butler', allowWrite: true } }
const TEST_TOKEN = 'test-write-token'
const SAY_PATH = `${ROUTE_PREFIX}/${BUTLER_SAY_FILE}`
const SESSION_PATH = `${ROUTE_PREFIX}/${BUTLER_SESSION_FILE}`

/** 假 sessionController：prompt/create/rename 可编排，记录调用参数。 */
function fakeController(overrides = {}) {
  const calls = { prompt: [], create: [], rename: [], modelCatalog: 0, selectModel: [], list: 0 }
  const controller = {
    async modelCatalog() {
      calls.modelCatalog += 1
      if (overrides.catalogError) throw overrides.catalogError
      return overrides.catalog ?? {
        default: { provider: 'deepseek', model: 'm-flash', reasoningEffort: 'max' },
        routableProviders: ['deepseek'],
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
          { id: 'm-flash', name: 'M Flash', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } },
          { id: 'm-pro', name: 'M Pro' },
        ] }],
        failures: [],
      }
    },
    async list() {
      calls.list += 1
      return overrides.list ?? { items: [{
        sessionId: 's-butler',
        projections: { values: {
          modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'm-pro', reasoningEffort: 'max' } },
          permissions: { currentValue: 'danger-full-access' },
        } },
      }] }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      if (overrides.selectModelError) throw overrides.selectModelError
      return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }
    },
    async prompt(request) {
      calls.prompt.push(request)
      if (overrides.promptError) throw overrides.promptError
      return { accepted: true }
    },
    async create(request) {
      calls.create.push(request)
      if (overrides.createError) throw overrides.createError
      return overrides.created ?? { sessionId: 's-new-butler' }
    },
    async rename(request) {
      calls.rename.push(request)
      if (overrides.renameError) throw overrides.renameError
      return { title: request.title, seq: 1 }
    },
  }
  return { controller, calls }
}

function writeChannel(overrides = {}) {
  const clock = { now: AT }
  const fake = fakeController(overrides.controller)
  // 深拷贝配置：ensureSession 会原地更新 butler.sessionId，不能污染模块级常量。
  const config = overrides.config === undefined
    ? JSON.parse(JSON.stringify(BUTLER_CONFIG))
    : JSON.parse(JSON.stringify(overrides.config))
  const channel = createWriteChannel({
    controller: () => (overrides.controller === null ? null : fake.controller),
    config,
    token: overrides.token ?? TEST_TOKEN,
    now: () => clock.now,
    fsDeps: overrides.fsDeps,
  })
  return { channel, calls: fake.calls, clock }
}

/** 从插件路由返回的页面 HTML 里取出宿主注入的写通道配置（token 只应在这里出现）。 */
async function injectedWriteConfig(resource) {
  const response = await resource(new Request('http://127.0.0.1/dsh-html-panel/index.html'))
  const text = await response.text()
  const match = /\/\*__DSH_PANEL_WRITE__\*\/(\{[^<]*\})/.exec(text)
  assert.ok(match, '页面里应有注入的写通道配置')
  return JSON.parse(match[1])
}

function sayHeaders(overrides = {}) {
  return { 'content-type': 'application/json', 'x-butler-write-token': TEST_TOKEN, ...overrides }
}

/** 直接调通道 say：返回 {status, body}。 */
function say(channel, body, headers = sayHeaders()) {
  return channel.say(headers, { sessionId: 's-butler', content: '连通性测试', ...body })
}

/** 临时目录里造一份 cordis.patch.yml 样本（两行插件 + panel 块）。 */
async function makeConfigFixture(withButler) {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-panel-080-'))
  const lines = [
    '- id: mesh-plugin',
    '  config:',
    "    token: 'board-token-should-never-change'",
    '- id: dsh-html-panel',
    '  config:',
    '    board:',
    "      endpoint: 'http://127.0.0.1:13090'",
    "      token: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'",
    '      timeoutMs: 4000',
  ]
  if (withButler) {
    lines.push('    butler:', "      sessionId: 's-old'", '      targetMode: pinned', '      allowWrite: true')
  }
  lines.push('- id: mobile-access', '  disabled: true', '')
  const path = join(dir, 'cordis.patch.yml')
  await writeFile(path, lines.join('\n'), 'utf8')
  return { dir, path }
}

test('0.8.0 写配置：readWriteOptions 默认关闭、只认 true、label/configPath 归一', () => {
  const defaults = readWriteOptions(undefined)
  assert.equal(defaults.allowWrite, false)
  assert.equal(defaults.sessionId, '')
  assert.equal(defaults.configPath, '')
  assert.equal(defaults.label, BUTLER_LABEL_DEFAULT)
  const parsed = readWriteOptions({
    butler: { sessionId: ' s-butler ', allowWrite: true, configPath: ' C:\\x\\cordis.patch.yml ', label: ' 大管家 · 常驻 ' },
  })
  assert.deepEqual(parsed, {
    sessionId: 's-butler', allowWrite: true, configPath: 'C:\\x\\cordis.patch.yml',
    label: '大管家 · 常驻', cwd: '', agentPreset: '',
  })
  for (const value of ['true', 1, 'yes', null, {}]) {
    assert.equal(readWriteOptions({ butler: { allowWrite: value } }).allowWrite, false, 'allowWrite=' + JSON.stringify(value))
  }
})

test('0.8.0 写配置：没有 butler 段时插入，panel 以外每行一字节不变（含 board.token 行）', async () => {
  const { path } = await makeConfigFixture(false)
  const original = await readFile(path, 'utf8')
  const rewritten = rewriteButlerSessionId(original, 's-new-butler')
  assert.equal(rewritten.ok, true, rewritten.reason)
  assert.deepEqual(rewritten.changed, ['butler', 'butler.sessionId', 'butler.targetMode'])
  const output = rewritten.text
  // 其它插件行 + board.token 行原样保留。
  for (const line of original.split('\n')) {
    if (line.includes('dsh-html-panel') || line.includes('butler:')) continue
    if (line.includes('sessionId') || line.includes('targetMode')) continue
    assert.ok(output.includes(line), '原样行丢失：' + line)
  }
  assert.ok(output.includes("    butler:\n      sessionId: 's-new-butler'\n      targetMode: pinned"))
  // 幂等：再跑一遍不变。
  const again = rewriteButlerSessionId(output, 's-new-butler')
  assert.equal(again.ok, true, again.reason)
  assert.equal(again.text, output)
})

test('0.8.0 写配置：已有 butler 段时只改 sessionId/targetMode，保留 allowWrite', async () => {
  const { path } = await makeConfigFixture(true)
  const original = await readFile(path, 'utf8')
  const rewritten = rewriteButlerSessionId(original, 's-rebuilt')
  assert.equal(rewritten.ok, true, rewritten.reason)
  assert.deepEqual(rewritten.changed, ['butler.sessionId', 'butler.targetMode'])
  assert.match(rewritten.text, /sessionId: 's-rebuilt'/)
  assert.match(rewritten.text, /targetMode: pinned/)
  assert.match(rewritten.text, /allowWrite: true/)
  assert.ok(rewritten.text.includes("token: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'"))
})

test('0.8.0 写配置：拒绝不安全 sessionId / 缺 panel 块 / 缺 config 段', () => {
  assert.equal(rewriteButlerSessionId('- id: x\n  config: {}\n', 'a-b-c').ok, false)
  for (const bad of ['a\nb', "a'b", 'x'.repeat(200), '', '中文']) {
    const result = rewriteButlerSessionId('- id: dsh-html-panel\n  config:\n    board:\n      timeoutMs: 1\n', bad)
    assert.equal(result.ok, false, 'sessionId 应被拒绝：' + JSON.stringify(bad))
  }
  const noConfig = rewriteButlerSessionId('- id: dsh-html-panel\n  disabled: true\n', 's-new')
  assert.equal(noConfig.ok, false)
  assert.match(noConfig.reason, /config/)
})

test('0.8.0 写配置：persistButlerSessionId 备份 + 原子写 + 读回校验；其它行不变', async () => {
  const { dir, path } = await makeConfigFixture(true)
  const original = await readFile(path, 'utf8')
  const result = await persistButlerSessionId({ configPath: path, sessionId: 's-persisted', nowMs: AT })
  assert.equal(result.updated, true, result.reason)
  assert.equal(result.validated, true)
  assert.equal(result.backup, 'cordis.patch.yml' + CONFIG_BACKUP_INFIX + stampOf(AT))
  const backupText = await readFile(path + CONFIG_BACKUP_INFIX + stampOf(AT), 'utf8')
  assert.equal(backupText, original, '备份必须是改写前原文')
  const written = await readFile(path, 'utf8')
  assert.match(written, /sessionId: 's-persisted'/)
  assert.ok(written.includes("token: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'"))
  // 再写一次同一 id：不重复写（unchanged），不新造备份。
  const again = await persistButlerSessionId({ configPath: path, sessionId: 's-persisted', nowMs: AT })
  assert.equal(again.updated, true)
  assert.equal(again.unchanged, true)
  assert.equal(await readFile(path, 'utf8'), written)
  await rm(dir, { recursive: true, force: true })
})

test('0.8.0 写配置：configPath 缺失 / 非绝对路径 / 文件不存在都如实失败不写', async () => {
  const none = await persistButlerSessionId({ configPath: '', sessionId: 's-x' })
  assert.equal(none.updated, false)
  assert.match(none.reason, /configPath/)
  const relative = await persistButlerSessionId({ configPath: 'cordis.patch.yml', sessionId: 's-x' })
  assert.equal(relative.updated, false)
  assert.match(relative.reason, /绝对路径/)
  const missing = await persistButlerSessionId({ configPath: join(tmpdir(), 'definitely-not-there-080', 'cordis.patch.yml'), sessionId: 's-xxxxx' })
  assert.equal(missing.updated, false)
  assert.match(missing.reason, /读不到/)
})

test('0.8.0 say：token 缺失/错误 → 401；allowWrite 关闭 → 403 write-disabled', async () => {
  const { channel } = writeChannel()
  const missing = await channel.say({ 'content-type': 'application/json' }, { sessionId: 's-butler', content: 'x' })
  assert.equal(missing.status, 401)
  assert.equal(missing.body.code, 'write-token-missing')
  const wrong = await channel.say({ 'x-butler-write-token': 'nope' }, { sessionId: 's-butler', content: 'x' })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body.code, 'write-token-invalid')

  const closed = writeChannel({ config: { butler: { sessionId: 's-butler', allowWrite: false } } })
  const disabled = await say(closed.channel, {})
  assert.equal(disabled.status, 403)
  assert.equal(disabled.body.code, 'write-disabled')
  assert.equal(disabled.body.retryable, false)
  assert.equal(closed.calls.prompt.length, 0)
})

test('0.8.0 say：只允许专属会话（白名单外 403）；空内容/超长 400', async () => {
  const { channel, calls } = writeChannel()
  const foreign = await channel.say(sayHeaders(), { sessionId: 's-other', content: 'hi' })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.body.code, 'not-butler-session')
  const blank = await say(channel, { content: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(blank.body.code, 'empty-content')
  const tooLong = await say(channel, { content: 'x'.repeat(SAY_CONTENT_MAX + 1) })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.body.code, 'content-too-long')
  // 边界：正好 4000 字可以发。
  const ok = await say(channel, { content: 'x'.repeat(SAY_CONTENT_MAX), requestId: 'rid-limit-ok' })
  assert.equal(ok.status, 200)
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].content[0].text.length, SAY_CONTENT_MAX)
})

test('0.8.0 say：成功入队返回 accepted/mode/sessionId/requestId，mode 固定 queue', async () => {
  const { channel, calls } = writeChannel()
  const result = await say(channel, { content: '连通性测试，请只回复 OK', requestId: 'rid-1' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, accepted: true, mode: 'queue', sessionId: 's-butler', requestId: 'rid-1' })
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].sessionId, 's-butler')
  assert.equal(calls.prompt[0].mode, 'queue')
  assert.equal(calls.prompt[0].requestId, 'rid-1')
  assert.deepEqual(calls.prompt[0].content, [{ type: 'text', text: '连通性测试，请只回复 OK' }])
})

test('0.8.0 say：同 requestId 幂等去重（只调一次 prompt），第二个请求标 deduped', async () => {
  const { channel, calls } = writeChannel()
  const first = await say(channel, { content: '一次', requestId: 'rid-dup' })
  const second = await say(channel, { content: '一次', requestId: 'rid-dup' })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.deduped, true)
  assert.equal(calls.prompt.length, 1)
})

test('0.8.0 say：限流 10 条/分钟（第 11 条 429 带 retryAfterSeconds）', async () => {
  const { channel, clock } = writeChannel()
  for (let index = 0; index < SAY_RATE_LIMIT; index += 1) {
    const ok = await say(channel, { content: '第 ' + index, requestId: 'rid-rate-' + index })
    assert.equal(ok.status, 200)
  }
  const limited = await say(channel, { content: '第 11 条', requestId: 'rid-rate-over' })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 'rate-limited')
  assert.equal(limited.body.retryable, true)
  assert.ok(limited.body.retryAfterSeconds >= 1)
  // 窗口滑过后恢复。
  clock.now = AT + SAY_RATE_WINDOW_MS + 1
  const recovered = await say(channel, { content: '窗口外', requestId: 'rid-rate-after' })
  assert.equal(recovered.status, 200)
})

test('0.8.0 say：宿主错误映射为结构化回执（不泄露原始异常文本）', async () => {
  const notFound = writeChannel({ controller: { promptError: Object.assign(new Error('SECRET C:\\x path'), { code: 'session/not-found' }) } })
  const missing = await say(notFound.channel, { requestId: 'rid-e1' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'session-not-found')
  assert.equal(missing.body.retryable, false)
  assert.equal(JSON.stringify(missing.body).includes('SECRET'), false)

  const busy = writeChannel({ controller: { promptError: Object.assign(new Error('busy'), { code: 'session/agent-busy' }) } })
  const busyResult = await say(busy.channel, { requestId: 'rid-e2' })
  assert.equal(busyResult.status, 409)
  assert.equal(busyResult.body.retryable, true)

  const internal = writeChannel({ controller: { promptError: new Error('boom at C:\\deep\\path') } })
  const internalResult = await say(internal.channel, { requestId: 'rid-e3' })
  assert.equal(internalResult.status, 502)
  assert.equal(internalResult.body.code, 'prompt-failed')
  assert.equal(JSON.stringify(internalResult.body).includes('C:'), false)
  // 失败的 requestId 不缓存：换新 id 可重试。
  const retried = await say(internal.channel, { requestId: 'rid-e4' })
  assert.equal(retried.status, 502)
})

test('0.8.0 say：没有 controller → 503 retryable；错误 requestId 400', async () => {
  const { channel } = writeChannel({ controller: null })
  const result = await say(channel, { requestId: 'rid-noctl' })
  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'no-controller')
  assert.equal(result.body.retryable, true)
  const bad = await say(channel, { requestId: 'bad id with spaces' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'bad-request-id')
})

test('0.8.0 专属会话：ensure 建会话 + rename 标题 + 写回配置 + 内存绑定切换', async () => {
  const { dir, path } = await makeConfigFixture(true)
  const config = { butler: { sessionId: 's-old', allowWrite: true, configPath: path, agentPreset: 'butler-lead' } }
  const fake = fakeController({ created: { sessionId: 's-butler-new' } })
  const channel = createWriteChannel({ controller: () => fake.controller, config, token: TEST_TOKEN, now: () => AT })
  const result = await channel.ensureSession(sayHeaders(), { action: 'ensure' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.ok, true)
  assert.equal(result.body.sessionId, 's-butler-new')
  assert.equal(result.body.titleApplied, true)
  assert.equal(result.body.persisted, true)
  assert.equal(result.body.action, 'ensure')
  assert.equal(fake.calls.create[0].agentPreset, 'butler-lead', '领导预设必须随 create 传给宿主')
  assert.equal(fake.calls.rename[0].title, BUTLER_LABEL_DEFAULT)
  assert.ok((await readFile(path, 'utf8')).includes("sessionId: 's-butler-new'"))
  // 内存里也切换：say 现在发到新 id。
  assert.equal(channel.sessionId, 's-butler-new')
  const sent = await channel.say(sayHeaders(), { sessionId: 's-butler-new', content: 'hi', requestId: 'rid-after-rebuild' })
  assert.equal(sent.status, 200)
  assert.equal(fake.calls.prompt.at(-1).sessionId, 's-butler-new')
  await rm(dir, { recursive: true, force: true })
})

test('0.8.0 专属会话：未配置 configPath 时如实提示未持久化；重建空绑定 400；未知动作 400；缺 token 401', async () => {
  const config = { butler: { sessionId: 's-old', allowWrite: true } }
  const fake = fakeController({ created: { sessionId: 's-new-2' } })
  const channel = createWriteChannel({ controller: () => fake.controller, config, token: TEST_TOKEN, now: () => AT })
  const noPath = await channel.ensureSession(sayHeaders(), { action: 'rebuild' })
  assert.equal(noPath.status, 200)
  assert.equal(noPath.body.persisted, false)
  assert.match(noPath.body.config.reason, /configPath/)

  const emptyConfig = createWriteChannel({ controller: () => fake.controller, config: { butler: { allowWrite: true } }, token: TEST_TOKEN })
  const noBinding = await emptyConfig.ensureSession(sayHeaders(), { action: 'rebuild' })
  assert.equal(noBinding.status, 400)

  const unknown = await channel.ensureSession(sayHeaders(), { action: 'delete-everything' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'unknown-action')

  const noToken = await channel.ensureSession({}, { action: 'ensure' })
  assert.equal(noToken.status, 401)
})

test('0.8.0 专属会话：create 失败结构化 502；rename 失败不挡会话但如实回报', async () => {
  const failed = writeChannel({ controller: { createError: new Error('create boom C:\\secret') } })
  const result = await failed.channel.ensureSession(sayHeaders(), { action: 'ensure' })
  assert.equal(result.status, 502)
  assert.equal(result.body.code, 'session-create-failed')
  assert.equal(JSON.stringify(result.body).includes('C:'), false)

  const renameFail = writeChannel({ controller: { created: { sessionId: 's-r' }, renameError: new Error('no rename') } })
  const partial = await renameFail.channel.ensureSession(sayHeaders(), { action: 'ensure' })
  assert.equal(partial.status, 200)
  assert.equal(partial.body.titleApplied, false)
  assert.equal(typeof partial.body.titleReason, 'string')
})

test('0.8.0 路由：POST say 405/401/415/200 契约（exact raw handler）', async () => {
  const fake = fakeController()
  const resource = mount({ sessionController: () => fake.controller, config: BUTLER_CONFIG })
  const handler = resource.handlers.get(SAY_PATH)
  assert.equal(typeof handler, 'function')
  const injected = await injectedWriteConfig(resource)
  await withHandlerServer(handler, async baseUrl => {
    const get = await fetch(baseUrl, { method: 'GET' })
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const noToken = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(noToken.status, 401)

    const wrongType = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-butler-write-token': injected.token },
      body: 'hi',
    })
    assert.equal(wrongType.status, 415)

    const ok = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-butler-write-token': injected.token },
      body: JSON.stringify({ sessionId: 's-butler', content: '路由成功', requestId: 'rid-route' }),
    })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.deepEqual(body, { ok: true, accepted: true, mode: 'queue', sessionId: 's-butler', requestId: 'rid-route' })
    assert.equal(fake.calls.prompt.length, 1)
  })
})

test('0.8.0 路由：POST session 契约（ensure 建会话并写回配置）', async () => {
  const { dir, path } = await makeConfigFixture(true)
  const fake = fakeController({ created: { sessionId: 's-route-new' } })
  const resource = mount({
    sessionController: () => fake.controller,
    config: { butler: { sessionId: 's-old', allowWrite: true, configPath: path } },
  })
  const handler = resource.handlers.get(SESSION_PATH)
  assert.equal(typeof handler, 'function')
  const injected = await injectedWriteConfig(resource)
  await withHandlerServer(handler, async baseUrl => {
    const get = await fetch(baseUrl, { method: 'GET' })
    assert.equal(get.status, 405)
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-butler-write-token': injected.token },
      body: JSON.stringify({ action: 'ensure' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 's-route-new')
    assert.equal(body.persisted, true)
    assert.ok((await readFile(path, 'utf8')).includes("sessionId: 's-route-new'"))
  })
  await rm(dir, { recursive: true, force: true })
})

test('0.8.0 token 注入：页面 HTML 带 token/allowWrite，JSON 路由与磁盘文件都不带 token', async () => {
  const fake = fakeController()
  const resource = mount({ sessionController: () => fake.controller, config: BUTLER_CONFIG })
  await withRouteServer(resource, async baseUrl => {
    const page = await hit(baseUrl, `${ROUTE_PREFIX}/index.html`)
    assert.equal(page.status, 200)
    assert.match(page.text, /\/\*__DSH_PANEL_WRITE__\*\/\{/)
    assert.equal(page.text.includes('__DSH_PANEL_WRITE__*/null'), false)
    const injected = /\/\*__DSH_PANEL_WRITE__\*\/(\{[^<]*\})/.exec(page.text)
    assert.ok(injected, '页面里应有注入的写通道配置')
    const config = JSON.parse(injected[1])
    assert.equal(config.allowWrite, true)
    assert.equal(typeof config.token, 'string')
    assert.ok(config.token.length >= 32)
    assert.equal(config.sessionId, 's-butler')
    // JSON 路由绝不带 token。
    for (const path of [`${ROUTE_PREFIX}/${BUTLER_SESSIONS_FILE}`, `${ROUTE_PREFIX}/${BUTLER_DIALOG_FILE}`, `${ROUTE_PREFIX}/api/tiers`]) {
      const response = await hit(baseUrl, path)
      assert.equal(response.text.includes(config.token), false, path + ' 不得出现 token')
      assert.equal(response.text.includes('x-butler-write-token'), false, path + ' 不得出现 token 头名')
    }
    // 磁盘上的页面文件本身无 token、占位符未替换。
    const disk = await readFile(resolve(ROOT, 'public', 'index.html'), 'utf8')
    assert.equal(disk.includes(config.token), false)
    assert.ok(disk.includes('/*__DSH_PANEL_WRITE__*/null'))
  })
})

test('0.8.0 静态：token 只由 butler-write.js 生成；butler.js / 页面源码都不含 token 生成调用', async () => {
  const butlerSource = await readFile(resolve(ROOT, 'lib', 'butler.js'), 'utf8')
  assert.equal(butlerSource.includes('randomBytes'), false)
  assert.equal(butlerSource.includes('newWriteToken'), false)
  const writeSource = await readFile(resolve(ROOT, 'lib', 'butler-write.js'), 'utf8')
  assert.match(writeSource, /randomBytes\(32\)/)
  const page = await readFile(resolve(ROOT, 'public', 'index.html'), 'utf8')
  assert.equal(/randomBytes|newWriteToken/.test(page), false)
  // 注入逻辑在 index.js：只替换标记，不写日志。
  const indexSource = await readFile(resolve(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(indexSource, /injectWriteConfig/)
  assert.equal(/log\([^)]*token/i.test(indexSource), false, '日志不得带 token')
})


/* ─────────────────────────── J. 0.8.1 领导预设（工具白名单：deny 差集） ─────────────────────────── */

test('0.8.1 领导预设：白名单只含沟通/指挥/只读记忆，执行类一律不在 allow', () => {
  assert.equal(BUTLER_PRESET_NAME, 'butler-preset')
  assert.deepEqual(BUTLER_PRESET_INJECT, ['tools', 'agentTeams'])
  assert.ok(TOOL_WHITELIST.length >= 20, '白名单条数=' + TOOL_WHITELIST.length)
  for (const name of TOOL_WHITELIST) assert.ok(typeof name === 'string' && name.trim() !== '', '非法条目：' + String(name))
  for (const required of [
    'mesh_dispatch', 'mesh_task_list', 'mesh_task_report', 'mesh_task_ack', 'mesh_inbox', 'mesh_events', 'mesh_peers',
    'interconnect_peers', 'interconnect_send', 'interconnect_reply',
  ]) {
    assert.ok(TOOL_WHITELIST.includes(required), '白名单缺沟通/指挥工具：' + required)
  }
  assert.ok(TOOL_WHITELIST.includes('mcp__openviking__find'))
  assert.ok(TOOL_WHITELIST.includes('mcp__openviking__search'))
  for (const forbidden of [
    'bash', 'pwsh', 'persistent_pwsh', 'job_output', 'job_kill', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep',
    'working_directory', 'web_search', 'web_fetch', 'present', 'run_code', 'sandbox_exec',
    'mcp__openviking__write', 'mcp__openviking__edit', 'mcp__openviking__remember', 'mcp__openviking__forget',
  ]) {
    assert.equal(TOOL_WHITELIST.includes(forbidden), false, '执行类/写入类工具不得出现在 allow：' + forbidden)
  }
  // 白名单里不能出现幻觉工具（按本机 DSH 工具注册表核对过的名字）。
  const known = new Set([
    'mesh_peers', 'mesh_peer_probe', 'mesh_dispatch', 'mesh_events', 'mesh_inbox',
    'mesh_task_create', 'mesh_task_list', 'mesh_task_claim', 'mesh_task_heartbeat', 'mesh_task_report',
    'mesh_task_complete', 'mesh_task_cancel', 'mesh_task_ack', 'mesh_task_adopt',
    'interconnect_peers', 'interconnect_list', 'interconnect_ping', 'interconnect_send', 'interconnect_reply',
    'mcp__openviking__find', 'mcp__openviking__search',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  ])
  for (const name of TOOL_WHITELIST) assert.ok(known.has(name), '白名单含未核对名字：' + name)
  for (const name of ['bash', 'pwsh', 'read', 'write', 'edit', 'grep', 'glob']) {
    assert.ok(TOOL_DENY.includes(name), 'TOOL_DENY 文档清单缺：' + name)
  }
})

test('0.8.1 领导预设：planRestriction 用 deny 差集——保留白名单、deny 全部其它全局工具、不碰 scoped', () => {
  const plan = planRestriction([
    'bash', 'read', 'mesh_peers', 'mcp__openviking__find', 'ego_status', 'mcp__blender__execute_blender_code',
  ])
  assert.deepEqual(plan.allow, [...TOOL_WHITELIST])
  assert.deepEqual(plan.deny, ['bash', 'ego_status', 'mcp__blender__execute_blender_code', 'read'])
  for (const keep of ['mesh_peers', 'mcp__openviking__find']) {
    assert.equal(plan.deny.includes(keep), false, '白名单工具不能被 deny：' + keep)
  }
  // 预设自挂的 scoped 工具不会出现在 tools.definitions() 的全局视图里，因此不会进 deny（0.8.1 的核心修复）
  const globalsOnly = planRestriction(['mesh_peers', 'mcp__openviking__find'])
  assert.deepEqual(globalsOnly.deny, [], '全是白名单全局工具时 deny 为空')
  assert.ok(planRestriction(['mesh_peers', 'scoped_only_example']).deny.includes('scoped_only_example'),
    '纯函数不做名字来源过滤；apply 只传全局视图，所以真实运行时 scoped 名不会进来')
  assert.deepEqual(planRestriction(['team_task_list', 'bash', 'mesh_peers']).deny, ['bash'])
  const override = planRestriction(['bash', 'mesh_peers', 'read'], ['mesh_peers'])
  assert.deepEqual(override.deny, ['bash', 'read'])
})

test('0.8.1 领导预设：apply 只传 deny（不传 allow），tools/change 时重算并替换 restriction', () => {
  let globals = ['bash', 'read', 'mesh_peers', 'mcp__openviking__find']
  const calls = []
  let disposed = 0
  let changeHandler = null
  const ctx = {
    tools: {
      definitions() { return globals.map(name => ({ name })) },
      restrict(filter) { calls.push(filter); return () => { disposed += 1 } },
    },
    on(event, handler) {
      assert.equal(event, 'tools/change')
      changeHandler = handler
      return () => { changeHandler = null }
    },
    effect(setup) { setup() },
  }
  applyButlerPreset(ctx, undefined)
  assert.equal(calls.length, 1, '首次挂载要收紧一次')
  assert.deepEqual(calls[0], { deny: ['bash', 'read'] })
  assert.equal('allow' in calls[0], false, '不能再用 allow：它会把预设自挂的 scoped 领导工具一起裁掉')

  globals = ['bash', 'read', 'mesh_peers', 'mcp__openviking__find', 'new_exec']
  changeHandler()
  assert.equal(calls.length, 2, '全局工具变化后要重算')
  assert.deepEqual(calls[1], { deny: ['bash', 'new_exec', 'read'] })
  assert.equal(disposed, 1, '旧 restriction 要释放后再换新的')

  changeHandler()
  assert.equal(calls.length, 2, '集合没变化时不重复打扰')

  assert.throws(
    () => applyButlerPreset({ tools: { definitions: () => [], restrict: () => () => {} }, on: () => () => {}, effect: setup => setup() }, { allow: [] }),
    /config\.allow 不能为空/,
  )
})

test('0.8.1 领导预设：预设工厂/面板配置互相对齐（agentPreset 与 exports）', async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '0.9.2')
  assert.equal(pkg.exports['./butler-preset'], './lib/agent-preset-auto-team.js')
  assert.ok(pkg.files.includes('lib/agent-preset-auto-team.js'), 'files 必须带 agent-preset-auto-team.js，否则安装副本缺文件')
  assert.equal(pkg.files.includes('lib/agent-preset.js'), false, '旧实现文件已退役')
  const parsed = readWriteOptions({
    butler: { sessionId: 'session-butler', allowWrite: true, agentPreset: 'butler-lead' },
  })
  assert.equal(parsed.agentPreset, 'butler-lead')
  const butlerConfig = readButlerConfig({ butler: { sessionId: 'session-butler', agentPreset: 'butler-lead' } })
  assert.equal(butlerConfig.agentPreset, 'butler-lead')
})


test('0.8.1 补丁：新根会话 agent/created 时自动开 Team 模式（子代理/已开启不重复调）', async () => {
  const mod = await import('../lib/agent-preset-auto-team.js')
  mod.enabledAgents.length = 0
  const calls = []
  let createdHandler = null
  const ctx = {
    tools: { definitions: () => [{ name: 'mesh_peers' }], restrict: () => () => {} },
    agentTeams: {
      isEnabled: agent => agent.__teamEnabled === true,
      setEnabled: async (agent, enabled) => { calls.push({ id: agent.session.id, enabled }); agent.__teamEnabled = enabled },
    },
    on(event, handler) {
      if (event === 'agent/created') createdHandler = handler
      return () => { createdHandler = null }
    },
    effect(setup) { setup() },
    logger: { warn() {}, info() {} },
  }
  mod.apply(ctx, undefined)
  assert.equal(typeof createdHandler, 'function', '必须监听 agent/created')
  const root = { session: { id: 'session-new', header: {} } }
  await createdHandler({ agent: root })
  assert.deepEqual(calls, [{ id: 'session-new', enabled: true }])
  assert.deepEqual(mod.enabledAgents, ['session-new'])
  await createdHandler({ agent: root })
  assert.equal(calls.length, 1, '已开启的会话不重复调')
  const child = { session: { id: 'session-child', header: { parentSession: 'session-new' } } }
  await createdHandler({ agent: child })
  assert.equal(calls.length, 1, '子代理（有 parentSession）不开启')
  const failing = {
    tools: { definitions: () => [], restrict: () => () => {} },
    agentTeams: { isEnabled: () => false, setEnabled: async () => { throw new Error('boom') } },
    on(event, handler) { if (event === 'agent/created') createdHandler = handler; return () => {} },
    effect(setup) { setup() },
    logger: { warn() {} },
  }
  mod.apply(failing, undefined)
  await createdHandler({ agent: { session: { id: 'session-fail', header: {} } } })
  assert.ok(true, '自动开 Team 失败不抛出（只记日志）')
})

test('0.8.1 补丁：package exports / files 指向自动 Team 版预设插件', async () => {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./butler-preset'], './lib/agent-preset-auto-team.js')
  assert.equal(pkg.exports['./butler-preset-auto-team'], './lib/agent-preset-auto-team.js')
  assert.ok(pkg.files.includes('lib/agent-preset-auto-team.js'))
  assert.equal(pkg.files.includes('lib/agent-preset.js'), false)
})

/* ─────────────────────── I. 0.9.2 模型目录 / 切模型 ─────────────────────── */

test('0.9.2 模型目录：官方 catalog + 会话投影（当前模型/权限不写死）', async () => {
  const { channel, calls } = writeChannel()
  const result = await channel.modelCatalog()
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.deepEqual(result.body.current, { provider: 'deepseek', model: 'm-pro', reasoningEffort: 'max' })
  assert.equal(result.body.currentSource, 'session')
  assert.equal(result.body.permission, 'danger-full-access')
  assert.equal(result.body.catalog.groups[0].models.length, 2)
  assert.equal(calls.modelCatalog, 1)
  assert.equal(calls.list, 1)
})

test('0.9.2 切模型：token / 白名单会话 / 官方 selectModel / requestId 幂等', async () => {
  const { channel, calls } = writeChannel()
  assert.equal((await channel.selectModel({}, { sessionId: 's-butler', provider: 'deepseek', model: 'm-pro' })).status, 401)
  assert.equal((await channel.selectModel(sayHeaders(), { sessionId: 's-other', provider: 'deepseek', model: 'm-pro' })).status, 403)
  const body = { sessionId: 's-butler', provider: 'deepseek', model: 'm-pro', reasoningEffort: 'max', requestId: 'rid-model-1' }
  const ok = await channel.selectModel(sayHeaders(), body)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.selected, { provider: 'deepseek', model: 'm-pro', reasoningEffort: 'max' })
  assert.equal(calls.selectModel.length, 1)
  assert.deepEqual(calls.selectModel[0], { sessionId: 's-butler', provider: 'deepseek', model: 'm-pro', reasoningEffort: 'max' })
  const again = await channel.selectModel(sayHeaders(), body)
  assert.equal(again.body.deduped, true)
  assert.equal(calls.selectModel.length, 1)
})

test('0.9.2 切模型错误映射：官方 model-unavailable → 422（不伪造成功）', async () => {
  const { channel } = writeChannel({ controller: { selectModelError: Object.assign(new Error('no model'), { code: 'session/model-unavailable' }) } })
  const result = await channel.selectModel(sayHeaders(), { sessionId: 's-butler', provider: 'deepseek', model: 'nope' })
  assert.equal(result.status, 422)
  assert.equal(result.body.code, 'model-unavailable')
})
