#!/usr/bin/env node
/**
 * tools/cdp-alerts.mjs —— 0.6.0 TRAIL 告警页面的运行时自检 + 截图（Edge headless + CDP，零依赖）。
 *
 * 用内置 HTTP fixture 起一个同源站点，把 `public/index.html` 按插件真实路由
 * `/dsh-html-panel/` 提供出去，并把 5 条只读路由换成可控 fixture：
 *   - alerts   有告警：高 2 / 中 1 / 低 2，含任务类与节点类告警；
 *   - empty    无告警：counts 全 0（页面必须显示「当前没有需要你处理的异常」，不渲染空卡片）；
 *   - （可选 --live）不在 fixture 里跑，而是打开本机真实 DSH 的 `/dsh-html-panel/index.html`，
 *     验证「Host 未重启时 api/alerts 404 → 页面退回 0.5.0 行为」并截图（真实数据）。
 *
 * 断言覆盖：三问第一问由告警驱动（需要你 N 条 / 无异常文案 / 高·中计数 = 卡片数）、
 * 告警卡五要素（严重度颜色 + 中文类目 + 为什么 + 建议动作 + 证据字段）、低优先级单独折叠不占计数、
 * 任务卡告警标记可点跳到告警卡（切页 + 展开 + 定位）、1440/900 无横向溢出、页面 JS 报错 0。
 *
 * 用法: node tools/cdp-alerts.mjs [--live] [--live-port 60654]
 * 产物: tools/shots/cdp-alerts-report.json + shot-alerts-*.png
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

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const livePortIndex = args.indexOf('--live-port')
const LIVE_PORT = livePortIndex >= 0 && args[livePortIndex + 1] ? Number(args[livePortIndex + 1]) : 60654

/* ───────────────────────── fixture 数据（形状照真实路由返回） ───────────────────────── */
const NOW = Date.parse('2026-11-21T12:12:06.226Z')
const iso = ms => new Date(ms).toISOString()

const CLUSTER_REAL = {
  generatedAt: iso(NOW),
  interconnect: true,
  self: { instanceId: 'pc-ky614' },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'up' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
  ],
  board: null,
}

const HOST_REAL = {
  generatedAt: iso(NOW),
  hostname: 'fixture-pc',
  os: { platform: 'win32', release: '10.0.26300', uptimeSec: 7200 },
  memory: { totalBytes: 34359738368, freeBytes: 17179869184, ratio: 0.5 },
  cpu: { count: 12, load1: 0 },
  disks: [{ mount: 'C:', label: 'C: 系统盘', totalBytes: 155692564480, freeBytes: 107374182400, ratio: 0.31, error: null }],
}

/** 任务行：与真实 `/api/board` tasks[] 同字段；前两张是重复劳动对，便于任务卡标记断言。 */
function task(row) {
  const base = {
    owner: null, requireReview: false, brief: 'fixture：CDP 自检数据，不是真实任务。', acceptance: [],
    createdAt: NOW - 60 * 60000, updatedAt: NOW - 10 * 60000,
    leaseDeadline: null, ackDeadline: null, ackAt: null, expiredAt: null, doneAt: null,
    ackState: 'none', evidenceCount: 0, revision: 2, blockedBy: [], writeScopes: [],
    ready: false, writeScopeWarnings: [], source: 'mesh', unsupported: ['blockedBy', 'writeScopes'],
  }
  return { ...base, ...row, subject: row.title, description: row.brief }
}

