/**
 * 大管家永续常驻（1.1.0）：三条只读路由的组装逻辑 + 真实的按天归档摘要。
 *
 *   1. `GET api/butler/continuity` —— 常驻会话自续观测：
 *      首次绑定时间 / 最近一次存活 / 重建次数；会话丢失就 `available:false + reason`。
 *      **不写配置**：sessionId 只由已有的「用户点重建」流程写回 cordis.patch.yml。
 *   2. `GET api/butler/digest?days=7&date=YYYY-MM-DD` —— 按天归档摘要：
 *      只从**已有真实来源**（共享板 `api/board`、派活层级 `api/tiers`、告警
 *      `api/alerts`）聚合 `done / dispatched / alerts`；缺数据就 ok:false/source:'unavailable'，
 *      **不编条目、不估算**。同一天重复生成幂等（覆盖写同一份归档）。
 *   3. `GET api/butler/context` —— 上下文预算：
 *      宿主 `ctx.tokenMeter.contextPressure(session)`（token-meter 插件，代码见 app.asar 内
 *      `@deepseek-ai/dsh-token-meter/src/index.ts`）只对**活会话**给真实
 *      `pressureTokens / contextWindow`；压缩次数从会话持久日志的 `compaction/summary` 事件
 *      数出来。拿不到就 `ok:false + source:'unavailable' + reason`，**绝不估算假数字**。
 *
 * 硬约束（与 `lib/butler.js` 同口径）：任何输入都不抛错；原始异常文本不外泄（只给稳定人话）；
 * 本文件不 import 任何写 API（唯一写操作是落盘自己的状态文件，见 `lib/butler-state.js`）。
 */
import { readButlerConfig } from './butler.js'
import {
  CONTINUITY_FILE_NAME, DIGEST_DIR_NAME, STATE_SCHEMA_VERSION, backupCorruptStateFile,
  continuityPathOf, dayWindowOf, digestPathOf, localDateOf, normalizeContinuityRecord,
  readJsonFile, resolveStateRoot, writeJsonAtomic,
} from './butler-state.js'

/* ─────────────────────────── 路由子路径（index.js 复用） ─────────────────────────── */

/** `GET api/butler/continuity` 的子路径。 */
export const BUTLER_CONTINUITY_FILE = 'api/butler/continuity'
/** `GET api/butler/digest` 的子路径。 */
export const BUTLER_DIGEST_FILE = 'api/butler/digest'
/** `GET api/butler/context` 的子路径。 */
export const BUTLER_CONTEXT_FILE = 'api/butler/context'

/** continuity 观测记录的最小写盘间隔：页面 10 秒轮询，不能让 lastSeenAt 每轮都写盘。 */
export const CONTINUITY_PERSIST_INTERVAL_MS = 60000
/** 今天这份 digest 的复用窗口：窗口内直接给归档，不重复打板/告警。 */
export const DIGEST_CACHE_MS = 60000
/** 单份 digest 最多带多少条明细。 */
export const DIGEST_MAX_ITEMS = 50
/** 共享板 `/events` 取满这个条数就认为列表被截断（与 `lib/board.js` 的 BOARD_EVENT_LIMIT 一致）。 */
export const DIGEST_BOARD_EVENT_FULL = 12
/** `days` 默认 / 上限（只做参数收敛与回显，不改变单日语义）。 */
export const DIGEST_DEFAULT_DAYS = 7
export const DIGEST_MAX_DAYS = 31
/** context 路由扫会话日志的上限：超过就如实说扫不完，不截断着报数。 */
export const CONTEXT_SCAN_MAX_EVENTS = 50000
/** context 路由的会话列表等待上限（与 butler M0 的 list 超时同量级）。 */
const CONTEXT_LIST_TIMEOUT_MS = 5000

/** 从 getter/对象取 Host 服务；抛错或缺失一律 null。 */
function serviceOf(deps, name) {
  try {
    const value = deps ? deps[name] : undefined
    const service = typeof value === 'function' ? value() : value
    return service && typeof service === 'object' ? service : null
  } catch {
    return null
  }
}

