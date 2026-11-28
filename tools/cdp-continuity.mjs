#!/usr/bin/env node
/**
 * tools/cdp-continuity.mjs —— 永续常驻（页面侧）的真浏览器验证 + 截图证据。
 *
 * 用法（插件根目录）: node tools/cdp-continuity.mjs
 *
 * 做法：起同源静态服务器（`/dsh-html-panel/index.html` 就是被测页面本身），
 * `/api/*` 返回可控 fixture（healthy / 全 404 两种模式）；用 Edge headless + CDP
 * （Node 内置 WebSocket）先往 localStorage 写 dshhp:* 恢复记录，再重新加载页面，
 * 断言恢复/未读/上下文预算/今日归档/404 降级都符合预期，并截图为证。
 *
 * 场景：
 *   1. restored-dialogue  上次停留：大管家页 · 对话 tab · 状态条展开 · 会话 session-restored ·
 *                         滚动在顶部 · 游标 100 → 恢复后滚动仍在顶部、未读 20、常驻 3 小时 25 分
 *   2. restored-trajectory 同样记录但页签是轨迹 → 刷新后仍是轨迹 tab（页签恢复）
 *   3. page-tasks         上次停在任务页 + 游标旧 → 任务页恢复，nav「大管家」未读徽标 20
 *   4. invalid-fallback   页面/页签/状态条/会话记录全部失效 → 回退默认并在 restoreNote 说明原因
 *   5. api-404            所有 api/* 404 → 面板仍渲染：常驻「未知」、上下文「未知」、
 *                         对话 404 说明、今日归档「暂无归档」，不报错刷屏
 *
 * 产物：tools/shots/shot-continuity-*.png 与 tools/shots/continuity-report.json。
 * 断言失败退出码 1。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_FILE = path.join(ROOT, 'public', 'index.html')
const OUT_DIR = path.join(ROOT, 'tools', 'shots')
const ROUTE = '/dsh-html-panel'
const NOW = Date.now()

/* ───────────────────────── fixture：形状对齐宿主契约，内容只是样本 ───────────────────────── */
const CLUSTER = {
  generatedAt: new Date(NOW).toISOString(),
  interconnect: true,
  self: { instanceId: 'pc-ky614' },
  peers: [
    { instanceId: 'server', origin: '10.26.0.3:13080', link: 'up' },
    { instanceId: 'mcloud', origin: '10.26.0.4:13086', link: 'up' }
  ],
  board: null
}
const BOARD = {
  generatedAt: new Date(NOW).toISOString(),
  configured: true,
  source: { origin: '10.26.0.4:13090' },
  health: { ok: true, latencyMs: 12 },
  tasks: [
    { id: 't-fixture-1', title: 'fixture：永续常驻恢复层验收', state: 'leased', owner: 'lead', node: 'pc-ky614', evidenceCount: 2, acceptance: ['fixture'], brief: '', lifecycle: 'working', ackState: 'acked', createdAt: NOW - 600000, updatedAt: NOW - 60000 }
  ],
  official: { available: false, reason: 'fixture：未接官方任务板' },
  events: [
    { task: 't-fixture-1', at: NOW - 120000, kind: 'task.created', node: 'pc-ky614', text: 'fixture 事件（不是真实事件）', seq: 9 }
  ]
}
const HOST = {
  generatedAt: new Date(NOW).toISOString(),
  hostname: 'pc-ky614',
  os: { platform: 'win32', release: '10.0.26340', uptimeSec: 86400 },
  memory: { totalBytes: 34359738368, freeBytes: 17179869184, ratio: 0.5 },
  cpu: { count: 12, load1: 0.4 },
  disks: [{ mount: 'C:', label: 'C: 系统盘', totalBytes: 256000000000, freeBytes: 128000000000, ratio: 0.5 }]
}
const TIERS = {
  generatedAt: new Date(NOW).toISOString(),
  source: { local: 'sessions', subagents: 'session-header', subagentMode: 'official-projection', remote: [], cached: false, ageMs: 0 },
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: new Date(NOW - 3600000).toISOString() },
  nodes: [
    { id: 'session-restored', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '大管家 · 常驻', status: 'run', startedAt: new Date(NOW - 3600000).toISOString(), childSessionId: 'session-restored', parentSessionId: null, mode: null }
  ]
}
const ALERTS = { generatedAt: new Date(NOW).toISOString(), counts: { high: 0, medium: 0, low: 0 }, alerts: [] }
const BUTLER = {
  generatedAt: new Date(NOW).toISOString(),
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', statusText: '运行中', startedAt: new Date(NOW - 3600000).toISOString(), readonly: false },
  source: { sessions: 'sessionController.list', states: 'sessionController.state', lineage: 'api/tiers(shared 4s cache)', remote: 'interconnect.list', cached: false, ageMs: 0 },
  counts: { 0: 1, 1: 1, 2: 0, 3: 0 },
  total: 1,
  binding: {
    sessionId: 'session-restored', title: '大管家 · 常驻', label: '大管家 · 常驻', agentPreset: 'butler-lead',
    targetMode: 'pinned', resolvedBy: 'config', available: true
  },
  nodes: [
    { id: 'session-restored', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '大管家 · 常驻', status: 'idle', statusText: '空闲', startedAt: new Date(NOW - 3600000).toISOString(), updatedAt: new Date(NOW - 30000).toISOString(), active: true, running: false, queue: 0, pendingInput: [], stateKnown: true, mode: null, parentSessionId: null, childSessionId: 'session-restored', readonly: false, controllable: true },
    { id: 'server:session-aaa', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: '远端只读会话', status: 'idle', statusText: '空闲', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false }
  ],
  remote: [{ instanceId: 'server', link: 'up', readonly: true, controllable: false, note: '远端只读不可控', sessions: 1 }],
  write: { allowWrite: true, sessionId: 'session-restored' }
}
const DIALOG_MESSAGES = Array.from({ length: 20 }, (_, index) => {
  const seq = 101 + index
  const user = index % 2 === 0
  return {
    seq,
    role: user ? 'user' : 'assistant',
    time: new Date(NOW - (20 - index) * 60000).toISOString(),
    text: user
      ? 'fixture 第 ' + (index + 1) + ' 轮：请核对永续常驻的恢复层（这不是真实对话）'
      : 'fixture 第 ' + (index + 1) + ' 轮回复：恢复逻辑按契约返回，未读徽标与上下文预算都从真实路由来（样本内容，不是真实对话）。'
  }
})
const DIALOG = {
  generatedAt: new Date(NOW).toISOString(),
  available: true,
  sessionId: 'session-restored',
  title: '大管家 · 常驻',
  targetMode: 'pinned',
  resolvedBy: 'config',
  state: { active: true, running: false, queue: 0, pendingInput: [], status: 'idle', statusText: '空闲' },
  stateKnown: true,
  messages: DIALOG_MESSAGES,
  cursor: 120,
  hasMore: false,
  limit: 30,
  before: null,
  counts: { messages: DIALOG_MESSAGES.length, events: 20, tools: 0 }
}
const CONTINUITY = {
  ok: true,
  sessionId: 'session-restored',
  title: '大管家 · 常驻',
  available: true,
  reason: '',
  firstBoundAt: new Date(NOW - (3 * 3600 + 25 * 60) * 1000).toISOString(),
  lastSeenAt: new Date(NOW).toISOString(),
  uptimeMs: (3 * 3600 + 25 * 60) * 1000,
  rebuildCount: 2,
  source: 'config'
}
const CONTEXT = {
  ok: true,
  used: 85000,
  limit: 100000,
  percent: 85,
  compactions: { count: 2, lastAt: new Date(NOW - 1800000).toISOString() },
  source: 'session'
}
const DIGEST = {
  ok: true,
  date: '2026-11-28',
  generatedAt: new Date(NOW).toISOString(),
  source: 'board',
  counts: { done: 3, dispatched: 2, alerts: 1 },
  items: [
    { kind: 'done', text: 'fixture：恢复层纯函数测试跑通', at: new Date(NOW - 3600000).toISOString() },
    { kind: 'dispatched', text: 'fixture：派活给 server 跑长任务', at: new Date(NOW - 7200000).toISOString() },
    { kind: 'alert', text: 'fixture：板服务延迟偏高（示例）', at: new Date(NOW - 10800000).toISOString() }
  ]
}
const HEALTHY = {
  'api/cluster': CLUSTER,
  'api/board': BOARD,
  'api/host': HOST,
  'api/tiers': TIERS,
  'api/alerts': ALERTS,
  'api/butler/sessions': BUTLER,
  'api/butler/dialog': DIALOG,
  'api/butler/continuity': CONTINUITY,
  'api/butler/context': CONTEXT,
  'api/butler/digest': DIGEST
}
/** 路由在、但宿主如实降级（HTTP 200 + ok:false）时的契约形状：页面要显示「未知」而不是数字。 */
const UNAVAILABLE = {
  'api/butler/continuity': {
    ok: false, sessionId: null, title: null, available: false, reason: 'DSH 没有可用的会话读取器：无法确认常驻会话是否存活',
    firstBoundAt: null, lastSeenAt: null, uptimeMs: null, rebuildCount: 0, source: 'unavailable'
  },
  'api/butler/context': {
    ok: false, used: null, limit: null, percent: null, compactions: { count: null, lastAt: null },
    source: 'unavailable', sessionId: null, reason: 'DSH 没有可用的 tokenMeter 服务（token-meter 未挂载）：拒绝估算'
  },
  'api/butler/digest': {
    ok: false, date: '2026-11-28', generatedAt: new Date(NOW).toISOString(), source: 'unavailable',
    reason: '数据源都不可用：共享板 / 层级 / 告警都读不到（不估算）',
    counts: { done: null, dispatched: null, alerts: null }, items: [], days: 1
  }
}

