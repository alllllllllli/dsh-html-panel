/**
 * Host 半的共享板读取器：`GET /dsh-html-panel/api/board` 的全部网络与脱敏逻辑。
 *
 * 数据源是 `dsh-team-mesh` 插件起的**共享板 HTTP 服务**（只读路由）：
 *   - `GET /health`         探活（免鉴权，但这里仍带 token 头；板服务对只读路由一视同仁）
 *   - `GET /task/list`      任务列表（最多 100 条，这里取 20）
 *   - `GET /task/evidence`  每个任务的证据条数（`/task/list` 不返回条数，只能逐任务查）
 *   - `GET /events`         最近事件
 * 鉴权头是 **`x-team-token: <boardToken>`**（与 `dsh-team-mesh/src/remote.js` 一致）。
 *
 * 三条硬约束：
 *   1. **token 只进请求头**。响应、错误 message、日志里都没有它：`source.origin` 只放
 *      `http(s)://host[:port]`，错误文本统一过 `sanitizeMessage()` 兜底。
 *   2. **路由此模块不抛错**：未配置 / 连不上 / 超时 / 非 JSON / 401 / 500 都化成
 *      `{ configured, source, health, tasks, events, error:{code,message} }` 结构化 JSON。
 *   3. **3 秒进程内缓存**：页面 30 秒轮询一次，但同一毫秒被多个请求打进来时也只碰板一次；
 *      命中缓存时响应体带 `cached: true`。
 *
 * 映射（五态 / acceptance 拆行 / 事件正文）复用 `lib/boardmap.js`，与离线工具
 * `tools/mesh-snapshot.mjs` 是同一份实现。
 */
import { mapBoardTask, toSnapshotEvent } from './boardmap.js'
import { projectMeshTasks } from './taskview.js'

/** 未配置 `timeoutMs` 时的默认超时。 */
export const BOARD_DEFAULT_TIMEOUT_MS = 4000
/** `timeoutMs` 下限：再短会把局域网里正常的抖动误判成超时。 */
export const BOARD_MIN_TIMEOUT_MS = 500
/** `timeoutMs` 上限：面板是一次页面加载，不能让一个路由挂 10 秒以上。 */
export const BOARD_MAX_TIMEOUT_MS = 10000
/** 进程内缓存窗口（毫秒）。 */
export const BOARD_CACHE_MS = 3000
/** `/task/list` 取的条数（板服务上限 100；页面只显示最近任务）。 */
export const BOARD_TASK_LIMIT = 20
/** `/events` 取的条数。 */
export const BOARD_EVENT_LIMIT = 12
/** 单条板响应的体积上限，防止异常响应吃内存。 */
const BOARD_MAX_BYTES = 512 * 1024
/** 官方任务板一次最多收多少条任务视图（官方单团队 maxTasks=256，页面不需要那么多）。 */
export const OFFICIAL_TASK_LIMIT = 50
/** 官方投影最多扫描多少个本机根会话（防异常会话集合拖慢一次同步读取）。 */
const OFFICIAL_MAX_SESSIONS = 60

/** 读一个依赖：可以是 getter 也可以是服务对象本身；抛错/缺服务一律 null。 */
function serviceOf(deps, name) {
  try {
    const value = deps ? deps[name] : undefined
    if (typeof value === 'function') return value()
    return value === undefined ? null : value
  } catch {
    return null
  }
}

