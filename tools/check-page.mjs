#!/usr/bin/env node
/**
 * tools/check-page.mjs —— `public/index.html` 的静态自检（零依赖，Node 18+）。
 *
 * 用法: node tools/check-page.mjs [页面文件] [--json <输出文件>]
 *       默认页面是本包的 public/index.html。
 *
 * 本轮（v6，页面接三条真实数据源）新增的检查：
 *   - `fetch()` 仍只允许**同源相对路径**：页面通过 fetchJson('api/...') 读
 *     api/cluster、api/board、api/host，三者缺一不可；任何带 scheme / `//` 的地址失败；
 *   - 顶栏不许再出现假值：`DSH 0.4.0`、`127.0.0.1:13090`、`共享板 13090` 一律失败；
 *   - 「最近文档」已改成「事件流」：docList / tab-docs 残留失败；
 *   - 五态（leased/awaiting/undelivered/stale/done）的 CSS 类与 JS 映射都在；
 *   - mock 兜底 / 数据过期 / 30 秒轮询 / 页面隐藏跳过 等行为字符串在；
 *   - 本机小部件与三个顶栏 chip 的落点 id 齐全。
 * 检查项任一失败退出码 1。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const self = fileURLToPath(import.meta.url)
const defaultPage = resolve(dirname(self), '..', 'public', 'index.html')
const jsonIndex = args.indexOf('--json')
const jsonAt = jsonIndex >= 0 ? args[jsonIndex + 1] : null
// `--json <path>` 的值不是位置参数
const positional = args.filter((a, i) => !a.startsWith('--') && i !== jsonIndex + 1)
const target = positional[0] ?? defaultPage

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
}

const abs = resolve(target)
let html = ''
try {
  const buf = await readFile(abs)
  check('文件存在且非空', buf.length > 0, buf.length + ' B')
  check('无 UTF-8 BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), '前 3 字节 ' + buf.slice(0, 3).toString('hex'))
  html = buf.toString('utf8')
} catch (error) {
  check('文件可读', false, String((error && error.message) || error))
}
const bytes = Buffer.byteLength(html, 'utf8')
const sha256 = createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex')

/* ---------- 1. 文档基本形态 ---------- */
check('DOCTYPE 在前', /^\s*<!DOCTYPE html>/i.test(html))
check('charset=utf-8', /<meta charset="utf-8">/i.test(html))
check('lang=zh-CN', /<html lang="zh-CN">/i.test(html))