/* ───────────────────────── 同源静态服务器 ───────────────────────── */
async function startServer() {
  const state = { mode: 'healthy' }
  const server = createServer(async (req, res) => {    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (pathname === ROUTE + '/index.html' || pathname === ROUTE + '/') {
      try {
        const html = await readFile(PAGE_FILE)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('read page failed: ' + String((error && error.message) || error))
      }
      return
    }
    if (pathname.startsWith(ROUTE + '/api/')) {
      if (state.mode === '404') {
        json(404, { ok: false, reason: 'fixture：路由未加载（HTTP 404）' })
        return
      }
      const key = pathname.slice(ROUTE.length + 1)
      if (state.mode === 'unavailable' && UNAVAILABLE[key]) {
        json(200, UNAVAILABLE[key])
        return
      }
      const body = HEALTHY[key]
      if (body) {
        json(200, body)
        return
      }
      json(404, { ok: false, reason: 'fixture：unknown route ' + key })
      return
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
    baseUrl: 'http://127.0.0.1:' + port,
    pageUrl: 'http://127.0.0.1:' + port + ROUTE + '/index.html',
    setMode(mode) { state.mode = mode },
    /** 模拟「人不在大管家页时又来了 3 条新消息」：未读徽标应随之增长。 */
    bumpDialog() {
      const start = DIALOG.cursor + 1
      for (let index = 0; index < 3; index += 1) {
        DIALOG.messages.push({
          seq: start + index,
          role: 'assistant',
          time: new Date(NOW + (index + 1) * 1000).toISOString(),
          text: 'fixture 新消息 ' + (index + 1) + '：你离开大管家页之后才到的（样本内容，不是真实对话）'
        })
      }
      DIALOG.cursor = start + 2
      DIALOG.counts.messages = DIALOG.messages.length
      DIALOG.counts.events = DIALOG.messages.length
    },
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.() })
  }
}

