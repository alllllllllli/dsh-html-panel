/**
 * Host half of `dsh-html-panel`.
 *
 * Owns four things:
 *
 * 1. The HTTP route that serves this package's own `public/` directory. The
 *    page the sidebar panel shows is an ordinary file (`public/index.html`)
 *    read from disk on every request, so editing the HTML and refreshing the
 *    GUI is the whole edit loop — no client rebuild, no repackage, no Host
 *    restart.
 * 2. `GET /dsh-html-panel/api/cluster` — a read-only snapshot of this
 *    instance's interconnect links, built by `lib/cluster.js` from
 *    `ctx.interconnect.peers()` / `selfSender()` (both local and synchronous;
 *    `ping()`/`list()` are not used, so the panel never waits on a network
 *    round-trip). The page fetches this same-origin path for its cluster
 *    topology and falls back to its mock when it is unavailable.
 * 3. `GET /dsh-html-panel/api/board` — a read-only view of two independent
 *    task sources: the shared board (`dsh-team-mesh`'s HTTP service,
 *    `x-team-token` header) and the official Agent Teams projection
 *    (`ctx.sessionProjections.snapshot(session).values.agentTeam`, read-only,
 *    live root sessions only). `lib/board.js` builds both; the shared-board
 *    half never leaks the token (it only travels in the request header) and
 *    the official half degrades to `{ available:false, reason }` instead of
 *    inventing tasks.
 * 4. `GET /dsh-html-panel/api/host` — a read-only snapshot of the local
 *    machine (`node:os` + `fs.statfs`), built by `lib/host.js`. Zero external
 *    dependencies, zero external links.
 * 5. `GET /dsh-html-panel/api/tiers` — the right-hand "派活层级" tree
 *    (T0 大管家 → T1 会话 → T2/T3 子代理), built by `lib/tiers.js` from the
 *    live Host services (`ctx.sessions` headers carry the real
 *    `origin`/`parentSession` lineage, `ctx.agents` the run state,
 *    `ctx.sessionProjections` the titles) plus `ctx.interconnect.list()` for
 *    peers whose link is up. Read-only, 4 s cache, 2 s remote timeout; every
 *    failure is a structured `degraded` field, never an error page.
 * 6. `GET /dsh-html-panel/api/alerts` (0.6.0) — 规则化异常告警，搬自 TRAIL 的
 *    失败分类体系（MIT，见 `lib/trail.LICENSE`）。`lib/trail.js` 用一个纯函数把
 *    `api/board` + `api/tiers` 的**已有快照**（复用它们自己的缓存，不另开网络请求）
 *    映射成 `{severity, category, subject, why, evidence[], suggestion}` 数组；
 *    4 s 缓存、任何失败结构化降级，**不接 LLM、不花钱、不编数据**。
 * 7. `GET /dsh-html-panel/api/butler/sessions` (0.7.0 M0) — 大管家驾驶舱的可管理对象
 *    清单：本机会话 + 官方子代理血缘（复用 `api/tiers` 的同一份 4 s reader，不复制
 *    第二套血缘）+ `sessionController.state()` 的排队/等审批/等回答 + `updatedAt`，
 *    以及跨机对端（interconnect，**只读不可控**）。`lib/butler.js` 组装。
 * 8. `GET /dsh-html-panel/api/butler/dialog` (0.7.0 M1) — 中栏真实对话只读流：
 *    `sessionController.events()` 分页读尾部页，按 seq 去重归一化，工具调用压成折叠卡。
 *    绑定会话由 config `butler.sessionId` 或「最近有主人消息的根会话」决定；找不到就
 *    `available:false + reason`，**绝不编造对话**。写通道（say）M2 才开，0.7.0 没有。
 * 9. `POST /dsh-html-panel/api/action` — the page's only write path. A JSON
 *    body carrying **one whitelisted action id** (never a path, command or
 *    URL) runs `lib/actions.js` and answers a structured result. It is a raw
 *    handler route, not a `resource`: `webServer` routes resources GET/HEAD
 *    only (`dsh-host-webserver/src/index.ts`: "Only GET and HEAD reach it; any
 *    other method receives 405"), while a handler owns the whole exchange and
 *    can take POST. Non-POST, foreign `Origin`, non-JSON, oversized or unknown
 *    bodies are rejected before any side effect.
 * 10. `POST /dsh-html-panel/api/butler/say` (0.8.0 M2) — the conversation write
 *    channel. `lib/butler-write.js` owns every policy: injected per-process
 *    token (`x-butler-write-token`, never in any JSON/log), `butler.allowWrite`,
 *    one whitelisted session id (`butler.sessionId`), 10/min rate limit,
 *    requestId dedupe, then the real `sessionController.prompt({mode:'queue'})`.
 * 11. `POST /dsh-html-panel/api/butler/session` (0.8.0 M2) — create/rebuild the
 *    dedicated butler session (`sessionController.create` + `rename` to
 *    「大管家 · 常驻」) and write the new id back into `cordis.patch.yml`
 *    (timestamped backup + targeted validation, no other config line touched).
 *    The page's own HTML gets the token through a marker replaced while the
 *    file is served; `public/index.html` on disk stays token-free.
 *
 * The page also still tolerates the legacy snapshot route (a JSON file or URL
 * named in `config.snapshot`; 204 when unconfigured), kept for
 * `lib/client.js`'s `postMessage` delivery. The V6 page ignores that message.
 *
 * Why the `postMessage` itself lives in `lib/client.js`: only the frame that
 * holds the `<iframe>` element can post into it, and that frame is the browser
 * half. This module produces the snapshot, the browser half delivers it — the
 * message shape is documented in this package's README.
 */
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACTION_LATEST_REPORT, ACTION_OPEN_REPORTS, ACTION_PROBE_MEMORY, ACTION_WHITELIST,
  readActionConfig, runAction,
} from './actions.js'
import { createBoardReader } from './board.js'
import { createButlerReader, fallbackButlerDialog, fallbackButlerSessions, resolveStreamTarget } from './butler.js'
import {
  BUTLER_STREAM_FILE, createButlerLiveHub, handleButlerStreamRequest,
} from './butler-stream.js'
import {
  BUTLER_SAY_FILE, BUTLER_SESSION_FILE, WRITE_BODY_MAX_BYTES,
  createWriteChannel,
} from './butler-write.js'

