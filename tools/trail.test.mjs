#!/usr/bin/env node
/**
 * tools/trail.test.mjs —— 0.6.0 TRAIL 告警（lib/trail.js + GET api/alerts）的单元与路由测试。
 *
 * 测的是什么：
 *   A. taxonomy 保真：21 个叶子类目与 TRAIL `calculate_scores.py::all_categories` 逐字一致、
 *      字段齐全、类别树对不对得上；`Incorrect Memory Usage` 的 20/21 来源差异有记录；
 *   B. 规则：10 条规则逐条正例 + 反例（全部喂真实字段形状），并测排序/去重/上限；
 *   C. 真实快照：`tools/fixtures/board-2026-11-21.json` + `tiers-2026-11-21.json`（真实
 *      `/api/board`、`/api/tiers` 返回）跑一遍，断言告警类别与低/中/高分布；
 *   D. 人造边界快照：`tools/fixtures/alerts-edge-2026-11-21.json`（字段结构照真实行复制，
 *      值是构造的）覆盖真实快照里没触发的规则；
 *   E. 组装/缓存/降级：buildAlerts、createAlertsReader（4 s 缓存 + 单飞）、fallbackAlerts；
 *   F. 路由：真 socket 打 `GET/HEAD/POST api/alerts`，含假板服务端到端与 token 不外泄；
 *   G. 零依赖：lib/trail.js 没有 import/require（不接 LLM、不联网、不花钱）。
 *
 * 跑法：node --test（本文件随 `node --test` 自动发现）或 node tools/trail.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createBoardReader } from '../lib/board.js'
import { ALERTS_FILE, ROUTE_PREFIX, apply } from '../lib/index.js'
import {
  ALERT_RULES,
  ALERTS_CACHE_MS,
  RULE_BY_ID,
  THRESHOLDS,
  TRAIL_BY_ID,
  TRAIL_SOURCE,
  TRAIL_TAXONOMY,
  buildAlerts,
  classifyAlerts,
  countAlerts,
  createAlertsReader,
  fallbackAlerts,
} from '../lib/trail.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readFixture = name => JSON.parse(readFileSync(resolve(ROOT, 'tools', 'fixtures', name), 'utf8'))
const REAL_BOARD = readFixture('board-2026-11-21.json')
const REAL_TIERS = readFixture('tiers-2026-11-21.json')
const EDGE = readFixture('alerts-edge-2026-11-21.json')
const REAL_NOW = Date.parse(REAL_BOARD.generatedAt)
const NOW = EDGE.now
const MIN = 60 * 1000
const HOUR = 60 * MIN

/** TRAIL `benchmarking/calculate_scores.py::all_categories`（2026-11-21 实读，原样照抄）。 */
const TRAIL_EXPECTED_IDS = [
  'Language-only', 'Tool-related', 'Poor Information Retrieval', 'Incorrect Memory Usage',
  'Tool Output Misinterpretation', 'Incorrect Problem Identification', 'Tool Selection Errors',
  'Formatting Errors', 'Instruction Non-compliance', 'Tool Definition Issues',
  'Environment Setup Errors', 'Rate Limiting', 'Authentication Errors', 'Service Errors',
  'Resource Not Found', 'Resource Exhaustion', 'Timeout Issues', 'Context Handling Failures',
  'Resource Abuse', 'Goal Deviation', 'Task Orchestration',
]

/** 一行任务（字段名/单位与真实 `/api/board` tasks[] 一致，值由用例给）。 */
function mkTask(overrides = {}) {
  return {
    id: 't-test-1',
    title: '测试任务：一条真实形状的卡',
    state: 'open',
    owner: 'owner-a',
    evidenceCount: 0,
    lifecycle: 'open',
    ackState: 'none',
    createdAt: NOW - 10 * MIN,
    updatedAt: NOW - 5 * MIN,
    leaseDeadline: null,
    ackDeadline: null,
    ackAt: null,
    expiredAt: null,
    ...overrides,
  }
}

/** 一行层级节点（字段与真实 `/api/tiers` nodes[] 一致）。 */
function mkNode(overrides = {}) {
  return {
    id: 'node-test-1',
    parentId: 'pc-ky614',
    tier: 2,
    kind: 'subagent',
    device: 'pc-ky614',
    title: '测试子代理',
    status: 'run',
    startedAt: new Date(NOW - 3 * HOUR).toISOString(),
    mode: 'one-shot',
    ...overrides,
  }
}

/** 组一个分类器输入（只给要测的那部分）。 */
function run(tasks, events = [], nodes = [], extra = {}) {
  return classifyAlerts({ board: { tasks, events, official: extra.official }, tiers: { nodes }, now: NOW }, NOW)
}

/** 编号断言：只留指定 ruleId 的告警，方便逐规则断言。 */
function only(alerts, ruleId) {
  return alerts.filter(alert => alert.ruleId === ruleId)
}

/* ───────────────────────────── A. taxonomy 保真 ───────────────────────────── */

test('taxonomy：21 个叶子类目与 TRAIL calculate_scores.py 的 all_categories 逐字一致', () => {
  assert.equal(TRAIL_TAXONOMY.length, 21)
  assert.deepEqual(TRAIL_TAXONOMY.map(item => item.id), TRAIL_EXPECTED_IDS)
  assert.equal(TRAIL_SOURCE.leafCategories, 21)
})

