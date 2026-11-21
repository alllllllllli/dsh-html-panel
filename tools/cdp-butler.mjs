#!/usr/bin/env node
/**
 * tools/cdp-butler.mjs —— 大管家 0.4.0 页面的运行时自检（Edge headless + CDP，零依赖）。
 *
 * 用内置 HTTP fixture 起一个同源站点，把 `public/index.html` 按插件真实路由
 * `/dsh-html-panel/` 提供出去，并把四条只读路由与 `POST api/action` 换成可控 fixture：
 *   - real     真实形状数据：4 对端链路 / 6 任务 + 8 事件 / 本机 / T0+4×T1+6×T2+2×T3；
 *   - degraded api/tiers 只给 T0 + degraded（模拟本机/远端数据源不可用）；
 *   - tiers404 api/tiers 返回 404（模拟「新路由要重启 DSH」这一真实中间态）；
 *   - mock     四条接口全 500（页面必须落回 MOCK 兜底并明确标注）。
 *
 * 断言覆盖：五页导航切换与真实渲染、右栏 T0–T3 计数/折叠/选中上级路径、动作四态回执、
 * 报告预览、记忆探测、900 抽屉、无横向溢出、页面 JS 报错 0；截图写入 tools/shots/。
 *
 * 用法: node tools/cdp-butler.mjs
 * 产物: tools/shots/cdp-butler-report.json + shot-butler-*.png
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
const VIEWPORT = { width: 1440, height: 1000 }

/* ───────────────────────── fixture 数据 ───────────────────────── */
const NOW = Date.parse('2026-11-21T08:00:00.000Z')
const CLUSTER_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  interconnect: true,
  self: { instanceId: 'pc-ky614' },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'up' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
    { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'down' },
    { instanceId: 'mcloud', origin: '127.0.0.1:13086', link: 'down' }
  ],
  board: null
}
const HOST_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  hostname: 'fixture-pc',
  os: { platform: 'win32', release: '10.0.26300', uptimeSec: 7200 },
  memory: { totalBytes: 34359738368, freeBytes: 17179869184, ratio: 0.5 },
  cpu: { count: 12, load1: 0 },
  disks: [
    { mount: 'C:', label: 'C: 系统盘', totalBytes: 155692564480, freeBytes: 107374182400, ratio: 0.31, error: null },
    { mount: 'D:', label: 'D: 数据盘', totalBytes: 1030792151040, freeBytes: 579820584960, ratio: 0.44, error: null }
  ]
}
const BOARD_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  configured: true,
  source: { origin: '172.24.112.11:13090' },
  health: { ok: true, latencyMs: 37, service: 'dsh-team-mesh board', version: '1.0.0', schema_version: 4 },
  tasks: [
    { id: 't-fixture-1', title: 'fixture：核对板服务监听地址', state: 'leased', owner: 'agent-team:pc:lead', node: 'pc-ky614', evidenceCount: 2, acceptance: ['fixture 验收 A'], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 90000, updatedAt: NOW - 60000, leaseDeadline: NOW + 120000, lifecycle: 'working', ackState: 'acked' },
    { id: 't-fixture-2', title: 'fixture：汇总升级清单', state: 'done', owner: 'agent-team:server:worker-1', node: 'server', evidenceCount: 3, acceptance: ['fixture 验收 B'], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 300000, updatedAt: NOW - 240000, lifecycle: 'done', ackState: 'acked' },
    { id: 't-fixture-3', title: 'fixture：双机互发验证', state: 'awaiting', owner: 'agent-team:mcloud:worker-1', node: 'mcloud', evidenceCount: 1, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 600000, updatedAt: NOW - 420000, lifecycle: 'open', ackState: 'pending' },
    { id: 't-fixture-4', title: 'fixture：清理临时验证目录', state: 'undelivered', owner: null, node: null, evidenceCount: 0, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 900000, updatedAt: NOW - 780000, lifecycle: 'open', ackState: 'none' },
    { id: 't-fixture-5', title: 'fixture：给板服务加观测端点', state: 'stale', owner: 'agent-team:cloud:worker-2', node: 'cloud', evidenceCount: 1, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 3600000, updatedAt: NOW - 3000000, lifecycle: 'working', ackState: 'acked' },
    { id: 't-fixture-6', title: 'fixture：已取消的历史任务', state: 'canceled', owner: null, node: null, evidenceCount: 0, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 7200000, updatedAt: NOW - 7000000, lifecycle: 'canceled', ackState: 'none' }
  ],
  events: Array.from({ length: 8 }, (_, index) => ({
    task: 't-fixture-' + (index + 1),
    at: NOW - (index + 1) * 60000,
    kind: index % 2 === 0 ? 'task.created' : 'task.reported',
    node: index % 2 === 0 ? 'pc-ky614' : 'server',
    text: 'fixture 事件 ' + (index + 1) + '（CDP 自检数据，不是真实事件）',
    seq: 200 - index
  }))
}

