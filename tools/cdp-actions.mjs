#!/usr/bin/env node
/**
 * tools/cdp-actions.mjs —— 用 Edge headless + CDP 验证「常用动作」真的会生效、
 * 做不到时如实显示「暂不支持：原因」。零依赖（Node 内置 WebSocket / fetch）。
 *
 * 用法（插件根目录）: node tools/cdp-actions.mjs
 *
 * 被测对象是 public/index.html 本身 + 它和两方的协议：
 *   - 页面 → 父窗口（lib/client.js）: `panel-action` / `panel-action-result`
 *     用 **桩父窗口 harness**（/harness.html）模拟，验证成功 / 暂不支持 / 草稿替代；
 *     /harness-silent.html 不回消息，验证 2.5 秒超时回执。
 *   - 页面 → 宿主路由: 同源 POST api/action，fixture 服务器按场景返回真形状结果
 *     （可达 / 不可达 / 老宿主 404 / 报告内容）。
 *   - 页面本地: 打开看板用 api/board 的真实 origin，window.open 后检查新标签页。
 *
 * 断言：每个按钮的结果回执、没有「演示」字样、只有「重启 DSH」禁用、页面 JS
 * 报错 0、失败分支不静默、报告内容来自宿主返回值。截图写 tools/shots/。
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
const BOARD_ORIGIN = 'http://172.24.112.14:13090'
const MEMORY_ORIGIN = 'http://172.24.112.11:1933'
const REPORT_NAME = '0.4.0-跨端验证与安装排障-20261121.md'
const REPORT_TEXT = '# 0.4.0 跨端验证报告\n\n- 报告正文 A\n- 报告正文 B\n'
const REPORT_MTIME = Date.parse('2026-11-21T01:26:00.000Z')

const CLUSTER_REAL = {
  generatedAt: '2026-11-21T06:00:00.000Z',
  interconnect: true,
  self: { instanceId: 'pc-ky614' },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'down' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
    { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'down' },
    { instanceId: 'mcloud', origin: '127.0.0.1:13086', link: 'down' },
  ],
  board: null,
}

const HOST_REAL = {
  generatedAt: '2026-11-21T06:00:00.000Z',
  hostname: 'test-host',
  os: { platform: 'win32', release: '10.0.26200', uptimeSec: 1000 },
  memory: { totalBytes: 34359738368, freeBytes: 17179869184, ratio: 0.5 },
  cpu: { count: 12, load1: 0.4 },
  disks: [
    { mount: 'C:', label: 'C: 系统盘', totalBytes: 155692564480, freeBytes: 107374182400, ratio: 0.31 },
    { mount: 'D:', label: 'D: 数据盘', totalBytes: 1030792151040, freeBytes: 579820584960, ratio: 0.44 },
  ],
}

/** Board fixture: 2 tasks + 2 events, real origin (so 「打开看板」 has a target). */
const BOARD_REAL = {
  generatedAt: '2026-11-21T06:00:01.000Z',
  configured: true,
  source: { origin: BOARD_ORIGIN },
  health: { ok: true, latencyMs: 21, service: 'dsh-team-mesh board', version: '0.5.0', schema_version: 4 },
  tasks: [
    { id: 't-demo-1', title: '示例任务：核对板服务', state: 'leased', owner: 'dev-a', node: 'pc-a',
      evidenceCount: 2, lifecycle: 'working', ackState: 'acked', updatedAt: Date.now() - 60_000, acceptance: ['取证'], brief: '' },
    { id: 't-demo-2', title: '示例任务：汇总清单', state: 'done', owner: 'dev-b', node: 'pc-b',
      evidenceCount: 3, lifecycle: 'done', ackState: 'acked', updatedAt: Date.now() - 120_000, acceptance: [], brief: '' },
  ],
  events: [
    { task: 't-demo-1', at: Date.now() - 30_000, kind: 'task.claimed', node: 'dev-a', text: '示例事件正文', seq: 2 },
    { task: 't-demo-2', at: Date.now() - 90_000, kind: 'task.done', node: 'dev-b', text: '示例事件正文', seq: 1 },
  ],
  cached: false,
}

