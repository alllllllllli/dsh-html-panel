/**
 * 只读派活层级快照：`GET /dsh-html-panel/api/tiers` 的全部组装逻辑。
 *
 * 为什么单独一个文件：路由里只留取服务与拼响应，**层级算法与降级都能被单测直接
 * 断言**（`tools/tiers.test.mjs` 不需要起 DSH、不需要真的 interconnect）。
 *
 * 口径（用户拍板）：**层级优先、设备只做标签**——
 *   T0 = 大管家（本实例）
 *   T1 = 本机会话 + 其它设备上的会话（平级）
 *   T2 = 这些会话开的子代理
 *   T3 = 子代理再开的子代理（更深按 tier 递推，封顶 {@link MAX_TIER}）
 *
 * 真实数据来源（全部只读、全部 Host 侧）：
 *   1. 本机会话：`ctx.sessions.list()`（SessionStore，只含活会话）+ 每个 Session 的
 *      不可变 `header`：`id` / `createdAt` / `origin`（`'subagent'` 才是子代理）/
 *      `parentSession`（子代理的直接父会话）/ `delegationDepth`。父子关系因此是
 *      **DSH 自己持久化的真实血缘**，不是猜的。
 *   2. 本机会话状态：`ctx.agents.list()` 的 `agent.status`（`running` / `idle`）；
 *      标题用 `ctx.sessionProjections.snapshot(session).values.title`，取不到就用短 id。
 *   3. 其它设备会话：`ctx.interconnect.list(instanceId)`（走已建立的 WS 链路，返回该
 *      实例的活会话行 `{ sessionId, title?, status? }`）；只对 `peers()` 里 `link==='up'`
 *      的对端发；`down` 的不发，如实把链路状态交给页面。
 *
 * 已知边界（页面脚注与 README 都写明，**不在这里假装完整**）：
 *   - 只列**活会话**：已结束（不在 SessionStore / 不在 agents 注册表）的会话与子代理
 *     不出现。`degraded` 只记录"数据源失败/缺口"，不把这条常驻限制写进去。
 *   - 远端只能拿到顶层活会话（interconnect 的 list 契约本身过滤了子代理会话），
 *     所以远端 T2/T3 不可见；有远端 T1 时 `degraded` 会写清这一点。
 *
 * 超时与缓存：多个对端并行 `list()`，单个上限 {@link TIERS_TIMEOUT_MS}（默认 2s，
 * 即整个请求的远段上限）；结果缓存 {@link TIERS_CACHE_MS}（默认 4s），并发请求
 * 共用同一个 in-flight promise，避免把 interconnect 打满。
 *
 * 硬约束：本模块任何输入都不许抛错；任何错误文本都不原样带出（配置里可能有 origin），
 * 只写稳定的人话原因。
 */

/** 进程内缓存窗口：页面轮询比这更快也不会真的打 interconnect。 */
export const TIERS_CACHE_MS = 4000

/** 单个远端会话列表的等待上限；也是整轮远端查询的上限（并行）。 */
export const TIERS_TIMEOUT_MS = 2000

/** 节点总数上限，防止异常会话集合撑爆响应/页面。 */
export const TIERS_MAX_NODES = 200

/** 单个远端的会话行上限（interconnect 本身最多 100 行，这里再收窄）。 */
export const TIERS_MAX_REMOTE_SESSIONS = 40

/** tier 封顶：契约里节点 tier 从 1 起，更深的一律并到 MAX_TIER。 */
export const MAX_TIER = 8

/** 取不到本实例 id 时的根节点 id；与页面/契约示例一致。 */
export const ROOT_ID = 'pc-ky614'

/** 大管家根节点显示名。 */
export const ROOT_LABEL = '大管家'

/** 取不到本实例 id 时的占位值（不编造实例名）。 */
export const UNKNOWN_INSTANCE = 'unknown'

/** `selfSender()` 的占位 sessionId：拿实例 id 与 session 无关。 */
export const PROBE_SESSION_ID = '__tiers__'

