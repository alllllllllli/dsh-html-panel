#!/usr/bin/env node
/**
 * tools/tiers.test.mjs —— `lib/tiers.js`（右栏派活层级）的单元测试。
 *
 * 零依赖，`node --test`：不需要起 DSH、不需要真的 interconnect、不碰网络。
 * 覆盖：
 *   - T0 根 + T1 本机会话 + T2/T3 真实父子链（Session header 的 origin/parentSession）；
 *   - tier 递推与封顶、孤儿子代理、节点/远端行上限；
 *   - 状态与标题映射（agents.status / sessionProjections 标题 / 短 id 兜底）；
 *   - 远端 `interconnect.list()`：up 才问、down 不问、undefined/抛错/超时都降级不抛；
 *   - 缺 sessions / 缺 interconnect 时仍给 T0 + degraded；
 *   - 4 秒缓存与单飞（并发只打一次数据源）；
 *   - 路由 `GET|HEAD api/tiers` 的形状 / 405 / 降级仍 200。
 *
 * 用法: node --test tools/tiers.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_TIER, ROOT_LABEL, TIERS_CACHE_MS, TIERS_MAX_NODES, TIERS_MAX_REMOTE_SESSIONS,
  buildTiers, createTiersReader, fallbackTiers, mapStatus,
} from '../lib/tiers.js'
import { ROUTE_PREFIX, TIERS_FILE, apply } from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ─────────────────────────── A. stub 工具 ─────────────────────────── */

let seq = 0
/** 造一个活会话：`header` 是 tiers 唯一读的部分。 */
function makeSession(id, options = {}) {
  seq += 1
  const header = {
    version: 4,
    id,
    createdAt: options.createdAt ?? 1_700_000_000_000 + seq * 1000,
    isSeeded: false,
  }
  if (options.origin !== undefined) header.origin = options.origin
  if (options.parent !== undefined) header.parentSession = options.parent
  if (options.depth !== undefined) header.delegationDepth = options.depth
  return { id, header }
}

function sessionsOf(list) {
  return { list: () => list }
}

function agentsOf(rows) {
  return { list: () => rows }
}

function projectionsOf(titles) {
  return {
    snapshot(session) {
      const title = titles[session.id]
      return { asOfSeq: 0, values: title === undefined ? {} : { title } }
    },
  }
}

/**
 * 假 interconnect：peers 固定，list 按 instanceId 查表。
 * @param {{self?: string, peers?: Array<{instanceId:string, link:string}>, lists?: Record<string, unknown>}} options
 */
function interconnectOf(options = {}) {
  const peers = options.peers ?? []
  const lists = options.lists ?? {}
  return {
    selfSender: () => ({ instanceId: options.self ?? 'pc-ky614', sessionId: '__tiers__' }),
    peers: () => peers,
    list: async instanceId => lists[instanceId],
  }
}

/** 一组典型数据：本机 1 个主会话 + 2 个子代理 + 1 个孙代理；server 上 2 个会话。 */
function happyDeps() {
  const sessions = [
    makeSession('s-main', { createdAt: 1_700_000_000_100 }),
    makeSession('s-child', { origin: 'subagent', parent: 's-main', createdAt: 1_700_000_000_200 }),
    makeSession('s-child2', { origin: 'subagent', parent: 's-main', createdAt: 1_700_000_000_300 }),
    makeSession('s-grand', { origin: 'subagent', parent: 's-child', createdAt: 1_700_000_000_400 }),
    makeSession('s-remote-unused', { createdAt: 1_700_000_000_500 }),
  ]
  return {
    interconnect: () => interconnectOf({
      peers: [
        { instanceId: 'server', link: 'up' },
        { instanceId: 's5', link: 'down' },
      ],
      lists: {
        server: {
          instance: 'server',
          sessions: [
            { sessionId: 'session-aaa', title: '查看本机SSH公钥', status: 'idle' },
            { sessionId: 'session-bbb', title: '', status: 'running' },
          ],
        },
      },
    }),
    sessions: () => sessionsOf(sessions),
    agents: () => agentsOf([
      { id: 's-main', status: 'running' },
      { id: 's-child', status: 'idle' },
    ]),
    projections: () => projectionsOf({ 's-main': '主控会话', 's-child': '层级交互' }),
    now: () => 1_700_000_100_000,
  }
}