/**
 * Child paths of the two M2 write endpoints (0.8.0), re-exported here so tests
 * and the README have one canonical place to read them from. The definitions
 * live in `lib/butler-write.js` next to the channel that owns them.
 */
export { BUTLER_SAY_FILE, BUTLER_SESSION_FILE }

/** 0.9.2：官方模型目录（只读）与模型切换（写通道）子路径。 */
export const BUTLER_MODEL_CATALOG_FILE = 'api/butler/model-catalog'
export const BUTLER_SELECT_MODEL_FILE = 'api/butler/select-model'
import { buildCluster } from './cluster.js'
import { buildHostInfo } from './host.js'
import { createTiersReader, fallbackTiers } from './tiers.js'
import { createAlertsReader, fallbackAlerts } from './trail.js'

/** Route prefix owned by this plugin; keep in sync with `lib/client.js`. */
export const ROUTE_PREFIX = '/dsh-html-panel'

/** Absolute path of the `public/` directory that backs the route. */
export const PUBLIC_ROOT = resolve(fileURLToPath(new URL('../public', import.meta.url)))

/**
 * Child path under {@link ROUTE_PREFIX} that answers the read-only snapshot.
 * Reserved: `public/` must not contain a file of this name.
 */
export const SNAPSHOT_FILE = 'snapshot.json'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the read-only cluster
 * snapshot (real interconnect links). Reserved as well; it shares the `api/`
 * namespace, which only ever answers JSON.
 */
export const CLUSTER_FILE = 'api/cluster'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the read-only shared-board
 * snapshot (tasks + events + board health). Reserved like the two above.
 */
export const BOARD_FILE = 'api/board'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the read-only local host
 * snapshot (memory / cpu / disks). Reserved like the two above.
 */
export const HOST_FILE = 'api/host'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the read-only dispatch-tier
 * snapshot (T0 大管家 → T1 sessions → T2/T3 subagents). Reserved as well.
 */
export const TIERS_FILE = 'api/tiers'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the read-only alert
 * snapshot (TRAIL-based rule classifier, 0.6.0). Reserved as well.
 */
export const ALERTS_FILE = 'api/alerts'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the Butler cockpit's
 * manageable-object list (M0, 0.7.0): local sessions + official subagent
 * lineage + live `sessionController.state()` + read-only remote peers.
 * Reserved as well.
 */
export const BUTLER_SESSIONS_FILE = 'api/butler/sessions'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the Butler cockpit's
 * real conversation stream (M1, 0.7.0): paged `sessionController.events()` of
 * one bound session, normalized for the page. Reserved as well.
 */
export const BUTLER_DIALOG_FILE = 'api/butler/dialog'

/**
 * Child path under {@link ROUTE_PREFIX} that answers the SSE live stream
 * (0.9.0): `GET api/butler/dialog/stream?sessionId=…`，只读、Host/Origin
 * fence、`text/event-stream`。它与 M1 的 `api/butler/dialog` 同级鉴权（不校验
 * 写 token —— EventSource 只能把 token 放进 URL，绝不能那么做）。
 */
export { BUTLER_STREAM_FILE }

/** Exact absolute path of the SSE live stream endpoint. */
const BUTLER_STREAM_PATH = ROUTE_PREFIX + '/' + BUTLER_STREAM_FILE

/**
 * Marker inside `public/index.html` that the Host replaces with the injected
 * write-channel config. The token only ever reaches the page's own script; it
 * is never part of any JSON response, log line or error message.
 */
export const WRITE_INJECT_MARKER = '/*__DSH_PANEL_WRITE__*/null'

/** Exact absolute path of the write-channel say endpoint. */
const BUTLER_SAY_PATH = ROUTE_PREFIX + '/' + BUTLER_SAY_FILE

/** Exact absolute path of the dedicated-session endpoint. */
const BUTLER_SESSION_PATH = ROUTE_PREFIX + '/' + BUTLER_SESSION_FILE

/** 0.9.2：官方模型目录 / 模型切换 exact 路径。 */
const BUTLER_MODEL_CATALOG_PATH = ROUTE_PREFIX + '/' + BUTLER_MODEL_CATALOG_FILE
const BUTLER_SELECT_MODEL_PATH = ROUTE_PREFIX + '/' + BUTLER_SELECT_MODEL_FILE