/** 当前时刻（测试可注入 now()）。 */
function nowOf(deps) {
  const raw = typeof deps.now === 'function' ? deps.now() : deps.now
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : Date.now()
}

/** 毫秒 → ISO；非法值 null。 */
function isoAt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null
}

/** 外部字符串截断（不把异常长文本塞进响应）。 */
function tex(value, max = 120) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** 读 butler reader（getter 或对象）；缺失 null。 */
function readerOf(deps) {
  const reader = typeof deps.reader === 'function' ? (() => {
    try {
      return deps.reader()
    } catch {
      return null
    }
  })() : deps.reader
  return reader && typeof reader.readSessions === 'function' ? reader : null
}

/** 状态根：调用方给 root（测试/多 profile），否则按 $DSH_HOME 推导。 */
function rootOf(deps) {
  return typeof deps.root === 'string' && deps.root !== '' ? deps.root : resolveStateRoot()
}

/* =====================================================================
 * 1) continuity：常驻会话自续
 * ===================================================================== */

/**
 * 组装 `GET api/butler/continuity` 的响应体。
 *
 * 只有「观测」写盘：`continuity.json` 记 firstBoundAt / lastSeenAt / rebuildCount。
 * sessionId 变了（说明走过重建）→ rebuildCount + 1，首次绑定时间按新会话的创建时间重算；
 * **配置一个字节都不碰**。
 *
 * @param {object} [deps]
 * @param {() => (object|null)} [deps.reader] 返回 butler reader（`readSessions()`）
 * @param {unknown} [deps.config] 插件行 config（读 `butler` 段）
 * @param {string} [deps.root] 状态根（缺省按 DSH_HOME 推导）
 * @param {() => number} [deps.now] 当前时刻（测试注入）
 * @param {object} [deps.fsDeps] 测试注入的 fs（readFile/writeFile/mkdir/rename/unlink）
 * @returns {Promise<object>} 契约字段齐全；永不 reject
 */
