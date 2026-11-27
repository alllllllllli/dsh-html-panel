/**
 * 0.9.0：中栏对话的实时增量（只读、瞬时）。
 *
 * 数据源（官方事件，面板只读监听，不跑模型、不写任何东西）：
 *   - `ctx.on('agent/assistant-stream', …, {global:true})`：token 增量帧
 *     （`start` / `chunk` / `end`），帧不进 session log，进程重启即丢；
 *   - `ctx.on('session/event')`：durable 事件通知，只发 `{seq,type}` 让页面立刻拉一次
 *     `api/butler/dialog`（内容永远以 durable 轮询为唯一事实源）。
 *
 * 设计要点（照调研报告 §5-B1/B4/B7，抄语义不抄代码）：
 *   - 按 `agent.session.id` 过滤并**不排除子代理**（页面选中子代理时也要能流）；
 *   - 帧折叠：`revision` 连续才接受、跳号/形状异常一律 `reset` 且**绝不 throw**；
 *   - 40–60ms 合批（默认 50ms），单 session 未 flush 上限 64KB，超限关掉该连接；
 *   - SSE handler 自己拥有响应生命周期、15s `: ping`、30 分钟空闲关闭、
 *     每 session ≤2 / 全局 ≤8 条连接；
 *   - 只读 GET，Host/Origin 回环 fence，**不接受也不产生写 token**。
 *
 * 零外部依赖、零 `@deepseek-ai/*` import（宿主插件运行时解析不到那些包）。
 */

/** 0.9.0：SSE 路由相对路径（index.js 拼上 ROUTE_PREFIX）。 */
export const BUTLER_STREAM_FILE = 'api/butler/dialog/stream'
/** SSE 自动重连间隔（写进首帧 `retry:`）。 */
export const STREAM_RETRY_MS = 3000
/** 心跳间隔。 */
export const STREAM_PING_MS = 15000
/** 文本合批窗口。 */
export const STREAM_BATCH_MS = 50
/** 单 session 未 flush 上限（字节）。 */
export const STREAM_MAX_PENDING_BYTES = 64 * 1024
/** 连接空闲上限。 */
export const STREAM_IDLE_MS = 30 * 60 * 1000
/** 连接上限：每 session / 全局。 */
export const STREAM_MAX_PER_SESSION = 2
export const STREAM_MAX_TOTAL = 8
/** 同一 session 的 durable tick 去重窗口。 */
export const STREAM_TICK_DEDUPE_MS = 100
/** 内存里最多跟踪多少个 session 的 attempt（防 map 无限增长）。 */
export const STREAM_MAX_ATTEMPTS = 256

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 安全读一个字符串字段。 */
function textOf(value, max = 160) {
  return typeof value === 'string' ? (value.length > max ? value.slice(0, max) : value) : ''
}

/** 读请求头里可能为数组/缺失的值。 */
function headerOf(req, name) {
  const raw = req && req.headers ? req.headers[name] : undefined
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : ''
  return typeof raw === 'string' ? raw : ''
}

/**
 * SSE 只读路由的 Host/Origin fence（照调研报告 §3 的先例思路）。
 *
 * 只允许回环 Host；`sec-fetch-site: cross-site` 直接拒绝；有 Origin 时必须与 Host 同源且同为回环。
 * 不带 Origin 的非浏览器请求（curl/测试）允许——它们不是跨站浏览器请求。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|undefined} 拒绝原因；undefined 表示通过。
 */