const BOARD_UNREACHABLE = {
  generatedAt: '2026-11-21T06:00:02.000Z',
  configured: true,
  source: { origin: BOARD_ORIGIN },
  health: null,
  tasks: [],
  events: [],
  cached: false,
  error: { code: 'timeout', message: '连共享板超时（4000ms）：' + BOARD_ORIGIN },
}

const PROBE_OK = {
  ok: true, action: 'probe-memory', url: MEMORY_ORIGIN + '/', origin: MEMORY_ORIGIN,
  status: 200, latencyMs: 12,
}

const PROBE_FAIL = {
  ok: false, action: 'probe-memory', code: 'memory-unreachable',
  reason: 'OpenViking 不可达（' + MEMORY_ORIGIN + '）：连接被拒绝（ECONNREFUSED）',
}

const REPORT_OK = {
  ok: true,
  action: 'latest-report',
  dir: 'C:\\Users\\ky614\\mesh-0.6-dev\\repo\\docs',
  dirLabel: 'docs',
  file: { name: REPORT_NAME, mtime: REPORT_MTIME, size: Buffer.byteLength(REPORT_TEXT) },
  content: REPORT_TEXT,
  truncated: false,
  readBytes: Buffer.byteLength(REPORT_TEXT),
}

const REPORT_FAIL = {
  ok: false, action: 'latest-report', code: 'reports-dir-missing',
  reason: '报告目录不存在：C:\\Users\\ky614\\mesh-0.6-dev\\repo\\docs',
}

/** Parent-window harness that answers the panel protocol like lib/client.js does. */
const HARNESS_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>panel harness</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style></head>
<body>
<iframe id="panelFrame" src="${ROUTE}/index.html" title="panel"></iframe>
<script>
window.addEventListener('message', function (event) {
  var frame = document.getElementById('panelFrame');
  if (!frame || event.source !== frame.contentWindow) return;
  var data = event.data;
  if (!data || data.type !== 'panel-action') return;
  var results = window.__harnessResults || {};
  var result = results[data.action] || { ok: false, code: 'unknown-action', reason: '桩宿主未定义动作 ' + data.action };
  event.source.postMessage(Object.assign({}, result, {
    type: 'panel-action-result', action: data.action, requestId: data.requestId, at: Date.now()
  }), event.origin || '*');
});
</script>
</body></html>`

/** Same harness, but the parent never answers: the page must report the timeout honestly. */
const HARNESS_SILENT_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>panel harness silent</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style></head>
<body><iframe id="panelFrame" src="${ROUTE}/index.html" title="panel"></iframe></body></html>`

const HARNESS_NEW_SESSION = {
  ok: true, code: 'session-requested',
  detail: '已调用 DSH 新会话入口（uiWorkspace.startSession，桩父窗口收到 panel-action）',
}
const HARNESS_DISPATCH = {
  ok: false, unsupported: true, code: 'mesh-tool-unavailable',
  reason: '面板不能直接调用 mesh_* 任务工具：mesh_dispatch 需要任务卡与会话目标，面板没有 agent 上下文。',
  hint: { action: 'dispatch-draft', label: '在新会话草稿里填入 mesh_dispatch 提示' },
}
const HARNESS_DRAFT = {
  ok: true, code: 'draft-opened',
  detail: '已打开 DSH 新会话，并在输入框填入 mesh_dispatch 提示草稿（草稿不会自动发送）',
}

