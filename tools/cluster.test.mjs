#!/usr/bin/env node
/**
 * tools/cluster.test.mjs —— `/api/cluster` 路由与脱敏的断言集（node:test，零依赖）。
 *
 * 跑法（插件根目录）：
 *   node --test tools/
 *   node tools/cluster.test.mjs          # 直接跑也行，node:test 自带执行器
 *
 * 测的是什么：**真的 `lib/index.js` 的 `apply()`**，挂在一个假 ctx 上
 * （假 webServer 只捕获 route 函数，假 interconnect 返回固定行），
 * 然后用 `node:http` 起真 socket，用 `fetch` 打 HTTP——不是只调内部函数。
 *
 * 覆盖：
 *   A. sanitizeOrigin：userinfo / path / query / token / fragment 全剥干净；函数与坏值 → null
 *   B. buildCluster：字段形状、self 来源、链路只认 up、垃圾行过滤、服务缺失/读失败都不抛
 *   C. 路由：200 契约、no-store、405 JSON、api 命名空间 404 JSON、遍历防护、HEAD、
 *      无 interconnect 时 200 + interconnect:false、真实静态文件路由不退化
 *   D. 声明：inject 同时含 webServer 与 interconnect；注册的是 prefix 路由
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { BUTLER_STREAM_FILE, CLUSTER_FILE, ROUTE_PREFIX, SNAPSHOT_FILE, apply, inject } from '../lib/index.js'
import { buildCluster, sanitizeOrigin } from '../lib/cluster.js'

const FIXED_NOW = 1_795_000_000_000

/** 一条带用户名、口令、路径、token、fragment 的 origin：脱敏必须把它们全剥掉。 */
const DIRTY_ORIGIN = 'http://user:pass@127.0.0.1:13080/some/path?token=abc#frag'

/**
 * 假 ctx + 假 webServer：只捕获 route 函数，不起网络。
 *
 * v0.3.0 起 `apply()` 注册两条路由（prefix resource + exact action handler），
 * 这里两个都收下；读 API 的测试只用 prefix 的 resource。
 * @param {{interconnect?: unknown}} [options]
 * @returns {{resource: Function, actionHandler: Function, registration: object,
 *   registrations: object[], effects: string[]}}
 */
function mount(options = {}) {
  let resource = null
  let actionHandler = null
  const registrations = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
    webServer: {
      register(optionsIn) {
        registrations.push(optionsIn)
        if (typeof optionsIn.resource === 'function') resource = optionsIn.resource
        if (typeof optionsIn.handler === 'function') actionHandler = optionsIn.handler
        return () => {
          if (optionsIn.resource === resource) resource = null
          if (optionsIn.handler === actionHandler) actionHandler = null
        }
      },
    },
  }
  if ('interconnect' in options) ctx.interconnect = options.interconnect
  apply(ctx, {})
  assert.equal(typeof resource, 'function', 'apply 必须注册一个 prefix resource 路由')
  assert.equal(typeof actionHandler, 'function', 'apply 必须注册 POST api/action 的 handler 路由')
  return { resource, actionHandler, registrations, registration: registrations[0], effects }
}

/**
 * 起一个真 socket，把 Fetch 风格 route 接到 node:http 上。
 * @param {Function} resource - route 函数（Request → Response）。
 * @param {(baseUrl: string) => Promise<unknown>} run
 */
async function withRouteServer(resource, run) {
  let port = 0
  const server = createServer(async (req, res) => {
    try {
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers,
      })
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
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(done => server.close(done))
  }
}