/** 外部字符串截断（不把异常长标题塞进响应）。 */
function tex(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 只读读官方 Agent Teams 投影，产出 `/api/board` 的 `official` 段。
 *
 * 官方契约（app.asar 内 `@deepseek-ai/dsh-agent-team/src/projection.ts`）：
 *   key = `agentTeam`，wire view = `{ enabled, tasks: TeamTaskView[], failure? }`。
 * Host 侧拿法：`ctx.sessionProjections.snapshot(session, ['agentTeam','title'])`，
 * 与 `lib/tiers.js` 读标题是同一个服务、同一套只读语义。
 *
 * **诚实边界**：
 *   - 只扫 `sessions.list()` 里的**活**根会话；已结束会话的投影拿不到（同 tiers）。
 *   - 官方任务板只在 Team 模式开启时展示，所以 `enabled !== true` 的团队不并入 `tasks`，
 *     只在 `teams` 里留记录（含 `taskCount`），并把条数记进 `hiddenTasks`。
 *   - 一次读不到就如实降级：返回 `{ available:false, reason }`，**绝不编任务**。
 * @param {{sessions?:Function|object, projections?:Function|object}} [deps] Host 服务（getter 或对象）
 * @returns {{available:boolean, reason?:string, teams:object[], tasks:object[], hiddenTasks:number,
 *   truncated:boolean, failedSessions?:number}}
 */
export function readOfficialBoard(deps = {}) {
  const unavailable = reason => ({
    available: false,
    reason,
    teams: [],
    tasks: [],
    hiddenTasks: 0,
    truncated: false,
  })
  const sessions = serviceOf(deps, 'sessions')
  const projections = serviceOf(deps, 'projections')
  if (!sessions || typeof sessions.list !== 'function') {
    return unavailable('DSH 没有可用的 sessions 服务：官方任务板不可见')
  }
  if (!projections || typeof projections.snapshot !== 'function') {
    return unavailable('DSH 没有可用的 sessionProjections 服务：官方任务板不可见')
  }
  let list
  try {
    list = sessions.list()
  } catch {
    return unavailable('读取本机活会话失败：官方任务板不可见')
  }
  if (!Array.isArray(list)) return unavailable('sessions.list() 没有返回数组：官方任务板不可见')

  const roots = []
  for (const session of list) {
    if (!session || typeof session.id !== 'string' || session.id === '') continue
    const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
    if (header.origin === 'subagent') continue
    roots.push(session)
    if (roots.length >= OFFICIAL_MAX_SESSIONS) break
  }

  const teams = []
  const tasks = []
  let seenProjection = false
  let failed = 0
  let hiddenTasks = 0
  let truncated = false
  for (const session of roots) {
    let values
    try {
      const snapshot = projections.snapshot(session, ['agentTeam', 'title'])
      values = snapshot && snapshot.values && typeof snapshot.values === 'object' ? snapshot.values : null
    } catch {
      failed += 1
      continue
    }
    if (values === null) {
      failed += 1
      continue
    }
    if (!Object.hasOwn(values, 'agentTeam')) continue
    seenProjection = true
    const team = values.agentTeam
    if (!team || typeof team !== 'object' || !Array.isArray(team.tasks)) continue
    const title = tex(values.title, 120)
    const teamTasks = team.tasks.filter(view => view && typeof view === 'object')
    const enabled = team.enabled === true
    if (!enabled) {
      hiddenTasks += teamTasks.length
      teams.push({ sessionId: session.id, title, enabled: false, taskCount: teamTasks.length, shownTasks: 0 })
      continue
    }
    let shown = 0
    for (const view of teamTasks) {
      if (tasks.length >= OFFICIAL_TASK_LIMIT) {
        truncated = true
        break
      }
      tasks.push(Object.assign({}, view, {
        source: 'official',
        sessionId: session.id,
        sessionTitle: title,
        teamEnabled: true,
      }))
      shown += 1
    }
    const row = { sessionId: session.id, title, enabled: true, taskCount: teamTasks.length, shownTasks: shown }
    const failure = tex(team.failure, 200)
    if (failure !== '') row.failure = failure
    teams.push(row)
  }

  if (!seenProjection) {
    return unavailable(failed > 0
      ? '官方 agentTeam 投影读取失败（' + failed + ' 个活会话全部失败）'
      : '官方 agentTeam 投影未注册（agent-team 插件未启用）')
  }
  const body = { available: true, teams, tasks, hiddenTasks, truncated }
  if (failed > 0) body.failedSessions = failed
  return body
}

/** 内部错误类型：只带 `code` 和一句人话，不携带原始 URL/token。 */
class BoardFailure extends Error {
  /**
   * @param {string} code 机读错误码（写进响应 `error.code`）
   * @param {string} message 人话（写进响应 `error.message`）
   */
  constructor(code, message) {
    super(message)
    this.name = 'BoardFailure'
    this.code = code
  }
}

/**
 * 把插件行 config 里的 `config.board` 规整成读取器配置。
 *
 * 入参形状：`{ board: { endpoint, token?, timeoutMs? } }`。也接受平铺的
 * `{ endpoint, token?, timeoutMs? }`（与老 `snapshot` 配置的简写习惯一致）。
 *
 * 非法配置**不抛错**，返回 `configured: false` + 结构化 `error`，路由会原样交给页面。
 * @param {unknown} config 插件行 `config`（可能 undefined）
 * @returns {{configured:boolean, requestBase:string, origin:string|null, token:string,
 *   timeoutMs:number, error:{code:string,message:string}|null}}
 */
export function readBoardConfig(config) {
  const shaped = config && typeof config === 'object'
    ? (config.board && typeof config.board === 'object' ? config.board : config)
    : {}
  const fallback = {
    configured: false,
    requestBase: '',
    origin: null,
    token: '',
    timeoutMs: BOARD_DEFAULT_TIMEOUT_MS,
    error: null,
  }

  const rawEndpoint = typeof shaped.endpoint === 'string' ? shaped.endpoint.trim() : ''
  const rawToken = shaped.token
  const rawTimeout = shaped.timeoutMs

  let timeoutMs = BOARD_DEFAULT_TIMEOUT_MS
  if (rawTimeout !== undefined && rawTimeout !== null && rawTimeout !== '') {
    const value = Number(rawTimeout)
    if (!Number.isFinite(value)) {
      return { ...fallback, error: { code: 'invalid-timeout', message: 'config.board.timeoutMs 必须是数字（毫秒）' } }
    }
    timeoutMs = Math.min(BOARD_MAX_TIMEOUT_MS, Math.max(BOARD_MIN_TIMEOUT_MS, Math.round(value)))
  }

  if (rawToken !== undefined && rawToken !== null && typeof rawToken !== 'string') {
    return { ...fallback, timeoutMs, error: { code: 'invalid-token', message: 'config.board.token 必须是字符串（可省略）' } }
  }
  const token = typeof rawToken === 'string' ? rawToken.trim() : ''

  if (rawEndpoint === '') {
    return {
      ...fallback,
      timeoutMs,
      token,
      error: { code: 'board-not-configured', message: '未配置共享板：profile 里给 dsh-html-panel 加 config.board.endpoint' },
    }
  }

  let url
  try {
    url = new URL(rawEndpoint)
  } catch {
    return { ...fallback, timeoutMs, token, error: { code: 'invalid-endpoint', message: 'config.board.endpoint 不是合法 URL' } }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ...fallback, timeoutMs, token, error: { code: 'invalid-endpoint', message: 'config.board.endpoint 只支持 http/https' } }
  }

  // 请求基址：丢掉 userinfo / query / fragment，保留可能存在的路径前缀。
  // 为什么要丢 userinfo：Node 的 fetch 直接拒绝带凭据的 URL；而且 token 走请求头，
  // 不该出现在 URL 里。`source.origin` 只报 scheme + host[:port]。
  const pathPrefix = url.pathname.replace(/\/+$/, '')
  return {
    configured: true,
    requestBase: `${url.protocol}//${url.host}${pathPrefix}`,
    origin: `${url.protocol}//${url.host}`,
    token,
    timeoutMs,
    error: null,
  }
}