test('taxonomy：每个类目字段齐全且分到 3 大类 9 组', () => {
  const groups = new Set()
  const branches = new Set()
  for (const item of TRAIL_TAXONOMY) {
    for (const key of ['id', 'group', 'branch', 'label', 'what', 'evidenceHint']) {
      assert.equal(typeof item[key], 'string', item.id + ' 缺 ' + key)
      assert.ok(item[key].trim() !== '', item.id + ' 的 ' + key + ' 不能为空')
    }
    groups.add(item.group)
    branches.add(item.branch)
  }
  assert.deepEqual([...groups].sort(), [
    'Planning and Coordination Errors',
    'Reasoning Errors',
    'System Execution Errors',
  ])
  assert.equal(branches.size, 9, '二级组：3 大类下共 9 组（TRAIL prompt 树）')
})

test('taxonomy：记录 TRAIL 20/21 差异（Incorrect Memory Usage 只在评分清单里）', () => {
  const memory = TRAIL_BY_ID['Incorrect Memory Usage']
  assert.ok(memory, '21 类清单里的 Incorrect Memory Usage 必须在')
  assert.equal(memory.group, 'Reasoning Errors')
  assert.equal(memory.branch, 'Information Processing')
  assert.match(memory.what, /calculate_scores|prompt 树没有/)
  // 其余 20 个 = run_eval.py prompt 树的 20 个叶子，一个不少。
  assert.equal(TRAIL_TAXONOMY.filter(item => item.id !== 'Incorrect Memory Usage').length, 20)
})

test('taxonomy：id 不重复，TRAIL_BY_ID 反查一致', () => {
  const ids = TRAIL_TAXONOMY.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.equal(TRAIL_BY_ID[id].id, id)
  assert.equal(TRAIL_BY_ID['不存在的类目'], undefined)
})

test('规则：≥6 条、id 不重复、类目都在 taxonomy 里', () => {
  assert.ok(ALERT_RULES.length >= 6)
  assert.equal(new Set(ALERT_RULES.map(rule => rule.id)).size, ALERT_RULES.length)
  for (const rule of ALERT_RULES) {
    assert.ok(TRAIL_BY_ID[rule.category], rule.id + ' 的类目 ' + rule.category + ' 不在 taxonomy 里')
    assert.equal(RULE_BY_ID[rule.id].id, rule.id)
    assert.ok(rule.label.trim() !== '')
  }
})

test('来源：MIT 许可与「LLM judge 未接」写死在模块里', () => {
  assert.equal(TRAIL_SOURCE.repo, 'patronus-ai/trail-benchmark')
  assert.equal(TRAIL_SOURCE.license, 'MIT')
  assert.equal(TRAIL_SOURCE.copyright, 'Copyright (c) 2025 patronus-ai')
  assert.equal(TRAIL_SOURCE.judge, 'not-ported')
  assert.match(TRAIL_SOURCE.extractedFrom, /run_eval\.py/)
  assert.match(TRAIL_SOURCE.extractedFrom, /calculate_scores\.py/)
})

/* ───────────────────────────── B. 规则逐条 ───────────────────────────── */

test('规则 task_stalled：25 分钟无更新 → 中；5 分钟 → 不报；租约已过期交给 lease_expired', () => {
  const idle = mkTask({ id: 't-idle-25m', lifecycle: 'working', state: 'leased', updatedAt: NOW - 25 * MIN, leaseDeadline: NOW + 5 * MIN })
  const fresh = mkTask({ id: 't-fresh', lifecycle: 'working', state: 'leased', updatedAt: NOW - 5 * MIN, leaseDeadline: NOW + 5 * MIN })
  const leaseGone = mkTask({ id: 't-lease-gone', lifecycle: 'working', state: 'stale', updatedAt: NOW - 25 * MIN, leaseDeadline: NOW - MIN })
  const alerts = run([idle, fresh, leaseGone])
  const stalled = only(alerts, 'task_stalled')
  assert.deepEqual(stalled.map(alert => alert.subjectId), ['t-idle-25m'])
  assert.equal(stalled[0].severity, 'medium')
  assert.equal(stalled[0].category, 'Task Orchestration')
  assert.ok(stalled[0].evidence.some(line => line.startsWith('tasks.t-idle-25m.updatedAt=')))
  assert.match(stalled[0].why, /25 分钟/)
  assert.ok(only(alerts, 'lease_expired').every(alert => alert.subjectId === 't-lease-gone'))
})

test('规则 task_stalled：45 分钟 → 高', () => {
  const task = mkTask({ id: 't-idle-45m', lifecycle: 'working', state: 'leased', updatedAt: NOW - 45 * MIN, leaseDeadline: NOW + 5 * MIN })
  const stalled = only(run([task]), 'task_stalled')
  assert.equal(stalled.length, 1)
  assert.equal(stalled[0].severity, 'high')
})