export async function buildButlerContinuity(deps = {}) {
  const now = nowOf(deps)
  const config = readButlerConfig(deps.config)
  const root = rootOf(deps)
  const statePath = continuityPathOf(root)
  const fsDeps = deps.fsDeps && typeof deps.fsDeps === 'object' ? deps.fsDeps : {}

  const previousRead = await readJsonFile(statePath, fsDeps)
  const previous = normalizeContinuityRecord(previousRead.ok === true ? previousRead.value : null)

  /* ---- 活会话清单（与 api/butler/sessions 共用同一份 4 s 缓存，不另开网络） ---- */
  let sessionsBody = null
  let liveReason = ''
  const reader = readerOf(deps)
  if (reader === null) {
    liveReason = 'DSH 没有可用的会话读取器：无法确认常驻会话是否存活'
  } else {
    try {
      sessionsBody = await reader.readSessions()
    } catch {
      liveReason = '会话清单读取失败（详见 DSH 宿主日志）'
    }
  }
  const binding = sessionsBody && sessionsBody.binding && typeof sessionsBody.binding === 'object'
    ? sessionsBody.binding
    : null
  const nodes = sessionsBody && Array.isArray(sessionsBody.nodes) ? sessionsBody.nodes : []
  const pinned = config.sessionId
  const node = pinned === '' ? null : (nodes.find(row => row && row.id === pinned) || null)

  const available = pinned !== '' && node !== null
  let reason = null
  if (!available) {
    if (pinned === '') {
      reason = config.targetMode === 'pinned'
        ? '尚未创建专属大管家会话（config.butler.sessionId 为空）：用「创建专属会话」按配置的预设建一个'
        : '配置没有绑定专属大管家会话（config.butler.sessionId 为空）：continuity 只能按 live 清单观测'
      if (binding && typeof binding.reason === 'string' && binding.reason !== '') reason = binding.reason
    } else if (sessionsBody === null) {
      reason = liveReason
    } else {
      reason = binding && typeof binding.reason === 'string' && binding.reason !== ''
        ? binding.reason
        : 'config.butler.sessionId 指向的专属大管家会话不在可见会话列表里（可能已归档或删除）：请用「重建专属会话」，或改配置'
    }
  }
  const title = (binding && typeof binding.title === 'string' && binding.title !== '' ? binding.title : '')
    || (node && typeof node.title === 'string' ? node.title : '')
    || '大管家 · 常驻'

  /* ---- 观测记录推进（只在值发生变化/到写盘间隔时落盘） ---- */
  const record = { ...previous }
  const startedAt = node && typeof node.startedAt === 'string' ? Date.parse(node.startedAt) : Number.NaN
  const sessionStartedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null
  if (pinned !== '' && previous.sessionId !== pinned) {
    // sessionId 变了 = 走过「重建」流程（页面 POST api/butler/session 写回配置后，
    // 本进程的内存 config 也被原地更新）。旧会话的绑定时间不能沿用到新会话；
    // 新会话此刻不可见时 firstBoundAt/lastSeenAt 一律给 null——没观测到就不编时间。
    if (previous.sessionId !== '') record.rebuildCount = previous.rebuildCount + 1
    record.sessionId = pinned
    record.firstBoundAt = available ? (sessionStartedAt ?? now) : null
    record.lastSeenAt = available ? now : null
  }
  if (available) {
    if (record.firstBoundAt === null) record.firstBoundAt = sessionStartedAt ?? now
    if (record.lastSeenAt === null || now - record.lastSeenAt >= CONTINUITY_PERSIST_INTERVAL_MS) record.lastSeenAt = now
  }
  record.label = config.label
  record.title = title
  record.schemaVersion = STATE_SCHEMA_VERSION
  const changed = JSON.stringify(record) !== JSON.stringify(previous)
  let writeResult = { ok: true }
  let stateBackup = null
  if (changed) {
    // 红线口径：要覆盖一份读不懂的状态文件时，先留同目录带时间戳的备份（正常写盘是原子替换，不留备份）。
    if (previousRead.code === 'corrupt') {
      stateBackup = await backupCorruptStateFile(statePath, 'corrupt', now, fsDeps)
    }
    writeResult = await writeJsonAtomic(statePath, record, fsDeps)
  }

  const firstBoundAt = record.firstBoundAt
  const lastSeenAt = record.lastSeenAt
  const parts = []
  parts.push(sessionsBody !== null ? 'sessionController.list' : 'session.unavailable')
  if (previousRead.ok === true) parts.push(CONTINUITY_FILE_NAME)
  else if (previousRead.code === 'missing') parts.push(CONTINUITY_FILE_NAME + (writeResult.ok ? '(new)' : '(missing)'))
  else parts.push(CONTINUITY_FILE_NAME + '(' + previousRead.code + ')' + (writeResult.ok ? '→rewritten' : ''))
  if (changed && writeResult.ok === false) parts.push('state-write-failed')

  return {
    ok: true,
    sessionId: pinned === '' ? null : pinned,
    title,
    available,
    reason,
    firstBoundAt: firstBoundAt ?? null,
    lastSeenAt: lastSeenAt ?? null,
    uptimeMs: firstBoundAt !== null ? Math.max(0, now - firstBoundAt) : null,
    rebuildCount: record.rebuildCount,
    source: parts.join('+'),
    label: config.label,
    // 附加字段（页面可忽略）：state 记录来自哪个文件、是否观察到过重建
    statePath,
    stateReadable: previousRead.ok === true,
    stateWritable: writeResult.ok === true,
    ...(stateBackup === null ? {} : { stateBackup }),
    ...(writeResult.ok === false ? { stateError: writeResult.reason } : {}),
  }
}

/** continuity 整体不可用时的兜底响应体：契约字段都在，原因如实写。 */
export function fallbackButlerContinuity(reason, now = Date.now()) {
  return {
    ok: false,
    sessionId: null,
    title: null,
    available: false,
    reason: reason || '常驻会话观测失败',
    firstBoundAt: null,
    lastSeenAt: null,
    uptimeMs: null,
    rebuildCount: 0,
    source: 'unavailable',
    statePath: null,
    stateReadable: false,
    stateWritable: false,
    generatedAt: isoAt(now),
  }
}

/* =====================================================================
 * 2) digest：按天归档摘要
 * ===================================================================== */

