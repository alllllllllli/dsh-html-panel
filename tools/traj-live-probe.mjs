#!/usr/bin/env node
/**
 * 真机探针（0.9.8 轨迹视图）：在无头 Edge 里打开**运行中的 DSH 面板**（不是 fixture），
 * 点「轨迹」tab，抓 DOM 事实 + 两张截图 + 页面 JS 报错。
 *
 * 用法: node traj-live-probe.mjs [origin]
 *   例: node traj-live-probe.mjs http://127.0.0.1:52844
 * 产物: traj-live-1440.png / traj-live-1000.png（同目录）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = (process.argv[2] || 'http://127.0.0.1:52844').replace(/\/+$/, '')
const PAGE_URL = ORIGIN + '/dsh-html-panel/index.html'
const OUT = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(done => setTimeout(done, ms))
const log = (...args) => console.log(...args)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => existsSync(p))
if (!EDGE) throw new Error('找不到 msedge.exe')

async function pickPort(start) {
  for (let port = start; port < start + 40; port += 1) {
    try { await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) }) }
    catch { return port }
  }
  throw new Error('no free CDP port')
}

async function launchEdge(port, profileDir, width, height) {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-component-update',
    '--force-device-scale-factor=1',
    '--window-size=' + width + ',' + height,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    'about:blank'
  ], { stdio: 'ignore' })
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    try {
      const info = await (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) })).json()
      if (info && info.webSocketDebuggerUrl) return child
    } catch { /* still booting */ }
    await sleep(250)
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
    let msg = null
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error('CDP ' + JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    if (msg.method && handlers.has(msg.method)) for (const fn of handlers.get(msg.method)) { try { fn(msg.params) } catch { /* obs */ } }
  })
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true })
    ws.addEventListener('error', e => rej(new Error('ws error ' + String((e && e.message) || e))), { once: true })
  })
  function send(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 25000)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) }
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { ws, opened, send, on: (method, fn) => handlers.set(method, [...(handlers.get(method) || []), fn]) }
}

async function probe(browser, expression) {
  const out = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (out && out.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(out.exceptionDetails).slice(0, 400))
  return out && out.result ? out.result.value : undefined
}

async function waitFor(browser, expression, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 10000)
  while (Date.now() < deadline) {
    try { if (await probe(browser, expression)) return true } catch { /* 页面还在导航 */ }
    await sleep(120)
  }
  throw new Error('timeout waiting: ' + (label || expression))
}

async function setViewport(browser, width, height) {
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(200)
}

async function shot(browser, name) {
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length < 20000) throw new Error('截图疑似空白: ' + name + ' ' + buffer.length + ' bytes')
  const file = path.join(OUT, name)
  await writeFile(file, buffer)
  log('  截图 ' + file + ' (' + buffer.length + ' B)')
  return file
}

/** 真实指针点击（Input.dispatchMouseEvent），不是 DOM .click()。 */
async function realClick(browser, selector) {
  const point = await probe(browser, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)
  if (!point) throw new Error('realClick target missing: ' + selector)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(250)
}

const PORT = await pickPort(9700 + Math.floor(Math.random() * 200))
const PROFILE = path.join(os.tmpdir(), 'traj-live-probe-' + Date.now())
await mkdir(PROFILE, { recursive: true })

const facts = { page: PAGE_URL, facts: {}, checks: [], consoleErrors: [], screenshot: [] }
const check = (name, ok, detail = '') => {
  facts.checks.push({ name, ok: !!ok, detail: String(detail) })
  log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''))
}

