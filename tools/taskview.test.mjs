#!/usr/bin/env node
/**
 * tools/taskview.test.mjs —— 官方 Agent Teams 任务视图纯函数的移植断言 + mesh 投影 + 官方投影读取。
 *
 * 零依赖、`node --test`：不联网、不起 DSH、不读板库。
 *
 * 覆盖三块：
 *   A. 官方 `src/task-view.ts` 的规则（与我们移植的 `lib/taskview.js` 逐条对齐）：
 *      blocker 判定 / ready 只在 pending / 写域重叠只警告 / 字段副本。
 *   B. **本机真实板数据**（2026-11-21 从共享板 `/task/list` 只读取回的 10 条，不含 token）
 *      投影成官方 TeamTaskView；依赖链与写域重叠用真实任务 id 另造用例（板子本身没有这两列）。
 *   C. `readOfficialBoard`：官方 `agentTeam` 投影的读取与**如实降级**（拿不到就说拿不到）。
 *
 * 用法: node --test tools/taskview.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { OFFICIAL_TASK_LIMIT, readOfficialBoard } from '../lib/board.js'
import {
  MESH_UNSUPPORTED_FIELDS, meshTaskToTeam, projectMeshTasks, projectTaskView, scopesOverlap, taskReady,
} from '../lib/taskview.js'

/* ─────────────────────── 真实板数据（只读快照） ─────────────────────── */

/**
 * 本机共享板 `/task/list` 的真实切片（2026-11-21 18:44 只读，已去掉任何凭据）。
 * 当前板子 30 条任务里只有 done / canceled 两种 lifecycle，所以这里 10 条都是终态；
 * ready / 依赖 / 写域用例在下面用这批真实任务 id **另造**，并明确标注"造"。
 */