export function streamFence(req) {
  const site = headerOf(req, 'sec-fetch-site').toLowerCase()
  if (site === 'cross-site') return '拒绝跨站来源（sec-fetch-site: cross-site）'
  const hostRaw = headerOf(req, 'host').trim()
  if (hostRaw === '') return '缺少 Host 头：SSE 只接受本机回环请求'
  let host
  try {
    host = new URL('http://' + hostRaw).hostname.toLowerCase()
  } catch {
    return 'Host 头不是合法主机名'
  }
  if (!LOOPBACK_HOSTS.has(host)) return '只允许回环 Host（本机面板）'
  const originRaw = headerOf(req, 'origin').trim()
  if (originRaw !== '') {
    let origin
    try {
      origin = new URL(originRaw)
    } catch {
      return 'Origin 不是合法 URL'
    }
    if (origin.host !== hostRaw) return '拒绝跨站来源（Origin 与 Host 不一致）'
    if (!LOOPBACK_HOSTS.has(origin.hostname.toLowerCase())) return '只允许回环 Origin（本机面板）'
  }
  return undefined
}

/** 帧里的 chunk 文本（不认识的形状返回空串，不猜）。 */
function chunkTextOf(chunk) {
  if (!chunk || typeof chunk !== 'object') return { text: '', thinking: '', replaceText: null, replaceThinking: null }
  if (chunk.type === 'text-delta') return { text: textOf(chunk.text, STREAM_MAX_PENDING_BYTES), thinking: '', replaceText: null, replaceThinking: null }
  if (chunk.type === 'reasoning-delta') return { text: '', thinking: textOf(chunk.text, STREAM_MAX_PENDING_BYTES), replaceText: null, replaceThinking: null }
  if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
    const blockType = chunk.block.type
    if (blockType === 'text' && typeof chunk.block.text === 'string') {
      return { text: '', thinking: '', replaceText: chunk.block.text, replaceThinking: null }
    }
    if (blockType === 'reasoning' && typeof chunk.block.text === 'string') {
      return { text: '', thinking: '', replaceText: null, replaceThinking: chunk.block.text }
    }
  }
  return { text: '', thinking: '', replaceText: null, replaceThinking: null }
}

/** 把 outcome 收敛成页面可读的小对象（committed 带 seq）。 */
function outcomeOf(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.kind === 'committed' || raw.type === 'committed') {
      const seq = Number.isFinite(raw.seq) ? raw.seq : null
      return { kind: 'committed', ...(seq === null ? {} : { seq }) }
    }
    const kind = textOf(raw.kind ?? raw.type, 40) || 'unknown'
    return { kind }
  }
  const kind = textOf(raw, 40) || 'unknown'
  return { kind }
}

/**
 * 创建 assistant-stream 聚合 hub：进程内累积每个 session 的当前 attempt 并广播给 SSE 连接。
 *
 * @param {object} options
 * @param {object} options.ctx Host context（需要 `ctx.on`；缺失时只做纯聚合，便于单测）。
 * @param {object} [options.logger] 宿主 logger（warn 用）。
 * @param {() => number} [options.now]
 * @param {{setTimeout:Function, clearTimeout:Function}} [options.timers]
 * @param {{batchMs?:number, maxPendingBytes?:number, tickDedupeMs?:number, maxAttempts?:number}} [options.options]
 * @returns {object} hub
 */
