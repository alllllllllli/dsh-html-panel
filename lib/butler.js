/**
 * 大管家驾驶舱 M0+M1：`api/butler/sessions` 与 `api/butler/dialog` 的全部组装逻辑。
 *
 * 口径（2026-11-21 主人拍板）：**大管家管理所有人，不是共享任务板**。本模块只做
 * 只读两件事：
 *
 *   M0 `buildButlerSessions` — 可管理对象清单：本机会话（活/冷）+ 官方子代理血缘 +
 *      每个会话的 `sessionController.state()`（active/running/queue/pendingInput）+
 *      最后活动时间 + 跨机对端（interconnect，只读不可控）。
 *   M1 `buildButlerDialog` — 某一个会话的真实对话流：`sessionController.events()` 分页
 *      读尾部页，按 seq 去重后归一化成 `{messages:[{seq,role,time,text,thinking?,tools?}]}`；
 *      tool/step 中间事件压成「工具名 + 一行参数/结果摘要」的可折叠卡片，不把大输出塞进页面。
 *
 * **零写操作**：本文件不 import 任何写 API，也不调用 prompt/cancel/interrupt/archive/
 * updateTask。M2 的写通道（`api/butler/say`）不在这里，也不在 0.7.0 里。
 *
 * 与 `lib/tiers.js` 的关系：**不复制第二套血缘**。M0 直接读同一个 tiers reader（4 秒缓存、
 * 单飞）拿 T0→T1→T2/T3 节点与跨机远端行，再补两样 tiers 没有的东西：
 *   1. `sessionController.list()` 的 `updatedAt` / `agentAvailable` / 会话标题，
 *      以及只存在于持久化层的**冷会话**（tiers 只列活会话）；
 *   2. `sessionController.state()` 的排队 / 等审批 / 等回答。
 *
 * 已知边界（README 与报告同口径，不在这里假装完整）：
 *   - 跨机只能列标题/状态，**不能读对话、不能中断/催办**（interconnect 契约如此）；
 *   - 冷会话状态只标「空闲（会话未激活）」，不读磁盘也不激活它；
 *   - 对话增量靠页面轮询 + seq 去重（M1），SSE/`ctx.on('session/event')` 留 M2。
 *
 * 硬约束：任何输入都不许抛错；任何原始异常文本都不带出（只给稳定的人话原因）。
 */
import { buildTiers, mapStatus } from './tiers.js'

/** M0 快照缓存窗口：页面 10 秒轮询，取 4 秒避免和 tiers 缓存互相打架。 */
export const BUTLER_CACHE_MS = 4000

/** `sessionController.list()` 的等待上限（冷会话要 stat 持久化，别无限等）。 */
export const BUTLER_LIST_TIMEOUT_MS = 5000

/** 单个 `sessionController.state()` 的等待上限。 */
export const BUTLER_STATE_TIMEOUT_MS = 1500

/** 单个 `sessionController.events()` 的等待上限。 */
export const BUTLER_DIALOG_TIMEOUT_MS = 4000

/** 对话页默认/最大消息预算（对应 events() 的 maxMessages）。 */
export const BUTLER_DIALOG_DEFAULT_LIMIT = 30
export const BUTLER_DIALOG_MAX_LIMIT = 50

/** 会话节点上限，防止异常会话集合撑爆响应/页面。 */
export const BUTLER_MAX_SESSIONS = 150

/** 单条工具参数 / 结果摘要的字符上限：页面只显示一两行，不塞大输出。 */
export const TOOL_ARG_MAX = 200
export const TOOL_RESULT_MAX = 240

/** 单条消息正文 / 思考块的字符上限（防止一篇超长输出撑爆一轮轮询）。 */
export const MESSAGE_TEXT_MAX = 12000
export const MESSAGE_THINKING_MAX = 4000

/** 单页事件上限：超过就只保留尾部，并如实降级（分页本身是消息对齐的）。 */
export const DIALOG_MAX_EVENTS = 3000

/** 状态 → 页面文案（与右栏图例同一套词）。 */
const STATUS_TEXT = Object.freeze({
  run: '运行中',
  idle: '空闲',
  queue: '排队',
  blocked: '阻塞',
  done: '已完成',
})

/** 会话 id 的短形式：只用于缺标题时的可读占位，不编标题。 */
function shortId(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length > 14 ? text.slice(0, 6) + '…' + text.slice(-4) : text
}

/** 截断外部字符串，避免把异常长文本塞进响应。 */
function tex(value, max = 120) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** 去掉空白并截断（工具摘要用）。 */
function oneLine(value, max) {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, Math.max(0, max - 1)) + '…' : collapsed
}

/** 毫秒时间戳 → ISO；非法值 null（不编时间）。 */
function isoAt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
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