/** 页面状态枚举（与页面 `.dot.run|idle|queue|blocked|done` 对齐）。 */
const STATUS_MAP = Object.freeze({
  running: 'run',
  run: 'run',
  active: 'run',
  idle: 'idle',
  queued: 'queue',
  queue: 'queue',
  waiting: 'queue',
  blocked: 'blocked',
  failed: 'blocked',
  error: 'blocked',
  done: 'done',
  completed: 'done',
  finished: 'done',
  // 子代理目录里的 activity 只有 running / inactive
  inactive: 'idle',
})

/** 契约要求的状态值；未知状态不冒充"运行中"，落到 idle。 */
export function mapStatus(value) {
  if (typeof value !== 'string') return 'idle'
  return STATUS_MAP[value.toLowerCase()] ?? 'idle'
}

/** 截断外部字符串，避免把异常长的标题/实例名塞进响应。 */
function tex(value, max = 120) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** 毫秒时间戳 → ISO 字符串；非法值给 null（不编时间）。 */
function isoAt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

/** 会话 id 的短形式：只用于缺标题时的可读占位。 */
function shortId(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length > 14 ? text.slice(0, 6) + '…' + text.slice(-4) : text
}

/** 读一个可选的 Host 服务；服务不存在、getter 抛错都返回 undefined。 */
function serviceOf(deps, name) {
  try {
    const getter = deps?.[name]
    if (typeof getter === 'function') return getter()
    return getter ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 把任意 thenable 包成「值 / 超时 / 失败」三态，绝不抛出。
 * @param {unknown} promise
 * @param {number} ms
 * @returns {Promise<{kind:'value', value:unknown}|{kind:'timeout'}|{kind:'error'}>}
 */
function settleWithin(promise, ms) {
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ kind: 'timeout' })
    }, ms)
    Promise.resolve(promise).then(
      value => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ kind: 'value', value })
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ kind: 'error' })
      },
    )
  })
}

/**
 * 从活会话列表里抽出本机 T1/T2/T3 的真实血缘。
 *
 * 只读 `sessions.list()`（活会话）与 `agents.list()`（状态）；`header.origin ===
 * 'subagent'` 的会话挂到 `header.parentSession` 下面，tier 由父节点递归 +1。
 *
 * @param {{sessions:unknown, agents:unknown, projections:unknown, rootId:string, degraded:string[]}} input
 * @returns {{nodes:Array<object>, records:Map<string,object>, ok:boolean}}
 */
