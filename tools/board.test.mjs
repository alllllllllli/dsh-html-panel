#!/usr/bin/env node
/**
 * tools/board.test.mjs —— `/api/board`、`/api/host` 两个新路由的断言集（node:test，零依赖）。
 *
 * 跑法（插件根目录）：
 *   node --test "tools/*.test.mjs"
 *
 * 测的是什么：**真的 `lib/index.js` 的 `apply()`** 挂在假 ctx 上，用 `node:http`
 * 起两个真 socket —— 一个假板服务（校验 `x-team-token`、可切换故障模式），一个把
 * Fetch 风格 route 接到 node:http 的服务器；然后用真 `fetch` 打 HTTP。
 *
 * 覆盖：
 *   A. 配置解析：endpoint 校验/脱敏、token 可选、timeoutMs 夹取、平铺简写、非法配置不抛
 *   B. 映射：六种板子 lifecycle → 五态；owner/node/evidenceCount；时间毫秒原样
 *   C. 正常路由：字段契约、health 只挑 5 个字段（不泄露 db 路径）、证据数、事件排序、
 *      3 秒缓存（命中 cached:true 且不再打板）、token 只出现在请求头
 *   D. 错误形状：连不上 / 超时 / 非 JSON / 401 / 500（结构化）/ 未配置；
 *      响应与 console 里都 grep 不到 token，也不回显 endpoint 的 userinfo
 *   E. /api/host：字段范围、C/D 盘、statfs 失败不抛、HEAD/405
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { BOARD_FILE, HOST_FILE, ROUTE_PREFIX, apply, inject } from '../lib/index.js'
import { BOARD_CACHE_MS, createBoardReader, readBoardConfig } from '../lib/board.js'
import { mapBoardTask } from '../lib/boardmap.js'
import { buildHostInfo } from '../lib/host.js'

const FIXED_NOW = 1_795_000_000_000
/** 路由内部用真实 Date.now() 判定租约，所以夹具的时间基准必须是「现在」。 */
const NOW = Date.now()
/** 测试夹具里的假 token：不是任何真实凭据，只为验证"确实带了头、且从不回显"。 */
const FAKE_TOKEN = 'test-fixture-token-not-a-real-credential'

/* ─────────────────────── 假板服务（真 socket） ─────────────────────── */

/** 六种 lifecycle / 租约 / 回执组合，覆盖五态映射与两种原样透传。 */
const TASK_ROWS = [
  {
    task_id: 't-leased', title: '租约中的任务', lifecycle: 'working', owner_session: 'dev-a',
    lease_host: 'pc-a', lease_until: NOW + 600_000, ack_state: 'acked',
    stale: 0, require_independent_review: 1, created_at: NOW - 60_000, updated_at: NOW - 1_000,
    acceptance: '第一条\n第二条', brief: '演示租约',
  },
  {
    task_id: 't-done', title: '已完成的任务', lifecycle: 'done', owner_session: 'dev-b',
    lease_host: null, lease_until: null, ack_state: 'acked',
    stale: 0, require_independent_review: 0, created_at: NOW - 120_000, updated_at: NOW - 5_000,
    acceptance: '', brief: '',
  },
  {
    task_id: 't-awaiting', title: '等回执的任务', lifecycle: 'open', owner_session: null,
    lease_host: null, lease_until: null, ack_state: 'pending',
    stale: 0, require_independent_review: 0, created_at: NOW - 30_000, updated_at: NOW - 2_000,
    acceptance: '回执到位', brief: '',
  },
  {
    task_id: 't-undelivered', title: '未送达的任务', lifecycle: 'open', owner_session: null,
    lease_host: null, lease_until: null, ack_state: 'none',
    stale: 0, require_independent_review: 0, created_at: NOW - 20_000, updated_at: NOW - 3_000,
    acceptance: '', brief: '',
  },
  {
    task_id: 't-stale', title: '租约过期的任务', lifecycle: 'working', owner_session: 'dev-c',
    lease_host: 'pc-c', lease_until: NOW - 1_000, ack_state: 'acked',
    stale: 0, require_independent_review: 0, created_at: NOW - 90_000, updated_at: NOW - 40_000,
    acceptance: '', brief: '',
  },
  {
    task_id: 't-blocked', title: '受阻的任务', lifecycle: 'blocked', owner_session: null,
    lease_host: null, lease_until: null, ack_state: 'none',
    stale: 0, require_independent_review: 0, created_at: NOW - 10_000, updated_at: NOW - 4_000,
    acceptance: '', brief: '',
  },
]