/** 收敛 query（URLSearchParams / 普通对象均可）。 */
function readDigestQuery(query) {
  const params = query && typeof query.get === 'function' ? query : null
  const raw = name => {
    if (params !== null) return params.get(name) ?? ''
    if (query && typeof query === 'object' && typeof query[name] === 'string') return query[name]
    return ''
  }
  const dateText = raw('date').trim()
  const daysRaw = Number.parseInt(raw('days'), 10)
  const days = Number.isFinite(daysRaw) && daysRaw >= 1
    ? Math.min(DIGEST_MAX_DAYS, daysRaw)
    : DIGEST_DEFAULT_DAYS
  return { dateText, days }
}

/** 明细条目：字段只用 `{kind,text,at}`，at 保持毫秒时间戳。 */
function digestItem(kind, text, at) {
  const item = { kind: tex(kind, 60) || 'event', text: tex(text, 240), at: null }
  if (typeof at === 'number' && Number.isFinite(at)) item.at = Math.round(at)
  return item
}

/** 共享板事件 → 当天条目（只收落在当天窗口里的事件）。 */
function boardWindowItems(body, window) {
  const items = []
  if (!body || !Array.isArray(body.events)) return items
  for (const event of body.events) {
    if (!event || typeof event !== 'object') continue
    if (typeof event.at !== 'number' || !Number.isFinite(event.at)) continue
    if (event.at < window.start || event.at >= window.end) continue
    const text = tex(event.text, 240) || (event.task ? '任务 ' + tex(event.task, 40) : '')
    items.push(digestItem(tex(event.kind, 60) || 'board-event', text, event.at))
    if (items.length >= DIGEST_MAX_ITEMS) break
  }
  return items
}

/** 层级快照里的子代理派发 → 当天条目（共享板不可用时的独立来源）。 */
function tierWindowItems(body, window) {
  const items = []
  if (!body || !Array.isArray(body.nodes)) return items
  for (const node of body.nodes) {
    if (!node || typeof node !== 'object' || typeof node.startedAt !== 'string') continue
    if (!(node.tier >= 2)) continue
    const at = Date.parse(node.startedAt)
    if (!Number.isFinite(at) || at < window.start || at >= window.end) continue
    items.push(digestItem('dispatch', '派发子代理 ' + (tex(node.title, 80) || tex(node.id, 40)), at))
    if (items.length >= DIGEST_MAX_ITEMS) break
  }
  return items
}

/** 告警快照 → 当天条目；告警没有逐条时间，只按快照生成时刻归属（只有今天）。 */
function alertWindowItems(body, window) {
  const items = []
  if (!body || !Array.isArray(body.alerts)) return items
  const at = body.generatedAt ? Date.parse(body.generatedAt) : Number.NaN
  if (!Number.isFinite(at) || at < window.start || at >= window.end) return items
  for (const alert of body.alerts) {
    if (!alert || typeof alert !== 'object' || items.length >= DIGEST_MAX_ITEMS) break
    const severity = tex(alert.severity, 12)
    const subject = tex(alert.subject, 80)
    const why = tex(alert.why, 160)
    const text = [severity, subject, why].filter(part => part !== '').join(' · ')
    items.push(digestItem('alert', text, at))
  }
  return items
}

/** 归档文件 → 响应体（读取已归档的那一份）。 */
function bodyOfArchive(archive, days) {
  const counts = archive.counts && typeof archive.counts === 'object' ? archive.counts : {}
  const items = Array.isArray(archive.items) ? archive.items : []
  return {
    ok: archive.ok === true,
    date: archive.date,
    generatedAt: archive.generatedAt,
    source: 'archive',
    counts: {
      done: typeof counts.done === 'number' ? counts.done : null,
      dispatched: typeof counts.dispatched === 'number' ? counts.dispatched : null,
      alerts: typeof counts.alerts === 'number' ? counts.alerts : null,
    },
    items,
    cached: true,
    days,
    ...(archive.coverage ? { coverage: archive.coverage } : {}),
    ...(archive.degraded ? { degraded: archive.degraded } : {}),
  }
}

