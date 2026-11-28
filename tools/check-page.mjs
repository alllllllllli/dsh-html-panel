#!/usr/bin/env node
/**
 * tools/check-page.mjs —— `public/index.html`（大管家 0.7.0 = M0+M1 只读驾驶舱）的静态自检。
 *
 * 用法: node tools/check-page.mjs [页面文件] [--json <输出文件>]
 *       默认页面是本包的 public/index.html。
 *
 * 覆盖：
 *   - 单文件 / UTF-8 无 BOM / DOCTYPE / charset / lang；
 *   - **零外部引用**（无 http(s)://、无 <link>、无脚本/图片外链、无 XHR/WS；href 只有站内锚点）；
 *   - 同源只读路由：api/cluster · api/board · api/host · api/tiers · api/alerts ·
 *     api/butler/sessions · api/butler/dialog；写动作只 POST api/action；
 *   - 标签基本闭合 / 内联 CSS·JS 各一段 / CSS 花括号配平 / JS 可解析且 'use strict'；
 *   - 改名：标题、品牌、导航都叫「大管家」，页面不再出现「HTML 面板」这个入口名；
 *   - V7 三栏结构与 DSH token（选中态是 DSH 真实灰底，不是绿色）；
 *   - 五页导航（大管家/任务/集群/记忆/设置）；
 *   - 0.7.0：中栏是**真实对话只读流**（api/butler/dialog + seq 去重 + 工具折叠卡 +
 *     思考折叠），**不再有示例对话**；0.8.0 起底部输入框在写通道可用时启用（只发专属会话，
 *     每次二次确认），不可用时禁用并写明原因；
 *   - 0.8.0：顶部三问条收成一行 36–44px 细状态条（默认摘要 + 健康/降级 chip；high 自动展开，
 *     展开后才是原三问三块）；专属会话 pinned 标签 + 领导预设标注 + 创建/重建按钮；
 *   - 0.7.0：右栏 T0–T3 状态来自 api/butler/sessions（sessionController.state），
 *     跨机节点标「只读」；M0 未加载时退回 api/tiers 并写明降级；
 *   - 右栏派活层级：T0–T3 chip、折叠/选中上级路径/tooltip/900 抽屉、降级 badge、节点文本 esc；
 *   - 共享板五态 / 事件流 / 板状态 badge / 数据过期横幅 / 30 秒轮询（隐藏页跳过）；
 *   - 动作真实通道（客户端 postMessage + 宿主动作路由）/ 四态回执 / 报告预览 / 重启禁用红线；
 *   - 0.6.0 TRAIL 告警：api/alerts 读取与降级回退、三问第一问「需要你 N 条」、告警卡字段、
 *     高低优先级分栏、任务卡告警标记与跳转、无告警文案；
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
const apiPaths = [...html.matchAll(/fetchJson\(\s*'([^']+)'/g)].map(m => m[1].replace(/\?$/, ''))
check('老四条只读路由都读了', ['api/cluster', 'api/board', 'api/host', 'api/tiers'].every(p => apiPaths.includes(p)), '实际：' + [...new Set(apiPaths)].join(', '))
check('驾驶舱两条新只读路由都读了（M0/M1）', ['api/butler/sessions', 'api/butler/dialog'].every(p => apiPaths.includes(p)), apiPaths.filter(p => p.startsWith('api/butler')).join(', '))
check('api 路径都是相对路径', apiPaths.length > 0 && apiPaths.every(p => /^api\/(?:[a-z]+|butler\/[a-z]+)(?:\?)?$/.test(p)), apiPaths.join(' | '))
check('没有写死任何 api 外部地址', !/fetchJson\(\s*['"`](?:https?:|\/\/)/i.test(html))
check('写动作只走同源 POST api/action', /fetch\('api\/action'/.test(html) && /method: 'POST'/.test(html) && /JSON\.stringify\(\{ action: action \}\)/.test(html))
check('写对话通道走同源 POST api/butler/say 且带注入 token 头', /fetch\('api\/butler\/say'/.test(html) && /x-butler-write-token/.test(html) && /INJECTED_WRITE/.test(html))
check('专属会话创建/重建走同源 POST api/butler/session', /fetch\('api\/butler\/session'/.test(html) && /SESSION_ACTION_TIMEOUT_MS/.test(html))

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
check('内联 <script> 两段（诊断 + 主程序）且无 src', scripts.length === 2 && scripts.every(x => !/\bsrc\s*=/.test(x[1])), '共 ' + scripts.length + ' 段')
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

/* ---------- 8. 中栏：真实对话只读流（0.7.0，不再有示例对话） ---------- */
check('中栏真实对话容器在', html.includes('id="dialogList"') && html.includes('id="dialogEmpty"') && html.includes('id="thread"'))
check('页面不再有示例对话 / 静态演示', !html.includes('id="demoBadge"') && !/示例对话 · 静态演示/.test(html) && !/示例轨迹 · 静态演示/.test(html))
check('轨迹视图诚实占位（M2 未接入，不伪造轨迹）', /轨迹视图 · M2 未接入/.test(html) && /不伪造轨迹/.test(html))
check('对话/轨迹 tab 在', html.includes('id="tab-dialogue"') && html.includes('id="tab-trajectory"'))
check('对话与轨迹两个容器在', html.includes('id="traceDialogue"') && html.includes('id="traceTrajectory"'))
check('DSH 风格真实对话渲染（思考折叠 / 工具卡 / composer）', /class="think"/.test(html) && /function toolCardHtml\(/.test(html) && /class="tcard/.test(html) && html.includes('class="composer-card"'))
check('真实对话轮询 + seq 去重合并', /function loadDialog\(/.test(html) && /function mergeDialogMessages\(/.test(html) && /map\.set\(message\.seq, message\)/.test(html) && /fetchJson\('api\/butler\/dialog\?'/.test(html))
check('加载更早消息（before 翻页）', /id="loadEarlier"/.test(html) && /function loadEarlierDialog\(/.test(html) && /before: oldest/.test(html))
check('composer 里挂真实快捷动作容器', /id="actionList"/.test(html) && /class="action-strip"/.test(html))

/* ---------- 9. 右栏派活层级 ---------- */
check('层级 chip T0–T3 都在', ['cntT0', 'cntT1', 'cntT2', 'cntT3'].every(id => html.includes('id="' + id + '"')))
check('层级降级 badge 在', html.includes('id="tierDegraded"'))
check('层级树容器 role=tree', /id="tree" role="tree"/.test(html))
check('层级状态图例五态', ['运行中', '空闲', '排队', '阻塞', '已完成'].every(t => html.includes(t)))
check('节点渲染函数在', /function renderNode\(/.test(html))
check('节点文本全部过 esc()', /esc\(n\.name\)/.test(html) && /esc\(n\.device\)/.test(html) && /esc\(n\.task\)/.test(html))
check('折叠 / 选中上级路径 / tooltip 代码都在', /classList\.toggle\('collapsed'\)/.test(html) && /has-sel/.test(html) && /function fillTip\(/.test(html))
check('右栏状态来自 api/butler/sessions（M0 真实 state）', /fetchJson\('api\/butler\/sessions'/.test(html) && /data\.nodes/.test(html) && /parentId/.test(html) && /statusText/.test(html))
check('右栏状态文案接真实 state（运行中/排队/等审批/等回答/空闲）', ['运行中', '排队', '等审批', '等回答', '空闲'].every(t => html.includes(t)))
check('右栏跨机节点标「只读」', /class="ro-tag"/.test(html) && /data-readonly=/.test(html) && /跨机只读/.test(html))
check('M0 未加载时退回 api/tiers 并写明降级（不编节点）', /fetchJson\('api\/tiers'/.test(html) && /右栏状态降级/.test(html) && /需重启 DSH/.test(html))
check('层级降级 badge 保留', /id="tierDegraded"/.test(html) && /会话数据降级/.test(html))
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
check('动作通道说明在设置页', html.includes('POST api/action（白名单动作 id）') && html.includes('POST api/butler/say') && html.includes('POST api/butler/session'))

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
check('设置页版本是 0.9.7', /id="setVersion">0\.9\.7</.test(html) && /setVersion\.textContent = '0\.9\.7'/.test(html))
/* 0.9.5：页脚版本行精简为「v0.9.x · 驾驶舱」，副标全文移到 title（信息不丢，只是不常驻占位）。 */
check('页脚版本是 0.9.7', /v0\.9\.7 · 驾驶舱</.test(html) && /title="驾驶舱 · 写通道 M2 · 模型\/档位 · 自诊断"/.test(html))
check('设置页列出七条只读路由', /api\/cluster · api\/board · api\/host · api\/tiers · api\/alerts · api\/butler\/sessions · api\/butler\/dialog/.test(html))
check('设置页列出写通道路由（say/session）', /POST api\/butler\/say/.test(html) && /POST api\/butler\/session/.test(html))
check('设置页数据源接真实字段', /id="setBoard"/.test(html) && /id="setTiersSource"/.test(html) && /id="setHost"/.test(html) && /id="setButler"/.test(html))
check('设置页显示专属会话与写通道现场状态', /id="setPinned"/.test(html) && /id="setWrite"/.test(html) && /function writeChannelState\(/.test(html))
check('设置页写明重启要求', /api\/butler\/sessions/.test(html) && /official 段/.test(html) && /需重启 DSH 后才生效/.test(html))

/* ---------- 13.5 一行细状态条（0.8.0，替代 0.5.0 三问条主位） ---------- */
check('细状态条容器在（statusBar + 展开按钮 + 详情面板）', /id="statusBar"/.test(html) && /id="statusToggle"/.test(html) && /id="statusDetail"/.test(html) && /aria-label="状态条/.test(html))
check('细状态条高度 36–44px（min-height:40px / max-height:44px 且无大块 padding）', /\.sb-main\{[^}]*min-height:40px;[^}]*max-height:44px/.test(html) || /min-height:40px;max-height:44px/.test(html) || /\.sb-main\{[^}]*min-height:40px[^}]*max-height:44px/.test(html))
check('细状态条默认一行：摘要 + dot + chips + 展开箭头', /id="statusSummary"/.test(html) && /id="statusDot"/.test(html) && /id="statusChips"/.test(html) && /class="i sb-chev"/.test(html))
check('摘要文案口径（需要你 N 条 · 高 H 中 M / 一切正常 · 在管 X 个活 · 板 Y 任务）', /需要你 ' \+/.test(html) && /一切正常/.test(html) && /在管 ' \+/.test(html) && /'板 ' \+/.test(html))
check('详情面板默认收起（status-detail[hidden] + data-expanded=false）', /<div class="status-detail" id="statusDetail" hidden>/.test(html) && /id="statusBar" data-expanded="false"/.test(html) && /detail\.hidden = !state\.statusBar\.expanded/.test(html))
check('有 high 告警默认展开、同一批不重复抢回（lastHighSig）', /function renderStatusBar\(/.test(html) && /state\.statusBar\.lastHighSig !== sig/.test(html) && /setStatusBarExpanded\(true\)/.test(html))
check('健康/降级用一枚小 chip 提示（N 项降级 / 健康）', /项降级<\/span>/.test(html) && /sb-chip ok">健康/.test(html) && /function statusCounts\(/.test(html))
check('折叠面板里仍是原三问三块（是否需要我 / 系统是否健康 / 这件事的历史）', /id="statusDetail"[\s\S]{0,900}id="tqNeeds"[\s\S]{0,600}id="tqHealth"[\s\S]{0,600}id="tqHistory"/.test(html))
for (const [id, text] of [['tqNeeds', '是否需要我'], ['tqHealth', '系统是否健康'], ['tqHistory', '这件事的历史']]) {
  check('三问项齐：' + text, new RegExp('id="' + id + '"').test(html) && html.includes(text) && new RegExp('id="' + id + 'N"').test(html) && new RegExp('id="' + id + 'List"').test(html))
}
check('三问健康态不占位（计数=列表长度）', /count\.textContent = String\(rows\.length\)/.test(html) && /block\.hidden = true/.test(html))
check('三问每行说「在等谁、要什么」', /class="tq-who">在等 <b>/.test(html) && /class="tq-want">要 /.test(html))
check('三问第一问只认真实板数据（awaiting/undelivered/stale/官方可认领）', /task\.state === 'awaiting'/.test(html) && /task\.state === 'undelivered'/.test(html) && /task\.state === 'stale'/.test(html) && /task\.ready === true && !task\.ownerName/.test(html))
check('三问第二问逐行列系统问题（链路/板/投影/本机/层级）', /function tqHealth\(/.test(html) && /官方 Agent Teams 投影/.test(html) && /官方任务板不可用/.test(html))
check('三问第三问用选中节点或最近任务历史', /function tqHistory\(/.test(html) && /state\.tierSelectedId/.test(html) && /最近任务 /.test(html))

/* ---------- 13.6 官方 TeamTaskView（0.5.0） ---------- */
check('官方 TeamTaskStatus 中文文案（不直接显示英文）', /const TEAM_STATUS = \{ pending: '待办'/.test(html) && /in_progress: '进行中'/.test(html) && /completed: '已完成'/.test(html) && /deleted: '已取消'/.test(html))
check('TeamBoard.tsx 的 status→StateDot 映射在', /const TEAM_DOT = \{ pending: 'idle', in_progress: 'ongoing', completed: 'done'/.test(html) && /function teamDot\(/.test(html) && /return 'warning'/.test(html))
check('StateDot 五态 CSS 在（idle/ongoing/done/warning/error）', ['.sd{', '.sd.ongoing{', '.sd.done{', '.sd.warning{', '.sd.error{'].every(rule => html.includes(rule)))
check('任务卡片用 TeamTaskView 字段渲染', /officialRows/.test(html) && /blockedByText\(task\)/.test(html) && /writeScopesText\(task\)/.test(html) && /task\.writeScopeWarnings/.test(html) && /就绪：/.test(html))
check('mesh 缺列如实写（unsupported）', /unsupportedText\(/.test(html) && /数据源不含依赖/.test(html) && /数据源不含写域/.test(html))
check('报告五态中文口径在', ['进行中', '可接手', '受阻', '失败', '已撤销'].every(t => html.includes(t)))
check('官方任务板卡片与降级文案在', ['officialCard', 'officialList', 'officialEmpty', 'officialHint', 'officialCount', 'officialLegend'].every(id => html.includes('id="' + id + '"')) && /官方任务板不可用（/.test(html))
check('官方任务板接 api/board 的 official 段', /board\.data\.official/.test(html) && /official\.available/.test(html) && /official\.tasks/.test(html))
check('官方任务板不拿 mock 冒充', /board\.kind === 'mock'/.test(html) && /官方任务板不可用（共享板接口整体不可达/.test(html))
check('设置页显示官方任务板数据源', /id="setOfficial"/.test(html) && /official\.teams/.test(html))

/* ---------- 13.7 官方 subagent 契约（0.5.0） ---------- */
check('官方 subagent 地址契约字段在', /parentSessionId/.test(html) && /childSessionId/.test(html) && /SUBAGENT_MODE = \{ 'one-shot': '一次性', continuable: '可续聊', unknown: '未知' \}/.test(html))
check('层级卡片显示 mode 并对齐官方契约', /data-mode=/.test(html) && /data-child-session=/.test(html) && /data-parent-session=/.test(html) && /tipRow\('子会话'/.test(html))
check('层级数据源显示官方投影可达性', /source\.subagentMode/.test(html) && /契约：官方投影/.test(html))

/* ---------- 13.8 TRAIL 告警（0.6.0） ---------- */
check('页面读取 api/alerts 且校验响应结构', /fetchJson\('api\/alerts'/.test(html) && /function isAlertsPayload\(/.test(html) && /function loadAlerts\(/.test(html))
check('告警失败有一致降级（404 需重启 / 保留旧数据）', /state\.alerts = \{ kind: 'missing'/.test(html) && /api\/alerts 路由尚未加载（HTTP 404）/.test(html) && /noteFailure\('alerts'/.test(html))
check('第一问接告警：高/中 → 「需要你：N 条」', /function renderNeedsAlerts\(/.test(html) && /需要你：/.test(html) && /alertFold/.test(html))
check('无告警明说「当前没有需要你处理的异常」', /当前没有需要你处理的异常/.test(html) && /alertFoldLow/.test(html) && /不占「需要你」计数/.test(html))
check('告警卡字段齐全（严重度/类目/为什么/建议/证据）', /function alertCardHtml\(/.test(html) && ['al-sev', 'al-cat', 'al-subject', 'al-why', 'al-fix', 'al-evi'].every(cls => html.includes('class="' + cls)) && /证据：/.test(html) && /建议：/.test(html))
check('告警三级配色 CSS 在', ['.al-sev.high{', '.al-sev.medium{', '.al-sev.low{', '.alert-card.sev-high{', '.alert-card.sev-medium{', '.alert-card.sev-low{'].every(rule => html.includes(rule)))
check('任务卡命中告警有小标记且可跳转', /function taskAlertFlags\(/.test(html) && /data-alert-jump/.test(html) && /function jumpToAlert\(/.test(html) && /jumpToAlert\(jump\.getAttribute\('data-alert-jump'\)\)/.test(html))
check('告警标记/卡片文本都过 esc()', /esc\(alert\.why/.test(html) && /esc\(alert\.suggestion/.test(html) && /esc\(alert\.categoryLabel/.test(html) && /esc\(alert\.subject/.test(html))
check('告警降级回退旧路径（Host 未重启时行为不变）', /if \(alertsData\(\) !== null\) renderNeedsAlerts\(\)/.test(html) && /else tqFill\('tqNeeds'/.test(html) && /function statusSummaryText\(/.test(html))
check('告警接 30 秒轮询 + body.dataset 标记', /loadAlerts\(\);/.test(html) && /setDatasetFlag\('alerts'/.test(html) && /state\.alerts = \{ kind: 'real'/.test(html))
check('设置页显示告警数据源', /id="setAlerts"/.test(html) && /function alertsSummary\(/.test(html) && /TRAIL 规则 /.test(html))
check('设置页写清告警路由只读与限制', /api\/alerts（TRAIL 规则，只读）/.test(html) || /api\/alerts/.test(html))

/* ---------- 13.9 大管家驾驶舱 M0+M1（0.7.0，只读） + M2 写通道（0.8.0） ---------- */
check('M0 会话清单：路由 + 响应校验 + binding', /fetchJson\('api\/butler\/sessions'/.test(html) && /function isButlerPayload\(/.test(html) && /binding\.resolvedBy/.test(html))
check('M0 会话选择器（选项来自会话清单 + 自动绑定项）', /id="sessionPick"/.test(html) && /自动（配置 \/ 最近根会话）/.test(html) && /function renderSessionPicker\(/.test(html) && /<optgroup/.test(html))
check('M1 对话响应校验 + 窗口参数', /function isDialogPayload\(/.test(html) && /function dialogQuery\(/.test(html) && /DIALOG_LIMIT/.test(html) && /sessionId/.test(html))
check('写通道三层闸门：token 注入 + allowWrite + 只认专属会话', /const INJECTED_WRITE = \/\*__DSH_PANEL_WRITE__\*\/null/.test(html) && /injected\.allowWrite !== true/.test(html) && /binding\.resolvedBy !== 'config'/.test(html) && /function writeChannelState\(/.test(html))
check('写通道默认禁用并写明原因（禁用态不假装能发）', /id="prompt"[^>]*disabled/.test(html) && /id="sendBtn"[^>]*disabled/.test(html) && /写通道不可用：/.test(html) && /id="composerRoTag"/.test(html))
check('每次发送二次确认（没有「不再提醒」）', /id="confirmMask"/.test(html) && /id="confirmSend"/.test(html) && /id="confirmCancel"/.test(html) && /function openSayConfirm\(/.test(html) && /function sendButlerSay\(/.test(html) && /event\.key === 'Enter' && !event\.shiftKey/.test(html) && /mask\.addEventListener\('click'/.test(html))
check('二次确认文案写明会花钱/写历史', /消耗模型额度/.test(html) && /写入对话历史/.test(html) && /不做催办 \/ 中断 \/ 归档/.test(html))
check('写通道错误如实回执（401/403/404/405/429 分支）', /say-route-missing/.test(html) && /say-unreachable/.test(html) && /unsupported === true \? '写通道未加载：'/.test(html) && /function sayResultFromResponse\(/.test(html))
check('附件按钮明确禁用（本轮仅文本，无 hover 假象）', /id="attachBtn"/.test(html) && /本轮仅文本/.test(html) && /aria-disabled="true" disabled/.test(html) && /\.add:disabled\{/.test(html) && /\.add:disabled:hover/.test(html))
check('专属会话 pin 标签「大管家 · 常驻」+ 配置固定文案', /id="bindPinned" hidden>大管家 · 常驻/.test(html) && /配置固定 · 专属会话/.test(html) && /function butlerLabelOf\(/.test(html))
check('领导预设标注：agentPreset → 名字后加「· 领导预设」', /function butlerLabelOf\(/.test(html) && /' · 领导预设'/.test(html) && /binding\.agentPreset/.test(html) && /butlerLabelOf\(bindingOf\(\)\)/.test(html))
check('还没建会话时给「创建专属会话」（ensure），不存在时给「重建专属会话」（rebuild）', /needCreate \? '创建专属会话' : '重建专属会话'/.test(html) && /专属会话尚未创建：/.test(html) && /'rebuild' : 'ensure'/.test(html))
check('专属会话丢失：显示原因 + 重建按钮（不静默回退）', /大管家会话不存在：/.test(html) && /id="rebuildBtn"/.test(html) && /function rebuildButlerSession\(/.test(html) && /missingPinned/.test(html))
check('切到别的会话只读查看（写通道只对专属会话）', /当前查看的是其它会话（只读）/.test(html) && /手动选择 · 只读/.test(html) && /当前是自动绑定：写通道只对配置里的专属大管家会话生效/.test(html))
check('空/不可用诚实提示（找不到会话不编对话）', /真实对话路由尚未加载/.test(html) && /对话不可用：/.test(html) && /该会话还没有消息/.test(html) && /不显示任何示例对话/.test(html))
check('顶部显示绑定会话标题与真实状态点', /id="sessTitle"/.test(html) && /id="dlgStateText"/.test(html) && /id="dlgDot"/.test(html) && /id="bindMode"/.test(html) && /function renderDialogHeader\(/.test(html))
check('轮询：M0 10 秒 / M1 2 秒且隐藏页跳过', /BUTLER_POLL_MS = 10000/.test(html) && /DIALOG_POLL_MS = 2000/.test(html) && /state\.dialog\.kind !== 'real'/.test(html) && /document\.hidden/.test(html))
check('对话计数与工具数进 composer 状态条', /id="pillDialog"/.test(html) && /'消息 ' \+/.test(html) && /' · 工具 ' \+/.test(html))
check('思考默认折叠 / 工具卡 result 截断显示（不塞大输出）', /row\.thinking/.test(html) && /tcard/.test(html) && /result\.summary/.test(html))
check('消息文本全部过 esc()（XSS 防线）', /esc\(text\)/.test(html) && /esc\(row\.name/.test(html) && /esc\(args \|\| '—'\)/.test(html))
check('M1 无可用会话时顶部标题回落主控台（不冒充会话）', /'大管家 · 主控台'/.test(html) && /未绑定/.test(html))
/* ---------- 14. 本机 / 待办能力不退化 ---------- */
check('本机小部件接 api/host 真值', /function renderHostModule\(/.test(html) && /host\.data\.memory/.test(html) && /fmtBytes\(/.test(html))
check('localStorage 待办键存在', /localStorage/.test(html) && /STORE_KEY/.test(html))
check('待办表单/列表/计数 id 齐全', ['todoForm', 'todoInput', 'todoList', 'todoCount', 'storeHint', 'todoSummary', 'clearDone', 'todoEmpty'].every(id => html.includes('id="' + id + '"')))
check('待办在任务页（五页导航内）', /id="page-tasks"[\s\S]*id="todoForm"/.test(html))

/* ---------- 15. id / XSS / 交互 ---------- */
const requiredIds = ['toast', 'chipStale', 'chipStaleText', 'statDevices', 'statBoard', 'sfSub', 'sfDev',
  'sessTitle', 'sessionPick', 'bindMode', 'dlgStateText', 'dlgDot', 'dlgRoTag', 'dialogList', 'dialogEmpty',
  'loadEarlierWrap', 'loadEarlier', 'loadEarlierHint', 'trajBadge', 'pillDialog', 'composerRo',
  'traceDialogue', 'traceTrajectory', 'actionList', 'receiptList', 'clearReceipt',
  'reportPanel', 'reportMeta', 'reportContent', 'closeReport', 'taskList', 'eventList','taskEmpty','eventEmpty',
  'todoForm', 'todoInput', 'todoList', 'todoCount', 'storeHint', 'todoSummary', 'clearDone', 'todoEmpty',
  'topoEdges', 'topoNodes', 'topoSource', 'topoDot', 'topoSourceText', 'topoStamp', 'topoOthers',
  'tree', 'cntT0', 'cntT1', 'cntT2', 'cntT3', 'tierDegraded', 'hier', 'hierScroll', 'drawerBtn', 'hierClose', 'mask', 'tip',
  'boardBadge', 'boardBadgeText', 'recentHint', 'clusterList', 'memoryProbe', 'memoryState', 'memoryBadge', 'memoryBadgeText',
  'setVersion', 'setBoard', 'setOfficial', 'setCluster', 'setHost', 'setTiersSource', 'setButler', 'setPinned', 'setWrite', 'disabledReason', 'sendBtn', 'prompt', 'drawerCount', 'hhDesc', 'tierHint', 'tierSourceHint',
  'statusBar', 'statusToggle', 'statusSummary', 'statusDot', 'statusChips', 'statusDetail',
  'bindPinned', 'bindNote', 'rebuildBtn', 'dlgWriteTag', 'composerRoTag',
  'confirmMask', 'confirmTitle', 'confirmTarget', 'confirmPreview', 'confirmSend', 'confirmCancel', 'dlgStreamBadge',
  'tqNeeds', 'tqNeedsN', 'tqNeedsList', 'tqHealth', 'tqHealthN', 'tqHealthList', 'tqHistory', 'tqHistoryN', 'tqHistoryList',
  'officialCard', 'officialList', 'officialEmpty', 'officialHint', 'officialCount', 'officialLegend', 'setAlerts']
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

/* ---------- 13.9 0.9.0：系统注入默认折叠 + 流式 SSE（调研报告 §5-A2/A3/B3/B6） ---------- */
check('注入折叠用原生 details.ctx-row（默认收起）', /<details class="ctx-row"/.test(html) && /class="ctx-head"/.test(html) && /class="ctx-body"/.test(html))
check('折叠态 24px 一行 + 展开体 141px 滚动 + 11/16 代码字体 + pre-wrap', /\.ctx-head\{[^}]*height:24px/.test(html) && /\.ctx-body\{[^}]*max-height:141px/.test(html) && /\.ctx-body\{[^}]*font:400 11px\/16px var\(--mono\)/.test(html) && /\.ctx-body\{[^}]*white-space:pre-wrap/.test(html))
check('折叠行四段：标签 + source + 摘要 + 行数/大小', /class="ctx-title"/.test(html) && /class="ctx-source"/.test(html) && /class="ctx-summary"/.test(html) && /class="ctx-meta"/.test(html))
check('不再整段直出系统注入（旧 .msg.notice .body 已移除）', !/\.msg\.notice \.body\{/.test(html) && /noticeView\(row\)/.test(html))
check('客户端兜底摘要（host 没给 summary 也能折叠）', /function clientInjectionSummary\(/.test(html) && /function noticeView\(/.test(html) && /row\.sourceLabel/.test(html))
check('展开体 20k 截断并标注', /NOTICE_TEXT_MAX = 20000/.test(html) && /已截断，共 ' \+ view\.chars/.test(html))
check('SSE 只绑绑定会话：EventSource + api/butler/dialog/stream（URL 不带 token）', /new EventSource\(STREAM_PATH \+ '\?sessionId=' \+ encodeURIComponent\(sessionId\)\)/.test(html) && /STREAM_PATH = 'api\/butler\/dialog\/stream'/.test(html) && !/EventSource\([^)]*token/.test(html))
check('live 气泡独立增量渲染且不写进 durable messages', /function liveBubbleInnerHtml\(/.test(html) && /function liveBubbleHtml\(/.test(html) && /live-cursor/.test(html) && /syncDialogLiveNode\(list\)/.test(html) && /list\.appendChild\(dialogLiveNode\)/.test(html) && /commitDialogList\(list, html\)/.test(html) && !/html \+= liveBubbleHtml\(\)/.test(html) && !/state\.dialog\.messages\.push\([^)]*live/.test(html))
check('durable 列表内容未变不写 DOM + 按住指针推迟重建（点击不被吞）', /dialogDurableHtml/.test(html) && /if \(durableHtml !== dialogDurableHtml\)/.test(html) && /if \(dialogPointerDown\) \{ dialogRebuildPending = true; return; \}/.test(html) && /function initDialogPointerGuard\(/.test(html) && /safeStep\('initDialogPointerGuard', initDialogPointerGuard\)/.test(html) && /if \(dialogRebuildPending\) \{/.test(html))
check('live 节点回收：断流/换绑时移除（closeDialogStream + resetDialogRenderCache）', /function resetDialogRenderCache\(/.test(html) && /resetDialogRenderCache\(\)/.test(html) && /dialogLiveNode\.parentNode\.removeChild\(dialogLiveNode\)/.test(html) && /typeof renderDialog === 'function'/.test(html))
check('实时/轮询/离线徽标 + body.dataset.stream', /id="dlgStreamBadge"/.test(html) && /function streamBadge\(kind\)/.test(html) && /'实时' : /.test(html) && /'轮询' : /.test(html) && /'离线'/.test(html) && /document\.body\.dataset\.stream = kind/.test(html))
check('断线退轮询 + 30s 重连 + tick 去抖 + 页面隐藏关 ES', /STREAM_RETRY_MS = 30000/.test(html) && /function fallbackToPolling\(/.test(html) && /STREAM_TICK_DEBOUNCE_MS = 180/.test(html) && /visibilitychange/.test(html) && /closeDialogStream\('hidden'\)/.test(html))
check('end.committed 后清 live 并静默拉 durable（300ms 重试一次）', /function handleStreamEnd\(/.test(html) && /loadDialog\(\{ quiet: true \}\)/.test(html) && /setTimeout\(function \(\) \{ retry\(attempt \+ 1\); \}, 300\)/.test(html))
check('实时态 durable 兜底 8 秒、轮询态保持 2 秒', /STREAM_POLL_MS = 8000/.test(html) && /stream\.kind === 'live' \? STREAM_POLL_MS : DIALOG_POLL_MS/.test(html))
check('SSE 帧处理齐全（hello/start/assistant/reset/end/tick）', ['hello', 'start', 'assistant', 'reset', 'end', 'tick'].every(name => new RegExp("addEventListener\\('" + name + "'").test(html)))

/* ---------- 13.10 0.9.1：自诊断 + SSE 退避 + 抽屉硬化（真机 429 风暴/死点击加固） ---------- */
check('启动期异常红条：window.error/unhandledrejection + #panelDiag', /id = 'panelDiag'/.test(html) && /window\.addEventListener\('error'/.test(html) && /window\.addEventListener\('unhandledrejection'/.test(html) && /window\.__panelReportError/.test(html))
check('init 逐步隔离：safeStep 包住每个 init/render，单步失败不掐断后续', /function safeStep\(label, fn\)/.test(html) && /safeStep\('initNav', initNav\)/.test(html) && /safeStep\('initTodos', initTodos\)/.test(html) && /safeStep\('markState', markState\)/.test(html) && /__panelBootLog/.test(html))
check('SSE 退避：fallback 后 suppressUntil 期间 loadDialog 不再重连（429 风暴修复）', /s\.suppressUntil = Date\.now\(\) \+ STREAM_RETRY_MS/.test(html) && /if \(s\.suppressUntil && Date\.now\(\) < s\.suppressUntil\) return;/.test(html) && /s\.suppressUntil = 0;/.test(html))
check('窄屏遮罩硬化：初始化强制复位 drawer + mask hidden/aria', /safeStep\('resetDrawer'/.test(html) && /mask\.hidden = true; mask\.setAttribute\('aria-hidden', 'true'\)/.test(html) && /mask\.hidden = false; mask\.setAttribute\('aria-hidden', 'false'\)/.test(html))
check('临时自检已移除（避免生产页多一块调试面板）', !html.includes('runPanelSelfTest') && !html.includes('panelSelfTest'))

/* ---------- 13.11 0.9.2：composer 接官方模型（真实 chip/菜单/确认/权限只读） ---------- */
check('模型 chip 是真按钮（不是占位 span）', /id="modelChip"/.test(html) && /<button class="model" type="button" id="modelChip"/.test(html) && !/样式占位/.test(html) && !/DeepSeek V4\.1 Flash <b>Max<\/b>/.test(html))
check('模型菜单是 listbox（官方 catalog 分组 + 选中态 + Esc 关闭）', /id="modelMenu"[^>]*role="listbox"/.test(html) && /model-item/.test(html) && /aria-selected/.test(html) && /closeModelMenu\(\)/.test(html) && /event\.key === 'Escape'/.test(html))
check('模型切换走官方 selectModel + 写 token + 绑定会话 + 一次点击直接生效（0.9.7 去掉二次确认）', /api\/butler\/select-model/.test(html) && /x-butler-write-token/.test(html) && /applyModelSelection\(/.test(html) && /async function sendSelectModel\(selection\)/.test(html) && /reasoningEffort/.test(html) && !/openModelConfirm/.test(html))
check('模型目录读官方 modelCatalog/投影（不写死模型）', /api\/butler\/model-catalog/.test(html) && /currentSource/.test(html) && /projections/.test(html) && /modelDisplayName\(/.test(html))
check('权限徽标只读（无假下拉/假按钮；官方无切已有会话权限的远程方法）', /id="permBadge"[^>]*class="perm-ro"|class="perm-ro"[^>]*id="permBadge"/.test(html) && /权限由桌面端决定/.test(html) && !/权限设置（视觉占位）/.test(html) && !/id="permBadge"[^>]*<button/.test(html))
check('附件按钮明确禁用（本轮仅文本，无 hover 假象）', /id="attachBtn"/.test(html) && /本轮仅文本/.test(html) && /aria-disabled="true"/.test(html) && /\.add:disabled\{/.test(html) && /\.add:disabled:hover/.test(html))

/* ---------- 13.12 0.9.3：dialog 重建统一 + stream 兜底（真机换会话红条 hotfix） ---------- */
check('dialog 重建统一走 resetDialogState（页面无裸 state.dialog = { 赋值）', !/state\.dialog = \{/.test(html) && /function resetDialogState\(patch\)/.test(html) && /live: null/.test(html) && /stream: previous\.stream/.test(html))
check('resetDialogState 同时兜住 live 与 stream（不再漏字段）', /live: null,\n      stream: previous\.stream/.test(html) && /patch\.stream === null/.test(html) && /function freshDialogStream\(/.test(html))
check('stream 读取容错：dialogStreamOf + renderDialogHeader/轮询/可见性三处防御', /function dialogStreamOf\(/.test(html) && /dialogStreamOf\(\)\.kind = kind/.test(html) && /streamBadge\(\(state\.dialog\.stream && state\.dialog\.stream\.kind\) \|\| 'off'\)/.test(html) && /state\.dialog\.stream \|\| freshDialogStream\(\)/.test(html) && /dialogStreamOf\(\)\.suppressUntil = 0/.test(html))
check('会话选择器切会话：先关流再给全新 stream（本次触发点）', /closeDialogStream\('switch'\)/.test(html) && /resetDialogState\(\{ target: target, stream: null \}\)/.test(html))

/* ---------- 13.13 0.9.4：思考档位选择器（官方 reasoning.efforts） ---------- */
check('思考档位控件存在：当前模型 efforts 段 + 选项 + 选中态', /function effortsOfCurrent\(/.test(html) && /model-effort-item/.test(html) && /data-effort/.test(html) && /aria-selected/.test(html) && /思考档位 · /.test(html))
check('空 efforts 模型明确禁用（该模型不支持思考档位，不给假选项）', /model-effort-empty/.test(html) && /该模型不支持思考档位/.test(html) && /modelEfforts\.length === 0/.test(html))
check('chip 显示当前有效档位（显式 effort 优先，其次官方 defaultEffort）', /function effectiveEffortOf\(/.test(html) && /shownEffort/.test(html) && /reasoning\.defaultEffort/.test(html))
check('选档位走同一条写通道 + 一次点击直接生效（0.9.7 去掉二次确认，换档=重写模型选择）', /model-effort-item/.test(html) && /applyModelSelection\(current\.provider, current\.model, effort\)/.test(html) && /function applyModelSelection\(/.test(html) && !/把思考档位改成 /.test(html))
/* 0.9.6：档位段在菜单最上方（原来排在 27 个模型之后，被挤出滚动区，等于选不到）。 */
check('0.9.6 档位段排在模型列表之前（打开菜单第一眼可见）', html.indexOf("'思考档位 · '") > -1 && html.indexOf("'思考档位 · '") < html.indexOf('catalog.groups.forEach'))
/* 0.9.7：正文确认弹窗只服务于「发消息」，不再有模型/档位确认分支。 */
check('0.9.7 去掉模型/档位二次确认（确认框只剩发消息一条路径）', !/openModelConfirm/.test(html) && !/kind: 'model'/.test(html) && /id="confirmMask"/.test(html) && /function openSayConfirm\(/.test(html))

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