const BOARD_REAL = {
  generatedAt: iso(NOW),
  configured: true,
  source: { origin: 'http://172.24.112.11:13090' },
  health: { ok: true, latencyMs: 37, service: 'dsh-team-mesh board', version: '1.0.0', schema_version: 4 },
  tasks: [
    task({ id: 't-fixture-dup-a', title: 'fixture：同标题并存的任务甲', lifecycle: 'open', state: 'awaiting', ackState: 'pending', ackDeadline: NOW + 10 * 60000, owner: 'agent-team:pc:lead' }),
    task({ id: 't-fixture-dup-b', title: 'fixture：同标题并存的任务甲', lifecycle: 'working', state: 'leased', leaseDeadline: NOW + 5 * 60000, owner: 'agent-team:server:worker-1', evidenceCount: 1, updatedAt: NOW - 60000 }),
    task({ id: 't-fixture-stale', title: 'fixture：租约已过期的任务', lifecycle: 'working', state: 'stale', leaseDeadline: NOW - 20 * 60000, expiredAt: NOW - 19 * 60000, owner: 'agent-team:mcloud:worker-1' }),
    task({ id: 't-fixture-done-noev', title: 'fixture：完成但没有证据', lifecycle: 'done', state: 'done', status: 'completed', evidenceCount: 0, updatedAt: NOW - 15 * 60000 }),
    task({ id: 't-fixture-ok', title: 'fixture：正常完成的任务', lifecycle: 'done', state: 'done', status: 'completed', evidenceCount: 3, updatedAt: NOW - 30 * 60000 }),
  ],
  events: [],
  official: { available: true, teams: [{ sessionId: 'session-main', title: 'fixture 主控会话', enabled: true, taskCount: 0, shownTasks: 0 }], tasks: [], hiddenTasks: 0, truncated: false },
}

const TIERS_REAL = {
  generatedAt: iso(NOW),
  source: {
    local: 'sessions+agents',
    subagents: 'session-header(origin+parentSession)',
    subagentMode: 'official-projection',
    remote: [{ instanceId: 'server', link: 'up', sessions: 1 }, { instanceId: 's5', link: 'down', sessions: 0 }],
    cached: false,
    ageMs: 0,
  },
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: iso(NOW - 6 * 3600000) },
  nodes: [
    { id: 'session-main', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: 'fixture 主控会话', status: 'run', startedAt: iso(NOW - 3 * 3600000), childSessionId: 'session-main', parentSessionId: null, mode: null },
    { id: 'sub-orphan', parentId: 'pc-ky614', tier: 1, kind: 'subagent', device: 'pc-ky614', title: 'fixture 孤儿子代理', status: 'idle', startedAt: iso(NOW - 10 * 86400000), childSessionId: 'sub-orphan', parentSessionId: 'session-gone', mode: 'one-shot' },
  ],
  degraded: { reason: '远端设备的子代理层级不可见（interconnect 只列顶层活会话）' },
}

/** 一条告警（字段与 `/api/alerts` alerts[] 契约一致）。 */
function alert(row) {
  return { ruleId: row.ruleId || 'evidence_gate', subjectType: 'task', ...row }
}