/**
 * 组装 `GET api/butler/digest?days=7&date=YYYY-MM-DD` 的响应体。
 *
 * 语义（写进 README）：
 *   - `date` 缺省 = 本地今天；`days` 只做参数收敛/回显（1..31），不改变单日语义；
 *   - 今天：从 live 数据源生成，落盘 `digests/<date>.json`；60 秒内复用归档；
 *   - 过去日期：只读归档；没有归档就 `ok:false + source:'unavailable'`
 *     （共享板只保留最近事件，重建过去数据只能靠猜——**不猜**）；
 *   - counts 里某项数据源不可用 = `null`（页面显示「—」），不是 0。
 *
 * @param {object} [deps]
 * @param {{read:Function}} [deps.board] 共享板 reader（`api/board` 同一个,3 s 缓存）
 * @param {{read:Function}} [deps.tiers] 层级 reader（`api/tiers` 同一个,4 s 缓存）
 * @param {{read:Function}} [deps.alerts] 告警 reader（`api/alerts` 同一个,4 s 缓存）
 * @param {string} [deps.root] 状态根
 * @param {() => number} [deps.now] 当前时刻
 * @param {object} [deps.fsDeps] 测试注入 fs
 * @param {URLSearchParams|object} [query] `date` / `days`
 * @returns {Promise<object>} 契约字段齐全；永不 reject
 */