function readLocalTiers({ sessions, agents, projections, rootId, degraded }) {
  const empty = { nodes: [], records: new Map(), ok: false, official: { reads: 0, failures: 0, modes: 0 } }
  let list = null
  if (sessions !== null && typeof sessions === 'object' && typeof sessions.list === 'function') {
    try {
      list = sessions.list()
    } catch {
      list = null
    }
  }
  if (!Array.isArray(list)) {
    degraded.push('DSH 没有可用的 sessions 服务：本机会话层级不可见')
    return empty
  }

  /** agent.id === session.id（interconnect 同样用 agent.id 当 sessionId）。 */
  const agentById = new Map()
  if (agents !== null && typeof agents === 'object' && typeof agents.list === 'function') {
    try {
      const rows = agents.list()
      if (Array.isArray(rows)) {
        for (const agent of rows) {
          if (agent && typeof agent.id === 'string' && agent.id !== '') agentById.set(agent.id, agent)
        }
      }
    } catch {
      /* 状态取不到就不显示运行态；节点仍然来自 sessions */
    }
  }

  /**
   * 一次读齐这一层要用的官方投影值（只读、best-effort）：
   *   - `title`           会话标题；
   *   - `subagent`        子会话自己的官方身份 `{ mode:'one-shot'|'continuable', label } | null`；
   *   - `subagentCatalog` 父会话的官方直接子代理目录 `[{ id, mode, label? }]`。
   * 投影缺失/抛错都只让这一行退回旧口径，不影响层级本身。
   * @param {object} session 活会话
   * @returns {object|null}
   */
  const officialValuesOf = session => {
    try {
      if (!projections || typeof projections.snapshot !== 'function') return null
      const snapshot = projections.snapshot(session, ['title', 'subagent', 'subagentCatalog'])
      const values = snapshot && snapshot.values
      return values && typeof values === 'object' ? values : null
    } catch {
      return null
    }
  }

  const records = new Map()
  const order = []
  let officialReads = 0
  let officialFailures = 0
  for (const session of list) {
    if (!session || typeof session.id !== 'string' || session.id === '') continue
    const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
    const id = session.id
    const origin = header.origin === 'subagent' ? 'subagent' : 'session'
    const parentSession = typeof header.parentSession === 'string' && header.parentSession !== ''
      ? header.parentSession
      : null
    const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
      ? header.createdAt
      : null
    const official = officialValuesOf(session)
    if (official === null) officialFailures += 1
    else officialReads += 1
    const title = official !== null ? tex(official.title) : ''
    records.set(id, { id, origin, parentSession, createdAt, title, session, status: 'idle', official })
    order.push(records.get(id))
  }

  for (const record of order) {
    const agent = agentById.get(record.id)
    record.status = mapStatus(agent ? agent.status : undefined)
  }

  const nodes = []
  const childrenOf = new Map()
  const orphans = []
  for (const record of order) {
    if (record.origin === 'session') continue
    const parentId = record.parentSession !== null && records.has(record.parentSession) ? record.parentSession : null
    if (parentId === null) {
      // 父会话已经不在活会话里：不丢节点、也不假装有父，挂到 T1 并如实降级。
      record.orphan = true
      degraded.push('有子代理的父会话已不在活会话列表里，已把它挂到 T1')
      orphans.push(record)
      continue
    }
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
    childrenOf.get(parentId).push(record)
  }
  const byCreation = (a, b) => {
    if (a.createdAt !== null && b.createdAt !== null) return a.createdAt - b.createdAt
    if (a.createdAt !== null) return -1
    if (b.createdAt !== null) return 1
    return 0
  }
  for (const kids of childrenOf.values()) kids.sort(byCreation)
  const topSessions = order.filter(record => record.origin === 'session').sort(byCreation)

  /* ---- 官方 subagent 契约对齐（dsh-client-ui-subagent：{parentSessionId, childSessionId, mode}） ---- */
  const OFFICIAL_MODES = new Set(['one-shot', 'continuable'])
  let officialModeCount = 0

  /** 官方模式只认官方定义的两个值；其它一律 'unknown'（官方自己也允许 unknown）。 */
  const knownMode = value => (OFFICIAL_MODES.has(value) ? value : 'unknown')

  /**
   * 子代理模式：父会话的官方 `subagentCatalog` 优先（官方目录是权威来源），
   * 其次子会话自己的 `subagent` 投影；都拿不到给 'unknown'（不猜）。
   * @param {object} record 子代理会话记录
   * @param {object|null} parentRecord 活着的父会话记录（父已结束则为 null）
   * @returns {string} 'one-shot' | 'continuable' | 'unknown'
   */
  const modeOf = (record, parentRecord) => {
    const catalog = parentRecord && parentRecord.official && Array.isArray(parentRecord.official.subagentCatalog)
      ? parentRecord.official.subagentCatalog
      : null
    if (catalog !== null) {
      const entry = catalog.find(row => row && typeof row === 'object' && row.id === record.id)
      if (entry) {
        const mode = knownMode(entry.mode)
        if (mode !== 'unknown') officialModeCount += 1
        return mode
      }
    }
    const own = record.official && record.official.subagent
    if (own && typeof own === 'object') {
      const mode = knownMode(own.mode)
      if (mode !== 'unknown') officialModeCount += 1
      return mode
    }
    return 'unknown'
  }

  /** 官方目录/身份里的创建标签（缺标题时比「子代理 <短 id>」更像人话）。 */
  const labelOf = (record, parentRecord) => {
    const catalog = parentRecord && parentRecord.official && Array.isArray(parentRecord.official.subagentCatalog)
      ? parentRecord.official.subagentCatalog
      : null
    if (catalog !== null) {
      const entry = catalog.find(row => row && typeof row === 'object' && row.id === record.id)
      if (entry) {
        const label = tex(entry.label)
        if (label !== '') return label
      }
    }
    const own = record.official && record.official.subagent
    if (own && typeof own === 'object') return tex(own.label)
    return ''
  }

  /**
   * 造一个本机节点。
   *
   * `parentSessionId` / `childSessionId` / `mode` 是官方
   * `dsh-client-ui-subagent` 的地址契约：T2/T3 的 `parentSessionId` 就是 DSH
   * 自己持久化的直接创建者（`header.parentSession`，与官方同源同口径）；
   * 本机 T1 顶层会话**没有**父会话，`parentSessionId` 给 null（不拿树根实例 id 冒充
   * session id），`mode` 同理给 null（T1 不是 subagent 对话，地址契约不适用）。
   * @param {object} record 会话记录
   * @param {object|null} parentRecord 活着的父会话记录（用于读官方目录）
   * @returns {object} 节点
   */
  const push = (record, parentRecord) => {
    const isSubagent = record.origin === 'subagent'
    const officialLabel = isSubagent ? labelOf(record, parentRecord) : ''
    const node = {
      id: record.id,
      parentId: null,
      tier: 1,
      kind: isSubagent ? 'subagent' : 'session',
      device: rootId,
      title: record.title !== '' ? record.title : (officialLabel !== '' ? officialLabel : (isSubagent ? '子代理 ' : '会话 ') + shortId(record.id)),
      status: record.status,
      startedAt: isoAt(record.createdAt),
      // 官方 subagent 地址契约（仅本机节点；远端节点没有本机 session id）
      childSessionId: record.id,
      parentSessionId: isSubagent ? record.parentSession : null,
      mode: isSubagent ? modeOf(record, parentRecord) : null,
    }
    if (officialLabel !== '') node.label = officialLabel
    nodes.push(node)
    return node
  }

  /** 先序展开：父节点先入列，子节点紧跟其后（页面按 parentId 重建树）。 */
  const expand = (record, parentNode, parentTier) => {
    const kids = childrenOf.get(record.id)
    if (!kids || kids.length === 0) return
    for (const kid of kids) {
      if (nodes.length >= TIERS_MAX_NODES) return
      const tier = Math.min(parentTier + 1, MAX_TIER)
      const node = push(kid, record)
      node.parentId = parentNode.id
      node.tier = tier
      expand(kid, node, tier)
    }
  }

  const tops = []
  for (const record of topSessions) {
    if (nodes.length >= TIERS_MAX_NODES) break
    const node = push(record, null)
    node.parentId = rootId
    tops.push({ record, node })
  }
  for (const record of orphans) {
    if (nodes.length >= TIERS_MAX_NODES) break
    const node = push(record, null)
    node.parentId = rootId
    expand(record, node, 1)
  }
  for (const top of tops) expand(top.record, top.node, 1)

  if (nodes.length >= TIERS_MAX_NODES) degraded.push('层级节点超过上限，已截断（只列前 ' + TIERS_MAX_NODES + ' 个）')
  return { nodes, records, ok: true, official: { reads: officialReads, failures: officialFailures, modes: officialModeCount } }
}

