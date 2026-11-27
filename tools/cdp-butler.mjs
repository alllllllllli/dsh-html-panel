#!/usr/bin/env node
/**
 * tools/cdp-butler.mjs —— 大管家 0.7.0 页面的运行时自检（Edge headless + CDP，零依赖）。
 *
 * 用内置 HTTP fixture 起一个同源站点，把 `public/index.html` 按插件真实路由
 * `/dsh-html-panel/` 提供出去，并把只读路由与 `POST api/action` 换成可控 fixture：
 *   - real     真实形状数据：4 对端链路 / 6 任务 + 8 事件 / 本机 / T0+4×T1+6×T2+2×T3 /
 *              0.7.0 M0（butler/sessions：真实 state + 跨机只读）+ M1（butler/dialog：真实对话形状）；
 *   - degraded api/tiers 只给 T0 + degraded（模拟本机/远端数据源不可用；M0 路由 404）；
 *   - tiers404 api/tiers 返回 404（模拟「新路由要重启 DSH」这一真实中间态）；
 *   - butler404 api/tiers 真实、api/butler/* 404（测 M0/M1 未加载时右栏退回、中栏诚实提示）；
 *   - mock     所有接口 500（页面必须落回 MOCK 兜底并明确标注）。
 *
 * 断言覆盖：五页导航切换与真实渲染、右栏 T0–T3 计数/折叠/选中上级路径、动作四态回执、
 * 报告预览、记忆探测、900 抽屉、无横向溢出、页面 JS 报错 0；截图写入 tools/shots/。
 *
 * 用法: node tools/cdp-butler.mjs
 * 产物: tools/shots/cdp-butler-report.json + shot-butler-*.png
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { injectWriteConfig } from '../lib/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_FILE = path.join(ROOT, 'public', 'index.html')
const OUT_DIR = path.join(ROOT, 'tools', 'shots')
const ROUTE = '/dsh-html-panel'
const VIEWPORT = { width: 1440, height: 1000 }

/* ───────────────────────── fixture 数据 ───────────────────────── */
const NOW = Date.parse('2026-11-21T08:00:00.000Z')
const CLUSTER_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  interconnect: true,
  self: { instanceId: 'pc-ky614' },
  peers: [
    { instanceId: 'server', origin: '127.0.0.1:13080', link: 'up' },
    { instanceId: 's5', origin: '127.0.0.1:13082', link: 'down' },
    { instanceId: 'cloud', origin: '127.0.0.1:13085', link: 'down' },
    { instanceId: 'mcloud', origin: '127.0.0.1:13086', link: 'down' }
  ],
  board: null
}
const HOST_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  hostname: 'fixture-pc',
  os: { platform: 'win32', release: '10.0.26300', uptimeSec: 7200 },
  memory: { totalBytes: 34359738368, freeBytes: 17179869184, ratio: 0.5 },
  cpu: { count: 12, load1: 0 },
  disks: [
    { mount: 'C:', label: 'C: 系统盘', totalBytes: 155692564480, freeBytes: 107374182400, ratio: 0.31, error: null },
    { mount: 'D:', label: 'D: 数据盘', totalBytes: 1030792151040, freeBytes: 579820584960, ratio: 0.44, error: null }
  ]
}
/** 官方 Agent Teams 投影 fixture（0.5.0）：一条可认领 + 一条进行中（带写域告警）。 */
const OFFICIAL_REAL = {
  available: true,
  teams: [{ sessionId: 'session-main', title: '主控会话', enabled: true, taskCount: 2, shownTasks: 2 }],
  tasks: [
    { id: 'task-official-1', revision: 1, subject: 'fixture：官方任务可认领', description: 'CDP fixture 官方任务，不是真实任务。', status: 'pending', blockedBy: [], writeScopes: ['lib/panel'], ready: true, writeScopeWarnings: [], source: 'official', sessionId: 'session-main', sessionTitle: '主控会话', teamEnabled: true },
    { id: 'task-official-2', revision: 2, subject: 'fixture：官方任务写域告警', description: 'CDP fixture 官方任务，不是真实任务。', status: 'in_progress', blockedBy: ['task-official-1'], writeScopes: ['lib/panel/public'], ownerId: 'session-child-1', ownerName: 'fixture-lead/层级交互', ready: false, writeScopeWarnings: ['write scopes overlap with task-official-3'], source: 'official', sessionId: 'session-main', sessionTitle: '主控会话', teamEnabled: true }
  ],
  hiddenTasks: 0,
  truncated: false
}
const BOARD_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  configured: true,
  source: { origin: '172.24.112.11:13090' },
  health: { ok: true, latencyMs: 37, service: 'dsh-team-mesh board', version: '1.0.0', schema_version: 4 },
  tasks: [
    { id: 't-fixture-1', title: 'fixture：核对板服务监听地址', state: 'leased', owner: 'agent-team:pc:lead', node: 'pc-ky614', evidenceCount: 2, acceptance: ['fixture 验收 A'], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 90000, updatedAt: NOW - 60000, leaseDeadline: NOW + 120000, lifecycle: 'working', ackState: 'acked' },
    { id: 't-fixture-2', title: 'fixture：汇总升级清单', state: 'done', owner: 'agent-team:server:worker-1', node: 'server', evidenceCount: 3, acceptance: ['fixture 验收 B'], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 300000, updatedAt: NOW - 240000, lifecycle: 'done', ackState: 'acked' },
    { id: 't-fixture-3', title: 'fixture：双机互发验证', state: 'awaiting', owner: 'agent-team:mcloud:worker-1', node: 'mcloud', evidenceCount: 1, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 600000, updatedAt: NOW - 420000, lifecycle: 'open', ackState: 'pending' },
    { id: 't-fixture-4', title: 'fixture：清理临时验证目录', state: 'undelivered', owner: null, node: null, evidenceCount: 0, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 900000, updatedAt: NOW - 780000, lifecycle: 'open', ackState: 'none' },
    { id: 't-fixture-5', title: 'fixture：给板服务加观测端点', state: 'stale', owner: 'agent-team:cloud:worker-2', node: 'cloud', evidenceCount: 1, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 3600000, updatedAt: NOW - 3000000, lifecycle: 'working', ackState: 'acked' },
    { id: 't-fixture-6', title: 'fixture：已取消的历史任务', state: 'canceled', owner: null, node: null, evidenceCount: 0, acceptance: [], brief: 'fixture 任务，不是真实任务。', createdAt: NOW - 7200000, updatedAt: NOW - 7000000, lifecycle: 'canceled', ackState: 'none' }
  ],
  official: OFFICIAL_REAL,
  events: Array.from({ length: 8 }, (_, index) => ({
    task: 't-fixture-' + (index + 1),
    at: NOW - (index + 1) * 60000,
    kind: index % 2 === 0 ? 'task.created' : 'task.reported',
    node: index % 2 === 0 ? 'pc-ky614' : 'server',
    text: 'fixture 事件 ' + (index + 1) + '（CDP 自检数据，不是真实事件）',
    seq: 200 - index
  }))
}