const EVENT_ROWS = Array.from({ length: 8 }, (_, index) => ({
  seq: index + 1,
  kind: index % 2 === 0 ? 'task.created' : 'task.reported',
  task_id: index < 6 ? TASK_ROWS[index].task_id : null,
  actor: index % 2 === 0 ? 'lead' : 'dev-a',
  payload: { message: '事件正文 ' + (index + 1) },
  created_at: NOW - (8 - index) * 1_000,
}))

/** 每个任务的证据条数（t-leased 2 条，t-done 3 条，其余 0/1 条）。 */
const EVIDENCE_BY_TASK = { 't-leased': 2, 't-done': 3, 't-awaiting': 1, 't-undelivered': 0, 't-stale': 1, 't-blocked': 0 }

/**
 * 起一个假板服务。
 * @param {{token?:string, mode?:'ok'|'hang'|'badjson'|'401'|'500-structured'|'health-down'}} [options]
 * @returns {Promise<{endpoint:string, state:object, close:()=>Promise<void>}>}
 */
async function startFakeBoard(options = {}) {
  const token = options.token ?? FAKE_TOKEN
  const state = {
    mode: options.mode ?? 'ok',
    expectedToken: token,
    hits: [],
    tokensSeen: [],
    hang: new Set(),
    badTokenHits: 0,
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = url.pathname + (url.search === '' ? '' : url.search)
    state.hits.push(key)
    const headerToken = req.headers['x-team-token']
    state.tokensSeen.push(headerToken ?? null)

    const sendJson = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    if (state.mode === 'hang') {
      state.hang.add(res)
      res.on('close', () => state.hang.delete(res))
      // 故意不回包：验证读取器自己的 timeout
      return
    }
    if (state.mode === 'badjson') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{definitely not json')
      return
    }
    if (state.mode === '401') {
      // 故意给纯文本：验证 401 的兜底提示（token 配错）而不是把 HTML 塞进错误
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return
    }
    if (state.mode === 'health-down') {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'DOWN', message: 'board restarting' } }))
      return
    }

    if (headerToken !== token) {
      state.badTokenHits += 1
      sendJson(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'bad board token' } })
      return
    }

    if (url.pathname === '/health') {
      sendJson(200, {
        ok: true,
        service: 'dsh-team-mesh board',
        version: '0.5.0',
        schema_version: 4,
        // 板服务 /health 真的会报 dbPath：面板只挑 5 个字段，这个字符串**不许**进响应
        board: 'D:\\fake-private-path\\team.db',
      })
      return
    }
    if (url.pathname === '/task/list') {
      sendJson(200, { ok: true, tasks: TASK_ROWS })
      return
    }
    if (url.pathname === '/task/evidence') {
      const taskId = url.searchParams.get('taskId') ?? ''
      const count = EVIDENCE_BY_TASK[taskId]
      if (count === undefined) {
        sendJson(200, { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'no such task' } })
        return
      }
      sendJson(200, { ok: true, evidence: Array.from({ length: count }, (_, i) => ({ evidence_id: i + 1 })) })
      return
    }
    if (url.pathname === '/events') {
      // 板服务按 seq DESC 返回（最近的在前）
      sendJson(200, { ok: true, events: EVENT_ROWS.slice().reverse() })
      return
    }
    sendJson(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no route' } })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return {
    endpoint,
    state,
    close: () => new Promise((done) => {
      for (const res of state.hang) {
        try { res.destroy() } catch { /* 已断开 */ }
      }
      state.hang.clear()
      server.close(done)
      server.closeAllConnections?.()
    }),
  }
}