/** 一个带超时的 AbortSignal；环境不支持时退化成 AbortController。 */
function abortAfter(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms)
    }
  } catch {
    /* 退化到下面的 controller */
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

/**
 * 把任意 thenable 包成「值 / 超时 / 失败」三态，绝不抛出。
 * @param {unknown} promise
 * @param {number} ms
 * @returns {Promise<{kind:'value', value:unknown}|{kind:'timeout'}|{kind:'error', error:unknown}>}
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
      error => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ kind: 'error', error })
      },
    )
  })
}

/**
 * 读取插件配置里的 `butler` 段（只读解析；写通道另见 `lib/butler-write.js`）。
 *
 * `{ sessionId?, targetMode?, allowWrite?, configPath?, label?, agentPreset? }`；默认 recent-root
 * （最近有主人消息的根会话）。配置了 sessionId 就以它为准（targetMode 只用于展示）。
 * 0.8.0 增加：`allowWrite`（M2 写通道开关，只认 true）、`configPath`（重建时写回的
 * cordis.patch.yml 绝对路径）、`agentPreset`（专属会话使用的 agent 预设；领导预设时页面标出）、
 * `label`（专属会话显示名，缺省「大管家 · 常驻」）。
 * 本模块**不导出 token**：token 只活在 `lib/butler-write.js` 与页面 HTML 里。
 *
 * @param {unknown} config 插件行 config（可能 undefined）
 * @returns {{sessionId:string, targetMode:'pinned'|'recent-root', allowWrite:boolean, configPath:string, label:string, agentPreset:string}}
 */
export function readButlerConfig(config) {
  const row = config && typeof config === 'object' ? config : {}
  const shaped = row.butler && typeof row.butler === 'object' ? row.butler : {}
  const sessionId = typeof shaped.sessionId === 'string' ? shaped.sessionId.trim().slice(0, 160) : ''
  const targetMode = sessionId !== ''
    ? 'pinned'
    : (shaped.targetMode === 'pinned' ? 'pinned' : 'recent-root')
  const configPath = typeof shaped.configPath === 'string' ? shaped.configPath.trim() : ''
  const label = typeof shaped.label === 'string' && shaped.label.trim() !== ''
    ? shaped.label.trim().slice(0, 60)
    : '大管家 · 常驻'
  const agentPreset = typeof shaped.agentPreset === 'string' ? shaped.agentPreset.trim().slice(0, 80) : ''
  return { sessionId, targetMode, allowWrite: shaped.allowWrite === true, configPath, label, agentPreset }
}

/**
 * 官方 `subagent` 投影里的 mode（只认官方两个值）。
 * @param {unknown} value
 * @returns {'one-shot'|'continuable'|'unknown'|null}
 */
function officialMode(value) {
  if (value === 'one-shot' || value === 'continuable') return value
  return null
}

/** 摘要里的标题：官方投影 title 优先，其次子代理 label，都没有给空串。 */
function titleOfSummary(summary) {
  const values = summary && summary.projections && typeof summary.projections === 'object'
    ? summary.projections.values
    : null
  if (!values || typeof values !== 'object') return ''
  const title = tex(values.title)
  if (title !== '') return title
  const subagent = values.subagent
  if (subagent && typeof subagent === 'object') return tex(subagent.label)
  return ''
}

/** 摘要里的官方子代理 mode（父/子投影任一可用）。 */
function modeOfSummary(summary) {
  const values = summary && summary.projections && typeof summary.projections === 'object'
    ? summary.projections.values
    : null
  if (!values || typeof values !== 'object') return null
  const own = values.subagent
  if (own && typeof own === 'object') {
    const mode = officialMode(own.mode)
    if (mode !== null) return mode
  }
  return null
}

/** 摘要里「最近一次主人消息」的时间（官方 sessionListMetadata 投影）。 */
function lastPromptOf(summary) {
  const values = summary && summary.projections && typeof summary.projections === 'object'
    ? summary.projections.values
    : null
  const metadata = values && typeof values === 'object' ? values.sessionListMetadata : null
  if (!metadata || typeof metadata !== 'object') return null
  return typeof metadata.lastPromptAt === 'number' && Number.isFinite(metadata.lastPromptAt)
    ? metadata.lastPromptAt
    : null
}

/**
 * 把一个 `SessionState` 折算成页面右栏/对话头要用的状态。
 *
 * 优先级：等审批 / 等回答（需要人）→ 运行中 → 排队 → 空闲。
 * @param {unknown} state `sessionController.state()` 的返回值（可能 null）
 * @param {string} fallbackStatus 状态读不到时的 tiers/agents 状态
 * @returns {{status:string,statusText:string,active:boolean,running:boolean,queue:number,pendingInput:string[],stateKnown:boolean}}
 */
export function foldSessionState(state, fallbackStatus = 'idle') {
  const pending = state && Array.isArray(state.pendingInput) ? state.pendingInput.filter(item => typeof item === 'string') : []
  const queue = state && Array.isArray(state.queue) ? state.queue.length : 0
  const running = state ? state.running === true : false
  const active = state ? state.active === true : false
  const base = {
    active,
    running,
    queue,
    pendingInput: pending,
    stateKnown: state !== null && state !== undefined,
  }
  if (pending.includes('approval')) return { ...base, status: 'blocked', statusText: '等审批' }
  if (pending.includes('question')) return { ...base, status: 'blocked', statusText: '等回答' }
  if (pending.length > 0) return { ...base, status: 'blocked', statusText: '等待输入' }
  if (running) return { ...base, status: 'run', statusText: STATUS_TEXT.run }
  if (queue > 0) return { ...base, status: 'queue', statusText: STATUS_TEXT.queue }
  const mapped = mapStatus(fallbackStatus)
  return { ...base, status: mapped, statusText: STATUS_TEXT[mapped] || STATUS_TEXT.idle }
}

/** 跨机行（interconnect.list）的状态文案：只认 tiers 已映射的五个状态。 */
function remoteStatusText(status) {
  return STATUS_TEXT[status] || STATUS_TEXT.idle
}

/** tiers 节点 → M0 节点的基础字段（保留官方 subagent 地址契约字段）。 */
function nodeFromTiers(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    tier: node.tier,
    kind: node.kind === 'subagent' ? 'subagent' : 'session',
    device: node.device,
    title: node.title,
    status: node.status,
    statusText: STATUS_TEXT[node.status] || STATUS_TEXT.idle,
    startedAt: node.startedAt,
    updatedAt: null,
    active: node.status === 'run',
    running: node.status === 'run',
    queue: 0,
    pendingInput: [],
    stateKnown: false,
    mode: node.mode === 'one-shot' || node.mode === 'continuable' ? node.mode : (node.kind === 'subagent' ? 'unknown' : null),
    parentSessionId: node.parentSessionId === undefined ? null : node.parentSessionId,
    childSessionId: node.childSessionId === undefined ? null : node.childSessionId,
    readonly: false,
    controllable: true,
  }
}

/**
 * 把 tiers 快照 + 会话摘要 + 会话状态拼成 M0 响应（同步部分；异步读取在
 * {@link collectSessionIndex} 里完成）。
 *
 * @param {object} input
 * @param {object} input.tierBody api/tiers 形状的快照
 * @param {Array<object>|null} input.summaries sessionController.list() 的 items（可能 null）
 * @param {Map<string,object>} input.states sessionId → SessionState
 * @param {Map<string,object>} input.stateErrors sessionId → 人话原因
 * @param {number} input.now 生成时刻（毫秒）
 * @param {string[]} input.degraded 降级原因（原地追加）
 * @param {{sessionId:string,targetMode:string}} input.config 插件 `butler` 配置
 * @returns {{body:object, summaryById:Map<string,object>, nodeById:Map<string,object>, binding:object}}
 */