/**
 * Child path under {@link ROUTE_PREFIX} that answers the write action endpoint.
 * It is registered as an exact raw handler (see `apply`) so POST reaches it;
 * a `resource` route would be answered with 405 before our code runs.
 */
export const ACTION_FILE = 'api/action'

/** Exact absolute path of the action endpoint. */
const ACTION_PATH = ROUTE_PREFIX + '/' + ACTION_FILE

/** Action request body ceiling: one whitelisted id never needs more. */
const ACTION_MAX_BODY_BYTES = 4096

/** Ceiling on one snapshot body, so a misconfigured source cannot exhaust memory. */
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024

/** Timeout for a configured snapshot URL. */
const SNAPSHOT_URL_TIMEOUT_MS = 5000

/** Media types for the file kinds a panel page realistically ships. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * The Host services this plugin uses.
 *
 * `webServer` is hard-required: without it there is no route. `interconnect`
 * is declared so the service is attached by the time `apply()` runs (a cordis
 * Service read without injection may still be undefined), but **absence is
 * tolerated**: `ctx.interconnect` is read lazily per request and the cluster
 * route answers `interconnect: false` instead of throwing.
 */
export const inject = ['webServer', 'interconnect']

/**
 * Resolve one request pathname to a file under {@link PUBLIC_ROOT}.
 * @param pathname - Request pathname, already stripped of {@link ROUTE_PREFIX}.
 * @returns the absolute file path, or undefined when it escapes the root.
 */
function resolveTarget(pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = resolve(normalize(join(PUBLIC_ROOT, relative === '' ? 'index.html' : relative)))
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) return undefined
  return target
}

/**
 * Normalize the plugin row's config into a snapshot source.
 *
 * Accepts the documented shape `{ snapshot: { path, url } }` and, as a
 * shorthand, a flat `{ path, url }`. Both fields are optional and validated by
 * hand: this package ships no dependency on a schema library.
 *
 * @param config - The plugin row's `config` (may be undefined).
 * @returns `{ path, url }`, each either a trimmed string or `''`.
 */
function readSnapshotSource(config) {
  const shaped = config && typeof config === 'object'
    ? (config.snapshot && typeof config.snapshot === 'object' ? config.snapshot : config)
    : {}
  return {
    path: typeof shaped.path === 'string' ? shaped.path.trim() : '',
    url: typeof shaped.url === 'string' ? shaped.url.trim() : '',
  }
}

/**
 * Read the configured source and shape the message the page expects.
 * @param source - Snapshot source from {@link readSnapshotSource}.
 * @returns the snapshot message, or undefined when no source is configured.
 */
async function loadSnapshotMessage(source) {
  let text
  let origin
  if (source.path) {
    const target = isAbsolute(source.path) ? source.path : resolve(source.path)
    origin = `file ${target}`
    text = await readFile(target, 'utf8')
  } else {
    const url = new URL(source.url)
    // Report the origin only: a URL may carry a query token, and nothing here
    // may put a credential on screen.
    origin = `url ${url.origin}`
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(SNAPSHOT_URL_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`snapshot URL answered ${response.status}`)
    text = await response.text()
  }
  if (text.length > SNAPSHOT_MAX_BYTES) {
    throw new Error(`snapshot is larger than ${SNAPSHOT_MAX_BYTES} bytes`)
  }
  const parsed = JSON.parse(text)
  const root = Array.isArray(parsed) ? { tasks: parsed } : parsed
  if (!root || typeof root !== 'object') throw new Error('snapshot root is neither an object nor an array')
  return {
    type: 'snapshot',
    generatedAt: Date.now(),
    source: origin,
    tasks: Array.isArray(root.tasks) ? root.tasks : [],
    events: Array.isArray(root.events) ? root.events : [],
    nodes: Array.isArray(root.nodes) ? root.nodes : [],
  }
}

/**
 * Build a JSON response for one of the reserved child paths.
 * @param body - JSON-serializable payload.
 * @param status - HTTP status; 200 unless the source failed.
 * @param headOnly - true for a HEAD request: same headers, no body.
 * @param extraHeaders - additional response headers (e.g. `Allow`).
 * @returns the response, always `no-store`.
 */
function jsonResponse(body, status = 200, headOnly = false, extraHeaders = {}) {
  return new Response(headOnly ? null : JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  })
}

/** true for the only methods the read-only `api/` routes answer. */
function isReadMethod(request) {
  return request.method === 'GET' || request.method === 'HEAD'
}

/**
 * The 405 answer for a non-GET/HEAD request to an `api/` route: JSON with the
 * allowed methods, never HTML.
 * @returns {Response} 405 with `{ ok:false, error:'method-not-allowed' }`.
 */
function methodNotAllowed() {
  return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, false, { allow: 'GET, HEAD' })
}

/**
 * Write one JSON response onto a raw handler's `ServerResponse`.
 * @param res - Node response owned by the action handler.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload (never a stack trace).
 * @param extraHeaders - additional response headers (e.g. `allow`).
 */
function writeJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(text)
}

/**
 * Reject a request whose `Origin` names another host. Same-origin `fetch` from
 * the panel always sends the DSH origin; a foreign page cannot send a matching
 * one. A request without `Origin` (curl, tests) is allowed — it is not a
 * browser cross-site write.
 * @param req - Node request.
 * @returns a human reason, or undefined when the origin is acceptable.
 */