function byId(nodes) {
  const map = new Map()
  for (const node of nodes) map.set(node.id, node)
  return map
}

/* ─────────────────────────── B. 纯函数 / buildTiers ─────────────────────────── */

test('mapStatus：running→run/idle→idle/未知→idle，绝不编造运行中', () => {
  assert.equal(mapStatus('running'), 'run')
  assert.equal(mapStatus('RUNNING'), 'run')
  assert.equal(mapStatus('idle'), 'idle')
  assert.equal(mapStatus('queued'), 'queue')
  assert.equal(mapStatus('blocked'), 'blocked')
  assert.equal(mapStatus('done'), 'done')
  assert.equal(mapStatus('inactive'), 'idle')
  assert.equal(mapStatus(undefined), 'idle')
  assert.equal(mapStatus('mystery'), 'idle')
  assert.equal(mapStatus(42), 'idle')
})

test('buildTiers：T0 根 + 本机 T1 + 子代理 T2/T3 的真实父子链', async () => {
  const body = await buildTiers(happyDeps())
  assert.equal(body.root.id, 'pc-ky614')
  assert.equal(body.root.label, ROOT_LABEL)
  assert.equal(body.root.device, 'pc-ky614')
  assert.equal(body.root.tier, 0)
  assert.equal(body.root.status, 'run')
  assert.equal(body.source.local, 'sessions+agents')
  assert.equal(body.source.subagents.includes('parentSession'), true)

  const map = byId(body.nodes)
  // 本机只有 s-main 是 T1；子代理不进 T1
  const main = map.get('s-main')
  assert.ok(main)
  assert.equal(main.tier, 1)
  assert.equal(main.parentId, 'pc-ky614')
  assert.equal(main.kind, 'session')
  assert.equal(main.device, 'pc-ky614')
  assert.equal(main.title, '主控会话')
  assert.equal(main.status, 'run')
  assert.equal(main.startedAt, new Date(1_700_000_000_100).toISOString())

  const child = map.get('s-child')
  assert.equal(child.tier, 2)
  assert.equal(child.parentId, 's-main')
  assert.equal(child.kind, 'subagent')
  assert.equal(child.title, '层级交互')
  assert.equal(child.status, 'idle')

  const grand = map.get('s-grand')
  assert.equal(grand.tier, 3)
  assert.equal(grand.parentId, 's-child')
  assert.equal(grand.kind, 'subagent')

  const child2 = map.get('s-child2')
  assert.equal(child2.tier, 2)
  assert.equal(child2.parentId, 's-main')
  assert.equal(child2.title, '子代理 s-child2')

  // 远端：server 的 2 个活会话是 T1，device 只是标签
  const remoteA = map.get('server:session-aaa')
  assert.ok(remoteA)
  assert.equal(remoteA.tier, 1)
  assert.equal(remoteA.parentId, 'pc-ky614')
  assert.equal(remoteA.device, 'server')
  assert.equal(remoteA.title, '查看本机SSH公钥')
  assert.equal(remoteA.status, 'idle')
  assert.equal(remoteA.startedAt, null)
  assert.equal(remoteA.kind, 'session')
  assert.equal(map.get('server:session-bbb').status, 'run')
  // 远端没有子代理数据 → 如实写进 degraded
  assert.ok(body.degraded)
  assert.match(body.degraded.reason, /远端设备的子代理层级不可见/)

  // source 里如实记录每个对端：up 的给出会话数，down 的写清楚
  const server = body.source.remote.find(row => row.instanceId === 'server')
  assert.deepEqual(server, { instanceId: 'server', link: 'up', sessions: 2 })
  const s5 = body.source.remote.find(row => row.instanceId === 's5')
  assert.deepEqual(s5, { instanceId: 's5', link: 'down', sessions: 0 })
  // 事件顺序：本机 T1 先于远端 T1
  assert.ok(body.nodes.findIndex(node => node.id === 's-main') < body.nodes.findIndex(node => node.id === 'server:session-aaa'))
})

