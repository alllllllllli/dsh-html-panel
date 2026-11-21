#!/usr/bin/env node
/**
 * tools/cdp-live.mjs —— 用 Edge headless + CDP 验证页面真的消费三条同源只读路由（零依赖）。
 *
 * 用法（插件根目录）: node tools/cdp-live.mjs
 *
 * 做法：本脚本起一个**同源静态服务器**，`/dsh-html-panel/index.html` 直接读
 * `public/index.html`（就是被测页面本身），`/dsh-html-panel/api/cluster|board|host`
 * 按场景返回可控 fixture；再用 Edge headless + DevTools 协议（Node 内置 WebSocket）
 * 打开页面断言。为什么不用 `msedge --screenshot`：本机 CLI 截图曾以退出码 13 失败；
 * CDP 还能在页面脚本之前挂错误钩子、量 scrollWidth、切换 fixture 制造轮询失败。
 *
 * 场景（fixture 内容全是假的，只为验证页面逻辑）：
 *   1. real-1440           板有 6 任务 + 8 事件、集群 0/4 up、本机 C/D 真值
 *                          → chip/日期行/五态/证据数/事件流/磁盘内存/板健康 + V4 交互 + 截图
 *   2. board-unreachable   板返回结构化 timeout 错误 → 任务/事件标「mock 兜底 · 原因」、
 *                          本机小部件仍是真值（模块隔离）+ 截图
 *   3. board-unconfigured  configured:false → 「板未配置」空态、看板动作可点但如实标注原因 + 截图
 *   4. board-empty         板在线但 0 任务 0 事件 → 「板上暂无任务」「暂无事件」+ 截图
 *   5. cluster-down-404    api/cluster 404 → 只有拓扑回落 mock，任务仍是真实数据
 *   6. narrow-900          900 宽：scrollWidth==innerWidth、面板不溢出 + 截图
 *   7. poll-no-flash       首屏真实，随后板 fixture 切成错误；等 30 秒轮询后
 *                          **保留上一次真实任务**、只多一个「数据过期 · HH:MM:SS / 原因」badge + 截图
 *
 * 产物：tools/shots/shot-*.png 与 tools/shots/cdp-report.json（只写相对路径）。
 * 断言失败退出码 1。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_FILE = path.join(ROOT, 'public', 'index.html')
const OUT_DIR = path.join(ROOT, 'tools', 'shots')
const ROUTE = '/dsh-html-panel'
const STORE_KEY = 'dsh-workbench-todos-b'
const POLL_WAIT_MS = 33_000

/* ───────────────────────── 假 fixture：页面逻辑只认契约 ───────────────────────── */

const CLUSTER_REAL = {
  generatedAt: '2026-11-21T05:50:00.000Z',
  interconnect: true,
  self: { instanceId: 'pc-ky614' },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'down' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
    { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'down' },
    { instanceId: 'mcloud', origin: '127.0.0.1:13086', link: 'down' }
  ],
  board: null
}

const BOARD_TASKS = [
  { id: 't-leased', title: '核对板服务监听地址', state: 'leased', owner: 'dev-a', node: 'pc-a',
    evidenceCount: 2, lifecycle: 'working', ackState: 'acked', updatedAt: Date.now() - 120_000,
    acceptance: ['三处取证', '独立复核'], brief: '演示租约中的任务' },
  { id: 't-awaiting', title: '等回执的任务', state: 'awaiting', owner: null, node: null,
    evidenceCount: 1, lifecycle: 'open', ackState: 'pending', updatedAt: Date.now() - 300_000,
    acceptance: ['回执到位'], brief: '' },
  { id: 't-undelivered', title: '未送达的任务', state: 'undelivered', owner: null, node: null,
    evidenceCount: 0, lifecycle: 'open', ackState: 'none', updatedAt: Date.now() - 600_000,
    acceptance: [], brief: '' },
  { id: 't-stale', title: '租约过期的任务', state: 'stale', owner: 'dev-c', node: 'pc-c',
    evidenceCount: 1, lifecycle: 'working', ackState: 'acked', updatedAt: Date.now() - 3_600_000,
    acceptance: [], brief: '' },
  { id: 't-done', title: '已完成的任务', state: 'done', owner: 'dev-b', node: 'pc-b',
    evidenceCount: 3, lifecycle: 'done', ackState: 'acked', updatedAt: Date.now() - 7_200_000,
    acceptance: ['验收通过'], brief: '' },
  { id: 't-blocked', title: '原始状态透传的任务', state: 'blocked', owner: null, node: null,
    evidenceCount: 0, lifecycle: 'blocked', ackState: 'none', updatedAt: Date.now() - 400_000,
    acceptance: [], brief: '' }
]

const BOARD_EVENTS = Array.from({ length: 8 }, (_, index) => ({
  task: index < 5 ? BOARD_TASKS[index].id : '',
  at: Date.now() - (index + 1) * 60_000,
  kind: index % 2 === 0 ? 'task.created' : 'task.reported',
  node: index % 2 === 0 ? 'lead' : 'dev-a',
  text: '演示事件正文 ' + (index + 1),
  seq: 50 - index
}))