const REAL_BOARD_TASKS = [{"task_id":"t-e5b4cb53","title":"跨机反例 v2：门禁不许放松","brief":"server 建，mcloud 尝试各种不合规证据完成，必须被拒。","acceptance":"反例全部被拒，任务仍不能变成 done。","lifecycle":"done","ack_state":"none","owner_session":"agent-team:mcloud:worker-1","version":3,"created_at":1794633450083,"updated_at":1794633451329,"lease_until":1794633750426,"lease_host":"desktop-3b458109125f43d3-20261103150549186","stale":0},{"task_id":"t-b4f83eff","title":"跨机反例：门禁不许放松","brief":"server 建，mcloud 尝试用各种不合规证据完成，全部必须被拒。","acceptance":"四种反例全部被服务端拒绝，任务最终仍不能变成 done。","lifecycle":"canceled","ack_state":"none","owner_session":"agent-team:mcloud:worker-1","version":3,"created_at":1794633343691,"updated_at":1794633344117,"lease_until":1794633643754,"lease_host":"desktop-3b458109125f43d3-20261103150549186","stale":0},{"task_id":"t-db1a80d5","title":"跨机验证：server 建，mcloud 完成","brief":"这是 server(10.26.0.3) 与 mcloud(10.26.0.4) 共用同一块板的实证任务。由 server 创建，mcloud 认领并完成。","acceptance":"mcloud 认领后上传一份真实文件的物证，门禁通过，任务进入 done，server 侧能看到同样的记录。","lifecycle":"done","ack_state":"none","owner_session":"agent-team:mcloud:worker-1","version":3,"created_at":1794633105335,"updated_at":1794633185958,"lease_until":1794633485693,"lease_host":"desktop-3b458109125f43d3-20261103150549186","stale":0},{"task_id":"t-74bceb8f","title":"task-6 活体验证：HTTP leaseIdentity 生效（自动生成，验证后 cancel）","brief":"","acceptance":"","lifecycle":"canceled","ack_state":"none","owner_session":"session-task6-liveproof","version":4,"created_at":1794597656351,"updated_at":1794597656746,"lease_until":1794598256711,"lease_host":"DESKTOP-QLO0LSC","stale":0},{"task_id":"t-c036a9f8","title":"task-6 活体验证：HTTP leaseIdentity 生效（自动生成，验证后 cancel）","brief":"","acceptance":"","lifecycle":"canceled","ack_state":"none","owner_session":"session-task6-liveproof","version":4,"created_at":1794597611823,"updated_at":1794597646074,"lease_until":1794598211845,"lease_host":"DESKTOP-QLO0LSC","stale":1},{"task_id":"t-233cbe89","title":"v4-e2e-028ec961 租约身份自检","brief":"e2e 自检，跑完即 cancel","acceptance":"","lifecycle":"done","ack_state":"none","owner_session":"e2e-runner","version":6,"created_at":1794594275876,"updated_at":1794594275933,"lease_until":1794594875901,"lease_host":"DESKTOP-QLO0LSC","stale":0},{"task_id":"t-9b34f4f4","title":"0.3.3 复验：newSession 闭环（重启后首次真跑）","brief":"server 侧 DSH 已于 2026-11-13 重启，dsh-team-mesh 0.3.3 已真正加载（createSession.js 7277B，create-refused 出现 2 次）。现在需要真机验证 newSession 创建链路。\n\n背景：0.3.3 修的是「对端 allowCreate=false 时静默 return []，导致派发方白等 60s 拿到 create-timeout」这个缺陷。修法是对端即使拒绝也要写回 create-refused。\n\n本卡要你做的事很少：\n1. 收到后立刻 mesh_task_ack\n2. 用 mesh_task_report 如实回报：\n   - 本会话的 sessionId\n   - 本机 instanceId 与工作目录（cwd 绝对路径）\n   - 你是怎么来的：是 newSession 自动新建的，还是原本就在跑的老会话\n   - 如果是被自动新建的：请注明（这直接证明建会话链路通了）\n3. 如果本机 allowCreate=false，说明你不该收到这张卡；若你收到了，也照样回报。\n\n不要改任何文件、不要跑测试、不要装任何东西。","acceptance":"1. 板上出现本卡的 ack（不是 ack_timeout）\n2. 有一条可采信证据（executed=true, outcome=pass），内容含 sessionId + instanceId + 是否被自动新建\n3. 必须由对端会话自己 ack+report，不许派发方代填","lifecycle":"done","ack_state":"none","owner_session":"session-22572e7c-c328-4fb0-873a-1f3fd2f7f6cc","version":3,"created_at":1794580479551,"updated_at":1794583119862,"lease_until":1794583708363,"lease_host":null,"stale":0},{"task_id":"t-f53187f6","title":"复验卡：0.3.3 newSession 闭环（只回执，不做工作）","brief":"这是 pc-ky614 升级 dsh-team-mesh 0.3.3 并重启后的闭环复验卡。你（对端会话）不需要做任何实质工作，只走三个动作，做完就停：\n\n1) mesh_task_ack({taskId:\"\u003c本卡 id\u003e\"}) —— 立刻回执，不要先看代码、不要先分析。\n2) 写证据文件：把一行文本写进 C:\\Users\\demo\\work-20261113\\mesh-033-loop-ack.txt，内容含当前时间和 \"ack sent from \u003c你的实例名\u003e \u003c你的 session id\u003e\"。\n3) mesh_task_report({taskId:\"\u003c本卡 id\u003e\", executed:true, outcome:\"pass\", evidenceRef:\"C:\\Users\\demo\\work-20261113\\mesh-033-loop-ack.txt\", note:\"newSession 闭环回执+证据已交\"})，然后 mesh_task_complete({taskId:\"\u003c本卡 id\u003e\"})。\n\n边界：不要派活给任何人，不要改别的文件，不要跑测试/回归，不要分析插件源码。三个动作做完即停，不要续活。","acceptance":"板上本卡：owner=对端新会话、有一条可采信证据（evidenceRef 指向真实存在的文件）、状态最终 done；pc-ky614 侧能观察到 task.dispatched(created_session:true, delivered:true) 且 ack_state 变为 acked（不再是 ack_timeout / reject_reason=null 的模糊态）。","lifecycle":"done","ack_state":"acked","owner_session":"session-d5f5eb63-e4c9-4a30-8c99-fd71cad254cd","version":5,"created_at":1794582996507,"updated_at":1794583072389,"lease_until":1794583672374,"lease_host":null,"stale":0},{"task_id":"t-31811eb9","title":"pc-ky614 升级 dsh-team-mesh 到 0.3.3（只回执+执行，不分析）","brief":"server 侧已确认本机是 0.3.3，但派给你的 newSession 请求过期且无 reject_reason，判断你侧还是旧版。\n\n请在本机执行：\n1. 先回报你的现状：读 node_modules/dsh-team-mesh/package.json 的 version、src/createSession.js 是否存在及字节数\n2. 若不是 0.3.3：从 server 同步。server 侧的权威源在 F:\\<workspace>\\dsh-team-plugin（但那是 server 本机路径，你访问不到）\n   → 改为：在你本机的 profile 目录下找 dsh-team-mesh，把它升到 0.3.3。如果你本机也有 F:\\<workspace>\\dsh-team-plugin，直接 pnpm install 即可。\n3. 升级后确认三处一致：package.json version=0.3.3-prototype、src/createSession.js 存在且含 create-refused 关键字、src/index.js 有 setInterval 驱动 serviceSessionRequests\n4. 用 mesh_task_report 回报，evidenceRef 指向你实测的日志或命令输出文件\n\n不要动板服务、不要改 token、不要重启 server。","acceptance":"1. 本卡有 ack（证明你侧 mesh 活着）\n2. 证据含：升级前 version、升级后 version、createSession.js 字节数、create-refused 出现次数\n3. 若你本机无法完成升级，如实报 fail 并说明缺什么","lifecycle":"done","ack_state":"none","owner_session":"session-22572e7c-c328-4fb0-873a-1f3fd2f7f6cc","version":5,"created_at":1794582021898,"updated_at":1794582549929,"lease_until":1794583423176,"lease_host":null,"stale":0},{"task_id":"t-9ee8aac3","title":"__probe_delete_me__","brief":"","acceptance":"","lifecycle":"canceled","ack_state":"none","owner_session":null,"version":2,"created_at":1794569453956,"updated_at":1794569826124,"lease_until":null,"lease_host":null,"stale":0}]

