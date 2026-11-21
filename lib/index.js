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
 * 3. `GET /dsh-html-panel/api/board` — a read-only view of the shared board
 *    (`dsh-team-mesh`'s HTTP service, `x-team-token` header), built by
 *    `lib/board.js` from the endpoint/token in the plugin row's
 *    `config.board`. Unconfigured / unreachable / bad response all answer a
 *    structured JSON body the page can render, never an error page or a 5xx
 *    stack. Token never leaves the request header.
 * 4. `GET /dsh-html-panel/api/host` — a read-only snapshot of the local
 *    machine (`node:os` + `fs.statfs`), built by `lib/host.js`. Zero external
 *    dependencies, zero external links.
 * 5. `POST /dsh-html-panel/api/action` — the page's only write path. A JSON
 *    body carrying **one whitelisted action id** (never a path, command or
 *    URL) runs `lib/actions.js` and answers a structured result. It is a raw
 *    handler route, not a `resource`: `webServer` routes resources GET/HEAD
 *    only (`dsh-host-webserver/src/index.ts`: "Only GET and HEAD reach it; any
 *    other method receives 405"), while a handler owns the whole exchange and
 *    can take POST. Non-POST, foreign `Origin`, non-JSON, oversized or unknown
 *    bodies are rejected before any side effect.
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
import { buildCluster } from './cluster.js'
import { buildHostInfo } from './host.js'

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
 * or with one of the three read-only `api/` snapshots.
 *
 * The `api/` namespace is JSON-only: an unknown `api/...` path is a JSON 404
 * rather than an empty one, so a typo can never hand the page an HTML body.
 *
 * @param request - The incoming request; the webserver resource route only
 *   forwards GET/HEAD (the action endpoint is a separate exact handler).
 * @param deps - Per-request dependencies: snapshot source, interconnect getter,
 *   board reader.
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
  const board = createBoardReader(config)
  const deps = {
    source,
    board,
    interconnect: () => interconnectOf(ctx),
  }
  const actionDeps = {
    actions: readActionConfig(config),
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
}