const BOARD_REAL = {
  generatedAt: '2026-11-21T05:50:01.000Z',
  configured: true,
  source: { origin: 'http://172.24.112.14:13090' },
  health: { ok: true, latencyMs: 37, service: 'dsh-team-mesh board', version: '0.5.0', schema_version: 4 },
  tasks: BOARD_TASKS,
  events: BOARD_EVENTS,
  cached: false
}

const BOARD_REACHABLE_EMPTY = {
  generatedAt: '2026-11-21T05:50:01.000Z',
  configured: true,
  source: { origin: 'http://172.24.112.14:13090' },
  health: { ok: true, latencyMs: 12, service: 'dsh-team-mesh board', version: '0.5.0', schema_version: 4 },
  tasks: [],
  events: [],
  cached: false
}

const BOARD_UNREACHABLE = {
  generatedAt: '2026-11-21T05:50:02.000Z',
  configured: true,
  source: { origin: 'http://172.24.112.14:13090' },
  health: null,
  tasks: [],
  events: [],
  cached: false,
  error: { code: 'timeout', message: '连共享板超时（4000ms）：http://172.24.112.14:13090' }
}

const BOARD_UNCONFIGURED = {
  generatedAt: '2026-11-21T05:50:03.000Z',
  configured: false,
  source: null,
  health: null,
  tasks: [],
  events: [],
  cached: false,
  error: { code: 'board-not-configured', message: '未配置共享板：profile 里给 dsh-html-panel 加 config.board.endpoint' }
}

const HOST_REAL = {
  generatedAt: '2026-11-21T05:50:00.500Z',
  hostname: 'test-host',
  os: { platform: 'win32', release: '10.0.26340', uptimeSec: 50_000 },
  memory: { totalBytes: 34_359_738_368, freeBytes: 17_179_869_184, ratio: 0.5 },
  cpu: { count: 12, load1: 0 },
  disks: [
    { mount: 'C:', label: 'C: 系统盘', totalBytes: 155_692_564_480, freeBytes: 107_374_182_400, ratio: 0.31 },
    { mount: 'D:', label: 'D: 数据盘', totalBytes: 1_030_792_151_040, freeBytes: 579_820_584_960, ratio: 0.44 }
  ]
}

const REAL_FIXTURES = {
  cluster: { kind: 'json', body: CLUSTER_REAL },
  board: { kind: 'json', body: BOARD_REAL },
  host: { kind: 'json', body: HOST_REAL }
}

const SCENARIOS = [
  {
    name: 'real-1440',
    width: 1440,
    height: 1000,
    fixtures: REAL_FIXTURES,
    expect: 'real',
    shot: 'shot-01-real-data-1440.png',
    interactions: true
  },
  {
    name: 'board-unreachable-1440',
    width: 1440,
    height: 1000,
    fixtures: { cluster: { kind: 'json', body: CLUSTER_REAL }, board: { kind: 'json', body: BOARD_UNREACHABLE }, host: { kind: 'json', body: HOST_REAL } },
    expect: 'board-mock',
    shot: 'shot-02-board-unreachable-1440.png'
  },
  {
    name: 'board-unconfigured-1440',
    width: 1440,
    height: 1000,
    fixtures: { cluster: { kind: 'json', body: CLUSTER_REAL }, board: { kind: 'json', body: BOARD_UNCONFIGURED }, host: { kind: 'json', body: HOST_REAL } },
    expect: 'board-unconfigured',
    shot: 'shot-03-board-unconfigured-1440.png'
  },
  {
    name: 'board-empty-1440',
    width: 1440,
    height: 1000,
    fixtures: { cluster: { kind: 'json', body: CLUSTER_REAL }, board: { kind: 'json', body: BOARD_REACHABLE_EMPTY }, host: { kind: 'json', body: HOST_REAL } },
    expect: 'board-empty',
    shot: 'shot-04-board-empty-1440.png'
  },
  {
    name: 'cluster-down-404',
    width: 1440,
    height: 1000,
    fixtures: { cluster: { kind: 'missing' }, board: { kind: 'json', body: BOARD_REAL }, host: { kind: 'json', body: HOST_REAL } },
    expect: 'cluster-mock'
  },
  {
    name: 'narrow-900',
    width: 900,
    height: 1000,
    fixtures: REAL_FIXTURES,
    expect: 'real',
    shot: 'shot-05-narrow-900.png'
  },
  {
    name: 'poll-no-flash',
    width: 1440,
    height: 1000,
    fixtures: REAL_FIXTURES,
    expect: 'poll',
    shot: 'shot-06-stale-after-poll.png'
  }
]