/* ─────────────────────── 官方纯函数：A 组 ─────────────────────── */

/** 造一个官方 `TeamTaskSnapshot`。 */
function snapshot(overrides = {}) {
  return {
    id: 'task-1',
    revision: 1,
    subject: '任务',
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

test('A1 scopesOverlap：按路径分量判重叠（逐字对齐官方 task-view.ts）', () => {
  assert.equal(scopesOverlap('/a/b', '/a/b'), true)
  assert.equal(scopesOverlap('/a', '/a/b'), true)
  assert.equal(scopesOverlap('/a/b', '/a'), true)
  // 前缀但不是目录分量：/a/bc 与 /a/b 不重叠（官方 startsWith(`${right}/`) 口径）
  assert.equal(scopesOverlap('/a/b', '/a/bc'), false)
  assert.equal(scopesOverlap('/x', '/y'), false)
  // 官方原实现里空串等价根：'' 与绝对路径 '/a' 会因 right.startsWith('/') 判为重叠（这里是移植的边界语义，照抄）
  assert.equal(scopesOverlap('', '/a'), true)
  assert.equal(scopesOverlap('', 'a'), false)
})

test('A2 taskReady：blocker 全 completed 才 ready；找不到的 blocker 不算完成', () => {
  const state = { tasks: [snapshot({ id: 'task-a', status: 'completed' }), snapshot({ id: 'task-b', status: 'in_progress' })] }
  assert.equal(taskReady(state, snapshot({ blockedBy: [] })), true)
  assert.equal(taskReady(state, snapshot({ blockedBy: ['task-a'] })), true)
  assert.equal(taskReady(state, snapshot({ blockedBy: ['task-a', 'task-a'] })), true)
  assert.equal(taskReady(state, snapshot({ blockedBy: ['task-b'] })), false)
  assert.equal(taskReady(state, snapshot({ blockedBy: ['task-missing'] })), false, '未知 blocker 不算 completed')
  assert.equal(taskReady(state, snapshot({ blockedBy: ['task-a', 'task-b'] })), false)
})

test('A3 projectTaskView：字段形状 / 数组是副本 / owner 字段按官方方式省略', () => {
  const state = { tasks: [] }
  const source = snapshot({
    id: 'task-7', revision: 3, subject: '标题', description: '说明',
    blockedBy: ['task-1'], writeScopes: ['lib/a'], ownerId: 'sess-1', ownerName: 'agent/path',
  })
  const view = projectTaskView(state, source)
  assert.deepEqual(view, {
    id: 'task-7', revision: 3, subject: '标题', description: '说明', status: 'pending',
    blockedBy: ['task-1'], writeScopes: ['lib/a'], ownerId: 'sess-1', ownerName: 'agent/path',
    ready: false, writeScopeWarnings: [],
  })
  // 副本：改视图不影响快照
  view.blockedBy.push('x')
  view.writeScopes.push('y')
  assert.deepEqual(source.blockedBy, ['task-1'])
  assert.deepEqual(source.writeScopes, ['lib/a'])
  // 无 owner 时字段整个省略（官方 ...ownerId === undefined ? {} : {...}）
  const bare = projectTaskView(state, snapshot())
  assert.equal('ownerId' in bare, false)
  assert.equal('ownerName' in bare, false)
})

test('A4 projectTaskView：ready 只在 pending 且 blocker 全完成时为 true', () => {
  const state = { tasks: [snapshot({ id: 'task-a', status: 'completed' })] }
  const cases = [
    [{ status: 'pending', blockedBy: [] }, true],
    [{ status: 'pending', blockedBy: ['task-a'] }, true],
    [{ status: 'pending', blockedBy: ['task-b'] }, false],
    [{ status: 'in_progress', blockedBy: [] }, false],
    [{ status: 'completed', blockedBy: [] }, false],
    [{ status: 'deleted', blockedBy: [] }, false],
  ]
  for (const [patch, expected] of cases) {
    assert.equal(projectTaskView(state, snapshot(patch)).ready, expected, JSON.stringify(patch))
  }
})

test('A5 projectTaskView：writeScopeWarnings 只跟 in_progress 任务比，且只警告不阻塞', () => {
  const state = {
    tasks: [
      snapshot({ id: 'task-self', status: 'pending', writeScopes: ['src/app'] }),
      snapshot({ id: 'task-run', status: 'in_progress', writeScopes: ['src/app/index.ts'] }),
      snapshot({ id: 'task-pending', status: 'pending', writeScopes: ['src/app'] }),      // pending 不告警
      snapshot({ id: 'task-done', status: 'completed', writeScopes: ['src/app'] }),       // completed 不告警
      snapshot({ id: 'task-other', status: 'in_progress', writeScopes: ['docs/'] }),      // 不重叠
    ],
  }
  const view = projectTaskView(state, state.tasks[0])
  assert.deepEqual(view.writeScopeWarnings, ['write scopes overlap with task-run'])
  // 只警告：任务照旧 pending / ready 不受影响
  assert.equal(view.status, 'pending')
  assert.equal(view.ready, true)
})

test('A6 projectTaskView：多个 in_progress 重叠时每任务一条告警（Set 去重）', () => {
  const state = {
    tasks: [
      snapshot({ id: 'task-self', status: 'pending', writeScopes: ['lib'] }),
      snapshot({ id: 'task-r1', status: 'in_progress', writeScopes: ['lib'] }),
      snapshot({ id: 'task-r2', status: 'in_progress', writeScopes: ['lib/sub'] }),
    ],
  }
  const warnings = projectTaskView(state, state.tasks[0]).writeScopeWarnings
  assert.equal(warnings.length, 2)
  assert.deepEqual(warnings, ['write scopes overlap with task-r1', 'write scopes overlap with task-r2'])
})

/* ─────────────────────── 真实板数据：B 组 ─────────────────────── */

/** 把真实板行过一遍旧的五态映射（这里直接按板子 lifecycle 判：fixture 全是终态）。 */
function realItems() {
  return REAL_BOARD_TASKS.map(row => ({
    id: row.task_id,
    title: row.title,
    brief: row.brief,
    acceptance: row.acceptance === '' ? [] : [row.acceptance],
    state: row.lifecycle === 'done' ? 'done' : 'canceled',
    owner: row.owner_session,
    revision: row.version,
    lifecycle: row.lifecycle,
    ackState: row.ack_state,
    updatedAt: row.updated_at,
  }))
}

test('B1 真实板 10 条任务：五态 → 官方 status（done→completed / canceled→deleted）', () => {
  const items = realItems()
  const views = projectMeshTasks(items)
  assert.equal(views.length, REAL_BOARD_TASKS.length)
  for (let i = 0; i < views.length; i += 1) {
    const view = views[i]
    assert.equal(view.source, 'mesh', '每条都要标数据源')
    assert.equal(view.id, REAL_BOARD_TASKS[i].task_id)
    assert.equal(view.status, REAL_BOARD_TASKS[i].lifecycle === 'done' ? 'completed' : 'deleted')
    assert.equal(view.ready, false, '终态任务不可能 ready')
    assert.deepEqual(view.writeScopeWarnings, [])
    assert.deepEqual(view.unsupported, [...MESH_UNSUPPORTED_FIELDS])
  }
})

test('B2 真实板任务：subject/description/ownerName/revision 原样来自板数据', () => {
  const items = realItems()
  const views = projectMeshTasks(items)
  const first = REAL_BOARD_TASKS[0]
  assert.equal(views[0].subject, first.title)
  assert.equal(views[0].description, first.brief)
  assert.equal(views[0].ownerName, first.owner_session)
  assert.equal(views[0].revision, first.version)
  // 板子真实没有依赖 / 写域列：投影给空数组，但必须同时标 unsupported（不假装"没有依赖"）
  assert.deepEqual(views[0].blockedBy, [])
  assert.deepEqual(views[0].writeScopes, [])
  assert.equal(views[0].unsupported.includes('blockedBy'), true)
  assert.equal(views[0].unsupported.includes('writeScopes'), true)
})

test('B3 真实任务 id 上造依赖链：blockedBy 未完成 → ready=false；全完成 → ready=true', () => {
  // 造：拿真实板任务 id 串一条 3 段依赖链（板子没有 blockedBy 列，故这是"造"的用例）
  const [a, b, c] = REAL_BOARD_TASKS.slice(0, 3).map(row => row.task_id)
  const make = (id, status, blockedBy) => snapshot({ id, status, blockedBy, subject: '真实 id ' + id })
  const state = { tasks: [make(a, 'completed', []), make(b, 'pending', [a]), make(c, 'pending', [b])] }
  assert.equal(projectTaskView(state, state.tasks[1]).ready, true, 'a 已完成 → b 可接手')
  assert.equal(projectTaskView(state, state.tasks[2]).ready, false, 'b 未完成 → c 受阻')
  state.tasks[1] = make(b, 'in_progress', [a])
  assert.equal(projectTaskView(state, state.tasks[2]).ready, false, 'b 进行中 → c 仍受阻')
  state.tasks[1] = make(b, 'completed', [a])
  assert.equal(projectTaskView(state, state.tasks[2]).ready, true, 'b 完成 → c 可接手')
})

test('B4 真实任务 id 上造写域重叠：in_progress 任务写域重叠 → 告警（不阻塞）', () => {
  const [a, b] = REAL_BOARD_TASKS.slice(0, 2).map(row => row.task_id)
  const state = {
    tasks: [
      snapshot({ id: a, status: 'pending', writeScopes: ['C:/work/panel/public'] }),
      snapshot({ id: b, status: 'in_progress', writeScopes: ['C:/work/panel'] }),
    ],
  }
  const view = projectTaskView(state, state.tasks[0])
  assert.deepEqual(view.writeScopeWarnings, ['write scopes overlap with ' + b])
  assert.equal(view.ready, true, '写域重叠只警告，不阻塞 ready')
})

test('B5 projectMeshTasks / meshTaskToTeam：空表与脏行不抛（不编字段）', () => {
  assert.deepEqual(projectMeshTasks([]), [])
  assert.deepEqual(projectMeshTasks(null), [])
  const dirty = meshTaskToTeam({ state: 'mystery', revision: 'x', owner: 42 })
  assert.equal(dirty.id, '')
  assert.equal(dirty.status, 'pending')
  assert.equal(dirty.revision, null, '拿不到 version 给 null，不编 1')
  assert.equal('ownerName' in dirty, false)
})

/* ─────────────────────── 官方投影读取：C 组 ─────────────────────── */

/** 造一个活会话（只带 board/tiers 会读的 header）。 */
function session(id, options = {}) {
  const header = { version: 4, id, createdAt: 1_700_000_000_000 }
  if (options.origin !== undefined) header.origin = options.origin
  if (options.parent !== undefined) header.parentSession = options.parent
  return { id, header }
}

/** 官方 wire 形状的 TeamTaskView（官方已算好 ready / warnings）。 */
function officialView(overrides = {}) {
  return {
    id: 'task-1',
    revision: 1,
    subject: '官方任务',
    description: '官方说明',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...overrides,
  }
}

/**
 * 造官方投影依赖。
 * @param {{sessions:object[], teams:Record<string, object>, throwOn?:string[]}} options
 */
function officialDeps(options) {
  const throwOn = new Set(options.throwOn || [])
  return {
    sessions: { list: () => options.sessions },
    projections: {
      snapshot(target) {
        if (throwOn.has(target.id)) throw new Error('projection exploded')
        const team = options.teams[target.id]
        const values = { title: '会话 ' + target.id }
        if (team !== undefined) values.agentTeam = team
        return { asOfSeq: 1, values }
      },
    },
  }
}

test('C1 readOfficialBoard：缺 sessions / 缺 projections → available:false + 人话原因（不编任务）', () => {
  for (const deps of [{}, { sessions: { list: () => [] } }, { projections: { snapshot: () => ({}) } }]) {
    const got = readOfficialBoard(deps)
    assert.equal(got.available, false)
    assert.equal(typeof got.reason, 'string')
    assert.ok(got.reason.length > 0)
    assert.deepEqual(got.tasks, [])
    assert.deepEqual(got.teams, [])
  }
})

test('C2 readOfficialBoard：投影里没有 agentTeam 键 → 报"未注册"，不当成空任务板', () => {
  const got = readOfficialBoard(officialDeps({ sessions: [session('s-main')], teams: {} }))
  assert.equal(got.available, false)
  assert.match(got.reason, /未注册|未启用/)
  assert.deepEqual(got.tasks, [])
})

test('C3 readOfficialBoard：enabled 团队 → tasks 带 source/sessionId，官方 ready 与告警原样', () => {
  const teams = {
    's-main': {
      enabled: true,
      tasks: [
        officialView({ id: 'task-1', subject: '可认领', ready: true }),
        officialView({ id: 'task-2', status: 'in_progress', subject: '进行中', ready: false, writeScopes: ['lib'], writeScopeWarnings: ['write scopes overlap with task-3'] }),
      ],
    },
  }
  const got = readOfficialBoard(officialDeps({ sessions: [session('s-main')], teams }))
  assert.equal(got.available, true)
  assert.equal(got.tasks.length, 2)
  assert.equal(got.tasks[0].source, 'official')
  assert.equal(got.tasks[0].sessionId, 's-main')
  assert.equal(got.tasks[0].teamEnabled, true)
  assert.equal(got.tasks[0].ready, true)
  assert.deepEqual(got.tasks[1].writeScopeWarnings, ['write scopes overlap with task-3'])
  assert.deepEqual(got.teams, [{ sessionId: 's-main', title: '会话 s-main', enabled: true, taskCount: 2, shownTasks: 2 }])
})

test('C4 readOfficialBoard：Team 模式关闭的团队不并入 tasks，只记 hiddenTasks', () => {
  const teams = { 's-main': { enabled: false, tasks: [officialView({ id: 'task-9' })] } }
  const got = readOfficialBoard(officialDeps({ sessions: [session('s-main')], teams }))
  assert.equal(got.available, true)
  assert.deepEqual(got.tasks, [])
  assert.equal(got.hiddenTasks, 1)
  assert.equal(got.teams[0].enabled, false)
  assert.equal(got.teams[0].taskCount, 1)
})

test('C5 readOfficialBoard：只扫根会话，subagent 会话（团队不挂在它们身上）跳过', () => {
  const teams = {
    's-child': { enabled: true, tasks: [officialView({ id: 'task-child' })] },
    's-main': { enabled: true, tasks: [officialView({ id: 'task-main' })] },
  }
  const deps = officialDeps({
    sessions: [session('s-main'), session('s-child', { origin: 'subagent', parent: 's-main' })],
    teams,
  })
  const got = readOfficialBoard(deps)
  assert.deepEqual(got.tasks.map(task => task.id), ['task-main'])
})

test('C6 readOfficialBoard：投影抛错 → 全部失败 available:false；部分失败给 failedSessions', () => {
  const teams = { 's-main': { enabled: true, tasks: [officialView({ id: 'task-1' })] } }
  const allFail = readOfficialBoard(officialDeps({
    sessions: [session('s-main')], teams: {}, throwOn: ['s-main'],
  }))
  assert.equal(allFail.available, false)
  assert.match(allFail.reason, /读取失败/)
  assert.ok(Number.isInteger(allFail.failedSessions) === false, '全失败时不带 failedSessions（原因里已写）')

  const partial = readOfficialBoard(officialDeps({
    sessions: [session('s-main'), session('s-boom')],
    teams,
    throwOn: ['s-boom'],
  }))
  assert.equal(partial.available, true)
  assert.equal(partial.tasks.length, 1)
  assert.equal(partial.failedSessions, 1)
})

test('C7 readOfficialBoard：条数上限 OFFICIAL_TASK_LIMIT → truncated，不静默截断', () => {
  const many = Array.from({ length: OFFICIAL_TASK_LIMIT + 5 }, (_, i) => officialView({ id: 'task-' + (i + 1) }))
  const got = readOfficialBoard(officialDeps({ sessions: [session('s-main')], teams: { 's-main': { enabled: true, tasks: many } } }))
  assert.equal(got.tasks.length, OFFICIAL_TASK_LIMIT)
  assert.equal(got.truncated, true)
  assert.equal(got.teams[0].taskCount, OFFICIAL_TASK_LIMIT + 5)
})

test('C8 readOfficialBoard：团队 failure 原样带出（不吞官方投影错误）', () => {
  const teams = { 's-main': { enabled: true, tasks: [], failure: 'persisted Agent Teams team/task payload is invalid' } }
  const got = readOfficialBoard(officialDeps({ sessions: [session('s-main')], teams }))
  assert.equal(got.available, true)
  assert.equal(got.teams[0].failure, 'persisted Agent Teams team/task payload is invalid')
})