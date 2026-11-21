#!/usr/bin/env node
/**
 * tools/check-page.mjs —— `public/index.html`（大管家 0.4.0）的静态自检。
 *
 * 用法: node tools/check-page.mjs [页面文件] [--json <输出文件>]
 *       默认页面是本包的 public/index.html。
 *
 * 覆盖：
 *   - 单文件 / UTF-8 无 BOM / DOCTYPE / charset / lang；
 *   - **零外部引用**（无 http(s)://、无 <link>、无脚本/图片外链、无 XHR/WS；href 只有站内锚点）；
 *   - 同源只读路由：恰好读 api/cluster · api/board · api/host · api/tiers；写动作只 POST api/action；
 *   - 标签基本闭合 / 内联 CSS·JS 各一段 / CSS 花括号配平 / JS 可解析且 'use strict'；
 *   - 改名：标题、品牌、导航都叫「大管家」，页面不再出现「HTML 面板」这个入口名；
 *   - V7 三栏结构与 DSH token（选中态是 DSH 真实灰底，不是绿色）；
 *   - 五页导航（大管家/任务/集群/记忆/设置）与中栏示例对话 badge（必须明确标注）；
 *   - 右栏派活层级：T0–T3 chip、折叠/选中上级路径/tooltip/900 抽屉、降级 badge、节点文本 esc；
 *   - 共享板五态 / 事件流 / 板状态 badge / 数据过期横幅 / 30 秒轮询（隐藏页跳过）；
 *   - 动作真实通道（客户端 postMessage + 宿主动作路由）/ 四态回执 / 报告预览 / 重启禁用红线；
 *   - 本机与待办（localStorage）能力不退化；MOCK 只作首次失败兜底且覆盖五态；
 *   - 页面 id 不重复、关键 id 齐全。
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
check('深色主题声明', /<meta name="color-scheme" content="dark">/i.test(html))
check('viewport 声明', /<meta name="viewport"/i.test(html))

/* ---------- 2. 零外部引用 ---------- */
const externalRules = [
  ['http(s):// 绝对地址', /https?:\/\//i],
  ['协议相对地址 src="//"', /(?:src|href)\s*=\s*["']\s*\/\//i],
  ['<link> 标签', /<link\b/i],
  ['@import', /@import/i],
  ['<script src>', /<script\b[^>]*\bsrc\s*=/i],
  ['<img src>', /<img\b[^>]*\bsrc\s*=/i],
  ['<iframe>', /<iframe\b/i],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['new WebSocket', /\bnew\s+WebSocket\b/],
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
check('href 仅站内锚点 / SVG use', badHrefs.length === 0, badHrefs.join(' | ') || hrefs.length + ' 个 href')

/* ---------- 3. 同源路由：四条只读 + 一条写动作 ---------- */
const fetchArgs = [...html.matchAll(/\bfetch\s*\(\s*([^)]*)/g)].map(m => m[1].trim())
const externalFetch = fetchArgs.filter(arg => {
  const literal = /^['"`]([^'"`]*)['"`]/.exec(arg)
  if (!literal) return false
  const value = literal[1].trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')
})
check('fetch 只有同源相对路径', fetchArgs.length > 0 && externalFetch.length === 0, externalFetch.join(' | ') || '共 ' + fetchArgs.length + ' 处 fetch')
const apiPaths = [...html.matchAll(/fetchJson\(\s*'([^']+)'/g)].map(m => m[1])
check('四条只读路由都读了', ['api/cluster', 'api/board', 'api/host', 'api/tiers'].every(p => apiPaths.includes(p)), '实际：' + [...new Set(apiPaths)].join(', '))
check('api 路径都是相对路径', apiPaths.length > 0 && apiPaths.every(p => /^api\/[a-z]+$/.test(p)), apiPaths.join(' | '))
check('没有写死任何 api 外部地址', !/fetchJson\(\s*['"`](?:https?:|\/\/)/i.test(html))
check('写动作只走同源 POST api/action', /fetch\('api\/action'/.test(html) && /method: 'POST'/.test(html) && /JSON\.stringify\(\{ action: action \}\)/.test(html))

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

/* ---------- 6. 改名：大管家，且不再有「HTML 面板」入口名 ---------- */
check('页面标题是「大管家」', /<title>[^<]*大管家[^<]*<\/title>/.test(html), (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '')
check('品牌名是「大管家」', /class="brand-t">大管家</.test(html))
check('品牌副标 BUTLER CONSOLE', html.includes('BUTLER CONSOLE'))
check('页面不再出现「HTML 面板」入口名', !html.includes('HTML 面板') && !html.includes('HTML面板'))
check('页面不出现「快捷工作台」旧名', !html.includes('快捷工作台'))

/* ---------- 7. V7 三栏 + 五页导航 + DSH token ---------- */
check('三栏结构（side / chat / hier）', /<aside class="side">/.test(html) && /<main class="chat">/.test(html) && /<aside class="hier" id="hier"/.test(html))
const navItems = [...html.matchAll(/class="nav-item[^"]*" type="button" data-page="([a-z]+)"/g)].map(m => m[1])
check('五页导航（大管家/任务/集群/记忆/设置）', JSON.stringify(navItems) === JSON.stringify(['butler', 'tasks', 'cluster', 'memory', 'settings']), navItems.join(','))
for (const [label, page] of [['大管家', 'butler'], ['任务', 'tasks'], ['集群', 'cluster'], ['记忆', 'memory'], ['设置', 'settings']]) {
  check('导航项文案 + data-page：' + label, new RegExp('data-page="' + page + '"[\\s\\S]{0,200}?' + label).test(html) || new RegExp(label + '[\\s\\S]{0,200}?data-page="' + page + '"').test(html))
}
check('五个页面容器都在', ['butler', 'tasks', 'cluster', 'memory', 'settings'].every(p => html.includes('id="page-' + p + '"')))
const TOKENS = [
  ['--bg-base:rgb(21,21,23)', 'DSH bg-base'],
  ['--sidebar-fill:rgb(27,27,28)', 'DSH sidebar-fill'],
  ['--sidebar-active:rgb(67,69,74)', 'DSH 侧栏选中灰底'],
  ['--accent:rgb(122,170,255)', 'DSH business-primary 蓝'],
  ['--chat-w:clamp(680px,64%,920px)', 'DSH 会话列宽'],
]
for (const [token, label] of TOKENS) check('DSH token：' + label, html.includes(token), token)
check('当前导航项用 DSH 灰底而非绿色', /\.nav-item\.active\{background:var\(--sidebar-active\)/.test(html))
check('900/窄屏抽屉断点（≤1200px）', /@media \(max-width:1200px\)/.test(html) && /body\.drawer \.hier\{transform:none\}/.test(html))
check('窄屏二次断点（≤980px）', /@media \(max-width:980px\)/.test(html))
check('prefers-reduced-motion 降级动画', /@media \(prefers-reduced-motion:reduce\)/.test(html))

/* ---------- 8. 中栏示例对话必须明确标注 ---------- */
check('示例对话 badge 在', html.includes('id="demoBadge"') && /示例对话[^<]*静态演示/.test(html))
check('示例轨迹也标注', /示例轨迹[^<]*静态演示/.test(html))
check('示例 badge 说明不是真实聊天', /不是真实聊天/.test(html))
check('对话/轨迹 tab 在', html.includes('id="tab-dialogue"') && html.includes('id="tab-trajectory"'))
check('对话与轨迹两个容器在', html.includes('id="traceDialogue"') && html.includes('id="traceTrajectory"'))
check('DSH 风格会话区（已启动卡 / 思考 / composer）', html.includes('class="started"') && html.includes('class="think"') && html.includes('class="composer-card"'))
check('composer 里挂真实快捷动作容器', /id="actionList"/.test(html) && /class="action-strip"/.test(html))

/* ---------- 9. 右栏派活层级 ---------- */
check('层级 chip T0–T3 都在', ['cntT0', 'cntT1', 'cntT2', 'cntT3'].every(id => html.includes('id="' + id + '"')))
check('层级降级 badge 在', html.includes('id="tierDegraded"'))
check('层级树容器 role=tree', /id="tree" role="tree"/.test(html))
check('层级状态图例五态', ['运行中', '空闲', '排队', '阻塞', '已完成'].every(t => html.includes(t)))
check('节点渲染函数在', /function renderNode\(/.test(html))
check('节点文本全部过 esc()', /esc\(n\.name\)/.test(html) && /esc\(n\.device\)/.test(html) && /esc\(n\.task\)/.test(html))
check('折叠 / 选中上级路径 / tooltip 代码都在', /classList\.toggle\('collapsed'\)/.test(html) && /has-sel/.test(html) && /function fillTip\(/.test(html))
check('数据来自 api/tiers（真实层级）', /fetchJson\('api\/tiers'/.test(html) && /data\.nodes/.test(html) && /parentId/.test(html))
check('层级降级不编节点：404 文案在', /api\/tiers 路由尚未加载/.test(html) && /需重启 DSH/.test(html))
check('900 抽屉开关三件套', /id="drawerBtn"/.test(html) && /id="hierClose"/.test(html) && /id="mask"/.test(html))
check('设备只是标签（节点内 .dev chip）', /class="dev"/.test(html) && /data-device=/.test(html))

/* ---------- 10. 任务页：共享板真数据 ---------- */
check('MOCK 常量唯一存在', (html.match(/const\s+MOCK\s*=/g) || []).length === 1, '共 ' + (html.match(/const\s+MOCK\s*=/g) || []).length + ' 处定义')
for (const key of ['actions', 'tasks', 'events', 'host', 'topology', 'todosSeed']) {
  check('MOCK 含 ' + key + ' 段', new RegExp('\\n\\s*' + key + '\\s*:').test(html))
}
check('MOCK 兜底任务覆盖五种状态', ['leased', 'awaiting', 'undelivered', 'stale', 'done'].every(s => new RegExp("state:\\s*'" + s + "'").test(html)))
check('TASK_STATES 五态映射在', /const TASK_STATES = \{/.test(html) && ['leased', 'awaiting', 'undelivered', 'stale', 'done'].every(s => new RegExp(s + "\\s*:\\s*\\{\\s*text").test(html)))
check('五态 CSS 类都在', ['leased', 'awaiting', 'undelivered', 'stale', 'done', 'unknown'].every(s => new RegExp('\\.st\\.' + s + '\\{').test(html)))
check('板状态文案在', ['租约中', '等回执', '未送达', '已过期', '已完成'].every(t => html.includes(t)))
check('任务/事件渲染函数在', /function taskItem\(/.test(html) && /function eventItem\(/.test(html) && /function renderTasks\(/.test(html) && /function renderEvents\(/.test(html))
check('任务行含证据数与相对时间', html.includes('evidenceCount') && html.includes('relTime(') && /条证据/.test(html))
check('事件字段齐全（时间/任务/节点/类型/文本）', ['evt-time', 'evt-kind', 'evt-text', 'evt-meta'].every(c => html.includes(c)))
check('任务/事件 tab 与面板 id 齐全', ['taskList', 'eventList', 'taskEmpty', 'eventEmpty', 'tab-tasks', 'tab-events', 'panel-tasks', 'panel-events'].every(id => html.includes('id="' + id + '"')))
check('板状态 badge 接真实状态', /id="boardBadge"/.test(html) && /board\.badgeKind/.test(html))
check('数据过期横幅（轮询失败保留旧数据）', /id="chipStale"/.test(html) && /数据过期 · /.test(html))
check('首次失败回落 mock 的三条路径在', /state\.cluster = \{ kind: 'mock'/.test(html) && /state\.board = \{ kind: 'mock'/.test(html) && /state\.host = \{ kind: 'mock'/.test(html))
check('轮询失败不闪回 mock', /kind === 'real'/.test(html) && /noteFailure\('board'/.test(html) && /noteFailure\('cluster'/.test(html))
check('30 秒静默轮询 + 页面隐藏跳过', /const POLL_MS = 30000/.test(html) && /document\.hidden/.test(html) && /setInterval\(/.test(html))
check('层级单独 15 秒轮询', /const TIERS_POLL_MS = 15000/.test(html))
check('接口请求有超时控制', /AbortSignal\.timeout/.test(html))

/* ---------- 11. 动作真实化（0.3.0 能力保留） ---------- */
check('回执四种状态齐全', /RECEIPT_STATES = \{ ok: '成功', fail: '失败', unsupported: '暂不支持', pending: '进行中' \}/.test(html))
check('回执四态 CSS 类齐全', ['ok', 'fail', 'unsupported', 'pending'].every(s => new RegExp('\\.r-state\\.' + s + '\\{').test(html)))
check('动作按钮都由动作白名单驱动', /const ACTION_RUNNERS = \{/.test(html) && ['new-session', 'dispatch', 'board', 'notes', 'latest-report', 'open-reports-folder', 'restart-dsh'].every(id => new RegExp("'" + id + "': run").test(html)))
check('新会话走 DSH 客户端消息', /window\.parent\.postMessage\(\{ type: 'panel-action'/.test(html) && /panel-action-result/.test(html) && /requestId/.test(html))
check('客户端动作有超时与独立打开说明', /CLIENT_ACTION_TIMEOUT_MS = 2500/.test(html) && html.includes('client.js 改动需重启 DSH 后生效') && html.includes('当前页面不在 DSH 面板 iframe 里'))
check('客户端无响应回执写明超时原因', html.includes('client-timeout') && html.includes('DSH 客户端 2.5 秒内没响应动作'))
check('派发任务不伪造：写明替代方式', html.includes('面板不能直接调 mesh_* 工具') && html.includes('dispatch-draft'))
check('宿主动作三件套在页面用到', ['probe-memory', 'latest-report', 'open-reports-folder'].every(id => html.includes(id)))
check('宿主路由缺失/失败有可读原因', html.includes('action-route-missing') && html.includes('action-unreachable') && html.includes('action-bad-response'))
check('看板不可达回执带原因', /board-unreachable/.test(html) && /board\.reason/.test(html))
check('报告预览面板齐全', ['reportPanel', 'reportMeta', 'reportContent', 'closeReport'].every(id => html.includes('id="' + id + '"')))
check('报告内容只用 textContent 渲染', /reportContent'\)\.textContent =/.test(html))
check('二级动作按钮（回执内）走 DOM 构建', /data-hint-action/.test(html) && /r-link/.test(html))
check('重启 DSH 仍禁用且写明红线', /disabled aria-describedby="disabledReason"/.test(html) && html.includes('红线：不由面板重启 DSH') && /runRestart/.test(html))
check('动作通道说明在设置页', html.includes('POST api/action（只收白名单动作 id）'))

/* ---------- 12. 集群拓扑 ---------- */
check('mock 兜底视图存在（mockView）', /function mockView\(\)/.test(html))
check('真实数据视图存在（realView）', /function realView\(data\)/.test(html))
check('渲染函数只有一份且接视图模型', /function renderTopology\(view\)/.test(html) && /renderTopology\(mockView\(\)\)/.test(html) && /renderTopology\(realView\(cluster\.data\)\)/.test(html))
check('拓扑四槽位 id', ['mcloud', 'pc-ky614', 'server', 's5'].every(id => new RegExp("id:\\s*'" + id + "'").test(html)))
check('拓扑 5 条边', (html.match(/\['(?:mcloud|pc-ky614|server|s5)',\s*'(?:mcloud|pc-ky614|server|s5)'\]/g) || []).length === 5)
check('三态都落到 DOM 类上', ["'online'", "'offline'", "'unknown'"].every(s => html.includes(s)))
check('badge 元素齐全', ['topoSource', 'topoDot', 'topoSourceText', 'topoStamp', 'topoOthers'].every(id => new RegExp('id="' + id + '"').test(stripRawText(html))))
check('真实/兜底两种 badge 文案', html.includes('真实 · interconnect') && html.includes('mock 兜底 · 真实数据不可用'))
check('title 不再编造心跳', !/最后心跳/.test(html) && !/heartbeat/.test(html))
check('未知态写清「未在 interconnect 配置」', html.includes('未在 interconnect 配置'))
check('使用 inline SVG（非 canvas）', /<svg\b/i.test(html) && !/<canvas\b/i.test(html))
check('拓扑 SVG 有 viewBox / preserveAspectRatio / title / desc', /viewBox="0 0 1000 300"/.test(html) && /preserveAspectRatio="xMidYMid meet"/.test(html) && /id="topoTitle"/.test(html) && /id="topoDesc"/.test(html))
check('拓扑节点容器存在', /id="topoEdges"/.test(html) && /id="topoNodes"/.test(html))
check('节点可键盘聚焦（tabindex）', /tabindex="0"/.test(html))
check('设备/链路列表接真实字段', /function renderClusterList\(/.test(html) && /peer\.link/.test(html) && /peer\.origin/.test(html))

/* ---------- 13. 记忆 / 设置页 ---------- */
check('记忆页真探测入口', /id="memoryProbe"/.test(html) && /fireAction\('notes'\)/.test(html))
check('记忆状态文案来自真实回执', /state\.memory = \{ kind: 'ok'/.test(html) && /state\.memory = \{ kind: 'fail'/.test(html))
check('设置页版本是 0.4.0', /id="setVersion">0\.4\.0</.test(html))
check('设置页列出四条路由', /api\/cluster · api\/board · api\/host · api\/tiers/.test(html))
check('设置页数据源接真实字段', /id="setBoard"/.test(html) && /id="setTiersSource"/.test(html) && /id="setHost"/.test(html))
check('设置页写明重启要求', /改动（含新增 api\/tiers 路由、侧栏改名）需重启 DSH 后才生效/.test(html))

/* ---------- 14. 本机 / 待办能力不退化 ---------- */
check('本机小部件接 api/host 真值', /function renderHostModule\(/.test(html) && /host\.data\.memory/.test(html) && /fmtBytes\(/.test(html))
check('localStorage 待办键存在', /localStorage/.test(html) && /STORE_KEY/.test(html))
check('待办表单/列表/计数 id 齐全', ['todoForm', 'todoInput', 'todoList', 'todoCount', 'storeHint', 'todoSummary', 'clearDone', 'todoEmpty'].every(id => html.includes('id="' + id + '"')))
check('待办在任务页（五页导航内）', /id="page-tasks"[\s\S]*id="todoForm"/.test(html))

/* ---------- 15. id / XSS / 交互 ---------- */
const requiredIds = ['toast', 'chipStale', 'chipStaleText', 'statDevices', 'statBoard', 'sfSub', 'sfDev',
  'demoBadge', 'traceDialogue', 'traceTrajectory', 'actionList', 'receiptList', 'clearReceipt',
  'reportPanel', 'reportMeta', 'reportContent', 'closeReport', 'taskList', 'eventList','taskEmpty','eventEmpty',
  'todoForm', 'todoInput', 'todoList', 'todoCount', 'storeHint', 'todoSummary', 'clearDone', 'todoEmpty',
  'topoEdges', 'topoNodes', 'topoSource', 'topoDot', 'topoSourceText', 'topoStamp', 'topoOthers',
  'tree', 'cntT0', 'cntT1', 'cntT2', 'cntT3', 'tierDegraded', 'hier', 'hierScroll', 'drawerBtn', 'hierClose', 'mask', 'tip',
  'boardBadge', 'boardBadgeText', 'recentHint', 'clusterList', 'memoryProbe', 'memoryState', 'memoryBadge', 'memoryBadgeText',
  'setVersion', 'setBoard', 'setCluster', 'setHost', 'setTiersSource', 'disabledReason', 'sendBtn', 'prompt', 'drawerCount', 'hhDesc', 'tierHint', 'tierSourceHint']
const markupOnly = stripRawText(html)
const missingIds = requiredIds.filter(id => !new RegExp('id="' + id + '"').test(markupOnly))
check('关键 id 齐全', missingIds.length === 0, missingIds.join(',') || requiredIds.length + ' 个都在')
const allIds = [...markupOnly.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]).filter(id => /^[A-Za-z][\w:.-]*$/.test(id))
const dupIds = allIds.filter((id, i) => allIds.indexOf(id) !== i)
check('页面 id 不重复', dupIds.length === 0, [...new Set(dupIds)].join(',') || allIds.length + ' 个静态 id')
check('XSS 防护：动态文本过 esc()', /function esc\(/.test(html) && /esc\(task\.title/.test(html) && /esc\(event\.text/.test(html))
check('导航切换函数与五页联动', /function setPage\(/.test(html) && /PAGES = \['butler', 'tasks', 'cluster', 'memory', 'settings'\]/.test(html))
check('刷新按钮真刷新四条路由', /id="refreshBtn"/.test(html) && /function refreshAll\(/.test(html))
check('渲染状态写进 body.dataset（无头自检用）', /body\.dataset\[kind\]/.test(html))

/* ---------- 汇总 ---------- */
const failed = checks.filter(c => !c.ok)
const pluginRoot = resolve(dirname(self), '..')
const relFile = abs.startsWith(pluginRoot + sep)
  ? abs.slice(pluginRoot.length + 1).split(sep).join('/')
  : abs
const summary = { file: relFile, bytes, sha256, checks: checks.length, failed: failed.length, pass: failed.length === 0, results: checks }
if (jsonAt) await writeFile(jsonAt, JSON.stringify(summary, null, 2), 'utf8')

const padName = s => String(s).padEnd(46, ' ')
process.stdout.write('\n== check-page: ' + abs + ' ==\n')
process.stdout.write('bytes=' + bytes + ' sha256=' + sha256 + '\n')
for (const c of checks) {
  process.stdout.write((c.ok ? 'PASS ' : 'FAIL ') + padName(c.name) + (c.detail ? '  ' + c.detail : '') + '\n')
}
process.stdout.write('\nresult: ' + (summary.pass ? 'PASS' : 'FAIL') + ' (' + (checks.length - failed.length) + '/' + checks.length + ')\n')
process.exit(summary.pass ? 0 : 1)