function originRejection(req) {
  const raw = req.headers.origin
  if (typeof raw !== 'string' || raw === '') return undefined
  const host = req.headers.host
  let originHost
  try {
    originHost = new URL(raw).host
  } catch {
    return '请求来源（Origin）不是合法 URL'
  }
  if (typeof host !== 'string' || originHost !== host) {
    return '拒绝跨站来源（Origin 与 Host 不一致）'
  }
  return undefined
}

/**
 * Read one action request body and validate its envelope.
 *
 * Ordering is deliberate: method → origin → content-type → size → JSON →
 * whitelist. Every rejection happens before `lib/actions.js` can touch the
 * filesystem, the network or a child process.
 *
 * @param req - Node request.
 * @returns `{ ok:true, action }` or `{ ok:false, status, code, reason, extra }`.
 */
async function readActionRequest(req) {
  if (req.method !== 'POST') {
    return { ok: false, status: 405, code: 'method-not-allowed', reason: '动作端点只接受 POST', extra: { allow: 'POST' } }
  }
  const originReason = originRejection(req)
  if (originReason !== undefined) {
    return { ok: false, status: 403, code: 'origin-rejected', reason: originReason }
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, code: 'unsupported-media-type', reason: '动作请求必须是 application/json' }
  }

  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > ACTION_MAX_BODY_BYTES) {
        return { ok: false, status: 413, code: 'body-too-large', reason: '动作请求体超过 ' + ACTION_MAX_BODY_BYTES + ' 字节' }
      }
      chunks.push(chunk)
    }
  } catch {
    return { ok: false, status: 400, code: 'body-read-failed', reason: '读取动作请求体失败' }
  }

  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { ok: false, status: 400, code: 'bad-json', reason: '动作请求体不是合法 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: 'bad-body', reason: '动作请求体必须是 JSON 对象' }
  }
  const action = typeof parsed.action === 'string' ? parsed.action.trim() : ''
  if (action === '' || !ACTION_WHITELIST.includes(action)) {
    return { ok: false, status: 400, code: 'unknown-action', reason: '未知动作：只接受白名单动作' }
  }
  return { ok: true, action }
}

/**
 * Answer `POST /dsh-html-panel/api/action` as a raw handler (the only route
 * method here that is not GET/HEAD).
 *
 * Always answers JSON and never throws: validation failures get their 4xx,
 * a business failure keeps 200 with `{ok:false, code, reason}` (same contract
 * as the read-only routes), and an unexpected throw becomes a generic 500
 * without a stack, a token, or a path.
 *
 * @param req - Node request.
 * @param res - Node response.
 * @param deps - `{ actions, logger }`; `deps.actions` is the resolved action config.
 * @returns completion once the response is written.
 */
export async function handleActionRequest(req, res, deps) {
  try {
    const envelope = await readActionRequest(req)
    if (!envelope.ok) {
      writeJson(res, envelope.status, { ok: false, code: envelope.code, reason: envelope.reason }, envelope.extra)
      return
    }
    const result = await runAction(envelope.action, deps.actions, deps.actionDeps)
    writeJson(res, 200, result)
  } catch (error) {
    // 不把内部异常写进响应；只记一条给 DSH 日志。
    try {
      deps.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      /* 日志失败不影响响应 */
    }
    if (!res.headersSent) {
      writeJson(res, 500, { ok: false, code: 'action-failed', reason: '动作执行失败（详见 DSH 宿主日志）' })
    } else {
      res.end()
    }
  }
}

/**
 * Read one JSON body for a write route, with the same validate-before-act
 * ordering as the action endpoint: method → origin → content-type → size →
 * JSON object. Never returns a stack trace or echoes the body.
 *
 * @param {import('node:http').IncomingMessage} req - Node request.
 * @param {number} maxBytes - body ceiling; larger is a 413.
 * @returns {Promise<{ok:true, value:unknown} | {ok:false, status:number, code:string, reason:string, extra?:object}>}
 */
async function readJsonWriteRequest(req, maxBytes) {
  if (req.method !== 'POST') {
    return { ok: false, status: 405, code: 'method-not-allowed', reason: '该写通道只接受 POST', extra: { allow: 'POST' } }
  }
  const originReason = originRejection(req)
  if (originReason !== undefined) {
    return { ok: false, status: 403, code: 'origin-rejected', reason: originReason }
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, code: 'unsupported-media-type', reason: '请求必须是 application/json' }
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) {
        return { ok: false, status: 413, code: 'body-too-large', reason: '请求体超过 ' + maxBytes + ' 字节' }
      }
      chunks.push(chunk)
    }
  } catch {
    return { ok: false, status: 400, code: 'body-read-failed', reason: '读取请求体失败' }
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { ok: false, status: 400, code: 'bad-json', reason: '请求体不是合法 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: 'bad-body', reason: '请求体必须是 JSON 对象' }
  }
  return { ok: true, value: parsed }
}

