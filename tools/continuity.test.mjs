#!/usr/bin/env node
/**
 * tools/continuity.test.mjs —— `lib/butler-continuity.js` + `lib/butler-state.js`
 * （1.1.0 永续常驻）的单元测试。
 *
 * 零依赖，`node --test`：不需要起 DSH、不需要真的会话/网络；全部用假 Host 服务 mock，
 * **不碰任何真实会话与真实 profile 数据**（落盘目录是 os.tmpdir() 下的临时目录）。
 *
 * 覆盖：
 *   continuity（常驻会话自续）
 *   - 正常观测：firstBoundAt=会话创建时间、lastSeenAt=观测时刻、uptimeMs/rebuildCount/source；
 *   - 写盘节流：60 s 内重复轮询不重复写 lastSeenAt，超过间隔才更新；
 *   - 会话丢失 → available:false + reason，**不写配置**（config 原样、sessionId 不变）；
 *   - 重建识别：sessionId 变化 → rebuildCount+1、firstBoundAt 按新会话重算；
 *   - 状态文件损坏 → 仍给 live 结论、source 标 corrupt、不删原文件；
 *   - 会话读取器抛错 → ok:true + available:false + 人话原因。
 *   digest（按天归档摘要）
 *   - 今天：共享板事件 → done/dispatched 计数 + 明细；告警按快照时刻归属；
 *     归档落盘 `${root}/digests/<date>.json`；缓存窗口内复用 → source:'archive'；
 *   - 幂等：同一批输入在同一 now 下重复生成，counts/items 完全一致；
 *   - 过去日期：只读归档（source:'archive'），没有归档 → ok:false/source:'unavailable'；
 *   - 数据源降级：共享板不可用但告警可用 → ok:true、counts.done/dispatched=null；
 *     全部不可用 → ok:false、counts 全 null、items 空；非法 date → ok:false 不猜日期。
 *   context（上下文预算）
 *   - 活会话 + tokenMeter → used/limit/percent + compaction 计数（真实日志事件）；
 *   - 冷会话 / tokenMeter 缺失 / 无提供方用量 → ok:false + reason（绝不估算）。
 *   路由
 *   - apply() 真接线：GET api/butler/continuity|digest|context 契约、HEAD、POST 405。
 *
 * 用法: node --test tools/continuity.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BUTLER_CONTEXT_FILE, BUTLER_CONTINUITY_FILE, BUTLER_DIGEST_FILE,
  CONTEXT_SCAN_MAX_EVENTS, CONTINUITY_PERSIST_INTERVAL_MS, DIGEST_CACHE_MS,
  buildButlerContext, buildButlerContinuity, buildButlerDigest, countCompactions,
} from '../lib/butler-continuity.js'
import {
  STATE_DIR_NAME, continuityPathOf, dayWindowOf, digestPathOf, localDateOf, writeJsonAtomic,
} from '../lib/butler-state.js'
import { apply, ROUTE_PREFIX } from '../lib/index.js'

/* ─────────────────────────── 固定时刻 & 小工具 ─────────────────────────── */

/** 本地 2026-11-28 10:00:00（digest 按本地时区分天，测试用本地 Date 构造）。 */
const NOW = new Date(2026, 10, 28, 10, 0, 0).getTime()
const TODAY = localDateOf(NOW)
const MIN = 60000

/** 当天本地 h:m 的毫秒时间戳。 */
function at(hour, minute = 0) {
  return new Date(2026, 10, 28, hour, minute, 0).getTime()
}

/** 昨天本地日期串。 */
function yesterdayOf(dateText) {
  const [year, month, day] = dateText.split('-').map(Number)
  return localDateOf(new Date(year, month - 1, day - 1, 12, 0, 0).getTime())
}

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'panel-continuity-'))
}

/** 假 butler reader：`readSessions()` 返回给定快照。 */
function fakeReader(body) {
  return { readSessions: async () => body }
}

/** 会话快照：pinned 会话 + 可选的 binding。 */
function sessionsBody({ sessionId = 'session-a', title = '大管家 · 常驻', available = true, startedAt = null, reason = null } = {}) {
  const nodes = available || startedAt !== null
    ? [{
      id: sessionId,
      title,
      tier: 1,
      kind: 'session',
      device: 'pc-ky614',
      status: 'idle',
      startedAt,
      readonly: false,
      controllable: true,
    }]
    : []
  return {
    generatedAt: new Date(NOW).toISOString(),
    nodes,
    binding: {
      sessionId,
      title,
      label: '大管家 · 常驻',
      targetMode: 'pinned',
      resolvedBy: 'config',
      available,
      ...(reason === null ? {} : { reason }),
    },
  }
}