/** 真实形状的层级树：T0 + 4×T1 + 6×T2 + 2×T3（设备只作标签）。 */
const TIERS_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  source: {
    local: 'sessions+agents',
    subagents: 'session-header(origin+parentSession)',
    subagentMode: 'official-projection',
    remote: [
      { instanceId: 'server', link: 'up', sessions: 2 },
      { instanceId: 's5', link: 'down', sessions: 0 },
      { instanceId: 'cloud', link: 'down', sessions: 0 },
      { instanceId: 'mcloud', link: 'up', sessions: 1 }
    ],
    cached: false,
    ageMs: 0
  },
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: new Date(NOW - 3600000).toISOString() },
  nodes: [
    { id: 'session-main', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '主控会话', status: 'run', startedAt: new Date(NOW - 1800000).toISOString(), childSessionId: 'session-main', parentSessionId: null, mode: null },
    { id: 'session-child-1', parentId: 'session-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '层级交互', status: 'run', startedAt: new Date(NOW - 1200000).toISOString(), childSessionId: 'session-child-1', parentSessionId: 'session-main', mode: 'continuable' },
    { id: 'session-grand-1', parentId: 'session-child-1', tier: 3, kind: 'subagent', device: 'pc-ky614', title: '折叠态走查', status: 'run', startedAt: new Date(NOW - 900000).toISOString(), childSessionId: 'session-grand-1', parentSessionId: 'session-child-1', mode: 'one-shot' },
    { id: 'session-child-2', parentId: 'session-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '长名字截断样式回归用例集', status: 'queue', startedAt: new Date(NOW - 1100000).toISOString(), childSessionId: 'session-child-2', parentSessionId: 'session-main', mode: 'unknown' },
    { id: 'server:session-aaa', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: '查看本机SSH公钥', status: 'idle', startedAt: null },
    { id: 'server:session-r1', parentId: 'server:session-aaa', tier: 2, kind: 'subagent', device: 'server', title: '连线与缩进校对', status: 'done', startedAt: null },
    { id: 'server:session-r2', parentId: 'server:session-aaa', tier: 2, kind: 'subagent', device: 'server', title: '折叠状态回归', status: 'idle', startedAt: null },
    { id: 'server:session-bbb', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: 'Deepfish 私信回复', status: 'idle', startedAt: null },
    { id: 'server:session-grand-2', parentId: 'server:session-r1', tier: 3, kind: 'subagent', device: 'server', title: '1440/900 截图复核', status: 'done', startedAt: null },
    { id: 'mcloud:session-ccc', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'mcloud', title: 'OV 索引巡检', status: 'idle', startedAt: null },
    { id: 'mcloud:session-m1', parentId: 'mcloud:session-ccc', tier: 2, kind: 'subagent', device: 'mcloud', title: '记忆库巡检', status: 'idle', startedAt: null },
    { id: 'mcloud:session-m2', parentId: 'mcloud:session-ccc', tier: 2, kind: 'subagent', device: 'mcloud', title: '索引重建等待', status: 'queue', startedAt: null }
  ],
  degraded: { reason: '远端设备的子代理层级不可见（interconnect 只列顶层活会话）' }
}

const TIERS_DEGRADED = {
  generatedAt: new Date(NOW).toISOString(),
  source: { local: 'unavailable', subagents: 'unavailable', remote: [{ instanceId: 'server', link: 'down', sessions: 0 }], cached: false, ageMs: 0 },
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', startedAt: new Date(NOW).toISOString() },
  nodes: [],
  degraded: { reason: '本实例没有可用的 interconnect 服务：其它设备的会话不可见；DSH 没有可用的 sessions 服务：本机会话层级不可见' }
}

/**
 * 0.7.0 M0 fixture：与 TIERS_REAL 同一棵树，再补真实 state 字段
 * （statusText / updatedAt / active / running / queue / pendingInput / readonly）。
 * 这是 CDP fixture，不是真实会话；页面/断言都按它当「接口返回的形状」用。
 */
const BUTLER_REAL = {
  generatedAt: new Date(NOW).toISOString(),
  root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', statusText: '运行中', startedAt: new Date(NOW - 3600000).toISOString(), readonly: false },
  source: { sessions: 'sessionController.list', states: 'sessionController.state', lineage: 'api/tiers(shared 4s cache)', remote: 'interconnect.list', cached: false, ageMs: 0 },
  counts: { 0: 1, 1: 4, 2: 6, 3: 2 },
  total: 12,
  binding: { sessionId: 'session-main', title: '主控会话', targetMode: 'recent-root', resolvedBy: 'recent-root', available: true },
  nodes: [
    { id: 'session-main', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '主控会话', status: 'run', statusText: '运行中', startedAt: new Date(NOW - 1800000).toISOString(), updatedAt: new Date(NOW - 60000).toISOString(), active: true, running: true, queue: 2, pendingInput: [], stateKnown: true, mode: null, parentSessionId: null, childSessionId: 'session-main', readonly: false, controllable: true },
    { id: 'session-child-1', parentId: 'session-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '层级交互', status: 'run', statusText: '运行中', startedAt: new Date(NOW - 1200000).toISOString(), updatedAt: new Date(NOW - 120000).toISOString(), active: true, running: true, queue: 0, pendingInput: [], stateKnown: true, mode: 'continuable', parentSessionId: 'session-main', childSessionId: 'session-child-1', readonly: false, controllable: true },
    { id: 'session-grand-1', parentId: 'session-child-1', tier: 3, kind: 'subagent', device: 'pc-ky614', title: '折叠态走查', status: 'idle', statusText: '空闲', startedAt: new Date(NOW - 900000).toISOString(), updatedAt: new Date(NOW - 300000).toISOString(), active: true, running: false, queue: 0, pendingInput: [], stateKnown: true, mode: 'one-shot', parentSessionId: 'session-child-1', childSessionId: 'session-grand-1', readonly: false, controllable: true },
    { id: 'session-child-2', parentId: 'session-main', tier: 2, kind: 'subagent', device: 'pc-ky614', title: '长名字截断样式回归用例集', status: 'blocked', statusText: '等审批', startedAt: new Date(NOW - 1100000).toISOString(), updatedAt: new Date(NOW - 200000).toISOString(), active: true, running: false, queue: 0, pendingInput: ['approval'], stateKnown: true, mode: 'unknown', parentSessionId: 'session-main', childSessionId: 'session-child-2', readonly: false, controllable: true },
    { id: 'server:session-aaa', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: '查看本机SSH公钥', status: 'idle', statusText: '空闲', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'server:session-r1', parentId: 'server:session-aaa', tier: 2, kind: 'subagent', device: 'server', title: '连线与缩进校对', status: 'done', statusText: '已完成', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'server:session-r2', parentId: 'server:session-aaa', tier: 2, kind: 'subagent', device: 'server', title: '折叠状态回归', status: 'idle', statusText: '空闲', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'server:session-bbb', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'server', title: 'Deepfish 私信回复', status: 'idle', statusText: '空闲', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'server:session-grand-2', parentId: 'server:session-r1', tier: 3, kind: 'subagent', device: 'server', title: '1440/900 截图复核', status: 'done', statusText: '已完成', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'mcloud:session-ccc', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'mcloud', title: 'OV 索引巡检', status: 'idle', statusText: '空闲', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'mcloud:session-m1', parentId: 'mcloud:session-ccc', tier: 2, kind: 'subagent', device: 'mcloud', title: '记忆库巡检', status: 'idle', statusText: '空闲', startedAt: null, updatedAt: null, active: false, running: false, queue: 0, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false },
    { id: 'mcloud:session-m2', parentId: 'mcloud:session-ccc', tier: 2, kind: 'subagent', device: 'mcloud', title: '索引重建等待', status: 'queue', statusText: '排队', startedAt: null, updatedAt: null, active: false, running: false, queue: 1, pendingInput: [], stateKnown: false, mode: null, readonly: true, controllable: false }
  ],
  remote: [
    { instanceId: 'server', link: 'up', readonly: true, controllable: false, note: '远端只读不可控（interconnect 只能列标题/状态，不能读对话、不能中断）', sessions: 5 },
    { instanceId: 's5', link: 'down', readonly: true, controllable: false, note: '远端只读不可控（interconnect 只能列标题/状态，不能读对话、不能中断）', sessions: 0 },
    { instanceId: 'cloud', link: 'down', readonly: true, controllable: false, note: '远端只读不可控（interconnect 只能列标题/状态，不能读对话、不能中断）', sessions: 0 },
    { instanceId: 'mcloud', link: 'up', readonly: true, controllable: false, note: '远端只读不可控（interconnect 只能列标题/状态，不能读对话、不能中断）', sessions: 3 }
  ],
  remoteNote: '跨机会话只读：能看标题/状态，不能读对话、不能催办/中断（M0/M1 边界）',
  degraded: { reason: '远端设备的子代理层级不可见（interconnect 只列顶层活会话）' }
}

/**
 * 0.7.0 M1 fixture：真实 events() 归一化后的形状（主人/系统注入/助手思考/工具卡）。
 * 不是真实对话内容，是给页面/断言用的接口形状样本。
 */
const DIALOG_REAL = {
  available: true,
  generatedAt: new Date(NOW).toISOString(),
  sessionId: 'session-main',
  title: '主控会话',
  targetMode: 'recent-root',
  resolvedBy: 'recent-root',
  state: { active: true, running: true, queue: 2, pendingInput: [], status: 'run', statusText: '运行中', stateKnown: true },
  stateKnown: true,
  cursor: 16,
  hasMore: true,
  limit: 30,
  before: null,
  counts: { messages: 4, events: 9, tools: 2 },
  messages: [
    { seq: 9, role: 'user', time: new Date(NOW - 9 * 60000).toISOString(), text: '按 M0+M1 把中栏换成真实会话对话，右栏用真实状态；写通道先不开。' },
    { seq: 10, role: 'notice', time: new Date(NOW - 8 * 60000).toISOString(), text: '系统注入上下文（fixture）：AGENTS.md 规则摘要…', injected: true, source: 'context' },
    { seq: 11, role: 'assistant', time: new Date(NOW - 7 * 60000).toISOString(), text: '先读可行性报告，再落地 lib/butler.js 的两个只读路由（M0/M1）。', thinking: '口径：只读、不重启 DSH、不编对话；工具输出只留摘要。', tools: [
      { seq: 12, callId: 'call-1', name: 'read', args: '{"file_path":"big-butler-upgrade/butler-cockpit-feasibility.md"}', result: { summary: '224 行 · 真实 API 文件:行 与限制已核对', isError: false } },
      { seq: 14, callId: 'call-2', name: 'bash', args: 'node --test tools/butler.test.mjs', result: { summary: '25 tests · 25 pass · 0 fail', isError: false } }
    ] },
    { seq: 16, role: 'assistant', time: new Date(NOW - 2 * 60000).toISOString(), text: 'M0/M1 已通过单测；中栏现在读的是真实 events() 归一化结果，写通道未开启。' }
  ]
}

/**
 * 0.8.0 fixture：配置固定的专属大管家会话（pinned）+ 写通道打开。
 * 与 BUTLER_REAL 同一棵树，只换 binding/write —— 页面断言「大管家 · 常驻」/「可发送」用。
 */
const BUTLER_PINNED = {
  ...BUTLER_REAL,
  binding: { sessionId: 'session-butler', title: '连通性测试（fixture）', label: '大管家 · 常驻', agentPreset: 'butler-lead', targetMode: 'pinned', resolvedBy: 'config', available: true },
  write: { enabled: true, targetSessionId: 'session-butler', label: '大管家 · 常驻', agentPreset: 'butler-lead', note: 'CDP fixture：写通道打开' },
  nodes: [
    { id: 'session-butler', parentId: 'pc-ky614', tier: 1, kind: 'session', device: 'pc-ky614', title: '连通性测试（fixture）', status: 'idle', statusText: '空闲', startedAt: new Date(NOW - 600000).toISOString(), updatedAt: new Date(NOW - 120000).toISOString(), active: true, running: false, queue: 0, pendingInput: [], stateKnown: true, mode: null, parentSessionId: null, childSessionId: 'session-butler', readonly: false, controllable: true },
    ...BUTLER_REAL.nodes
  ],
  counts: { 0: 1, 1: 5, 2: 6, 3: 2 },
  total: 13,
}
/** 0.8.0 fixture：配置指向的专属会话已不存在（binding.available=false）→ 页面显示原因 + 重建按钮。 */
const BUTLER_PINNED_MISSING = {
  ...BUTLER_PINNED,
  binding: {
    sessionId: 'session-butler-gone',
    title: null,
    label: '大管家 · 常驻',
    targetMode: 'pinned',
    resolvedBy: 'config',
    available: false,
    reason: 'config.butler.sessionId 指向的专属大管家会话不在可见会话列表里（可能已归档或删除）：请用「重建专属会话」',
  },
  write: { enabled: true, targetSessionId: 'session-butler-gone', label: '大管家 · 常驻' },
}
/** 0.8.0 fixture：配置要 pinned 但还没创建（sessionId 为空）→ 页面显示「创建专属会话」。 */
const BUTLER_UNBOUND = {
  ...BUTLER_PINNED,
  binding: {
    sessionId: '',
    title: null,
    label: '大管家 · 常驻',
    agentPreset: 'butler-lead',
    targetMode: 'pinned',
    resolvedBy: 'config',
    available: false,
    reason: '尚未创建专属大管家会话（config.butler.sessionId 为空）：用「创建专属会话」按配置的预设建一个',
  },
  write: { enabled: true, targetSessionId: null, label: '大管家 · 常驻', agentPreset: 'butler-lead' },
}
/** 0.8.0 fixture：pinned 绑定下的对话流。 */
const DIALOG_PINNED = {
  ...DIALOG_REAL,
  sessionId: 'session-butler',
  title: '连通性测试（fixture）',
  targetMode: 'pinned',
  resolvedBy: 'config',
  state: { active: true, running: false, queue: 0, pendingInput: [], status: 'idle', statusText: '空闲', stateKnown: true },
  hasMore: false,
  counts: { messages: 2, events: 2, tools: 0 },
  messages: [
    { seq: 1, role: 'user', time: new Date(NOW - 60000).toISOString(), text: '连通性测试，请只回复 OK，不要调用工具、不要改任何文件。' },
    { seq: 2, role: 'assistant', time: new Date(NOW - 50000).toISOString(), text: 'OK' },
  ],
}

/* ───────────────────────── fixture HTTP 服务 ───────────────────────── */
async function startFixtureServer() {
  const state = { scenario: 'real', sayRequests: [], sessionRequests: [] }
  const isPinned = () => state.scenario === 'real-pinned' || state.scenario === 'real-pinned-missing' || state.scenario === 'real-unbound'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    const sendJson = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (pathname === ROUTE + '/index.html' || pathname === ROUTE + '/') {
      try {
        let body = await readFile(PAGE_FILE, 'utf8')
        if (isPinned()) {
          // 模拟 Host 在服务页面时注入写通道配置（token 只进 HTML；这是 CDP fixture token）。
          body = injectWriteConfig(body, {
            allowWrite: true,
            label: '大管家 · 常驻',
            token: 'cdp-fixture-write-token',
            sessionId: state.scenario === 'real-pinned-missing'
              ? 'session-butler-gone'
              : (state.scenario === 'real-unbound' ? '' : 'session-butler'),
          })
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String((error && error.message) || error))
      }
      return
    }
    if (pathname === ROUTE + '/api/butler/say' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let parsed = null
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        parsed = null
      }
      const token = req.headers['x-butler-write-token']
      if (token !== 'cdp-fixture-write-token') {
        sendJson(401, { ok: false, code: 'write-token-missing', reason: 'CDP fixture：token 不对' })
        return
      }
      state.sayRequests.push({ token: String(token), sessionId: parsed && parsed.sessionId, content: parsed && parsed.content, requestId: parsed && parsed.requestId })
      sendJson(200, { ok: true, accepted: true, mode: 'queue', sessionId: parsed && parsed.sessionId, requestId: parsed && parsed.requestId })
      return
    }
    if (pathname === ROUTE + '/api/butler/session' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let parsed = null
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        parsed = null
      }
      state.sessionRequests.push(parsed)
      sendJson(200, { ok: true, action: parsed && parsed.action, sessionId: 'session-butler-rebuilt', label: '大管家 · 常驻', titleApplied: true, persisted: true, config: { updated: true, backup: 'cordis.patch.yml.bak-before-panel-butler-fixture' } })
      return
    }
    if (pathname === ROUTE + '/api/action' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let action = ''
      try {
        action = JSON.parse(Buffer.concat(chunks).toString('utf8')).action
      } catch {
        action = ''
      }
      if (action === 'probe-memory') {
        sendJson(200, { ok: true, action, url: 'about:blank', origin: '172.24.112.11:1933', status: 200, latencyMs: 12 })
      } else if (action === 'latest-report') {
        sendJson(200, {
          ok: true,
          action,
          dir: 'fixture/docs',
          dirLabel: 'docs',
          file: { name: 'fixture-report.md', mtime: NOW - 600000, size: 42 },
          content: '# fixture 报告\n\n- 来自 CDP fixture，不是真实报告\n',
          truncated: false,
          readBytes: 42
        })
      } else if (action === 'open-reports-folder') {
        sendJson(200, { ok: true, action, dir: 'fixture/docs' })
      } else {
        sendJson(200, { ok: false, code: 'unknown-action', reason: 'fixture 未实现该动作' })
      }
      return
    }
    if (pathname === ROUTE + '/api/cluster') {
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(200, CLUSTER_REAL)
    }
    if (pathname === ROUTE + '/api/board') {
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(200, BOARD_REAL)
    }
    if (pathname === ROUTE + '/api/host') {
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(200, HOST_REAL)
    }
    if (pathname === ROUTE + '/api/tiers') {
      if (state.scenario === 'tiers404') return sendJson(404, { ok: false, error: 'not-found' })
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      if (state.scenario === 'degraded') return sendJson(200, TIERS_DEGRADED)
      return sendJson(200, TIERS_REAL)
    }
    /* 0.7.0 M0/M1：只有 real 场景模拟「新版 Host 已加载」；其它场景 404 = 旧 Host（需重启 DSH），
       butler404 场景测「M0 未加载时右栏退回 tiers、中栏诚实提示」。 */
    if (pathname === ROUTE + '/api/butler/sessions') {
      if (state.scenario === 'real-pinned') return sendJson(200, BUTLER_PINNED)
      if (state.scenario === 'real-pinned-missing') return sendJson(200, BUTLER_PINNED_MISSING)
      if (state.scenario === 'real-unbound') return sendJson(200, BUTLER_UNBOUND)
      if (state.scenario === 'real' || state.scenario === 'real-nodlg') return sendJson(200, BUTLER_REAL)
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(404, { ok: false, error: 'not-found' })
    }
    if (pathname === ROUTE + '/api/butler/dialog') {
      if (state.scenario === 'real-pinned' || state.scenario === 'real-pinned-missing') return sendJson(200, DIALOG_PINNED)
      if (state.scenario === 'real') {
        const before = url.searchParams.get('before')
        if (before === null) return sendJson(200, DIALOG_REAL)
        return sendJson(200, {
          ...DIALOG_REAL,
          cursor: Number(before) - 1,
          hasMore: false,
          counts: { messages: 1, events: 1, tools: 0 },
          messages: [{ seq: Number(before) - 1, role: 'user', time: new Date(NOW - 30 * 60000).toISOString(), text: '更早的一条 fixture 消息（before 翻页）' }]
        })
      }
      if (state.scenario === 'mock') return sendJson(500, { error: 'fixture-down' })
      return sendJson(404, { ok: false, error: 'not-found' })
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  return {
    baseUrl: 'http://127.0.0.1:' + port,
    setScenario: name => { state.scenario = name },
    sayRequests: () => state.sayRequests.slice(),
    sessionRequests: () => state.sessionRequests.slice(),
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.() })
  }
}