/**
 * Answer `GET /dsh-html-panel/api/butler/model-catalog` (0.9.2) as a raw handler.
 *
 * 只读：官方 `sessionController.modelCatalog()` 的 provider 分组 + 部署默认模型；
 * 当前会话模型与权限取自官方 `sessionController.list()` 的 projections
 * （modelSelection / permissions），不在这里维护第二套状态。不校验写 token。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{write:object, logger?:object}} deps
 * @returns {Promise<void>}
 */
export async function handleButlerModelCatalogRequest(req, res, deps) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', reason: '模型目录只接受 GET' }, { allow: 'GET' })
      return
    }
    const result = await deps.write.modelCatalog()
    if (req.method === 'HEAD') { res.statusCode = result.status; res.end(); return }
    writeJson(res, result.status, result.body)
  } catch (error) {
    try { deps.logger?.warn?.(error instanceof Error ? error : new Error(String(error))) } catch { /* 日志失败不影响响应 */ }
    if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'model-catalog-failed', reason: '读取模型目录失败（详见 DSH 宿主日志）' })
    else res.end()
  }
}

/**
 * Answer `POST /dsh-html-panel/api/butler/select-model` (0.9.2) as a raw handler.
 *
 * Body: `{ sessionId, provider, model, reasoningEffort?, requestId? }`。所有策略在写
 * 通道里：token、allowWrite、仅绑定会话、参数上限、requestId 幂等、官方
 * `sessionController.selectModel()`；二次确认由页面在调用前弹。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{write:object, logger?:object}} deps
 * @returns {Promise<void>}
 */
export async function handleButlerSelectModelRequest(req, res, deps) {
  try {
    const envelope = await readJsonWriteRequest(req, WRITE_BODY_MAX_BYTES)
    if (envelope.ok !== true) {
      writeJson(res, envelope.status, { ok: false, code: envelope.code, reason: envelope.reason }, envelope.extra)
      return
    }
    const result = await deps.write.selectModel(req.headers, envelope.value)
    writeJson(res, result.status, result.body, result.extraHeaders)
  } catch (error) {
    try { deps.logger?.warn?.(error instanceof Error ? error : new Error(String(error))) } catch { /* 日志失败不影响响应 */ }
    if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'select-model-failed', reason: '模型切换执行失败（详见 DSH 宿主日志）' })
    else res.end()
  }
}

/**
 * Answer `POST /dsh-html-panel/api/butler/say` (M2, 0.8.0) as a raw handler.
 *
 * The channel itself owns every policy: token, `allowWrite`, whitelist of the
 * one configured session, rate limit, requestId dedupe and the real
 * `sessionController.prompt()` call. This handler only does the transport
 * envelope and never lets an exception text (or the token) reach the page.
 *
 * @param {import('node:http').IncomingMessage} req - Node request.
 * @param {import('node:http').ServerResponse} res - Node response.
 * @param {{write:object, logger?:object}} deps - write channel + logger.
 * @returns {Promise<void>} completion once the response is written.
 */
export async function handleButlerSayRequest(req, res, deps) {
  try {
    const envelope = await readJsonWriteRequest(req, WRITE_BODY_MAX_BYTES)
    if (envelope.ok !== true) {
      writeJson(res, envelope.status, { ok: false, code: envelope.code, reason: envelope.reason }, envelope.extra)
      return
    }
    const result = await deps.write.say(req.headers, envelope.value)
    writeJson(res, result.status, result.body, result.extraHeaders)
  } catch (error) {
    try {
      deps.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      /* 日志失败不影响响应 */
    }
    if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'say-failed', reason: '写通道执行失败（详见 DSH 宿主日志）' })
    else res.end()
  }
}

/**
 * Answer `POST /dsh-html-panel/api/butler/session` (M2, 0.8.0) as a raw handler.
 *
 * Body: `{ action: 'ensure' | 'rebuild' }`. Creates a real root session through
 * `sessionController.create()`, renames it to the configured label, and writes
 * the new session id back into `cordis.patch.yml` (backup + targeted checks in
 * `lib/butler-write.js`). Same token gate as the say route — the page gets the
 * token from its injected script only.
 *
 * @param {import('node:http').IncomingMessage} req - Node request.
 * @param {import('node:http').ServerResponse} res - Node response.
 * @param {{write:object, logger?:object}} deps - write channel + logger.
 * @returns {Promise<void>} completion once the response is written.
 */
export async function handleButlerSessionRequest(req, res, deps) {
  try {
    const envelope = await readJsonWriteRequest(req, WRITE_BODY_MAX_BYTES)
    if (envelope.ok !== true) {
      writeJson(res, envelope.status, { ok: false, code: envelope.code, reason: envelope.reason }, envelope.extra)
      return
    }
    const result = await deps.write.ensureSession(req.headers, envelope.value)
    writeJson(res, result.status, result.body)
  } catch (error) {
    try {
      deps.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      /* 日志失败不影响响应 */
    }
    if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'session-action-failed', reason: '会话创建/重建失败（详见 DSH 宿主日志）' })
    else res.end()
  }
}

/**
 * Replace the write-channel marker in the page HTML with the injected config.
 *
 * The token is handed to the page's own `<script>` only. Nothing else in this
 * package may put it into a JSON body, a log line or an error message.
 * `<` is escaped anyway so an unexpected token can never close the script tag.
 *
 * @param {string} text - `public/index.html` source.
 * @param {{allowWrite:boolean, label:string, token:string, sessionId:string}} config - page config.
 * @returns {string} HTML with the marker replaced (unchanged when absent).
 */