test('buildTiers：tier 逐级递推并在 MAX_TIER 封顶（不因更深而丢失节点）', async () => {
  const sessions = [makeSession('root-session')]
  let parent = 'root-session'
  for (let i = 1; i <= 12; i += 1) {
    const id = 'sub-' + i
    sessions.push(makeSession(id, { origin: 'subagent', parent }))
    parent = id
  }
  const body = await buildTiers({ sessions: () => sessionsOf(sessions) })
  const map = byId(body.nodes)
  assert.equal(map.get('root-session').tier, 1)
  assert.equal(map.get('sub-1').tier, 2)
  assert.equal(map.get('sub-2').tier, 3)
  assert.equal(map.get('sub-7').tier, MAX_TIER)
  assert.equal(map.get('sub-12').tier, MAX_TIER)
  assert.equal(map.get('sub-12').parentId, 'sub-11')
})

test('buildTiers：孤儿子代理挂 T1（不丢节点）且 degraded 写清原因', async () => {
  const sessions = [
    makeSession('s-live-top'),
    makeSession('s-orphan', { origin: 'subagent', parent: 's-parent-gone' }),
  ]
  const body = await buildTiers({ sessions: () => sessionsOf(sessions) })
  const orphan = byId(body.nodes).get('s-orphan')
  assert.ok(orphan)
  assert.equal(orphan.tier, 1)
  assert.equal(orphan.parentId, 'pc-ky614')
  assert.equal(orphan.kind, 'subagent')
  assert.match(body.degraded.reason, /父会话已不在活会话列表/)
})

test('buildTiers：缺 sessions 服务 → 仍给 T0，degraded 说明；不抛错', async () => {
  const body = await buildTiers({ interconnect: () => interconnectOf({ peers: [] }) })
  assert.deepEqual(body.nodes, [])
  assert.equal(body.root.label, ROOT_LABEL)
  assert.equal(body.source.local, 'unavailable')
  assert.match(body.degraded.reason, /sessions 服务/)
})

test('buildTiers：缺 interconnect → 本机层级仍在，远端为空并说明', async () => {
  const sessions = [makeSession('s-main')]
  const body = await buildTiers({ sessions: () => sessionsOf(sessions) })
  assert.equal(body.nodes.length, 1)
  assert.equal(body.root.id, 'pc-ky614')
  assert.equal(body.nodes[0].id, 's-main')
  assert.deepEqual(body.source.remote, [])
  assert.match(body.degraded.reason, /interconnect 服务/)
})

test('buildTiers：sessions.list 抛错 → 结构化降级，不把原始错误文本带出', async () => {
  const body = await buildTiers({
    sessions: () => ({ list: () => { throw new Error('secret path C:\\Users\\x') } }),
  })
  assert.equal(body.source.local, 'unavailable')
  assert.equal(body.root.id, 'pc-ky614')
  assert.equal(JSON.stringify(body).includes('secret'), false)
})

test('buildTiers：peers() 抛错 → 不抛、degraded 说明', async () => {
  const broken = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers: () => { throw new Error('secret detail') },
    list: async () => undefined,
  }
  const body = await buildTiers({ interconnect: () => broken })
  assert.equal(body.root.id, 'pc-ky614')
  assert.match(body.degraded.reason, /peer 列表失败/)
  assert.equal(JSON.stringify(body).includes('secret'), false)
})

