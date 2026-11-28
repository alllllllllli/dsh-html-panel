#!/usr/bin/env node
/**
 * tools/state-restore.test.mjs —— 页面侧「永续常驻」恢复层**纯函数**的单元测试。
 *
 * 用法: node --test tools/state-restore.test.mjs
 *
 * 被测代码在 public/index.html 的
 *   /* __DSHHP_STATE_BEGIN__ *\/ ... /* __DSHHP_STATE_END__ *\/
 * 之间（不碰 DOM / 网络），这里把它抽出来在 node:vm 里跑，断言：
 *   - storage 键统一 dshhp: 前缀与固定结构；
 *   - 页 / 页签 / 状态条 / 游标 / 滚动位置的序列化校验与「失效回退 + 原因」；
 *   - 会话恢复：清单可用时校验、不可用时 pending、失效时回退自动绑定；
 *   - 未读计数与 N+ 截断口径（游标未知不显示假值）；
 *   - continuity / context / digest 三条新路由的展示与降级文案。
 * 另外断言页面两段内联脚本都能被解析（改大文件时防手滑语法错）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
const BEGIN = '/* __DSHHP_STATE_BEGIN__ */'
const END = '/* __DSHHP_STATE_END__ */'
const beginAt = html.indexOf(BEGIN)
const endAt = html.indexOf(END)
assert.ok(beginAt >= 0, '恢复层纯函数块有 BEGIN 标记')
assert.ok(endAt > beginAt, '恢复层纯函数块有 END 标记')

/** 页面内联脚本逐个解析（只解析不执行），防止改大文件时语法错漏过 check-page。 */
function assertPageScriptsParse() {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.equal(blocks.length, 2, '页面两段内联脚本')
  blocks.forEach((block, index) => {
    assert.doesNotThrow(() => new Function(block[2]), '内联脚本 #' + index + ' 可解析')
  })
}

/** 把纯函数块放进一个干净上下文执行，取它挂到 window 上的入口。 */
function loadRestoreApi() {
  const sandbox = { window: {} }
  vm.createContext(sandbox)
  vm.runInContext(html.slice(beginAt, endAt), sandbox, { filename: 'public/index.html#state-restore' })
  const api = sandbox.window.__dshhpState
  assert.ok(api && typeof api === 'object', 'window.__dshhpState 已挂载')
  return api
}

const api = loadRestoreApi()

test('页面两段内联脚本可解析', () => {
  assertPageScriptsParse()
})

test('storage 键统一 dshhp: 前缀且结构固定', () => {
  assert.equal(api.PREFIX, 'dshhp:')
  assert.deepEqual(Object.keys(api.KEYS).sort(), ['cursors', 'page', 'scroll', 'session', 'statusBar', 'tab'])
  for (const [name, key] of Object.entries(api.KEYS)) {
    assert.ok(key.startsWith('dshhp:'), name + ' 键带前缀：' + key)
  }
  assert.deepEqual([...api.PAGES], ['butler', 'tasks', 'cluster', 'memory', 'settings'])
  assert.deepEqual([...api.TABS], ['dialogue', 'trajectory'])
})

test('页恢复：无记录用默认；合法值恢复；失效值回退大管家并给原因', () => {
  assert.deepEqual({ ...api.parsePage(undefined) }, { value: 'butler', reason: '' })
  assert.deepEqual({ ...api.parsePage('  tasks ') }, { value: 'tasks', reason: '' })
  const bad = api.parsePage('nowhere')
  assert.equal(bad.value, 'butler')
  assert.match(bad.reason, /已回退「大管家」/)
  assert.match(bad.reason, /nowhere/)
})

test('页签恢复：对话 / 轨迹；失效回退对话并给原因', () => {
  assert.equal(api.parseTab('trajectory').value, 'trajectory')
  assert.equal(api.parseTab('').value, 'dialogue')
  const bad = api.parseTab('settings2')
  assert.equal(bad.value, 'dialogue')
  assert.match(bad.reason, /已回退「对话」/)
})