/* ─────────────────────── 假 ctx + 真 socket 路由 ─────────────────────── */

/**
 * 挂载真的 `apply()`。
 * @param {object} config 插件行 config
 * @returns {{resource: Function, registration: object}}
 */
function mount(config = {}) {
  let resource = null
  let registration = null
  const ctx = {
    effect(fn) { return fn() },
    webServer: {
      register(optionsIn) {
        registration = optionsIn
        resource = optionsIn.resource
        return () => { resource = null }
      },
    },
  }
  apply(ctx, config)
  assert.equal(typeof resource, 'function', 'apply 必须注册一个 route 函数')
  return { resource, registration }
}

/** 把 Fetch 风格 route 接到 node:http 上，用真 fetch 打。 */
async function withRouteServer(resource, run) {
  let port = 0
  const server = createServer(async (req, res) => {
    try {
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers })
      const response = await resource(request)
      const headers = {}
      response.headers.forEach((value, key) => { headers[key] = value })
      const body = response.body === null ? Buffer.from('') : Buffer.from(await response.arrayBuffer())
      res.writeHead(response.status, headers)
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String((error && error.message) || error))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((done) => server.close(done))
  }
}

/** 打一条路由，返回状态 / 头 / 原文 / 解析后的 JSON（解析失败给 undefined）。 */
async function hit(baseUrl, path, init) {
  const response = await fetch(baseUrl + path, init)
  const text = await response.text()
  let json
  try { json = text === '' ? undefined : JSON.parse(text) } catch { json = undefined }
  return { status: response.status, headers: response.headers, text, json }
}

/** 一个配置好的板 config（指向假服务）。 */
function boardConfig(endpoint, extra = {}) {
  return { board: { endpoint, token: FAKE_TOKEN, timeoutMs: 2000, ...extra } }
}

/** 收集 console 输出，用来断言错误路径不打印任何东西（更不会打印 token）。 */
function captureConsole() {
  const lines = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  for (const name of ['log', 'warn', 'error']) {
    console[name] = (...args) => { lines.push(name + ': ' + args.map(String).join(' ')) }
  }
  return {
    lines,
    restore() { console.log = original.log; console.warn = original.warn; console.error = original.error },
  }
}

/* ─────────────────────────── A. 配置解析 ─────────────────────────── */

test('readBoardConfig：合法配置、默认值与 timeoutMs 夹取', () => {
  const got = readBoardConfig({ board: { endpoint: '  http://127.0.0.1:13090  ', token: ' abc ', timeoutMs: 4000 } })
  assert.equal(got.configured, true)
  assert.equal(got.origin, 'http://127.0.0.1:13090')
  assert.equal(got.requestBase, 'http://127.0.0.1:13090')
  assert.equal(got.token, 'abc')
  assert.equal(got.timeoutMs, 4000)
  assert.equal(got.error, null)

  assert.equal(readBoardConfig({ board: { endpoint: 'http://h:1' } }).timeoutMs, 4000, '缺省 4000')
  assert.equal(readBoardConfig({ board: { endpoint: 'http://h:1', timeoutMs: 1 } }).timeoutMs, 500, '下限 500')
  assert.equal(readBoardConfig({ board: { endpoint: 'http://h:1', timeoutMs: 10 ** 9 } }).timeoutMs, 10000, '上限 10000')
  assert.equal(readBoardConfig({ board: { endpoint: 'http://h:1', timeoutMs: 'abc' } }).configured, false)
  assert.equal(readBoardConfig({ board: { endpoint: 'http://h:1', timeoutMs: 'abc' } }).error.code, 'invalid-timeout')
  assert.equal(readBoardConfig({ board: { endpoint: 'http://h:1', token: 42 } }).error.code, 'invalid-token')
})

