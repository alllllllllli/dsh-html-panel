/**
 * 大管家写通道（0.8.0 M2）：`POST api/butler/say` 与 `POST api/butler/session` 的全部逻辑。
 *
 * 口径（2026-11-21 主人逐条批准）：
 *
 *   1. **只允许发给配置里的专属大管家会话**：`config.butler.sessionId`；其它 sessionId
 *      一律 403 `not-butler-session`。页面看别的会话可以，发不行。
 *   2. **三层闸门**：页面内嵌一次性 token（宿主启动时随机生成，只注入页面 HTML，绝不出现在
 *      任何 JSON/日志/报告里）→ `config.butler.allowWrite === true`（代码默认 false）→ 限流
 *      10 条/分钟 + 同 requestId 幂等去重。
 *   3. **真实调用**：`sessionController.prompt({mode:'queue', content:[{type:'text'}]})`。
 *      这会真跑模型、真写对话历史、真计费 —— 所以页面每次都要二次确认，这里不自动重试。
 *   4. **专属会话的创建与重建**：`sessionController.create()` 建新根会话，再 `rename()` 设标题
 *      「大管家 · 常驻」；随后把新 sessionId 写回 `cordis.patch.yml` 的 panel 块（备份 + 定点校验）。
 *
 * 与 `lib/butler.js` 的分工：butler.js 保持**只读**（M0/M1），本文件才碰写 API。
 * 失败一律结构化：`{ ok:false, code, reason, retryable }`，原始异常文本不外泄（只进 DSH 日志）。
 *
 * 零新增依赖：YAML 只做「定点改写 + 局部结构校验」（不引 yaml 库）；部署时另用 js-yaml 全量解析。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** 写通道 say 路由的 child path（挂在 `ROUTE_PREFIX` 下，exact raw handler）。 */
export const BUTLER_SAY_FILE = 'api/butler/say'
/** 专属会话创建/重建路由的 child path（exact raw handler）。 */
export const BUTLER_SESSION_FILE = 'api/butler/session'
/** 页面携带写通道 token 的请求头。 */
export const WRITE_TOKEN_HEADER = 'x-butler-write-token'

/** 单条消息字符上限（1–4000）。 */
export const SAY_CONTENT_MAX = 4000
/** 写通道限流：窗口内最多条数。 */
export const SAY_RATE_LIMIT = 10
/** 写通道限流窗口（毫秒）。 */
export const SAY_RATE_WINDOW_MS = 60 * 1000
/** say/session 请求体上限：一条消息 + 几个字段，8 KB 足够。 */
export const WRITE_BODY_MAX_BYTES = 8192
/** `sessionController.prompt()` 的等待上限（入队本身很快，超时如实报）。 */
export const SAY_PROMPT_TIMEOUT_MS = 15000
/** 幂等去重缓存时长。 */
export const SAY_CACHE_TTL_MS = 10 * 60 * 1000
/** 幂等去重缓存上限。 */
export const SAY_CACHE_MAX = 200
/** 建会话路由的等待上限。 */
export const SESSION_CREATE_TIMEOUT_MS = 20000

/** 专属会话默认显示名 / 标题。 */
export const BUTLER_LABEL_DEFAULT = '大管家 · 常驻'
/** session 路由动作：没有配置时创建。 */
export const SESSION_ACTION_ENSURE = 'ensure'
/** session 路由动作：配置指向的会话已不存在时重建。 */
export const SESSION_ACTION_REBUILD = 'rebuild'

/** 备份文件名里的稳定标记（与手动部署备份同名规则一致）。 */
export const CONFIG_BACKUP_INFIX = '.bak-before-panel-butler-'

/** sessionId 允许字符：写回 YAML 前必须过这条，避免把换行/引号写进配置。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{4,160}$/

/** requestId 允许字符。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/

/** 错误结果：稳定 code + 人话 reason + retryable，绝不带原始异常/路径/凭据。 */
function failure(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra }
}

/** 结构化错误的 HTTP 状态选择（与 code 一一对应，页面按状态码给提示）。 */
function answer(status, code, reason, extra = {}) {
  return { status, body: failure(code, reason, extra) }
}

/** timing-safe 比较两个 token（先比长度，再比 sha256，避免长度泄露）。 */
export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const left = createHash('sha256').update(actual, 'utf8').digest()
  const right = createHash('sha256').update(expected, 'utf8').digest()
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** 生成 32 字节随机 token（base64url，URL/HTML 安全）。 */
export function newWriteToken() {
  return randomBytes(32).toString('base64url')
}