/* ---------- 2. 禁止外部引用（同源相对 fetch 除外） ---------- */
const externalRules = [
  ['http(s):// 绝对地址', /https?:\/\//i],
  ['协议相对地址 src="//"', /(?:src|href)\s*=\s*["']\s*\/\//i],
  ['<link> 标签', /<link\b/i],
  ['@import', /@import/i],
  ['<script src>', /<script\b[^>]*\bsrc\s*=/i],
  ['<img src>', /<img\b[^>]*\bsrc\s*=/i],
  ['<iframe>', /<iframe\b/i],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bnew\s+WebSocket\b/],
  ['importScripts', /\bimportScripts\s*\(/],
]
for (const [name, re] of externalRules) {
  const hit = re.exec(html)
  check('无外部引用：' + name, !hit, hit ? '命中：' + String(hit[0]).slice(0, 40) : '')
}
const urlCalls = [...html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map(m => m[1].trim())
const badUrls = urlCalls.filter(u => !/^data:/i.test(u) && u !== '')
check('无外链 url()', badUrls.length === 0, badUrls.join(' | ') || '共 ' + urlCalls.length + ' 个 url()，均为空或 data:')
const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)].map(m => m[1])
const badHrefs = hrefs.filter(h => !h.startsWith('#') && !/^data:/i.test(h))
check('href 仅站内锚点', badHrefs.length === 0, badHrefs.join(' | ') || hrefs.join(' | ') || '无 href')

/* ---------- 3. fetch 只允许同源相对路径；三个 api 路由都要读 ---------- */
const fetchArgs = [...html.matchAll(/\bfetch\s*\(\s*([^)]*)/g)].map(m => m[1].trim())
const externalFetch = fetchArgs.filter(arg => {
  const literal = /^['"`]([^'"`]*)['"`]/.exec(arg)
  if (!literal) return false // 变量参数：本页走 fetchJson(path)，路径常量在下面单独校验
  const value = literal[1].trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')
})
check('fetch 只有同源相对路径', fetchArgs.length > 0 && externalFetch.length === 0, externalFetch.join(' | ') || '共 ' + fetchArgs.length + ' 处 fetch，无字面量外链')
const apiPaths = [...html.matchAll(/fetchJson\(\s*'([^']+)'/g)].map(m => m[1])
const expectedPaths = ['api/cluster', 'api/board', 'api/host']
check('三个同源路由都读了', expectedPaths.every(p => apiPaths.includes(p)), '实际：' + [...new Set(apiPaths)].join(', '))
check('api 路径都是相对路径', apiPaths.length > 0 && apiPaths.every(p => /^api\/[a-z]+$/.test(p)), apiPaths.join(' | '))
check('没有写死任何 api 外部地址', !/fetchJson\(\s*['"`](?:https?:|\/\/)/i.test(html))

/* ---------- 4. 标签基本闭合 ---------- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
function stripRawText(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
}
const stack = []
const tagErrors = []
const tokens = stripRawText(html).matchAll(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)\s*>/g)
for (const m of tokens) {
  const closing = m[1] === '/'
  const name = m[2].toLowerCase()
  const selfClosed = m[4] === '/' || VOID.has(name)
  if (closing) {
    const top = stack.pop()
    if (top !== name) {
      tagErrors.push('</' + name + '> 遇到未闭合的 <' + top + '>')
      if (top) stack.push(top)
    }
  } else if (!selfClosed) {
    stack.push(name)
  }
  if (tagErrors.length > 6) break
}
if (stack.length) tagErrors.push('仍开：' + stack.join(','))
check('标签基本闭合', tagErrors.length === 0, tagErrors.join(' | ') || '栈干净')

/* ---------- 5. 内联 CSS / JS ---------- */
const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
check('内联 <style> 恰一段', styles.length === 1, '共 ' + styles.length + ' 段')
check('内联 <script> 恰一段且无 src', scripts.length === 1 && !/\bsrc\s*=/.test(scripts[0]?.[1] ?? ''), '共 ' + scripts.length + ' 段')
if (styles.length === 1) {
  const css = styles[0][1].replace(/\/\*[\s\S]*?\*\//g, '')
  const open = (css.match(/\{/g) || []).length
  const close = (css.match(/\}/g) || []).length
  check('CSS 花括号配平', open === close && open > 0, open + ' { / ' + close + ' }')
}
if (scripts.length === 1) {
  const js = scripts[0][2]
  let jsError = ''
  try {
    new Function(js) // 只解析不执行
  } catch (error) {
    jsError = String((error && error.message) || error)
  }
  check('内联 JS 语法可解析', jsError === '', jsError)
  check("JS 开启 use strict", /'use strict'|"use strict"/.test(js))
  check('JS 有自执行入口', /\(function\s*\(\)/.test(js))
}

/* ---------- 6. MOCK 只作为兜底，且内容与真实数据形状对齐 ---------- */
check('MOCK 常量唯一存在', (html.match(/const\s+MOCK\s*=/g) || []).length === 1, '共 ' + (html.match(/const\s+MOCK\s*=/g) || []).length + ' 处定义')
for (const key of ['actions', 'tasks', 'events', 'host', 'topology', 'todosSeed']) {
  check('MOCK 含 ' + key + ' 段', new RegExp('\\n\\s*' + key + '\\s*:').test(html))
}
check('MOCK 兜底任务覆盖五种状态', ['leased', 'awaiting', 'undelivered', 'stale', 'done'].every(s => new RegExp("state:\\s*'" + s + "'").test(html)))
check('MOCK 主机数据含磁盘与内存', /disks\s*:\s*\[/.test(html) && /memory\s*:\s*\{/.test(html))

/* ---------- 7. 真实数据落点：三源 / 五态 / 事件流 ---------- */
check('TASK_STATES 五态映射在', /const TASK_STATES = \{/.test(html) &&
  ['leased', 'awaiting', 'undelivered', 'stale', 'done'].every(s => new RegExp(s + "\\s*:\\s*\\{\\s*text").test(html)))
check('五态 CSS 类都在', ['leased', 'awaiting', 'undelivered', 'stale', 'done', 'unknown'].every(s => new RegExp('\\.st\\.' + s + '\\{').test(html)))
check('板状态文案在', ['租约中', '等回执', '未送达', '已过期', '已完成'].every(s => html.includes(s)))
check('事件流渲染函数在', /function eventItem\(/.test(html) && /function renderEvents\(/.test(html))
check('任务渲染函数在', /function taskItem\(/.test(html) && /function renderTasks\(/.test(html))
check('事件字段齐全（时间/任务/节点/类型/文本）', ['evt-time', 'evt-kind', 'evt-text', 'evt-meta'].every(c => html.includes(c)))
check('任务行含证据数与相对时间', html.includes('evidenceCount') && html.includes('relTime(') && /条证据/.test(html))

/* ---------- 8. 顶栏假值必须清掉、三个 chip 接真实字段 ---------- */
const topbar = (/<header class="topbar">[\s\S]*?<\/header>/i.exec(html) || [''])[0]
check('顶栏不含 mock 字样', !/mock/i.test(topbar), topbar.includes('mock') ? '顶栏仍有 mock' : '')
for (const fake of ['DSH 0.4.0', '127.0.0.1:13090', '共享板 13090', 'p95 34ms', '已用 43 / 80 GB', '18.4 GB']) {
  check('无假值残留：' + fake, !html.includes(fake))
}
check('chip 三件套 + 过期 badge', ['chipCluster', 'chipBoard', 'chipTasks', 'chipStale'].every(id => html.includes('id="' + id + '"')))
check('三 chip 均有 dot 与文案节点', [1, 2, 3].every(() => true) &&
  ['chipClusterDot', 'chipClusterText', 'chipBoardDot', 'chipBoardText', 'chipTasksDot', 'chipTasksText'].every(id => html.includes('id="' + id + '"')))
check('chip 文案来自真实字段（up 计数 / 健康延迟 / 任务数）', /interconnect '\s*\+\s*up/.test(html) && /health\.latencyMs/.test(html) && /板上 '\s*\+\s*count/.test(html))
check('顶栏日期行接真实字段', ['selfLine', 'boardSourceLine', 'dataStamp'].every(id => html.includes('id="' + id + '"')))
check('日期行文案来自 self / source.origin', /实例 '\s*\+\s*\(/.test(html) && /source\.origin/.test(html))
check('无「最近文档」残留', !html.includes('最近文档') && !html.includes('docList') && !html.includes('tab-docs'))
check('事件流标签在', html.includes('id="tab-events"') && html.includes('id="panel-events"'))

/* ---------- 9. 小部件接 api/host 真值 ---------- */
check('小部件落点 id 齐全', ['diskRows', 'memTotal', 'memUsed', 'memRatio', 'memBar', 'boardLat', 'boardLatNote', 'boardHealthSrc', 'osLine'].every(id => html.includes('id="' + id + '"')))
check('磁盘/内存走 fmtBytes 与 ratio', /function fmtBytes\(/.test(html) && /memory\.ratio|data\.memory\.ratio/.test(html))
check('板健康取 /health 延迟', /health\.latencyMs/.test(html) && html.includes('最近一次 /health 延迟'))
check('小部件定位「本机 · 只读」', html.includes('本机 · 只读'))
check('已删除假 sparkline', !html.includes('latSpark') && !html.includes('drawSpark') && !html.includes('MOCK.latency'))

/* ---------- 10. 兜底 / 轮询 / 不闪回 mock ---------- */
check('mock 兜底标注在', html.includes('mock 兜底 · ') && html.includes('mock 兜底 · 真实数据不可用'))
check('首次失败回落 mock 的三条路径在', /state\.cluster = \{ kind: 'mock'/.test(html) && /state\.board = \{ kind: 'mock'/.test(html) && /state\.host = \{ kind: 'mock'/.test(html))
check('轮询失败保留上一次好数据（不重渲染 mock）', /kind === 'real'/.test(html) && /noteFailure\('board'/.test(html) && /noteFailure\('cluster'/.test(html))
check('过期 badge 文案格式', html.includes("'数据过期 · '") && /数据过期 · /.test(html))
check('30 秒静默轮询', /const POLL_MS = 30000/.test(html) && /setInterval\(function \(\)/.test(html) && /POLL_MS\)/.test(html))
check('页面隐藏时跳过轮询', /document\.hidden/.test(html))
check('接口请求有超时控制', /AbortSignal\.timeout/.test(html))
check('常用动作的看板地址动态化', /function renderBoardAction\(/.test(html) && /data-action="board"/.test(html) && /source\.origin/.test(html))
check('看板动作不可达时不置灰（点击给原因）', html.includes('板不可达（点击查看原因）') && html.includes('板未配置（点击查看原因）') && !/button\.disabled = true/.test(html))

/* ---------- 10b. 动作真实化（v0.3.0） ---------- */
check('没有本地假回执文案', !html.includes('演示') && !html.includes('未发送'))
check('回执四种状态齐全', /RECEIPT_STATES = \{ ok: '成功', fail: '失败', unsupported: '暂不支持', pending: '进行中' \}/.test(html))
check('回执四态 CSS 类齐全', ['ok', 'fail', 'unsupported', 'pending'].every(s => new RegExp('\\.r-state\\.' + s + '\\{').test(html)))
check('动作按钮都由动作白名单驱动', /const ACTION_RUNNERS = \{/.test(html) && ['new-session', 'dispatch', 'board', 'notes', 'latest-report'].every(id => new RegExp("'" + id + "': run").test(html)))
check('新会话走 DSH 客户端消息', /window\.parent\.postMessage\(\{ type: 'panel-action'/.test(html) && /panel-action-result/.test(html) && /requestId/.test(html))
check('客户端动作有超时与独立打开说明', /CLIENT_ACTION_TIMEOUT_MS = 2500/.test(html) && html.includes('client.js 改动需重启 DSH 后生效') && html.includes('当前页面不在 DSH 面板 iframe 里'))
check('客户端无响应回执写明超时原因', html.includes('client-timeout') && html.includes('DSH 客户端 2.5 秒内没响应动作'))
check('派发任务不伪造：写明替代方式', html.includes('面板不能直接调 mesh_* 工具') && html.includes('dispatch-draft'))
check('宿主动作路由走同源 POST', /fetch\('api\/action'/.test(html) && /method: 'POST'/.test(html) && /JSON\.stringify\(\{ action: action \}\)/.test(html))
check('宿主动作三件套在页面用到', ['probe-memory', 'latest-report', 'open-reports-folder'].every(id => html.includes(id)))
check('宿主路由缺失/失败有可读原因', html.includes('action-route-missing') && html.includes('action-unreachable') && html.includes('action-bad-response'))
check('看板不可达回执带原因', /board-unreachable/.test(html) && /board\.reason/.test(html))
check('报告预览面板齐全', ['reportPanel', 'reportMeta', 'reportContent', 'closeReport'].every(id => html.includes('id="' + id + '"')))
check('报告内容只用 textContent 渲染', /reportContent'\)\.textContent =/.test(html))
check('二级动作按钮（回执内）走 DOM 构建', /data-hint-action/.test(html) && /r-link/.test(html))
check('重启 DSH 仍禁用且写明红线', /disabled aria-describedby="disabledReason"/.test(html) && html.includes('红线：不由面板重启 DSH') && /runRestart/.test(html))
check('动作面板脚注说明真实通道', html.includes('宿主动作路由 api/action') && html.includes('DSH 客户端服务'))

/* ---------- 11. 拓扑（v5 能力不退化） ---------- */
check('mock 兜底视图存在（mockView）', /function mockView\(\)/.test(html))
check('真实数据视图存在（realView）', /function realView\(data\)/.test(html))
check('渲染函数只有一份且接视图模型', /function renderTopology\(view\)/.test(html) && /renderTopology\(mockView\(\)\)/.test(html) && /renderTopology\(realView\(cluster\.data\)\)/.test(html))
check('拓扑四槽位 id 齐全', ['mcloud', 'pc-ky614', 'server', 's5'].every(id => new RegExp("id:\\s*'" + id + "'").test(html)), '')
check('拓扑 5 条边', /edges:\s*\[\[/.test(html) && (html.match(/\['(?:mcloud|pc-ky614|server|s5)',\s*'(?:mcloud|pc-ky614|server|s5)'\]/g) || []).length === 5, '')
check('三态都落到 DOM 类上', ["'online'", "'offline'", "'unknown'"].every(s => html.includes(s)))
check('badge 元素齐全', ['topoSource', 'topoDot', 'topoSourceText', 'topoStamp', 'topoOthers'].every(id => new RegExp('id="' + id + '"').test(stripRawText(html))))
check('真实/兜底两种 badge 文案', html.includes('真实 · interconnect') && html.includes('mock 兜底 · 真实数据不可用'))
check('title 不再编造心跳', !/最后心跳/.test(html) && !/heartbeat/.test(html))
check('未知态写清「未在 interconnect 配置」', html.includes('未在 interconnect 配置'))
check('其它已配置对端一行', html.includes('其它已配置对端'))
check('使用 inline SVG（非 canvas）', /<svg\b/i.test(html) && !/<canvas\b/i.test(html))
check('拓扑 SVG 有 viewBox', /viewBox="0 0 1000 300"/.test(html))
check('拓扑 SVG 有 preserveAspectRatio', /preserveAspectRatio="xMidYMid meet"/.test(html))
check('拓扑 SVG 有 <title>/<desc>', /id="topoTitle"/.test(html) && /id="topoDesc"/.test(html))
check('拓扑节点容器存在', /id="topoEdges"/.test(html) && /id="topoNodes"/.test(html))
check('节点可键盘聚焦（tabindex）', /tabindex="0"/.test(html))

/* ---------- 12. 关键 id / V4 交互 / 存储不退化 ---------- */
const requiredIds = ['clock', 'greeting', 'dateLine', 'actionList', 'receiptList', 'taskList', 'eventList',
  'todoForm', 'todoInput', 'todoList', 'todoCount', 'storeHint', 'toast', 'topoEdges', 'topoNodes',
  'tab-tasks', 'tab-events', 'panel-tasks', 'panel-events']
const markupOnly = stripRawText(html)
const missingIds = requiredIds.filter(id => !new RegExp('id="' + id + '"').test(markupOnly))
check('关键 id 齐全', missingIds.length === 0, missingIds.join(',') || requiredIds.length + ' 个都在')
const allIds = [...markupOnly.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]).filter(id => /^[A-Za-z][\w:.-]*$/.test(id))
const dupIds = allIds.filter((id, i) => allIds.indexOf(id) !== i)
check('页面 id 不重复', dupIds.length === 0, [...new Set(dupIds)].join(',') || allIds.length + ' 个静态 id')
check('localStorage 待办键存在', /localStorage/.test(html) && /STORE_KEY/.test(html))
check('时钟定时器存在', /setInterval\(tick, 1000\)/.test(html))
check('动作回执仍在本页内存', /const receipts = \[\]/.test(html) && /function fireAction\(/.test(html))
check('标签页切换仍在', /function initTabs\(\)/.test(html) && /function tabSelect\(/.test(html))
check('暗色主题变量存在', /--bg:#14161a/.test(html) && /color-scheme" content="dark"/.test(html))
check('系统字体栈（无外链字体）', /--font:"Segoe UI"/.test(html) && !/fonts\.googleapis|font-face/i.test(html))
check('窄宽适配（900px 断点）', /@media\s*\(max-width:880px\)/.test(html))
check('XSS 防护：动态文本过 esc()', /function esc\(/.test(html) && /esc\(task\.title/.test(html) && /esc\(event\.text/.test(html))

/* ---------- 汇总 ---------- */
const failed = checks.filter(c => !c.ok)
// 证据里只写相对插件根的路径：这份 JSON 会入库，不该带本机绝对路径
const pluginRoot = resolve(dirname(self), '..')
const relFile = abs.startsWith(pluginRoot + sep)
  ? abs.slice(pluginRoot.length + 1).split(sep).join('/')
  : abs
const summary = { file: relFile, bytes, sha256, checks: checks.length, failed: failed.length, pass: failed.length === 0, results: checks }
if (jsonAt) await writeFile(jsonAt, JSON.stringify(summary, null, 2), 'utf8')

const padName = s => String(s).padEnd(40, ' ')
process.stdout.write('\n== check-page: ' + abs + ' ==\n')
process.stdout.write('bytes=' + bytes + ' sha256=' + sha256 + '\n')
for (const c of checks) {
  process.stdout.write((c.ok ? 'PASS ' : 'FAIL ') + padName(c.name) + (c.detail ? '  ' + c.detail : '') + '\n')
}
process.stdout.write('\nresult: ' + (summary.pass ? 'PASS' : 'FAIL') + ' (' + (checks.length - failed.length) + '/' + checks.length + ')\n')
process.exit(summary.pass ? 0 : 1)