function configOf(sessionId, extra = {}) {
  return {
    butler: {
      sessionId,
      targetMode: 'pinned',
      label: '大管家 · 常驻',
      allowWrite: false,
      agentPreset: 'butler-lead',
      ...extra,
    },
  }
}

/** 共享板成功响应体（`api/board` 形状）。 */
function boardBody(events = []) {
  return {
    generatedAt: new Date(NOW).toISOString(),
    configured: true,
    source: { origin: 'http://127.0.0.1:13090' },
    health: { ok: true, latencyMs: 1 },
    tasks: [],
    events,
    official: { available: true, teams: [], tasks: [], hiddenTasks: 0, truncated: false },
    cached: false,
  }
}

/** 共享板失败响应体（`lib/board.js` 的 failureBody 形状：有 error、events=[]）。 */
function boardFailure() {
  return {
    generatedAt: new Date(NOW).toISOString(),
    configured: true,
    source: { origin: 'http://127.0.0.1:13090' },
    health: null,
    tasks: [],
    events: [],
    official: { available: false, reason: '不可用', teams: [], tasks: [], hiddenTasks: 0, truncated: false },
    cached: false,
    error: { code: 'unreachable', message: '连不上共享板' },
  }
}

/** 告警快照（`api/alerts` 形状子集）。 */
function alertsBody(alerts = [], generatedAt = NOW) {
  return {
    generatedAt: new Date(generatedAt).toISOString(),
    source: { classifier: 'trail-rules-v1', cached: false, ageMs: 0 },
    counts: { total: alerts.length },
    alerts,
    degraded: { reasons: [] },
  }
}

/** 一个活 Session 的假实现：`seq` + `eventAt(i)`。 */
function fakeSession(id, events) {
  return {
    id,
    seq: events.length,
    eventAt: index => events[index] ?? undefined,
  }
}

/** 一个含 2 次成功压缩的会话日志。 */
function sessionWithCompactions(id = 'session-a') {
  return fakeSession(id, [
    { type: 'user/message', seq: 0, time: at(9, 0), data: {} },
    { type: 'compaction/start', seq: 1, time: at(9, 10), data: {} },
    { type: 'compaction/summary', seq: 2, time: at(9, 11), data: {} },
    { type: 'compaction/end', seq: 3, time: at(9, 12), data: {} },
    { type: 'compaction/start', seq: 4, time: at(9, 30), data: {} },
    { type: 'compaction/summary', seq: 5, time: at(9, 31), data: {} },
    { type: 'compaction/end', seq: 6, time: at(9, 32), data: { error: { code: 'x' } } },
    { type: 'assistant/message', seq: 7, time: at(9, 40), data: {} },
  ])
}

/* ─────────────────────────── A. continuity ─────────────────────────── */