/** 读请求头（兼容 Node 的 IncomingHttpHeaders 小写键与 fetch Request 的 Headers）。 */
export function readHeader(headers, name) {
  if (headers === null || headers === undefined) return undefined
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  if (typeof headers !== 'object') return undefined
  const wanted = String(name).toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue
    const value = headers[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.join(',')
  }
  return undefined
}

/**
 * 读插件配置里的写通道段（与 `lib/butler.js` 的只读段同源，但这里额外要写权限/配置路径）。
 *
 * @param {unknown} rawConfig 插件行 config
 * @returns {{sessionId:string, allowWrite:boolean, configPath:string, label:string, cwd:string, agentPreset:string}}
 */
export function readWriteOptions(rawConfig) {
  const row = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const shaped = row.butler && typeof row.butler === 'object' ? row.butler : {}
  const trimmed = value => (typeof value === 'string' ? value.trim() : '')
  const sessionId = trimmed(shaped.sessionId).slice(0, 160)
  const configPath = trimmed(shaped.configPath)
  const label = trimmed(shaped.label).slice(0, 60) || BUTLER_LABEL_DEFAULT
  const cwd = trimmed(shaped.cwd)
  const agentPreset = trimmed(shaped.agentPreset)
  return { sessionId, allowWrite: shaped.allowWrite === true, configPath, label, cwd, agentPreset }
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

/** 把 thenable 包成「值 / 超时 / 失败」三态，绝不抛出。 */
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

/** 从异常上取官方错误码（RemoteError 带 code；其它异常一律当未知）。 */
function codeOf(error) {
  return error && typeof error.code === 'string' ? error.code : ''
}

/** 把 prompt() 的失败映射成结构化回执；不带原始异常文本。 */
function mapPromptError(error) {
  const code = codeOf(error)
  if (code === 'session/not-found') {
    return answer(404, 'session-not-found', '专属大管家会话不存在（可能已归档或被删除）：请用「重建」按钮建一个新的专属会话', { retryable: false })
  }
  if (code === 'session/agent-busy') {
    return answer(409, 'session-busy', '专属会话当前不接受入队（可能被另一个写者或子代理路由占用）：稍后再试', { retryable: true })
  }
  if (code === 'gateway/bad-request') {
    return answer(400, 'bad-request', '宿主拒收了这条消息：内容为空或含不支持的附件', { retryable: false })
  }
  if (code === 'gateway/cancelled' || (error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
    return answer(504, 'prompt-cancelled', '发送被取消或超时：消息可能没有入队，先看对话流核对，不要盲目重发', { retryable: true })
  }
  return answer(502, 'prompt-failed', '发送失败（宿主 sessionController.prompt 报错，详见 DSH 宿主日志）', { retryable: true })
}

/** 把 create()/rename() 的失败映射成结构化回执。 */
function mapSessionError(error, step) {
  const code = codeOf(error)
  if (step === 'create') {
    if (code === 'agent-preset/not-found' || code === 'agent-preset/invalid') {
      return answer(400, 'preset-invalid', '配置里的 butler.agentPreset 在宿主上不存在：删掉该键或改成可用预设后重试', { retryable: false })
    }
    if (code === 'workspace/not-found') {
      return answer(400, 'workspace-not-found', 'butler.cwd 指向的目录不可用（或配置的 workspace 不存在）', { retryable: false })
    }
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return answer(504, 'create-timeout', '建会话超时：宿主可能正在忙，稍后重试', { retryable: true })
    }
    return answer(502, 'session-create-failed', '建专属会话失败（宿主 sessionController.create 报错，详见 DSH 宿主日志）', { retryable: true })
  }
  return answer(502, 'rename-failed', '会话已创建，但设置标题失败（会话本身可用；标题可稍后手动改）', { retryable: true })
}

/** 毫秒时间戳 → 本地时间戳 `YYYYMMDD-HHmmss`（备份文件名用）。 */
export function stampOf(ms) {
  const date = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now())
  const pad = value => (value < 10 ? '0' + value : String(value))
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

/* =====================================================================
 * A. 创建 / 重建专属会话的写通道对象
 * ===================================================================== */

/**
 * 建一个写通道实例：token 只在这里生成一次；配置对象引用会被保留，
 * 重建后原地更新 `butler.sessionId`，这样 M0 下一轮轮询就能看到新绑定（不必重启）。
 *
 * @param {object} deps
 * @param {() => (object|null)} deps.controller 惰性取 `sessionController`
 * @param {unknown} deps.config 插件行 config（会被读取；重建时原地写回 sessionId）
 * @param {string} [deps.token] 未给就现场生成
 * @param {() => number} [deps.now]
 * @param {{warn: Function}} [deps.logger]
 * @param {object} [deps.fsDeps] 配置读写注入（单测用）
 * @returns {object} 写通道
 */
export function createWriteChannel(deps = {}) {
  const token = typeof deps.token === 'string' && deps.token !== '' ? deps.token : newWriteToken()
  const rawConfig = deps.config && typeof deps.config === 'object' ? deps.config : {}
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const logger = deps.logger ?? null
  const fsDeps = deps.fsDeps && typeof deps.fsDeps === 'object' ? deps.fsDeps : {}
  const acceptedAt = []
  const cache = new Map()
  const inflight = new Map()
  let runtimeSessionId = ''

  const controllerOf = () => {
    try {
      const value = typeof deps.controller === 'function' ? deps.controller() : deps.controller
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  /** 当前生效的写配置（重建后的 id 优先于配置文件里的旧值）。 */
  const options = () => {
    const opts = readWriteOptions(rawConfig)
    if (runtimeSessionId !== '') opts.sessionId = runtimeSessionId
    return opts
  }

  /** 三层闸门第一步：token。 */
  const authorize = headers => {
    const given = readHeader(headers, WRITE_TOKEN_HEADER)
    if (typeof given !== 'string' || given === '') {
      return answer(401, 'write-token-missing', '缺少写通道 token 请求头（x-butler-write-token）：页面没有拿到注入的 token，需重启 DSH 后重新加载页面', { retryable: false })
    }
    if (!tokenMatches(given, token)) {
      return answer(401, 'write-token-invalid', '写通道 token 不正确：拒绝写操作', { retryable: false })
    }
    return { ok: true }
  }

  /** 幂等缓存：只缓存真正被接受的发送（失败允许换新 requestId 重试）。 */
  const remember = (requestId, result) => {
    cache.set(requestId, { at: now(), result })
    while (cache.size > SAY_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  /**
   * 发一条主人消息到专属大管家会话。
   * @param {object} headers Node/fetch 请求头
   * @param {unknown} body `{ sessionId, content, requestId? }`
   * @returns {Promise<{status:number, body:object, extraHeaders?:object}>}
   */
  async function say(headers, body) {
    const auth = authorize(headers)
    if (auth.ok !== true) return auth
    const opts = options()
    if (opts.allowWrite !== true) {
      return answer(403, 'write-disabled', '写通道已关闭（config.butler.allowWrite=false，代码默认 false）：页面输入框保持禁用', { retryable: false })
    }
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (sessionId === '') return answer(400, 'bad-request', 'sessionId 不能为空', { retryable: false })
    if (opts.sessionId === '') {
      return answer(403, 'not-butler-session', '还没有配置专属大管家会话（config.butler.sessionId 为空）：先建会话再发送', { retryable: false })
    }
    if (sessionId !== opts.sessionId) {
      return answer(403, 'not-butler-session', '只允许发给配置里的专属大管家会话；其它会话一律只读', { retryable: false })
    }
    const content = typeof payload.content === 'string' ? payload.content : ''
    const chars = Array.from(content).length
    if (content.trim() === '') return answer(400, 'empty-content', '消息内容不能为空', { retryable: false })
    if (chars > SAY_CONTENT_MAX) {
      return answer(400, 'content-too-long', '消息内容超过 ' + SAY_CONTENT_MAX + ' 字符上限（当前 ' + chars + '）', { retryable: false })
    }
    let requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : ''
    if (requestId === '') requestId = 'panel-' + randomUUID()
    else if (!REQUEST_ID_PATTERN.test(requestId)) {
      return answer(400, 'bad-request-id', 'requestId 格式不合法（只允许字母/数字/._:-，1–120 字符）', { retryable: false })
    }

    const cached = cache.get(requestId)
    if (cached && now() - cached.at < SAY_CACHE_TTL_MS) {
      return { status: cached.result.status, body: { ...cached.result.body, deduped: true } }
    }
    const running = inflight.get(requestId)
    if (running !== undefined) {
      const result = await running
      return { status: result.status, body: { ...result.body, deduped: true } }
    }

    const at = now()
    while (acceptedAt.length > 0 && at - acceptedAt[0] >= SAY_RATE_WINDOW_MS) acceptedAt.shift()
    if (acceptedAt.length >= SAY_RATE_LIMIT) {
      const retryAfterSeconds = Math.max(1, Math.ceil((acceptedAt[0] + SAY_RATE_WINDOW_MS - at) / 1000))
      return {
        status: 429,
        body: failure('rate-limited', '写通道限流：每分钟最多 ' + SAY_RATE_LIMIT + ' 条，请 ' + retryAfterSeconds + ' 秒后再试', {
          retryable: true,
          retryAfterSeconds,
        }),
        extraHeaders: { 'retry-after': String(retryAfterSeconds) },
      }
    }

    const controller = controllerOf()
    if (controller === null || typeof controller.prompt !== 'function') {
      return answer(503, 'no-controller', '宿主没有可用的 sessionController.prompt：写通道不可用（详见 DSH 日志）', { retryable: true })
    }

    const pending = (async () => {
      const settled = await settleWithin(
        controller.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: content }],
        }, abortAfter(SAY_PROMPT_TIMEOUT_MS)),
        SAY_PROMPT_TIMEOUT_MS + 500,
      )
      try {
        if (settled.kind === 'timeout') {
          return answer(504, 'prompt-timeout', '发送超时：消息可能已排队，先看对话流核对，不要重复发送', { retryable: true })
        }
        if (settled.kind === 'error') return mapPromptError(settled.error)
        const result = {
          status: 200,
          body: { ok: true, accepted: true, mode: 'queue', sessionId, requestId },
        }
        acceptedAt.push(now())
        remember(requestId, result)
        return result
      } finally {
        inflight.delete(requestId)
      }
    })()
    inflight.set(requestId, pending)
    const result = await pending
    return result
  }

  /**
   * 创建 / 重建专属大管家会话，并把新 sessionId 写回配置文件。
   * @param {object} headers
   * @param {unknown} body `{ action: 'ensure'|'rebuild' }`
   * @returns {Promise<{status:number, body:object}>}
   */
  async function ensureSession(headers, body) {
    const auth = authorize(headers)
    if (auth.ok !== true) return auth
    const opts = options()
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const action = typeof payload.action === 'string' ? payload.action.trim() : ''
    if (action !== SESSION_ACTION_ENSURE && action !== SESSION_ACTION_REBUILD) {
      return answer(400, 'unknown-action', '未知动作：只接受 ensure（没有配置时创建）或 rebuild（绑定的会话已不存在时重建）', { retryable: false })
    }
    if (action === SESSION_ACTION_REBUILD && opts.sessionId === '') {
      return answer(400, 'bad-request', '当前没有绑定会话可重建（config.butler.sessionId 为空）：先点「创建专属会话」', { retryable: false })
    }
    const controller = controllerOf()
    if (controller === null || typeof controller.create !== 'function') {
      return answer(503, 'no-controller', '宿主没有可用的 sessionController.create：无法创建专属会话（详见 DSH 日志）', { retryable: true })
    }

    const request = {}
    if (opts.cwd !== '') {
      if (!isAbsolute(opts.cwd)) return answer(400, 'bad-config', 'config.butler.cwd 必须是绝对路径', { retryable: false })
      request.cwd = opts.cwd
    }
    if (opts.agentPreset !== '') request.agentPreset = opts.agentPreset

    const created = await settleWithin(controller.create(request), SESSION_CREATE_TIMEOUT_MS)
    if (created.kind === 'timeout') return mapSessionError(null, 'create')
    if (created.kind === 'error') return mapSessionError(created.error, 'create')
    const value = created.value && typeof created.value === 'object' ? created.value : {}
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
    if (sessionId === '') {
      return answer(502, 'session-create-failed', '宿主的 sessionController.create 没有返回 sessionId：无法绑定专属会话', { retryable: true })
    }

    // 标题尽量设成「大管家 · 常驻」；失败不影响会话本身，如实回报。
    let titleApplied = false
    let titleReason = ''
    if (typeof controller.rename === 'function') {
      const renamed = await settleWithin(controller.rename({ sessionId, title: opts.label }), 5000)
      if (renamed.kind === 'value') titleApplied = true
      else if (renamed.kind === 'error') titleReason = String(codeOf(renamed.error) || 'rename-failed').slice(0, 80)
      else titleReason = 'rename-timeout'
    } else {
      titleReason = '宿主没有 sessionController.rename：标题留空，页面显示默认名'
    }

    // 写回配置（备份 + 定点校验）；失败时如实告知「已建会话但未持久化」。
    const config = await persistButlerSessionId({
      configPath: opts.configPath,
      sessionId,
      fsDeps,
      nowMs: now(),
    })

    // 内存里也换成新 id：M0 的 binding 下一轮轮询即可看到；不用重启。
    try {
      if (!rawConfig.butler || typeof rawConfig.butler !== 'object') rawConfig.butler = {}
      rawConfig.butler.sessionId = sessionId
      rawConfig.butler.targetMode = 'pinned'
    } catch {
      /* 配置对象被冻结时忽略：只影响本次进程内的 M0 显示，写盘结果仍会生效 */
    }
    runtimeSessionId = sessionId

    const bodyOut = {
      ok: true,
      action,
      sessionId,
      label: opts.label,
      titleApplied,
      ...(titleReason === '' ? {} : { titleReason }),
      persisted: config.updated === true,
      config: { updated: config.updated === true, ...(config.backup ? { backup: config.backup } : {}), ...(config.reason ? { reason: config.reason } : {}) },
      ...(config.updated === true ? { note: '新会话已生效（本进程内 M0 立刻可见）；重启 DSH 后仍从 cordis.patch.yml 读取同一个 sessionId' } : {}),
    }
    return { status: 200, body: bodyOut }
  }

  /** 给页面注入用的快照（token 只允许进这里）。 */
  function pageConfig() {
    const opts = options()
    return { allowWrite: opts.allowWrite === true, label: opts.label, token, sessionId: opts.sessionId }
  }

  return {
    token,
    get sessionId() {
      return options().sessionId
    },
    allowWrite() {
      return options().allowWrite === true
    },
    label() {
      return options().label
    },
    pageConfig,
    say,
    ensureSession,
  }
}

/* =====================================================================
 * B. cordis.patch.yml 定点写回（备份 + 只改 panel 块的 butler 段）
 * ===================================================================== */

/** 行首缩进宽度（空格数）；含 tab 返回 -1。 */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  if (match === null) return 0
  return match[0].includes('\t') ? -1 : match[0].length
}