test('规则 subagent_stalled：跑了 3 小时的子代理 → 中；1 小时 / 已完成 → 不报', () => {
  const old = mkNode({ id: 'sub-old', startedAt: new Date(NOW - 3 * HOUR).toISOString(), status: 'run' })
  const young = mkNode({ id: 'sub-young', startedAt: new Date(NOW - 1 * HOUR).toISOString(), status: 'run' })
  const idle = mkNode({ id: 'sub-idle', startedAt: new Date(NOW - 3 * HOUR).toISOString(), status: 'idle' })
  const alerts = run([], [], [old, young, idle])
  const stalled = only(alerts, 'subagent_stalled')
  assert.deepEqual(stalled.map(alert => alert.subjectId), ['sub-old'])
  assert.equal(stalled[0].severity, 'medium')
  assert.equal(stalled[0].subjectType, 'node')
  assert.ok(stalled[0].evidence.includes('nodes.sub-old.status=run'))
})

test('规则 lease_expired：stale 任务 → 高；done/canceled 的 stale 残留不报', () => {
  const stale = mkTask({ id: 't-stale', lifecycle: 'working', state: 'stale', leaseDeadline: NOW - 20 * MIN, expiredAt: NOW - 19 * MIN, owner: 'owner-z' })
  const done = mkTask({ id: 't-done-stale', lifecycle: 'done', state: 'stale', leaseDeadline: NOW - 20 * MIN })
  const canceled = mkTask({ id: 't-cancel-stale', lifecycle: 'canceled', state: 'stale', leaseDeadline: NOW - 20 * MIN })
  const alerts = only(run([stale, done, canceled]), 'lease_expired')
  assert.deepEqual(alerts.map(alert => alert.subjectId), ['t-stale'])
  assert.equal(alerts[0].severity, 'high')
  assert.equal(alerts[0].category, 'Timeout Issues')
  assert.ok(alerts[0].evidence.some(line => line.includes('leaseDeadline=') && line.includes('已过期')))
  assert.match(alerts[0].suggestion, /接管|重派/)
})

test('规则 ack_timeout：回执期限已过且未 ack → 中；已 ack / 未到期 / 终态 → 不报', () => {
  const overdue = mkTask({ id: 't-ack-overdue', lifecycle: 'open', state: 'awaiting', ackState: 'pending', ackDeadline: NOW - 5 * MIN })
  const acked = mkTask({ id: 't-ack-done', lifecycle: 'open', state: 'open', ackState: 'acked', ackDeadline: NOW - 5 * MIN, ackAt: NOW - 6 * MIN })
  const pending = mkTask({ id: 't-ack-pending', lifecycle: 'open', state: 'awaiting', ackState: 'pending', ackDeadline: NOW + 5 * MIN })
  const terminal = mkTask({ id: 't-ack-canceled', lifecycle: 'canceled', state: 'canceled', ackState: 'timeout', ackDeadline: NOW - 9 * MIN })
  const alerts = only(run([overdue, acked, pending, terminal]), 'ack_timeout')
  assert.deepEqual(alerts.map(alert => alert.subjectId), ['t-ack-overdue'])
  assert.equal(alerts[0].severity, 'medium')
  assert.ok(alerts[0].evidence.includes('tasks.t-ack-overdue.ackState=pending'))
  assert.ok(alerts[0].evidence.includes('tasks.t-ack-overdue.ackAt=null'))
})

test('规则 dispatch_undelivered：未送达 → 中；正常等回执不报', () => {
  const undelivered = mkTask({ id: 't-undelivered', lifecycle: 'open', state: 'undelivered', ackState: 'none' })
  const awaiting = mkTask({ id: 't-awaiting', lifecycle: 'open', state: 'awaiting', ackState: 'pending', ackDeadline: NOW + 5 * MIN })
  const alerts = only(run([undelivered, awaiting]), 'dispatch_undelivered')
  assert.deepEqual(alerts.map(alert => alert.subjectId), ['t-undelivered'])
  assert.equal(alerts[0].severity, 'medium')
  assert.equal(alerts[0].category, 'Task Orchestration')
})