/* ───────────────────────── 断言小工具 ───────────────────────── */
let passed = 0
const failures = []
function ok(condition, label, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failures.push(label + (detail ? '（' + detail + '）' : ''))
  return false
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return ok(a === b, label, a === b ? '' : '期望 ' + b + '，实际 ' + a)
}
function includes(actual, needle, label) {
  return ok(String(actual || '').includes(needle), label, String(actual || '').slice(0, 120))
}

/* ───────────────────────── 同源静态服务器 + 可控 fixture ───────────────────────── */
async function startFixtureServer() {
  const state = {
    fixtures: { cluster: { kind: 'missing' }, board: { kind: 'missing' }, host: { kind: 'missing' } }
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    if (pathname === `${ROUTE}/index.html` || pathname === `${ROUTE}/`) {
      try {
        const html = await readFile(PAGE_FILE)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('page read failed: ' + String((error && error.message) || error))
      }
      return
    }
    for (const name of ['cluster', 'board', 'host']) {
      if (pathname === `${ROUTE}/api/${name}`) {
        const fixture = state.fixtures[name]
        if (fixture.kind === 'missing') {
          res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
          res.end('not found')
        } else if (fixture.kind === 'badjson') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end('{definitely not json')
        } else {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(fixture.body))
        }
        return
      }
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end('not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${port}${ROUTE}/index.html`,
    setFixtures(fixtures) { state.fixtures = fixtures },
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.() })
  }
}

/* ───────────────────────── 最小 CDP 客户端 ───────────────────────── */
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => existsSync(p))

async function pickPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) })
      continue // 端口已被占用
    } catch {
      return port
    }
  }
  throw new Error('no free CDP port')
}

async function launchEdge(port, profileDir) {
  const { spawn } = await import('node:child_process')
  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--force-device-scale-factor=1',
    '--window-size=1440,1000',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: 'ignore' })
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })).json()
      if (info && info.webSocketDebuggerUrl) return child
    } catch {
      /* 还没起来 */
    }
    await new Promise(done => setTimeout(done, 250))
  }
  child.kill()
  throw new Error('Edge CDP did not come up')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  const handlers = new Map()
  ws.addEventListener('message', event => {
    let msg
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error('CDP ' + JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    if (msg.method && handlers.has(msg.method)) {
      for (const fn of handlers.get(msg.method)) {
        try { fn(msg.params) } catch { /* 观察器异常不影响被测页面 */ }
      }
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', event => reject(new Error('ws error ' + String((event && event.message) || event))), { once: true })
  })
  function send(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  function on(method, fn) {
    handlers.set(method, [...(handlers.get(method) || []), fn])
  }
  function once(method, timeout = 20_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting ' + method)), timeout)
      const fn = params => {
        clearTimeout(timer)
        handlers.set(method, (handlers.get(method) || []).filter(f => f !== fn))
        resolve(params)
      }
      on(method, fn)
    })
  }
  return { ws, opened, send, on, once }
}

/* ───────────────────────── 主流程 ───────────────────────── */
const report = { page: 'public/index.html', scenarios: [], checks: {}, pageErrors: [], ok: false }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 轮询一个返回布尔值的页面表达式，超时返回 false。 */
async function waitFor(evaluate, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      /* 页面还没就绪 */
    }
    await sleep(100)
  }
  return false
}