/** 真实形状的层级树：T0 + 4×T1 + 6×T2 + 2×T3（设备只作标签）。 */
const TIERS_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  source: {
    local: 'sessions+agents',
    subagents: 'session-header(origin+parentSession)',
    remote: [
      { instanceId: 'server', link: 'up', sessions: 2 },
      { instanceId: 's5', link: 'down', sessions: 0 },
      { instanceId: 'cloud', link: 'down', sessions: 0 },
      { instanceId: 'mcloud', link: 'up', sessions: 1 }
    ],
    cached: false,
    ageMs: 0
  },
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: new Date(NOW - 3600000).toISOString() },
  nodes: [
    { id: 'session-main', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '主控会话', status: 'run', startedAt: new Date(NOW - 1800000).toISOString() },
    { id: 'session-child-1', parentId: 'session-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '层级交互', status: 'run', startedAt: new Date(NOW - 1200000).toISOString() },
    { id: 'session-grand-1', parentId: 'session-child-1', tier: 3, kind: 'subagent', device: 'pc-ky614', title: '折叠态走查', status: 'run', startedAt: new Date(NOW - 900000).toISOString() },
    { id: 'session-child-2', parentId: 'session-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '长名字截断样式回归用例集', status: 'queue', startedAt: new Date(NOW - 1100000).toISOString() },
    { id: 'server:session-aaa', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: '查看本机SSH公钥', status: 'idle', startedAt: null },
    { id: 'server:session-r1', parentId: 'server:session-aaa', tier: 2, kind: 'subagent', device: 'server', title: '连线与缩进校对', status: 'done', startedAt: null },
    { id: 'server:session-r2', parentId: 'server:session-aaa', tier: 2, kind: 'subagent', device: 'server', title: '折叠状态回归', status: 'idle', startedAt: null },
    { id: 'server:session-bbb', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: 'Deepfish 私信回复', status: 'idle', startedAt: null },
    { id: 'server:session-grand-2', parentId: 'server:session-r1', tier: 3, kind: 'subagent', device: 'server', title: '1440/900 截图复核', status: 'done', startedAt: null },
    { id: 'mcloud:session-ccc', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'mcloud', title: 'OV 索引巡检', status: 'idle', startedAt: null },
    { id: 'mcloud:session-m1', parentId: 'mcloud:session-ccc', tier: 2, kind: 'subagent', device: 'mcloud', title: '记忆库巡检', status: 'idle', startedAt: null },
    { id: 'mcloud:session-m2', parentId: 'mcloud:session-ccc', tier: 2, kind: 'subagent', device: 'mcloud', title: '索引重建等待', status: 'queue', startedAt: null }
  ],
  degraded: { reason: '远端设备的子代理层级不可见（interconnect 只列顶层活会话）' }
}

const TIERS_DEGRADED = {
  generatedAt: new Date(NOW).toISOString(),
  source: { local: 'unavailable', subagents: 'unavailable', remote: [{ instanceId: 'server', link: 'down', sessions: 0 }], cached: false, ageMs: 0 },
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: new Date(NOW).toISOString() },
  nodes: [],
  degraded: { reason: '本实例没有可用的 interconnect 服务：其它设备的会话不可见；DSH 没有可用的 sessions 服务：本机会话层级不可见' }
}