/**
 * 组装一份派活层级快照（异步：远段要真的问 interconnect）。
 *
 * @param {object} deps
 * @param {(() => unknown)|unknown} [deps.interconnect] 返回 `ctx.interconnect` 的 getter（可缺）
 * @param {(() => unknown)|unknown} [deps.sessions]     返回 `ctx.sessions` 的 getter
 * @param {(() => unknown)|unknown} [deps.agents]       返回 `ctx.agents` 的 getter
 * @param {(() => unknown)|unknown} [deps.projections]  返回 `ctx.sessionProjections` 的 getter
 * @param {number|(() => number)} [deps.now]            生成时刻（测试可注入）
 * @param {number} [deps.timeoutMs]                     单个远端 list() 等待上限
 * @returns {Promise<object>} `/api/tiers` 的响应体
 */
export async function buildTiers(deps = {}) {
  const nowInput = typeof deps.now === 'function' ? deps.now() : deps.now
  const now = typeof nowInput === 'number' && Number.isFinite(nowInput) ? nowInput : Date.now()
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
    ? Math.min(10000, Math.max(200, Math.round(deps.timeoutMs)))
    : TIERS_TIMEOUT_MS
  const degraded = []

  const interconnect = serviceOf(deps, 'interconnect')
  const sessions = serviceOf(deps, 'sessions')
  const agents = serviceOf(deps, 'agents')
  const projections = serviceOf(deps, 'projections')

  let selfId = UNKNOWN_INSTANCE
  const hasInterconnect = interconnect !== null && typeof interconnect === 'object' && typeof interconnect.peers === 'function'
  if (hasInterconnect) {
    try {
      const sender = typeof interconnect.selfSender === 'function' ? interconnect.selfSender(PROBE_SESSION_ID) : undefined
      if (sender && typeof sender.instanceId === 'string') {
        const trimmed = sender.instanceId.trim()
        if (trimmed !== '') selfId = trimmed.slice(0, 80)
      }
    } catch {
      /* 读不到就留 unknown，不编 */
    }
  } else {
    degraded.push('本实例没有可用的 interconnect 服务：其它设备的会话不可见')
  }
  const rootId = selfId === UNKNOWN_INSTANCE ? ROOT_ID : selfId

  const root = {
    id: rootId,
    label: ROOT_LABEL,
    device: rootId,
    tier: 0,
    status: 'run',
    startedAt: new Date(now).toISOString(),
  }

  const local = readLocalTiers({ sessions, agents, projections, rootId, degraded })
  const nodes = local.nodes
  if (local.ok && projections !== null) {
    if (local.official.reads === 0 && local.official.failures > 0) {
      degraded.push('官方 subagent 投影读取失败：mode 一律显示「未知」（血缘仍用 Session header）')
    } else if (local.official.reads > 0 && local.official.failures > 0) {
      degraded.push(local.official.failures + ' 个会话的官方 subagent 投影读取失败，这些节点 mode 显示「未知」')
    }
  }

  const remote = []
  let remoteTopCount = 0
  let truncated = false
  if (hasInterconnect) {
    let peers = null
    try {
      peers = interconnect.peers()
    } catch {
      peers = null
      degraded.push('读取 interconnect peer 列表失败：其它设备会话不可见')
    }
    const rows = []
    if (Array.isArray(peers)) {
      for (const peer of peers) {
        if (!peer || typeof peer !== 'object') continue
        const instanceId = tex(peer.instanceId, 80)
        if (instanceId === '') continue
        rows.push({ instanceId, link: peer.link === 'up' ? 'up' : 'down' })
      }
    }
    const canList = typeof interconnect.list === 'function'
    const results = await Promise.all(rows.map(async row => {
      const sourceRow = { instanceId: row.instanceId, link: row.link, sessions: 0 }
      if (row.link !== 'up') return { row: sourceRow, items: [] }
      if (!canList) {
        sourceRow.error = 'no-list-method'
        return { row: sourceRow, items: [] }
      }
      let settled
      try {
        settled = await settleWithin(interconnect.list(row.instanceId), timeoutMs)
      } catch {
        settled = { kind: 'error' }
      }
      if (settled.kind === 'timeout') {
        sourceRow.error = 'timeout'
        degraded.push(row.instanceId + ' 的会话列表超时（' + timeoutMs + 'ms）')
        return { row: sourceRow, items: [] }
      }
      if (settled.kind === 'error') {
        sourceRow.error = 'failed'
        degraded.push(row.instanceId + ' 的会话列表失败：该设备会话不可见')
        return { row: sourceRow, items: [] }
      }
      const value = settled.value
      const list = value && typeof value === 'object' && Array.isArray(value.sessions) ? value.sessions : null
      if (list === null) {
        sourceRow.error = 'unreachable'
        degraded.push(row.instanceId + ' 的会话列表不可达（链路无应答）')
        return { row: sourceRow, items: [] }
      }
      const items = []
      for (const item of list) {
        if (items.length >= TIERS_MAX_REMOTE_SESSIONS) break
        if (!item || typeof item !== 'object') continue
        const sessionId = tex(item.sessionId, 160)
        if (sessionId === '') continue
        items.push({
          sessionId,
          title: tex(item.title),
          status: mapStatus(item.status),
        })
      }
      sourceRow.sessions = items.length
      return { row: sourceRow, items }
    }))
    for (const result of results) {
      remote.push(result.row)
      for (const item of result.items) {
        if (nodes.length >= TIERS_MAX_NODES) {
          truncated = true
          break
        }
        remoteTopCount += 1
        nodes.push({
          id: result.row.instanceId + ':' + item.sessionId,
          parentId: rootId,
          tier: 1,
          kind: 'session',
          device: result.row.instanceId,
          title: item.title !== '' ? item.title : '会话 ' + shortId(item.sessionId),
          status: item.status,
          startedAt: null,
        })
      }
    }
    if (truncated) degraded.push('层级节点超过上限，已截断（只列前 ' + TIERS_MAX_NODES + ' 个）')
    if (remoteTopCount > 0) {
      degraded.push('远端设备的子代理层级不可见（interconnect 只列顶层活会话）')
    }
  }

  const source = {
    local: local.ok ? 'sessions+agents' : 'unavailable',
    subagents: local.ok ? 'session-header(origin+parentSession)' : 'unavailable',
    // 官方 subagent 投影（mode/label）的可达性，与本机血缘来源分开报，别混成一句。
    subagentMode: !local.ok
      ? 'unavailable'
      : (local.official.modes > 0 ? 'official-projection' : (local.official.reads > 0 ? 'official-projection(no-mode)' : 'unavailable')),
    remote,
    cached: false,
    ageMs: 0,
  }
  const body = {
    generatedAt: new Date(now).toISOString(),
    source,
    root,
    nodes,
  }
  if (degraded.length > 0) body.degraded = { reason: [...new Set(degraded)].join('；') }
  return body
}