export async function buildButlerDigest(deps = {}, query = {}) {
  const now = nowOf(deps)
  const { dateText, days } = readDigestQuery(query)
  const root = rootOf(deps)
  const fsDeps = deps.fsDeps && typeof deps.fsDeps === 'object' ? deps.fsDeps : {}
  const window = dayWindowOf(dateText === '' ? localDateOf(now) : dateText)
  if (window === null) {
    return fallbackButlerDigest('date 不是合法的 YYYY-MM-DD 日期（例：2026-11-28）', dateText, now, days)
  }
  const today = localDateOf(now)
  const archivePath = digestPathOf(root, window.date)
  const archived = await readJsonFile(archivePath, fsDeps)
  const archive = archived.ok && archived.value && typeof archived.value === 'object' && archived.value.date === window.date
    ? archived.value
    : null

  if (archive !== null && window.date !== today) return bodyOfArchive(archive, days)
  if (archive !== null && window.date === today) {
    const generatedAtMs = archive.generatedAt ? Date.parse(archive.generatedAt) : Number.NaN
    if (Number.isFinite(generatedAtMs) && now >= generatedAtMs && now - generatedAtMs < DIGEST_CACHE_MS) {
      return bodyOfArchive(archive, days)
    }
  }
  if (archive === null && window.date !== today) {
    return {
      ok: false,
      date: window.date,
      generatedAt: isoAt(now),
      source: 'unavailable',
      reason: '该日期没有归档摘要（' + DIGEST_DIR_NAME + '/' + window.date + '.json 不存在）；共享板/告警只保留最近状态，无法按天重建过去数据（不估算）',
      counts: { done: null, dispatched: null, alerts: null },
      items: [],
      days,
    }
  }

  /* ---- live 聚合：共享板 → 层级 → 告警，逐源独立降级 ---- */
  const sources = []
  const degraded = []
  const items = []
  const counts = { done: null, dispatched: null, alerts: null }
  let partial = false

  const board = serviceOf(deps, 'board')
  if (board !== null && typeof board.read === 'function') {
    let body = null
    try {
      body = await board.read(now)
    } catch {
      degraded.push('共享板读取失败：done/dispatched 计数降级为 null')
    }
    if (body !== null && typeof body === 'object' && body.configured === true && body.error === undefined) {
      sources.push('api/board')
      const events = Array.isArray(body.events) ? body.events : []
      const inWindow = events.filter(event => event && typeof event.at === 'number'
        && event.at >= window.start && event.at < window.end)
      counts.done = inWindow.filter(event => event.kind === 'task.done').length
      counts.dispatched = inWindow.filter(event => event.kind === 'task.dispatched').length
      items.push(...boardWindowItems(body, window))
      // 共享板 /events 只保留最近 N 条（`lib/board.js` 的 BOARD_EVENT_LIMIT=12）：
      // 取满上限且最早一条晚于当天 0 点 → 当天更早的事件可能已被裁掉，如实标 partial。
      const earliest = events.reduce((min, event) => {
        const at = event && typeof event.at === 'number' ? event.at : null
        return at !== null && (min === null || at < min) ? at : min
      }, null)
      if (events.length >= DIGEST_BOARD_EVENT_FULL && earliest !== null && earliest > window.start) {
        partial = true
        degraded.push('共享板只保留最近 ' + events.length + ' 条事件（最早 ' + isoAt(earliest) + '），当天计数只覆盖可见事件')
      }
    } else if (body !== null && body.error !== undefined) {
      degraded.push('共享板不可用（' + tex(body.error && body.error.code, 60) + '）：done/dispatched 计数降级')
    }
  } else {
    degraded.push('没有可用的共享板 reader：done/dispatched 计数降级')
  }

  const tiers = serviceOf(deps, 'tiers')
  if (tiers !== null && typeof tiers.read === 'function' && counts.dispatched === null) {
    let tierBody = null
    try {
      tierBody = await tiers.read()
    } catch {
      degraded.push('层级快照读取失败：dispatched 计数仍不可用')
    }
    if (tierBody !== null && typeof tierBody === 'object' && Array.isArray(tierBody.nodes)) {
      const tierItems = tierWindowItems(tierBody, window)
      if (tierItems.length > 0 || tierBody.nodes.length > 0) {
        sources.push('api/tiers')
        counts.dispatched = tierItems.length
        items.push(...tierItems)
      }
    }
  }

  const alerts = serviceOf(deps, 'alerts')
  if (alerts !== null && typeof alerts.read === 'function') {
    let alertBody = null
    try {
      alertBody = await alerts.read()
    } catch {
      degraded.push('告警读取失败：alerts 计数降级为 null')
    }
    if (alertBody !== null && typeof alertBody === 'object' && Array.isArray(alertBody.alerts)) {
      const alertItems = alertWindowItems(alertBody, window)
      const alertsAt = alertBody.generatedAt ? Date.parse(alertBody.generatedAt) : Number.NaN
      const coversWindow = Number.isFinite(alertsAt) && alertsAt >= window.start && alertsAt < window.end
      if (coversWindow) {
        sources.push('api/alerts')
        counts.alerts = alertItems.length
        items.push(...alertItems)
      } else {
        degraded.push('告警快照不在该日期窗口内（告警没有历史归档）：alerts 计数降级为 null')
      }
    }
  } else {
    degraded.push('没有可用的告警 reader：alerts 计数降级为 null')
  }

  const ok = sources.length > 0
  items.sort((left, right) => {
    const leftAt = typeof left.at === 'number' ? left.at : 0
    const rightAt = typeof right.at === 'number' ? right.at : 0
    return rightAt - leftAt
  })
  const trimmedItems = items.slice(0, DIGEST_MAX_ITEMS)
  const sourceText = ok ? sources.join('+') : 'unavailable'
  const generatedAt = isoAt(now)
  const archiveBody = {
    schemaVersion: STATE_SCHEMA_VERSION,
    ok,
    date: window.date,
    generatedAt,
    source: sourceText,
    counts,
    items: trimmedItems,
    coverage: partial ? 'partial' : 'full',
    ...(degraded.length > 0 ? { degraded: { reasons: [...new Set(degraded)] } } : {}),
  }
  let archivedOk = false
  let archiveError = ''
  if (ok) {
    const written = await writeJsonAtomic(archivePath, archiveBody, fsDeps)
    archivedOk = written.ok === true
    if (written.ok !== true) archiveError = written.reason || '状态写盘失败'
  }
  return {
    ok,
    date: window.date,
    generatedAt,
    source: sourceText,
    ...(ok ? {} : { reason: '数据源都不可用：共享板 / 层级 / 告警都读不到（不估算）' }),
    counts,
    items: trimmedItems,
    days,
    cached: false,
    coverage: partial ? 'partial' : 'full',
    archived: archivedOk,
    ...(archiveError !== '' ? { archiveError } : {}),
    ...(degraded.length > 0 ? { degraded: { reasons: [...new Set(degraded)] } } : {}),
  }
}