/* ───────────────────────── fixture HTTP 服务 ───────────────────────── */
async function startFixtureServer() {
  const state = { scenario: 'real' }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    const sendJson = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (pathname === ROUTE + '/index.html' || pathname === ROUTE + '/') {
      try {
        const body = await readFile(PAGE_FILE)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String((error && error.message) || error))
      }
      return
    }
    if (pathname === ROUTE + '/api/action' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let action = ''
      try {
        action = JSON.parse(Buffer.concat(chunks).toString('utf8')).action
      } catch {
        action = ''
      }
      if (action === 'probe-memory') {
        sendJson(200, { ok: true, action, url: 'about:blank', origin: '172.24.112.11:1933', status: 200, latencyMs: 12 })
      } else if (action === 'latest-report') {
        sendJson(200, {
          ok: true,
          action,
          dir: 'fixture/docs',
          dirLabel: 'docs',
          file: { name: 'fixture-report.md', mtime: NOW - 600000, size: 42 },
          content: '# fixture 报告\n\n- 来自 CDP fixture，不是真实报告\n',
          truncated: false,
          readBytes: 42
        })
      } else if (action === 'open-reports-folder') {
        sendJson(200, { ok: true, action, dir: 'fixture/docs' })
      } else {
        sendJson(200, { ok: false, code: 'unknown-action', reason: 'fixture 未实现该动作' })
      }
      return
    }
    if (pathname === ROUTE + '/api/cluster') {
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(200, CLUSTER_REAL)
    }
    if (pathname === ROUTE + '/api/board') {
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(200, BOARD_REAL)
    }
    if (pathname === ROUTE + '/api/host') {
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(200, HOST_REAL)
    }
    if (pathname === ROUTE + '/api/tiers') {
      if (state.scenario === 'tiers404') return sendJson(404, { ok: false, error: 'not-found' })
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      if (state.scenario === 'degraded') return sendJson(200, TIERS_DEGRADED)
      return sendJson(200, TIERS_REAL)
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  return {
    baseUrl: 'http://127.0.0.1:' + port,
    setScenario: name => { state.scenario = name },
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
      await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) })
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
    '--disable-popup-blocking',
    '--force-device-scale-factor=1',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    'about:blank'
  ], { stdio: 'ignore' })
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    try {
      const info = await (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) })).json()
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
        try { fn(msg.params) } catch { /* 观察器异常不影响页面 */ }
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
  return { ws, opened, send, on }
}

/* ───────────────────────── 主流程 ───────────────────────── */
const report = {
  page: 'public/index.html',
  viewport: VIEWPORT,
  generatedAt: new Date().toISOString(),
  checks: [],
  shots: [],
  pageErrors: [],
  runtimeErrors: [],
  scenarios: [],
  ok: false
}
const sleep = ms => new Promise(done => setTimeout(done, ms))