test('readBoardConfig：endpoint 的 userinfo/path/query/fragment 不进 origin 与请求基址', () => {
  const got = readBoardConfig({
    board: { endpoint: 'http://user:pass@127.0.0.1:13090/prefix/path?token=abc#frag', token: ' real-token ' },
  })
  assert.equal(got.configured, true)
  assert.equal(got.origin, 'http://127.0.0.1:13090')
  assert.equal(got.requestBase, 'http://127.0.0.1:13090/prefix/path', '保留路径前缀、丢掉凭据与 query')
  const raw = JSON.stringify(got)
  for (const secret of ['user', 'pass@', 'token=abc', 'frag']) {
    assert.equal(raw.includes(secret), false, `配置解析结果不许含 ${secret}`)
  }
})

test('readBoardConfig：未配置 / 非法 endpoint 给结构化 error，绝不抛', () => {
  for (const config of [undefined, null, {}, { board: {} }]) {
    let got
    assert.doesNotThrow(() => { got = readBoardConfig(config) })
    assert.equal(got.configured, false)
    assert.equal(got.origin, null)
    assert.equal(got.error.code, 'board-not-configured')
  }
  for (const endpoint of ['not a url at all', 'ftp://127.0.0.1:1', 'file:///C:/x', 'javascript:alert(1)']) {
    let got
    assert.doesNotThrow(() => { got = readBoardConfig({ board: { endpoint } }) })
    assert.equal(got.configured, false, `应判非法：${endpoint}`)
    assert.equal(got.error.code, 'invalid-endpoint')
  }
  // 平铺简写（与老 snapshot 配置习惯一致）
  const flat = readBoardConfig({ endpoint: 'http://127.0.0.1:1', token: 'x' })
  assert.equal(flat.configured, true)
  assert.equal(flat.origin, 'http://127.0.0.1:1')
})

/* ─────────────────────────── B. 映射复用 ─────────────────────────── */

test('mapBoardTask：六种板子状态 → 五态 + 原样透传，证据数与毫秒时间原样', () => {
  const states = TASK_ROWS.map((row, index) =>
    mapBoardTask(row, NOW, EVIDENCE_BY_TASK[row.task_id] ?? null))
  assert.deepEqual(states.map((task) => task.state), ['leased', 'done', 'awaiting', 'undelivered', 'stale', 'blocked'])
  assert.equal(states[0].node, 'pc-a', 'node 取 lease_host')
  assert.equal(states[1].node, undefined, 'lease_host 为 null 时不写 node 键')
  assert.equal(states[0].evidenceCount, 2)
  assert.equal(states[0].acceptance.length, 2, 'acceptance 按换行拆行')
  assert.equal(states[0].updatedAt, NOW - 1_000, '时间单位毫秒原样透传')
  assert.equal(states[0].requireReview, true)
  assert.equal(states[0].eventTotal, undefined, 'HTTP 路径不给 eventTotal')
  assert.equal(mapBoardTask(TASK_ROWS[0], NOW, null).evidenceCount, null, '取不到证据数给 null')
})

/* ─────────────────────────── C. 正常路由 ─────────────────────────── */