test('状态条展开态：1/0 还原，坏值回退收起并给原因', () => {
  assert.equal(api.parseStatusBar('1').value, true)
  assert.equal(api.parseStatusBar('0').value, false)
  assert.equal(api.parseStatusBar(undefined).value, false)
  const bad = api.parseStatusBar('yes')
  assert.equal(bad.value, false)
  assert.match(bad.reason, /已回退收起/)
})

test('游标表：坏 JSON / 负数 / 非数字整条丢弃，只保留正整数 seq', () => {
  assert.deepEqual({ ...api.parseCursors('{"a":12,"b":0,"c":-3,"d":"9","e":2.8,"":5}') }, { a: 12, e: 2 })
  assert.deepEqual({ ...api.parseCursors('[1,2,3]') }, {})
  assert.deepEqual({ ...api.parseCursors('not-json') }, {})
  assert.deepEqual({ ...api.parseCursors(null) }, {})
})

test('滚动表：0 与正数保留，负数 / 字符串丢弃', () => {
  assert.deepEqual({ ...api.parseScroll('{"s1":0,"s2":420,"s3":-1,"s4":"88"}') }, { s1: 0, s2: 420 })
  assert.deepEqual({ ...api.parseScroll('{}') }, {})
})

test('会话恢复：清单可用才校验；失效回退自动绑定并给原因', () => {
  assert.deepEqual({ ...api.resolveSession('', ['a']) }, { value: '', reason: '', pending: false })
  assert.deepEqual({ ...api.resolveSession('a', ['a', 'b']) }, { value: 'a', reason: '', pending: false })
  const pending = api.resolveSession('gone', null)
  assert.deepEqual({ ...pending }, { value: 'gone', reason: '', pending: true })
  const bad = api.resolveSession('gone', ['a', 'b'])
  assert.equal(bad.value, '')
  assert.equal(bad.pending, false)
  assert.match(bad.reason, /已回退自动绑定/)
})

test('未读：seq 大于游标才算；游标未知不显示假值；整窗都是新的标 N+', () => {
  const messages = [{ seq: 101 }, { seq: 104 }, { seq: 110 }]
  assert.deepEqual({ ...api.unread(messages, 100, 30) }, { count: 3, capped: false, known: true })
  assert.deepEqual({ ...api.unread(messages, 104, 30) }, { count: 1, capped: false, known: true })
  assert.deepEqual({ ...api.unread(messages, 110, 30) }, { count: 0, capped: false, known: true })
  assert.deepEqual({ ...api.unread(messages, null, 30) }, { count: 0, capped: false, known: false })
  assert.deepEqual({ ...api.unread(messages, 100, 3) }, { count: 3, capped: true, known: true })
  assert.deepEqual({ ...api.unread('nope', 100) }, { count: 0, capped: false, known: false })
})

test('未读徽标文案：0 / 未知隐藏，截断显示 N+', () => {
  assert.deepEqual({ ...api.unreadBadge({ count: 3, capped: false, known: true }) }, { text: '3', hidden: false, count: 3 })
  assert.deepEqual({ ...api.unreadBadge({ count: 30, capped: true, known: true }) }, { text: '30+', hidden: false, count: 30 })
  assert.equal(api.unreadBadge({ count: 0, capped: false, known: true }).hidden, true)
  assert.equal(api.unreadBadge({ count: 0, capped: false, known: false }).hidden, true)
  assert.equal(api.unreadBadge(null).hidden, true)
})

test('游标推进：data.cursor 与窗口内最大 message.seq 取大者', () => {
  assert.equal(api.nextCursor({ cursor: 9, messages: [{ seq: 12 }, { seq: 8 }] }), 12)
  assert.equal(api.nextCursor({ cursor: 20, messages: [{ seq: 12 }] }), 20)
  assert.equal(api.nextCursor({ messages: [{ seq: 5 }] }), 5)
  assert.equal(api.nextCursor({ cursor: 0, messages: [] }), null)
  assert.equal(api.nextCursor(null), null)
})