test('规则 duplicate_work：同标题并存→高、取消后重开→中、反复建卡又放弃→低、单张不报', () => {
  const pairA = mkTask({ id: 't-dup-a', title: '边界：同标题两张并存', lifecycle: 'open', state: 'awaiting', ackDeadline: NOW + 10 * MIN })
  const pairB = mkTask({ id: 't-dup-b', title: '边界：同标题两张并存', lifecycle: 'working', state: 'leased', leaseDeadline: NOW + 5 * MIN, updatedAt: NOW - MIN })
  const canceled = mkTask({ id: 't-dup-c', title: '边界：取消后重开', lifecycle: 'canceled', state: 'canceled', createdAt: NOW - 3 * HOUR, updatedAt: NOW - 2 * HOUR })
  const reopened = mkTask({ id: 't-dup-d', title: '边界：取消后重开', lifecycle: 'open', state: 'awaiting', createdAt: NOW - 1 * HOUR, ackDeadline: NOW + 10 * MIN })
  const abandonedA = mkTask({ id: 't-dup-e', title: '边界：反复建卡又放弃', lifecycle: 'canceled', state: 'canceled', updatedAt: NOW - 2 * HOUR })
  const abandonedB = mkTask({ id: 't-dup-f', title: '边界：反复建卡又放弃', lifecycle: 'canceled', state: 'canceled', updatedAt: NOW - 30 * MIN })
  const single = mkTask({ id: 't-single', title: '边界：只有一张卡', lifecycle: 'open', state: 'awaiting', ackDeadline: NOW + 10 * MIN })
  const alerts = only(run([pairA, pairB, canceled, reopened, abandonedA, abandonedB, single]), 'duplicate_work')
  assert.equal(alerts.length, 3)
  const bySubject = Object.fromEntries(alerts.map(alert => [alert.subject, alert.severity]))
  const pairAlert = alerts.find(alert => alert.relatedIds && alert.relatedIds.length === 2 && alert.relatedIds.includes('t-dup-a'))
  assert.equal(pairAlert.severity, 'high')
  assert.match(pairAlert.why, /并存/)
  const reopenAlert = alerts.find(alert => alert.relatedIds && alert.relatedIds.includes('t-dup-d'))
  assert.equal(reopenAlert.severity, 'medium')
  assert.match(reopenAlert.why, /取消后重开/)
  const abandonedAlert = alerts.find(alert => alert.relatedIds && alert.relatedIds.includes('t-dup-e'))
  assert.equal(abandonedAlert.severity, 'low')
  assert.ok(!Object.keys(bySubject).some(subject => subject.includes('只有一张卡')))
})

test('规则 evidence_gate：done 但 0 证据 → 高；门禁驳回后取消且 0 证据 → 中；未知/有证据不报', () => {
  const doneNoEvidence = mkTask({ id: 't-done-noev', title: '边界：完成但没证据', lifecycle: 'done', state: 'done', evidenceCount: 0, updatedAt: NOW - 10 * MIN })
  const gateCanceled = mkTask({ id: 't-gate-cancel', title: '边界：门禁驳回后取消', lifecycle: 'canceled', state: 'canceled', evidenceCount: 0 })
  const unknown = mkTask({ id: 't-unknown-ev', lifecycle: 'done', state: 'done', evidenceCount: null })
  const hasEvidence = mkTask({ id: 't-has-evidence', lifecycle: 'done', state: 'done', evidenceCount: 3 })
  const events = [{ task: 't-gate-cancel', kind: 'task.gate_rejected', seq: 901, at: NOW - 2 * HOUR, text: '{"reasons":["NO_EVIDENCE"]}' }]
  const alerts = only(run([doneNoEvidence, gateCanceled, unknown, hasEvidence], events), 'evidence_gate')
  assert.deepEqual(alerts.map(alert => [alert.subjectId, alert.severity]).sort(), [
    ['t-done-noev', 'high'],
    ['t-gate-cancel', 'medium'],
  ])
  const canceledAlert = alerts.find(alert => alert.subjectId === 't-gate-cancel')
  assert.ok(canceledAlert.evidence.some(line => line.includes('task.gate_rejected')))
  assert.equal(alerts.find(alert => alert.subjectId === 't-done-noev').category, 'Instruction Non-compliance')
})

test('规则 subagent_anomaly：阻塞 → 高；父已完成子仍在跑 → 中；正常不报', () => {
  const parentDone = mkNode({ id: 'session-done', tier: 1, kind: 'session', status: 'done', startedAt: new Date(NOW - 5 * HOUR).toISOString() })
  const blocked = mkNode({ id: 'sub-blocked', parentId: 'session-run', status: 'blocked', startedAt: new Date(NOW - 40 * MIN).toISOString() })
  const parentRun = mkNode({ id: 'session-run', tier: 1, kind: 'session', status: 'run', startedAt: new Date(NOW - 2 * HOUR).toISOString() })
  const childOfDone = mkNode({ id: 'child-of-done', parentId: 'session-done', status: 'run', startedAt: new Date(NOW - 1 * HOUR).toISOString() })
  const normal = mkNode({ id: 'sub-normal', parentId: 'session-run', status: 'idle', startedAt: new Date(NOW - 1 * HOUR).toISOString() })
  const alerts = only(run([], [], [parentDone, parentRun, blocked, childOfDone, normal]), 'subagent_anomaly')
  assert.deepEqual(alerts.map(alert => [alert.subjectId, alert.severity]).sort(), [
    ['child-of-done', 'medium'],
    ['sub-blocked', 'high'],
  ])
  assert.equal(alerts.find(alert => alert.subjectId === 'sub-blocked').category, 'Task Orchestration')
})

test('规则 subagent_orphan：T1 子代理（父会话已不在活会话）= 父丢失 → 低；普通会话不报', () => {
  const orphan = mkNode({ id: 'orphan-sub', tier: 1, parentId: 'pc-ky614', status: 'idle', startedAt: new Date(NOW - 10 * 24 * HOUR).toISOString() })
  const session = mkNode({ id: 'session-1', tier: 1, kind: 'session', status: 'idle', startedAt: new Date(NOW - 10 * 24 * HOUR).toISOString() })
  const alerts = only(run([], [], [orphan, session]), 'subagent_orphan')
  assert.deepEqual(alerts.map(alert => alert.subjectId), ['orphan-sub'])
  assert.equal(alerts[0].severity, 'low')
  assert.equal(alerts[0].category, 'Context Handling Failures')
  assert.match(alerts[0].why, /父会话已不在活会话列表/)
})