export function createButlerLiveHub({ ctx, logger, now = () => Date.now(), timers, options } = {}) {
  const shape = options && typeof options === 'object' ? options : {}
  const batchMs = Number.isFinite(shape.batchMs) && shape.batchMs >= 0 ? shape.batchMs : STREAM_BATCH_MS
  const maxPendingBytes = Number.isFinite(shape.maxPendingBytes) && shape.maxPendingBytes > 0 ? shape.maxPendingBytes : STREAM_MAX_PENDING_BYTES
  const tickDedupeMs = Number.isFinite(shape.tickDedupeMs) && shape.tickDedupeMs >= 0 ? shape.tickDedupeMs : STREAM_TICK_DEDUPE_MS
  const maxAttempts = Number.isFinite(shape.maxAttempts) && shape.maxAttempts > 0 ? shape.maxAttempts : STREAM_MAX_ATTEMPTS
  const setTimer = timers && typeof timers.setTimeout === 'function' ? timers.setTimeout : setTimeout
  const clearTimer = timers && typeof timers.clearTimeout === 'function' ? timers.clearTimeout : clearTimeout
  const nowOf = typeof now === 'function' ? now : () => Date.now()

  /** sessionId -> attempt */
  const attempts = new Map()
  /** sessionId -> Set<sink> */
  const subscribers = new Map()
  /** sessionId -> last tick time */
  const tickAt = new Map()
  /** sink -> 建立顺序（超限时关最旧，避免硬杀浏览器留下的半开连接长期占满名额）。 */
  const sinkSeq = new WeakMap()
  let sinkCounter = 0
  let disposed = false

  const warn = message => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message)
    } catch {
      /* 日志失败不影响流 */
    }
  }

  const sinksFor = sessionId => subscribers.get(sessionId)

  /** 给该 session 的所有订阅者发一帧；单个 sink 写失败只移除它。 */
  function emit(sessionId, event, data) {
    const set = sinksFor(sessionId)
    if (!set || set.size === 0) return
    for (const sink of [...set]) {
      try {
        sink.send(event, data)
      } catch (error) {
        set.delete(sink)
        try { sink.close('write-failed') } catch { /* 关闭失败忽略 */ }
        warn('butler-stream: sink write failed: ' + String(error))
      }
    }
    if (set.size === 0) subscribers.delete(sessionId)
  }

  /** 背压：pending 超上限就关掉该 session 的所有连接（页面会退回轮询）。 */
  function closeSessionSinks(sessionId, reason) {
    const set = sinksFor(sessionId)
    if (!set) return
    for (const sink of [...set]) {
      try { sink.close(reason) } catch { /* 忽略 */ }
    }
    subscribers.delete(sessionId)
  }

  function attemptOf(sessionId) {
    return attempts.get(sessionId) ?? null
  }

  /** 新建 attempt（已有未结束的 attempt 视为替换并发 reset）。 */
  function startAttempt(sessionId, frame) {
    const attemptId = textOf(frame.attemptId, 120)
    const revision = Number.isFinite(frame.revision) ? frame.revision : -1
    const previous = attempts.get(sessionId)
    if (previous !== undefined && (previous.attemptId !== attemptId || previous.revision !== revision)) {
      emit(sessionId, 'reset', { reason: 'attempt-start', previousAttemptId: previous.attemptId })
    }
    if (previous !== undefined) clearAttemptTimer(sessionId, previous)
    const attempt = {
      attemptId,
      revision,
      index: -1,
      turn: Number.isFinite(frame.turn) ? frame.turn : null,
      step: Number.isFinite(frame.step) ? frame.step : null,
      text: '',
      thinking: '',
      startedAt: nowOf(),
      pendingText: '',
      pendingThinking: '',
      timer: null,
      desynced: false,
    }
    attempts.set(sessionId, attempt)
    trimAttempts()
    emit(sessionId, 'start', {
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      turn: attempt.turn,
      step: attempt.step,
      startedAt: attempt.startedAt,
    })
    return attempt
  }

  /** 清理未 flush 的定时器。 */
  function clearAttemptTimer(sessionId, attempt) {
    if (attempt && attempt.timer !== null) {
      try { clearTimer(attempt.timer) } catch { /* 忽略 */ }
      attempt.timer = null
    }
    void sessionId
  }

  /** 50ms 合批后发一帧完整快照（页面用快照替换 live 文本，幂等）。 */
  function flush(sessionId) {
    const attempt = attemptOf(sessionId)
    if (attempt === null) return
    attempt.timer = null
    const deltaText = attempt.pendingText
    const deltaThinking = attempt.pendingThinking
    attempt.pendingText = ''
    attempt.pendingThinking = ''
    if (deltaText === '' && deltaThinking === '') return
    emit(sessionId, 'assistant', {
      attemptId: attempt.attemptId,
      revision: attempt.revision,
      index: attempt.index,
      turn: attempt.turn,
      step: attempt.step,
      startedAt: attempt.startedAt,
      text: attempt.text,
      thinking: attempt.thinking,
      delta: { text: deltaText, thinking: deltaThinking },
    })
  }

  /** 安排一次 flush（同一 attempt 只排一个）。 */
  function scheduleFlush(sessionId, attempt) {
    if (attempt.timer !== null) return
    attempt.timer = setTimer(() => flush(sessionId), batchMs)
  }

  /** 处理 chunk 的文本增量；revision 不连续就 reset 并进入 desync（等 durable）。 */
  function chunkAttempt(sessionId, frame) {
    const attemptId = textOf(frame.attemptId, 120)
    const revision = Number.isFinite(frame.revision) ? frame.revision : -1
    let attempt = attemptOf(sessionId)
    if (attempt === null || attempt.attemptId !== attemptId) {
      attempt = startAttempt(sessionId, frame)
    }
    if (revision === attempt.revision) return // 幂等重复帧
    if (revision < attempt.revision) return // 过期帧
    if (revision > attempt.revision + 1) {
      // 跳号：清空已显示的 live 文本，通知页面 reset 并等 durable 轮询兜底。
      attempt.text = ''
      attempt.thinking = ''
      attempt.pendingText = ''
      attempt.pendingThinking = ''
      attempt.desynced = true
      attempt.revision = revision
      emit(sessionId, 'reset', { reason: 'revision-gap', attemptId, revision })
      return
    }
    attempt.revision = revision
    if (attempt.desynced) return // 已放弃这段 attempt 的增量，等 durable
    if (Number.isFinite(frame.index)) attempt.index = frame.index
    const folded = chunkTextOf(frame.chunk)
    if (folded.replaceText !== null) attempt.text = folded.replaceText
    if (folded.replaceThinking !== null) attempt.thinking = folded.replaceThinking
    let appended = false
    if (folded.text !== '') {
      attempt.text += folded.text
      attempt.pendingText += folded.text
      appended = true
    }
    if (folded.thinking !== '') {
      attempt.thinking += folded.thinking
      attempt.pendingThinking += folded.thinking
      appended = true
    }
    if (!appended) return
    const pendingBytes = Buffer.byteLength(attempt.pendingText) + Buffer.byteLength(attempt.pendingThinking)
    if (pendingBytes > maxPendingBytes) {
      // 背压上限：不再缓冲，直接关连接，让页面退回 2s 轮询。
      closeSessionSinks(sessionId, 'backpressure')
      attempt.pendingText = ''
      attempt.pendingThinking = ''
      return
    }
    scheduleFlush(sessionId, attempt)
  }

  /** end 帧：先 flush 再发 end（committed 时页面立即拉 durable）。 */
  function endAttempt(sessionId, frame) {
    const attemptId = textOf(frame.attemptId, 120)
    const attempt = attemptOf(sessionId)
    if (attempt === null || attempt.attemptId !== attemptId) {
      // 没见过 start 的 end（重连/晚到）：不猜，通知 reset 让页面等 durable。
      emit(sessionId, 'reset', { reason: 'orphan-end', attemptId })
      return
    }
    flush(sessionId)
    emit(sessionId, 'end', {
      attemptId,
      revision: Number.isFinite(frame.revision) ? frame.revision : attempt.revision,
      turn: attempt.turn,
      step: attempt.step,
      outcome: outcomeOf(frame.outcome),
    })
    clearAttemptTimer(sessionId, attempt)
    attempts.delete(sessionId)
  }

  /** attempt map 上限：删最久未更新的。 */
  function trimAttempts() {
    while (attempts.size > maxAttempts) {
      let oldestId = null
      let oldestAt = Infinity
      for (const [id, attempt] of attempts) {
        if (attempt.startedAt < oldestAt) {
          oldestAt = attempt.startedAt
          oldestId = id
        }
      }
      if (oldestId === null) break
      const attempt = attempts.get(oldestId)
      if (attempt !== undefined) clearAttemptTimer(oldestId, attempt)
      attempts.delete(oldestId)
    }
  }

  /** agent/assistant-stream 监听（任何异常都 reset，绝不 throw）。 */
  function onAssistantStream(payload) {
    if (disposed) return
    const agent = payload && payload.agent
    const frame = payload && payload.frame
    const sessionId = agent && agent.session ? textOf(agent.session.id, 160) : ''
    if (sessionId === '' || !frame || typeof frame !== 'object') return
    try {
      const kind = textOf(frame.kind ?? frame.type, 20)
      if (kind === 'start') startAttempt(sessionId, frame)
      else if (kind === 'chunk') chunkAttempt(sessionId, frame)
      else if (kind === 'end') endAttempt(sessionId, frame)
      // 不认识的帧类型：忽略（不 throw）。
    } catch (error) {
      const attempt = attemptOf(sessionId)
      if (attempt !== null) {
        attempt.text = ''
        attempt.thinking = ''
        attempt.pendingText = ''
        attempt.pendingThinking = ''
        attempt.desynced = true
        clearAttemptTimer(sessionId, attempt)
      }
      emit(sessionId, 'reset', { reason: 'frame-error' })
      warn('butler-stream: frame folded to reset: ' + String(error))
    }
  }

  /** session/event 监听：durable tick（只对已订阅 session，100ms 去重）。 */
  function onSessionEvent(session, event) {
    if (disposed) return
    const sessionId = session ? textOf(session.id, 160) : ''
    if (sessionId === '' || !event || typeof event !== 'object') return
    if (!sinksFor(sessionId)) return
    const at = nowOf()
    const last = tickAt.get(sessionId) ?? 0
    if (at - last < tickDedupeMs) return
    tickAt.set(sessionId, at)
    emit(sessionId, 'tick', { seq: Number.isFinite(event.seq) ? event.seq : null, type: textOf(event.type, 60) })
  }

  /* ---- 订阅 ---- */
  function countFor(sessionId) {
    return sinksFor(sessionId)?.size ?? 0
  }
  function countAll() {
    let total = 0
    for (const set of subscribers.values()) total += set.size
    return total
  }
  /** 找到并关闭最旧的一条连接；返回是否关掉了。 */
  function evictOldest(sessionId) {
    let target = null
    let best = Infinity
    for (const [id, set] of subscribers) {
      if (sessionId !== undefined && id !== sessionId) continue
      for (const sink of set) {
        const seq = sinkSeq.get(sink) ?? 0
        if (seq < best) { best = seq; target = { id, sink } }
      }
    }
    if (target === null) return false
    const set = subscribers.get(target.id)
    if (set) {
      set.delete(target.sink)
      if (set.size === 0) subscribers.delete(target.id)
    }
    try { target.sink.close('replaced') } catch { /* 忽略 */ }
    return true
  }
  function addSubscriber(sessionId, sink) {
    if (disposed) return { ok: false, code: 'stream-disposed', reason: '实时流已关闭' }
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, code: 'bad-session', reason: '会话 id 不能为空' }
    if (!sink || typeof sink.send !== 'function') return { ok: false, code: 'bad-sink', reason: '订阅者缺少 send' }
    // 超限策略：关最旧（不 429）——浏览器崩溃/断网留下的半开连接会占满名额，硬拒会让用户一直卡在轮询。
    while (countFor(sessionId) >= STREAM_MAX_PER_SESSION) {
      if (!evictOldest(sessionId)) break
    }
    while (countAll() >= STREAM_MAX_TOTAL) {
      if (!evictOldest()) break
    }
    let set = subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      subscribers.set(sessionId, set)
    }
    set.add(sink)
    sinkSeq.set(sink, ++sinkCounter)
    return {
      ok: true,
      unsubscribe() {
        const current = subscribers.get(sessionId)
        if (!current) return
        current.delete(sink)
        if (current.size === 0) subscribers.delete(sessionId)
      },
    }
  }
  function snapshotOf(sessionId) {
    const attempt = attempts.get(typeof sessionId === 'string' ? sessionId : '')
    if (!attempt) return { attempt: null }
    return {
      attempt: {
        attemptId: attempt.attemptId,
        revision: attempt.revision,
        index: attempt.index,
        turn: attempt.turn,
        step: attempt.step,
        startedAt: attempt.startedAt,
        text: attempt.text,
        thinking: attempt.thinking,
      },
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const sessionId of [...subscribers.keys()]) closeSessionSinks(sessionId, 'disposed')
    for (const attempt of attempts.values()) {
      if (attempt.timer !== null) {
        try { clearTimer(attempt.timer) } catch { /* 忽略 */ }
        attempt.timer = null
      }
    }
    attempts.clear()
    tickAt.clear()
  }

  /* ---- 挂宿主事件（ctx.on 不存在时纯聚合，便于单测） ---- */
  const offs = []
  if (ctx && typeof ctx.on === 'function') {
    try { offs.push(ctx.on('agent/assistant-stream', payload => onAssistantStream(payload), { global: true })) } catch (error) { warn('butler-stream: subscribe assistant-stream failed: ' + String(error)) }
    try { offs.push(ctx.on('session/event', (session, event) => onSessionEvent(session, event))) } catch (error) { warn('butler-stream: subscribe session/event failed: ' + String(error)) }
  }
  const offEffect = ctx && typeof ctx.effect === 'function'
    ? ctx.effect(() => () => {
        for (const off of offs) {
          try { if (typeof off === 'function') off() } catch { /* 忽略 */ }
        }
        dispose()
      }, 'dsh-html-panel: butler-stream hub')
    : null
  void offEffect

  return { addSubscriber, snapshotOf, countFor, countAll, dispose, onAssistantStream, onSessionEvent }
}