const SCENARIOS = [
  {
    name: 'standalone-real',
    harness: null,
    board: BOARD_REAL,
    action: { kind: 'route', probe: PROBE_OK, report: REPORT_OK },
    expect: 'real',
    shot: 'shot-actions-01-standalone-real.png',
  },
  {
    name: 'standalone-unreachable',
    harness: null,
    board: { kind: 'json', body: BOARD_UNREACHABLE },
    action: { kind: 'route', probe: PROBE_FAIL, report: REPORT_FAIL },
    expect: 'unreachable',
    shot: 'shot-actions-02-standalone-unreachable.png',
  },
  {
    name: 'standalone-old-host',
    harness: null,
    board: BOARD_REAL,
    action: { kind: 'missing' },
    expect: 'old-host',
    shot: 'shot-actions-03-old-host.png',
  },
  {
    name: 'harness-client',
    harness: 'HARNESS_HTML',
    board: BOARD_REAL,
    action: { kind: 'route', probe: PROBE_OK, report: REPORT_OK },
    expect: 'client',
    shot: 'shot-actions-04-harness-client.png',
  },
  {
    name: 'harness-silent',
    harness: 'HARNESS_SILENT_HTML',
    board: BOARD_REAL,
    action: { kind: 'route', probe: PROBE_OK, report: REPORT_OK },
    expect: 'silent',
    shot: 'shot-actions-05-harness-silent.png',
  },
  {
    name: 'board-unconfigured',
    harness: null,
    board: { kind: 'json', body: { configured: false, generatedAt: '2026-11-21T06:00:03.000Z', source: null, health: null, tasks: [], events: [], cached: false,
      error: { code: 'board-not-configured', message: '未配置共享板' } } },
    action: { kind: 'route', probe: PROBE_OK, report: REPORT_OK },
    expect: 'unconfigured',
    shot: 'shot-actions-06-board-unconfigured.png',
  },
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
  return ok(String(actual || '').includes(needle), label, String(actual || '').slice(0, 140))
}

/* ───────────────────────── fixture 服务器 ───────────────────────── */
async function startFixtureServer() {
  const state = { scenario: SCENARIOS[0] }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (pathname === `${ROUTE}/index.html` || pathname === `${ROUTE}/`) {
      try {
        return send(200, 'text/html; charset=utf-8', await readFile(PAGE_FILE))
      } catch (error) {
        return send(500, 'text/plain', 'page read failed: ' + String((error && error.message) || error))
      }
    }
    if (pathname === '/harness.html') return send(200, 'text/html; charset=utf-8', HARNESS_HTML)
    if (pathname === '/harness-silent.html') return send(200, 'text/html; charset=utf-8', HARNESS_SILENT_HTML)
    if (pathname === `${ROUTE}/api/cluster`) {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(CLUSTER_REAL))
    }
    if (pathname === `${ROUTE}/api/host`) {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(HOST_REAL))
    }
    if (pathname === `${ROUTE}/api/board`) {
      const board = state.scenario.board
      const body = board && board.kind === 'json' ? board.body : BOARD_REAL
      return send(200, 'application/json; charset=utf-8', JSON.stringify(body))
    }
    if (pathname === `${ROUTE}/api/action`) {
      if (req.method !== 'POST') return send(405, 'application/json; charset=utf-8', JSON.stringify({ ok: false, code: 'method-not-allowed', reason: '只接受 POST' }))
      const action = state.scenario.action
      let chunks = ''
      for await (const chunk of req) chunks += chunk
      let requested = ''
      try { requested = JSON.parse(chunks).action } catch { /* 页面不会发坏 body */ }
      if (action.kind === 'missing') {
        // 老宿主真实行为：没有 exact handler，POST 落到 prefix resource 前就被
        // webserver 拒成 405，且响应体为空（没有 JSON 可以解析）。
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (requested === 'probe-memory') {
        return send(action.probe && action.probe.ok ? 200 : 200, 'application/json; charset=utf-8', JSON.stringify(action.probe))
      }
      if (requested === 'latest-report') {
        return send(200, 'application/json; charset=utf-8', JSON.stringify(action.report))
      }
      if (requested === 'open-reports-folder') {
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, action: 'open-reports-folder', dir: 'C:\\Users\\ky614\\mesh-0.6-dev\\repo\\docs', dirLabel: 'docs', detail: '已在资源管理器打开报告目录' }))
      }
      return send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, code: 'unknown-action', reason: '未知动作' }))
    }
    if (pathname === '/favicon.ico') return send(204, 'text/plain', '')
    return send(404, 'text/plain', 'not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${port}${ROUTE}/index.html`,
    harnessUrl: `http://127.0.0.1:${port}/harness.html`,
    silentHarnessUrl: `http://127.0.0.1:${port}/harness-silent.html`,
    useScenario(scenario) { state.scenario = scenario },
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.() }),
  }
}