/** digest 整体不可用时的兜底响应体：契约字段都在。 */
export function fallbackButlerDigest(reason, date = '', now = Date.now(), days = DIGEST_DEFAULT_DAYS) {
  return {
    ok: false,
    date: typeof date === 'string' && date !== '' ? date : localDateOf(now),
    generatedAt: isoAt(now),
    source: 'unavailable',
    reason: reason || '按天摘要生成失败',
    counts: { done: null, dispatched: null, alerts: null },
    items: [],
    days,
  }
}

/* =====================================================================
 * 3) context：上下文预算（真实数字，拿不到就降级）
 * ===================================================================== */

/**
 * 数一个活会话持久日志里的压缩事件。
 *
 * 宿主契约（app.asar 内 `@deepseek-ai/dsh-compaction-basic/src/region.ts`）：
 * 每次成功压缩追加一条 `compaction/summary`（失败只有 `compaction/start` + 带 error 的
 * `compaction/end`），另有 `compaction/prune`。这里 **count 只数成功的 summary**，
 * lastAt 取任意 compaction/* 事件的最晚时间。
 * @param {object} session 活 Session（`seq` / `eventAt(i)`）
 * @returns {{count:number|null, lastAt:number|null, reason:string|null}} 事件数超上限时 count=null
 */
export function countCompactions(session) {
  const total = typeof session.seq === 'number' && Number.isFinite(session.seq) ? Math.floor(session.seq) : null
  if (total === null || total < 0) return { count: null, lastAt: null, reason: '会话日志序列不可用，压缩次数读不到' }
  if (typeof session.eventAt !== 'function') return { count: null, lastAt: null, reason: '会话没有 eventAt：压缩次数读不到' }
  if (total > CONTEXT_SCAN_MAX_EVENTS) {
    return {
      count: null,
      lastAt: null,
      reason: '会话事件 ' + total + ' 条超过扫描上限 ' + CONTEXT_SCAN_MAX_EVENTS + '：压缩次数降级为 null',
    }
  }
  let count = 0
  let lastAt = null
  for (let index = 0; index < total; index += 1) {
    const event = session.eventAt(index)
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'compaction/summary') count += 1
    if (event.type.startsWith('compaction/') && typeof event.time === 'number' && Number.isFinite(event.time)) {
      if (lastAt === null || event.time > lastAt) lastAt = event.time
    }
  }
  return { count, lastAt, reason: null }
}

