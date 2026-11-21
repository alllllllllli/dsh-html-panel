#!/usr/bin/env node
/**
 * tools/cdp-live.mjs —— 用 Edge headless + CDP 验证页面真的消费 api/cluster（零依赖）。
 *
 * 用法（插件根目录）: node tools/cdp-live.mjs
 *
 * 做法：本脚本起一个**同源静态服务器**，`/dsh-html-panel/index.html` 直接读
 * `public/index.html`（就是被测页面本身），`/dsh-html-panel/api/cluster` 按场景返回
 * 可控 fixture；再用 Edge headless + DevTools 协议（Node 内置 WebSocket）打开页面断言。
 * 为什么不用 `msedge --screenshot`：本机 CLI 截图曾以退出码 13 失败；CDP 还能在页面
 * 脚本之前挂错误钩子、读 localStorage、量 scrollWidth。
 *
 * 场景（fixture 内容全部是假的，只为验证页面逻辑；真实链路状态要等 Host 路由生效后才有）：
 *   1. real-1440       self=pc-ky614，server up、s5 down、cloud down，mcloud 未配置
 *                     → 三态映射 + 「其它已配置对端」一行 + V4 交互回归 + 截图
 *   2. fallback-404    路由 404 → 保留 mock、badge 写明原因、无 JS 报错 + 截图
 *   3. real-900         900 宽：scrollWidth==innerWidth、拓扑不溢出 + 拓扑特写截图（2x）
 *   4. fallback-badjson 200 但不是 JSON → 兜底原因「响应不是 JSON」
 *   5. fallback-无服务   200 且 interconnect:false → 兜底原因「本实例没有 interconnect 服务」
 *   6. live-shape-1440  本机当前实测形状（4 对端全 down）→ 四槽位离线映射 + cloud 进「其它」
 *
 * 产物：tools/shots/shot-*.png 与 tools/shots/cdp-report.json（只写相对路径，不含本机路径）。
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

/* 假 fixture：页面逻辑只认契约，不认真实网络 */
const SELF = 'pc-ky614'
const REAL_FIXTURE = {
  generatedAt: '2026-11-21T04:20:00.000Z',
  interconnect: true,
  self: { instanceId: SELF },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'up' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
    { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'down' },
  ],
  board: null,
}
/* 本机 2026-11-21 实测形状：四个对端都在配置里、全部 down（VNT 未启动） */
const LIVE_SHAPE_FIXTURE = {
  generatedAt: '2026-11-21T04:30:00.000Z',
  interconnect: true,
  self: { instanceId: SELF },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'down' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
    { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'down' },
    { instanceId: 'mcloud', origin: '127.0.0.1:13086', link: 'down' },
  ],
  board: null,
}