function assembleSessions({ tierBody, summaries, states, stateErrors, now, degraded, config }) {
  const root = tierBody && tierBody.root && typeof tierBody.root === 'object' ? tierBody.root : {}
  const rootId = typeof root.id === 'string' && root.id !== '' ? root.id : 'pc-ky614'
  const sourceRows = tierBody && tierBody.source && Array.isArray(tierBody.source.remote) ? tierBody.source.remote : []
  const remoteDevices = new Set()
  for (const row of sourceRows) {
    if (row && typeof row.instanceId === 'string' && row.instanceId !== '') remoteDevices.add(row.instanceId)
  }

  const summaryById = new Map()
  if (Array.isArray(summaries)) {
    for (const summary of summaries) {
      if (summary && typeof summary.sessionId === 'string' && summary.sessionId !== '') {
        summaryById.set(summary.sessionId, summary)
      }
    }
  }

  const nodes = []
  const nodeById = new Map()
  for (const raw of tierBody && Array.isArray(tierBody.nodes) ? tierBody.nodes : []) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') continue
    const isRemote = remoteDevices.has(raw.device) && raw.device !== rootId
    const node = nodeFromTiers(raw)
    if (isRemote) {
      node.readonly = true
      node.controllable = false
      node.title = raw.title || '会话 ' + shortId(raw.id)
    } else {
      const summary = summaryById.get(node.id) || null
      if (summary) {
        const title = titleOfSummary(summary)
        if (title !== '' && /^(会话 |子代理 )/.test(node.title)) node.title = title
        node.updatedAt = isoAt(summary.updatedAt)
        node.agentAvailable = summary.agentAvailable === true
        if (node.mode === null || node.mode === 'unknown') {
          const mode = modeOfSummary(summary)
          if (mode !== null) node.mode = mode
        }
      }
      const state = states.get(node.id)
      if (state !== undefined) Object.assign(node, foldSessionState(state, node.status))
      else if (stateErrors.has(node.id)) node.stateKnown = false
    }
    nodes.push(node)
    nodeById.set(node.id, node)
  }

  /* ---- 冷会话：tiers 只列活会话，sessionController.list() 还知道持久化会话 ---- */
  const summaryOnly = []
  for (const summary of summaryById.values()) {
    if (nodeById.has(summary.sessionId)) continue
    if (summary.blank === true) continue // 从没开始过的空会话不是可管理对象
    summaryOnly.push(summary)
    if (summaryOnly.length >= BUTLER_MAX_SESSIONS) break
  }
  const summaryTierOf = id => {
    const seen = new Set()
    let current = summaryById.get(id)
    let depth = 1
    while (current && current.origin === 'subagent' && typeof current.parentSessionId === 'string') {
      if (seen.has(current.sessionId) || depth > 8) break
      seen.add(current.sessionId)
      const parent = summaryById.get(current.parentSessionId)
      if (!parent) return { tier: 1, orphan: true }
      depth += 1
      current = parent
    }
    return { tier: Math.min(depth, 8), orphan: false }
  }
  let orphanCold = 0
  for (const summary of summaryOnly) {
    const id = summary.sessionId
    const isSubagent = summary.origin === 'subagent'
    const parentSessionId = typeof summary.parentSessionId === 'string' && summary.parentSessionId !== ''
      ? summary.parentSessionId
      : null
    const computed = isSubagent ? summaryTierOf(id) : { tier: 1, orphan: false }
    if (computed.orphan) orphanCold += 1
    const parentKnown = isSubagent && parentSessionId !== null && summaryById.has(parentSessionId)
    const node = {
      id,
      parentId: isSubagent ? (parentKnown ? parentSessionId : rootId) : rootId,
      tier: computed.tier,
      kind: isSubagent ? 'subagent' : 'session',
      device: rootId,
      title: titleOfSummary(summary) || (isSubagent ? '子代理 ' : '会话 ') + shortId(id),
      status: 'idle',
      statusText: summary.agentAvailable === true ? '空闲' : '空闲（会话未激活，只读历史）',
      startedAt: null,
      updatedAt: isoAt(summary.updatedAt),
      active: false,
      running: false,
      queue: 0,
      pendingInput: [],
      stateKnown: false,
      mode: isSubagent ? (modeOfSummary(summary) || 'unknown') : null,
      parentSessionId: isSubagent ? parentSessionId : null,
      childSessionId: id,
      readonly: false,
      controllable: true,
      cold: true,
    }
    const state = states.get(id)
    if (state !== undefined) Object.assign(node, foldSessionState(state, 'idle'))
    nodes.push(node)
    nodeById.set(id, node)
  }
  if (orphanCold > 0) degraded.push('有 ' + orphanCold + ' 个冷子代理的父会话已不可见，已挂到 T1')
  if (nodes.length >= BUTLER_MAX_SESSIONS) degraded.push('会话节点超过上限，已截断（只列前 ' + BUTLER_MAX_SESSIONS + ' 个）')

  /* ---- 跨机：只给标题/状态，明确标注只读不可控 ---- */
  const remote = []
  for (const row of sourceRows) {
    if (!row || typeof row.instanceId !== 'string' || row.instanceId === '') continue
    const sessions = nodes
      .filter(node => node.device === row.instanceId && node.device !== rootId)
      .map(node => ({
        id: node.id,
        sessionId: node.id.slice(row.instanceId.length + 1),
        title: node.title,
        status: node.status,
        statusText: node.statusText,
        readonly: true,
        controllable: false,
      }))
    remote.push({
      instanceId: row.instanceId,
      link: row.link === 'up' ? 'up' : 'down',
      readonly: true,
      controllable: false,
      note: '远端只读不可控（interconnect 只能列标题/状态，不能读对话、不能中断）',
      sessions,
      ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
    })
  }

  const counts = { 0: 1, 1: 0, 2: 0, 3: 0 }
  for (const node of nodes) {
    if (node.tier <= 1) counts[1] += 1
    else if (node.tier === 2) counts[2] += 1
    else counts[3] += 1
  }

  const binding = resolveBinding({ config, summaries, summaryById, nodeById, rootId, degraded })
  const body = {
    generatedAt: new Date(now).toISOString(),
    root: {
      id: rootId,
      label: typeof root.label === 'string' && root.label !== '' ? root.label : '大管家',
      device: typeof root.device === 'string' && root.device !== '' ? root.device : rootId,
      tier: 0,
      status: 'run',
      statusText: STATUS_TEXT.run,
      startedAt: typeof root.startedAt === 'string' ? root.startedAt : new Date(now).toISOString(),
      readonly: false,
    },
    source: {
      sessions: summaryById.size > 0 ? 'sessionController.list' : 'unavailable',
      states: states.size > 0 ? 'sessionController.state' : (stateErrors.size > 0 ? 'unavailable' : 'none'),
      lineage: tierBody && Array.isArray(tierBody.nodes) && tierBody.nodes.length > 0
        ? 'api/tiers(shared 4s cache)'
        : 'api/tiers(empty or degraded)',
      remote: remoteDevices.size > 0 ? 'interconnect.list' : 'unavailable',
      cached: false,
      ageMs: 0,
    },
    counts,
    total: nodes.length,
    nodes,
    remote,
    remoteNote: '跨机会话只读：能看标题/状态，不能读对话、不能催办/中断（M0/M1 边界）',
    /* 0.8.0 M2：写通道开关与唯一允许的发送目标；token 绝不进这里。 */
    write: {
      enabled: config.allowWrite === true,
      targetSessionId: config.sessionId !== '' ? config.sessionId : null,
      label: config.label,
      agentPreset: config.agentPreset,
      note: '写通道只对 config.butler.sessionId 生效；token 只在页面 HTML 里，不经过任何 api 响应',
    },
    binding,
  }
  return { body, summaryById, nodeById, binding }
}