log('=== 目标: ' + PAGE_URL + ' ===')
const child = await launchEdge(PORT, PROFILE, 1440, 1000)
let browser = null
try {
  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
  const page = targets.find(t => t.type === 'page')
  if (!page) throw new Error('no page target')
  browser = connect(page.webSocketDebuggerUrl)
  await browser.opened
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await browser.send(domain + '.enable')

  const runtimeErrors = []
  browser.on('Runtime.exceptionThrown', params => {
    const detail = params && params.exceptionDetails
      ? (params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text)
      : 'exception'
    runtimeErrors.push(String(detail).slice(0, 300))
  })
  browser.on('Runtime.consoleAPICalled', params => {
    if (params && (params.type === 'error' || params.type === 'warning')) {
      facts.consoleErrors.push(params.type + ' ' + (params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 300))
    }
  })
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__panelErrors=[];' +
      'addEventListener("error",e=>{try{window.__panelErrors.push("error: "+String(e.message||e))}catch(_){}});' +
      'addEventListener("unhandledrejection",e=>{try{window.__panelErrors.push("rejection: "+String(e.reason))}catch(_){}});'
  })

  await setViewport(browser, 1440, 1000)
  await browser.send('Page.navigate', { url: PAGE_URL })
  await waitFor(browser, 'document.readyState === "complete"', 10000, 'readyState')
  await waitFor(browser, '!!document.body && !!document.getElementById("page-butler")', 10000, 'page boot')
  await waitFor(browser, 'document.body.dataset.dialog && document.body.dataset.dialog !== "loading"', 15000, 'dialog settled')
  await sleep(800)

  facts.facts.before = await probe(browser, `(() => {
    const q = s => document.querySelector(s);
    return {
      href: location.href,
      sfVer: (q('#sfVer') || {}).textContent || '',
      setVersion: (q('#setVersion') || {}).textContent || '',
      dialogueVisible: q('#traceDialogue') ? !q('#traceDialogue').hidden : null,
      trajHidden: q('#traceTrajectory') ? q('#traceTrajectory').hidden : null,
      trajText: (q('#traceTrajectory') || {}).textContent || '',
      dialogMsgs: document.querySelectorAll('#dialogList .msg').length,
      toolCards: document.querySelectorAll('#dialogList .tcard').length,
      streamBadge: (q('#dlgStreamBadge') || {}).textContent || '',
      panelErrors: (window.__panelErrors || []).slice()
    };
  })()`)
  log('--- A) 初始状态（对话 tab） ---')
  log(JSON.stringify(facts.facts.before, null, 2))

  check('页面服务的是 0.9.8（#sfVer）', /v0\.9\.8/.test(facts.facts.before.sfVer), facts.facts.before.sfVer)
  check('初始在对话 tab（轨迹容器隐藏）', facts.facts.before.dialogueVisible === true && facts.facts.before.trajHidden === true)

  log('--- B) 真实指针点「轨迹」tab ---')
  await realClick(browser, '#tab-trajectory')
  await waitFor(browser, `(() => {
    const el = document.getElementById('traceTrajectory');
    const groups = document.getElementById('trajGroups');
    return !!el && !el.hidden && !!groups && !groups.hidden && groups.querySelectorAll('.tj-item').length > 0;
  })()`, 8000, 'trajectory rendered')
  await sleep(300)

  facts.facts.traj = await probe(browser, `(() => {
    const q = s => document.querySelector(s);
    const qa = s => Array.from(document.querySelectorAll(s));
    const txt = s => { const el = q(s); return el ? el.textContent.trim() : ''; };
    const scr = document.getElementById('thread');
    return {
      visible: q('#traceTrajectory') ? !q('#traceTrajectory').hidden : false,
      dialogueHidden: q('#traceDialogue') ? q('#traceDialogue').hidden : null,
      tabActive: (q('#tab-trajectory') || {}).getAttribute ? q('#tab-trajectory').getAttribute('aria-selected') : null,
      badge: txt('#trajBadgeText'),
      badgeHidden: q('#trajBadge') ? q('#trajBadge').hidden : null,
      stats: txt('#trajStats'),
      statsHidden: q('#trajStats') ? q('#trajStats').hidden : null,
      note: txt('#trajNote'),
      noteHidden: q('#trajNote') ? q('#trajNote').hidden : null,
      empty: q('#trajEmpty') ? !q('#trajEmpty').hidden : null,
      emptyText: txt('#trajEmpty'),
      groups: qa('#trajGroups .tj-group').length,
      heads: qa('#trajGroups .tj-gh b').map(el => el.textContent.trim()),
      items: qa('#trajGroups .tj-item').length,
      users: qa('#trajGroups .tj-item .tj-k').filter(el => el.textContent.trim() === '你').length,
      steps: qa('#trajGroups .tj-item .tj-k').filter(el => /步骤|助手步骤/.test(el.textContent)).length,
      notices: qa('#trajGroups .tj-item .tj-k').filter(el => el.textContent.trim() === '注入').length,
      toolNames: qa('#trajGroups .tj-k.tool-name').map(el => el.textContent.trim()),
      toolStates: qa('#trajGroups .tj-item .r-state').map(el => el.textContent.trim()),
      thinks: qa('#trajGroups .think').length,
      failItems: qa('#trajGroups .tj-item.fail').length,
      text: (q('#traceTrajectory') || {}).textContent || '',
      textLen: ((q('#traceTrajectory') || {}).textContent || '').length,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      threadScrollTop: scr ? Math.round(scr.scrollTop) : null,
      panelErrors: (window.__panelErrors || []).slice()
    };
  })()`)
  log('--- C) 轨迹 tab DOM 事实 ---')
  log(JSON.stringify(facts.facts.traj, null, 2))

  const t = facts.facts.traj
  check('点轨迹 tab 后轨迹容器可见、对话容器隐藏', t.visible === true && t.dialogueHidden === true)
  check('轨迹里没有「M2 未接入」占位', !t.text.includes('M2 未接入'), t.text.slice(0, 60))
  check('轨迹渲染出真实条目（>0）', t.items > 0, 'items=' + t.items)
  check('轨迹有轮/段分组标题', t.groups > 0 && t.heads.length > 0, 'groups=' + t.groups + ' heads=' + t.heads.join('/'))
  check('轨迹统计行是真实计数', /共\s*\d+\s*[轮段]/.test(t.stats) && /次工具调用/.test(t.stats), t.stats)
  check('轨迹条目含真实工具名', t.toolNames.length > 0, t.toolNames.join(','))
  check('轨迹工具条目带状态徽标', t.toolStates.length > 0, t.toolStates.join(','))
  check('轨迹数据源写明 api/butler/dialog 真实事件', t.badge.includes('api/butler/dialog'), t.badge)
  check('1440 无横向溢出', t.overflowX <= 1, 'overflowX=' + t.overflowX)
  // 降级说明：只有真缺 turn/step 时才允许显示；完整数据下必须不显示（不伪造降级）。
  const statsHasTurns = /共\s*(\d+)\s*轮/.test(t.stats) && !/共\s*\d+\s*段/.test(t.stats)
  check('降级说明与数据一致（有 turn 就不谎报降级）', statsHasTurns ? t.noteHidden === true : t.note.includes('数据降级'), 'note=' + JSON.stringify(t.note))
  check('轨迹 tab 下页面 JS 报错 0', t.panelErrors.length === 0, JSON.stringify(t.panelErrors).slice(0, 200))
  // 布局几何：工具条目的两行必须在同一张卡内、不重叠（0.9.8 首次截图曾出现行重叠）
  facts.facts.geo = await probe(browser, `(() => {
    const li = document.querySelector('#trajGroups .tj-item.tj-tool');
    if (!li) return null;
    const summary = li.querySelector('summary');
    const rows = Array.from(summary.querySelectorAll(':scope > .tj-row'));
    const rect = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width) }; };
    return {
      li: rect(li),
      summary: rect(summary),
      summaryDisplay: getComputedStyle(summary).display,
      rows: rows.map(row => ({ cls: row.className, display: getComputedStyle(row).display, rect: rect(row) })),
      detailsOpen: li.querySelector('details').open,
      liScrollH: li.scrollHeight,
      liClientH: li.clientHeight,
      html: li.outerHTML.slice(0, 900)
    };
  })()`)
  log('--- C2) 工具条目几何 ---')
  log(JSON.stringify(facts.facts.geo, null, 2))
  const geo = facts.facts.geo
  check('工具条目两行都在卡内且不重叠（卡宽正常，未被 .tool 压扁）', !!geo && geo.rows.length === 2 && geo.li.w > 200 &&
    geo.li.h >= geo.rows[1].rect.top + geo.rows[1].rect.h - geo.li.top - 1 &&
    geo.summaryDisplay === 'block' && geo.rows.every(row => row.display === 'flex'), JSON.stringify(geo && { li: geo.li, summary: geo.summary, rows: geo.rows.map(r => ({ d: r.display, r: r.rect })) }))
  await shot(browser, 'traj-live-1440.png')

  log('--- D) 1000x780（面板 iframe 实际尺寸） ---')
  await setViewport(browser, 1000, 780)
  await sleep(400)
  // 回到顶部看统计行与第一轮
  await probe(browser, '(() => { const el = document.getElementById("thread"); if (el) el.scrollTop = 0; return true; })()')
  await sleep(200)
  facts.facts.traj1000 = await probe(browser, `(() => {
    const q = s => document.querySelector(s);
    const stats = q('#trajStats');
    const r = stats ? stats.getBoundingClientRect() : null;
    return {
      visible: q('#traceTrajectory') ? !q('#traceTrajectory').hidden : false,
      statsText: stats ? stats.textContent.trim() : '',
      statsRect: r ? { top: Math.round(r.top), height: Math.round(r.height), right: Math.round(r.right), clipped: r.right > window.innerWidth + 1 } : null,
      items: document.querySelectorAll('#trajGroups .tj-item').length,
      groups: document.querySelectorAll('#trajGroups .tj-group').length,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panelErrors: (window.__panelErrors || []).slice()
    };
  })()`)
  log(JSON.stringify(facts.facts.traj1000, null, 2))
  check('1000x780 轨迹仍可见且有条目', facts.facts.traj1000.visible === true && facts.facts.traj1000.items > 0, 'items=' + facts.facts.traj1000.items)
  check('1000x780 统计行未被裁出视口', facts.facts.traj1000.statsRect && facts.facts.traj1000.statsRect.clipped === false, JSON.stringify(facts.facts.traj1000.statsRect))
  check('1000x780 无横向溢出', facts.facts.traj1000.overflowX <= 1, 'overflowX=' + facts.facts.traj1000.overflowX)
  check('1000x780 页面 JS 报错 0', facts.facts.traj1000.panelErrors.length === 0, JSON.stringify(facts.facts.traj1000.panelErrors).slice(0, 200))
  await shot(browser, 'traj-live-1000.png')

  log('--- E) 切回「对话」tab ---')
  await realClick(browser, '#tab-dialogue')
  await waitFor(browser, '(() => { const el = document.getElementById("traceDialogue"); return !!el && !el.hidden; })()', 6000, 'dialogue back')
  facts.facts.back = await probe(browser, `(() => {
    const q = s => document.querySelector(s);
    return {
      dialogueVisible: q('#traceDialogue') ? !q('#traceDialogue').hidden : null,
      trajHidden: q('#traceTrajectory') ? q('#traceTrajectory').hidden : null,
      dialogMsgs: document.querySelectorAll('#dialogList .msg').length,
      toolCards: document.querySelectorAll('#dialogList .tcard').length,
      streamBadge: (q('#dlgStreamBadge') || {}).textContent || '',
      panelErrors: (window.__panelErrors || []).slice()
    };
  })()`)
  log(JSON.stringify(facts.facts.back, null, 2))
  check('切回对话 tab 正常（对话可见 / 轨迹隐藏 / 消息仍在）', facts.facts.back.dialogueVisible === true && facts.facts.back.trajHidden === true && facts.facts.back.dialogMsgs > 0, JSON.stringify({ msgs: facts.facts.back.dialogMsgs, tools: facts.facts.back.toolCards }))

  facts.facts.runtimeErrors = runtimeErrors
  check('CDP 运行时异常 0', runtimeErrors.length === 0, JSON.stringify(runtimeErrors).slice(0, 300))
  check('页面 console error/warning 0', facts.consoleErrors.length === 0, JSON.stringify(facts.consoleErrors).slice(0, 300))
  check('页面 onerror/unhandledrejection 0', (facts.facts.back.panelErrors || []).length === 0, JSON.stringify(facts.facts.back.panelErrors).slice(0, 300))
} finally {
  try { if (browser) browser.ws.close() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  await sleep(500)
  try { await rm(PROFILE, { recursive: true, force: true }) } catch { /* ignore */ }
}

const failed = facts.checks.filter(c => !c.ok)
await writeFile(path.join(OUT, 'traj-live-facts.json'), JSON.stringify({ ...facts, ok: failed.length === 0, failed: failed.length }, null, 2), 'utf8')
log('')
log('=== 结果: ' + (facts.checks.length - failed.length) + '/' + facts.checks.length + (failed.length ? ' FAIL' : ' PASS') + ' ===')
log('事实 JSON: ' + path.join(OUT, 'traj-live-facts.json'))
process.exit(failed.length === 0 ? 0 : 1)