const SCENARIOS = [
  {
    name: 'real-1440',
    width: 1440,
    height: 1000,
    fixture: { kind: 'json', body: REAL_FIXTURE },
    expect: 'real',
    shot: 'shot-01-live-data-1440.png',
    interactions: true,
    statuses: ['unknown', 'online', 'online', 'offline'],
    others: '其它已配置对端：cloud（down）',
    titleChecks: [
      { node: 0, contains: '未在 interconnect 配置' },
      { node: 1, contains: '本实例' },
      { node: 2, contains: '链路：up' },
      { node: 3, contains: '链路：down' },
    ],
  },
  {
    name: 'fallback-404-1440',
    width: 1440,
    height: 1000,
    fixture: { kind: 'missing' },
    expect: 'mock',
    shot: 'shot-02-mock-fallback-1440.png',
    statuses: ['online', 'online', 'online', 'offline'],
    reason: 'HTTP 404',
  },
  {
    name: 'real-900-topology',
    width: 900,
    height: 1000,
    fixture: { kind: 'json', body: REAL_FIXTURE },
    expect: 'real',
    shot: 'shot-03-narrow-900-topology.png',
    clip: '.topo-panel',
    statuses: ['unknown', 'online', 'online', 'offline'],
    others: '其它已配置对端：cloud（down）',
  },
  { name: 'fallback-badjson', width: 1440, height: 1000, fixture: { kind: 'badjson' }, expect: 'mock', statuses: ['online', 'online', 'online', 'offline'], reason: '响应不是 JSON' },
  {
    name: 'fallback-structure',
    width: 1440,
    height: 1000,
    fixture: { kind: 'json', body: { interconnect: true, self: { instanceId: 'pc-ky614' } } }, // 缺 peers
    expect: 'mock',
    statuses: ['online', 'online', 'online', 'offline'],
    reason: '结构不符',
  },
  {
    name: 'fallback-timeout',
    width: 1440,
    height: 1000,
    fixture: { kind: 'hang' }, // 服务端不响应；页面 3s 超时
    expect: 'mock',
    statuses: ['online', 'online', 'online', 'offline'],
    reason: '超时 3s',
  },
  {
    name: 'fallback-no-interconnect',
    width: 1440,
    height: 1000,
    fixture: { kind: 'json', body: { ...REAL_FIXTURE, interconnect: false, self: { instanceId: 'unknown' }, peers: [] } },
    expect: 'mock',
    statuses: ['online', 'online', 'online', 'offline'],
    reason: '本实例没有 interconnect 服务',
  },
  {
    name: 'live-shape-1440',
    width: 1440,
    height: 1000,
    fixture: { kind: 'json', body: LIVE_SHAPE_FIXTURE },
    expect: 'real',
    statuses: ['offline', 'online', 'offline', 'offline'],
    others: '其它已配置对端：cloud（down）',
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

/* ───────────────────────── 同源静态服务器 ───────────────────────── */
async function startFixtureServer() {
  const state = { fixture: { kind: 'missing' }, hanging: new Set() }
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
    if (pathname === `${ROUTE}/api/cluster`) {
      const fixture = state.fixture
      if (fixture.kind === 'missing') {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end('not found')
      } else if (fixture.kind === 'badjson') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{definitely not json')
      } else if (fixture.kind === 'hang') {
        // 故意不回包：验证页面自己的 3s 超时兜底
        state.hanging.add(res)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.flushHeaders?.()
        res.on('close', () => state.hanging.delete(res))
      } else {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(fixture.body))
      }
      return
    }
    if (pathname === '/favicon.ico') {
      // 只为消掉浏览器自己请求 favicon 的 404 噪音，与页面无关
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
    setFixture(fixture) { state.fixture = fixture },
    close: () => new Promise(done => {
      // 先销毁挂起的连接（超时场景故意不回包），否则 close() 会一直等它们
      for (const res of state.hanging) {
        try { res.destroy() } catch { /* 已断开 */ }
      }
      state.hanging.clear()
      server.close(done)
      server.closeAllConnections?.()
    }),
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

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  if (!existsSync(PAGE_FILE)) throw new Error('找不到页面文件')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-panel-live-' + Date.now())
  await mkdir(profileDir, { recursive: true })

  const site = await startFixtureServer()
  const port = await pickPort(9341)
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
        "addEventListener('unhandledrejection',e=>{try{window.__panelErrors.push('rejection: '+String(e.reason))}catch(_){}});",
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
      // （api/cluster 404 → mock 兜底），页面处理了，不算 JS 报错。
      if (params && params.entry && params.entry.level === 'error' && params.entry.source !== 'network') {
        runtimeErrors.push('console: ' + String(params.entry.text || '').slice(0, 160))
      }
    })

    const evaluate = async expression => {
      const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails))
      return result.result ? result.result.value : undefined
    }

    for (const scenario of SCENARIOS) {
      site.setFixture(scenario.fixture)
      requests.length = 0
      runtimeErrors.length = 0
      await browser.send('Emulation.setDeviceMetricsOverride', {
        width: scenario.width,
        height: scenario.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const loaded = browser.once('Page.loadEventFired', 25_000)
      await browser.send('Page.navigate', { url: site.pageUrl })
      await loaded
      // 等 fetch 出结果：badge 离开 loading 状态（最多 5s；页面自身超时 3s）
      const terminal = await waitFor(evaluate,
        "document.querySelector('#topoSource') && document.querySelector('#topoSource').getAttribute('data-state') !== 'loading'",
        6000)
      ok(terminal, `${scenario.name}: badge 离开 loading 状态`)
      await sleep(120)
      await evaluate('window.scrollTo(0,0)')

      const view = await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('#topoNodes > g')];
        const rects = [...document.querySelectorAll('#topoNodes .node-rect')].map(r => r.getAttribute('class'));
        const titles = [...document.querySelectorAll('#topoNodes .node title')].map(t => t.textContent);
        const badge = document.querySelector('#topoSource');
        const svg = document.querySelector('.topo');
        const panel = document.querySelector('.topo-panel');
        return {
          badgeState: badge ? badge.getAttribute('data-state') : null,
          badgeText: (document.querySelector('#topoSourceText') || {}).textContent || '',
          badgeStamp: (document.querySelector('#topoStamp') || {}).textContent || '',
          rects, titles,
          nodes: document.querySelectorAll('#topoNodes .node').length,
          pending: document.querySelectorAll('#topoNodes .pending').length,
          edges: document.querySelectorAll('#topoEdges > line').length,
          others: (document.querySelector('#topoOthers') || {}).textContent || '',
          othersHidden: !!(document.querySelector('#topoOthers') || {}).hidden,
          svgTitle: (document.querySelector('#topoTitle') || {}).textContent || '',
          svgWidth: svg ? svg.getBoundingClientRect().width : 0,
          panelClientW: panel ? panel.clientWidth : 0,
          panelScrollW: panel ? panel.scrollWidth : 0,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          panelErrors: (window.__panelErrors || []).slice(0, 5),
        };
      })()`)

      report.scenarios.push({ name: scenario.name, viewport: [scenario.width, scenario.height], view })

      /* ---- 每个场景都成立的：4 节点 + 1 待接入 + 5 边、无报错、无横向溢出 ---- */
      eq(view.nodes, 4, `${scenario.name}: 4 个节点`)
      eq(view.pending, 1, `${scenario.name}: 1 个待接入空心圆`)
      eq(view.edges, 5, `${scenario.name}: 5 条边`)
      eq(view.rects.map(c => c.replace('node-rect ', '')), scenario.statuses, `${scenario.name}: 节点状态映射`)
      eq(view.panelErrors, [], `${scenario.name}: 页面无 JS 报错`)
      ok(view.scrollWidth <= view.innerWidth, `${scenario.name}: 无横向溢出`, `scrollWidth=${view.scrollWidth} innerWidth=${view.innerWidth}`)

      /* ---- 真实数据场景 ---- */
      if (scenario.expect === 'real') {
        eq(view.badgeState, 'real', `${scenario.name}: badge=real`)
        eq(view.badgeText, '真实 · interconnect', `${scenario.name}: badge 文案`)
        ok(/^生成 \d{2}:\d{2}:\d{2}$/.test(view.badgeStamp), `${scenario.name}: badge 带生成时间`, view.badgeStamp)
        ok(view.svgTitle.includes('真实 interconnect'), `${scenario.name}: SVG title 标真实`, view.svgTitle)
        for (const item of scenario.titleChecks || []) {
          ok((view.titles[item.node] || '').includes(item.contains),
            `${scenario.name}: 第 ${item.node} 个节点 title 含「${item.contains}」`, view.titles[item.node])
        }
        for (const title of view.titles) {
          ok(!title.includes('心跳'), `${scenario.name}: 节点 title 不含心跳`, title.slice(0, 60))
        }
      }

      /* ---- mock 兜底场景 ---- */
      if (scenario.expect === 'mock') {
        eq(view.badgeState, 'mock', `${scenario.name}: badge=mock`)
        ok(view.badgeText.startsWith('mock 兜底 · 真实数据不可用：'), `${scenario.name}: badge 文案`, view.badgeText)
        ok(view.badgeText.includes(scenario.reason), `${scenario.name}: badge 写明原因「${scenario.reason}」`, view.badgeText)
        eq(view.badgeStamp, '', `${scenario.name}: mock 时不显示真实生成时间`)
        ok(view.svgTitle.includes('mock 兜底'), `${scenario.name}: SVG title 标 mock`, view.svgTitle)
        ok(view.titles.every(t => t.includes('mock 示例')), `${scenario.name}: 节点 title 标 mock 示例`)
      }

      /* ---- 「其它已配置对端」一行 ---- */
      if (scenario.others) {
        eq(view.othersHidden, false, `${scenario.name}: 其它对端一行可见`)
        eq(view.others, scenario.others, `${scenario.name}: 其它对端文案`)
      } else {
        eq(view.othersHidden, true, `${scenario.name}: 没有其它对端时该行隐藏`)
      }

      /* ---- 网络：只允许同源请求 ---- */
      const external = requests.filter(url => !url.startsWith(site.baseUrl))
      eq(external, [], `${scenario.name}: 只有同源请求`)

      /* ---- 300px 窄宽（900 场景）：拓扑面板自己也不许溢出 ---- */
      if (scenario.width === 900) {
        ok(view.scrollWidth <= view.innerWidth, `${scenario.name}: scrollWidth==innerWidth`, `${view.scrollWidth}/${view.innerWidth}`)
        ok(view.panelScrollW <= view.panelClientW + 1, `${scenario.name}: 拓扑面板无溢出`, `${view.panelScrollW}/${view.panelClientW}`)
        ok(view.svgWidth <= view.panelClientW + 1, `${scenario.name}: SVG 不超面板宽`, `${view.svgWidth}/${view.panelClientW}`)
      }

      /* ---- 截图（在交互回归之前：页面还是初始状态，没有 toast 残影） ---- */
      if (scenario.shot) {
        let clip
        if (scenario.clip) {
          const rect = await evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(scenario.clip)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
          })()`)
          if (!rect) throw new Error('clip selector not found: ' + scenario.clip)
          clip = { x: Math.max(0, Math.round(rect.x) - 8), y: Math.max(0, Math.round(rect.y) - 8), width: Math.round(rect.w) + 16, height: Math.round(rect.h) + 16, scale: 2 }
        } else {
          const dims = await evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
          clip = { x: 0, y: 0, width: dims.w, height: dims.h, scale: 1 }
        }
        const png = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip })
        await writeFile(path.join(OUT_DIR, scenario.shot), Buffer.from(png.data, 'base64'))
        report.scenarios[report.scenarios.length - 1].shot = 'tools/shots/' + scenario.shot
        report.scenarios[report.scenarios.length - 1].clip = clip
      }

      /* ---- V4 交互回归（只在 real-1440 做一次） ---- */
      if (scenario.interactions) {
        const clock1 = await evaluate("document.querySelector('#clock').textContent")
        await sleep(1150)
        const clock2 = await evaluate("document.querySelector('#clock').textContent")
        ok(clock1 !== clock2, 'V4: 时钟走秒', `${clock1} -> ${clock2}`)

        const interact = await evaluate(`(() => {
          const out = {};
          document.querySelector('#actionList [data-action]').click();
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
          document.querySelector('#tab-docs').click();
          out.docTabOpen = document.querySelector('#panel-docs').hidden === false;
          out.docRows = document.querySelectorAll('#docList .item').length;
          out.taskRows = document.querySelectorAll('#taskList .item').length;
          out.actionCount = document.querySelectorAll('#actionList .action').length;
          out.disabledRestart = !!document.querySelector('#actionList .action[disabled]');
          out.todoCount = document.querySelectorAll('#todoList .todo').length;
          return out;
        })()`)
        report.scenarios[report.scenarios.length - 1].interactions = interact
        ok(interact.receipts >= 1 && String(interact.receiptText).includes('演示回执'), 'V4: 动作回执出现')
        ok(interact.storeHasItems && interact.checkedPersisted, 'V4: 待办勾选写入 localStorage')
        ok(interact.docTabOpen && interact.docRows === 5 && interact.taskRows === 6, 'V4: 标签页切换与列表完整')
        eq(interact.actionCount, 6, 'V4: 常用动作 6 个')
        ok(interact.disabledRestart, 'V4: 重启按钮仍禁用')
        ok(interact.todoCount > 0, 'V4: 待办列表非空')
      }

      /* ---- 运行时异常（挂在 CDP 层，不只靠页面内 hook） ---- */
      eq(runtimeErrors, [], `${scenario.name}: CDP 层无异常`)
      report.pageErrors.push(...runtimeErrors)

      process.stdout.write(
        `${scenario.name.padEnd(26)} badge=${String(view.badgeState).padEnd(4)} nodes=${view.nodes} edges=${view.edges} ` +
        `statuses=${scenario.statuses.join(',')} ${scenario.shot ? 'shot=' + scenario.shot : ''}\n`,
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

try {
  await main()
  report.checks = { scenarios: SCENARIOS.length, assertionsPassed: passed, assertionsFailed: failures.length, pageErrors: report.pageErrors.length }
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