/**
 * 解析「中栏绑定哪个会话」。
 *
 * 规则（主人拍板）：config 给了 `butler.sessionId` 就用它；否则取
 * **最近有主人消息的根会话**（官方 `sessionListMetadata.lastPromptAt` 最大；
 * 没有该投影时退回 updatedAt）。找不到就 `available:false + reason`，**绝不编会话**。
 *
 * @param {object} input
 * @param {{sessionId:string,targetMode:string}} input.config
 * @param {Array<object>|null} input.summaries
 * @param {Map<string,object>} input.summaryById
 * @param {Map<string,object>} input.nodeById
 * @param {string} input.rootId
 * @param {string[]} input.degraded
 * @returns {object}
 */
export function resolveBinding({ config, summaries, summaryById, nodeById, rootId, degraded = [] }) {
  const pinned = config && typeof config.sessionId === 'string' ? config.sessionId : ''
  const label = config && typeof config.label === 'string' && config.label !== '' ? config.label : '大管家 · 常驻'
  const agentPreset = config && typeof config.agentPreset === 'string' ? config.agentPreset : ''
  // 0.8.0：配置明确要 pinned 但还没有 sessionId（专属会话尚未创建）。
  // 这不是「自动绑定」——必须报 available:false，让页面显示「创建专属会话」，
  // 绝不能静默回退到最近根会话（那会让写通道绑错会话）。
  if (pinned === '' && config && config.targetMode === 'pinned') {
    return {
      sessionId: '',
      title: null,
      label,
      ...(agentPreset === '' ? {} : { agentPreset }),
      targetMode: 'pinned',
      resolvedBy: 'config',
      available: false,
      reason: '尚未创建专属大管家会话（config.butler.sessionId 为空）：用「创建专属会话」按配置的预设建一个',
    }
  }
  if (pinned !== '') {
    const summary = summaryById instanceof Map ? summaryById.get(pinned) : null
    const node = nodeById instanceof Map ? nodeById.get(pinned) : null
    if (summary || node) {
      return {
        sessionId: pinned,
        title: (summary ? titleOfSummary(summary) : '') || (node ? node.title : '') || label,
        label,
        ...(agentPreset === '' ? {} : { agentPreset }),
        targetMode: 'pinned',
        resolvedBy: 'config',
        available: true,
      }
    }
    return {
      sessionId: pinned,
      title: null,
      label,
      ...(agentPreset === '' ? {} : { agentPreset }),
      targetMode: 'pinned',
      resolvedBy: 'config',
      available: false,
      reason: 'config.butler.sessionId 指向的专属大管家会话不在可见会话列表里（可能已归档或删除）：请用「重建专属会话」，或改配置',
    }
  }

  const list = Array.isArray(summaries) ? summaries.filter(summary =>
    summary && typeof summary.sessionId === 'string' && summary.origin !== 'subagent' && summary.blank !== true) : []
  if (list.length === 0) {
    // sessionController.list 不可用时，退回 tiers 里最新的本机根会话（仍标清来源）。
    const fallback = []
    if (nodeById instanceof Map) {
      for (const node of nodeById.values()) {
        if (node.kind === 'session' && !node.readonly && node.device === rootId) fallback.push(node)
      }
    }
    if (fallback.length > 0) {
      fallback.sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))
      degraded.push('sessionController.list 不可用：按层级快照的创建时间选最近根会话')
      return {
        sessionId: fallback[0].id,
        title: fallback[0].title,
        targetMode: 'recent-root',
        resolvedBy: 'recent-root(tiers)',
        available: true,
      }
    }
    return {
      sessionId: null,
      title: null,
      targetMode: 'recent-root',
      resolvedBy: 'none',
      available: false,
      reason: '没有可见的根会话：sessionController.list 不可用或列表为空，无法确定中栏绑定哪个会话',
    }
  }
  list.sort((left, right) => {
    const leftAt = lastPromptOf(left) ?? left.updatedAt ?? 0
    const rightAt = lastPromptOf(right) ?? right.updatedAt ?? 0
    return rightAt - leftAt
  })
  const picked = list[0]
  const withPrompt = list.find(summary => lastPromptOf(summary) !== null) || null
  const target = withPrompt || picked
  if (withPrompt === null) degraded.push('会话列表没有最近主人消息时间：按最后活动时间选最近根会话')
  return {
    sessionId: target.sessionId,
    title: titleOfSummary(target) || '会话 ' + shortId(target.sessionId),
    targetMode: 'recent-root',
    resolvedBy: 'recent-root',
    available: true,
  }
}