/* ───────────────────────── 最小 CDP 客户端 ───────────────────────── */
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => existsSync(p))

async function pickPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) })
    } catch {
      return port // 端口空闲
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
    '--window-size=1440,1000',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
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

async function waitFor(evaluate, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch {
      /* 页面/iframe 还没就绪 */
    }
    await sleep(80)
  }
  return false
}

/**
 * 页面状态提取。`IN_FRAME` 为真时通过同源 contentDocument 读 harness 里的 iframe，
 * 否则读独立页面本身。
 */
function pageStateExpression(inFrame) {
  const docExpr = inFrame
    ? 'document.getElementById("panelFrame") && document.getElementById("panelFrame").contentDocument'
    : 'document'
  return `(() => {
    const doc = ${docExpr};
    if (!doc) return { ready: false };
    const text = sel => { const el = doc.querySelector(sel); return el ? el.textContent : ''; };
    const buttons = [...doc.querySelectorAll('#actionList .action')];
    // 占位行（.placeholder）不是回执：只取带状态徽章的 li
    const receipts = [...doc.querySelectorAll('#receiptList li')]
      .filter(li => li.querySelector('.r-state'))
      .map(li => ({
        time: (li.querySelector('.t') || {}).textContent || '',
        label: (li.querySelector('b') || {}).textContent || '',
        state: (li.querySelector('.r-state') || {}).textContent || '',
        text: (li.querySelector('.r-text') || {}).textContent || '',
        hint: (li.querySelector('.r-hint') || {}).textContent || '',
        hintAction: li.querySelector('.r-hint') ? li.querySelector('.r-hint').getAttribute('data-hint-action') : null,
        link: (li.querySelector('.r-link') || {}).href || ''
      }));
    return {
      ready: true,
      hint: {
        actions: text('#actions-h ~ .hint') || (doc.querySelector('#actions-h + .hint') || {}).textContent || '',
        foot: text('.panel-foot')
      },
      buttons: buttons.map(b => ({ label: (b.querySelector('b') || {}).textContent || '', disabled: b.disabled, action: b.getAttribute('data-action') })),
      disabledCount: buttons.filter(b => b.disabled).length,
      receipts,
      receiptCount: receipts.length,
      demoText: /\u6f14\u793a|\u672a\u53d1\u9001/.test(doc.body ? doc.body.textContent : ''),
      report: {
        visible: !!doc.getElementById('reportPanel') && !doc.getElementById('reportPanel').hidden,
        meta: text('#reportMeta'),
        content: text('#reportContent')
      },
      pageErrors: (window.__panelErrors || []).slice(0, 5),
      layout: { scrollWidth: doc.documentElement.scrollWidth, innerWidth: window.innerWidth }
    };
  })()`
}

/** Click one action inside the page/harness iframe. */
function clickExpression(inFrame, actionId) {
  const docExpr = inFrame
    ? 'document.getElementById("panelFrame") && document.getElementById("panelFrame").contentDocument'
    : 'document'
  return `(() => {
    const doc = ${docExpr};
    if (!doc) return 'no-doc';
    const button = doc.querySelector('#actionList [data-action="${actionId}"]');
    if (!button) return 'no-button';
    if (button.disabled) return 'disabled';
    button.click();
    return 'clicked';
  })()`
}