test('buildTiers：远端 list 返回 undefined / 拒绝 / 超时 → 各自降级且不挂住', async () => {
  const hanging = new Promise(() => {})
  const interconnect = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers: () => [
      { instanceId: 'p-none', link: 'up' },
      { instanceId: 'p-fail', link: 'up' },
      { instanceId: 'p-hang', link: 'up' },
    ],
    list: instanceId => {
      if (instanceId === 'p-none') return Promise.resolve(undefined)
      if (instanceId === 'p-fail') return Promise.reject(new Error('boom'))
      return hanging
    },
  }
  const started = Date.now()
  const body = await buildTiers({ interconnect: () => interconnect, timeoutMs: 40 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1500, '超时上限必须真的生效，耗时 ' + elapsed + 'ms')
  assert.equal(body.degraded !== undefined, true)
  const rows = new Map(body.source.remote.map(row => [row.instanceId, row]))
  assert.equal(rows.get('p-none').error, 'unreachable')
  assert.equal(rows.get('p-fail').error, 'failed')
  assert.equal(rows.get('p-hang').error, 'timeout')
  for (const row of rows.values()) assert.equal(row.sessions, 0)
  assert.equal(JSON.stringify(body).includes('boom'), false)
})

test('buildTiers：远端会话行上限与超长字段截断（防异常响应撑爆页面）', async () => {
  const rows = Array.from({ length: TIERS_MAX_REMOTE_SESSIONS + 20 }, (_, index) => ({
    sessionId: 'session-' + index,
    title: 'T'.repeat(300),
    status: 'running',
  }))
  const interconnect = interconnectOf({ peers: [{ instanceId: 'big', link: 'up' }], lists: { big: { sessions: rows } } })
  const body = await buildTiers({ interconnect: () => interconnect })
  const remoteNodes = body.nodes.filter(node => node.device === 'big')
  assert.equal(remoteNodes.length, TIERS_MAX_REMOTE_SESSIONS)
  assert.equal(remoteNodes[0].title.length, 120)
  assert.equal(body.source.remote[0].sessions, TIERS_MAX_REMOTE_SESSIONS)
})

test('buildTiers：本机节点总数上限生效并写进 degraded', async () => {
  const sessions = []
  for (let i = 0; i < TIERS_MAX_NODES + 40; i += 1) sessions.push(makeSession('sess-' + i))
  const body = await buildTiers({ sessions: () => sessionsOf(sessions) })
  assert.equal(body.nodes.length, TIERS_MAX_NODES)
  assert.match(body.degraded.reason, /上限/)
})

test('buildTiers：标题投影缺失/抛错时退回短 id，节点标题永不为空', async () => {
  const sessions = [makeSession('s-main'), makeSession('s-child', { origin: 'subagent', parent: 's-main' })]
  const body = await buildTiers({
    sessions: () => sessionsOf(sessions),
    projections: () => ({ snapshot: () => { throw new Error('projection down') } }),
  })
  for (const node of body.nodes) assert.ok(typeof node.title === 'string' && node.title.length > 0)
  assert.match(byId(body.nodes).get('s-main').title, /^会话 /)
  assert.match(byId(body.nodes).get('s-child').title, /^子代理 /)
})