/* ───────────────────────── 最小 CDP 客户端 ───────────────────────── */
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => existsSync(p))

async function pickPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(400) })
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
    '--disable-popup-blocking',
    '--force-device-scale-factor=1',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    'about:blank'
  ], { stdio: 'ignore' })
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    try {
      const info = await (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) })).json()
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
      // 看门狗：无头浏览器偶发不回 CDP 响应时，20 秒后明确失败而不是永远挂住。
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('CDP timeout: ' + method + ' (' + 20000 + 'ms)'))
      }, 20000)
      if (typeof timer.unref === 'function') timer.unref()
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  function on(method, fn) {
    handlers.set(method, [...(handlers.get(method) || []), fn])
  }
  return { ws, opened, send, on }
}

/* ───────────────────────── 主流程 ───────────────────────── */
const report = {
  page: 'public/index.html',
  viewport: VIEWPORT,
  generatedAt: new Date().toISOString(),
  checks: [],
  shots: [],
  pageErrors: [],
  runtimeErrors: [],
  scenarios: [],
  ok: false
}
const sleep = ms => new Promise(done => setTimeout(done, ms))

/** 页面状态提取：一次 evaluate 取回所有断言需要的 DOM 事实。 */
const PAGE_STATE = `(() => {
  const q = s => document.querySelector(s);
  const qa = s => Array.from(document.querySelectorAll(s));
  const txt = s => { const el = q(s); return el ? el.textContent.trim() : ''; };
  return {
    title: document.title,
    ready: !!q('#page-butler'),
    dataset: Object.assign({}, document.body.dataset),
    nav: qa('.nav-item[data-page]').map(b => ({ page: b.dataset.page, active: b.classList.contains('active'), label: (b.querySelector('.nav-label') || {}).textContent || '' })),
    visiblePages: ['butler','tasks','cluster','memory','settings'].filter(p => q('#page-' + p) && !q('#page-' + p).hidden),
    dialog: {
      title: txt('#sessTitle'),
      stateText: txt('#dlgStateText'),
      bindMode: txt('#bindMode'),
      empty: q('#dialogEmpty') ? !q('#dialogEmpty').hidden : false,
      emptyText: txt('#dialogEmpty'),
      messages: qa('#dialogList .msg').length,
      users: qa('#dialogList .msg.user').length,
      notices: qa('#dialogList .msg.notice').length,
      bots: qa('#dialogList .msg.bot').length,
      toolCards: qa('#dialogList .tcard').length,
      thinks: qa('#dialogList .think').length,
      seps: qa('#dialogList .dlg-sep').length,
      text: txt('#dialogList'),
      pickOptions: qa('#sessionPick option').length,
      pickValue: q('#sessionPick') ? q('#sessionPick').value : '',
      earlierHidden: q('#loadEarlierWrap') ? q('#loadEarlierWrap').hidden : true,
      pill: q('#pillDialog') ? txt('#pillDialog') : '',
      readonlyTag: q('#dlgRoTag') ? !q('#dlgRoTag').hidden : false,
      pinned: q('#bindPinned') ? !q('#bindPinned').hidden : false,
      pinnedText: q('#bindPinned') ? txt('#bindPinned') : '',
      writeTag: q('#dlgWriteTag') ? !q('#dlgWriteTag').hidden : false,
      rebuildHidden: q('#rebuildBtn') ? q('#rebuildBtn').hidden : true,
      rebuildText: q('#rebuildBtn') ? txt('#rebuildBtn') : '',
      bindNote: txt('#bindNote'),
      bindNoteHidden: q('#bindNote') ? q('#bindNote').hidden : true,
      composerDisabled: q('#prompt') ? q('#prompt').disabled === true : false,
      sendDisabled: q('#sendBtn') ? q('#sendBtn').disabled === true : false,
      composerRo: q('#composerRo') ? txt('#composerRo') : '',
      composerValue: q('#prompt') ? q('#prompt').value : ''
    },
    confirm: { visible: q('#confirmMask') ? !q('#confirmMask').hidden : false, target: txt('#confirmTarget'), preview: txt('#confirmPreview') },
    statusDetail: q('#statusDetail') ? !q('#statusDetail').hidden : false,
    tier: {
      nodes: qa('#tree .node').length,
      cnt: [0,1,2,3].map(i => txt('#cntT' + i)),
      degraded: q('#tierDegraded') ? !q('#tierDegraded').hidden : false,
      degradedTitle: q('#tierDegraded') ? q('#tierDegraded').title : '',
      treeText: txt('#tree'),
      hint: txt('#tierHint'),
      hhDesc: txt('#hhDesc'),
      sourceHint: txt('#tierSourceHint'),
      devices: qa('#tree .dev').map(e => e.textContent.trim()),
      badges: qa('#tree .node > .head > .badge').map(e => e.textContent.trim()),
      readonlyNodes: qa('#tree .node[data-readonly="1"]').length,
      roTags: qa('#tree .ro-tag').length,
      statusTexts: qa('#tree .nst').map(e => e.textContent.trim())
    },
    tasks: {
      rows: qa('#taskList .item').length,
      events: qa('#eventList .item').length,
      badge: q('#boardBadge') ? q('#boardBadge').getAttribute('data-kind') : '',
      badgeText: txt('#boardBadgeText')
    },
    cluster: {
      nodes: qa('#topoNodes .node').length,
      pending: qa('#topoNodes .pending').length,
      devRows: qa('#clusterList .dev-row').length,
      state: q('#topoSource') ? q('#topoSource').getAttribute('data-state') : '',
      text: txt('#topoSourceText')
    },
    chrome: {
      statDevices: txt('#statDevices'),
      statBoard: txt('#statBoard'),
      sfSub: txt('#sfSub'),
      sfDev: txt('#sfDev'),
      navTasks: txt('#navTasksCount'),
      navCluster: txt('#navClusterCount'),
      pillTiers: txt('#pillTiers'),
      pillBoard: txt('#pillBoard'),
      pillHost: txt('#pillHost')
    },
    tq: {
      bar: !!q('#statusBar'),
      expanded: q('#statusBar') ? q('#statusBar').getAttribute('data-expanded') === 'true' : false,
      summary: txt('#statusSummary'),
      chips: txt('#statusChips'),
      needs: txt('#tqNeedsN'),
      health: txt('#tqHealthN'),
      history: txt('#tqHistoryN'),
      needsRows: qa('#tqNeedsList .tq-li').length,
      healthRows: qa('#tqHealthList .tq-li').length,
      historyRows: qa('#tqHistoryList .tq-li').length,
      needsText: txt('#tqNeedsList'),
      healthText: txt('#tqHealthList'),
      historyText: txt('#tqHistoryList')
    },
    official: {
      rows: qa('#officialList .item').length,
      empty: q('#officialEmpty') ? !q('#officialEmpty').hidden : false,
      emptyText: txt('#officialEmpty'),
      hint: txt('#officialHint'),
      count: txt('#officialCount'),
      sourceTags: qa('#officialList .src-tag').map(e => e.textContent.trim()),
      detailText: txt('#officialList')
    },
    taskDots: qa('#taskList .sd').length,
    modeTags: qa('#tree .mode-tag').map(e => e.textContent.trim()),
    lineage: qa('#tree .node').slice(0, 4).map(n => ({
      mode: n.getAttribute('data-mode'),
      child: n.getAttribute('data-child-session'),
      parent: n.getAttribute('data-parent-session')
    })),
    settingsOfficial: txt('#setOfficial'),
    receipts: qa('#receiptList li').filter(li => li.querySelector('.r-state')).map(li => ({
      label: (li.querySelector('b') || {}).textContent || '',
      state: (li.querySelector('.r-state') || {}).textContent || '',
      text: (li.querySelector('.r-text') || {}).textContent || ''
    })),
    report: { visible: q('#reportPanel') ? !q('#reportPanel').hidden : false, meta: txt('#reportMeta'), content: txt('#reportContent') },
    memory: { state: txt('#memoryState'), badge: txt('#memoryBadgeText') },
    settings: { version: txt('#setVersion'), board: txt('#setBoard'), cluster: txt('#setCluster'), tiers: txt('#setTiersSource'), host: txt('#setHost'), butler: txt('#setButler'), pinned: txt('#setPinned'), write: txt('#setWrite') },
    todoCount: qa('#todoList .todo').length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    hierRect: (() => { const el = q('#hier'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; })(),
    hierTransform: q('#hier') ? getComputedStyle(q('#hier')).transform : '',
    hierMatchesDrawer: !!document.querySelector('body.drawer .hier'),
    drawerRules: (() => {
      const out = [];
      try {
        const sheet = document.styleSheets[0];
        const walk = list => {
          for (const rule of list) {
            if (rule.cssRules) walk(rule.cssRules);
            else if (rule.selectorText && rule.selectorText.indexOf('drawer') !== -1) out.push(rule.selectorText + ' {' + rule.style.cssText + '}');
          }
        };
        walk(sheet.cssRules);
      } catch (error) {
        out.push('style-sheet-error: ' + String(error));
      }
      return out;
    })(),
    drawerBtnDisplay: q('#drawerBtn') ? getComputedStyle(q('#drawerBtn')).display : '',
    bodyDrawer: document.body.classList.contains('drawer'),
    errors: (window.__panelErrors || []).slice()
  };
})()`

