#!/usr/bin/env node
/**
 * tools/check-page.mjs —— `public/index.html` 的静态自检（零依赖，Node 18+）。
 *
 * 用法: node tools/check-page.mjs [页面文件] [--json <输出文件>]
 *       默认页面是本包的 public/index.html。
 *
 * 和上一版检查的区别（本轮页面接了同源真实数据）：
 *   - 仍然**禁止任何外部 URL**（http(s)://、协议相对地址、<link>、@import、
 *     <script src>、<img src>、<iframe>、XHR、WebSocket、非 data: 的 url()）；
 *   - `fetch()` 从「一律禁止」改成「只允许同源相对路径」：逐个检查 fetch 的字符串
 *     参数，带 scheme 或 `//` 开头就失败，并要求页面确实 fetch 了 `api/cluster`；
 *   - 新增真实数据落点断言：mockView / realView 都在、renderTopology 接视图模型、
 *     四槽位 id 与 5 条边、badge 元素齐全、title 里不许再出现「最后心跳」。
 *
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

/* ---------- 3. fetch 只允许同源相对路径 ---------- */
const fetchArgs = [...html.matchAll(/\bfetch\s*\(\s*([^)]*)/g)].map(m => m[1].trim())
const externalFetch = fetchArgs.filter(arg => {
  const literal = /^['"`]([^'"`]*)['"`]/.exec(arg)
  if (!literal) return false // 变量参数：页面里没有，出现就当外部查询人工复核
  const value = literal[1].trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')
})
check('fetch 只有同源相对路径', fetchArgs.length > 0 && externalFetch.length === 0, externalFetch.join(' | ') || '共 ' + fetchArgs.length + ' 处 fetch，参数均为相对路径')
check('页面 fetch 的是 api/cluster', fetchArgs.some(arg => /^['"`]api\/cluster['"`]/.test(arg)), fetchArgs.join(' | '))

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

/* ---------- 6. MOCK 与真实数据落点 ---------- */
check('MOCK 常量唯一存在', (html.match(/const\s+MOCK\s*=/g) || []).length === 1, '共 ' + (html.match(/const\s+MOCK\s*=/g) || []).length + ' 处定义')
check('MOCK 含 topology 段', /topology\s*:/.test(html))
check('拓扑四槽位 id 齐全', ['mcloud', 'pc-ky614', 'server', 's5'].every(id => new RegExp("id:\\s*'" + id + "'").test(html)), '')
check('拓扑 5 条边', /edges:\s*\[\[/.test(html) && (html.match(/\['(?:mcloud|pc-ky614|server|s5)',\s*'(?:mcloud|pc-ky614|server|s5)'\]/g) || []).length === 5, '')
check('mock 兜底视图存在（mockView）', /function mockView\(\)/.test(html))
check('真实数据视图存在（realView）', /function realView\(data\)/.test(html))
check('渲染函数只有一份且接视图模型', /function renderTopology\(view\)/.test(html) && /renderTopology\(mockView\(\)\)/.test(html) && /renderTopology\(realView\(data\)\)/.test(html))
check('三态都落到 DOM 类上', ["'online'", "'offline'", "'unknown'"].every(s => html.includes(s)))
check('badge 元素齐全', ['topoSource', 'topoDot', 'topoSourceText', 'topoStamp', 'topoOthers'].every(id => new RegExp('id="' + id + '"').test(stripRawText(html))))
check('真实/兜底两种 badge 文案', html.includes('真实 · interconnect') && html.includes('mock 兜底 · 真实数据不可用'))
check('title 不再编造心跳', !/最后心跳/.test(html) && !/heartbeat/.test(html))
check('未知态写清「未在 interconnect 配置」', html.includes('未在 interconnect 配置'))
check('其它已配置对端一行', html.includes('其它已配置对端'))

/* ---------- 7. 拓扑 SVG ---------- */
check('使用 inline SVG（非 canvas）', /<svg\b/i.test(html) && !/<canvas\b/i.test(html))
check('拓扑 SVG 有 viewBox', /viewBox="0 0 1000 300"/.test(html))
check('拓扑 SVG 有 preserveAspectRatio', /preserveAspectRatio="xMidYMid meet"/.test(html))
check('拓扑 SVG 有 <title>/<desc>', /id="topoTitle"/.test(html) && /id="topoDesc"/.test(html))
check('拓扑节点容器存在', /id="topoEdges"/.test(html) && /id="topoNodes"/.test(html))
check('节点可键盘聚焦（tabindex）', /tabindex="0"/.test(html))

/* ---------- 8. 关键 id / V4 交互 / 存储不退化 ---------- */
const requiredIds = ['clock', 'greeting', 'dateLine', 'actionList', 'receiptList', 'taskList', 'docList',
  'todoForm', 'todoInput', 'todoList', 'todoCount', 'storeHint', 'toast', 'topoEdges', 'topoNodes']
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