test('规则 official_team_failure：enabled 团队带 failure → 中；未启用/不可用不报', () => {
  const official = {
    available: true,
    teams: [
      { sessionId: 'session-team', title: '测试团队', enabled: true, taskCount: 0, shownTasks: 0, failure: 'dispatch failed: peer unreachable' },
      { sessionId: 'session-off', title: '未启用', enabled: false, taskCount: 0, shownTasks: 0, failure: '不该报' },
    ],
    tasks: [],
  }
  const alerts = only(run([], [], [], { official }), 'official_team_failure')
  assert.deepEqual(alerts.map(alert => alert.subjectId), ['session-team'])
  assert.equal(alerts[0].severity, 'medium')
  assert.ok(alerts[0].evidence.some(line => line.includes('failure=dispatch failed')))
  assert.equal(only(run([], [], [], { official: { available: false, teams: [], tasks: [] } }), 'official_team_failure').length, 0)
})

test('去重：同一条规则对同一主体只报一条；不同规则不互相吞（stalled 与 anomaly 都保留）', () => {
  const parentDone = mkNode({ id: 'session-done', tier: 1, kind: 'session', status: 'done', startedAt: new Date(NOW - 6 * HOUR).toISOString() })
  const longChild = mkNode({ id: 'sub-both', parentId: 'session-done', status: 'run', startedAt: new Date(NOW - 5 * HOUR).toISOString() })
  const alerts = run([], [], [parentDone, longChild])
  // 同一节点：跑太久（中）+ 父已完成子仍在跑（中），是两件不同的事；每条规则对同一主体只 1 条。
  assert.equal(only(alerts, 'subagent_stalled').length, 1)
  assert.equal(only(alerts, 'subagent_anomaly').length, 1)
  assert.equal(new Set(alerts.map(alert => alert.id)).size, alerts.length)
})

test('上限：超过 MAX_ALERTS 条时截断', () => {
  const tasks = Array.from({ length: THRESHOLDS.MAX_ALERTS + 10 }, (_, index) => mkTask({
    id: 't-cap-' + index,
    title: '上限测试任务 ' + index,
    lifecycle: 'working',
    state: 'leased',
    updatedAt: NOW - 45 * MIN,
    leaseDeadline: NOW + 5 * MIN,
  }))
  const alerts = classifyAlerts({ board: { tasks }, now: NOW }, NOW)
  assert.equal(alerts.length, THRESHOLDS.MAX_ALERTS)
})

test('排序：high → medium → low，同严重度按类目/主体；两次运行结果完全一致', () => {
  const alerts = classifyAlerts({ board: EDGE.board, tiers: EDGE.tiers, now: NOW }, NOW)
  const rank = { high: 0, medium: 1, low: 2 }
  for (let index = 1; index < alerts.length; index += 1) {
    assert.ok(rank[alerts[index - 1].severity] <= rank[alerts[index].severity], '严重度必须单调')
  }
  assert.deepEqual(classifyAlerts({ board: EDGE.board, tiers: EDGE.tiers, now: NOW }, NOW), alerts)
})

test('纯函数：不修改输入（含 agents 兜底分支）', () => {
  const input = JSON.parse(JSON.stringify({ board: EDGE.board, tiers: EDGE.tiers }))
  input.tiers.nodes = input.tiers.nodes.map(node => ({ ...node, status: node.id === 'sub-blocked' ? undefined : node.status }))
  const before = JSON.stringify(input)
  classifyAlerts(input, NOW)
  assert.equal(JSON.stringify(input), before)
})

test('agents 兜底：tiers 节点缺 status 时用 agents 列表补（不伪造节点）', () => {
  const node = mkNode({ id: 'sub-agentless', parentId: 'session-run', status: undefined, startedAt: new Date(NOW - 40 * MIN).toISOString(), tier: 2 })
  const parentRun = mkNode({ id: 'session-run', tier: 1, kind: 'session', status: 'run', startedAt: new Date(NOW - 2 * HOUR).toISOString() })
  const withAgents = classifyAlerts({
    tiers: { nodes: [parentRun, node] },
    agents: [{ id: 'sub-agentless', status: 'failed' }],
    now: NOW,
  }, NOW)
  assert.ok(only(withAgents, 'subagent_anomaly').some(alert => alert.subjectId === 'sub-agentless'))
})

/* ───────────────────────────── C. 真实快照 ───────────────────────────── */