/** 打一条路由，返回状态 / 头 / 原文。 */
async function hit(baseUrl, path, init) {
  const response = await fetch(baseUrl + path, init)
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

/** 本机现在的真实拓扑形状（4 个对端、全部 down）：stub 也用它，好断言顺序与脱敏。 */
function stubInterconnect() {
  return {
    selfSender: sessionId => ({ instanceId: 'pc-ky614', sessionId }),
    peers: () => [
      { instanceId: 'server', origin: DIRTY_ORIGIN, link: 'down' },
      { instanceId: 's5', origin: 'http://127.0.0.1:13082', link: 'down' },
      { instanceId: 'cloud', origin: 'http://127.0.0.1:13085', link: 'up' },
      { instanceId: 'mcloud', origin: () => 'http://10.26.0.4:13086', link: 'down' },
    ],
  }
}

/* ─────────────────────────── A. sanitizeOrigin ─────────────────────────── */

test('sanitizeOrigin 只留 host[:port]，userinfo/path/query/token/fragment 全剥掉', () => {
  assert.equal(sanitizeOrigin(DIRTY_ORIGIN), '127.0.0.1:13080')
  const clean = sanitizeOrigin(DIRTY_ORIGIN)
  for (const secret of ['user', 'pass', 'token', 'abc', 'some/path', '#']) {
    assert.equal(clean.includes(secret), false, `脱敏结果不许含 ${secret}`)
  }
})

test('sanitizeOrigin 接受常见 origin 写法', () => {
  assert.equal(sanitizeOrigin('http://127.0.0.1:13080'), '127.0.0.1:13080')
  assert.equal(sanitizeOrigin('  http://127.0.0.1:13080  '), '127.0.0.1:13080')
  assert.equal(sanitizeOrigin('https://example.com'), 'example.com')
  assert.equal(sanitizeOrigin('http://example.com:80'), 'example.com', '默认端口丢掉')
  assert.equal(sanitizeOrigin('https://example.com:8443'), 'example.com:8443')
  assert.equal(sanitizeOrigin('10.0.0.2:13080'), '10.0.0.2:13080', '无 scheme 也能解析')
  assert.equal(sanitizeOrigin('http://[::1]:13080'), '[::1]:13080')
  assert.equal(sanitizeOrigin('ws://127.0.0.1:13081'), '127.0.0.1:13081')
})

test('sanitizeOrigin 对函数 / 空值 / 坏值一律 null，绝不抛错', () => {
  const bad = [
    () => 'http://127.0.0.1:13080',
    undefined,
    null,
    '',
    '   ',
    42,
    {},
    ['http://x'],
    'not a url at all',
    'javascript:alert(1)',
    'file:///C:/tmp/x',
  ]
  for (const value of bad) {
    let got
    assert.doesNotThrow(() => { got = sanitizeOrigin(value) }, `不许抛：${String(value)}`)
    assert.equal(got, null, `应为 null：${String(value)}`)
  }
})

/* ─────────────────────────── B. buildCluster ─────────────────────────── */

test('buildCluster 产出页面契约字段（self + 4 对端按配置顺序）', () => {
  const got = buildCluster(stubInterconnect(), FIXED_NOW)
  assert.deepEqual(got, {
    generatedAt: new Date(FIXED_NOW).toISOString(),
    interconnect: true,
    self: { instanceId: 'pc-ky614' },
    peers: [
      { instanceId: 'server', origin: '127.0.0.1:13080', link: 'down' },
      { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
      { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'up' },
      { instanceId: 'mcloud', origin: null, link: 'down' },
    ],
    board: null,
  })
  const raw = JSON.stringify(got)
  for (const secret of ['pass@', 'token=abc', 'user:']) {
    assert.equal(raw.includes(secret), false, `响应不许含 ${secret}`)
  }
})

test('buildCluster：服务缺失 → interconnect:false，self=unknown，绝不抛错', () => {
  for (const value of [undefined, null, 'nope', 42, {}]) {
    let got
    assert.doesNotThrow(() => { got = buildCluster(value, FIXED_NOW) })
    assert.equal(got.interconnect, false, `interconnect 应为 false：${String(value)}`)
    assert.deepEqual(got.self, { instanceId: 'unknown' })
    assert.deepEqual(got.peers, [])
    assert.equal(got.board, null)
    assert.equal(got.error, undefined)
  }
})

test('buildCluster：selfSender 缺失/抛错 → self 仍为 unknown', () => {
  const withoutSelf = { peers: () => [{ instanceId: 'server', origin: 'http://h:1', link: 'up' }] }
  const got = buildCluster(withoutSelf, FIXED_NOW)
  assert.equal(got.interconnect, true)
  assert.deepEqual(got.self, { instanceId: 'unknown' })
  assert.deepEqual(got.peers, [{ instanceId: 'server', origin: 'h:1', link: 'up' }])

  const thrower = {
    selfSender() { throw new Error('boom: user:pass@secret') },
    peers: () => [],
  }
  const got2 = buildCluster(thrower, FIXED_NOW)
  assert.deepEqual(got2.self, { instanceId: 'unknown' })
  assert.equal(JSON.stringify(got2).includes('secret'), false)
})

test('buildCluster：peers() 抛错 → 结构化 error，不抛、不带原始错误文本', () => {
  const service = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers() { throw new Error('dial http://user:pass@127.0.0.1:1/x?token=abc failed') },
  }
  let got
  assert.doesNotThrow(() => { got = buildCluster(service, FIXED_NOW) })
  assert.equal(got.interconnect, true)
  assert.deepEqual(got.peers, [])
  assert.deepEqual(got.self, { instanceId: 'pc-ky614' })
  assert.equal(got.error, '读取 peers 失败')
  const raw = JSON.stringify(got)
  for (const secret of ['pass', 'token', 'dial']) {
    assert.equal(raw.includes(secret), false)
  }
})

test('buildCluster：垃圾行被跳过，link 只认 up', () => {
  const service = {
    selfSender: () => ({ instanceId: 'pc-ky614' }),
    peers: () => [
      null,
      'x',
      { instanceId: '' },
      { instanceId: '   ' },
      { instanceId: 'server', origin: 'http://127.0.0.1:13080', link: 'weird' },
      { instanceId: 'cloud', origin: null, link: 'UP' },
      { instanceId: 'mcloud', origin: 'http://127.0.0.1:13086', link: 'up' },
    ],
  }
  const got = buildCluster(service, FIXED_NOW)
  assert.deepEqual(got.peers, [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'down' },
    { instanceId: 'cloud', origin: null, link: 'down' },
    { instanceId: 'mcloud', origin: '127.0.0.1:13086', link: 'up' },
  ])
})