/** 找 `- id: dsh-html-panel` 配置块的 [start, end) 行号区间。 */
export function findPanelBlock(lines) {
  const start = lines.findIndex(line => /^-\s+id:\s*dsh-html-panel\s*$/.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^-\s/.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

/** 在 [start,end) 里找 `config:` 行。 */
function findConfigLine(lines, block) {
  for (let index = block.start + 1; index < block.end; index += 1) {
    if (/^\s*config:\s*$/.test(lines[index])) return index
  }
  return -1
}

/** 在 [start,end) 里找 `butler:` 行（必须在 config 之下）。 */
function findButlerLine(lines, block, configIndex) {
  const configIndent = indentOf(lines[configIndex])
  for (let index = configIndex + 1; index < block.end; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= configIndent) return -1
    if (/^\s*butler:\s*$/.test(line)) return index
  }
  return -1
}

/**
 * 改写一次（不做幂等自校验）：找到 panel 块的 butler 段，替换 sessionId + targetMode。
 * 供 {@link rewriteButlerSessionId} 与其幂等校验共用，避免递归。
 * @param {string} text
 * @param {string} sessionId
 * @returns {{ok:true, text:string, changed:string[]} | {ok:false, reason:string}}
 */
function rewriteOnce(text, sessionId) {
  if (typeof text !== 'string' || text === '') return { ok: false, reason: '配置文件为空' }
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, reason: 'sessionId 含不安全字符（只允许字母/数字/._:-，4–160 字符），拒绝写配置' }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const block = findPanelBlock(lines)
  if (block === null) return { ok: false, reason: 'cordis.patch.yml 里找不到 `- id: dsh-html-panel` 配置块' }
  const configIndex = findConfigLine(lines, block)
  if (configIndex === -1) return { ok: false, reason: 'dsh-html-panel 配置块里没有 `config:` 段' }

  const changed = []
  const next = lines.slice()
  const butlerIndex = findButlerLine(next, block, configIndex)
  const configIndent = indentOf(next[configIndex])
  const childIndent = configIndent + 2
  const leafIndent = childIndent + 2
  const sessionLine = value => ' '.repeat(leafIndent) + "sessionId: '" + value + "'"
  const pinnedLine = ' '.repeat(leafIndent) + 'targetMode: pinned'
  let insertAt
  let butlerEnd

  if (butlerIndex === -1) {
    // 没有 butler 段：在 config: 之后插入整段。
    insertAt = configIndex + 1
    next.splice(insertAt, 0,
      ' '.repeat(childIndent) + 'butler:',
      sessionLine(sessionId),
      pinnedLine,
    )
    changed.push('butler', 'butler.sessionId', 'butler.targetMode')
  } else {
    butlerEnd = block.end
    const butlerIndent = indentOf(next[butlerIndex])
    for (let index = butlerIndex + 1; index < block.end; index += 1) {
      if (next[index].trim() === '') continue
      if (indentOf(next[index]) <= butlerIndent) {
        butlerEnd = index
        break
      }
    }
    let sessionAt = -1
    let targetAt = -1
    for (let index = butlerIndex + 1; index < butlerEnd; index += 1) {
      if (/^\s*sessionId:\s*.*$/.test(next[index])) sessionAt = index
      else if (/^\s*targetMode:\s*.*$/.test(next[index])) targetAt = index
    }
    if (sessionAt === -1) {
      next.splice(butlerIndex + 1, 0, sessionLine(sessionId))
      changed.push('butler.sessionId')
      if (targetAt !== -1) targetAt += 1
    } else {
      next[sessionAt] = sessionLine(sessionId)
      changed.push('butler.sessionId')
    }
    if (targetAt === -1) {
      const anchor = sessionAt === -1 ? butlerIndex + 1 : sessionAt
      next.splice(anchor + 1, 0, pinnedLine)
      changed.push('butler.targetMode')
    } else {
      next[targetAt] = pinnedLine
      changed.push('butler.targetMode')
    }
  }

  // ── 校验 1：不能有 tab（YAML 里 tab 是缩进错误）。
  if (next.some(line => line.includes('\t'))) return { ok: false, reason: '改写后出现 tab 字符（YAML 不允许），已放弃' }
  // ── 校验 2：panel 块以外的行必须一字节不变（含其它插件行与 board.token）。
  const newBlock = findPanelBlock(next)
  if (newBlock === null) return { ok: false, reason: '改写后找不到 panel 配置块' }
  const outsideBefore = lines.slice(0, block.start).join(eol)
  const outsideAfter = next.slice(0, newBlock.start).join(eol)
  const tailBefore = lines.slice(block.end).join(eol)
  const tailAfter = next.slice(newBlock.end).join(eol)
  if (outsideBefore !== outsideAfter || tailBefore !== tailAfter) {
    return { ok: false, reason: '改写触碰了 dsh-html-panel 以外的配置行，已放弃' }
  }
  // ── 校验 3：新块里 butler 段确实还在（幂等校验放到导出的包装函数里再做，避免递归）。
  const output = next.join(eol)
  const verifyLines = output.split(/\r?\n/)
  const verifyBlock = findPanelBlock(verifyLines)
  const verifyConfig = findConfigLine(verifyLines, verifyBlock)
  const verifyButler = findButlerLine(verifyLines, verifyBlock, verifyConfig)
  if (verifyButler === -1) return { ok: false, reason: '改写后 butler 段丢失，已放弃' }
  return { ok: true, text: output, changed: [...new Set(changed)] }
}