test('真实快照：/api/board + /api/tiers 跑出 1 条低优先级告警（孤儿子代理）', () => {
  const alerts = classifyAlerts({ board: REAL_BOARD, tiers: REAL_TIERS, now: REAL_NOW }, REAL_NOW)
  const counts = countAlerts(alerts)
  assert.deepEqual(counts, { high: 0, medium: 0, low: 1, total: 1 })
  assert.deepEqual(alerts.map(alert => alert.ruleId), ['subagent_orphan'])
  assert.deepEqual(alerts.map(alert => alert.category), ['Context Handling Failures'])
  for (const alert of alerts) {
    assert.ok(TRAIL_BY_ID[alert.category], '类目必须在 taxonomy 里：' + alert.category)
    assert.equal(alert.categoryLabel, TRAIL_BY_ID[alert.category].label)
    assert.ok(alert.evidence.length > 0 && alert.evidence.every(line => typeof line === 'string' && line !== ''))
    assert.ok(alert.evidence.every(line => /^(tasks|nodes|events|official)\./.test(line)), '证据必须指回字段路径：' + alert.evidence.join(' | '))
  }
  // 真实数据里「done 且有 5 条证据」的卡不能报（防止规则把正常完成当成问题）。
  assert.ok(!alerts.some(alert => alert.subjectId === 't-e5b4cb53'))
  // 板上有两张同标题的旧测试卡，但 updatedAt 是 184 小时前（超过 24 小时重复窗口）：
  // 按阈值算历史、不打扰人 —— 这条也锁住「阈值真的在生效」。
  assert.ok(!alerts.some(alert => alert.ruleId === 'duplicate_work'))
})

test('真实快照：同一天同一份数据重复跑结果稳定（幂等）', () => {
  const first = classifyAlerts({ board: REAL_BOARD, tiers: REAL_TIERS, now: REAL_NOW }, REAL_NOW)
  const second = classifyAlerts({ board: REAL_BOARD, tiers: REAL_TIERS, now: REAL_NOW }, REAL_NOW)
  assert.deepEqual(first, second)
})

/* ───────────────────────────── D. 人造边界快照 ───────────────────────────── */

test('边界快照：10 条规则全部命中，高 5 / 中 8 / 低 2（共 15）', () => {
  const alerts = classifyAlerts({ board: EDGE.board, tiers: EDGE.tiers, now: NOW }, NOW)
  assert.deepEqual(countAlerts(alerts), { high: 5, medium: 8, low: 2, total: 15 })
  const ruleIds = new Set(alerts.map(alert => alert.ruleId))
  assert.deepEqual([...ruleIds].sort(), ALERT_RULES.map(rule => rule.id).sort(), '10 条规则都应有正例')
  assert.equal(new Set(alerts.map(alert => alert.id)).size, alerts.length, '告警 id 不重复')
})

test('边界快照：每条告警都带完整契约字段与中文类目名', () => {
  const alerts = classifyAlerts({ board: EDGE.board, tiers: EDGE.tiers, now: NOW }, NOW)
  for (const alert of alerts) {
    assert.ok(typeof alert.id === 'string' && alert.id.startsWith('trail-'), alert.id)
    assert.ok(['high', 'medium', 'low'].includes(alert.severity))
    assert.ok(['task', 'node', 'team'].includes(alert.subjectType))
    assert.equal(typeof alert.subjectId, 'string')
    assert.ok(typeof alert.subject === 'string' && alert.subject !== '')
    assert.ok(typeof alert.why === 'string' && alert.why !== '')
    assert.ok(typeof alert.suggestion === 'string' && alert.suggestion !== '')
    assert.ok(Array.isArray(alert.evidence) && alert.evidence.length > 0)
    assert.equal(alert.categoryLabel, TRAIL_BY_ID[alert.category].label)
  }
})

test('边界快照：重复劳动告警的 relatedIds 指向真实任务行', () => {
  const taskIds = new Set(EDGE.board.tasks.map(task => task.id))
  const duplicates = classifyAlerts({ board: EDGE.board, tiers: EDGE.tiers, now: NOW }, NOW)
    .filter(alert => alert.ruleId === 'duplicate_work')
  assert.equal(duplicates.length, 3)
  for (const alert of duplicates) {
    assert.ok(Array.isArray(alert.relatedIds) && alert.relatedIds.length >= 2)
    for (const id of alert.relatedIds) assert.ok(taskIds.has(id), id + ' 不在 board.tasks 里')
    assert.ok(taskIds.has(alert.subjectId))
  }
})

/* ───────────────────────────── E. 组装 / 缓存 / 降级 ───────────────────────────── */

test('buildAlerts：正常输入 → 契约字段齐全，counts 与 alerts 一致', async () => {
  const board = { read: async () => REAL_BOARD }
  const tiers = { read: async () => REAL_TIERS }
  const body = await buildAlerts({ board, tiers, now: REAL_NOW })
  assert.deepEqual(Object.keys(body).sort(), ['alerts', 'counts', 'degraded', 'generatedAt', 'source'])
  assert.equal(body.source.classifier, 'trail-rules-v1')
  assert.equal(body.source.taxonomy, 21)
  assert.equal(body.source.rules, ALERT_RULES.length)
  assert.equal(body.source.board, 'real')
  // 真实 tiers 快照本身带 degraded（父会话已不在活会话列表）；如实标 degraded 并把原因带出来。
  assert.equal(body.source.tiers, 'degraded')
  assert.deepEqual(body.counts, countAlerts(body.alerts))
  assert.deepEqual(body.counts, { high: 0, medium: 0, low: 1, total: 1 })
  assert.equal(body.degraded.reasons.length, 1)
  assert.match(body.degraded.reasons[0], /层级快照有降级/)
  assert.equal(new Date(body.generatedAt).getTime(), REAL_NOW)
})