const PAGE_STATE_EXPR = `(() => {
  const text = sel => (document.querySelector(sel) || {}).textContent || '';
  const chip = sel => {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\\s+/g, " ").trim() : null;
  };
  const tabPanelVisible = id => {
    const el = document.getElementById(id);
    return !!el && !el.hidden;
  };
  const rows = sel => [...document.querySelectorAll(sel)];
  const taskRows = rows('#taskList .item');
  const eventRows = rows('#eventList .item');
  const diskRows = rows('#diskRows .disk-row');
  return {
    chips: {
      cluster: chip('#chipCluster'),
      board: chip('#chipBoard'),
      tasks: chip('#chipTasks'),
      stale: document.getElementById('chipStale') && !document.getElementById('chipStale').hidden
        ? text('#chipStaleText') : null
    },
    meta: {
      self: text('#selfLine'),
      board: text('#boardSourceLine'),
      data: text('#dataStamp'),
      recentHint: text('#recentHint'),
      widgetsHint: text('#widgetsHint')
    },
    tasks: {
      count: taskRows.length,
      states: taskRows.map(row => {
        const badge = row.querySelector('.st');
        return badge ? badge.className.replace('st ', '') : null;
      }),
      stateTexts: taskRows.map(row => (row.querySelector('.st') || {}).textContent || ''),
      firstTitle: taskRows.length ? (taskRows[0].querySelector('.item-title') || {}).textContent || '' : '',
      firstMeta: taskRows.length ? (taskRows[0].querySelector('.item-meta') || {}).textContent || '' : '',
      tabCount: text('#taskTabCount'),
      emptyHidden: (document.getElementById('taskEmpty') || {}).hidden,
      emptyText: text('#taskEmpty')
    },
    events: {
      count: eventRows.length,
      firstTime: eventRows.length ? (eventRows[0].querySelector('.evt-time') || {}).textContent || '' : '',
      firstKind: eventRows.length ? (eventRows[0].querySelector('.evt-kind') || {}).textContent || '' : '',
      firstText: eventRows.length ? (eventRows[0].querySelector('.evt-text') || {}).textContent || '' : '',
      firstMeta: eventRows.length ? (eventRows[0].querySelector('.evt-meta') || {}).textContent || '' : '',
      tabCount: text('#eventTabCount'),
      emptyHidden: (document.getElementById('eventEmpty') || {}).hidden,
      emptyText: text('#eventEmpty')
    },
    host: {
      diskCount: diskRows.length,
      diskText: diskRows.map(row => row.textContent),
      memTotal: text('#memTotal'),
      memUsed: text('#memUsed'),
      memRatio: text('#memRatio'),
      memBarWidth: (document.getElementById('memBar') || {}).style ? document.getElementById('memBar').style.width : null,
      osLine: text('#osLine'),
      boardHealthSrc: text('#boardHealthSrc'),
      boardLat: text('#boardLat'),
      boardLatNote: text('#boardLatNote')
    },
    topo: {
      badgeState: (document.getElementById('topoSource') || {}).getAttribute
        ? document.getElementById('topoSource').getAttribute('data-state') : null,
      badgeText: text('#topoSourceText'),
      nodes: document.querySelectorAll('#topoNodes .node').length,
      edges: document.querySelectorAll('#topoEdges > line').length,
      pending: document.querySelectorAll('#topoNodes .pending').length,
      rects: [...document.querySelectorAll('#topoNodes .node-rect')].map(el => el.getAttribute('class').replace('node-rect ', '')),
      svgTitle: text('#topoTitle')
    },
    boardAction: {
      disabled: (() => { const el = document.querySelector('#actionList [data-action="board"]'); return el ? el.disabled : null; })(),
      desc: (() => {
        const el = document.querySelector('#actionList [data-action="board"]');
        const span = el ? el.querySelector('.txt span') : null;
        return span ? span.textContent : null;
      })()
    },
    layout: {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      topbarVisible: !!document.querySelector('.topbar'),
      topbarText: text('.topbar')
    },
    tabs: {
      tasksSelected: (document.getElementById('tab-tasks') || {}).getAttribute
        ? document.getElementById('tab-tasks').getAttribute('aria-selected') : null,
      eventsSelected: (document.getElementById('tab-events') || {}).getAttribute
        ? document.getElementById('tab-events').getAttribute('aria-selected') : null,
      tasksPanelVisible: tabPanelVisible('panel-tasks'),
      eventsPanelVisible: tabPanelVisible('panel-events')
    },
    panelErrors: (window.__panelErrors || []).slice(0, 5)
  };
})()`

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  if (!existsSync(PAGE_FILE)) throw new Error('找不到页面文件')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-panel-board-' + Date.now())
  await mkdir(profileDir, { recursive: true })

  const site = await startFixtureServer()
  const port = await pickPort(9350)
  let child = null
  let browser = null
  try {
    child = await launchEdge(port, profileDir)
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const pageTarget = list.find(t => t.type === 'page')
    if (!pageTarget) throw new Error('no page target')

    browser = connect(pageTarget.webSocketDebuggerUrl)
    await browser.opened
    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    await browser.send('Log.enable')
    await browser.send('Network.enable')

    // 在页面脚本之前挂错误钩子：断言「没有 JS 报错」靠它
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__panelErrors=[];' +
        "addEventListener('error',e=>{try{window.__panelErrors.push('error: '+String(e.message||e))}catch(_){}});" +
        "addEventListener('unhandledrejection',e=>{try{window.__panelErrors.push('rejection: '+String(e.reason))}catch(_){}});"
    })

    const requests = []
    browser.on('Network.requestWillBeSent', params => { requests.push(params.request.url) })
    const runtimeErrors = []
    browser.on('Runtime.exceptionThrown', params => {
      const text = params && params.exceptionDetails
        ? String(params.exceptionDetails.text || '') + ' ' + String(
          (params.exceptionDetails.exception && params.exceptionDetails.exception.description) || '')
        : 'unknown exception'
      runtimeErrors.push(text.trim().slice(0, 160))
    })
    browser.on('Log.entryAdded', params => {
      // 网络层 4xx/5xx 会以 source='network' 出现在这里：那是本页**故意探测**的失败分支
      // （cluster 404 → 拓扑 mock 兜底），页面处理了，不算 JS 报错。
      if (params && params.entry && params.entry.level === 'error' && params.entry.source !== 'network') {
        runtimeErrors.push('console: ' + String(params.entry.text || '').slice(0, 160))
      }
    })

    const evaluate = async expression => {
      const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails))
      return result.result ? result.result.value : undefined
    }
    const readPage = () => evaluate(PAGE_STATE_EXPR)

    /** 加载当前场景并等三条数据都离开 loading。 */
    async function openScenario(scenario) {
      site.setFixtures(scenario.fixtures)
      requests.length = 0
      runtimeErrors.length = 0
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: scenario.width,
        height: scenario.height,
        deviceScaleFactor: 1,
        mobile: false
      })
      const loaded = browser.once('Page.loadEventFired', 25_000)
      await browser.send('Page.navigate', { url: site.pageUrl })
      await loaded
      const settled = await waitFor(
        evaluate,
        "(() => { const hint = (document.querySelector('#recentHint')||{}).textContent || '';" +
          "const badge = (document.querySelector('#topoSource')||{}).getAttribute ? document.querySelector('#topoSource').getAttribute('data-state') : '';" +
          "const os = (document.querySelector('#osLine')||{}).textContent || '';" +
          "return hint !== '载入中…' && hint !== '' && badge !== 'loading' && os !== '载入中…' && os !== ''; })()",
        6000
      )
      ok(settled, `${scenario.name}: 三条数据源都离开 loading 状态`)
      await sleep(120)
      await evaluate('window.scrollTo(0,0)')
      return readPage()
    }

    async function screenshot(scenario, name) {
      const dims = await evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
      const clip = { x: 0, y: 0, width: Math.max(1, dims.w), height: Math.max(1, dims.h), scale: 1 }
      const png = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip })
      await writeFile(path.join(OUT_DIR, name), Buffer.from(png.data, 'base64'))
      return { shot: 'tools/shots/' + name, clip }
    }

    for (const scenario of SCENARIOS) {
      const view = await openScenario(scenario)
      report.scenarios.push({ name: scenario.name, viewport: [scenario.width, scenario.height], view })

      /* ---- 每个场景都成立的：无页面 JS 报错、无横向溢出、只有同源请求 ---- */
      eq(view.panelErrors, [], `${scenario.name}: 页面无 JS 报错`)
      ok(view.layout.scrollWidth <= view.layout.innerWidth,
        `${scenario.name}: 无横向溢出`, `scrollWidth=${view.layout.scrollWidth} innerWidth=${view.layout.innerWidth}`)
      const external = requests.filter(url => url.startsWith('http') && !url.startsWith(site.baseUrl))
      eq(external, [], `${scenario.name}: 只有同源请求`)
      const apiHits = ['cluster', 'board', 'host'].map(name => requests.some(url => url.includes('/api/' + name)))
      eq(apiHits, [true, true, true], `${scenario.name}: 三个 api 路由都被请求`)
      eq(view.topo.nodes, 4, `${scenario.name}: 4 个拓扑节点`)
      eq(view.topo.edges, 5, `${scenario.name}: 5 条拓扑边`)
      eq(view.topo.pending, 1, `${scenario.name}: 1 个待接入节点`)
      ok(/(interconnect|链路)/.test(view.layout.topbarText), `${scenario.name}: 顶栏 chip 是链路文案`, view.layout.topbarText)
      ok(!/DSH 0\.4\.0|127\.0\.0\.1:13090|mock 在线/.test(view.layout.topbarText),
        `${scenario.name}: 顶栏无假文案`, view.layout.topbarText)

      /* ---- 本机小部件在全部场景都来自 api/host（真值） ---- */
      eq(view.host.diskCount, 2, `${scenario.name}: 两块磁盘`)
      includes(view.host.diskText[0], 'C:', `${scenario.name}: C 盘真值`)
      includes(view.host.diskText[1], 'D:', `${scenario.name}: D 盘真值`)
      eq(view.host.memTotal, '32.0 GB', `${scenario.name}: 内存总量真值`)
      eq(view.host.memUsed, '16.0 GB', `${scenario.name}: 内存已用真值`)
      eq(view.host.memRatio, '50%', `${scenario.name}: 内存比例真值`)
      eq(view.host.memBarWidth, '50%', `${scenario.name}: 内存进度条真值`)
      includes(view.host.osLine, 'test-host', `${scenario.name}: 主机名真值`)

      /* ---- 真实态：板 + 集群 + 本机全部真实 ---- */
      if (scenario.expect === 'real') {
        eq(view.chips.cluster, 'interconnect 0/4 up', `${scenario.name}: 链路 chip 0/4 up`)
        eq(view.chips.board, '板 在线 · 37ms', `${scenario.name}: 板 chip 在线+延迟`)
        eq(view.chips.tasks, '板上 6 任务', `${scenario.name}: 任务 chip 数量`)
        ok(view.chips.stale === null, `${scenario.name}: 无过期 badge`)
        includes(view.meta.self, 'pc-ky614', `${scenario.name}: 实例名来自 api/cluster`)
        eq(view.meta.board, '板 http://172.24.112.14:13090', `${scenario.name}: 板来源来自 source.origin`)
        ok(/^数据 \d{2}:\d{2}:\d{2}$/.test(view.meta.data), `${scenario.name}: 数据时间戳真实`, view.meta.data)
        eq(view.meta.widgetsHint, '本机 · 只读', `${scenario.name}: 小部件定位「本机 · 只读」`)
        eq(view.meta.recentHint, '共享板 http://172.24.112.14:13090 · 只读', `${scenario.name}: 板模块 hint 真实`)

        eq(view.tasks.count, 6, `${scenario.name}: 6 个真实任务`)
        eq(view.tasks.states, ['leased', 'awaiting', 'undelivered', 'stale', 'done', 'unknown'], `${scenario.name}: 五态 + 原样透传`)
        eq(view.tasks.stateTexts, ['租约中', '等回执', '未送达', '已过期', '已完成', '未知 · blocked'], `${scenario.name}: 五态文案`)
        includes(view.tasks.firstTitle, '核对板服务监听地址', `${scenario.name}: 任务标题来自板`)
        includes(view.tasks.firstMeta, '2 条证据', `${scenario.name}: 任务证据数来自 /task/evidence`)
        includes(view.tasks.firstMeta, '节点 pc-a', `${scenario.name}: 任务节点来自 lease_host`)
        eq(view.tasks.tabCount, '6', `${scenario.name}: 任务标签计数`)
        eq(view.tasks.emptyHidden, true, `${scenario.name}: 有任务时空态隐藏`)

        eq(view.events.count, 8, `${scenario.name}: 8 个真实事件`)
        ok(/^\d{2}:\d{2}:\d{2}$/.test(view.events.firstTime), `${scenario.name}: 事件时间格式化`, view.events.firstTime)
        eq(view.events.firstKind, 'task.created', `${scenario.name}: 事件类型`)
        includes(view.events.firstText, '演示事件正文 1', `${scenario.name}: 事件正文`)
        includes(view.events.firstMeta, '任务 t-leased', `${scenario.name}: 事件关联任务`)
        eq(view.events.tabCount, '8', `${scenario.name}: 事件标签计数`)
        eq(view.events.emptyHidden, true, `${scenario.name}: 有事件时空态隐藏`)

        eq(view.host.boardHealthSrc, '板 在线', `${scenario.name}: 板健康状态`)
        eq(view.host.boardLat, '37 ms', `${scenario.name}: 板健康延迟真值`)
        eq(view.boardAction.disabled, false, `${scenario.name}: 打开看板可用`)
        eq(view.boardAction.desc, '共享板 http://172.24.112.14:13090', `${scenario.name}: 看板动作地址来自 source.origin`)
        eq(view.topo.badgeState, 'real', `${scenario.name}: 拓扑 badge=real`)
        eq(view.topo.rects, ['offline', 'online', 'offline', 'offline'], `${scenario.name}: 拓扑状态映射（self 在线，四个对端 down）`)
      }

      /* ---- 板不可达：任务/事件 mock 兜底、本机仍真值 ---- */
      if (scenario.expect === 'board-mock') {
        includes(view.meta.recentHint, 'mock 兜底 · ', `${scenario.name}: 板模块标 mock 兜底`)
        includes(view.meta.recentHint, 'timeout', `${scenario.name}: mock 兜底写明原因`)
        eq(view.chips.board, '板 不可达', `${scenario.name}: 板 chip 不可达`)
        eq(view.chips.tasks, '任务 mock 兜底', `${scenario.name}: 任务 chip mock 兜底`)
        eq(view.tasks.count, 6, `${scenario.name}: 兜底任务仍渲染 6 条（已标注）`)
        includes(view.tasks.firstTitle, '示例任务', `${scenario.name}: 兜底任务标题明确是示例`)
        eq(view.boardAction.disabled, false, `${scenario.name}: 看板动作不可达时仍可点（点后给原因）`)
        eq(view.boardAction.desc, '板不可达（点击查看原因）', `${scenario.name}: 看板动作如实标注不可达`)
        eq(view.host.boardHealthSrc, '板 不可达', `${scenario.name}: 板健康不可达`)
        includes(view.meta.widgetsHint, '本机 · 只读', `${scenario.name}: 本机数据不受板故障影响`)
        eq(view.chips.cluster, 'interconnect 0/4 up', `${scenario.name}: 链路数据不受板故障影响`)
      }

      /* ---- 板未配置 ---- */
      if (scenario.expect === 'board-unconfigured') {
        eq(view.chips.board, '板 未配置', `${scenario.name}: 板 chip 未配置`)
        eq(view.chips.tasks, '任务 板未配置', `${scenario.name}: 任务 chip 未配置`)
        eq(view.meta.recentHint, '板未配置', `${scenario.name}: 板模块 hint`)
        eq(view.tasks.count, 0, `${scenario.name}: 未配置时不造假任务`)
        eq(view.tasks.emptyHidden, false, `${scenario.name}: 显示空态`)
        includes(view.tasks.emptyText, '板未配置', `${scenario.name}: 空态说明原因`)
        eq(view.events.emptyHidden, false, `${scenario.name}: 事件空态`)
        includes(view.events.emptyText, '板未配置', `${scenario.name}: 事件空态说明原因`)
        eq(view.boardAction.disabled, false, `${scenario.name}: 板未配置时仍可点（点后给原因）`)
        eq(view.boardAction.desc, '板未配置（点击查看原因）', `${scenario.name}: 看板动作标注未配置`)
        eq(view.host.boardHealthSrc, '板 未配置', `${scenario.name}: 板健康未配置`)
        eq(view.meta.board, '板 未配置', `${scenario.name}: 日期行板来源`)
      }

      /* ---- 板在线但空 ---- */
      if (scenario.expect === 'board-empty') {
        eq(view.chips.tasks, '板上 0 任务', `${scenario.name}: 任务数 0`)
        eq(view.tasks.count, 0, `${scenario.name}: 没有任务行`)
        eq(view.tasks.emptyHidden, false, `${scenario.name}: 任务空态可见`)
        eq(view.tasks.emptyText, '板上暂无任务', `${scenario.name}: 任务空态文案`)
        eq(view.events.emptyHidden, false, `${scenario.name}: 事件空态可见`)
        eq(view.events.emptyText, '暂无事件', `${scenario.name}: 事件空态文案`)
        eq(view.host.boardHealthSrc, '板 在线', `${scenario.name}: 板在线空数据`)
      }

      /* ---- 集群 404：只有拓扑回落 mock，板数据仍是真值 ---- */
      if (scenario.expect === 'cluster-mock') {
        eq(view.topo.badgeState, 'mock', `${scenario.name}: 拓扑 badge=mock`)
        includes(view.topo.badgeText, 'mock 兜底 · 真实数据不可用：HTTP 404', `${scenario.name}: 拓扑兜底原因`)
        includes(view.topo.svgTitle, 'mock 兜底', `${scenario.name}: SVG title 标 mock`)
        eq(view.chips.cluster, '链路 mock 兜底', `${scenario.name}: 链路 chip mock`)
        includes(view.meta.self, 'mock 兜底', `${scenario.name}: 实例名如实标 mock`)
        eq(view.tasks.count, 6, `${scenario.name}: 板任务不受集群故障影响`)
        includes(view.meta.recentHint, '共享板 ', `${scenario.name}: 板模块仍真实`)
      }

      /* ---- 轮询：先真实，切错误后保留好数据 + 过期 badge ---- */
      if (scenario.expect === 'poll') {
        // 先确认首屏真实
        eq(view.tasks.count, 6, `${scenario.name}: 首屏 6 条真实任务`)
        includes(view.tasks.firstTitle, '核对板服务监听地址', `${scenario.name}: 首屏真实标题`)
        // 把板 fixture 切成错误体，等 30 秒轮询
        site.setFixtures({ ...REAL_FIXTURES, board: { kind: 'json', body: BOARD_UNREACHABLE } })
        const appeared = await waitFor(
          evaluate,
          "(() => { const el = document.getElementById('chipStale'); return !!el && !el.hidden; })()",
          POLL_WAIT_MS
        )
        ok(appeared, `${scenario.name}: 30 秒轮询后出现过期 badge`)
        const after = await readPage()
        report.scenarios[report.scenarios.length - 1].afterPoll = after
        includes(after.chips.stale, '数据过期 · ', `${scenario.name}: 过期 badge 文案`)
        includes(after.chips.stale, '共享板', `${scenario.name}: 过期 badge 指明模块`)
        includes(after.chips.stale, '超时', `${scenario.name}: 过期 badge 写明原因`)
        eq(after.tasks.count, 6, `${scenario.name}: 轮询失败仍保留上一次真实任务`)
        includes(after.tasks.firstTitle, '核对板服务监听地址', `${scenario.name}: 保留真实标题而不是 mock`)
        eq(after.tasks.firstTitle.includes('示例任务'), false, `${scenario.name}: 没有闪回 mock`)
        includes(after.meta.recentHint, '共享板 ', `${scenario.name}: 板模块 hint 仍是真实来源`)
        eq(after.chips.board, '板 在线 · 37ms', `${scenario.name}: chip 保留上一次好数据`)
        eq(after.panelErrors, [], `${scenario.name}: 轮询后无 JS 报错`)
        eq(after.tabs.tasksPanelVisible, true, `${scenario.name}: 任务面板仍可见`)
        eq(after.events.count, 8, `${scenario.name}: 事件也保留上一次好数据`)
      }

      /* ---- 截图 ---- */
      if (scenario.shot) {
        const shot = await screenshot(scenario, scenario.shot)
        report.scenarios[report.scenarios.length - 1].shot = shot.shot
        report.scenarios[report.scenarios.length - 1].clip = shot.clip
      }

      /* ---- V4 交互回归（只在真实态做一次） ---- */
      if (scenario.interactions) {
        const clock1 = await evaluate("document.querySelector('#clock').textContent")
        await sleep(1150)
        const clock2 = await evaluate("document.querySelector('#clock').textContent")
        ok(clock1 !== clock2, 'V4: 时钟走秒', `${clock1} -> ${clock2}`)

        const interact = await evaluate(`(async () => {
          const out = {};
          document.querySelector('#actionList [data-action="new-session"]').click();
          // 动作是异步的：等一拍让独立页的「暂不支持」回执落定再读
          await new Promise(function (resolve) { setTimeout(resolve, 120); });
          out.receipts = document.querySelectorAll('#receiptList li').length;
          out.receiptText = document.querySelector('#receiptList li').textContent;
          const cb = document.querySelector('#todoList input[type="checkbox"]:not(:checked)');
          const label = cb ? (document.querySelector('label[for="' + cb.id + '"]') || {}).textContent : '';
          if (cb) cb.click();
          let store = null;
          try { store = JSON.parse(localStorage.getItem(${JSON.stringify(STORE_KEY)}) || 'null'); } catch (e) {}
          out.todoLabel = label;
          out.checkedPersisted = Array.isArray(store) && store.some(t => t.text === label && t.done === true);
          out.storeHasItems = Array.isArray(store) && store.length > 0;
          document.querySelector('#tab-events').click();
          out.eventsTabOpen = document.querySelector('#panel-events').hidden === false;
          out.tasksTabHidden = document.querySelector('#panel-tasks').hidden === true;
          out.eventRows = document.querySelectorAll('#eventList .item').length;
          out.actionCount = document.querySelectorAll('#actionList .action').length;
          out.disabledRestart = !!document.querySelector('#actionList .action[disabled][aria-describedby="disabledReason"]');
          out.todoCount = document.querySelectorAll('#todoList .todo').length;
          out.taskDetailToggle = (() => {
            document.querySelector('#tab-tasks').click();
            const row = document.querySelector('#taskList .item-row');
            if (!row) return null;
            row.click();
            const detail = document.getElementById(row.getAttribute('aria-controls'));
            return { expanded: row.getAttribute('aria-expanded'), detailHidden: detail ? detail.hidden : null };
          })();
          return out;
        })()`)
        report.scenarios[report.scenarios.length - 1].interactions = interact
        ok(interact.receipts >= 1 && String(interact.receiptText).includes('暂不支持'), 'V4: 动作回执出现（独立页如实暂不支持）')
        ok(interact.storeHasItems && interact.checkedPersisted, 'V4: 待办勾选写入 localStorage')
        ok(interact.eventsTabOpen && interact.tasksTabHidden, 'V4: 标签页切换到事件流')
        eq(interact.eventRows, 8, 'V4: 事件流行数')
        eq(interact.actionCount, 6, 'V4: 常用动作 6 个')
        ok(interact.disabledRestart, 'V4: 重启按钮仍禁用')
        ok(interact.todoCount > 0, 'V4: 待办列表非空')
        eq(interact.taskDetailToggle, { expanded: 'true', detailHidden: false }, 'V4: 任务行展开/收起')
      }

      /* ---- CDP 层异常（不只靠页面内 hook） ---- */
      eq(runtimeErrors, [], `${scenario.name}: CDP 层无异常`)
      report.pageErrors.push(...runtimeErrors)

      process.stdout.write(
        `${scenario.name.padEnd(24)} chips=[${view.chips.cluster} | ${view.chips.board} | ${view.chips.tasks}] ` +
        `tasks=${view.tasks.count} events=${view.events.count} ${scenario.shot ? 'shot=' + scenario.shot : ''}\n`
      )
    }
  } finally {
    try { if (browser) await browser.send('Browser.close') } catch { /* ignore */ }
    try { if (child) child.kill() } catch { /* ignore */ }
    await sleep(500)
    try { await rm(profileDir, { recursive: true, force: true }) } catch { /* Edge 可能还占着文件，无害 */ }
    try { await site.close() } catch { /* ignore */ }
  }
}

try {
  await main()
  report.checks = {
    scenarios: SCENARIOS.length,
    assertionsPassed: passed,
    assertionsFailed: failures.length,
    pageErrors: report.pageErrors.length
  }
  report.ok = failures.length === 0
  await writeFile(path.join(OUT_DIR, 'cdp-report.json'), JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(`\nassertions: ${passed} passed, ${failures.length} failed; pageErrors=${report.pageErrors.length}\n`)
  if (failures.length > 0) {
    process.stdout.write('failed:\n' + failures.map(f => '  - ' + f).join('\n') + '\n')
    process.exitCode = 1
  } else {
    process.stdout.write('result: PASS\n')
  }
} catch (error) {
  report.error = String((error && error.stack) || error)
  report.ok = false
  try {
    await mkdir(OUT_DIR, { recursive: true })
    await writeFile(path.join(OUT_DIR, 'cdp-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch { /* ignore */ }
  console.error('FAIL: ' + report.error)
  process.exitCode = 1
}