const ALERTS_REAL = {
  generatedAt: iso(NOW),
  source: { classifier: 'trail-rules-v1', taxonomy: 21, rules: 10, board: 'real', tiers: 'degraded', cached: false, ageMs: 0 },
  counts: { high: 2, medium: 1, low: 2, total: 5 },
  alerts: [
    alert({
      id: 'trail-evidence_gate-task-t-fixture-done-noev', ruleId: 'evidence_gate', severity: 'high',
      category: 'Instruction Non-compliance', categoryLabel: '不按指令完成',
      subject: '任务 t-fixture-done-noev「fixture：完成但没有证据」',
      why: '任务已是 done，但证据条数是 0（完成门禁要求可采信证据）。',
      evidence: ['tasks.t-fixture-done-noev.state=done', 'tasks.t-fixture-done-noev.evidenceCount=0'],
      suggestion: '让执行方补证据后重新走完成门禁；done 但无证据的卡不能当交付。',
      subjectId: 't-fixture-done-noev',
    }),
    alert({
      id: 'trail-lease_expired-task-t-fixture-stale', ruleId: 'lease_expired', severity: 'high',
      category: 'Timeout Issues', categoryLabel: '超时',
      subject: '任务 t-fixture-stale「fixture：租约已过期的任务」',
      why: '租约已过期 20 分钟，任务还没完成，原负责人没有续租。',
      evidence: ['tasks.t-fixture-stale.state=stale', 'tasks.t-fixture-stale.leaseDeadline=' + iso(NOW - 20 * 60000) + '（已过期 20 分钟）'],
      suggestion: '先确认原负责人是否还活着；确认失联就接管（mesh_task_claim）或重派。',
      subjectId: 't-fixture-stale',
    }),
    alert({
      id: 'trail-duplicate_work-task-t-fixture-dup-a', ruleId: 'duplicate_work', severity: 'medium',
      category: 'Task Orchestration', categoryLabel: '任务编排',
      subject: '同标题任务 ×2「fixture：同标题并存的任务甲」',
      why: '同一标题有 2 张进行中/待接手的卡并存（t-fixture-dup-a、t-fixture-dup-b），疑似重复派活。',
      evidence: ['tasks.t-fixture-dup-a.title=fixture：同标题并存的任务甲', 'tasks.t-fixture-dup-b.title=fixture：同标题并存的任务甲'],
      suggestion: '确认哪张是唯一有效卡：取消多余的，或把验收标准合并到一张；避免两边各做一遍。',
      subjectId: 't-fixture-dup-a', relatedIds: ['t-fixture-dup-a', 't-fixture-dup-b'],
    }),
    alert({
      id: 'trail-subagent_orphan-node-sub-orphan', ruleId: 'subagent_orphan', severity: 'low', subjectType: 'node',
      category: 'Context Handling Failures', categoryLabel: '上下文处理失败',
      subject: '子代理 「fixture 孤儿子代理」（sub-orphan）',
      why: '父会话已不在活会话列表（tiers 把它挂到 T1），会话创建于 2026-11-11T12:12:06.226Z（10.0 天前）。',
      evidence: ['nodes.sub-orphan.kind=subagent', 'nodes.sub-orphan.tier=1', 'nodes.sub-orphan.status=idle'],
      suggestion: '父会话已结束，它不会再收到指令；确认无用就结束这个遗留子代理会话。',
      subjectId: 'sub-orphan',
    }),
    alert({
      id: 'trail-duplicate_work-task-t-fixture-dup-x1', ruleId: 'duplicate_work', severity: 'low',
      category: 'Task Orchestration', categoryLabel: '任务编排',
      subject: '同标题任务 ×2「fixture：取消后又重开的旧卡」',
      why: '最近 24 小时有 2 张同标题的卡都被取消（t-fixture-dup-x1、t-fixture-dup-x2），疑似反复建卡又放弃。',
      evidence: ['tasks.t-fixture-dup-x1.lifecycle=canceled', 'tasks.t-fixture-dup-x2.lifecycle=canceled'],
      suggestion: '确认哪张是唯一有效卡：取消多余的，或把验收标准合并到一张。',
      subjectId: 't-fixture-dup-x1', relatedIds: ['t-fixture-dup-x1', 't-fixture-dup-x2'],
    }),
  ],
  degraded: { reasons: ['层级快照有降级：fixture 说明，远端设备的子代理层级不可见'] },
}

const ALERTS_EMPTY = {
  generatedAt: iso(NOW),
  source: { classifier: 'trail-rules-v1', taxonomy: 21, rules: 10, board: 'real', tiers: 'real', cached: false, ageMs: 0 },
  counts: { high: 0, medium: 0, low: 0, total: 0 },
  alerts: [],
  degraded: { reasons: [] },
}

