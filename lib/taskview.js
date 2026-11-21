/**
 * 官方 Agent Teams 任务视图的**纯函数移植** + mesh 板投影。
 *
 * 为什么要这个文件：DSH 0.2.2-rc.5 内置的 `@deepseek-ai/dsh-agent-team` 已经把
 * 「任务视图」推导写成了纯函数（`src/task-view.ts`，MIT，56 行）：
 *   - `taskReady(state, task)`：pending 且所有 blocker 都 completed 才算 ready；
 *   - `projectTaskView(state, task)`：补 `ready` 与 `writeScopeWarnings`（写域重叠只警告）。
 * 面板要跟官方同一套数据契约，所以把这两个函数**忠实移植**成零依赖 JS（去掉类型），
 * 语义逐行对齐；`tools/taskview.test.mjs` 用官方规则 + 本机真实板数据锁行为。
 *
 * 另加两个本面板专用的投影函数（官方没有，因为官方没有 mesh 板）：
 *   - `meshTaskToTeam()`：mesh 板一行 → 官方 `TeamTaskSnapshot` 形状的投影；
 *   - `projectMeshTasks()`：mesh 板整表 → `TeamTaskView[]`（带 `source:'mesh'`）。
 *
 * **诚实边界**：mesh 板没有 `blockedBy` / `writeScopes` 列（见板服务 `/task/list` 的
 * 真实字段），投影里给空数组并在 `unsupported` 里写明"这两列数据源没有"，而不是
 * 假装"没有依赖、没有写域"。`revision` 用板子的 `version` 列；拿不到就给 null，不编数字。
 *
 * 本模块零依赖、纯函数、**任何输入都不抛错**（脏行按最保守的 pending 处理）。
 */

/** 官方 `TeamTaskStatus` 的四个合法值。 */
export const TEAM_TASK_STATUS = Object.freeze(['pending', 'in_progress', 'completed', 'deleted'])

/**
 * 两个写域（已归一化的文件/目录前缀）是否在路径分量上重叠。
 * 逐字对齐官方 `task-view.ts`：相等、或任一是另一的前缀目录。
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function scopesOverlap(left, right) {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}

/**
 * 一个任务的全部 blocker 是否都已 completed。
 * 逐字对齐官方 `task-view.ts`：找不到的 blocker（已删除/未知 id）不算完成。
 * @param {{tasks: Array<{id:string,status:string}>}} state 供查兄弟任务的状态
 * @param {{blockedBy:string[]}} task 待判定的任务快照
 * @returns {boolean}
 */
export function taskReady(state, task) {
  const tasks = state && Array.isArray(state.tasks) ? state.tasks : []
  const blockedBy = task && Array.isArray(task.blockedBy) ? task.blockedBy : []
  return blockedBy.every(function (id) {
    const candidate = tasks.find(function (row) { return row && row.id === id })
    return !!candidate && candidate.status === 'completed'
  })
}

/**
 * 推导一个任务的官方视图（detached）。
 * 逐字对齐官方 `projectTaskView`，包括：
 *   - `ready` 只在 `status === 'pending'` 时可能为 true；
 *   - `writeScopeWarnings` 只跟**其它 in_progress 任务**比写域，只警告不阻塞；
 *   - `ownerId` / `ownerName` 未定义时字段整个省略（官方 same）。
 * @param {{tasks: Array<object>}} state
 * @param {object} task
 * @returns {object} TeamTaskView
 */
export function projectTaskView(state, task) {
  const source = task && typeof task === 'object' ? task : {}
  const siblings = state && Array.isArray(state.tasks) ? state.tasks : []
  const warnings = new Set()
  const writeScopes = Array.isArray(source.writeScopes) ? source.writeScopes : []
  for (const other of siblings) {
    if (!other || other.id === source.id || other.status !== 'in_progress') continue
    const otherScopes = Array.isArray(other.writeScopes) ? other.writeScopes : []
    if (writeScopes.some(function (left) {
      return otherScopes.some(function (right) { return scopesOverlap(left, right) })
    })) {
      warnings.add('write scopes overlap with ' + other.id)
    }
  }
  const view = {
    id: source.id,
    revision: source.revision,
    subject: source.subject,
    description: source.description,
    status: source.status,
    blockedBy: Array.isArray(source.blockedBy) ? source.blockedBy.slice() : [],
    writeScopes: writeScopes.slice(),
    ready: source.status === 'pending' && taskReady(state, source),
    writeScopeWarnings: [...warnings],
  }
  if (source.ownerId !== undefined) view.ownerId = source.ownerId
  if (source.ownerName !== undefined) view.ownerName = source.ownerName
  return view
}

/** mesh 板五态 → 官方 TeamTaskStatus。原 `state` 字段保留，不因投影丢失五态。 */
const MESH_STATUS = Object.freeze({
  leased: 'in_progress',
  done: 'completed',
  canceled: 'deleted',
  awaiting: 'pending',
  undelivered: 'pending',
  stale: 'pending',
  blocked: 'pending',
  unknown: 'pending',
})

/** mesh 投影明确不支持的官方字段（板服务没有这两列）。 */
export const MESH_UNSUPPORTED_FIELDS = Object.freeze(['blockedBy', 'writeScopes'])

/** 只把有限正整数当 revision；别的给 null（不编）。 */
function revisionOf(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

/** 只接受官方四个状态值。 */
function teamStatusOf(value) {
  return TEAM_TASK_STATUS.includes(value) ? value : 'pending'
}

/**
 * mesh 板一行（`lib/boardmap.js` 的 `mapBoardTask` 输出）→ 官方任务快照形状。
 * @param {object} item
 * @returns {object} TeamTaskSnapshot + `unsupported`
 */
export function meshTaskToTeam(item) {
  const source = item && typeof item === 'object' ? item : {}
  const state = typeof source.state === 'string' ? source.state : ''
  const owner = typeof source.owner === 'string' ? source.owner.trim() : ''
  const snapshot = {
    id: typeof source.id === 'string' ? source.id : '',
    revision: revisionOf(source.revision),
    subject: typeof source.title === 'string' ? source.title : '',
    description: typeof source.brief === 'string' ? source.brief : '',
    status: MESH_STATUS[state] || 'pending',
    blockedBy: [],
    writeScopes: [],
    unsupported: MESH_UNSUPPORTED_FIELDS.slice(),
  }
  if (owner !== '') snapshot.ownerName = owner
  return snapshot
}

/**
 * mesh 板整表 → 官方 `TeamTaskView[]`（含 `source:'mesh'`）。
 * 写域告警需要整表（跟其它 in_progress 任务比），所以必须一次投影整表。
 * @param {object[]} items
 * @returns {object[]}
 */
export function projectMeshTasks(items) {
  const rows = Array.isArray(items) ? items : []
  const snapshots = rows.map(meshTaskToTeam)
  const state = { tasks: snapshots }
  return snapshots.map(function (snapshot) {
    return Object.assign(projectTaskView(state, snapshot), {
      source: 'mesh',
      unsupported: snapshot.unsupported,
    })
  })
}

export { teamStatusOf }