/**
 * 把文本里 panel 块的 `butler.sessionId` 改成给定值，并保证 `targetMode: pinned`。
 *
 * 只允许 JSON 安全的 sessionId（见 {@link SESSION_ID_PATTERN}）；除 panel 块的 butler 段外，
 * 其它行（含 mesh/board/interconnect 配置与 board.token）**一个字节都不改**。
 * 写完后会再跑一次定点改写，确认结果幂等（结构稳定）才返回。
 *
 * @param {string} text cordis.patch.yml 原文
 * @param {string} sessionId 新会话 id
 * @returns {{ok:true, text:string, changed:string[]} | {ok:false, reason:string}}
 */
export function rewriteButlerSessionId(text, sessionId) {
  const first = rewriteOnce(text, sessionId)
  if (first.ok !== true || first.text === text) return first
  const second = rewriteOnce(first.text, sessionId)
  if (second.ok !== true || second.text !== first.text) {
    return { ok: false, reason: '改写不是幂等的（结构异常），已放弃' }
  }
  return first
}

/** 备份文件名：给已有同名备份时追加 -2/-3…（不覆盖旧备份）。 */
async function uniqueBackupPath(basePath, statImpl) {
  let candidate = basePath
  for (let index = 2; index < 100; index += 1) {
    let exists = false
    try {
      await statImpl(candidate)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) return candidate
    candidate = basePath + '-' + index
  }
  return basePath + '-' + Date.now()
}