/* ─────────────────────────── SSE 路由 ─────────────────────────── */

/** 一帧 SSE 文本。 */
function frameText(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
}

/** 只读路由的 JSON 响应（SSE 路由自己的错误回执，绝不 HTML）。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  try {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  } catch {
    try { res.end() } catch { /* 忽略 */ }
  }
}

/**
 * 处理 `GET /dsh-html-panel/api/butler/dialog/stream?sessionId=`。
 *
 * 只读：建立一条 SSE 连接，先发 `retry: 3000` + `hello` 快照，然后转发 hub 的
 * start/assistant/reset/end/tick 帧，15s 一条注释心跳；连接关闭/空闲 30 分钟/插件 dispose 都会清理。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} deps
 * @param {object} deps.hub {@link createButlerLiveHub} 的返回值
 * @param {(requested:string) => Promise<{sessionId:string}|{error:string}>} deps.targetOf 目标会话解析
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {{setInterval?:Function, clearInterval?:Function, setTimeout?:Function, clearTimeout?:Function, pingMs?:number, idleMs?:number, retryMs?:number}} [deps.timers]
 * @returns {Promise<void>}
 */
export async function handleButlerStreamRequest(req, res, deps = {}) {
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
  if (method !== 'GET') {
    try {
      res.setHeader('allow', 'GET')
    } catch { /* 忽略 */ }
    writeJson(res, 405, { ok: false, error: 'method-not-allowed', code: 'method-not-allowed' })
    return
  }
  const fence = streamFence(req)
  if (fence !== undefined) {
    writeJson(res, 403, { ok: false, code: 'origin-rejected', reason: fence })
    return
  }
  const hub = deps.hub
  if (!hub || typeof hub.addSubscriber !== 'function') {
    writeJson(res, 503, { ok: false, code: 'stream-unavailable', reason: '实时流未就绪（Host 未重启或插件未加载）' })
    return
  }
  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    writeJson(res, 400, { ok: false, code: 'bad-query', reason: '请求 URL 不合法' })
    return
  }
  const requested = url.searchParams.get('sessionId') ?? ''
  let target
  try {
    target = typeof deps.targetOf === 'function' ? await deps.targetOf(requested) : { error: '没有目标解析器' }
  } catch {
    target = { error: '目标解析失败' }
  }
  if (!target || typeof target.sessionId !== 'string' || target.sessionId === '') {
    writeJson(res, 404, { ok: false, code: 'no-session', reason: target && target.error ? target.error : '没有可用的会话绑定' })
    return
  }
  const sessionId = target.sessionId

  const timers = deps.timers && typeof deps.timers === 'object' ? deps.timers : {}
  const setIntervalFn = typeof timers.setInterval === 'function' ? timers.setInterval : setInterval
  const clearIntervalFn = typeof timers.clearInterval === 'function' ? timers.clearInterval : clearInterval
  const setTimeoutFn = typeof timers.setTimeout === 'function' ? timers.setTimeout : setTimeout
  const clearTimeoutFn = typeof timers.clearTimeout === 'function' ? timers.clearTimeout : clearTimeout
  const pingMs = Number.isFinite(timers.pingMs) && timers.pingMs > 0 ? timers.pingMs : STREAM_PING_MS
  const idleMs = Number.isFinite(timers.idleMs) && timers.idleMs > 0 ? timers.idleMs : STREAM_IDLE_MS
  const retryMs = Number.isFinite(timers.retryMs) && timers.retryMs > 0 ? timers.retryMs : STREAM_RETRY_MS
  const nowOf = typeof deps.now === 'function' ? deps.now : () => Date.now()

  let closed = false
  let pingTimer = null
  let idleTimer = null
  let unsubscribe = null

  const write = text => {
    if (closed || res.writableEnded === true) return false
    try {
      res.write(text)
      return true
    } catch {
      return false
    }
  }
  const touchIdle = () => {
    if (closed) return
    if (idleTimer !== null) {
      try { clearTimeoutFn(idleTimer) } catch { /* 忽略 */ }
    }
    idleTimer = setTimeoutFn(() => cleanup('idle'), idleMs)
  }
  const cleanup = reason => {
    if (closed) return
    closed = true
    void reason
    if (pingTimer !== null) {
      try { clearIntervalFn(pingTimer) } catch { /* 忽略 */ }
      pingTimer = null
    }
    if (idleTimer !== null) {
      try { clearTimeoutFn(idleTimer) } catch { /* 忽略 */ }
      idleTimer = null
    }
    try {
      if (typeof unsubscribe === 'function') unsubscribe()
    } catch { /* 忽略 */ }
    unsubscribe = null
    try {
      if (!res.writableEnded) res.end()
    } catch { /* 忽略 */ }
  }

  const subscription = hub.addSubscriber(sessionId, {
    send(event, data) {
      if (!write(frameText(event, data))) cleanup('write-failed')
      else touchIdle()
    },
    close(reason) {
      cleanup(reason)
    },
  })
  if (!subscription.ok) {
    writeJson(res, 429, { ok: false, code: subscription.code, reason: subscription.reason })
    return
  }
  unsubscribe = subscription.unsubscribe

  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
  } catch {
    cleanup('headers-failed')
    return
  }
  if (typeof res.flushHeaders === 'function') {
    try { res.flushHeaders() } catch { /* 忽略 */ }
  }
  write('retry: ' + retryMs + '\n\n')
  write(frameText('hello', { sessionId, snapshot: hub.snapshotOf(sessionId), at: nowOf() }))
  touchIdle()
  pingTimer = setIntervalFn(() => {
    if (!write(': ping ' + nowOf() + '\n\n')) cleanup('ping-failed')
    else touchIdle()
  }, pingMs)
  if (typeof pingTimer.unref === 'function') pingTimer.unref()

  req.on('close', () => cleanup('request-close'))
  res.on('close', () => cleanup('response-close'))
  res.on('error', () => cleanup('response-error'))
}