export function injectWriteConfig(text, config) {
  if (typeof text !== 'string' || text.indexOf(WRITE_INJECT_MARKER) === -1) return text
  const payload = {
    allowWrite: config && config.allowWrite === true,
    label: config && typeof config.label === 'string' ? config.label : '大管家 · 常驻',
    token: config && typeof config.token === 'string' ? config.token : '',
    sessionId: config && typeof config.sessionId === 'string' ? config.sessionId : '',
  }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  return text.replace(WRITE_INJECT_MARKER, '/*__DSH_PANEL_WRITE__*/' + json)
}
/**
 * Read `ctx.interconnect` at request time.
 *
 * Declaring `interconnect` in {@link inject} gets the service attached before
 * `apply()`, but a plugin must still survive it being absent (older profiles,
 * a service that failed to activate). Reading lazily also means a service that
 * comes up after this plugin starts is picked up without a restart.
 *
 * @param ctx - Host context.
 * @returns the interconnect service, or null.
 */
function interconnectOf(ctx) {
  try {
    return ctx?.interconnect ?? null
  } catch {
    return null
  }
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/cluster`.
 *
 * Always answers JSON, and a read failure is not a 5xx: the page wants a
 * usable "no interconnect data" answer, not an error page. A non-GET/HEAD
 * request is a 405 in the same JSON shape, so callers never get HTML.
 *
 * @param request - The incoming request.
 * @param interconnect - `ctx.interconnect` or null.
 * @returns 200 with the cluster snapshot, or 405 for other methods.
 */
function serveCluster(request, interconnect) {
  if (!isReadMethod(request)) return methodNotAllowed()
  let body
  try {
    body = buildCluster(interconnect)
  } catch {
    // buildCluster 自己吞了所有已知失败；走到这里说明有意料之外的东西。
    // 降级成同一份契约（interconnect:false），页面会落到 mock 兜底。
    body = {
      generatedAt: new Date().toISOString(),
      interconnect: false,
      self: { instanceId: 'unknown' },
      peers: [],
      board: null,
    }
  }
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Read an optional Host service through the cordis context.
 *
 * `webServer` is the only hard dependency; every other service (interconnect,
 * sessions, agents, sessionProjections) is read lazily per request so the panel
 * still renders on a profile that lacks one of them. A throwing accessor is
 * treated as absent rather than as a request failure.
 *
 * @param ctx - Host context.
 * @param name - service name, e.g. `sessions`.
 * @returns the service, or null when absent.
 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? (ctx.get(name) ?? null) : null
  } catch {
    return null
  }
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/tiers`.
 *
 * The tree is assembled by `lib/tiers.js`: live local sessions + their real
 * subagent lineage (`origin`/`parentSession` from the Session headers), plus
 * `interconnect.list()` for peers whose link is up. It never throws: a degraded
 * answer still carries T0 so the page can render the root and say why.
 *
 * @param request - The incoming request.
 * @param tiers - Reader from {@link createTiersReader}.
 * @returns 200 with the tier snapshot, or 405 for other methods.
 */
async function serveTiers(request, tiers) {
  if (!isReadMethod(request)) return methodNotAllowed()
  let body
  try {
    body = await tiers.read()
  } catch {
    // 组装层的意外异常：不把 stack 交给页面，降级成同一契约。
    body = fallbackTiers('层级快照生成失败（详见 DSH 宿主日志）')
  }
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/alerts` (0.6.0).
 *
 * The classifier in `lib/trail.js` never throws and always returns the same
 * JSON shape; an unexpected throw is folded into {@link fallbackAlerts} so the
 * page gets a usable "no alert data" body instead of an error page (same
 * degradation style as the tiers/board routes).
 *
 * @param request - The incoming request.
 * @param alerts - Reader from {@link createAlertsReader}.
 * @returns 200 with the alert snapshot, or 405 for other methods.
 */
async function serveAlerts(request, alerts) {
  if (!isReadMethod(request)) return methodNotAllowed()
  let body
  try {
    body = await alerts.read()
  } catch {
    body = fallbackAlerts('告警快照生成失败（详见 DSH 宿主日志）')
  }
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/butler/sessions` (0.7.0 M0).
 *
 * `lib/butler.js` never throws and always returns the same JSON shape; an
 * unexpected throw is folded into {@link fallbackButlerSessions} so the page
 * gets a usable "no session data" body instead of an error page (same
 * degradation style as the tiers/board routes).
 *
 * @param request - The incoming request.
 * @param butler - Reader from {@link createButlerReader}.
 * @returns 200 with the session list, or 405 for other methods.
 */
async function serveButlerSessions(request, butler) {
  if (!isReadMethod(request)) return methodNotAllowed()
  let body
  try {
    body = await butler.readSessions()
  } catch {
    body = fallbackButlerSessions('会话清单生成失败（详见 DSH 宿主日志）')
  }
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/butler/dialog` (0.7.0 M1).
 *
 * Query: `sessionId` (optional; omission uses the config/recent-root binding),
 * `limit` (1-50), `before` (exclusive upper seq for older pages). The reader
 * normalizes every failure into `{ available:false, reason }` instead of an
 * HTML error page, so the middle column can say why it has no conversation.
 *
 * @param request - The incoming request.
 * @param butler - Reader from {@link createButlerReader}.
 * @returns 200 with the dialog page, or 405 for other methods.
 */
async function serveButlerDialog(request, butler) {
  if (!isReadMethod(request)) return methodNotAllowed()
  let body
  try {
    const url = new URL(request.url)
    const query = {
      sessionId: url.searchParams.get('sessionId') ?? '',
      limit: url.searchParams.get('limit') ?? '',
      before: url.searchParams.get('before') ?? '',
    }
    body = await butler.readDialog(query)
  } catch {
    body = fallbackButlerDialog('真实对话读取失败（详见 DSH 宿主日志）')
  }
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/board`.
 *
 * `lib/board.js` normalizes every failure into a structured JSON body the page
 * can render (unconfigured / unreachable / bad response), so this handler never
 * throws and never answers an HTML error page. Status stays 200 on purpose: the
 * page reads `configured` + `error` and picks its own fallback.
 *
 * @param request - The incoming request.
 * @param board - Reader from {@link createBoardReader}.
 * @returns 200 with the board snapshot, or 405 for other methods.
 */
async function serveBoard(request, board) {
  if (!isReadMethod(request)) return methodNotAllowed()
  const body = await board.read()
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Answer `GET|HEAD /dsh-html-panel/api/host`.
 *
 * Local read-only facts, zero external dependencies. A read failure is folded
 * into the same JSON shape with an `error` object instead of a 5xx, so the page
 * can fall back to its labelled mock instead of white-screening.
 *
 * @param request - The incoming request.
 * @returns 200 with the host snapshot, or 405 for other methods.
 */
async function serveHost(request) {
  if (!isReadMethod(request)) return methodNotAllowed()
  let body
  try {
    body = await buildHostInfo()
  } catch {
    body = {
      generatedAt: new Date().toISOString(),
      hostname: null,
      os: null,
      memory: null,
      cpu: null,
      disks: [],
      error: { code: 'host-read-failed', message: '读取本机信息失败' },
    }
  }
  return jsonResponse(body, 200, request.method === 'HEAD')
}

/**
 * Answer the reserved snapshot child path.
 *
 * The page never fetches this itself and never sees the source path: the
 * browser half reads it and forwards the payload with `postMessage`.
 *
 * @param source - Snapshot source from {@link readSnapshotSource}.
 * @returns 204 with no source configured, 200 with the message, or 502 with the
 *   reason (no credentials in it — only a local path or a URL origin).
 */
async function serveSnapshot(source) {
  if (!source.path && !source.url) {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }
  try {
    return jsonResponse(await loadSnapshotMessage(source))
  } catch (error) {
    return jsonResponse({ type: 'snapshot-error', message: String((error && error.message) || error) }, 502)
  }
}

/**
 * Answer a Fetch request with a file from `public/`, with the legacy snapshot,
 * or with one of the four read-only `api/` snapshots.
 *
 * The `api/` namespace is JSON-only: an unknown `api/...` path is a JSON 404
 * rather than an empty one, so a typo can never hand the page an HTML body.
 *
 * @param request - The incoming request; the webserver resource route only
 *   forwards GET/HEAD (the action endpoint is a separate exact handler).
 * @param deps - Per-request dependencies: snapshot source, interconnect getter,
 *   board reader, tiers reader.
 * @returns the file response, one of the JSON responses, or a short 403/404.
 */
async function servePublic(request, deps) {
  const relative = new URL(request.url).pathname
    .slice(ROUTE_PREFIX.length)
    .replace(/^\/+|\/+$/g, '')
  if (relative === SNAPSHOT_FILE) return serveSnapshot(deps.source)
  if (relative === CLUSTER_FILE) return serveCluster(request, deps.interconnect())
  if (relative === BOARD_FILE) return serveBoard(request, deps.board)
  if (relative === HOST_FILE) return serveHost(request)
  if (relative === TIERS_FILE) return serveTiers(request, deps.tiers)
  if (relative === ALERTS_FILE) return serveAlerts(request, deps.alerts)
  if (relative === BUTLER_SESSIONS_FILE) return serveButlerSessions(request, deps.butler)
  if (relative === BUTLER_DIALOG_FILE) return serveButlerDialog(request, deps.butler)
  if (relative === 'api' || relative.startsWith('api/')) {
    return jsonResponse({ ok: false, error: 'not-found' }, 404)
  }
  const pathname = '/' + relative
  const target = resolveTarget(pathname)
  if (target === undefined) return new Response(null, { status: 403 })
  let body
  try {
    body = await readFile(target)
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return new Response(null, { status: 404 })
    throw error
  }
  // 0.8.0：主页面在服务时注入写通道配置（token 只进页面 HTML）。文件本身保持无 token。
  if (request.method !== 'HEAD' && target === join(PUBLIC_ROOT, 'index.html') && deps.writePage !== undefined) {
    const pageConfig = typeof deps.writePage === 'function' ? deps.writePage() : deps.writePage
    body = Buffer.from(injectWriteConfig(body.toString('utf8'), pageConfig), 'utf8')
  }
  const headers = {
    // Always revalidate: editing public/index.html must show on a plain refresh.
    'cache-control': 'no-store',
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
  }
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
}

/**
 * Claim the `/dsh-html-panel` route for this plugin's `public/` directory,
 * remember the configured snapshot source for the legacy child path, answer
 * the three read-only `api/` snapshots, and register the POST action endpoint.
 *
 * `interconnect` is resolved per request: absent → the cluster route answers
 * `interconnect: false`; a service that activates late is picked up without a
 * restart. The board reader is created once per plugin instance and owns its
 * 3 s cache (`lib/board.js`).
 *
 * The action endpoint is an **exact handler route**: the webserver's resource
 * routes answer GET/HEAD only, so a POST would be turned into 405 before our
 * code ran. An exact route wins over the prefix route (the webserver matches
 * exact first), which is why `/dsh-html-panel/api/action` reaches the handler
 * even though the whole prefix is also claimed.
 *
 * @param ctx - Host context carrying the web server service.
 * @param config - Plugin row config; `config.board` configures the board read,
 *   `config.actions.memory|reports` configures the action endpoint,
 *   `config.snapshot` / flat `{ path, url }` keeps the legacy snapshot source.
 */
export function apply(ctx, config) {
  const source = readSnapshotSource(config)
  // 共享板读 HTTP；官方任务板读本机投影（两条数据源互相独立，各失败各降级）。
  const board = createBoardReader(config, {
    sessions: () => serviceOf(ctx, 'sessions'),
    projections: () => serviceOf(ctx, 'sessionProjections'),
  })
  const tiers = createTiersReader({
    interconnect: () => interconnectOf(ctx),
    sessions: () => serviceOf(ctx, 'sessions'),
    agents: () => serviceOf(ctx, 'agents'),
    projections: () => serviceOf(ctx, 'sessionProjections'),
  })
  // 0.6.0：告警分类器只吃上面两个 reader 的**现成快照**（复用它们自己的缓存），
  // 不新增任何网络/进程调用；两个源各自降级，谁也不拖垮谁。
  const alerts = createAlertsReader({ board, tiers })
  // 0.7.0 M0+M1：复用同一个 tiers reader（血缘/远端不复制第二套），再补
  // sessionController.list/state/events 三样只读服务；读不到就结构化降级。
  const butler = createButlerReader({
    interconnect: () => interconnectOf(ctx),
    sessions: () => serviceOf(ctx, 'sessions'),
    agents: () => serviceOf(ctx, 'agents'),
    projections: () => serviceOf(ctx, 'sessionProjections'),
    controller: () => serviceOf(ctx, 'sessionController'),
    tiers,
    config: config ?? {},
  })
  // 0.8.0 M2：写通道实例。token 在这里生成一次；配置对象保持引用，重建会话后原地
  // 更新 sessionId，M0 下一轮轮询即可看到新绑定（写盘是重启后仍生效的那一份）。
  const butlerWrite = createWriteChannel({
    controller: () => serviceOf(ctx, 'sessionController'),
    config: config ?? {},
    logger: ctx.logger,
  })
  // 0.9.0：assistant 增量 hub（只读监听宿主事件；SSE 只 GET，不碰写 token）。
  const butlerStream = createButlerLiveHub({ ctx, logger: ctx.logger })
  const streamDeps = {
    hub: butlerStream,
    targetOf: async requested => resolveStreamTarget(await butler.readSessions(), requested),
    logger: ctx.logger,
  }
  const deps = {
    source,
    board,
    tiers,
    alerts,
    butler,
    interconnect: () => interconnectOf(ctx),
    writePage: () => butlerWrite.pageConfig(),
  }
  const actionDeps = {
    actions: readActionConfig(config),
    logger: ctx.logger,
  }
  const writeDeps = {
    write: butlerWrite,
    logger: ctx.logger,
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    resource: request => servePublic(request, deps),
  }), `dsh-html-panel: GET ${ROUTE_PREFIX}/<file>`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: (req, res) => handleActionRequest(req, res, actionDeps),
  }), `dsh-html-panel: POST ${ACTION_PATH}`)
  // 0.8.0 M2：两条 exact raw handler（webserver 只对命名路由放行 POST）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BUTLER_SAY_PATH,
    handler: (req, res) => handleButlerSayRequest(req, res, writeDeps),
  }), `dsh-html-panel: POST ${BUTLER_SAY_PATH}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BUTLER_SESSION_PATH,
    handler: (req, res) => handleButlerSessionRequest(req, res, writeDeps),
  }), `dsh-html-panel: POST ${BUTLER_SESSION_PATH}`)
  // 0.9.0：SSE 实时增量（exact raw GET；handler 自己持有响应生命周期）。
  // 0.9.2：官方模型目录（只读）+ 模型切换（写通道 exact POST）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BUTLER_MODEL_CATALOG_PATH,
    handler: (req, res) => handleButlerModelCatalogRequest(req, res, writeDeps),
  }), `dsh-html-panel: GET ${BUTLER_MODEL_CATALOG_PATH}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BUTLER_SELECT_MODEL_PATH,
    handler: (req, res) => handleButlerSelectModelRequest(req, res, writeDeps),
  }), `dsh-html-panel: POST ${BUTLER_SELECT_MODEL_PATH}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BUTLER_STREAM_PATH,
    handler: (req, res) => handleButlerStreamRequest(req, res, streamDeps),
  }), `dsh-html-panel: GET ${BUTLER_STREAM_PATH}`)
}