/* ───────────────────────── 最小 CDP 客户端 ───────────────────────── */
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(candidate => existsSync(candidate))

async function pickPort(start) {
  for (let port = start; port < start + 30; port += 1) {
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) })
      continue // 被占用
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
      const slot = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) slot.reject(new Error('CDP ' + JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
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
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
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
  function once(method, timeout = 25000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting ' + method)), timeout)
      const fn = params => {
        clearTimeout(timer)
        handlers.set(method, (handlers.get(method) || []).filter(item => item !== fn))
        resolve(params)
      }
      on(method, fn)
    })
  }
  return { ws, opened, send, on, once }
}

/* ───────────────────────── 断言 / 报告 ───────────────────────── */
const report = { page: 'public/index.html', scenarios: [], checks: [], pageErrors: [], ok: false }
function check(label, ok, detail) {
  report.checks.push({ label, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, same, same ? '' : '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}
function includes(label, actual, needle) {
  const text = String(actual === null || actual === undefined ? '' : actual)
  check(label, text.includes(needle), text.slice(0, 140))
}
const sleep = ms => new Promise(done => setTimeout(done, ms))

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
  const q = s => document.querySelector(s);
  const txt = s => ((q(s) || {}).textContent || '').trim();
  const nav = q('.nav-item.active');
  const unread = q('#navUnread');
  const thread = q('#thread');
  return {
    boot: window.__panelBootLog || [],
    page: document.body.dataset.page,
    activeNav: nav ? nav.getAttribute('data-page') : '',
    trajectorySelected: q('#tab-trajectory') ? q('#tab-trajectory').getAttribute('aria-selected') : null,
    traceTrajectoryHidden: q('#traceTrajectory') ? q('#traceTrajectory').hidden : null,
    statusExpanded: q('#statusBar') ? q('#statusBar').getAttribute('data-expanded') : null,
    statusDetailHidden: q('#statusDetail') ? q('#statusDetail').hidden : null,
    sessionPick: q('#sessionPick') ? q('#sessionPick').value : null,
    bindMode: txt('#bindMode'),
    statusSummary: txt('#statusSummary'),
    unread: { hidden: unread ? unread.hidden : null, text: txt('#navUnread'), count: unread ? unread.getAttribute('data-count') : null },
    contUptime: txt('#contUptime'),
    contRebuild: txt('#contRebuild'),
    context: {
      text: txt('#pillContext'),
      tone: q('#pillContextWrap') ? q('#pillContextWrap').getAttribute('data-tone') : null,
      title: q('#pillContextWrap') ? q('#pillContextWrap').title : ''
    },
    restoreNote: { hidden: q('#restoreNote') ? q('#restoreNote').hidden : null, text: txt('#restoreNote') },
    digest: { hidden: q('#digestPanel') ? q('#digestPanel').hidden : null, body: txt('#digestBody'), meta: txt('#digestMeta') },
    dialogEmpty: txt('#dialogEmpty'),
    thread: thread ? { top: Math.round(thread.scrollTop), height: thread.scrollHeight, client: thread.clientHeight } : null,
    panelErrors: window.__panelErrors || [],
    viewport: { w: innerWidth, h: innerHeight, scrollWidth: document.documentElement.scrollWidth }
  };
})()`

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-continuity-' + Date.now())
  const site = await startServer()
  const port = await pickPort(9360)
  let child = null
  let browser = null
  try {
    child = await launchEdge(port, profileDir)
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    const target = list.find(item => item.type === 'page')
    if (!target) throw new Error('no page target')
    browser = connect(target.webSocketDebuggerUrl)
    await browser.opened
    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    await browser.send('Log.enable')
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__panelErrors=[];' +
        "addEventListener('error',e=>{try{window.__panelErrors.push('error: '+String(e.message||e))}catch(_){}});" +
        "addEventListener('unhandledrejection',e=>{try{window.__panelErrors.push('rejection: '+String(e.reason && e.reason.message || e.reason))}catch(_){}});"
    })
    const runtimeErrors = []
    browser.on('Runtime.exceptionThrown', params => {
      const details = params && params.exceptionDetails ? params.exceptionDetails : {}
      const text = String(details.text || '') + ' ' + String((details.exception && details.exception.description) || '')
      runtimeErrors.push(text.trim().slice(0, 160))
    })
    browser.on('Log.entryAdded', params => {
      const entry = params && params.entry ? params.entry : {}
      // 网络层 4xx 是本页故意探测的失败分支（新路由未加载），页面已降级处理。
      if (entry.level === 'error' && entry.source !== 'network') runtimeErrors.push('console: ' + String(entry.text || '').slice(0, 160))
    })

    const evaluate = async expression => {
      const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails))
      return result.result ? result.result.value : undefined
    }
    const readPage = () => evaluate(PAGE_STATE_EXPR)

    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

    /** 用「页面脚本之前执行」的注入脚本写入 dshhp:* 恢复记录（先清空，保证场景独立）。 */
    let seedScriptId = null
    async function seed(store, mode) {
      site.setMode(mode || 'healthy')
      if (seedScriptId) {
        await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScriptId })
        seedScriptId = null
      }
      const source = '(() => { try { localStorage.clear();' +
        Object.entries(store).map(([key, value]) =>
          'localStorage.setItem(' + JSON.stringify(key) + ',' + JSON.stringify(value) + ');').join('') +
        ' } catch (error) { /* 存储不可用也不影响本场景其余断言 */ } })()'
      const added = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source })
      seedScriptId = added.identifier
      runtimeErrors.length = 0
      const loaded = browser.once('Page.loadEventFired', 25000)
      await browser.send('Page.navigate', { url: site.pageUrl })
      await loaded
      await waitFor(evaluate, "(() => { const d = document.body.dataset; return d.page === 'butler' || d.page === 'tasks' || d.page === 'cluster' || d.page === 'memory' || d.page === 'settings'; })()", 8000)
      await sleep(900)
      return readPage()
    }

    async function screenshot(name) {
      const dims = await evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
      const clip = { x: 0, y: 0, width: 1440, height: 1000, scale: 1 }
      void dims
      const png = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip })
      await writeFile(path.join(OUT_DIR, name), Buffer.from(png.data, 'base64'))
      report.scenarios[report.scenarios.length - 1].shot = 'tools/shots/' + name
    }

    /* ---------- 场景 0：直接双击打开 HTML（file://，没有宿主 API）也要能渲染 ---------- */
    runtimeErrors.length = 0
    const fileLoaded = browser.once('Page.loadEventFired', 20000)
    await browser.send('Page.navigate', { url: 'file:///' + PAGE_FILE.replace(/\\/g, '/') })
    await fileLoaded
    await sleep(1200)
    let view = await readPage()
    report.scenarios.push({ name: 'standalone-file', viewport: [1440, 1000], view })
    eq('独立文件：页面照常渲染（默认大管家页）', view.page, 'butler')
    includes('独立文件：状态条有降级摘要', view.statusSummary, '降级')
    includes('独立文件：常驻降级为未知', view.contUptime, '常驻 未知')
    eq('独立文件：上下文降级为未知', view.context.text, '上下文 未知')
    includes('独立文件：对话区写明数据源不可用', view.dialogEmpty, '不可用')
    await screenshot('shot-continuity-00-standalone-file-1440.png')

    /* ---------- 场景 1：恢复对话页（滚动/游标/状态条/会话） ---------- */
    const storeA = {
      'dshhp:page': 'butler',
      'dshhp:tab': 'dialogue',
      'dshhp:statusBar': '1',
      'dshhp:session': 'session-restored',
      'dshhp:cursors': JSON.stringify({ 'session-restored': 100 }),
      'dshhp:scroll': JSON.stringify({ 'session-restored': 0 })
    }
    view = await seed(storeA, 'healthy')
    report.scenarios.push({ name: 'restored-dialogue', viewport: [1440, 1000], view })
    includes('恢复：restorePanelState 初始化成功', view.boot.join(','), 'restorePanelState:ok')
    eq('恢复：停留在上次的大管家页', view.page, 'butler')
    eq('恢复：状态条展开态还原（data-expanded=true）', view.statusExpanded, 'true')
    eq('恢复：状态条详情面板可见', view.statusDetailHidden, false)
    eq('恢复：会话选择器还原为上次会话', view.sessionPick, 'session-restored')
    includes('恢复：绑定条标明手动选择', view.bindMode, '手动选择')
    eq('恢复：对话 tab 选中', view.trajectorySelected, 'false')
    check('恢复：滚动位置在顶部而非自动贴底', view.thread && view.thread.top === 0 && view.thread.height > view.thread.client, JSON.stringify(view.thread))
    eq('未读：游标 100 对比窗口 101–120 → 20 条', view.unread.text, '20')
    eq('未读：徽标带 data-count', view.unread.count, '20')
    includes('常驻：运行时长来自 api/butler/continuity', view.contUptime, '常驻 3 小时 25 分')
    eq('常驻：最近重建次数', view.contRebuild, '重建 2 次')
    eq('上下文：85% 显示百分比', view.context.text, '上下文 85%')
    eq('上下文：超过 80% 标 warn', view.context.tone, 'warn')
    eq('恢复：没有失效记录时不显示恢复提示', view.restoreNote.hidden, true)
    eq('页面无 JS 报错（恢复场景）', view.panelErrors, [])
    check('布局：无横向溢出', view.viewport.scrollWidth <= view.viewport.w, JSON.stringify(view.viewport))
    await screenshot('shot-continuity-01-restored-1440.png')

    /* ---------- 场景 1b：页签恢复为轨迹 ---------- */
    view = await seed(Object.assign({}, storeA, { 'dshhp:tab': 'trajectory' }), 'healthy')
    report.scenarios.push({ name: 'restored-trajectory', viewport: [1440, 1000], view })
    eq('恢复：上次页签是轨迹就回到轨迹', view.trajectorySelected, 'true')
    eq('恢复：轨迹面板可见', view.traceTrajectoryHidden, false)
    eq('恢复：轨迹 tab 下未读仍然保留（未看对话）', view.unread.text, '20')
    await screenshot('shot-continuity-02-restored-trajectory-1440.png')

    /* ---------- 场景 2：停在任务页 → 页面恢复 + nav 未读徽标 ---------- */
    view = await seed({
      'dshhp:page': 'tasks',
      'dshhp:tab': 'dialogue',
      'dshhp:statusBar': '0',
      'dshhp:session': 'session-restored',
      'dshhp:cursors': JSON.stringify({ 'session-restored': 100 }),
      'dshhp:scroll': JSON.stringify({ 'session-restored': 120 })
    }, 'healthy')
    report.scenarios.push({ name: 'page-tasks-unread', viewport: [1440, 1000], view })
    eq('恢复：回到上次停留的任务页', view.activeNav, 'tasks')
    eq('恢复：状态条收起态还原', view.statusExpanded, 'false')
    eq('未读：在别的页时 nav 上保留未读数', view.unread.text, '20')
    eq('未读：徽标可见', view.unread.hidden, false)
    await screenshot('shot-continuity-03-page-restored-unread-1440.png')
    // 人还在任务页：新消息到达后未读要继续增长（离开大管家页也要低频拉对话）。
    site.bumpDialog()
    await sleep(9000)
    view = await readPage()
    eq('未读：不在大管家页时也会随新消息增长（20 → 23）', view.unread.text, '23')
    // 点 nav「大管家」= 切到该页 → 未读清零。
    await evaluate("document.querySelector('.nav-item[data-page=\"butler\"]').click()")
    await sleep(500)
    view = await readPage()
    eq('未读：切到大管家页后清零（页恢复为 butler）', view.page, 'butler')
    eq('未读：清零后徽标隐藏', view.unread.hidden, true)

    /* ---------- 场景 3：恢复记录全部失效 → 回退默认 + 说明原因 ---------- */
    view = await seed({
      'dshhp:page': 'nowhere',
      'dshhp:tab': 'tabs-that-do-not-exist',
      'dshhp:statusBar': 'maybe',
      'dshhp:session': 'session-dead',
      'dshhp:cursors': '{}',
      'dshhp:scroll': '{}'
    }, 'healthy')
    report.scenarios.push({ name: 'invalid-fallback', viewport: [1440, 1000], view })
    eq('失效：页回退大管家', view.page, 'butler')
    eq('失效：会话回退自动绑定（picker 空值）', view.sessionPick, '')
    eq('失效：恢复提示可见', view.restoreNote.hidden, false)
    includes('失效：说明页已回退原因', view.restoreNote.text, '已回退「大管家」')
    includes('失效：说明页签已回退原因', view.restoreNote.text, '已回退「对话」')
    includes('失效：说明状态条记录无效', view.restoreNote.text, '状态条展开态记录无效')
    includes('失效：说明会话已失效并回退自动绑定', view.restoreNote.text, '已回退自动绑定')
    eq('页面无 JS 报错（失效回退场景）', view.panelErrors, [])
    await screenshot('shot-continuity-04-invalid-fallback-1440.png')

    /* ---------- 场景 4：所有新路由 404 → 面板仍渲染并降级「未知」 ---------- */
    view = await seed(Object.assign({}, storeA, { 'dshhp:tab': 'trajectory' }), '404')
    await evaluate("document.querySelector('#digestBtn') && document.querySelector('#digestBtn').click()")
    await sleep(600)
    view = await readPage()
    report.scenarios.push({ name: 'api-404-degrade', viewport: [1440, 1000], view })
    includes('404：常驻时长降级「未知」', view.contUptime, '常驻 未知')
    includes('404：重建次数降级「未知」', view.contRebuild, '重建 未知')
    eq('404：上下文 pill 降级「未知」', view.context.text, '上下文 未知')
    eq('404：上下文降级为 muted', view.context.tone, 'muted')
    includes('404：对话区如实说明路由未加载', view.dialogEmpty, '404')
    eq('404：未读徽标不显示假值', view.unread.hidden, true)
    eq('404：今日归档浮层已打开', view.digest.hidden, false)
    includes('404：今日归档说明暂无归档', view.digest.body, '暂无归档')
    includes('404：今日归档写明路由未加载', view.digest.body, '404')
    eq('页面无 JS 报错（404 降级场景）', view.panelErrors, [])
    await screenshot('shot-continuity-05-api-404-degrade-1440.png')

    /* ---------- 场景 5：路由在但宿主如实降级（HTTP 200 + ok:false）→ 同样显示「未知」 ---------- */
    view = await seed(Object.assign({}, storeA, { 'dshhp:tab': 'dialogue' }), 'unavailable')
    const beforeDigest = view.thread
    await evaluate("document.querySelector('#digestBtn') && document.querySelector('#digestBtn').click()")
    await sleep(600)
    view = await readPage()
    report.scenarios.push({ name: 'route-unavailable-degrade', viewport: [1440, 1000], view })
    check('降级：打开归档浮层前后滚动位置不变（恢复位置不被抢）', beforeDigest && view.thread && view.thread.top === beforeDigest.top, JSON.stringify({ before: beforeDigest, after: view.thread }))
    includes('降级：continuity ok:false → 常驻未知', view.contUptime, '常驻 未知')
    includes('降级：continuity ok:false → 重建未知', view.contRebuild, '重建 未知')
    eq('降级：context ok:false → 上下文未知', view.context.text, '上下文 未知')
    eq('降级：context 未冒充 0%', view.context.title.includes('拒绝估算'), true)
    eq('降级：今日归档浮层已打开', view.digest.hidden, false)
    includes('降级：digest ok:false → 暂无归档', view.digest.body, '暂无归档')
    includes('降级：digest 写明宿主降级原因', view.digest.body, '数据源都不可用')
    eq('页面无 JS 报错（200+ok:false 降级场景）', view.panelErrors, [])
    await screenshot('shot-continuity-06-route-unavailable-1440.png')

    /* ---------- 全场景公共断言 ---------- */
    check('运行期无页面 JS 异常（Runtime.exceptionThrown + 非网络 console）', runtimeErrors.length === 0, runtimeErrors.join(' | '))
    report.ok = report.checks.every(item => item.ok)
  } finally {
    try { browser && browser.ws.close() } catch { /* 忽略 */ }
    try { child && child.kill() } catch { /* 忽略 */ }
    await site.close()
    await sleep(150)
    try {
      const { rm } = await import('node:fs/promises')
      await rm(profileDir, { recursive: true, force: true })
    } catch { /* 忽略临时 profile 清理失败 */ }
  }

  await writeFile(path.join(OUT_DIR, 'continuity-report.json'), JSON.stringify(report, null, 2), 'utf8')
  for (const item of report.checks) {
    process.stdout.write((item.ok ? 'PASS ' : 'FAIL ') + item.label + (item.detail ? '  ' + item.detail : '') + '\n')
  }
  process.stdout.write('\nresult: ' + (report.ok ? 'PASS' : 'FAIL') + ' (' +
    report.checks.filter(item => item.ok).length + '/' + report.checks.length + ')\n')
  process.exit(report.ok ? 0 : 1)
}

await main()