/** 错误码只留安全字符，防止板服务回一个奇形怪状的字符串进页面。 */
function sanitizeCode(code) {
  return String(code).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 48) || 'error'
}

/** 错误文本脱敏：绝不回显 token；同时截断，避免把整段响应塞进页面。 */
function sanitizeMessage(config, message) {
  let text = String(message === null || message === undefined ? '未知错误' : message)
  if (config.token !== '') text = text.split(config.token).join('<redacted>')
  return text.slice(0, 240)
}

/** 把任意错误变成结构化 `{ code, message }`；未知错误只给一句人话，不带原始 stack。 */
function toPublicError(config, error) {
  if (error instanceof BoardFailure) {
    return { code: sanitizeCode(error.code), message: sanitizeMessage(config, error.message) }
  }
  return { code: 'unexpected', message: `读取共享板失败：${config.origin || '未知来源'}` }
}

/**
 * 打一条板服务 JSON 路由。
 * @param {ReturnType<typeof readBoardConfig>} config
 * @param {string} path 以 `/` 开头的路径（可带 query）
 * @returns {Promise<object>} 解析后的 JSON 对象（已确认 `ok === true`）
 */
async function requestJson(config, path) {
  const url = config.requestBase + path
  const headers = { accept: 'application/json' }
  if (config.token !== '') headers['x-team-token'] = config.token

  let response
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.timeoutMs),
      cache: 'no-store',
    })
  } catch (error) {
    const name = error && error.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new BoardFailure('timeout', `连共享板超时（${config.timeoutMs}ms）：${config.origin}`)
    }
    const cause = error && error.cause
    const code = String((cause && cause.code) || (error && error.code) || 'NETWORK')
    throw new BoardFailure('unreachable', `连不上共享板（${config.origin}）：${code}`)
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    throw new BoardFailure('unreachable', `读取共享板响应失败：${config.origin}`)
  }
  if (text.length > BOARD_MAX_BYTES) {
    throw new BoardFailure('too-large', `共享板响应超过 ${BOARD_MAX_BYTES} 字节：${config.origin}`)
  }

  let parsed = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      if (response.ok) throw new BoardFailure('bad-json', `共享板返回了非 JSON（HTTP ${response.status}）：${config.origin}`)
    }
  }

  // 板服务的统一错误形状：`{ ok: false, error: { code, message } }`
  const structured = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object'
    ? parsed.error
    : null
  if (!response.ok) {
    if (structured && typeof structured.code === 'string' && structured.code !== '') {
      const message = typeof structured.message === 'string' && structured.message !== ''
        ? structured.message
        : `共享板返回错误（HTTP ${response.status}）`
      throw new BoardFailure('board-' + sanitizeCode(structured.code), message)
    }
    if (response.status === 401) {
      throw new BoardFailure('http-401', '共享板拒绝访问（HTTP 401）：检查 config.board.token 是否与 dsh-team-mesh 的 boardToken 一致')
    }
    if (response.status === 403) {
      throw new BoardFailure('http-403', '共享板拒绝访问（HTTP 403）：token 权限不足')
    }
    throw new BoardFailure('http-' + response.status, `共享板返回 HTTP ${response.status}：${config.origin}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new BoardFailure('bad-json', `共享板返回空响应或非 JSON：${config.origin}`)
  }
  if (parsed.ok !== true) {
    const code = structured && typeof structured.code === 'string' ? structured.code : 'not-ok'
    const message = structured && typeof structured.message === 'string' && structured.message !== ''
      ? structured.message
      : '共享板返回 ok:false'
    throw new BoardFailure('board-' + sanitizeCode(code), message)
  }
  return parsed
}

/** 只把字符串/数字放进 health 字段，别的类型一律 null（不猜）。 */
function pickScalar(value) {
  if (typeof value === 'string') return value.slice(0, 120)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/** 查一个任务的证据条数；失败给 null（页面显示「证据 —」，不编 0）。 */
async function readEvidenceCount(config, taskId) {
  if (typeof taskId !== 'string' || taskId === '') return null
  const payload = await requestJson(config, `/task/evidence?taskId=${encodeURIComponent(taskId)}`)
  return Array.isArray(payload.evidence) ? payload.evidence.length : null
}

/** 组一个"已配置但读失败"的响应体（health 可能是已经读到的部分）。 */
function failureBody(config, now, error, health = null, official = null) {
  return {
    generatedAt: new Date(now).toISOString(),
    configured: true,
    source: { origin: config.origin },
    health,
    tasks: [],
    events: [],
    official: official === null ? readOfficialBoard({}) : official,
    cached: false,
    error: toPublicError(config, error),
  }
}

/**
 * 真的去读一次板（不做缓存）。
 *
 * 顺序：先 `/health`（探活 + 延迟），再并行 `/task/list` + `/events`，最后逐任务补证据条数。
 * health 或任务/事件失败 → 结构化错误体（`configured: true` + `error`），页面据此兜底。
 * @param {ReturnType<typeof readBoardConfig>} config
 * @param {number} now 生成时刻（毫秒）
 * @param {{sessions?:Function|object, projections?:Function|object}} [deps] 官方投影的 Host 服务（getter 或对象）
 * @returns {Promise<object>} `/api/board` 的响应体
 */
export async function readBoard(config, now = Date.now(), deps = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const generatedAt = new Date(at).toISOString()
  // 官方任务板跟共享板是两条独立数据源：共享板连不上时官方投影仍要照常给（反之亦然）。
  const official = readOfficialBoard(deps)
  if (!config || !config.configured) {
    return {
      generatedAt,
      configured: false,
      source: null,
      health: null,
      tasks: [],
      events: [],
      official,
      cached: false,
      error: config && config.error
        ? { code: sanitizeCode(config.error.code), message: sanitizeMessage(config, config.error.message) }
        : { code: 'board-not-configured', message: '未配置共享板' },
    }
  }

  let health
  const healthStarted = Date.now()
  try {
    const payload = await requestJson(config, '/health')
    health = {
      ok: payload.ok === true,
      latencyMs: Math.max(0, Date.now() - healthStarted),
      service: pickScalar(payload.service),
      version: pickScalar(payload.version),
      schema_version: pickScalar(payload.schema_version),
    }
  } catch (error) {
    return failureBody(config, at, error, null, official)
  }

  let tasksPayload
  let eventsPayload
  try {
    ;[tasksPayload, eventsPayload] = await Promise.all([
      requestJson(config, `/task/list?limit=${BOARD_TASK_LIMIT}`),
      requestJson(config, `/events?limit=${BOARD_EVENT_LIMIT}`),
    ])
  } catch (error) {
    return failureBody(config, at, error, health, official)
  }
  if (!Array.isArray(tasksPayload.tasks)) {
    return failureBody(config, at, new BoardFailure('bad-shape', '共享板 /task/list 响应缺 tasks 数组'), health, official)
  }
  if (!Array.isArray(eventsPayload.events)) {
    return failureBody(config, at, new BoardFailure('bad-shape', '共享板 /events 响应缺 events 数组'), health, official)
  }

  const rows = tasksPayload.tasks.slice(0, BOARD_TASK_LIMIT)
  // 证据条数逐任务查：/task/list 没有这个数字。查不到就给 null，不影响任务列表。
  const evidenceCounts = await Promise.all(rows.map((row) => {
    const taskId = row && typeof row === 'object' && typeof row.task_id === 'string' ? row.task_id : ''
    return readEvidenceCount(config, taskId).catch(() => null)
  }))

  const taskRows = rows.map((row, index) => mapBoardTask(row, at, evidenceCounts[index]))
  // 旧字段原样保留；在此基础上叠加官方 TeamTaskView 字段（ready / writeScopes / source…），
  // 页面旧代码继续读 title/state/owner，新代码读 subject/status/ready。
  const teamViews = projectMeshTasks(taskRows)
  const tasks = taskRows.map((row, index) => Object.assign({}, row, teamViews[index]))
  const events = eventsPayload.events
    .map(toSnapshotEvent)
    .sort((a, b) => ((b.at ?? 0) - (a.at ?? 0)) || ((b.seq ?? 0) - (a.seq ?? 0)))
    .slice(0, BOARD_EVENT_LIMIT)

  return {
    generatedAt,
    configured: true,
    source: { origin: config.origin },
    health,
    tasks,
    events,
    official,
    cached: false,
  }
}

/**
 * 创建一个带 3 秒缓存的板读取器（一个插件实例一个）。
 *
 * 缓存的是**整个响应体**（含错误体）：板不可达时，一个页面里的连续请求也不用每个都
 * 等满超时。命中缓存时响应体的 `generatedAt` 保持原值、并带 `cached: true`。
 * @param {unknown} pluginConfig 插件行 `config`
 * @param {{sessions?:Function|object, projections?:Function|object}} [deps] 官方投影的 Host 服务（getter 或对象）
 * @returns {{config: ReturnType<typeof readBoardConfig>, read: (now?: number) => Promise<object>}}
 */
export function createBoardReader(pluginConfig, deps = {}) {
  const config = readBoardConfig(pluginConfig)
  let cache = null
  let inflight = null
  return {
    config,
    /**
     * @param {number} [now] 读取时刻（毫秒）；测试可注入以控制缓存窗口
     * @returns {Promise<object>} `/api/board` 响应体；永不 reject
     */
    async read(now = Date.now()) {
      const at = Number.isFinite(now) ? now : Date.now()
      if (cache !== null && at >= cache.at && at - cache.at < BOARD_CACHE_MS) {
        return { ...cache.body, cached: true }
      }
      // 单飞：同一时刻被多个路由（api/board 与 0.6.0 的 api/alerts）打进来时只碰板一次。
      if (inflight !== null) return inflight
      inflight = (async () => {
        let body
        try {
          body = await readBoard(config, at, deps)
        } catch (error) {
          body = failureBody(config, at, error)
        }
        cache = { at, body }
        return body
      })()
      try {
        return await inflight
      } finally {
        inflight = null
      }
    },
  }
}