/** 从 `ctx.sessions.list()` 里找活会话对象。 */
function liveSessionOf(sessionsService, sessionId) {
  if (!sessionsService || typeof sessionsService.list !== 'function' || sessionId === '') return null
  let list
  try {
    list = sessionsService.list()
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  for (const session of list) {
    if (session && typeof session.id === 'string' && session.id === sessionId) return session
  }
  return null
}

/**
 * 组装 `GET api/butler/context` 的响应体。
 *
 * 数据来源（都来自宿主已有服务，**不估算**）：
 *   - `used`   = `ctx.tokenMeter.contextPressure(session).pressureTokens`（提供方上报的最新
 *                提示词规模；token-meter 回放持久日志，无模型调用）
 *   - `limit`  = 同一次调用的 `contextWindow`（最新 `request/context` 记录里的路由容量）
 *   - `percent`= used / limit（一位小数）
 *   - `compactions.count / lastAt` = 会话持久日志里的 `compaction/summary` 条数 / 最近时间
 *
 * 冷会话（`ctx.sessions.list()` 里没有）宿主不给 contextPressure 投影 → ok:false + reason；
 * token-meter 未挂载同样降级。**绝不拿字符数估算 token**。
 *
 * @param {object} [deps]
 * @param {() => (object|null)} [deps.reader] butler reader
 * @param {() => unknown} [deps.sessions] `ctx.sessions` getter
 * @param {() => unknown} [deps.tokenMeter] `ctx.tokenMeter` getter
 * @param {() => number} [deps.now] 当前时刻
 * @returns {Promise<object>} 契约字段齐全；永不 reject
 */
export async function buildButlerContext(deps = {}) {
  const now = nowOf(deps)
  const reader = readerOf(deps)
  if (reader === null) {
    return fallbackButlerContext('DSH 没有可用的会话读取器：无法确定上下文属于哪个会话')
  }
  let sessionsBody = null
  try {
    sessionsBody = await reader.readSessions()
  } catch {
    return fallbackButlerContext('会话清单读取失败（详见 DSH 宿主日志）：无法确定上下文属于哪个会话')
  }
  const binding = sessionsBody && sessionsBody.binding && typeof sessionsBody.binding === 'object'
    ? sessionsBody.binding
    : null
  if (!binding || binding.available !== true || typeof binding.sessionId !== 'string' || binding.sessionId === '') {
    return fallbackButlerContext(binding && typeof binding.reason === 'string' && binding.reason !== ''
      ? binding.reason
      : '没有可用的会话绑定：无法读上下文占用')
  }
  const sessionId = binding.sessionId
  const session = liveSessionOf(serviceOf(deps, 'sessions'), sessionId)
  if (session === null) {
    return {
      ok: false,
      used: null,
      limit: null,
      percent: null,
      compactions: { count: null, lastAt: null },
      source: 'unavailable',
      sessionId,
      generatedAt: isoAt(now),
      reason: '绑定的专属会话当前不是活会话（冷会话/未激活）：DSH 只对活会话提供 tokenMeter 上下文投影；拒绝估算假数字',
    }
  }

  const compactionScan = countCompactions(session)
  const compactions = { count: compactionScan.count, lastAt: compactionScan.lastAt }
  const energyReasons = []
  if (compactionScan.reason !== null) energyReasons.push(compactionScan.reason)

  const meter = serviceOf(deps, 'tokenMeter')
  if (meter === null || typeof meter.contextPressure !== 'function') {
    return {
      ok: false,
      used: null,
      limit: null,
      percent: null,
      compactions,
      source: 'unavailable',
      sessionId,
      generatedAt: isoAt(now),
      reason: 'DSH 没有可用的 tokenMeter 服务（token-meter 未挂载）：宿主不提供真实上下文占用，拒绝估算',
      ...(energyReasons.length > 0 ? { degraded: { reasons: energyReasons } } : {}),
    }
  }
  let pressure = null
  try {
    pressure = meter.contextPressure(session)
  } catch {
    pressure = null
  }
  const used = pressure && typeof pressure.pressureTokens === 'number' && Number.isFinite(pressure.pressureTokens)
    && pressure.pressureTokens >= 0 ? Math.round(pressure.pressureTokens) : null
  const limit = pressure && typeof pressure.contextWindow === 'number' && Number.isFinite(pressure.contextWindow)
    && pressure.contextWindow > 0 ? Math.round(pressure.contextWindow) : null
  const percent = used !== null && limit !== null ? Math.round((used / limit) * 1000) / 10 : null
  const ok = used !== null && limit !== null
  const reasons = [...energyReasons]
  if (used === null) reasons.push('tokenMeter 没有提供方上报的上下文占用（会话还没产生过请求）：used 降级为 null')
  if (limit === null) reasons.push('tokenMeter 没有 contextWindow（路由没有声明模型容量）：limit 降级为 null')
  return {
    ok,
    used,
    limit,
    percent,
    compactions,
    source: ok ? 'tokenMeter.contextPressure+session-log' : 'tokenMeter.contextPressure(partial)',
    sessionId,
    title: typeof binding.title === 'string' ? binding.title : null,
    generatedAt: isoAt(now),
    ...(ok ? {} : { reason: reasons.join('；') }),
    ...(reasons.length > 0 ? { degraded: { reasons } } : {}),
  }
}

/** context 整体不可用时的兜底响应体：契约字段都在，原因如实写。 */
export function fallbackButlerContext(reason, now = Date.now()) {
  return {
    ok: false,
    used: null,
    limit: null,
    percent: null,
    compactions: { count: null, lastAt: null },
    source: 'unavailable',
    sessionId: null,
    generatedAt: isoAt(now),
    reason: reason || '上下文预算读取失败',
  }
}