/** Click the secondary hint button carried by the newest receipt. */
function clickHintExpression(inFrame) {
  const docExpr = inFrame
    ? 'document.getElementById("panelFrame") && document.getElementById("panelFrame").contentDocument'
    : 'document'
  return `(() => {
    const doc = ${docExpr};
    if (!doc) return 'no-doc';
    const hint = doc.querySelector('#receiptList li .r-hint');
    if (!hint) return 'no-hint';
    hint.click();
    return 'clicked';
  })()`
}

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  if (!existsSync(PAGE_FILE)) throw new Error('找不到页面文件')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-panel-actions-' + Date.now())
  await mkdir(profileDir, { recursive: true })

  const site = await startFixtureServer()
  const port = await pickPort(9450)
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

    // 页面脚本之前挂错误钩子（每个 frame 都跑，含 harness 里的 iframe）
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__panelErrors=[];' +
        "addEventListener('error',e=>{try{window.__panelErrors.push('error: '+String(e.message||e))}catch(_){}});" +
        "addEventListener('unhandledrejection',e=>{try{window.__panelErrors.push('rejection: '+String(e.reason))}catch(_){}});",
    })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__harnessResults = ' + JSON.stringify({
        'new-session': HARNESS_NEW_SESSION,
        dispatch: HARNESS_DISPATCH,
        'dispatch-draft': HARNESS_DRAFT,
      }) + ';',
    })

    const requests = []
    browser.on('Network.requestWillBeSent', params => { requests.push(params.request.url) })
    const runtimeErrors = []
    browser.on('Runtime.exceptionThrown', params => {
      const details = params && params.exceptionDetails
      runtimeErrors.push(String((details && details.text) || 'exception').slice(0, 160))
    })
    browser.on('Log.entryAdded', params => {
      if (params && params.entry && params.entry.level === 'error' && params.entry.source !== 'network') {
        runtimeErrors.push('console: ' + String(params.entry.text || '').slice(0, 160))
      }
    })

    const evaluate = async expression => {
      const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails))
      return result.result ? result.result.value : undefined
    }
    const readPage = inFrame => evaluate(pageStateExpression(inFrame))

    /** Current browser targets (popups included). */
    const listTargets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
      .filter(t => t.type === 'page')
    const closeTarget = async id => { try { await fetch(`http://127.0.0.1:${port}/json/close/${id}`) } catch { /* ignore */ } }
    /** Wait for a target created after `beforeIds`; matching `origin` is preferred but not required. */
    async function waitForPopup(origin, beforeIds, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      let fresh = []
      while (Date.now() < deadline) {
        fresh = (await listTargets()).filter(t => !beforeIds.includes(t.id))
        const matched = fresh.filter(t => String(t.url || '').startsWith(origin))
        if (matched.length > 0) return { matched, fresh }
        if (fresh.length > 0) await sleep(150)
        else await sleep(120)
      }
      return { matched: fresh.filter(t => String(t.url || '').startsWith(origin)), fresh }
    }

    async function screenshot(name) {
      const dims = await evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
      const clip = { x: 0, y: 0, width: Math.max(1, dims.w), height: Math.max(1, dims.h), scale: 1 }
      const png = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip })
      await writeFile(path.join(OUT_DIR, name), Buffer.from(png.data, 'base64'))
      return 'tools/shots/' + name
    }

    async function openScenario(scenario) {
      site.useScenario(scenario)
      requests.length = 0
      runtimeErrors.length = 0
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
      const target = scenario.harness === 'HARNESS_HTML' ? site.harnessUrl
        : scenario.harness === 'HARNESS_SILENT_HTML' ? site.silentHarnessUrl
          : site.pageUrl
      const loaded = browser.once('Page.loadEventFired', 25_000)
      await browser.send('Page.navigate', { url: target })
      await loaded
      const inFrame = scenario.harness !== null
      const settled = await waitFor(
        evaluate,
        `(() => {
          const doc = ${inFrame ? 'document.getElementById("panelFrame") && document.getElementById("panelFrame").contentDocument' : 'document'};
          if (!doc) return false;
          const hint = (doc.querySelector('#recentHint') || {}).textContent || '';
          const os = (doc.querySelector('#osLine') || {}).textContent || '';
          const actions = doc.querySelectorAll('#actionList .action').length;
          return actions === 6 && hint !== '载入中…' && hint !== '' && os !== '载入中…' && os !== '';
        })()`,
        8000,
      )
      ok(settled, `${scenario.name}: 页面 6 个动作与三条数据源都就绪`)
      await sleep(120)
      return { inFrame, view: await readPage(inFrame) }
    }

    for (const scenario of SCENARIOS) {
      const { inFrame, view: initial } = await openScenario(scenario)
      report.scenarios.push({ name: scenario.name, initial })
      const view = () => readPage(inFrame)

      /* ---- 公共断言：6 按钮 / 只有重启禁用 / 无假回执字样 / 无 JS 报错 ---- */
      eq(initial.buttons.length, 6, `${scenario.name}: 6 个动作按钮`)
      eq(initial.buttons.map(b => b.action), ['new-session', 'dispatch', 'board', 'notes', 'latest-report', null], `${scenario.name}: 按钮顺序与 id`)
      eq(initial.disabledCount, 1, `${scenario.name}: 只有 1 个禁用按钮`)
      eq(initial.buttons[5].disabled, true, `${scenario.name}: 重启 DSH 保持禁用`)
      eq(initial.buttons[5].label, '重启 DSH', `${scenario.name}: 禁用按钮是重启 DSH`)
      eq(initial.demoText, false, `${scenario.name}: 页面没有「演示/未发送」字样`)
      eq(initial.receiptCount, 0, `${scenario.name}: 初始没有回执`)
      eq(initial.pageErrors, [], `${scenario.name}: 页面无 JS 报错`)
      ok(initial.layout.scrollWidth <= initial.layout.innerWidth, `${scenario.name}: 无横向溢出`)

      const external = requests.filter(url => url.startsWith('http') && !url.startsWith(site.baseUrl))
      eq(external, [], `${scenario.name}: 页面只发同源请求`)

      /* ---- 场景分支 ---- */
      if (scenario.expect === 'real') {
        /* ① 新会话：独立页没有父窗口 → 必须如实说「需要 DSH 客户端」 */
        await evaluate(clickExpression(inFrame, 'new-session'))
        await waitFor(evaluate, `(() => { const doc = document; const r = doc.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 4000)
        let state = await view()
        eq(state.receipts[0].state, '暂不支持', `${scenario.name}: 独立页新会话 → 暂不支持`)
        includes(state.receipts[0].text, '独立打开', `${scenario.name}: 新会话原因写明独立打开`)

        /* ② 派发任务：暂不支持 + 草稿替代（独立页也没有客户端） */
        await evaluate(clickExpression(inFrame, 'dispatch'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 4000)
        state = await view()
        eq(state.receipts[0].state, '暂不支持', `${scenario.name}: 派发任务 → 暂不支持`)
        includes(state.receipts[0].text, 'DSH 客户端', `${scenario.name}: 派发任务原因来自客户端不可用`)

        /* ③ 打开看板：真 origin 新标签页 */
        const beforeBoard = (await listTargets()).map(t => t.id)
        await evaluate(clickExpression(inFrame, 'board'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '成功', `${scenario.name}: 打开看板 → 成功`)
        includes(state.receipts[0].text, BOARD_ORIGIN, `${scenario.name}: 回执含真实板地址`)
        const boardPopup = await waitForPopup(BOARD_ORIGIN, beforeBoard)
        ok(boardPopup.matched.length > 0 || boardPopup.fresh.length > 0 || state.receipts[0].link !== '',
          `${scenario.name}: 看板真的打开了新窗口（或给出可点链接）`, JSON.stringify(boardPopup.fresh.map(t => t.url)))
        for (const popup of [...boardPopup.matched, ...boardPopup.fresh]) await closeTarget(popup.id)

        /* ④ 查记忆：宿主探测 ok → 打开 Studio */
        const beforeMemory = (await listTargets()).map(t => t.id)
        await evaluate(clickExpression(inFrame, 'notes'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '成功', `${scenario.name}: 查记忆 → 成功`)
        includes(state.receipts[0].text, MEMORY_ORIGIN, `${scenario.name}: 回执含 OpenViking 地址`)
        includes(state.receipts[0].text, 'ms', `${scenario.name}: 回执含探测延迟`)
        const memoryPopup = await waitForPopup(MEMORY_ORIGIN, beforeMemory)
        ok(memoryPopup.matched.length > 0 || memoryPopup.fresh.length > 0 || state.receipts[0].link !== '',
          `${scenario.name}: OpenViking 真的打开了新窗口（或给出可点链接）`, JSON.stringify(memoryPopup.fresh.map(t => t.url)))
        for (const popup of [...memoryPopup.matched, ...memoryPopup.fresh]) await closeTarget(popup.id)

        /* ⑤ 读最新报告：宿主内容出现在报告面板 */
        await evaluate(clickExpression(inFrame, 'latest-report'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '成功', `${scenario.name}: 读最新报告 → 成功`)
        includes(state.receipts[0].text, REPORT_NAME, `${scenario.name}: 回执含报告文件名`)
        eq(state.report.visible, true, `${scenario.name}: 报告预览面板可见`)
        includes(state.report.content, '报告正文 A', `${scenario.name}: 报告内容来自宿主返回`)
        includes(state.report.meta, REPORT_NAME, `${scenario.name}: 报告元信息含文件名`)
        eq(state.receipts[0].hintAction, 'open-reports-folder', `${scenario.name}: 报告回执带打开目录的二级动作`)

        /* ⑥ 二级动作：打开报告目录（fixture 返回 ok） */
        const clicked = await evaluate(clickHintExpression(inFrame))
        eq(clicked, 'clicked', `${scenario.name}: 回执里的二级动作可点`)
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '成功', `${scenario.name}: 打开报告目录 → 成功`)
        includes(state.receipts[0].text, '资源管理器', `${scenario.name}: 目录动作回执`)

        eq(state.receiptCount, 6, `${scenario.name}: 6 次点击留下 6 条回执`)
        eq(state.demoText, false, `${scenario.name}: 操作后仍无「演示/未发送」`)
        eq(state.pageErrors, [], `${scenario.name}: 操作后无 JS 报错`)
        const actionRequest = requests.filter(url => url.includes('/api/action'))
        ok(actionRequest.length >= 3, `${scenario.name}: 宿主路由被真实 POST（probe/report/folder）`,
          'action=' + actionRequest.length + ' 全部请求=' + requests.length + ' 尾部=' + requests.slice(-4).join(' | '))
      }

      if (scenario.expect === 'unreachable') {
        /* 板不可达：按钮仍可点，回执给出原因（不静默） */
        const boardButton = initial.buttons.find(b => b.action === 'board')
        ok(boardButton && boardButton.disabled === false, `${scenario.name}: 看板按钮不可达时仍可点`)
        await evaluate(clickExpression(inFrame, 'board'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        let state = await view()
        eq(state.receipts[0].state, '失败', `${scenario.name}: 看板不可达 → 失败`)
        includes(state.receipts[0].text, '共享板不可达', `${scenario.name}: 看板失败原因`)
        includes(state.receipts[0].text, 'timeout', `${scenario.name}: 看板失败带结构化原因`)

        /* OpenViking 探测失败：不打开新标签页，回执给原因 */
        const before = (await listTargets()).length
        await evaluate(clickExpression(inFrame, 'notes'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '失败', `${scenario.name}: OpenViking 不可达 → 失败`)
        includes(state.receipts[0].text, 'ECONNREFUSED', `${scenario.name}: OpenViking 失败原因`)
        eq((await listTargets()).length, before, `${scenario.name}: 不可达时没有打开新标签页`)

        /* 报告目录缺失：失败原因可读 */
        await evaluate(clickExpression(inFrame, 'latest-report'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '失败', `${scenario.name}: 报告缺失 → 失败`)
        includes(state.receipts[0].text, '报告目录不存在', `${scenario.name}: 报告失败原因`)
        eq(state.report.visible, false, `${scenario.name}: 失败时不显示空报告`)
      }

      if (scenario.expect === 'old-host') {
        /* 老宿主没有 api/action：失败必须点明「需重启 DSH」，不能装成功 */
        await evaluate(clickExpression(inFrame, 'latest-report'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        const state = await view()
        eq(state.receipts[0].state, '暂不支持', `${scenario.name}: 老宿主 → 暂不支持`)
        includes(state.receipts[0].text, '重启 DSH', `${scenario.name}: 老宿主原因写明需重启`)
        eq(state.report.visible, false, `${scenario.name}: 老宿主不显示假报告`)
      }

      if (scenario.expect === 'client') {
        /* 桩父窗口：新会话走 panel-action 协议并回执成功 */
        await evaluate(clickExpression(true, 'new-session'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        let state = await view()
        eq(state.receipts[0].state, '成功', `${scenario.name}: 新会话 → 成功（真实 client 协议）`)
        includes(state.receipts[0].text, 'startSession', `${scenario.name}: 回执点名真实 API`)

        /* 派发任务：暂不支持 + 草稿替代按钮 */
        await evaluate(clickExpression(true, 'dispatch'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '暂不支持', `${scenario.name}: 派发任务 → 暂不支持`)
        includes(state.receipts[0].text, 'mesh_dispatch', `${scenario.name}: 派发任务原因提到 mesh_dispatch`)
        eq(state.receipts[0].hintAction, 'dispatch-draft', `${scenario.name}: 派发任务给出草稿替代`)

        /* 点替代按钮：真的发出 dispatch-draft 动作 */
        eq(await evaluate(clickHintExpression(true)), 'clicked', `${scenario.name}: 草稿替代按钮可点`)
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        state = await view()
        eq(state.receipts[0].state, '成功', `${scenario.name}: 草稿替代 → 成功`)
        includes(state.receipts[0].text, '草稿', `${scenario.name}: 草稿回执`)
        eq(state.pageErrors, [], `${scenario.name}: 桩协议交互无 JS 报错`)
      }

      if (scenario.expect === 'silent') {
        /* 父窗口不回应：2.5 秒后如实「暂不支持：客户端没响应」，不能永远「进行中」 */
        await evaluate(clickExpression(true, 'new-session'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 6000)
        const state = await view()
        eq(state.receipts[0].state, '暂不支持', `${scenario.name}: 父窗口不回应 → 暂不支持`)
        includes(state.receipts[0].text, '2.5 秒', `${scenario.name}: 超时回执写明时限`)
        includes(state.receipts[0].text, '重启 DSH', `${scenario.name}: 超时回执点明 client.js 需重启`)
      }

      if (scenario.expect === 'unconfigured') {
        const boardButton = initial.buttons.find(b => b.action === 'board')
        ok(boardButton && boardButton.disabled === false, `${scenario.name}: 板未配置时按钮仍可点`)
        await evaluate(clickExpression(inFrame, 'board'))
        await waitFor(evaluate, `(() => { const r = document.querySelector('#receiptList li .r-state'); return !!r && r.textContent !== '进行中'; })()`, 5000)
        const state = await view()
        eq(state.receipts[0].state, '暂不支持', `${scenario.name}: 板未配置 → 暂不支持`)
        includes(state.receipts[0].text, '未配置', `${scenario.name}: 板未配置原因`)
      }

      /* ---- CDP 层异常 ---- */
      eq(runtimeErrors, [], `${scenario.name}: CDP 层无异常`)
      report.pageErrors.push(...runtimeErrors)
      if (scenario.shot) {
        const shot = await screenshot(scenario.shot)
        report.scenarios[report.scenarios.length - 1].shot = shot
      }
      process.stdout.write(`${scenario.name.padEnd(22)} receipts=${(await view()).receiptCount} ${scenario.shot ? 'shot=' + scenario.shot : ''}\n`)
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
  report.checks = { scenarios: SCENARIOS.length, assertionsPassed: passed, assertionsFailed: failures.length, pageErrors: report.pageErrors.length }
  report.ok = failures.length === 0
  await writeFile(path.join(OUT_DIR, 'cdp-actions-report.json'), JSON.stringify(report, null, 2), 'utf8')
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
    await writeFile(path.join(OUT_DIR, 'cdp-actions-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch { /* ignore */ }
  console.error('FAIL: ' + report.error)
  process.exitCode = 1
}