test('路由：GET api/board 正常态 —— 契约、health 字段白名单、证据数、事件排序、token 只在请求头', async () => {
  const board = await startFakeBoard()
  const host = mount(boardConfig(board.endpoint))
  try {
    await withRouteServer(host.resource, async (baseUrl) => {
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
      assert.equal(got.status, 200)
      assert.match(got.headers.get('content-type'), /^application\/json/)
      assert.equal(got.headers.get('cache-control'), 'no-store')

      const body = got.json
      assert.deepEqual(Object.keys(body).sort(), ['cached', 'configured', 'events', 'generatedAt', 'health', 'source', 'tasks'])
      assert.equal(body.configured, true)
      assert.deepEqual(body.source, { origin: board.endpoint })
      assert.deepEqual(Object.keys(body.health).sort(), ['latencyMs', 'ok', 'schema_version', 'service', 'version'])
      assert.equal(body.health.ok, true)
      assert.equal(typeof body.health.latencyMs, 'number')
      assert.ok(body.health.latencyMs >= 0)
      assert.equal(body.health.service, 'dsh-team-mesh board')
      assert.equal(body.health.version, '0.5.0')
      assert.equal(body.health.schema_version, 4)

      assert.equal(body.tasks.length, 6)
      assert.deepEqual(body.tasks.map((task) => task.id), TASK_ROWS.map((row) => row.task_id))
      assert.deepEqual(body.tasks.map((task) => task.state), ['leased', 'done', 'awaiting', 'undelivered', 'stale', 'blocked'])
      assert.deepEqual(body.tasks.map((task) => task.evidenceCount), [2, 3, 1, 0, 1, 0])

      assert.equal(body.events.length, 8)
      assert.deepEqual(body.events.map((event) => event.seq), [8, 7, 6, 5, 4, 3, 2, 1], '事件按时间倒序（最近在前）')
      assert.equal(body.events[0].kind, 'task.reported')
      assert.equal(body.events[0].node, 'dev-a', 'node 取 actor')
      assert.equal(body.events[0].text, '事件正文 8')
      assert.equal(body.events[0].task, '', 'task_id 为 null 的事件保留为空串，不丢')
      assert.equal(body.events[2].task, TASK_ROWS[5].task_id)
      assert.equal(body.events[7].task, TASK_ROWS[0].task_id)
      assert.equal(body.cached, false)

      // 安全断言：token 只在请求头，响应体里连它/凭据/板服务 db 路径都不许出现
      const raw = got.text
      assert.equal(raw.includes(FAKE_TOKEN), false, '响应体不许含 token')
      assert.equal(raw.includes('x-team-token'), false, '响应体不许含鉴权头名')
      assert.equal(raw.includes('fake-private-path'), false, 'health 的 dbPath 不许透传')
      assert.equal(board.state.tokensSeen.every((value) => value === FAKE_TOKEN), true, '每个请求都带 x-team-token')
      assert.equal(board.state.badTokenHits, 0)

      // 缓存：紧接着再打一次，不应再碰板
      const hitsAfterFirst = board.state.hits.length
      const second = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
      assert.equal(second.status, 200)
      assert.equal(second.json.cached, true, '3 秒内第二次应命中缓存')
      assert.deepEqual(second.json.tasks, body.tasks)
      assert.equal(second.json.generatedAt, body.generatedAt, '缓存命中保留原生成时间')
      assert.equal(board.state.hits.length, hitsAfterFirst, '缓存命中不再打板')
    })
  } finally {
    await board.close()
  }
})

test('createBoardReader：缓存窗口是 3 秒，过期后重新读板', async () => {
  const board = await startFakeBoard()
  try {
    const reader = createBoardReader(boardConfig(board.endpoint))
    const clock = Date.now()
    const first = await reader.read(clock)
    assert.equal(first.cached, false)
    const hitsAfterFirst = board.state.hits.length

    const inside = await reader.read(clock + BOARD_CACHE_MS - 1)
    assert.equal(inside.cached, true)
    assert.equal(board.state.hits.length, hitsAfterFirst, '窗口内不打板')

    const expired = await reader.read(clock + BOARD_CACHE_MS)
    assert.equal(expired.cached, false, '窗口外重新读')
    assert.ok(board.state.hits.length > hitsAfterFirst)
  } finally {
    await board.close()
  }
})

test('路由：未配置板 —— 200 + configured:false，页面可据此显示「板未配置」', async () => {
  const host = mount({})
  await withRouteServer(host.resource, async (baseUrl) => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
    assert.equal(got.status, 200)
    assert.equal(got.json.configured, false)
    assert.equal(got.json.source, null)
    assert.equal(got.json.health, null)
    assert.deepEqual(got.json.tasks, [])
    assert.deepEqual(got.json.events, [])
    assert.equal(got.json.error.code, 'board-not-configured')
  })
})

/* ─────────────────────────── D. 错误形状（脱敏） ─────────────────────────── */

test('错误：连不上 → unreachable，message 不含 token / userinfo', async () => {
  const host = mount(boardConfig('http://user:pass@127.0.0.1:1/x?token=abc', { timeoutMs: 500 }))
  await withRouteServer(host.resource, async (baseUrl) => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
    assert.equal(got.status, 200)
    const body = got.json
    assert.equal(body.configured, true)
    assert.deepEqual(body.source, { origin: 'http://127.0.0.1:1' })
    assert.equal(body.health, null)
    assert.equal(body.error.code, 'unreachable')
    for (const secret of [FAKE_TOKEN, 'user', 'pass', 'token=abc']) {
      assert.equal(got.text.includes(secret), false, `错误响应不许含 ${secret}`)
    }
  })
})