/** 页面状态提取：一次 evaluate 取回所有断言需要的 DOM 事实。 */
const PAGE_STATE = `(() => {
  const q = s => document.querySelector(s);
  const qa = s => Array.from(document.querySelectorAll(s));
  const txt = s => { const el = q(s); return el ? el.textContent.trim() : ''; };
  return {
    title: document.title,
    ready: !!q('#page-butler'),
    dataset: Object.assign({}, document.body.dataset),
    nav: qa('.nav-item[data-page]').map(b => ({ page: b.dataset.page, active: b.classList.contains('active'), label: (b.querySelector('.nav-label') || {}).textContent || '' })),
    visiblePages: ['butler','tasks','cluster','memory','settings'].filter(p => q('#page-' + p) && !q('#page-' + p).hidden),
    demoBadge: txt('#demoBadge'),
    tier: {
      nodes: qa('#tree .node').length,
      cnt: [0,1,2,3].map(i => txt('#cntT' + i)),
      degraded: q('#tierDegraded') ? !q('#tierDegraded').hidden : false,
      degradedTitle: q('#tierDegraded') ? q('#tierDegraded').title : '',
      treeText: txt('#tree'),
      devices: qa('#tree .dev').map(e => e.textContent.trim()),
      badges: qa('#tree .node > .head > .badge').map(e => e.textContent.trim())
    },
    tasks: {
      rows: qa('#taskList .item').length,
      events: qa('#eventList .item').length,
      badge: q('#boardBadge') ? q('#boardBadge').getAttribute('data-kind') : '',
      badgeText: txt('#boardBadgeText')
    },
    cluster: {
      nodes: qa('#topoNodes .node').length,
      pending: qa('#topoNodes .pending').length,
      devRows: qa('#clusterList .dev-row').length,
      state: q('#topoSource') ? q('#topoSource').getAttribute('data-state') : '',
      text: txt('#topoSourceText')
    },
    chrome: {
      statDevices: txt('#statDevices'),
      statBoard: txt('#statBoard'),
      sfSub: txt('#sfSub'),
      sfDev: txt('#sfDev'),
      navTasks: txt('#navTasksCount'),
      navCluster: txt('#navClusterCount'),
      pillTiers: txt('#pillTiers'),
      pillBoard: txt('#pillBoard'),
      pillHost: txt('#pillHost')
    },
    receipts: qa('#receiptList li').filter(li => li.querySelector('.r-state')).map(li => ({
      label: (li.querySelector('b') || {}).textContent || '',
      state: (li.querySelector('.r-state') || {}).textContent || '',
      text: (li.querySelector('.r-text') || {}).textContent || ''
    })),
    report: { visible: q('#reportPanel') ? !q('#reportPanel').hidden : false, meta: txt('#reportMeta'), content: txt('#reportContent') },
    memory: { state: txt('#memoryState'), badge: txt('#memoryBadgeText') },
    settings: { version: txt('#setVersion'), board: txt('#setBoard'), cluster: txt('#setCluster'), tiers: txt('#setTiersSource'), host: txt('#setHost') },
    todoCount: qa('#todoList .todo').length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    hierRect: (() => { const el = q('#hier'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; })(),
    hierTransform: q('#hier') ? getComputedStyle(q('#hier')).transform : '',
    hierMatchesDrawer: !!document.querySelector('body.drawer .hier'),
    drawerRules: (() => {
      const out = [];
      try {
        const sheet = document.styleSheets[0];
        const walk = list => {
          for (const rule of list) {
            if (rule.cssRules) walk(rule.cssRules);
            else if (rule.selectorText && rule.selectorText.indexOf('drawer') !== -1) out.push(rule.selectorText + ' {' + rule.style.cssText + '}');
          }
        };
        walk(sheet.cssRules);
      } catch (error) {
        out.push('style-sheet-error: ' + String(error));
      }
      return out;
    })(),
    drawerBtnDisplay: q('#drawerBtn') ? getComputedStyle(q('#drawerBtn')).display : '',
    bodyDrawer: document.body.classList.contains('drawer'),
    errors: (window.__panelErrors || []).slice()
  };
})()`