/**
 * 取 tiers 快照：优先用传进来的 reader（与 `api/tiers` 共用缓存），否则现算。
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function tierBodyOf(deps) {
  const tiers = serviceOf(deps, 'tiers')
  if (tiers !== null && typeof tiers === 'object' && typeof tiers.read === 'function') {
    return tiers.read()
  }
  return buildTiers({
    interconnect: deps.interconnect,
    sessions: deps.sessions,
    agents: deps.agents,
    projections: deps.projections,
    now: deps.now,
  })
}

/**
 * 一次 M0 的完整读取（含缓存前的内部结构）：给 `buildButlerSessions` 与 reader 共用。
 *
 * @param {object} deps
 * @param {object} deps.controller 返回 `ctx.sessionController` 的 getter（可缺）
 * @param {object} deps.tiers 返回 `createTiersReader()` 的 getter 或直接给 reader（可缺）
 * @param {object} deps.interconnect/sessions/agents/projections 传给 tiers 的 getter（可缺）
 * @param {object} deps.config 插件 config（读 `butler` 段）
 * @param {number|(() => number)} deps.now 生成时刻（测试可注入）
 * @param {number} deps.listTimeoutMs 会话列表等待上限
 * @param {number} deps.stateTimeoutMs 单会话状态等待上限
 * @returns {Promise<{body:object, summaryById:Map<string,object>, nodeById:Map<string,object>}>}
 */
export async function collectSessionIndex(deps = {}) {
  const nowInput = typeof deps.now === 'function' ? deps.now() : deps.now
  const now = typeof nowInput === 'number' && Number.isFinite(nowInput) ? nowInput : Date.now()
  const degraded = []
  const controller = serviceOf(deps, 'controller')
  const config = readButlerConfig(deps.config)

  const tierBody = await tierBodyOf(deps)
  if (tierBody && tierBody.degraded && typeof tierBody.degraded.reason === 'string' && tierBody.degraded.reason !== '') {
    degraded.push(tierBody.degraded.reason)
  }

  /* ---- sessionController.list()：updatedAt / agentAvailable / 冷会话 ---- */
  let summaries = null
  let listTimedOut = false
  if (controller !== null && typeof controller === 'object' && typeof controller.list === 'function') {
    const settled = await settleWithin(
      controller.list({}, abortAfter(typeof deps.listTimeoutMs === 'number' ? deps.listTimeoutMs : BUTLER_LIST_TIMEOUT_MS)),
      (typeof deps.listTimeoutMs === 'number' ? deps.listTimeoutMs : BUTLER_LIST_TIMEOUT_MS) + 250,
    )
    if (settled.kind === 'timeout') {
      listTimedOut = true
      degraded.push('sessionController.list 超时：最后活动时间与冷会话不可见')
    } else if (settled.kind === 'error') {
      degraded.push('sessionController.list 失败：最后活动时间与冷会话不可见')
    } else {
      const value = settled.value
      summaries = value && typeof value === 'object' && Array.isArray(value.items) ? value.items : null
      if (summaries === null) degraded.push('sessionController.list 返回结构不符：最后活动时间不可用')
    }
  } else {
    degraded.push('DSH 没有可用的 sessionController.list：最后活动时间与冷会话不可见')
  }

  const summaryById = new Map()
  if (Array.isArray(summaries)) {
    for (const summary of summaries) {
      if (summary && typeof summary.sessionId === 'string' && summary.sessionId !== '') summaryById.set(summary.sessionId, summary)
    }
  }

  /* ---- 会话状态：只对活会话读（冷会话不激活、不读盘） ---- */
  const states = new Map()
  const stateErrors = new Map()
  const liveIds = []
  const tierNodes = tierBody && Array.isArray(tierBody.nodes) ? tierBody.nodes : []
  const rootId = tierBody && tierBody.root && typeof tierBody.root.id === 'string' ? tierBody.root.id : 'pc-ky614'
  const remoteDevices = new Set()
  if (tierBody && tierBody.source && Array.isArray(tierBody.source.remote)) {
    for (const row of tierBody.source.remote) if (row && typeof row.instanceId === 'string') remoteDevices.add(row.instanceId)
  }
  for (const node of tierNodes) {
    if (!node || typeof node.id !== 'string') continue
    if (remoteDevices.has(node.device) && node.device !== rootId) continue
    const summary = summaryById.get(node.id)
    if (summary && summary.agentAvailable === false) continue
    liveIds.push(node.id)
  }
  for (const summary of summaryById.values()) {
    if (summary.origin === 'subagent' && summary.agentAvailable === true && !liveIds.includes(summary.sessionId)) {
      liveIds.push(summary.sessionId)
    }
  }
  const canState = controller !== null && typeof controller === 'object' && typeof controller.state === 'function'
  if (canState && liveIds.length > 0) {
    const stateTimeout = typeof deps.stateTimeoutMs === 'number' ? deps.stateTimeoutMs : BUTLER_STATE_TIMEOUT_MS
    const results = await Promise.all(liveIds.slice(0, BUTLER_MAX_SESSIONS).map(async id => {
      const settled = await settleWithin(
        controller.state({ sessionId: id }, abortAfter(stateTimeout)),
        stateTimeout + 200,
      )
      return { id, settled }
    }))
    for (const { id, settled } of results) {
      if (settled.kind === 'value' && settled.value && typeof settled.value === 'object') {
        states.set(id, settled.value)
      } else if (settled.kind === 'timeout') {
        stateErrors.set(id, '超时')
      } else {
        stateErrors.set(id, '读取失败')
      }
    }
    if (stateErrors.size > 0) {
      degraded.push(stateErrors.size + ' 个会话的状态读取失败：这些节点只显示层级快照状态')
    }
  } else if (!canState) {
    degraded.push('DSH 没有可用的 sessionController.state：右栏只显示运行/空闲两态')
  }

  const assembled = assembleSessions({
    tierBody,
    summaries,
    states,
    stateErrors,
    now,
    degraded,
    config,
  })
  if (listTimedOut) assembled.body.binding.degradedListTimeout = true
  if (degraded.length > 0) assembled.body.degraded = { reason: [...new Set(degraded)].join('；') }
  return assembled
}