test('错误：超时 → timeout（timeoutMs 生效）', async () => {
  const board = await startFakeBoard({ mode: 'hang' })
  const host = mount(boardConfig(board.endpoint, { timeoutMs: 500 }))
  try {
    await withRouteServer(host.resource, async (baseUrl) => {
      const started = Date.now()
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
      const elapsed = Date.now() - started
      assert.equal(got.status, 200)
      assert.equal(got.json.configured, true)
      assert.equal(got.json.error.code, 'timeout')
      assert.match(got.json.error.message, /超时/)
      assert.ok(elapsed >= 400, `应等满超时（实测 ${elapsed}ms）`)
      assert.equal(got.text.includes(FAKE_TOKEN), false)
    })
  } finally {
    await board.close()
  }
})

test('错误：非 JSON → bad-json；401 → http-401；结构化 500 → board-<code>', async () => {
  const cases = [
    { mode: 'badjson', expect: 'bad-json' },
    { mode: '401', expect: 'http-401' },
  ]
  for (const item of cases) {
    const board = await startFakeBoard({ mode: item.mode })
    const host = mount(boardConfig(board.endpoint, { timeoutMs: 1000 }))
    try {
      await withRouteServer(host.resource, async (baseUrl) => {
        const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
        assert.equal(got.status, 200, item.mode + ' 仍是 200（页面自己兜底）')
        assert.equal(got.json.error.code, item.expect, item.mode)
        assert.equal(got.json.tasks.length, 0)
        assert.equal(got.text.includes(FAKE_TOKEN), false, item.mode + ' 响应不许含 token')
      })
    } finally {
      await board.close()
    }
  }

  // 结构化错误：板服务回 { ok:false, error:{code,message} } → 原样带上 code（加 board- 前缀）
  const structured = await startFakeBoard({ mode: 'health-down' })
  const host = mount(boardConfig(structured.endpoint, { timeoutMs: 1000 }))
  try {
    await withRouteServer(host.resource, async (baseUrl) => {
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
      assert.equal(got.status, 200)
      assert.equal(got.json.configured, true)
      assert.equal(got.json.error.code, 'board-DOWN')
      assert.equal(got.json.error.message, 'board restarting')
      assert.equal(got.text.includes(FAKE_TOKEN), false)
    })
  } finally {
    await structured.close()
  }
})

test('错误路径不往 console 打印任何东西（更不会打印 token）', async () => {
  const host = mount(boardConfig('http://127.0.0.1:1', { timeoutMs: 500 }))
  const capture = captureConsole()
  try {
    await withRouteServer(host.resource, async (baseUrl) => {
      await hit(baseUrl, `${ROUTE_PREFIX}/${BOARD_FILE}`)
    })
  } finally {
    capture.restore()
  }
  assert.deepEqual(capture.lines, [], '错误路径不许有日志输出')
})

/* ─────────────────────────── E. /api/host ─────────────────────────── */