test('buildCluster：超长 instanceId 截断，时间参数非法时回落到 ISO', () => {
  const long = 'i'.repeat(300)
  const service = { selfSender: () => ({ instanceId: long }), peers: () => [] }
  const got = buildCluster(service, Number.NaN)
  assert.equal(got.self.instanceId.length, 80)
  assert.match(got.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

/* ─────────────────────────── C. 路由（真 socket） ─────────────────────────── */

test('路由：GET api/cluster 200 JSON，no-store，字段与形状正确', async () => {
  const host = mount({ interconnect: stubInterconnect() })
  await withRouteServer(host.resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${CLUSTER_FILE}`)
    assert.equal(got.status, 200)
    assert.match(got.headers.get('content-type'), /^application\/json/)
    assert.equal(got.headers.get('cache-control'), 'no-store')
    const body = JSON.parse(got.text)
    assert.deepEqual(Object.keys(body).sort(), ['board', 'generatedAt', 'interconnect', 'peers', 'self'])
    assert.equal(body.interconnect, true)
    assert.equal(body.self.instanceId, 'pc-ky614')
    assert.equal(body.peers.length, 4)
    assert.deepEqual(body.peers.map(p => p.instanceId), ['server', 's5', 'cloud', 'mcloud'])
    assert.deepEqual(body.peers.map(p => p.link), ['down', 'down', 'up', 'down'])
    assert.equal(body.peers[0].origin, '127.0.0.1:13080')
    assert.equal(body.peers[3].origin, null)
    for (const secret of ['pass', 'token', 'abc', 'user:']) {
      assert.equal(got.text.includes(secret), false, `响应不许含 ${secret}`)
    }
    // 尾部斜杠是同一个资源（generatedAt 每次重新生成，所以只比数据部分）
    const trailing = await hit(baseUrl, `${ROUTE_PREFIX}/${CLUSTER_FILE}/`)
    assert.equal(trailing.status, 200)
    const trailingBody = JSON.parse(trailing.text)
    assert.deepEqual(trailingBody.self, body.self)
    assert.deepEqual(trailingBody.peers, body.peers)
    assert.match(trailingBody.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('路由：HEAD api/cluster 同头无体；POST/PUT 是 405 JSON 且带 Allow', async () => {
  const host = mount({ interconnect: stubInterconnect() })
  await withRouteServer(host.resource, async baseUrl => {
    const head = await hit(baseUrl, `${ROUTE_PREFIX}/${CLUSTER_FILE}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.match(head.headers.get('content-type'), /^application\/json/)
    assert.equal(head.headers.get('cache-control'), 'no-store')

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${CLUSTER_FILE}`, { method })
      assert.equal(got.status, 405, `${method} 应为 405`)
      assert.match(got.headers.get('content-type'), /^application\/json/)
      assert.equal(got.headers.get('allow'), 'GET, HEAD')
      assert.deepEqual(JSON.parse(got.text), { ok: false, error: 'method-not-allowed' })
    }
  })
})

test('路由：api 命名空间里未知路径一律 JSON 404，不回 HTML', async () => {
  const host = mount({ interconnect: stubInterconnect() })
  await withRouteServer(host.resource, async baseUrl => {
    for (const path of [`${ROUTE_PREFIX}/api`, `${ROUTE_PREFIX}/api/nope`, `${ROUTE_PREFIX}/api/cluster/extra`]) {
      const got = await hit(baseUrl, path)
      assert.equal(got.status, 404, `${path} 应为 404`)
      assert.match(got.headers.get('content-type'), /^application\/json/)
      assert.deepEqual(JSON.parse(got.text), { ok: false, error: 'not-found' })
    }
  })
})

test('路由：无 interconnect 服务时仍是 200 + interconnect:false', async () => {
  const host = mount({}) // ctx 上根本没有 interconnect
  await withRouteServer(host.resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${CLUSTER_FILE}`)
    assert.equal(got.status, 200)
    const body = JSON.parse(got.text)
    assert.equal(body.interconnect, false)
    assert.deepEqual(body.self, { instanceId: 'unknown' })
    assert.deepEqual(body.peers, [])
    assert.equal(body.board, null)
  })
})

test('路由：interconnect 读失败时仍是 200 JSON（页面可兜底）', async () => {
  const broken = {
    selfSender: () => { throw new Error('secret detail') },
    peers: () => { throw new Error('secret detail') },
  }
  const host = mount({ interconnect: broken })
  await withRouteServer(host.resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${CLUSTER_FILE}`)
    assert.equal(got.status, 200)
    const body = JSON.parse(got.text)
    assert.equal(body.interconnect, true)
    assert.equal(body.error, '读取 peers 失败')
    assert.equal(got.text.includes('secret'), false)
  })
})

test('路由：静态文件路径不退化，编码遍历仍被挡住', async () => {
  const host = mount({ interconnect: stubInterconnect() })
  await withRouteServer(host.resource, async baseUrl => {
    const page = await hit(baseUrl, `${ROUTE_PREFIX}/index.html`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    assert.match(page.text, /^<!DOCTYPE html>/i)
    assert.equal(page.headers.get('cache-control'), 'no-store')

    // 无 snapshot 配置 → 204，仍是老行为
    const snapshot = await hit(baseUrl, `${ROUTE_PREFIX}/${SNAPSHOT_FILE}`)
    assert.equal(snapshot.status, 204)

    // %2e%2e%2f 解码后才逃逸：resolveTarget 必须给 403
    const escape = await hit(baseUrl, `${ROUTE_PREFIX}/%2e%2e%2f%2e%2e%2fcordis.patch.yml`)
    assert.equal(escape.status, 403)
    assert.equal(escape.text.includes('insert'), false)
  })
})

/* ─────────────────────────── D. 注册与声明 ─────────────────────────── */

test('inject 同时声明 webServer 与 interconnect；注册 prefix + exact action/say/session/stream handler', () => {
  assert.deepEqual(inject, ['webServer', 'interconnect'])
  const host = mount({ interconnect: stubInterconnect() })
  assert.equal(host.registration.kind, 'prefix')
  assert.equal(host.registration.path, ROUTE_PREFIX)
  assert.equal(host.registration.path, '/dsh-html-panel')
  const actionRoute = host.registrations[1]
  assert.equal(actionRoute.kind, 'exact')
  assert.equal(actionRoute.path, '/dsh-html-panel/api/action')
  assert.equal(typeof actionRoute.handler, 'function')
  // 0.8.0：两条 M2 写路由也是 exact raw handler。
  const exactPaths = host.registrations.filter(route => route.kind === 'exact').map(route => route.path)
  assert.deepEqual(exactPaths, ['/dsh-html-panel/api/action', '/dsh-html-panel/api/butler/say', '/dsh-html-panel/api/butler/session', '/dsh-html-panel/' + BUTLER_STREAM_FILE])
  for (const route of host.registrations.filter(item => item.kind === 'exact')) {
    assert.equal(typeof route.handler, 'function')
  }
  assert.equal(host.effects.length, 6) // prefix + 4 exact + hub dispose effect
  for (const effect of host.effects) assert.match(effect, /dsh-html-panel/)
})