/**
 * 组装 M0 响应：`GET /dsh-html-panel/api/butler/sessions`。
 * @param {object} deps 见 {@link collectSessionIndex}
 * @returns {Promise<object>}
 */
export async function buildButlerSessions(deps = {}) {
  const index = await collectSessionIndex(deps)
  return index.body
}

/** M0 整体不可用时的兜底响应体：契约不变，`degraded` 写原因，页面照常渲染。 */
export function fallbackButlerSessions(reason, now = Date.now()) {
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  return {
    generatedAt: new Date(at).toISOString(),
    root: { id: 'pc-ky614', label: '大管家', device: 'pc-ky614', tier: 0, status: 'run', statusText: '运行中', startedAt: new Date(at).toISOString(), readonly: false },
    source: { sessions: 'unavailable', states: 'unavailable', lineage: 'unavailable', remote: 'unavailable', cached: false, ageMs: 0 },
    counts: { 0: 1, 1: 0, 2: 0, 3: 0 },
    total: 0,
    nodes: [],
    remote: [],
    remoteNote: '跨机会话只读：能看标题/状态，不能读对话、不能催办/中断（M0/M1 边界）',
    write: { enabled: false, targetSessionId: null, label: '大管家 · 常驻', note: '会话清单生成失败：写通道状态未知' },
    binding: { sessionId: null, title: null, label: '大管家 · 常驻', targetMode: 'recent-root', resolvedBy: 'none', available: false, reason: reason || '会话清单生成失败' },
    degraded: { reason: reason || '会话清单生成失败' },
  }
}

/* =====================================================================
 * M1：真实对话只读流
 * ===================================================================== */

/** M1 失败响应：契约字段都在，`available:false` + 人话原因，绝不编对话。 */
function dialogUnavailable(reason, extra = {}) {
  return {
    available: false,
    reason,
    sessionId: extra.sessionId ?? null,
    title: null,
    targetMode: extra.targetMode ?? null,
    resolvedBy: extra.resolvedBy ?? 'none',
    state: null,
    messages: [],
    cursor: null,
    hasMore: false,
  }
}

/** 从 content 块里取可见文本；图片/文件用占位符，不塞二进制。 */
function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
    else if (block.type === 'file') parts.push('[文件]')
    /* reasoning / tool-call 由专门的字段/事件处理，正文不重复 */
  }
  const joined = parts.join('\n').trim()
  return joined.length > MESSAGE_TEXT_MAX ? joined.slice(0, MESSAGE_TEXT_MAX - 1) + '…' : joined
}

/** 从 content 块里取思考文本（页面默认折叠）。 */
function thinkingOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n').trim()
  return joined.length > MESSAGE_THINKING_MAX ? joined.slice(0, MESSAGE_THINKING_MAX - 1) + '…' : joined
}

/** 工具参数摘要：JSON 压成一行（解析不了就按原文压行）。 */
function summarizeArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  try {
    const parsed = JSON.parse(raw)
    return oneLine(JSON.stringify(parsed), TOOL_ARG_MAX)
  } catch {
    return oneLine(collapsed, TOOL_ARG_MAX)
  }
}

/**
 * 把一页 events() 记录归一化成页面消息。
 *
 * 只画四种 role：`user`（主人）· `notice`（系统注入，灰条）· `assistant` · `tool`
 * （分页从工具中间开始时才会出现的独立工具组）。`assistant/message` 之后的
 * `tool/call`+`tool/result` 按 callId 配成折叠工具卡，正文不受大输出污染。
 *
 * @param {Array<object>} records `SessionEventsPage.records`
 * @returns {{messages:Array<object>, events:number, tools:number, firstSeq:number|null, lastSeq:number|null}}
 */
export function normalizeDialogEvents(records) {
  const messages = []
  const toolByCallId = new Map()
  let currentAssistant = null
  let currentToolGroup = null
  let events = 0
  let tools = 0
  let firstSeq = null
  let lastSeq = null

  const attachTool = entry => {
    if (currentAssistant !== null) {
      if (!Array.isArray(currentAssistant.tools)) currentAssistant.tools = []
      currentAssistant.tools.push(entry)
      return
    }
    if (currentToolGroup === null) {
      currentToolGroup = { seq: entry.seq, role: 'tool', time: entry.time, tools: [] }
      messages.push(currentToolGroup)
    }
    currentToolGroup.tools.push(entry)
  }

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.type !== 'event' || !record.event || typeof record.event !== 'object') continue
    const event = record.event
    if (typeof event.type !== 'string' || typeof event.seq !== 'number') continue
    events += 1
    if (firstSeq === null || event.seq < firstSeq) firstSeq = event.seq
    if (lastSeq === null || event.seq > lastSeq) lastSeq = event.seq
    const time = isoAt(event.time)
    const data = event.data && typeof event.data === 'object' ? event.data : {}

    if (event.type === 'user/message') {
      const sourceKind = data.source && typeof data.source === 'object' ? tex(data.source.kind, 40) : ''
      const injected = sourceKind !== 'user'
      const text = textOfBlocks(data.content)
      if (text === '') continue
      const message = { seq: event.seq, role: injected ? 'notice' : 'user', time, text }
      if (injected) {
        message.injected = true
        message.source = sourceKind === '' ? 'injected' : sourceKind
      }
      messages.push(message)
      currentAssistant = null
      currentToolGroup = null
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const text = textOfBlocks(message.content)
      const thinking = thinkingOfBlocks(message.content)
      const assistant = { seq: event.seq, role: 'assistant', time, text }
      if (thinking !== '') assistant.thinking = thinking
      if (data.interrupted === true) assistant.interrupted = true
      messages.push(assistant)
      currentAssistant = assistant
      currentToolGroup = null
      continue
    }
    if (event.type === 'tool/call') {
      const callId = tex(data.callId, 120)
      const entry = {
        seq: event.seq,
        callId,
        name: tex(data.name, 80) || 'tool',
        args: summarizeArguments(data.arguments),
      }
      if (callId !== '') toolByCallId.set(callId, entry)
      attachTool(entry)
      tools += 1
      continue
    }
    if (event.type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const callId = tex(message.toolCallId, 120)
      const summary = oneLine(textOfBlocks(message.content), TOOL_RESULT_MAX)
      const isError = message.isError === true || (data.error && typeof data.error === 'object')
      const result = { summary, isError: isError === true }
      if (data.error && typeof data.error === 'object' && typeof data.error.code === 'string') {
        result.code = tex(data.error.code, 60)
      }
      const entry = callId !== '' ? toolByCallId.get(callId) : undefined
      if (entry) {
        entry.result = result
      } else {
        // 分页从工具中间开始：宁可显示「结果无对应调用」，也不丢这条事实。
        attachTool({ seq: event.seq, callId, name: '工具结果', args: '', result, partial: true })
        tools += 1
      }
      continue
    }
    /* turn/step/attempt/header 等中间事件不画：状态由 M0 的 state 负责，页面不塞日志。 */
  }
  return { messages, events, tools, firstSeq, lastSeq }
}