/**
 * 数据源整体不可用时的兜底响应体：仍给 T0，`degraded` 写原因，页面照常渲染。
 * @param {string} reason 人话原因（不含任何原始错误文本）
 * @param {number} [now] 生成时刻（毫秒）
 * @returns {object}
 */
export function fallbackTiers(reason, now = Date.now()) {
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  return {
    generatedAt: new Date(at).toISOString(),
    source: { local: 'unavailable', subagents: 'unavailable', subagentMode: 'unavailable', remote: [], cached: false, ageMs: 0 },
    root: {
      id: ROOT_ID,
      label: ROOT_LABEL,
      device: ROOT_ID,
      tier: 0,
      status: 'run',
      startedAt: new Date(at).toISOString(),
    },
    nodes: [],
    degraded: { reason: reason || '层级快照生成失败' },
  }
}

/**
 * 带 4 秒缓存 + 单飞（并发请求共用同一个 in-flight promise）的读取器。
 *
 * @param {object} deps {@link buildTiers} 的依赖，外加 `cacheMs`
 * @returns {{read: () => Promise<object>, clear: () => void}}
 */
export function createTiersReader(deps = {}) {
  const cacheMs = Number.isFinite(deps.cacheMs) && deps.cacheMs >= 0 ? deps.cacheMs : TIERS_CACHE_MS
  const nowOf = typeof deps.now === 'function' ? deps.now : () => Date.now()
  let cached = null
  let cachedAt = 0
  let inflight = null

  const read = async () => {
    const now = Number.isFinite(nowOf()) ? nowOf() : Date.now()
    if (cached !== null && now - cachedAt < cacheMs) {
      return { ...cached, source: { ...cached.source, cached: true, ageMs: Math.max(0, now - cachedAt) } }
    }
    if (inflight !== null) return inflight
    inflight = (async () => {
      const body = await buildTiers(deps)
      cached = body
      cachedAt = Number.isFinite(nowOf()) ? nowOf() : Date.now()
      return body
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  const clear = () => {
    cached = null
    cachedAt = 0
  }

  return { read, clear }
}