test('continuity：正常观测给出 firstBoundAt/lastSeenAt/uptimeMs/rebuildCount 并落盘', async () => {
  const root = await tempRoot()
  try {
    const startedAt = new Date(2026, 10, 28, 8, 0, 0).toISOString()
    const body = await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ startedAt })),
      config: configOf('session-a'),
      root,
      now: () => NOW,
    })
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 'session-a')
    assert.equal(body.available, true)
    assert.equal(body.reason, null)
    assert.equal(body.firstBoundAt, Date.parse(startedAt), '首次绑定时间取会话创建时间，不取现在')
    assert.equal(body.lastSeenAt, NOW)
    assert.equal(body.uptimeMs, NOW - Date.parse(startedAt))
    assert.equal(body.rebuildCount, 0)
    assert.match(body.source, /sessionController\.list/)
    assert.match(body.source, /continuity\.json/)
    assert.equal(body.stateReadable, false, '首次运行状态文件还不存在')
    assert.equal(body.stateWritable, true)

    const saved = JSON.parse(await readFile(continuityPathOf(root), 'utf8'))
    assert.equal(saved.sessionId, 'session-a')
    assert.equal(saved.firstBoundAt, Date.parse(startedAt))
    assert.equal(saved.lastSeenAt, NOW)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('continuity：60 秒内重复轮询不重复写 lastSeenAt，超过间隔才更新', async () => {
  const root = await tempRoot()
  try {
    const startedAt = new Date(2026, 10, 28, 8, 0, 0).toISOString()
    const reader = () => fakeReader(sessionsBody({ startedAt }))
    const config = configOf('session-a')
    const first = await buildButlerContinuity({ reader, config, root, now: () => NOW })
    const firstFile = await readFile(continuityPathOf(root), 'utf8')

    const early = await buildButlerContinuity({ reader, config, root, now: () => NOW + 10000 })
    assert.equal(early.lastSeenAt, first.lastSeenAt, '10 s 后的轮询不应刷新 lastSeenAt')
    assert.equal(await readFile(continuityPathOf(root), 'utf8'), firstFile, '没有变化就不写盘')

    const late = await buildButlerContinuity({ reader, config, root, now: () => NOW + CONTINUITY_PERSIST_INTERVAL_MS + 1000 })
    assert.equal(late.lastSeenAt, NOW + CONTINUITY_PERSIST_INTERVAL_MS + 1000, '超过间隔后刷新存活时间')
    const lateFile = JSON.parse(await readFile(continuityPathOf(root), 'utf8'))
    assert.equal(lateFile.lastSeenAt, late.lastSeenAt)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('continuity：会话丢失 → available:false + reason，绝不改配置', async () => {
  const root = await tempRoot()
  try {
    const startedAt = new Date(2026, 10, 28, 8, 0, 0).toISOString()
    await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ startedAt })),
      config: configOf('session-a'),
      root,
      now: () => NOW,
    })

    const config = configOf('session-a')
    const snapshot = JSON.stringify(config)
    const body = await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ sessionId: 'session-a', available: false, reason: 'config.butler.sessionId 指向的专属大管家会话已不可见' })),
      config,
      root,
      now: () => NOW + 5 * MIN,
    })
    assert.equal(body.ok, true)
    assert.equal(body.available, false)
    assert.match(body.reason, /不可见|不存在|不在/)
    assert.equal(body.sessionId, 'session-a')
    assert.equal(body.lastSeenAt, NOW, '会话丢了就保留上一次存活时间，不刷新')
    assert.equal(body.rebuildCount, 0, '同一个 sessionId 不算重建')
    assert.equal(JSON.stringify(config), snapshot, '配置对象必须一个字节都不变')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('continuity：sessionId 变化 → rebuildCount+1、firstBoundAt 按新会话重算', async () => {
  const root = await tempRoot()
  try {
    const firstStart = new Date(2026, 10, 28, 8, 0, 0).toISOString()
    await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ sessionId: 'session-a', startedAt: firstStart })),
      config: configOf('session-a'),
      root,
      now: () => NOW,
    })

    const secondStart = new Date(2026, 10, 28, 9, 30, 0).toISOString()
    const body = await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ sessionId: 'session-b', title: '大管家 · 常驻（重建）', startedAt: secondStart })),
      config: configOf('session-b'),
      root,
      now: () => NOW + MIN,
    })
    assert.equal(body.sessionId, 'session-b')
    assert.equal(body.available, true)
    assert.equal(body.rebuildCount, 1)
    assert.equal(body.firstBoundAt, Date.parse(secondStart))
    assert.equal(body.uptimeMs, NOW + MIN - Date.parse(secondStart))
    const saved = JSON.parse(await readFile(continuityPathOf(root), 'utf8'))
    assert.equal(saved.rebuildCount, 1)
    assert.equal(saved.sessionId, 'session-b')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('continuity：状态文件损坏 → 先留带时间戳备份再重写，live 结论照常', async () => {
  const root = await tempRoot()
  try {
    const corruptText = '{ 这不是 JSON'
    await writeFile(continuityPathOf(root), corruptText, 'utf8')
    const startedAt = new Date(2026, 10, 28, 8, 0, 0).toISOString()
    const body = await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ startedAt })),
      config: configOf('session-a'),
      root,
      now: () => NOW,
    })
    assert.equal(body.ok, true)
    assert.equal(body.available, true)
    assert.equal(body.stateReadable, false)
    assert.match(body.source, /continuity\.json\(corrupt\)/, '降级原因要出现在 source 里')
    assert.equal(body.firstBoundAt, Date.parse(startedAt), '读不到记录就退回会话创建时间')
    assert.equal(typeof body.stateBackup, 'string', '损坏文件必须先备份再覆盖')
    assert.equal(await readFile(body.stateBackup, 'utf8'), corruptText, '备份内容 = 原损坏文件')
    const rewritten = JSON.parse(await readFile(continuityPathOf(root), 'utf8'))
    assert.equal(rewritten.sessionId, 'session-a')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('continuity：首次观测就会话缺失 → 不编 firstBoundAt/lastSeenAt（available:false）', async () => {
  const root = await tempRoot()
  try {
    const body = await buildButlerContinuity({
      reader: () => fakeReader(sessionsBody({ sessionId: 'session-a', available: false, reason: '会话不在可见列表里' })),
      config: configOf('session-a'),
      root,
      now: () => NOW,
    })
    assert.equal(body.ok, true)
    assert.equal(body.available, false)
    assert.equal(body.firstBoundAt, null, '没观测到会话就不编首次绑定时间')
    assert.equal(body.lastSeenAt, null)
    assert.equal(body.uptimeMs, null)
    assert.equal(body.rebuildCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('continuity：会话读取器抛错 → ok:true + available:false + 人话原因（不外泄异常）', async () => {
  const root = await tempRoot()
  try {
    const body = await buildButlerContinuity({
      reader: () => ({ readSessions: async () => { throw new Error('boom: C:\\secret.txt') } }),
      config: configOf('session-a'),
      root,
      now: () => NOW,
    })
    assert.equal(body.ok, true)
    assert.equal(body.available, false)
    assert.match(body.reason, /会话清单读取失败/)
    assert.ok(!body.reason.includes('secret'), '原始异常文本不外泄')
    assert.equal(body.lastSeenAt, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ─────────────────────────── B. digest ─────────────────────────── */

test('digest：今天从共享板聚合 done/dispatched + 告警，落盘后缓存命中', async () => {
  const root = await tempRoot()
  try {
    const events = [
      { task: 't-1', at: at(9, 0), kind: 'task.done', text: '任务完成', node: 'pc', seq: 3 },
      { task: 't-2', at: at(9, 20), kind: 'task.dispatched', text: '派给 server', node: 'pc', seq: 2 },
      { task: 't-3', at: at(8, 0) - 24 * 60 * MIN, kind: 'task.done', text: '昨天的', node: 'pc', seq: 1 },
    ]
    const deps = {
      board: { read: async () => boardBody(events) },
      alerts: { read: async () => alertsBody([{ severity: 'high', category: 'Timeout', subject: '租约过期', why: 't-9 的租约已过期' }]) },
      root,
      now: () => NOW,
    }
    const body = await buildButlerDigest(deps, new URLSearchParams('days=7'))
    assert.equal(body.ok, true)
    assert.equal(body.date, TODAY)
    assert.equal(body.source, 'api/board+api/alerts')
    assert.deepEqual(body.counts, { done: 1, dispatched: 1, alerts: 1 })
    assert.equal(body.items.length, 3)
    assert.equal(body.items[0].kind, 'alert', '明细按时间倒序：告警快照在 10:00，最晚')
    assert.ok(body.items.every(item => typeof item.kind === 'string' && typeof item.text === 'string'))
    assert.equal(body.archived, true)

    const archive = JSON.parse(await readFile(digestPathOf(root, TODAY), 'utf8'))
    assert.equal(archive.date, TODAY)
    assert.equal(archive.ok, true)
    assert.deepEqual(archive.counts, body.counts)

    const again = await buildButlerDigest(deps, new URLSearchParams('days=7'))
    assert.equal(again.source, 'archive')
    assert.equal(again.cached, true)
    assert.deepEqual(again.counts, body.counts)
    assert.deepEqual(again.items, body.items)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest：同一批输入重复生成幂等（缓存过期后重算，counts/items 不变）', async () => {
  const root = await tempRoot()
  try {
    const events = [
      { task: 't-1', at: at(9, 0), kind: 'task.done', text: '任务完成', node: 'pc', seq: 1 },
    ]
    const make = now => ({
      board: { read: async () => boardBody(events) },
      alerts: { read: async () => alertsBody([]) },
      root,
      now: () => now,
    })
    const first = await buildButlerDigest(make(NOW), new URLSearchParams(''))
    const second = await buildButlerDigest(make(NOW + DIGEST_CACHE_MS + 1000), new URLSearchParams(''))
    assert.equal(second.source, 'api/board+api/alerts')
    assert.deepEqual(second.counts, first.counts)
    assert.deepEqual(second.items, first.items)
    const archive = JSON.parse(await readFile(digestPathOf(root, TODAY), 'utf8'))
    assert.equal(archive.generatedAt, new Date(NOW + DIGEST_CACHE_MS + 1000).toISOString(), '归档被覆盖为最新一次生成')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest：过去日期只读归档；没有归档就 ok:false（不估算）', async () => {
  const root = await tempRoot()
  try {
    const date = yesterdayOf(TODAY)
    const window = dayWindowOf(date)
    assert.ok(window !== null)

    const missing = await buildButlerDigest({ root, now: () => NOW }, new URLSearchParams('date=' + date))
    assert.equal(missing.ok, false)
    assert.equal(missing.source, 'unavailable')
    assert.match(missing.reason, /没有归档/)
    assert.deepEqual(missing.counts, { done: null, dispatched: null, alerts: null })
    assert.deepEqual(missing.items, [])

    const saved = await writeJsonAtomic(digestPathOf(root, date), {
      schemaVersion: 1,
      ok: true,
      date,
      generatedAt: new Date(window.start + 12 * 60 * MIN).toISOString(),
      source: 'api/board',
      counts: { done: 3, dispatched: 2, alerts: 1 },
      items: [{ kind: 'task.done', text: '归档条目', at: window.start + 1000 }],
      coverage: 'full',
    })
    assert.equal(saved.ok, true)
    const archived = await buildButlerDigest({ root, now: () => NOW }, new URLSearchParams('date=' + date + '&days=7'))
    assert.equal(archived.ok, true)
    assert.equal(archived.source, 'archive')
    assert.deepEqual(archived.counts, { done: 3, dispatched: 2, alerts: 1 })
    assert.equal(archived.items.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest：共享板不可用但告警可用 → ok:true，done/dispatched=null（不编 0）', async () => {
  const root = await tempRoot()
  try {
    const body = await buildButlerDigest({
      board: { read: async () => boardFailure() },
      tiers: { read: async () => { throw new Error('tiers down') } },
      alerts: { read: async () => alertsBody([{ severity: 'low', subject: '有告警', why: '仅作演示' }]) },
      root,
      now: () => NOW,
    }, new URLSearchParams(''))
    assert.equal(body.ok, true)
    assert.equal(body.source, 'api/alerts')
    assert.deepEqual(body.counts, { done: null, dispatched: null, alerts: 1 })
    assert.deepEqual(body.degraded.reasons.length > 0, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest：全部数据源不可用 → ok:false、counts 全 null、items 空，绝不编条目', async () => {
  const root = await tempRoot()
  try {
    const body = await buildButlerDigest({
      board: { read: async () => boardFailure() },
      alerts: { read: async () => { throw new Error('alerts down') } },
      root,
      now: () => NOW,
    }, new URLSearchParams(''))
    assert.equal(body.ok, false)
    assert.equal(body.source, 'unavailable')
    assert.deepEqual(body.counts, { done: null, dispatched: null, alerts: null })
    assert.deepEqual(body.items, [])
    assert.match(body.reason, /不估算/)
    assert.equal(body.archived, false, '没有数据就不落归档')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest：非法 date → ok:false + 人话原因，不猜日期', async () => {
  const root = await tempRoot()
  try {
    for (const bad of ['2026-13-01', '2026-02-31', 'not-a-date', '20261128']) {
      const body = await buildButlerDigest({ root, now: () => NOW }, new URLSearchParams('date=' + bad))
      assert.equal(body.ok, false, bad + ' 应被拒绝')
      assert.match(body.reason, /YYYY-MM-DD/)
      assert.deepEqual(body.items, [])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest：共享板事件超过保留上限且当天更早记录不在列表里 → coverage:partial 并如实降级', async () => {
  const root = await tempRoot()
  try {
    const events = []
    for (let index = 0; index < 12; index += 1) {
      events.push({ task: 't-' + index, at: at(9, index), kind: 'task.dispatched', text: '派发 ' + index, node: 'pc', seq: index })
    }
    const body = await buildButlerDigest({
      board: { read: async () => boardBody(events) },
      root,
      now: () => NOW,
    }, new URLSearchParams(''))
    assert.equal(body.coverage, 'partial')
    assert.match(body.degraded.reasons.join('；'), /只保留最近/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ─────────────────────────── C. context ─────────────────────────── */

test('countCompactions：只数成功的 compaction/summary，lastAt 取任意 compaction/* 最晚', () => {
  const session = sessionWithCompactions()
  const result = countCompactions(session)
  assert.equal(result.count, 2)
  assert.equal(result.lastAt, at(9, 32), '失败尝试的 compaction/end 也是压缩活动，取最晚时间')
  assert.equal(result.reason, null)

  const empty = countCompactions(fakeSession('empty', []))
  assert.equal(empty.count, 0)
  assert.equal(empty.lastAt, null)

  const huge = { seq: CONTEXT_SCAN_MAX_EVENTS + 1, eventAt: () => undefined }
  const overflow = countCompactions(huge)
  assert.equal(overflow.count, null, '超过扫描上限就降级，不截断着报数')
  assert.match(overflow.reason, /扫描上限/)
})

test('context：活会话 + tokenMeter → used/limit/percent + 压缩次数（真实数字）', async () => {
  const session = sessionWithCompactions()
  const body = await buildButlerContext({
    reader: () => fakeReader(sessionsBody({ startedAt: new Date(2026, 10, 28, 8, 0, 0).toISOString() })),
    sessions: () => ({ list: () => [session] }),
    tokenMeter: () => ({ contextPressure: () => ({ pressureTokens: 12000, contextWindow: 48000 }) }),
    now: () => NOW,
  })
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-a')
  assert.equal(body.used, 12000)
  assert.equal(body.limit, 48000)
  assert.equal(body.percent, 25)
  assert.equal(body.compactions.count, 2)
  assert.equal(body.compactions.lastAt, at(9, 32))
  assert.match(body.source, /tokenMeter\.contextPressure/)
})

test('context：冷会话（不在 sessions.list）→ ok:false + reason，不估算', async () => {
  const body = await buildButlerContext({
    reader: () => fakeReader(sessionsBody({ startedAt: new Date(2026, 10, 28, 8, 0, 0).toISOString() })),
    sessions: () => ({ list: () => [] }),
    tokenMeter: () => ({ contextPressure: () => ({ pressureTokens: 1, contextWindow: 2 }) }),
    now: () => NOW,
  })
  assert.equal(body.ok, false)
  assert.equal(body.source, 'unavailable')
  assert.equal(body.used, null)
  assert.equal(body.limit, null)
  assert.equal(body.percent, null)
  assert.match(body.reason, /冷会话/)
})

test('context：tokenMeter 未挂载 → ok:false，但压缩次数照实给（会话日志可读）', async () => {
  const session = sessionWithCompactions()
  const body = await buildButlerContext({
    reader: () => fakeReader(sessionsBody({ startedAt: new Date(2026, 10, 28, 8, 0, 0).toISOString() })),
    sessions: () => ({ list: () => [session] }),
    now: () => NOW,
  })
  assert.equal(body.ok, false)
  assert.match(body.reason, /tokenMeter/)
  assert.equal(body.compactions.count, 2)
  assert.equal(body.used, null)
})

test('context：tokenMeter 没有提供方上报用量 → ok:false，used=null（不拿字符数估算）', async () => {
  const session = sessionWithCompactions()
  const body = await buildButlerContext({
    reader: () => fakeReader(sessionsBody({ startedAt: new Date(2026, 10, 28, 8, 0, 0).toISOString() })),
    sessions: () => ({ list: () => [session] }),
    tokenMeter: () => ({ contextPressure: () => ({}) }),
    now: () => NOW,
  })
  assert.equal(body.ok, false)
  assert.equal(body.used, null)
  assert.equal(body.limit, null)
  assert.match(body.reason, /没有提供方上报/)
})

/* ─────────────────────────── D. 路由接线 ─────────────────────────── */

/** 假 ctx：apply() 只需要 webServer / effect / get；其余服务从 services 解析。 */
function mount(services = {}) {
  let resource = null
  const resolveService = name => {
    const value = services[name]
    return typeof value === 'function' ? value() : value
  }
  const ctx = {
    effect(fn) {
      return fn()
    },
    get(name) {
      return resolveService(name)
    },
    webServer: {
      register(options) {
        if (typeof options.resource === 'function') resource = options.resource
        return () => {}
      },
    },
  }
  apply(ctx, services.config ?? {})
  assert.equal(typeof resource, 'function')
  return resource
}

/** 用临时 HTTP 服务跑 resource(request)，返回 fetch 结果。 */
async function withRouteServer(resource, run) {
  let port = 0
  const server = createServer(async (req, res) => {
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers })
    const response = await resource(request)
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    const raw = response.body === null ? Buffer.from('') : Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, headers)
    res.end(raw)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(done => server.close(done))
  }
}

test('打包：package.json 1.1.0 且 files 带上两个新模块', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '1.1.0')
  for (const file of ['lib/butler-continuity.js', 'lib/butler-state.js']) {
    assert.ok(pkg.files.includes(file), 'files 必须带 ' + file + '，否则安装副本缺文件')
  }
})

test('路由：三条 1.1.0 只读路由真接线（GET 契约 / HEAD / POST 405）', async () => {
  const root = await tempRoot()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const session = sessionWithCompactions()
    const resource = mount({
      config: configOf('session-a'),
      sessions: () => ({ list: () => [session] }),
      tokenMeter: () => ({ contextPressure: () => ({ pressureTokens: 12000, contextWindow: 48000 }) }),
      sessionController: () => ({
        list: async () => ({
          items: [{
            sessionId: 'session-a',
            origin: 'root',
            updatedAt: NOW,
            agentAvailable: true,
            projections: { values: { title: '大管家 · 常驻', sessionListMetadata: { lastPromptAt: NOW } } },
          }],
        }),
        state: async () => ({ active: true, running: false, queue: [], pendingInput: [] }),
        events: async () => ({ records: [], cursor: 0 }),
      }),
      agents: () => ({ list: () => [] }),
      sessionProjections: () => ({ snapshot: () => ({ values: { title: '大管家 · 常驻' } }) }),
    })
    await withRouteServer(resource, async baseUrl => {
      const continuity = await fetch(baseUrl + ROUTE_PREFIX + '/' + BUTLER_CONTINUITY_FILE)
      assert.equal(continuity.status, 200)
      assert.match(continuity.headers.get('content-type') ?? '', /application\/json/)
      const continuityBody = await continuity.json()
      for (const key of ['ok', 'sessionId', 'title', 'available', 'reason', 'firstBoundAt', 'lastSeenAt', 'uptimeMs', 'rebuildCount', 'source']) {
        assert.ok(key in continuityBody, 'continuity 缺契约字段 ' + key)
      }
      assert.equal(continuityBody.sessionId, 'session-a')

      const digest = await fetch(baseUrl + ROUTE_PREFIX + '/' + BUTLER_DIGEST_FILE + '?days=7&date=' + TODAY)
      assert.equal(digest.status, 200)
      const digestBody = await digest.json()
      for (const key of ['ok', 'date', 'generatedAt', 'source', 'counts', 'items']) {
        assert.ok(key in digestBody, 'digest 缺契约字段 ' + key)
      }
      assert.ok(digestBody.counts && 'done' in digestBody.counts && 'dispatched' in digestBody.counts && 'alerts' in digestBody.counts)

      const contextResponse = await fetch(baseUrl + ROUTE_PREFIX + '/' + BUTLER_CONTEXT_FILE)
      assert.equal(contextResponse.status, 200)
      const contextBody = await contextResponse.json()
      for (const key of ['ok', 'used', 'limit', 'percent', 'compactions', 'source']) {
        assert.ok(key in contextBody, 'context 缺契约字段 ' + key)
      }
      assert.ok(contextBody.compactions && 'count' in contextBody.compactions && 'lastAt' in contextBody.compactions)
      assert.equal(contextBody.used, 12000)

      const head = await fetch(baseUrl + ROUTE_PREFIX + '/' + BUTLER_CONTINUITY_FILE, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')

      for (const path of [BUTLER_CONTINUITY_FILE, BUTLER_DIGEST_FILE, BUTLER_CONTEXT_FILE]) {
        const post = await fetch(baseUrl + ROUTE_PREFIX + '/' + path, { method: 'POST' })
        assert.equal(post.status, 405, path + ' 只读，POST 必须 405')
        const body = await post.json()
        assert.equal(body.ok, false)
        assert.equal(body.error, 'method-not-allowed')
      }
    })
    // 状态确实落在 DSH_HOME/<插件数据目录>/ 下（不是安装目录、不是用户目录）。
    const stateRoot = join(root, STATE_DIR_NAME)
    assert.equal(continuityPathOf(stateRoot).startsWith(root), true)
    const continuityFile = JSON.parse(await readFile(continuityPathOf(stateRoot), 'utf8'))
    assert.equal(continuityFile.sessionId, 'session-a')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