let checks = []
function ck(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })
}
function eq(name, actual, expected) {
  ck(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected))
}
function has(name, text, needle) {
  ck(name, typeof text === 'string' && text.includes(needle), 'needle=' + needle)
}

async function main() {
  if (!EDGE) throw new Error('找不到 msedge.exe')
  if (!existsSync(PAGE_FILE)) throw new Error('找不到页面文件')
  await mkdir(OUT_DIR, { recursive: true })
  const profileDir = path.join(os.tmpdir(), 'edge-cdp-butler-' + Date.now())
  await mkdir(profileDir, { recursive: true })

  const fixture = await startFixtureServer()
  const port = await pickPort(9600)
  let child = null
  let browser = null
  try {
    child = await launchEdge(port, profileDir)
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    const pageTarget = list.find(t => t.type === 'page')
    if (!pageTarget) throw new Error('no page target')
    browser = connect(pageTarget.webSocketDebuggerUrl)
    await browser.opened
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await browser.send(domain + '.enable')
    // 无头页面的 CSS transition 可能被节流，测量抽屉位置时不等动画；同时覆盖 reduced-motion 分支。
    await browser.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })

    browser.on('Runtime.exceptionThrown', params => {
      const detail = params && params.exceptionDetails ? (params.exceptionDetails.exception ? params.exceptionDetails.exception.description : params.exceptionDetails.text) : 'exception'
      report.runtimeErrors.push(String(detail).slice(0, 300))
    })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__panelErrors=[];' +
        'addEventListener("error",e=>{try{window.__panelErrors.push("error: "+String(e.message||e))}catch(_){}});' +
        'addEventListener("unhandledrejection",e=>{try{window.__panelErrors.push("rejection: "+String(e.reason))}catch(_){}});'
    })

    async function evaluate(expression) {
      const out = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
      if (out.exceptionDetails) {
        throw new Error('evaluate failed: ' + String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text))
      }
      return out.result.value
    }
    async function waitFor(expression, timeoutMs, label) {
      const deadline = Date.now() + (timeoutMs || 8000)
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return true
        } catch { /* 页面还在导航 */ }
        await sleep(100)
      }
      throw new Error('timeout waiting: ' + (label || expression))
    }
    let viewportNow = { width: VIEWPORT.width, height: VIEWPORT.height }
    async function setViewport(width, height) {
      viewportNow = { width, height }
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await sleep(150)
    }
    async function shot(name) {
      // 无头 Edge + --disable-gpu 偶发在「稳态页面」上卡住 Page.captureScreenshot；
      // 处理：先关动画/过渡（不影响布局），再依次尝试 默认 / 强制一次 viewport 重绘 /
      // captureBeyondViewport / fromSurface:false；并且校验产物不是纯黑小图。
      try {
        await evaluate(`(() => {
          let style = document.getElementById('__cdp_no_anim');
          if (!style) {
            style = document.createElement('style');
            style.id = '__cdp_no_anim';
            style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
            document.head.appendChild(style);
          }
          return true;
        })()`)
      } catch { /* 页面还在导航时忽略 */ }
      const { width, height } = viewportNow
      const attempts = [
        async () => browser.send('Page.captureScreenshot', { format: 'png' }),
        async () => {
          await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          await sleep(120)
          return browser.send('Page.captureScreenshot', { format: 'png' })
        },
        async () => browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }),
        async () => browser.send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
      ]
      let lastError = null
      for (const attempt of attempts) {
        try {
          const { data } = await attempt()
          const buffer = Buffer.from(data, 'base64')
          if (buffer.length < 20000) throw new Error('screenshot looks blank (' + buffer.length + ' bytes)')
          await writeFile(path.join(OUT_DIR, name), buffer)
          report.shots.push('tools/shots/' + name)
          return true
        } catch (error) {
          lastError = error
          await sleep(150)
        }
      }
      report.shotFailures = [...(report.shotFailures || []), name + ': ' + String((lastError && lastError.message) || lastError)]
      ck('截图失败：' + name, false, String((lastError && lastError.message) || lastError))
      return false
    }
    async function state() {
      return evaluate(PAGE_STATE)
    }
    async function click(selector) {
      const result = await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return "missing"; el.click(); return "clicked"; })()')
      if (result !== 'clicked') throw new Error('click failed: ' + selector + ' -> ' + result)
      await sleep(120)
    }
    async function selectPage(page) {
      await click('.nav-item[data-page="' + page + '"]')
      await waitFor('(() => { const el = document.getElementById("page-' + page + '"); return el && !el.hidden; })()', 5000, 'page ' + page)
    }
    async function waitReceipt(expected, timeoutMs) {
      await waitFor('(() => { const s = document.querySelector("#receiptList .r-state"); return s && s.textContent === ' + JSON.stringify(expected) + '; })()', timeoutMs || 9000, 'receipt ' + expected)
    }
    async function goto(scene) {
      fixture.setScenario(scene)
      const url = fixture.baseUrl + ROUTE + '/index.html?scene=' + encodeURIComponent(scene) + '&t=' + Date.now()
      await browser.send('Page.navigate', { url })
      await waitFor('document.readyState === "complete"', 8000, 'readyState')
      await waitFor('!!document.body && !!document.body.dataset.tiers', 8000, 'boot')
      await waitFor('document.body.dataset.tiers && document.body.dataset.tiers !== "loading"', 9000, 'tiers settled')
      await waitFor('document.body.dataset.butler && document.body.dataset.butler !== "loading"', 9000, 'butler settled')
      await waitFor('document.body.dataset.dialog && document.body.dataset.dialog !== "loading"', 9000, 'dialog settled')
      await waitFor('document.body.dataset.write !== undefined', 9000, 'write settled')
      await waitFor('document.body.dataset.board && document.body.dataset.board !== "loading"', 9000, 'board settled')
      await waitFor('document.body.dataset.cluster && document.body.dataset.cluster !== "loading"', 9000, 'cluster settled')
      await sleep(250)
      return state()
    }

    /* ================= 场景 1：真实数据（1440） ================= */
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    let s = await goto('real')
    report.scenarios.push({ name: 'real', dataset: s.dataset })
    eq('页面标题是大管家', s.title, '大管家 · DSH 控制台')
    eq('默认进大管家页', s.visiblePages.join(','), 'butler')
    eq('五页导航齐全', s.nav.map(n => n.page).join(','), 'butler,tasks,cluster,memory,settings')
    eq('导航文案是大管家口径', s.nav.map(n => n.label).join(','), '大管家,任务,集群,记忆,设置')
    // 0.7.0 M1：中栏是真实对话（fixture 形状），不是示例对话
    eq('中栏顶部标题=绑定会话标题', s.dialog.title, '主控会话')
    has('中栏顶部显示真实会话状态', s.dialog.stateText, '运行中')
    eq('绑定方式=自动最近根会话', s.dialog.bindMode, '自动 · 最近根会话')
    eq('真实对话渲染 4 条消息', s.dialog.messages, 4)
    eq('主人消息 1 条', s.dialog.users, 1)
    eq('系统注入 1 条（灰条）', s.dialog.notices, 1)
    eq('助手消息 2 条', s.dialog.bots, 2)
    eq('工具卡 2 张（折叠）', s.dialog.toolCards, 2)
    eq('思考块 1 个（默认折叠）', s.dialog.thinks, 1)
    ck('时间分隔出现', s.dialog.seps >= 1, 'seps=' + s.dialog.seps)
    has('工具卡有工具名', s.dialog.text, 'read')
    has('工具卡有结果摘要', s.dialog.text, '25 tests')
    ck('中栏不再有示例对话', !s.dialog.text.includes('示例对话') && !s.dialog.text.includes('静态演示'), s.dialog.text.slice(0, 80))
    eq('会话选择器选项=自动+4 个本机会话', s.dialog.pickOptions, 5)
    eq('加载更早消息按钮可见（hasMore=true）', s.dialog.earlierHidden, false)
    has('composer 状态条显示消息/工具计数', s.dialog.pill, '消息 4 · 工具 2')
    eq('对话顶部标只读', s.dialog.readonlyTag, true)
    eq('输入框禁用（写通道不可用）', s.dialog.composerDisabled, true)
    eq('发送按钮禁用（写通道不可用）', s.dialog.sendDisabled, true)
    has('写通道禁用原因写明（自动绑定 / 未注入）', s.dialog.composerRo, '写通道')
    eq('cluster 真实', s.dataset.cluster, 'real')
    eq('board 真实', s.dataset.board, 'real')
    eq('host 真实', s.dataset.host, 'real')
    eq('tiers 真实', s.dataset.tiers, 'real')
    has('顶栏设备统计接真实链路', s.chrome.statDevices, '4 台设备 · 1 条链路 up')
    has('顶栏共享板统计接真实任务数', s.chrome.statBoard, '板上 6 任务')
    has('左栏底部设备状态接真实实例', s.chrome.sfDev, 'pc-ky614')
    has('左栏底部链路统计', s.chrome.sfSub, '4 台设备 · 1 条链路 up')
    eq('任务导航 badge 是真实任务数', s.chrome.navTasks, '6')
    eq('集群导航 badge 是 up/总数', s.chrome.navCluster, '1/4')

    // 0.8.0：一行细状态条（替代 0.5.0 三问条主位）——默认收起，健康/降级进 chip
    eq('细状态条出现（始终在，不占大块）', s.tq.bar, true)
    eq('无 high 告警时状态条默认收起（摘要行可见）', s.tq.expanded, false)
    eq('状态详情面板默认隐藏', s.statusDetail, false)
    has('细状态条摘要给出需要你/在管/板任务', s.tq.summary, '需要你')
    has('细状态条含健康/降级 chip', s.tq.chips, '项降级')
    eq('三问计数=列表长度（需要我 3 mesh + 1 官方可认领）', [s.tq.needs, s.tq.needsRows].join('/'), '4/4')
    // 0.6.0：本 fixture 没有 api/alerts（模拟 Host 未重启），页面按 0.5.0 路径退回，
    // 同时在「系统是否健康」如实加一行「api/alerts 404 需重启」→ 3 条 down 链路 + 1 = 4。
    eq('三问计数=列表长度（健康 3 条 down 链路 + api/alerts 未加载）', [s.tq.health, s.tq.healthRows].join('/'), '4/4')
    eq('三问计数=列表长度（历史 2 行）', [s.tq.history, s.tq.historyRows].join('/'), '2/2')
    has('三问每行说在等谁/要什么', s.tq.needsText, '在等')
    has('三问健康行点名 down 对端', s.tq.healthText, 's5')

    // 0.8.0：点展开箭头后详情面板出现（原三问三大块）
    await click('#statusToggle')
    await sleep(120)
    s = await state()
    eq('点展开箭头 → data-expanded=true', s.tq.expanded, true)
    eq('展开后详情面板出现', s.statusDetail, true)
    await click('#statusToggle')
    await sleep(120)

    // 右栏 T0–T3
    eq('右栏节点总数（1+4+6+2）', s.tier.nodes, 13)
    eq('层级计数 chip T0..T3', s.tier.cnt.join(','), '1,4,6,2')
    eq('节点徽标从 T0 起', s.tier.badges[0], 'T0')
    has('T1 出现在徽标里', s.tier.badges.join(','), 'T1')
    has('T3 出现在徽标里', s.tier.badges.join(','), 'T3')
    has('设备标签出现 pc-ky614', s.tier.devices.join(','), 'pc-ky614')
    has('设备标签出现 server', s.tier.devices.join(','), 'server')
    has('设备标签出现 mcloud', s.tier.devices.join(','), 'mcloud')
    eq('有降级说明时 badge 显示', s.tier.degraded, true)
    has('降级原因来自接口', s.tier.degradedTitle, '远端设备的子代理层级不可见')
    // 0.7.0 M0：右栏状态来自真实 state，跨机节点标只读
    eq('右栏 8 个跨机节点标只读', s.tier.readonlyNodes, 8)
    ck('右栏只读 tag 至少 8 个', s.tier.roTags >= 8, 'roTags=' + s.tier.roTags)
    has('右栏状态文案有等审批（真实 state 映射）', s.tier.statusTexts.join(','), '等审批')
    has('右栏状态文案有运行中', s.tier.statusTexts.join(','), '运行中')
    has('右栏数据源写明 sessionController', s.tier.hint + s.tier.sourceHint, 'sessionController')
    has('右栏说明状态来自 sessionController', s.tier.hhDesc, '状态来自 sessionController')
    eq('1440 无横向溢出', s.overflow <= 1, true)
    await shot('shot-butler-01-dashboard-1440.png')
    await shot('shot-butler07-dialog-1440.png')

    // 页面 2：任务
    await selectPage('tasks')
    s = await state()
    eq('任务页可见', s.visiblePages.join(','), 'tasks')
    eq('任务行数接共享板真值', s.tasks.rows, 6)
    eq('事件流行数接共享板真值', s.tasks.events, 8)
    eq('板 badge 标真实', s.tasks.badge, 'real')
    has('板 badge 文案', s.tasks.badgeText, '真实 · 共享板')
    eq('任务页待办渲染（localStorage）', s.todoCount, 4)
    eq('mesh 任务行都带官方 StateDot 状态点', s.taskDots, 6)
    eq('官方任务板渲染 2 条（只读 official 段）', s.official.rows, 2)
    eq('官方任务板计数=列表长度', s.official.count, '2')
    has('官方任务板标只读与团队数', s.official.hint, '只读 · 1 个团队')
    eq('官方任务行标 source=official', s.official.sourceTags.join(','), '官方,官方')
    has('官方任务详情带就绪/阻塞依赖/写域告警', s.official.detailText, '阻塞依赖')
    has('官方任务详情带写域告警原文', s.official.detailText, 'write scopes overlap with task-official-3')
    await click('#tab-events')
    await waitFor('!document.getElementById("panel-events").hidden', 4000, 'events tab')
    await shot('shot-butler-02-tasks-1440.png')
    await shot('shot-butler07-tasks-1440.png')
    // 官方任务板卡片在任务列表下方，单独滚过去补一张
    await click('#tab-tasks')
    await evaluate('(() => { const el = document.getElementById("officialCard"); if (el) el.scrollIntoView({ block: "center" }); return true; })()')
    await sleep(200)
    await shot('shot-butler-14-official-board-1440.png')
    await evaluate('(() => { const el = document.querySelector("#page-tasks .page-body"); if (el) el.scrollTop = 0; return true; })()')

    // 页面 3：集群
    await selectPage('cluster')
    s = await state()
    eq('集群页可见', s.visiblePages.join(','), 'cluster')
    eq('拓扑真实节点 4 个', s.cluster.nodes, 4)
    eq('拓扑待接入空心圆 1 个', s.cluster.pending, 1)
    ck('设备/链路列表有行', s.cluster.devRows >= 4, 'rows=' + s.cluster.devRows)
    eq('拓扑 badge 标真实', s.cluster.state, 'real')
    has('拓扑 badge 文案', s.cluster.text, '真实 · interconnect')
    await shot('shot-butler-03-cluster-1440.png')

    // 页面 4：记忆（真探测）
    await selectPage('memory')
    await click('#memoryProbe')
    await waitFor('(() => { const s = document.querySelector("#receiptList .r-state"); return s && s.textContent !== "进行中"; })()', 9000, 'memory receipt')
    s = await state()
    const memoryReceipt = s.receipts[0] || {}
    ck('记忆探测回执有结果', memoryReceipt.state === '成功' || memoryReceipt.state === '失败', JSON.stringify(memoryReceipt))
    if (memoryReceipt.state === '成功') {
      eq('记忆 badge 标可达', s.memory.badge, '可达')
      has('记忆状态含 origin', s.memory.state, '172.24.112.11:1933')
    }
    await shot('shot-butler-04-memory-1440.png')

    // 页面 5：设置（只读信息接真实字段）
    await selectPage('settings')
    s = await state()
    eq('设置页可见', s.visiblePages.join(','), 'settings')
    eq('设置页插件版本 0.8.1', s.settings.version, '0.8.1')
    has('设置页驾驶舱状态显示真实绑定', s.settings.butler, '绑定')
    has('设置页驾驶舱状态说明只读', s.settings.butler, '只读')
    has('设置页官方任务板数据源可见', s.settingsOfficial, '可用 · 2 任务 · 1 个团队')
    has('设置页共享板来源接真实 origin', s.settings.board, '172.24.112.11:13090')
    has('设置页层级来源接真实字符串', s.settings.tiers, 'sessions+agents')
    has('设置页本机来源接真实字段', s.settings.host, 'fixture-pc')
    await shot('shot-butler-05-settings-1440.png')

    // 回到大管家：动作四态 + 报告预览
    await selectPage('butler')
    await click('#actionList [data-action="latest-report"]')
    await waitReceipt('成功')
    s = await state()
    eq('最新报告回执成功', s.receipts[0].state, '成功')
    ck('报告面板打开', s.report.visible === true, 'visible=' + s.report.visible)
    has('报告内容来自宿主动作路由', s.report.content, 'fixture 报告')
    await shot('shot-butler-06-action-report-1440.png')

    await click('#actionList [data-action="new-session"]')
    await waitReceipt('暂不支持')
    s = await state()
    has('独立打开时新会话如实说明', s.receipts[0].text, '不在 DSH 面板 iframe')
    await shot('shot-butler-07-action-unsupported-1440.png')

    // 右栏交互：折叠 / 选中上级路径
    const fold = await evaluate(`(() => {
      const node = Array.from(document.querySelectorAll('#tree .node[data-level="T1"]')).find(n => n.querySelector(':scope > .kids > .node'));
      if (!node) return { ok: false, why: 'no-node' };
      const fold = node.querySelector(':scope > .head .fold');
      if (!fold) return { ok: false, why: 'no-fold' };
      fold.click();
      const collapsed = node.classList.contains('collapsed');
      const display = getComputedStyle(node.querySelector(':scope > .kids')).display;
      fold.click();
      return { ok: collapsed && display === 'none' && !node.classList.contains('collapsed'), collapsed, display };
    })()`)
    ck('T1 折叠后子节点隐藏、再点恢复', fold.ok === true, JSON.stringify(fold))

    const select = await evaluate(`(() => {
      const node = document.querySelector('#tree .node[data-level="T2"]');
      if (!node) return { ok: false, why: 'no-t2' };
      const head = node.querySelector(':scope > .head');
      head.click();
      const tree = document.getElementById('tree');
      const first = { hasSel: tree.classList.contains('has-sel'), sel: tree.querySelectorAll('.node.sel').length, path: tree.querySelectorAll('.node.path').length };
      head.click();
      const cleared = !tree.classList.contains('has-sel') && tree.querySelectorAll('.node.path').length === 0;
      return { ok: first.hasSel && first.sel === 1 && first.path >= 3 && cleared, first, cleared };
    })()`)
    ck('点节点高亮 T0→… 上级路径，再点取消', select.ok === true, JSON.stringify(select))
    // 截图要能看到选中态：再点一次 T2 并保留选中，拍完再取消。
    await evaluate(`(() => { const node = document.querySelector('#tree .node[data-level="T2"]'); if (!node) return false; node.querySelector(':scope > .head').click(); return true; })()`)
    await sleep(150)
    s = await state()
    has('选中 T2 后三问历史切到该节点', s.tq.historyText, '层级交互')
    ck('层级节点带官方 mode 徽标（可续聊/一次性/未知）', s.modeTags.includes('可续聊') && s.modeTags.includes('一次性') && s.modeTags.includes('未知'), s.modeTags.join(','))
    ck('层级节点带官方血缘字段 childSessionId/parentSessionId', s.lineage.some(n => n.parent === 'session-main' && n.child === 'session-child-1'), JSON.stringify(s.lineage))
    await shot('shot-butler-08-tiers-selected-1440.png')
    await evaluate(`(() => { const node = document.querySelector('#tree .node.sel'); if (node) node.querySelector(':scope > .head').click(); return true; })()`)

    /* ================= 场景 2：900 窄屏 + 抽屉 ================= */
    await click('#closeReport')
    await setViewport(900, 1000)
    await sleep(350)
    s = await state()
    ck('900 无横向溢出', s.overflow <= 1, 'overflow=' + s.overflow)
    ck('900 右栏默认收在屏外', s.hierRect && s.hierRect.left >= 900, JSON.stringify(s.hierRect))
    eq('900 抽屉按钮可见', s.drawerBtnDisplay !== 'none', true)
    await shot('shot-butler-09-narrow-900.png')
    await shot('shot-butler07-narrow-900.png')
    await click('#drawerBtn')
    await sleep(500)
    s = await state()
    ck('点抽屉后右栏进入可视区', s.hierRect && s.hierRect.left < 520, JSON.stringify({ rect: s.hierRect, transform: s.hierTransform, matches: s.hierMatchesDrawer, rules: s.drawerRules }))
    eq('抽屉态 body.drawer', s.bodyDrawer, true)
    eq('窄屏仍无横向溢出', s.overflow <= 1, true)
    await shot('shot-butler-10-narrow-900-drawer.png')
    await click('#hierClose')
    await sleep(300)
    s = await state()
    eq('关闭抽屉后 body.drawer 移除', s.bodyDrawer, false)

    /* ================= 场景 3：层级降级 ================= */
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    s = await goto('degraded')
    report.scenarios.push({ name: 'degraded', dataset: s.dataset })
    eq('降级场景 tiers 仍是结构化响应', s.dataset.tiers, 'real')
    eq('降级时只渲染 T0（不编节点）', s.tier.nodes, 1)
    eq('降级 badge 显示', s.tier.degraded, true)
    has('降级原因写进页面', s.tier.degradedTitle, '会话层级不可见')
    await shot('shot-butler-11-tiers-degraded-1440.png')

    /* ================= 场景 4：api/tiers 404（需重启） ================= */
    s = await goto('tiers404')
    report.scenarios.push({ name: 'tiers404', dataset: s.dataset })
    eq('404 时层级降级', s.dataset.tiers, 'missing')
    eq('404 时只渲染 T0', s.tier.nodes, 1)
    eq('404 时降级 badge 显示', s.tier.degraded, true)
    has('404 时写明需要重启 DSH', s.tier.treeText, '404')
    has('404 时写明重启后生效', s.tier.treeText, '重启')
    await shot('shot-butler-12-tiers-404-1440.png')

    /* ================= 场景 5：接口全挂 → MOCK 兜底 ================= */
    s = await goto('mock')
    report.scenarios.push({ name: 'mock', dataset: s.dataset })
    eq('cluster 回落 mock', s.dataset.cluster, 'mock')
    eq('board 回落 mock', s.dataset.board, 'mock')
    eq('host 回落 mock', s.dataset.host, 'mock')
    eq('板 badge 标 mock', s.tasks.badge, 'mock')
    has('板 badge 写明 mock 兜底', s.tasks.badgeText, 'mock 兜底')
    eq('拓扑 badge 标 mock', s.cluster.state, 'mock')
    has('拓扑 badge 写明 mock 兜底', s.cluster.text, 'mock 兜底')
    ck('mock 时仍有任务列表（示例数据）', s.tasks.rows === 6, 'rows=' + s.tasks.rows)
    eq('mock 时层级降级但 T0 在', s.tier.nodes, 1)
    eq('mock 时官方任务板不冒充数据', s.official.rows, 0)
    has('mock 时官方任务板给不可用原因', s.official.emptyText, '官方任务板不可用')
    await shot('shot-butler-13-mock-fallback-1440.png')

    /* ================= 场景 6：M0/M1 路由 404（旧 Host，需重启） ================= */
    s = await goto('butler404')
    report.scenarios.push({ name: 'butler404', dataset: s.dataset })
    eq('M0 404 时 dataset.butler=missing', s.dataset.butler, 'missing')
    eq('M0 404 时右栏退回 tiers 真实层级（13 节点）', s.tier.nodes, 13)
    has('右栏写明「右栏状态降级」', s.tier.hint, '右栏状态降级')
    has('右栏写明 M0 路由 404', s.tier.hint, '404')
    eq('对话 404 时不显示任何消息（不编对话）', s.dialog.messages, 0)
    eq('对话 404 时显示诚实空态', s.dialog.empty, true)
    has('对话 404 时提示路由未加载', s.dialog.emptyText, '404')
    has('对话 404 时提示需要重启', s.dialog.emptyText, '重启')
    eq('404 时绑定方式写明需重启生效', s.dialog.bindMode, '绑定需重启后生效')
    eq('404 时加载更早消息按钮隐藏', s.dialog.earlierHidden, true)
    has('404 时右栏说明是层级快照', s.tier.hhDesc, '层级快照')
    has('设置页写明驾驶舱路由未加载', s.settings.butler, '404')
    await shot('shot-butler-15-m0-404-1440.png')

    /* ================= 场景 7：0.8.0 专属会话 + 写通道（交付截图：折叠/展开/900） ================= */
    const trace = label => process.stderr.write('[scenario7] ' + label + '\n')
    trace('goto real-pinned')
    await setViewport(VIEWPORT.width, VIEWPORT.height)
    s = await goto('real-pinned')
    trace('assert pinned')
    report.scenarios.push({ name: 'real-pinned', dataset: s.dataset })
    eq('写通道 dataset=on', s.dataset.write, 'on')
    eq('专属会话 pin 标签可见', s.dialog.pinned, true)
    has('pin 标签文案「大管家 · 常驻」', s.dialog.pinnedText, '大管家 · 常驻')
    has('pin 标注领导预设（agentPreset）', s.dialog.pinnedText, '领导预设')
    eq('绑定方式=配置固定 · 专属会话', s.dialog.bindMode, '配置固定 · 专属会话')
    eq('写通道可用：输入框启用', s.dialog.composerDisabled, false)
    eq('写通道可用：发送按钮启用', s.dialog.sendDisabled, false)
    eq('写通道可用：显示「可发送」tag', s.dialog.writeTag, true)
    has('composer 说明写通道已开', s.dialog.composerRo, '写通道已开')
    eq('无 high 告警时状态条默认收起', s.tq.expanded, false)
    eq('状态详情默认隐藏（细条只占一行）', s.statusDetail, false)
    has('状态条摘要含在管活会话', s.tq.summary, '在管')
    has('设置页专属会话显示已绑定', s.settings.pinned, '已绑定')
    has('设置页写通道显示已开启', s.settings.write, '已开启')
    await shot('shot-butler08-status-collapsed-1440.png')
    trace('collapsed shot done')

    await click('#statusToggle')
    await sleep(150)
    s = await state()
    eq('展开后 data-expanded=true', s.tq.expanded, true)
    eq('展开后详情面板出现', s.statusDetail, true)
    ck('展开后原三问三块都在 DOM', await evaluate('!!document.querySelector("#tqNeeds") && !!document.querySelector("#tqHealth") && !!document.querySelector("#tqHistory")'), true)
    await shot('shot-butler08-status-expanded-1440.png')
    trace('expanded shot done')
    await click('#statusToggle')
    await sleep(120)

    // 发送：点发送 → 每次弹二次确认（不直接发）→ 取消不发送 → 确认才 POST（fixture 查 token/内容）
    await evaluate('(() => { const el = document.querySelector("#prompt"); el.value = "CDP fixture：连通性测试，请只回复 OK"; return el.value; })()')
    trace('prompt filled')
    await click('#sendBtn')
    trace('send clicked')
    s = await state()
    eq('点发送先弹二次确认（没有直接发）', s.confirm.visible, true)
    has('确认框目标写明专属会话', s.confirm.target, '大管家 · 常驻')
    has('确认框预览原文', s.confirm.preview, '连通性测试')
    eq('确认前不发请求', fixture.sayRequests().length, 0)
    await shot('shot-butler08-confirm-1440.png')
    await click('#confirmCancel')
    s = await state()
    eq('取消后确认框关闭且未发送', [s.confirm.visible, fixture.sayRequests().length].join('/'), 'false/0')
    await click('#sendBtn')
    await click('#confirmSend')
    await waitReceipt('成功')
    s = await state()
    const sayRequests = fixture.sayRequests()
    eq('确认后真的 POST 一次 say', sayRequests.length, 1)
    eq('say 请求带页面注入 token', sayRequests[0].token, 'cdp-fixture-write-token')
    eq('say 目标会话=专属会话', sayRequests[0].sessionId, 'session-butler')
    has('say 内容来自输入框', sayRequests[0].content, '连通性测试')
    eq('发送成功后输入框清空', s.dialog.composerValue, '')
    has('发送回执写明已发送', s.receipts[0].text, '已发送')

    // 900 窄屏（交付截图）：状态条 + 绑定条 + 对话都不溢出
    await setViewport(900, 1000)
    await sleep(350)
    s = await state()
    ck('900 窄屏无横向溢出（0.8.0 状态条）', s.overflow <= 1, 'overflow=' + s.overflow)
    eq('900 窄屏状态详情仍按收起', s.statusDetail, false)
    await shot('shot-butler08-narrow-900.png')
    await setViewport(VIEWPORT.width, VIEWPORT.height)

    /* ================= 场景 7b：专属会话不存在 → 原因 + 重建按钮（不静默回退） ================= */
    s = await goto('real-pinned-missing')
    report.scenarios.push({ name: 'real-pinned-missing', dataset: s.dataset })
    eq('会话不存在时 pin 标签仍在（配置固定）', s.dialog.pinned, true)
    eq('显示「重建专属会话」按钮', s.dialog.rebuildHidden, false)
    has('绑定条写明「大管家会话不存在」', s.dialog.bindNote, '大管家会话不存在')
    eq('会话不存在时写通道禁用', s.dialog.composerDisabled, true)
    await shot('shot-butler08-rebuild-1440.png')

    /* ================= 场景 7c：还没创建专属会话 → 「创建专属会话」按钮 + 真 POST ensure ================= */
    s = await goto('real-unbound')
    report.scenarios.push({ name: 'real-unbound', dataset: s.dataset })
    eq('未创建时 pin 标签仍在（配置固定）', s.dialog.pinned, true)
    has('未创建时 pin 标注领导预设', s.dialog.pinnedText, '领导预设')
    eq('未创建时显示创建按钮', s.dialog.rebuildHidden, false)
    has('创建按钮文案', s.dialog.rebuildText, '创建专属会话')
    has('绑定条写明专属会话尚未创建', s.dialog.bindNote, '专属会话尚未创建')
    has('绑定条写明预设名', s.dialog.bindNote, 'butler-lead')
    eq('未创建时写通道禁用', s.dialog.composerDisabled, true)
    await click('#rebuildBtn')
    // 绑定条会被下一轮 M0 轮询刷回「尚未创建」，所以用 toast / 请求事实做回执断言。
    await waitFor('document.querySelector("#toast") && document.querySelector("#toast").textContent.indexOf("专属会话已创建") !== -1', 8000, 'create receipt')
    s = await state()
    const sessionRequests = fixture.sessionRequests()
    eq('点创建 → 真的 POST 一次 session ensure', sessionRequests.length, 1)
    eq('创建请求 action=ensure', sessionRequests[0] && sessionRequests[0].action, 'ensure')
    has('创建成功 toast 有回执', await evaluate('document.querySelector("#toast").textContent'), '专属会话已创建')
    await shot('shot-butler08-create-unbound-1440.png')

    /* ================= 页面 JS 报错收集 ================= */
    const finalState = await state()
    report.pageErrors = finalState.errors || []
    ck('页面 JS 报错为 0', report.pageErrors.length === 0, JSON.stringify(report.pageErrors).slice(0, 300))
    ck('CDP 运行时异常为 0', report.runtimeErrors.length === 0, JSON.stringify(report.runtimeErrors).slice(0, 300))
    ck('截图数量 ≥ 5', report.shots.length >= 5, 'shots=' + report.shots.length)
  } finally {
    try { await fixture.close() } catch { /* ignore */ }
    try { if (browser) browser.ws.close() } catch { /* ignore */ }
    if (child) {
      try { child.kill() } catch { /* ignore */ }
    }
    await sleep(300)
    try { await rm(profileDir, { recursive: true, force: true }) } catch { /* Edge 可能还占着文件，无害 */ }
  }

  const failed = checks.filter(c => !c.ok)
  report.checks = checks
  report.failed = failed.length
  report.passed = checks.length - failed.length
  report.ok = failed.length === 0
  await writeFile(path.join(OUT_DIR, 'cdp-butler-report.json'), JSON.stringify(report, null, 2), 'utf8')

  process.stdout.write('\n== cdp-butler: ' + checks.length + ' checks ==\n')
  for (const c of checks) {
    process.stdout.write((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.ok || !c.detail ? '' : '  [' + c.detail + ']') + '\n')
  }
  process.stdout.write('\nresult: ' + (report.ok ? 'PASS' : 'FAIL') + ' (' + report.passed + '/' + checks.length + ') shots=' + report.shots.length + '\n')
  process.exit(report.ok ? 0 : 1)
}

main().catch(error => {
  process.stderr.write('cdp-butler failed: ' + String((error && error.stack) || error) + '\n')
  process.exit(1)
})