test('常驻时长：人话格式 + firstBoundAt 兜底', () => {
  const now = Date.parse('2026-11-28T12:00:00.000Z')
  assert.equal(api.uptime(90_000), '1 分钟')
  assert.equal(api.uptime(2 * 3_600_000 + 120_000), '2 小时 2 分')
  assert.equal(api.uptime(3 * 86_400_000 + 4 * 3_600_000), '3 天 4 小时')
  assert.equal(api.uptime(30_000), '不到 1 分钟')
  assert.equal(api.uptime(-1), '')
  assert.equal(api.uptime(undefined, '2026-11-28T09:00:00.000Z', now), '3 小时')
})

test('continuity：可用时给时长/次数，404 或 unavailable 时给「未知」不报错', () => {
  const ok = api.continuityView({ ok: true, available: true, uptimeMs: 3_600_000, rebuildCount: 2, source: 'config' })
  assert.equal(ok.ok, true)
  assert.equal(ok.uptimeText, '常驻 1 小时')
  assert.equal(ok.rebuildText, '重建 2 次')
  assert.match(ok.title, /api\/butler\/continuity/)
  for (const payload of [null, { ok: false, reason: 'HTTP 404' }, { ok: true, available: false, reason: '无绑定' }]) {
    const view = api.continuityView(payload)
    assert.equal(view.ok, false)
    assert.equal(view.uptimeText, '常驻 未知')
    assert.equal(view.rebuildText, '重建 未知')
    assert.match(view.title, /不可用/)
  }
})

test('context pill：used/limit 百分比；>80% 警示；100% / 不可用降级未知', () => {
  const normal = api.contextPillView({ ok: true, used: 12, limit: 100 })
  assert.equal(normal.text, '上下文 12%')
  assert.equal(normal.tone, '')
  assert.match(normal.title, /12\/100/)
  const warn = api.contextPillView({ ok: true, used: 85, limit: 100 })
  assert.equal(warn.text, '上下文 85%')
  assert.equal(warn.tone, 'warn')
  const full = api.contextPillView({ ok: true, used: 100, limit: 100 })
  assert.equal(full.text, '上下文 未知')
  assert.equal(full.tone, 'warn')
  const unknown = api.contextPillView(null)
  assert.equal(unknown.text, '上下文 未知')
  assert.equal(unknown.tone, 'muted')
  const broken = api.contextPillView({ ok: true, used: 'x', limit: 0 })
  assert.equal(broken.text, '上下文 未知')
})

test('digest：counts + 前几条 items；counts 为 null 显示「—」不冒充 0；未知 kind 不隐藏', () => {
  const view = api.digestView({
    ok: true, date: '2026-11-28', source: 'api/board', coverage: 'partial',
    counts: { done: 3, dispatched: null, alerts: 1 },
    degraded: { reasons: ['共享板只保留最近 12 条事件'] },
    items: [
      { kind: 'task.done', text: '收尾验收', at: '2026-11-28T10:00:00.000Z' },
      { kind: 'task.dispatched', text: '派活给 server', at: 1732788000000 },
      { kind: 'weird', text: '未知类型' },
      null,
    ],
  })
  assert.equal(view.ok, true)
  assert.equal(view.countsText, '完成 3 · 派发 — · 告警 1')
  assert.deepEqual({ ...view.counts }, { done: 3, dispatched: null, alerts: 1 })
  assert.equal(view.coverage, 'partial')
  assert.deepEqual([...view.degraded], ['共享板只保留最近 12 条事件'])
  assert.equal(view.items.length, 3)
  assert.equal(view.items[0].kind, '完成')
  assert.equal(view.items[1].kind, '派发')
  assert.equal(view.items[2].kind, 'weird')
  assert.equal(view.empty, false)
  const empty = api.digestView({ ok: true, counts: {}, items: [] })
  assert.equal(empty.empty, true)
  assert.equal(empty.countsText, '完成 — · 派发 — · 告警 —')
  const fail = api.digestView({ ok: false, reason: 'HTTP 404' })
  assert.equal(fail.ok, false)
  assert.equal(fail.empty, true)
})