/**
 * 把新 sessionId 写回 cordis.patch.yml：备份 → 临时文件 → 原子替换 → 读回定点校验。
 *
 * 任何一步失败都返回 `{updated:false, reason}`（人话），绝不把半截配置留在盘上：
 * 临时文件写到同目录再 rename；备份失败就不写。
 *
 * @param {object} options
 * @param {string} options.configPath 绝对路径
 * @param {string} options.sessionId 新会话 id
 * @param {object} [options.fsDeps] 注入 fs（readFile/writeFile/copyFile/rename/stat）
 * @param {number} [options.nowMs]
 * @returns {Promise<{updated:boolean, backup?:string, changed?:string[], validated?:boolean, reason?:string}>}
 */
export async function persistButlerSessionId(options = {}) {
  const readFileImpl = options.fsDeps?.readFileImpl ?? readFile
  const writeFileImpl = options.fsDeps?.writeFileImpl ?? writeFile
  const copyFileImpl = options.fsDeps?.copyFileImpl ?? copyFile
  const renameImpl = options.fsDeps?.renameImpl ?? rename
  const statImpl = options.fsDeps?.statImpl ?? stat
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now()

  const configPath = typeof options.configPath === 'string' ? options.configPath.trim() : ''
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  if (configPath === '') {
    return { updated: false, reason: 'config.butler.configPath 未配置：会话已创建，但没有把 sessionId 写回 cordis.patch.yml，重启前请手动补' }
  }
  if (!isAbsolute(configPath)) return { updated: false, reason: 'config.butler.configPath 必须是绝对路径，未写回配置' }
  if (!SESSION_ID_PATTERN.test(sessionId)) return { updated: false, reason: 'sessionId 含不安全字符，未写回配置' }

  let original
  try {
    original = await readFileImpl(configPath, 'utf8')
  } catch {
    return { updated: false, reason: '读不到 ' + basename(configPath) + '：没有写回配置（会话本身已创建），请手动把 sessionId 填进 config.butler.sessionId' }
  }
  const rewritten = rewriteButlerSessionId(original, sessionId)
  if (rewritten.ok !== true) return { updated: false, reason: rewritten.reason }
  if (rewritten.text === original) {
    return { updated: true, unchanged: true, changed: [], validated: true, reason: '配置里已经是这个 sessionId，未重复写' }
  }

  const backupPath = await uniqueBackupPath(configPath + CONFIG_BACKUP_INFIX + stampOf(nowMs), statImpl)
  try {
    await copyFileImpl(configPath, backupPath)
  } catch {
    return { updated: false, reason: '写配置前备份失败：已放弃写 %s（会话本身已创建）'.replace('%s', basename(configPath)) }
  }
  const tempPath = configPath + '.tmp-' + randomBytes(4).toString('hex')
  try {
    await writeFileImpl(tempPath, rewritten.text, 'utf8')
    await renameImpl(tempPath, configPath)
  } catch {
    // 临时文件可能残留：尽力清掉，但清不掉也不影响原文件（原文件仍完整）。
    try {
      await writeFileImpl(tempPath, '', 'utf8')
      await renameImpl(tempPath, tempPath + '.failed')
    } catch {
      /* 忽略 */
    }
    return { updated: false, backup: basename(backupPath), reason: '写配置文件失败：已保留备份，可用备份回滚' }
  }

  let readBack
  try {
    readBack = await readFileImpl(configPath, 'utf8')
  } catch {
    return { updated: false, backup: basename(backupPath), reason: '写后读回失败：已保留备份，请人工核对配置文件' }
  }
  const verified = rewriteButlerSessionId(readBack, sessionId)
  if (readBack !== rewritten.text || verified.ok !== true) {
    return { updated: false, backup: basename(backupPath), reason: '写后校验不通过：文件内容与预期不一致（备份已保留，可用备份回滚）' }
  }
  return {
    updated: true,
    backup: basename(backupPath),
    changed: rewritten.changed,
    validated: true,
  }
}