/** 把请求查询参数收敛成 M1 的窗口：limit 1..50，before 正整数。 */
function readDialogWindow(query) {
  const limitRaw = query && typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : Number.NaN
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(BUTLER_DIALOG_MAX_LIMIT, limitRaw)
    : BUTLER_DIALOG_DEFAULT_LIMIT
  const beforeRaw = query && typeof query.before === 'string' ? Number.parseInt(query.before, 10) : Number.NaN
  const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : null
  return { limit, before }
}

/** 错误码 → 人话原因（不把原始异常文本带出去）。 */
function dialogReasonOf(error) {
  if (!error) return '读取会话对话失败（未知原因）'
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return '读取会话对话超时：本页稍后重试'
  const code = typeof error.code === 'string' ? error.code : ''
  switch (code) {
    case 'session/not-found':
      return '会话不存在或已不可见（可能已归档/被删除）'
    case 'subagent/not-found':
      return '子代理会话不存在或已不可见（父会话可能已结束）'
    case 'session/agent-busy':
      return '该子代理会话必须经父会话地址读取，当前地址不完整'
    case 'subagent/catalog-diagnostic':
      return '子代理的官方描述不可用（投影缺失/损坏），M1 只读窗口无法定位它'
    case 'gateway/cancelled':
      return '读取被取消（超时）'
    case 'gateway/bad-request':
      return '请求参数不合法'
    case 'gateway/internal':
      return 'DSH 内部读取失败（详见 DSH 宿主日志）'
    default:
      return '读取会话对话失败' + (code === '' ? '（详见 DSH 宿主日志）' : '：' + code)
  }
}

/**
 * 从会话摘要/节点拼出 events() 需要的官方地址契约。
 * @returns {{address:object}|{error:string}}
 */