test('路由：GET api/host 字段范围合理、磁盘项数值为正、无外链', async () => {
  const host = mount({})
  await withRouteServer(host.resource, async (baseUrl) => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${HOST_FILE}`)
    assert.equal(got.status, 200)
    assert.match(got.headers.get('content-type'), /^application\/json/)
    assert.equal(got.headers.get('cache-control'), 'no-store')
    const body = got.json
    assert.equal(typeof body.generatedAt, 'string')
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(typeof body.hostname, 'string')
    assert.ok(body.hostname.length > 0)
    assert.equal(typeof body.os.platform, 'string')
    assert.equal(typeof body.os.release, 'string')
    assert.equal(typeof body.os.uptimeSec, 'number')
    assert.ok(body.os.uptimeSec >= 0)
    assert.ok(body.memory.totalBytes > 0)
    assert.ok(body.memory.freeBytes >= 0 && body.memory.freeBytes <= body.memory.totalBytes)
    assert.ok(body.memory.ratio >= 0 && body.memory.ratio <= 1)
    assert.ok(body.cpu.count > 0)
    assert.equal(typeof body.cpu.load1, 'number')
    assert.ok(Array.isArray(body.disks) && body.disks.length > 0, '至少一项磁盘')
    for (const disk of body.disks) {
      assert.equal(typeof disk.mount, 'string')
      assert.equal(typeof disk.label, 'string')
      if (disk.error === null) {
        assert.ok(disk.totalBytes > 0)
        assert.ok(disk.freeBytes >= 0 && disk.freeBytes <= disk.totalBytes)
        assert.ok(disk.ratio >= 0 && disk.ratio <= 1)
      }
    }
    if (process.platform === 'win32') {
      const mounts = body.disks.map((disk) => disk.mount)
      assert.ok(mounts.includes('C:'), 'Windows 应报 C:，实际 ' + JSON.stringify(mounts))
    }
    assert.equal(got.text.includes('http://'), false, '本机数据里没有任何外链')
  })
})

test('buildHostInfo：statfs 失败的那项数值 null、不抛错；os 读不到也不抛', async () => {
  const failing = await buildHostInfo(FIXED_NOW, {
    mounts: [{ mount: 'C:\\', label: 'C: 测试' }, { mount: 'Z:\\', label: 'Z: 不存在' }],
    statfs: async (mount) => {
      if (mount === 'Z:\\') {
        const error = new Error('no such device')
        error.code = 'ENOENT'
        throw error
      }
      return { bsize: 4096, blocks: 1000, bavail: 250 }
    },
  })
  assert.equal(failing.disks.length, 2)
  assert.equal(failing.disks[0].totalBytes, 4096 * 1000)
  assert.equal(failing.disks[0].freeBytes, 4096 * 250)
  assert.equal(failing.disks[0].ratio, 0.75)
  assert.equal(failing.disks[1].totalBytes, null)
  assert.equal(failing.disks[1].freeBytes, null)
  assert.equal(failing.disks[1].ratio, null)
  assert.equal(failing.disks[1].error, 'ENOENT')

  let empty
  empty = await buildHostInfo(FIXED_NOW, { osModule: {}, statfs: async () => { throw new Error('x') } })
  assert.equal(empty.hostname, null)
  assert.equal(empty.memory.totalBytes, null)
  assert.equal(empty.memory.ratio, null)
  assert.equal(empty.cpu.count, null)
  assert.equal(empty.cpu.load1, null)
  assert.equal(empty.disks[0].error, 'statfs-failed')
})

test('路由：api/board 与 api/host 的 HEAD 同头无体；POST 是 405 JSON + Allow', async () => {
  const host = mount({})
  await withRouteServer(host.resource, async (baseUrl) => {
    for (const file of [BOARD_FILE, HOST_FILE]) {
      const head = await hit(baseUrl, `${ROUTE_PREFIX}/${file}`, { method: 'HEAD' })
      assert.equal(head.status, 200, file + ' HEAD')
      assert.equal(head.text, '')
      assert.match(head.headers.get('content-type'), /^application\/json/)
      assert.equal(head.headers.get('cache-control'), 'no-store')

      for (const method of ['POST', 'PUT', 'DELETE']) {
        const got = await hit(baseUrl, `${ROUTE_PREFIX}/${file}`, { method })
        assert.equal(got.status, 405, `${file} ${method}`)
        assert.equal(got.headers.get('allow'), 'GET, HEAD')
        assert.deepEqual(got.json, { ok: false, error: 'method-not-allowed' })
      }
    }
  })
})

/* ─────────────────────────── F. 注册声明 ─────────────────────────── */

test('inject 仍是 webServer + interconnect；注册的是同一个 prefix 路由', () => {
  assert.deepEqual(inject, ['webServer', 'interconnect'])
  const host = mount({})
  assert.equal(host.registration.kind, 'prefix')
  assert.equal(host.registration.path, ROUTE_PREFIX)
})