let checks = []
function ck(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
}
function eq(name, actual, expected) {
  ck(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}
function has(name, text, needle) {
  ck(name, typeof text === 'string' && text.includes(needle), 'needle=' + needle)
}

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  if (!existsSync(PAGE_FILE)) throw new Error('找不到页面文件')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-butler-' + Date.now())
  await mkdir(profileDir, { recursive: true })

  const fixture = await startFixtureServer()
  const port = await pickPort(9600)
  let child = null
  let browser = null
  try {
    child = await launchEdge(port, profileDir)
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    const pageTarget = list.find(t => t.type === 'page')
    if (!pageTarget) throw new Error('no page target')
    browser = connect(pageTarget.webSocketDebuggerUrl)
    await browser.opened
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await browser.send(domain + '.enable')
    // 无头页面的 CSS transition 可能被节流，测量抽屉位置时不等动画；同时覆盖 reduced-motion 分支。
    await browser.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })

    browser.on('Runtime.exceptionThrown', params => {
      const detail = params && params.exceptionDetails ? (params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text) : 'exception'
      report.runtimeErrors.push(String(detail).slice(0, 300))
    })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__panelErrors=[];' +
        'addEventListener("error",e=>{try{window.__panelErrors.push("error: "+String(e.message||e))}catch(_){}});' +
        'addEventListener("unhandledrejection",e=>{try{window.__panelErrors.push("rejection: "+String(e.reason))}catch(_){}});'
    })

    async function evaluate(expression) {
      const out = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
      if (out.exceptionDetails) {
        throw new Error('evaluate failed: ' + String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text))
      }
      return out.result.value
    }
    async function waitFor(expression, timeoutMs, label) {
      const deadline = Date.now() + (timeoutMs || 8000)
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return true
        } catch { /* 页面还在导航 */ }
        await sleep(100)
      }
      throw new Error('timeout waiting: ' + (label || expression))
    }
    async function setViewport(width, height) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await sleep(150)
    }
    async function shot(name) {
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(OUT_DIR, name), Buffer.from(data, 'base64'))
      report.shots.push('tools/shots/' + name)
    }
    async function state() {
      return evaluate(PAGE_STATE)
    }
    async function click(selector) {
      const result = await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return "missing"; el.click(); return "clicked"; })()')
      if (result !== 'clicked') throw new Error('click failed: ' + selector + ' -> ' + result)
      await sleep(120)
    }
    async function selectPage(page) {
      await click('.nav-item[data-page="' + page + '"]')
      await waitFor('(() => { const el = document.getElementById("page-' + page + '"); return el && !el.hidden; })()', 5000, 'page ' + page)
    }
    async function waitReceipt(expected, timeoutMs) {
      await waitFor('(() => { const s = document.querySelector("#receiptList .r-state"); return s && s.textContent === ' + JSON.stringify(expected) + '; })()', timeoutMs || 9000, 'receipt ' + expected)
    }
    async function goto(scene) {
      fixture.setScenario(scene)
      const url = fixture.baseUrl + ROUTE + '/index.html?scene=' + encodeURIComponent(scene) + '&t=' + Date.now()
      await browser.send('Page.navigate', { url })
      await waitFor('document.readyState === "complete"', 8000, 'readyState')
      await waitFor('!!document.body && !!document.body.dataset.tiers', 8000, 'boot')
      await waitFor('document.body.dataset.tiers && document.body.dataset.tiers !== "loading"', 9000, 'tiers settled')
      await waitFor('document.body.dataset.board && document.body.dataset.board !== "loading"', 9000, 'board settled')
      await waitFor('document.body.dataset.cluster && document.body.dataset.cluster !== "loading"', 9000, 'cluster settled')
      await sleep(250)
      return state()
    }

    /* ================= 场景 1：真实数据（1440） ================= */
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    let s = await goto('real')
    report.scenarios.push({ name: 'real', dataset: s.dataset })
    eq('页面标题是大管家', s.title, '大管家 · DSH 控制台')
    eq('默认进大管家页', s.visiblePages.join(','), 'butler')
    eq('五页导航齐全', s.nav.map(n => n.page).join(','), 'butler,tasks,cluster,memory,settings')
    eq('导航文案是大管家口径', s.nav.map(n => n.label).join(','), '大管家,任务,集群,记忆,设置')
    has('示例对话 badge 明确标注', s.demoBadge, '示例对话')
    has('示例对话 badge 说明不是真实聊天', s.demoBadge, '不是真实聊天')
    eq('cluster 真实', s.dataset.cluster, 'real')
    eq('board 真实', s.dataset.board, 'real')
    eq('host 真实', s.dataset.host, 'real')
    eq('tiers 真实', s.dataset.tiers, 'real')
    has('顶栏设备统计接真实链路', s.chrome.statDevices, '4 台设备 · 1 条链路 up')
    has('顶栏共享板统计接真实任务数', s.chrome.statBoard, '板上 6 任务')
    has('左栏底部设备状态接真实实例', s.chrome.sfDev, 'pc-ky614')
    has('左栏底部链路统计', s.chrome.sfSub, '4 台设备 · 1 条链路 up')
    eq('任务导航 badge 是真实任务数', s.chrome.navTasks, '6')
    eq('集群导航 badge 是 up/总数', s.chrome.navCluster, '1/4')

    // 右栏 T0–T3
    eq('右栏节点总数（1+4+6+2）', s.tier.nodes, 13)
    eq('层级计数 chip T0..T3', s.tier.cnt.join(','), '1,4,6,2')
    eq('节点徽标从 T0 起', s.tier.badges[0], 'T0')
    has('T1 出现在徽标里', s.tier.badges.join(','), 'T1')
    has('T3 出现在徽标里', s.tier.badges.join(','), 'T3')
    has('设备标签出现 pc-ky614', s.tier.devices.join(','), 'pc-ky614')
    has('设备标签出现 server', s.tier.devices.join(','), 'server')
    has('设备标签出现 mcloud', s.tier.devices.join(','), 'mcloud')
    eq('有降级说明时 badge 显示', s.tier.degraded, true)
    has('降级原因来自接口', s.tier.degradedTitle, '远端设备的子代理层级不可见')
    eq('1440 无横向溢出', s.overflow <= 1, true)
    await shot('shot-butler-01-dashboard-1440.png')

    // 页面 2：任务
    await selectPage('tasks')
    s = await state()
    eq('任务页可见', s.visiblePages.join(','), 'tasks')
    eq('任务行数接共享板真值', s.tasks.rows, 6)
    eq('事件流行数接共享板真值', s.tasks.events, 8)
    eq('板 badge 标真实', s.tasks.badge, 'real')
    has('板 badge 文案', s.tasks.badgeText, '真实 · 共享板')
    eq('任务页待办渲染（localStorage）', s.todoCount, 4)
    await click('#tab-events')
    await waitFor('!document.getElementById("panel-events").hidden', 4000, 'events tab')
    await shot('shot-butler-02-tasks-1440.png')

    // 页面 3：集群
    await selectPage('cluster')
    s = await state()
    eq('集群页可见', s.visiblePages.join(','), 'cluster')
    eq('拓扑真实节点 4 个', s.cluster.nodes, 4)
    eq('拓扑待接入空心圆 1 个', s.cluster.pending, 1)
    ck('设备/链路列表有行', s.cluster.devRows >= 4, 'rows=' + s.cluster.devRows)
    eq('拓扑 badge 标真实', s.cluster.state, 'real')
    has('拓扑 badge 文案', s.cluster.text, '真实 · interconnect')
    await shot('shot-butler-03-cluster-1440.png')

    // 页面 4：记忆（真探测）
    await selectPage('memory')
    await click('#memoryProbe')
    await waitFor('(() => { const s = document.querySelector("#receiptList .r-state"); return s && s.textContent !== "进行中"; })()', 9000, 'memory receipt')
    s = await state()
    const memoryReceipt = s.receipts[0] || {}
    ck('记忆探测回执有结果', memoryReceipt.state === '成功' || memoryReceipt.state === '失败', JSON.stringify(memoryReceipt))
    if (memoryReceipt.state === '成功') {
      eq('记忆 badge 标可达', s.memory.badge, '可达')
      has('记忆状态含 origin', s.memory.state, '172.24.112.11:1933')
    }
    await shot('shot-butler-04-memory-1440.png')

    // 页面 5：设置（只读信息接真实字段）
    await selectPage('settings')
    s = await state()
    eq('设置页可见', s.visiblePages.join(','), 'settings')
    eq('设置页插件版本 0.4.0', s.settings.version, '0.4.0')
    has('设置页共享板来源接真实 origin', s.settings.board, '172.24.112.11:13090')
    has('设置页层级来源接真实字符串', s.settings.tiers, 'sessions+agents')
    has('设置页本机来源接真实字段', s.settings.host, 'fixture-pc')
    await shot('shot-butler-05-settings-1440.png')

    // 回到大管家：动作四态 + 报告预览
    await selectPage('butler')
    await click('#actionList [data-action="latest-report"]')
    await waitReceipt('成功')
    s = await state()
    eq('最新报告回执成功', s.receipts[0].state, '成功')
    ck('报告面板打开', s.report.visible === true, 'visible=' + s.report.visible)
    has('报告内容来自宿主动作路由', s.report.content, 'fixture 报告')
    await shot('shot-butler-06-action-report-1440.png')

    await click('#actionList [data-action="new-session"]')
    await waitReceipt('暂不支持')
    s = await state()
    has('独立打开时新会话如实说明', s.receipts[0].text, '不在 DSH 面板 iframe')
    await shot('shot-butler-07-action-unsupported-1440.png')

    // 右栏交互：折叠 / 选中上级路径
    const fold = await evaluate(`(() => {
      const node = Array.from(document.querySelectorAll('#tree .node[data-level="T1"]')).find(n => n.querySelector(':scope > .kids > .node'));
      if (!node) return { ok: false, why: 'no-node' };
      const fold = node.querySelector(':scope > .head .fold');
      if (!fold) return { ok: false, why: 'no-fold' };
      fold.click();
      const collapsed = node.classList.contains('collapsed');
      const display = getComputedStyle(node.querySelector(':scope > .kids')).display;
      fold.click();
      return { ok: collapsed && display === 'none' && !node.classList.contains('collapsed'), collapsed, display };
    })()`)
    ck('T1 折叠后子节点隐藏、再点恢复', fold.ok === true, JSON.stringify(fold))

    const select = await evaluate(`(() => {
      const node = document.querySelector('#tree .node[data-level="T2"]');
      if (!node) return { ok: false, why: 'no-t2' };
      const head = node.querySelector(':scope > .head');
      head.click();
      const tree = document.getElementById('tree');
      const first = { hasSel: tree.classList.contains('has-sel'), sel: tree.querySelectorAll('.node.sel').length, path: tree.querySelectorAll('.node.path').length };
      head.click();
      const cleared = !tree.classList.contains('has-sel') && tree.querySelectorAll('.node.path').length === 0;
      return { ok: first.hasSel && first.sel === 1 && first.path >= 3 && cleared, first, cleared };
    })()`)
    ck('点节点高亮 T0→… 上级路径，再点取消', select.ok === true, JSON.stringify(select))
    // 截图要能看到选中态：再点一次 T2 并保留选中，拍完再取消。
    await evaluate(`(() => { const node = document.querySelector('#tree .node[data-level="T2"]'); if (!node) return false; node.querySelector(':scope > .head').click(); return true; })()`)
    await sleep(150)
    await shot('shot-butler-08-tiers-selected-1440.png')
    await evaluate(`(() => { const node = document.querySelector('#tree .node.sel'); if (node) node.querySelector(':scope > .head').click(); return true; })()`)

    /* ================= 场景 2：900 窄屏 + 抽屉 ================= */
    await click('#closeReport')
    await setViewport(900, 1000)
    await sleep(350)
    s = await state()
    ck('900 无横向溢出', s.overflow <= 1, 'overflow=' + s.overflow)
    ck('900 右栏默认收在屏外', s.hierRect && s.hierRect.left >= 900, JSON.stringify(s.hierRect))
    eq('900 抽屉按钮可见', s.drawerBtnDisplay !== 'none', true)
    await shot('shot-butler-09-narrow-900.png')
    await click('#drawerBtn')
    await sleep(500)
    s = await state()
    ck('点抽屉后右栏进入可视区', s.hierRect && s.hierRect.left < 520, JSON.stringify({ rect: s.hierRect, transform: s.hierTransform, matches: s.hierMatchesDrawer, rules: s.drawerRules }))
    eq('抽屉态 body.drawer', s.bodyDrawer, true)
    eq('窄屏仍无横向溢出', s.overflow <= 1, true)
    await shot('shot-butler-10-narrow-900-drawer.png')
    await click('#hierClose')
    await sleep(300)
    s = await state()
    eq('关闭抽屉后 body.drawer 移除', s.bodyDrawer, false)

    /* ================= 场景 3：层级降级 ================= */
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    s = await goto('degraded')
    report.scenarios.push({ name: 'degraded', dataset: s.dataset })
    eq('降级场景 tiers 仍是结构化响应', s.dataset.tiers, 'real')
    eq('降级时只渲染 T0（不编节点）', s.tier.nodes, 1)
    eq('降级 badge 显示', s.tier.degraded, true)
    has('降级原因写进页面', s.tier.degradedTitle, '会话层级不可见')
    await shot('shot-butler-11-tiers-degraded-1440.png')

    /* ================= 场景 4：api/tiers 404（需重启） ================= */
    s = await goto('tiers404')
    report.scenarios.push({ name: 'tiers404', dataset: s.dataset })
    eq('404 时层级降级', s.dataset.tiers, 'missing')
    eq('404 时只渲染 T0', s.tier.nodes, 1)
    eq('404 时降级 badge 显示', s.tier.degraded, true)
    has('404 时写明需要重启 DSH', s.tier.treeText, '404')
    has('404 时写明重启后生效', s.tier.treeText, '重启')
    await shot('shot-butler-12-tiers-404-1440.png')

    /* ================= 场景 5：接口全挂 → MOCK 兜底 ================= */
    s = await goto('mock')
    report.scenarios.push({ name: 'mock', dataset: s.dataset })
    eq('cluster 回落 mock', s.dataset.cluster, 'mock')
    eq('board 回落 mock', s.dataset.board, 'mock')
    eq('host 回落 mock', s.dataset.host, 'mock')
    eq('板 badge 标 mock', s.tasks.badge, 'mock')
    has('板 badge 写明 mock 兜底', s.tasks.badgeText, 'mock 兜底')
    eq('拓扑 badge 标 mock', s.cluster.state, 'mock')
    has('拓扑 badge 写明 mock 兜底', s.cluster.text, 'mock 兜底')
    ck('mock 时仍有任务列表（示例数据）', s.tasks.rows === 6, 'rows=' + s.tasks.rows)
    eq('mock 时层级降级但 T0 在', s.tier.nodes, 1)
    await shot('shot-butler-13-mock-fallback-1440.png')

    /* ================= 页面 JS 报错收集 ================= */
    const finalState = await state()
    report.pageErrors = finalState.errors || []
    ck('页面 JS 报错为 0', report.pageErrors.length === 0, JSON.stringify(report.pageErrors).slice(0, 300))
    ck('CDP 运行时异常为 0', report.runtimeErrors.length === 0, JSON.stringify(report.runtimeErrors).slice(0, 300))
    ck('截图数量 ≥ 5', report.shots.length >= 5, 'shots=' + report.shots.length)
  } finally {
    try { await fixture.close() } catch { /* ignore */ }
    try { if (browser) browser.ws.close() } catch { /* ignore */ }
    if (child) {
      try { child.kill() } catch { /* ignore */ }
    }
    await sleep(300)
    try { await rm(profileDir, { recursive: true, force: true }) } catch { /* Edge 可能还占着文件，无害 */ }
  }

  const failed = checks.filter(c => !c.ok)
  report.checks = checks
  report.failed = failed.length
  report.passed = checks.length - failed.length
  report.ok = failed.length === 0
  await writeFile(path.join(OUT_DIR, 'cdp-butler-report.json'), JSON.stringify(report, null, 2), 'utf8')

  process.stdout.write('\n== cdp-butler: ' + checks.length + ' checks ==\n')
  for (const c of checks) {
    process.stdout.write((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok || !c.detail ? '' : '  [' + c.detail + ']') + '\n')
  }
  process.stdout.write('\nresult: ' + (report.ok ? 'PASS' : 'FAIL') + ' (' + report.passed + '/' + checks.length + ') shots=' + report.shots.length + '\n')
  process.exit(report.ok ? 0 : 1)
}

main().catch(error => {
  process.stderr.write('cdp-butler failed: ' + String((error && error.stack) || error) + '\n')
  process.exit(1)
})