test('buildTiers：生成时刻可注入；非法时间回落到当前时间且不抛', async () => {
  const body = await buildTiers({ now: () => 1_700_000_000_000 })
  assert.equal(body.generatedAt, new Date(1_700_000_000_000).toISOString())
  assert.equal(body.root.startedAt, new Date(1_700_000_000_000).toISOString())
  const fallback = await buildTiers({ now: () => Number.NaN })
  assert.match(fallback.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('fallbackTiers：只给 T0 + degraded，字段形状与正常响应一致', () => {
  const body = fallbackTiers('层级快照生成失败', 1_700_000_000_000)
  assert.deepEqual(Object.keys(body).sort(), ['degraded', 'generatedAt', 'nodes', 'root', 'source'])
  assert.equal(body.root.id, 'pc-ky614')
  assert.equal(body.root.tier, 0)
  assert.deepEqual(body.nodes, [])
  assert.equal(body.degraded.reason, '层级快照生成失败')
  assert.equal(body.source.local, 'unavailable')
})

/* ─────────────────────────── C. 缓存 / 单飞 ─────────────────────────── */

test('createTiersReader：4 秒缓存内不再打数据源，命中带 cached/ageMs', async () => {
  let clock = 1_000_000
  let listCalls = 0
  const interconnect = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers: () => [{ instanceId: 'server', link: 'up' }],
    list: async instanceId => {
      listCalls += 1
      return { instance: instanceId, sessions: [{ sessionId: 's1', title: '会话一', status: 'idle' }] }
    },
  }
  const reader = createTiersReader({
    interconnect: () => interconnect,
    now: () => clock,
    cacheMs: TIERS_CACHE_MS,
  })
  const first = await reader.read()
  assert.equal(first.source.cached, false)
  assert.equal(first.source.ageMs, 0)
  assert.equal(listCalls, 1)

  clock += 1000
  const second = await reader.read()
  assert.equal(second.source.cached, true)
  assert.equal(second.source.ageMs, 1000)
  assert.equal(listCalls, 1, '缓存窗口内绝不能重复打 interconnect')
  assert.equal(second.nodes.length, first.nodes.length)

  clock += TIERS_CACHE_MS + 1
  const third = await reader.read()
  assert.equal(third.source.cached, false)
  assert.equal(listCalls, 2, '过窗口后必须重新读')
})

test('createTiersReader：并发请求单飞（只打一次数据源）', async () => {
  let listCalls = 0
  let release = null
  const gate = new Promise(resolve => { release = resolve })
  const interconnect = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers: () => [{ instanceId: 'server', link: 'up' }],
    list: async instanceId => {
      listCalls += 1
      await gate
      return { instance: instanceId, sessions: [] }
    },
  }
  const reader = createTiersReader({ interconnect: () => interconnect })
  const one = reader.read()
  const two = reader.read()
  release()
  const [a, b] = await Promise.all([one, two])
  assert.equal(listCalls, 1)
  assert.equal(a.generatedAt, b.generatedAt)
  assert.equal(a.root.id, b.root.id)
})

test('createTiersReader：cacheMs=0 时每次都读；clear() 立即失效', async () => {
  let listCalls = 0
  const interconnect = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers: () => [{ instanceId: 'server', link: 'up' }],
    list: async instanceId => {
      listCalls += 1
      return { instance: instanceId, sessions: [] }
    },
  }
  const reader = createTiersReader({ interconnect: () => interconnect, cacheMs: 0 })
  await reader.read()
  await reader.read()
  assert.equal(listCalls, 2)
  reader.clear()
  await reader.read()
  assert.equal(listCalls, 3)
})

/* ─────────────────────────── D. 路由（真 socket） ─────────────────────────── */

/**
 * 假 ctx：apply() 只需要 webServer；sessions/agents/sessionProjections 通过 ctx.get 注入。
 * 传进来的服务既可以是值，也可以是 getter（happyDeps 用 getter 方便懒取）。
 * @param {Record<string, unknown>} services
 */
function mount(services = {}) {
  let resource = null
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
        return () => {}
      },
    },
  }
  if ('interconnect' in services) ctx.interconnect = resolveService('interconnect')
  apply(ctx, {})
  assert.equal(typeof resource, 'function')
  return resource
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