/* ───────────────────────── fixture HTTP 服务 ───────────────────────── */
async function startFixtureServer() {
  const state = { scenario: 'alerts' }
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
    if (pathname === ROUTE + '/api/cluster') return sendJson(200, CLUSTER_REAL)
    if (pathname === ROUTE + '/api/board') return sendJson(200, BOARD_REAL)
    if (pathname === ROUTE + '/api/host') return sendJson(200, HOST_REAL)
    if (pathname === ROUTE + '/api/tiers') return sendJson(200, TIERS_REAL)
    if (pathname === ROUTE + '/api/alerts') {
      return sendJson(200, state.scenario === 'empty' ? ALERTS_EMPTY : ALERTS_REAL)
    }
    if (pathname === ROUTE + '/api/action' && req.method === 'POST') {
      return sendJson(200, { ok: false, code: 'fixture', reason: 'fixture 未实现动作' })
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    setScenario: name => { state.scenario = name },
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.() }),
  }
}

/* ───────────────────────── 最小 CDP 客户端 ───────────────────────── */
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(candidate => existsSync(candidate))

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
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-component-update',
    '--disable-popup-blocking', '--force-device-scale-factor=1',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    'about:blank',
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
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error('CDP ' + JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
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

/* ───────────────────────── 断言 / 主流程 ───────────────────────── */
const report = {
  page: 'public/index.html',
  viewport: VIEWPORT,
  generatedAt: new Date().toISOString(),
  checks: [],
  shots: [],
  pageErrors: [],
  runtimeErrors: [],
  scenarios: [],
  ok: false,
}
const sleep = ms => new Promise(done => setTimeout(done, ms))
const checks = []
function ck(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
}
function eq(name, actual, expected) {
  ck(name, actual === expected, 'actual=' + String(actual) + ' expected=' + String(expected))
}
function has(name, text, needle) {
  ck(name, typeof text === 'string' && text.includes(needle), 'needle=' + needle)
}

/** 一次 evaluate 取回页面事实（只读 DOM，不构造）。 */
const PAGE_STATE = `(() => {
  const q = s => document.querySelector(s)
  const qa = s => Array.from(document.querySelectorAll(s))
  const txt = s => { const el = q(s); return el ? el.textContent.trim() : '' }
  const needsBlock = q('#tqNeeds')
  const cards = qa('#alertCards .alert-card, #alertCards li.alert-card, #alertFold .alert-card, #alertFoldLow .alert-card')
  return {
    dataset: { ...document.body.dataset },
    page: document.body.dataset.page,
    tq: {
      bar: !!(q('#tqBar') && !q('#tqBar').hidden),
      needsBlockVisible: !!(needsBlock && !needsBlock.hidden),
      needsN: txt('#tqNeedsN'),
      needsText: txt('#tqNeeds'),
      fold: !!q('#alertFold'),
      foldOpen: !!(q('#alertFold') && q('#alertFold').open),
      lowFold: !!q('#alertFoldLow'),
      cards: cards.length,
      sevHigh: qa('.alert-card.sev-high').length,
      sevMedium: qa('.alert-card.sev-medium').length,
      sevLow: qa('.alert-card.sev-low').length,
      cardText: cards.map(card => card.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
      catText: qa('.alert-card .al-cat').map(el => el.textContent.trim()).join(','),
      whyText: qa('.alert-card .al-why').map(el => el.textContent.trim()).join(' | '),
      fixText: qa('.alert-card .al-fix').map(el => el.textContent.trim()).join(' | '),
      eviText: qa('.alert-card .al-evi').map(el => el.textContent.trim()).join(' | '),
      healthText: txt('#tqHealth'),
    },
    tasks: {
      rows: qa('#taskList .item').length,
      flags: qa('#taskList .alert-flag').length,
      flagTexts: qa('#taskList .alert-flag').map(el => el.textContent.trim()),
      flagJump: qa('#taskList .alert-flag[data-alert-jump]').length,
    },
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    errors: (window.__panelErrors || []).slice(0, 6),
  }
})()`

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  if (!existsSync(PAGE_FILE)) throw new Error('找不到页面文件')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-alerts-' + Date.now())
  await mkdir(profileDir, { recursive: true })

  const fixture = await startFixtureServer()
  const port = await pickPort(9620)
  let child = null
  let browser = null
  try {
    child = await launchEdge(port, profileDir)
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    const pageTarget = list.find(target => target.type === 'page')
    if (!pageTarget) throw new Error('no page target')
    browser = connect(pageTarget.webSocketDebuggerUrl)
    await browser.opened
    for (const domain of ['Page', 'Runtime', 'Log']) await browser.send(domain + '.enable')
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    browser.on('Runtime.exceptionThrown', params => {
      const detail = params && params.exceptionDetails
        ? (params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text)
        : 'exception'
      report.runtimeErrors.push(String(detail).slice(0, 300))
    })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__panelErrors=[];' +
        'addEventListener("error",e=>{try{window.__panelErrors.push("error: "+String(e.message||e))}catch(_){}});' +
        'addEventListener("unhandledrejection",e=>{try{window.__panelErrors.push("rejection: "+String(e.reason))}catch(_){}});',
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
      await sleep(150)
    }
    async function goto(url, label) {
      await browser.send('Page.navigate', { url })
      await waitFor('document.readyState === "complete"', 10000, 'readyState ' + label)
      await waitFor('!!document.body && !!document.body.dataset.alerts', 10000, 'boot ' + label)
      await waitFor('document.body.dataset.alerts && document.body.dataset.alerts !== "loading"', 12000, 'alerts settled ' + label)
      await waitFor('document.body.dataset.board && document.body.dataset.board !== "loading"', 12000, 'board settled ' + label)
      await sleep(300)
      return state()
    }

    /* ================= 场景 1：有告警（1440） ================= */
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    fixture.setScenario('alerts')
    let s = await goto(fixture.baseUrl + ROUTE + '/index.html?scene=alerts&t=' + Date.now(), 'alerts')
    report.scenarios.push({ name: 'alerts', dataset: s.dataset })
    eq('告警接口真实加载（alerts=real）', s.dataset.alerts, 'real')
    eq('三问条出现', s.tq.bar, true)
    eq('第一问可见', s.tq.needsBlockVisible, true)
    eq('需要你计数 = 高+中（2+1）', s.tq.needsN, '3')
    has('显示「需要你：3 条」', s.tq.needsText, '需要你：3 条')
    eq('高/中告警卡片数 = 3', s.tq.sevHigh + s.tq.sevMedium, 3)
    eq('高严重度卡片数', s.tq.sevHigh, 2)
    eq('中严重度卡片数', s.tq.sevMedium, 1)
    eq('低优先级单独折叠', s.tq.lowFold, true)
    eq('低优先级卡片数（不计入需要你）', s.tq.sevLow, 2)
    has('告警卡有中文类目「任务编排」', s.tq.catText, '任务编排')
    has('告警卡有中文类目「超时」', s.tq.catText, '超时')
    has('告警卡有一句话为什么', s.tq.whyText, '证据条数是 0')
    has('告警卡有建议动作', s.tq.fixText, '建议：')
    has('告警卡有证据字段路径', s.tq.eviText, 'tasks.t-fixture-done-noev.evidenceCount=0')
    eq('「需要你」折叠默认展开（截图能看到卡片）', s.tq.foldOpen, true)
    eq('告警降级原因进「系统是否健康」', s.tq.healthText.includes('告警分类器'), true)
    eq('1440 无横向溢出', s.overflow <= 1, true)
    await shot('shot-alerts-01-needs-1440.png')

    // 任务页：告警命中任务卡有标记
    await click('.nav-item[data-page="tasks"]')
    await waitFor('document.body.dataset.page === "tasks"', 4000, 'tasks page')
    s = await state()
    eq('任务页有任务行', s.tasks.rows, 5)
    // 4 个标记 = 高·不按指令完成（done 无证据）+ 高·超时（租约过期）+ 中·任务编排 ×2（重复劳动两张卡）
    eq('任务卡告警标记数（命中任务的行各一个）', s.tasks.flags, 4)
    eq('任务卡标记带跳转属性', s.tasks.flagJump, 4)
    has('任务卡标记带严重度文案（中·任务编排）', s.tasks.flagTexts.join(','), '中 · 任务编排')
    has('任务卡标记带严重度文案（高·超时）', s.tasks.flagTexts.join(','), '高 · 超时')
    await shot('shot-alerts-02-tasks-flags-1440.png')

    // 点标记 → 跳回大管家并展开告警卡
    await click('#taskList .alert-flag[data-alert-jump]')
    await waitFor('document.body.dataset.page === "butler"', 4000, 'jump back to butler')
    await sleep(400)
    s = await state()
    eq('点任务卡标记跳回大管家', s.page, 'butler')
    eq('跳转后告警折叠展开', s.tq.foldOpen, true)
    has('跳转后告警卡仍在页面里', s.tq.cardText, '同标题任务')
    await shot('shot-alerts-03-jump-1440.png')

    /* ================= 场景 2：有告警（900） ================= */
    await setViewport(900, 1000)
    await sleep(300)
    s = await state()
    ck('900 无横向溢出（有告警）', s.overflow <= 1, 'overflow=' + s.overflow)
    eq('900 告警卡仍在', s.tq.sevHigh + s.tq.sevMedium, 3)
    await shot('shot-alerts-04-needs-900.png')

    /* ================= 场景 3：无告警（1440） ================= */
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    fixture.setScenario('empty')
    s = await goto(fixture.baseUrl + ROUTE + '/index.html?scene=empty&t=' + Date.now(), 'empty')
    report.scenarios.push({ name: 'empty', dataset: s.dataset })
    eq('无告警时第一问仍显示（明说没有异常）', s.tq.needsBlockVisible, true)
    eq('无告警时计数为 0', s.tq.needsN, '0')
    has('无告警文案「当前没有需要你处理的异常」', s.tq.needsText, '当前没有需要你处理的异常')
    eq('无告警时不渲染告警卡', s.tq.cards, 0)
    eq('无告警时没有低优先级折叠', s.tq.lowFold, false)
    eq('无告警时任务卡无标记', s.tasks.flags, 0)
    eq('1440 无横向溢出（无告警）', s.overflow <= 1, true)
    await shot('shot-alerts-05-empty-1440.png')

    /* ================= 场景 4：无告警（900） ================= */
    await setViewport(900, 1000)
    await sleep(300)
    s = await state()
    ck('900 无横向溢出（无告警）', s.overflow <= 1, 'overflow=' + s.overflow)
    has('900 无告警文案仍在', s.tq.needsText, '当前没有需要你处理的异常')
    await shot('shot-alerts-06-empty-900.png')
  } finally {
    try { await fixture.close() } catch { /* ignore */ }
    try { if (browser) browser.ws.close() } catch { /* ignore */ }
    if (child) {
      try { child.kill() } catch { /* ignore */ }
    }
    await sleep(300)
    try { await rm(profileDir, { recursive: true, force: true }) } catch { /* Edge 可能还占着文件，无害 */ }
  }

  /* ================= 场景 5（可选）：本机真实 DSH 页面 ================= */
  if (LIVE) {
    const liveUrl = 'http://127.0.0.1:' + LIVE_PORT + ROUTE + '/index.html?live=' + Date.now()
    const liveProfile = path.join(os.tmpdir(), 'edge-cdp-alerts-live-' + Date.now())
    await mkdir(liveProfile, { recursive: true })
    let liveChild = null
    let liveBrowser = null
    try {
      const livePort = await pickPort(9640)
      liveChild = await launchEdge(livePort, liveProfile)
      const targets = await (await fetch('http://127.0.0.1:' + livePort + '/json/list')).json()
      const target = targets.find(item => item.type === 'page')
      if (!target) throw new Error('no live page target')
      liveBrowser = connect(target.webSocketDebuggerUrl)
      await liveBrowser.opened
      await liveBrowser.send('Page.enable')
      await liveBrowser.send('Runtime.enable')
      await liveBrowser.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false })
      const readLive = async expression => {
        const out = await liveBrowser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        return out.result ? out.result.value : undefined
      }
      await liveBrowser.send('Page.navigate', { url: liveUrl })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const ready = await readLive('!!document.body && !!document.body.dataset && !!document.body.dataset.alerts').catch(() => false)
        if (ready) break
        await sleep(100)
      }
      await sleep(1800)
      const live = await readLive(`(() => {
        const needs = document.querySelector('#tqNeeds')
        const bar = document.querySelector('#tqBar')
        const health = document.querySelector('#tqHealth')
        return {
          dataset: { ...document.body.dataset },
          needsText: needs ? needs.textContent.replace(/\\s+/g, ' ').trim() : '',
          needsBlockVisible: !!(needs && !needs.hidden),
          healthText: health ? health.textContent.replace(/\\s+/g, ' ').trim() : '',
          barVisible: !!(bar && !bar.hidden),
          overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        }
      })()`)
      report.scenarios.push({ name: 'live', dataset: live.dataset })
      ck('live：真实页面加载完成（alerts 状态已定，不是 loading）', !!live.dataset.alerts && live.dataset.alerts !== 'loading', JSON.stringify(live.dataset))
      eq('live：三问条在真实数据下出现', live.barVisible, true)
      eq('live：1440 无横向溢出', live.overflow <= 1, true)
      if (live.dataset.alerts === 'missing') {
        has('live：api/alerts 404 时健康问写明「重启 DSH 后路由生效」', live.healthText, 'api/alerts')
        has('live：健康问写明当前是 HTTP 404', live.healthText, '404')
        // 真实板上此刻没有 awaiting/undelivered/stale 时第一问合法为空（不编告警）；有的话按 0.5.0 列出。
        ck('live：404 时第一问如实（无待办为空 / 有则按板状态列出，不编告警）',
          live.needsBlockVisible === false || live.needsText.includes('在等') || live.needsText.includes('需要你'),
          JSON.stringify({ visible: live.needsBlockVisible, text: live.needsText.slice(0, 120) }))
      } else {
        has('live：api/alerts 已生效时第一问由告警驱动', live.needsText, '需要你')
      }
      const { data } = await liveBrowser.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(OUT_DIR, 'shot-alerts-07-live-real-1440.png'), Buffer.from(data, 'base64'))
      report.shots.push('tools/shots/shot-alerts-07-live-real-1440.png')
    } finally {
      try { if (liveBrowser) liveBrowser.ws.close() } catch { /* ignore */ }
      if (liveChild) {
        try { liveChild.kill() } catch { /* ignore */ }
      }
      await sleep(300)
      try { await rm(liveProfile, { recursive: true, force: true }) } catch { /* Edge 可能还占着文件，无害 */ }
    }
  }

  const failed = checks.filter(item => !item.ok)
  report.checks = checks
  report.failed = failed.length
  report.passed = checks.length - failed.length
  report.ok = failed.length === 0
  await writeFile(path.join(OUT_DIR, 'cdp-alerts-report.json'), JSON.stringify(report, null, 2), 'utf8')

  process.stdout.write('\n== cdp-alerts: ' + checks.length + ' checks ==\n')
  for (const item of checks) {
    process.stdout.write((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.ok || !item.detail ? '' : '  [' + item.detail + ']') + '\n')
  }
  process.stdout.write('\nresult: ' + (report.ok ? 'PASS' : 'FAIL') + ' (' + report.passed + '/' + checks.length + ') shots=' + report.shots.length + '\n')
  process.exit(report.ok ? 0 : 1)
}

main().catch(error => {
  process.stderr.write('cdp-alerts failed: ' + String((error && error.stack) || error) + '\n')
  process.exit(1)
})