function addressOf(sessionId, summary, node) {
  const isSubagent = (summary && summary.origin === 'subagent') || (node && node.kind === 'subagent')
  if (!isSubagent) return { address: { kind: 'session', sessionId } }
  const parentSessionId = (summary && typeof summary.parentSessionId === 'string' && summary.parentSessionId !== '')
    ? summary.parentSessionId
    : (node && typeof node.parentSessionId === 'string' ? node.parentSessionId : '')
  if (parentSessionId === '') {
    return { error: '子代理会话缺少父会话 id（官方地址契约不完整），M1 无法读取' }
  }
  // mode 给 unknown：validateAddress 只在非 unknown 时才校验 mode，避免缓存缺 mode 时误判。
  return { address: { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' } }
}

/**
 * 组装 M1 响应：`GET /dsh-html-panel/api/butler/dialog?sessionId=&limit=&before=`。
 *
 * @param {object} deps
 * @param {object} deps.controller 返回 `ctx.sessionController` 的 getter（可缺）
 * @param {{index?:object}} deps 可选 `index`：由 reader 传入的 M0 缓存（避免每 2 秒列一次会话）
 * @param {object} query URLSearchParams（对象形式也可以）
 * @returns {Promise<object>}
 */
export async function buildButlerDialog(deps = {}, query = {}) {
  const controller = serviceOf(deps, 'controller')
  if (controller === null || typeof controller !== 'object' || typeof controller.events !== 'function') {
    return dialogUnavailable('DSH 没有可用的 sessionController.events：真实对话不可读（M1 需要 0.7.0 Host 生效）')
  }
  const window = readDialogWindow(query)
  let index = deps.index && typeof deps.index === 'object' ? deps.index : null
  try {
    if (index === null) index = await collectSessionIndex(deps)
  } catch {
    index = null
  }
  const summaryById = index && index.summaryById instanceof Map ? index.summaryById : new Map()
  const nodeById = index && index.nodeById instanceof Map ? index.nodeById : new Map()
  const binding = index && index.body && index.body.binding ? index.body.binding : null
  const requested = tex(query && typeof query.sessionId === 'string' ? query.sessionId : '', 160)

  let targetId = requested
  let resolvedBy = 'query'
  let targetMode = 'pinned'
  if (targetId === '') {
    if (!binding) return dialogUnavailable('没有可用的会话绑定信息：无法确定中栏读哪个会话')
    if (binding.available !== true || typeof binding.sessionId !== 'string' || binding.sessionId === '') {
      return dialogUnavailable(binding.reason || '没有可用的会话绑定：请先在右栏选择一个会话', {
        targetMode: binding.targetMode || null,
        resolvedBy: binding.resolvedBy || 'none',
      })
    }
    targetId = binding.sessionId
    resolvedBy = binding.resolvedBy || 'binding'
    targetMode = binding.targetMode || 'recent-root'
  }

  const node = nodeById.get(targetId) || null
  if (node !== null && node.readonly === true) {
    return dialogUnavailable('跨机会话只读且没有对话读取通道：M1 只能读本机会话（interconnect 不提供消息内容）', {
      sessionId: targetId,
      resolvedBy,
      targetMode,
    })
  }
  // 远端节点 id 是 `instanceId:sessionId`：即使没在缓存里也要尽早拒绝，别拿它去问本机。
  if (targetId.includes(':') && node === null) {
    return dialogUnavailable('跨机会话只读且没有对话读取通道：M1 只能读本机会话（interconnect 不提供消息内容）', {
      sessionId: targetId,
      resolvedBy,
      targetMode,
    })
  }

  const summary = summaryById.get(targetId) || null
  const addressed = addressOf(targetId, summary, node)
  if (addressed.error !== undefined) {
    return dialogUnavailable(addressed.error, { sessionId: targetId, resolvedBy, targetMode })
  }

  const title = (summary ? titleOfSummary(summary) : '') || (node ? node.title : '') || '会话 ' + shortId(targetId)
  const request = { address: addressed.address, maxMessages: window.limit }
  if (window.before !== null) request.beforeSeq = window.before

  let page
  try {
    page = await controller.events(request, abortAfter(BUTLER_DIALOG_TIMEOUT_MS))
  } catch (error) {
    return dialogUnavailable(dialogReasonOf(error), { sessionId: targetId, resolvedBy, targetMode })
  }
  if (!page || typeof page !== 'object' || !Array.isArray(page.records)) {
    return dialogUnavailable('sessionController.events 返回结构不符：真实对话不可读', { sessionId: targetId, resolvedBy, targetMode })
  }
  const degraded = []
  let records = page.records
  if (records.length > DIALOG_MAX_EVENTS) {
    records = records.slice(records.length - DIALOG_MAX_EVENTS)
    degraded.push('单页事件过多，已只保留最近 ' + DIALOG_MAX_EVENTS + ' 条事件')
  }
  const normalized = normalizeDialogEvents(records)

  /* ---- 目标会话状态：活会话才真读 state，冷会话不激活它 ---- */
  let sessionState = null
  let stateKnown = false
  if (summary && summary.agentAvailable === false) {
    sessionState = {
      active: false,
      running: false,
      queue: 0,
      pendingInput: [],
      status: 'idle',
      statusText: '空闲（会话未激活，只读历史）',
      stateKnown: true,
    }
    stateKnown = true
  } else if (typeof controller.state === 'function') {
    const settled = await settleWithin(
      controller.state({ sessionId: targetId }, abortAfter(BUTLER_STATE_TIMEOUT_MS)),
      BUTLER_STATE_TIMEOUT_MS + 200,
    )
    if (settled.kind === 'value' && settled.value && typeof settled.value === 'object') {
      const folded = foldSessionState(settled.value, 'idle')
      sessionState = folded
      stateKnown = folded.stateKnown
    } else {
      degraded.push('会话状态读取失败：对话仍显示，但状态未知')
    }
  }

  const cursor = typeof page.cursor === 'number' && Number.isFinite(page.cursor)
    ? page.cursor
    : (normalized.lastSeq !== null ? normalized.lastSeq : (window.before !== null ? window.before : 0))

  const body = {
    available: true,
    generatedAt: new Date().toISOString(),
    sessionId: targetId,
    title,
    targetMode,
    resolvedBy,
    state: sessionState,
    stateKnown,
    messages: normalized.messages,
    cursor,
    hasMore: page.hasMore === true,
    limit: window.limit,
    before: window.before,
    counts: { messages: normalized.messages.length, events: normalized.events, tools: normalized.tools },
  }
  if (degraded.length > 0) body.degraded = { reason: [...new Set(degraded)].join('；') }
  return body
}

/** M1 整体不可用时的兜底响应体（契约不变）。 */
export function fallbackButlerDialog(reason) {
  return dialogUnavailable(reason || '真实对话不可读')
}

/**
 * M0+M1 的读取器：M0 结果缓存 4 秒（页面 10 秒轮询），M1 复用同一份 M0 缓存做目标解析，
 * 所以 2 秒一次的对话轮询不会每轮都去 `sessionController.list()` 读一遍冷会话。
 *
 * @param {object} deps {@link collectSessionIndex} 的依赖，外加 `cacheMs`
 * @returns {{readSessions:() => Promise<object>, readDialog:(query?:object) => Promise<object>, readTiers?:Function, clear:() => void}}
 */
export function createButlerReader(deps = {}) {
  const cacheMs = Number.isFinite(deps.cacheMs) && deps.cacheMs >= 0 ? deps.cacheMs : BUTLER_CACHE_MS
  const nowOf = typeof deps.now === 'function' ? deps.now : () => Date.now()
  let cached = null
  let cachedAt = 0
  let inflight = null

  const readIndex = async () => {
    const now = Number.isFinite(nowOf()) ? nowOf() : Date.now()
    if (cached !== null && now - cachedAt < cacheMs) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const index = await collectSessionIndex(deps)
        cached = index
        cachedAt = Number.isFinite(nowOf()) ? nowOf() : Date.now()
        return index
      } catch {
        // 组装层意外异常：给同一契约的兜底，页面照常渲染。
        return {
          body: fallbackButlerSessions('会话清单生成失败（详见 DSH 宿主日志）'),
          summaryById: new Map(),
          nodeById: new Map(),
        }
      }
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  const readSessions = async () => {
    const index = await readIndex()
    const now = Number.isFinite(nowOf()) ? nowOf() : Date.now()
    const age = Math.max(0, now - cachedAt)
    return {
      ...index.body,
      source: { ...index.body.source, cached: age < cacheMs && cached !== null, ageMs: age },
    }
  }

  const readDialog = async query => {
    const index = await readIndex()
    return buildButlerDialog({ ...deps, index }, query)
  }

  const clear = () => {
    cached = null
    cachedAt = 0
  }

  return { readSessions, readDialog, clear }
}