test('buildAlerts：board 未配置 / tiers 缺失 → source 如实标，不抛', async () => {
  const body = await buildAlerts({
    board: { read: async () => ({ generatedAt: new Date(REAL_NOW).toISOString(), configured: false, tasks: [], events: [], official: null }) },
    tiers: null,
    now: REAL_NOW,
  })
  assert.equal(body.source.board, 'unconfigured')
  assert.equal(body.source.tiers, 'missing')
  assert.deepEqual(body.alerts, [])
  assert.ok(body.degraded.reasons.length >= 2)
  assert.ok(body.degraded.reasons.some(reason => reason.includes('共享板未配置')))
  assert.ok(body.degraded.reasons.some(reason => reason.includes('层级')))
})

test('buildAlerts：reader 抛错 → 结构化降级，永不 reject', async () => {
  const boom = { read: async () => { throw new Error('boom') } }
  const body = await buildAlerts({ board: boom, tiers: boom, now: REAL_NOW })
  assert.deepEqual(body.alerts, [])
  assert.equal(body.source.board, 'missing')
  assert.equal(body.source.tiers, 'missing')
  assert.ok(body.degraded.reasons.length >= 2)
})

test('createAlertsReader：4 秒缓存命中带 cached/ageMs，过期后重建', async () => {
  let boardCalls = 0
  let clock = REAL_NOW
  const board = { read: async () => { boardCalls += 1; return REAL_BOARD } }
  const tiers = { read: async () => REAL_TIERS }
  const reader = createAlertsReader({ board, tiers, now: () => clock })
  const first = await reader.read()
  assert.equal(first.source.cached, false)
  assert.equal(boardCalls, 1)
  clock += ALERTS_CACHE_MS - 1
  const second = await reader.read()
  assert.equal(second.source.cached, true)
  assert.ok(second.source.ageMs >= 0 && second.source.ageMs < ALERTS_CACHE_MS)
  assert.equal(boardCalls, 1, '缓存窗口内不应再组装')
  clock += ALERTS_CACHE_MS
  await reader.read()
  assert.equal(boardCalls, 2, '过期后必须重读')
})

test('createAlertsReader：并发请求单飞（只组装一次）', async () => {
  let boardCalls = 0
  const board = { read: async () => { boardCalls += 1; return REAL_BOARD } }
  const tiers = { read: async () => REAL_TIERS }
  const reader = createAlertsReader({ board, tiers, now: () => REAL_NOW })
  const results = await Promise.all([reader.read(), reader.read(), reader.read()])
  assert.equal(boardCalls, 1)
  assert.deepEqual(results[0].counts, results[2].counts)
})

test('fallbackAlerts：同一份契约、0 告警、degraded 写原因', () => {
  const body = fallbackAlerts('测试原因', REAL_NOW)
  assert.deepEqual(Object.keys(body).sort(), ['alerts', 'counts', 'degraded', 'generatedAt', 'source'])
  assert.deepEqual(body.counts, { high: 0, medium: 0, low: 0, total: 0 })
  assert.deepEqual(body.alerts, [])
  assert.deepEqual(body.degraded.reasons, ['测试原因'])
  assert.equal(new Date(body.generatedAt).getTime(), REAL_NOW)
})

/* ───────────────────────────── F. 路由（真 socket） ───────────────────────────── */

/** 假 ctx：apply() 要 prefix resource（页面 + 只读 api）与 exact handler（action）。 */
function mount(config = {}, services = {}) {
  let resource = null
  let actionHandler = null
  const ctx = {
    effect(fn) { return fn() },
    get(name) { return Object.hasOwn(services, name) ? services[name] : null },
    webServer: {
      register(options) {
        if (typeof options.resource === 'function') resource = options.resource
        if (typeof options.handler === 'function') actionHandler = options.handler
        return () => {}
      },
    },
  }
  apply(ctx, config)
  assert.equal(typeof resource, 'function')
  return { resource, actionHandler }
}

/** 把 Fetch 风格 route 接到 node:http 上（测试用真 socket 打）。 */
async function withRouteServer(resource, runWithBase) {
  let port = 0
  const server = createServer(async (req, res) => {
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers })
    const response = await resource(request)
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    const body = response.body === null ? Buffer.from('') : Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, headers)
    res.end(body)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  try {
    return await runWithBase(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(done => server.close(done))
  }
}

async function hit(baseUrl, path, init) {
  const response = await fetch(baseUrl + path, init)
  const text = await response.text()
  let json
  try { json = text === '' ? undefined : JSON.parse(text) } catch { json = undefined }
  return { status: response.status, headers: response.headers, text, json }
}

/** 起一个最小假共享板：/health + /task/list + /task/evidence + /events，并记 health 命中数。 */
async function startFakeBoard(tasks = []) {
  const state = { healthHits: 0, taskListHits: 0 }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/health') {
      state.healthHits += 1
      return send(200, { ok: true, service: 'fake board', version: '0.0.1', schema_version: 5 })
    }
    if (url.pathname === '/task/list') {
      state.taskListHits += 1
      return send(200, { ok: true, tasks })
    }
    if (url.pathname === '/task/evidence') return send(200, { ok: true, evidence: [] })
    if (url.pathname === '/events') return send(200, { ok: true, events: [] })
    send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no route' } })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.() }),
  }
}