test('路由：GET api/tiers 200 JSON，契约字段齐全且接真实血缘', async () => {
  const resource = mount(happyDeps())
  await withRouteServer(resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${TIERS_FILE}`)
    assert.equal(got.status, 200)
    assert.match(got.headers.get('content-type'), /^application\/json/)
    assert.equal(got.headers.get('cache-control'), 'no-store')
    const body = JSON.parse(got.text)
    assert.deepEqual(Object.keys(body).sort(), ['degraded', 'generatedAt', 'nodes', 'root', 'source'])
    assert.equal(body.root.id, 'pc-ky614')
    assert.equal(body.root.label, ROOT_LABEL)
    assert.ok(Array.isArray(body.nodes) && body.nodes.length >= 5)
    for (const node of body.nodes) {
      assert.ok(['session', 'subagent'].includes(node.kind))
      assert.ok(Number.isInteger(node.tier) && node.tier >= 1)
      assert.ok(typeof node.parentId === 'string' && node.parentId !== '')
      assert.ok(typeof node.device === 'string' && node.device !== '')
      assert.ok(typeof node.title === 'string' && node.title !== '')
      assert.ok(['run', 'idle', 'queue', 'blocked', 'done'].includes(node.status))
    }
    // 第二次请求命中 4 秒缓存：cached=true 且 ageMs 有值
    const again = await hit(baseUrl, `${ROUTE_PREFIX}/${TIERS_FILE}`)
    const second = JSON.parse(again.text)
    assert.equal(second.source.cached, true)
    assert.ok(second.source.ageMs >= 0)
  })
})

test('路由：HEAD api/tiers 同头无体；POST/PUT 是 405 JSON 带 Allow', async () => {
  const resource = mount(happyDeps())
  await withRouteServer(resource, async baseUrl => {
    const head = await hit(baseUrl, `${ROUTE_PREFIX}/${TIERS_FILE}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.match(head.headers.get('content-type'), /^application\/json/)
    for (const method of ['POST', 'PUT']) {
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${TIERS_FILE}`, { method })
      assert.equal(got.status, 405)
      assert.equal(got.headers.get('allow'), 'GET, HEAD')
      assert.deepEqual(JSON.parse(got.text), { ok: false, error: 'method-not-allowed' })
    }
  })
})

test('路由：数据源全缺时仍是 200 + T0 + degraded（页面照常渲染）', async () => {
  const resource = mount({})
  await withRouteServer(resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${TIERS_FILE}`)
    assert.equal(got.status, 200)
    const body = JSON.parse(got.text)
    assert.equal(body.root.id, 'pc-ky614')
    assert.deepEqual(body.nodes, [])
    assert.ok(typeof body.degraded.reason === 'string' && body.degraded.reason.length > 0)
    assert.equal(got.text.includes('stack'), false)
  })
})