test('路由：GET api/alerts 200 JSON，契约字段齐全（数据源全缺时也是 0 告警 + 降级）', async () => {
  const { resource } = mount({})
  await withRouteServer(resource, async baseUrl => {
    const got = await hit(baseUrl, `${ROUTE_PREFIX}/${ALERTS_FILE}`)
    assert.equal(got.status, 200)
    assert.match(got.headers.get('content-type'), /^application\/json/)
    assert.equal(got.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(got.json).sort(), ['alerts', 'counts', 'degraded', 'generatedAt', 'source'])
    assert.deepEqual(got.json.alerts, [])
    assert.deepEqual(got.json.counts, { high: 0, medium: 0, low: 0, total: 0 })
    assert.ok(got.json.degraded.reasons.length > 0)
    assert.equal(got.text.includes('stack'), false)
  })
})

test('路由：HEAD 同头无体；POST/PUT 405 JSON 带 Allow；未知 api 路径是 JSON 404', async () => {
  const { resource } = mount({})
  await withRouteServer(resource, async baseUrl => {
    const head = await hit(baseUrl, `${ROUTE_PREFIX}/${ALERTS_FILE}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    assert.match(head.headers.get('content-type'), /^application\/json/)
    for (const method of ['POST', 'PUT']) {
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${ALERTS_FILE}`, { method })
      assert.equal(got.status, 405)
      assert.equal(got.headers.get('allow'), 'GET, HEAD')
      assert.deepEqual(got.json, { ok: false, error: 'method-not-allowed' })
    }
    const missing = await hit(baseUrl, `${ROUTE_PREFIX}/api/nope`)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.json, { ok: false, error: 'not-found' })
  })
})

test('路由：假板里有一张 stale 任务 → api/alerts 真的报 lease_expired，且 token 不外泄', async () => {
  const token = 'sekret-board-token-should-never-appear'
  const fake = await startFakeBoard([{
    task_id: 't-route-stale',
    title: '路由测试：租约过期的卡',
    lifecycle: 'working',
    stale: 1,
    lease_until: REAL_NOW - 20 * MIN,
    updated_at: REAL_NOW - 30 * MIN,
    created_at: REAL_NOW - HOUR,
    ack_state: 'acked',
    owner_session: 'owner-route',
    version: 3,
  }])
  try {
    const { resource } = mount({ board: { endpoint: fake.endpoint, token, timeoutMs: 2000 } })
    await withRouteServer(resource, async baseUrl => {
      const got = await hit(baseUrl, `${ROUTE_PREFIX}/${ALERTS_FILE}`)
      assert.equal(got.status, 200)
      assert.equal(got.json.source.board, 'real')
      assert.equal(got.json.source.tiers, 'missing')
      const leased = got.json.alerts.filter(alert => alert.ruleId === 'lease_expired')
      assert.equal(leased.length, 1)
      assert.equal(leased[0].subjectId, 't-route-stale')
      assert.equal(leased[0].severity, 'high')
      assert.equal(got.text.includes(token), false, '响应里不许出现板 token')
      assert.equal(got.json.degraded.reasons.some(reason => reason.includes('层级')), true)
    })
  } finally {
    await fake.close()
  }
})

test('板读取器单飞：api/board 与 api/alerts 同时打进来只碰板一次（/health 命中 1）', async () => {
  const fake = await startFakeBoard([{
    task_id: 't-route-done',
    title: '路由测试：正常完成的卡',
    lifecycle: 'done',
    updated_at: REAL_NOW - MIN,
    created_at: REAL_NOW - HOUR,
    ack_state: 'acked',
    version: 2,
  }])
  try {
    const reader = createBoardReader({ board: { endpoint: fake.endpoint, timeoutMs: 2000 } })
    const [first, second] = await Promise.all([reader.read(REAL_NOW), reader.read(REAL_NOW)])
    assert.equal(fake.state.healthHits, 1, '并发读只应打一次 /health')
    assert.equal(first.configured, true)
    assert.equal(first.tasks.length, second.tasks.length)
  } finally {
    await fake.close()
  }
})

/* ───────────────────────────── G. 零依赖 / 不接 LLM ───────────────────────────── */

test('零依赖：lib/trail.js 的代码里没有 import/require（不接 LLM、不联网），注释里的出处不算', () => {
  const raw = readFileSync(resolve(ROOT, 'lib', 'trail.js'), 'utf8')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/^\s*import\s/m.test(code), '不得 import 任何模块')
  assert.ok(!/\brequire\s*\(/.test(code), '不得 require')
  assert.ok(!/\bfetch\s*\(/.test(code), '不得发网络请求')
  assert.ok(!/\bchild_process\b/.test(code), '不得起进程')
  assert.ok(!/\blitellm\b|\bopenai\b|\bapi[_-]?key\b/i.test(code), '不得接 LLM/凭据')
  // 注释里必须保留 TRAIL 出处（MIT 归属），这是另一个方向的要求。
  assert.ok(/patronus-ai\/trail-benchmark/.test(raw))
  assert.ok(/MIT/.test(raw))
})