test('路由：构建层意外抛错时降级为 200 JSON（不让页面白屏）', async () => {
  const poison = {
    get() {
      throw new Error('accessor exploded')
    },
  }
  // 直接调 serveTiers 依赖的 reader 会吞错，这里验证 apply 的兜底：用坏掉的服务
  const resource = mount({ sessions: poison })
  await withRouteServer(resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${TIERS_FILE}`)
    assert.equal(got.status, 200)
    const body = JSON.parse(got.text)
    assert.equal(body.root.label, ROOT_LABEL)
    assert.equal(got.text.includes('accessor exploded'), false)
  })
})

/* ───────────── G. 官方 subagent 契约对齐（0.5.0 新增） ───────────── */

/** 官方投影 stub：按会话给 title / subagent / subagentCatalog。 */
function projectionsWithOfficial(payload) {
  return {
    snapshot(session) {
      const values = payload[session.id] === undefined ? {} : { ...payload[session.id] }
      return { asOfSeq: 1, values }
    },
  }
}

test('官方契约：本机节点带 childSessionId/parentSessionId/mode，T1 不冒充 session id', async () => {
  const body = await buildTiers(happyDeps())
  const map = byId(body.nodes)
  const main = map.get('s-main')
  assert.equal(main.childSessionId, 's-main')
  assert.equal(main.parentSessionId, null, 'T1 顶层会话没有父会话，不拿树根实例 id 冒充')
  assert.equal(main.mode, null, 'T1 不是 subagent 对话，mode 不适用')
  const child = map.get('s-child')
  assert.equal(child.childSessionId, 's-child')
  assert.equal(child.parentSessionId, 's-main', 'T2 的 parentSessionId 是 DSH 持久化的直接创建者')
  assert.equal(child.mode, 'unknown', '官方投影没有 mode 数据时给 unknown，不猜')
  const grand = map.get('s-grand')
  assert.equal(grand.parentSessionId, 's-child')
  // 远端节点的 session id 不属于本机地址契约：不加这三个字段
  const remote = map.get('server:session-aaa')
  assert.equal('parentSessionId' in remote, false)
  assert.equal('childSessionId' in remote, false)
})

test('官方契约：父会话 subagentCatalog 优先，其次子会话 subagent 投影（mode/label）', async () => {
  const deps = happyDeps()
  deps.projections = () => projectionsWithOfficial({
    's-main': {
      title: '主控会话',
      subagentCatalog: [
        { id: 's-child', createdAt: 1, mode: 'continuable', label: '实现子代理' },
        { id: 's-child2', createdAt: 2, mode: 'one-shot', label: '第二个子代理' },
      ],
    },
    's-child': {
      title: '层级交互',
      subagent: { mode: 'continuable', label: '实现子代理', seq: 1 },
      subagentCatalog: [{ id: 's-grand', createdAt: 3, mode: 'one-shot' }],
    },
  })
  const body = await buildTiers(deps)
  const map = byId(body.nodes)
  assert.equal(map.get('s-child').mode, 'continuable')
  assert.equal(map.get('s-child2').mode, 'one-shot')
  assert.equal(map.get('s-grand').mode, 'one-shot')
  assert.equal(map.get('s-child2').label, '第二个子代理')
  assert.equal(map.get('s-child2').title, '第二个子代理', '没有标题时官方 label 优先于「子代理 <短 id>」')
  assert.equal(body.source.subagents.includes('parentSession'), true, '血缘来源仍是 Session header')
  assert.equal(body.source.subagentMode, 'official-projection')
  assert.equal(((body.degraded && body.degraded.reason) || '').includes('官方 subagent 投影'), false, '官方数据齐全时不应因投影降级')
})

test('官方契约：父会话不在活会话里时，用子会话自己的 subagent 投影补 mode', async () => {
  const deps = happyDeps()
  // 把 s-main 从会话列表里拿掉，s-child 变孤儿（父会话已结束）
  deps.sessions = () => sessionsOf([
    makeSession('s-child', { origin: 'subagent', parent: 's-main', createdAt: 1_700_000_000_200 }),
  ])
  deps.agents = () => agentsOf([])
  deps.projections = () => projectionsWithOfficial({
    's-child': { subagent: { mode: 'continuable', label: '遗留子代理', seq: 2 } },
  })
  const body = await buildTiers(deps)
  const map = byId(body.nodes)
  const child = map.get('s-child')
  assert.equal(child.mode, 'continuable')
  assert.equal(child.parentSessionId, 's-main', '父会话不活但直接创建者 id 仍是持久化真值')
  assert.equal(child.title, '遗留子代理')
})

test('官方契约：投影全失败 → 血缘照旧 + degraded 说明，mode 一律 unknown（不编）', async () => {
  const deps = happyDeps()
  deps.projections = () => ({
    snapshot() { throw new Error('projection exploded') },
  })
  const body = await buildTiers(deps)
  const map = byId(body.nodes)
  assert.equal(body.nodes.length, 7, '层级节点照旧（血缘来自 Session header）')
  assert.equal(map.get('s-child').mode, 'unknown')
  assert.equal(body.source.subagentMode, 'unavailable')
  assert.match(body.degraded.reason, /官方 subagent 投影读取失败/)
  assert.equal(JSON.stringify(body).includes('projection exploded'), false, '原始异常文本不进响应')
})
