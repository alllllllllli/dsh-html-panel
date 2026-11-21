/**
 * Host half of `dsh-html-panel`'s action endpoint — the only write path the
 * panel's page can reach.
 *
 * The page posts `{ action }` to `POST /dsh-html-panel/api/action`; this module
 * decides what each whitelisted id does. Two rules shape everything here:
 *
 * 1. **The client never supplies a path, command, URL or argument.** Every
 *    filesystem path and URL is derived from the plugin row's `config` (or a
 *    built-in default); the request carries an action id and nothing else.
 * 2. **Nothing is invented.** `probe-memory` really fetches the configured
 *    OpenViking origin, `latest-report` really reads the newest markdown file,
 *    `open-reports-folder` really asks Explorer to open the fixed directory.
 *    A failure is returned as `{ ok:false, code, reason }` with a human reason —
 *    never a fake success.
 *
 * Failures never carry a stack trace, a request URL with credentials, or the
 * board token: `reason` is a hand-written sentence, `code` a stable token.
 *
 * All side effects go through `deps`, so the unit tests can inject fake
 * `fetch`/`spawn`/`fs` without touching the real machine.
 */
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Stable id: probe the configured OpenViking origin and return its URL. */
export const ACTION_PROBE_MEMORY = 'probe-memory'
/** Stable id: newest markdown file under the reports directory, plus content. */
export const ACTION_LATEST_REPORT = 'latest-report'
/** Stable id: open the reports directory in Explorer (fixed path). */
export const ACTION_OPEN_REPORTS = 'open-reports-folder'

/**
 * The complete action whitelist. Anything not in here is rejected before any
 * filesystem, network or process work happens.
 */
export const ACTION_WHITELIST = Object.freeze([
  ACTION_PROBE_MEMORY,
  ACTION_LATEST_REPORT,
  ACTION_OPEN_REPORTS,
])

/** Default OpenViking Studio origin (mcloud, WideWired address). */
export const MEMORY_DEFAULT_URL = 'http://172.24.112.11:1933/'

/** Probe ceiling: a page click should not wait longer than this. */
export const MEMORY_TIMEOUT_MS = 1500

/** Newest-report read ceiling; content is truncated (flagged) beyond it. */
export const REPORT_MAX_BYTES = 64 * 1024

/** Ceiling on directory entries inspected when looking for the newest report. */
export const REPORT_MAX_ENTRIES = 400

/** Spawn confirmation ceiling; only covers process creation, not the app. */
export const SPAWN_SETTLE_MS = 2000

/**
 * Resolve the reports directory without a hard-coded user path: by default the
 * `mesh-0.6-dev` workspace under the OS home, overridable in the plugin row.
 * @returns {string} absolute path
 */
export function defaultReportsDir() {
  return join(homedir(), 'mesh-0.6-dev', 'repo', 'docs')
}

/** Accept only an absolute Windows/POSIX directory path from config. */
function readDirectoryOption(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  return isAbsolute(trimmed) ? resolve(trimmed) : undefined
}

/**
 * Normalize the plugin row's config into the action endpoint's fixed settings.
 *
 * Accepted shapes:
 *   `{ actions: { memory: { url }, reports: { dir } } }`
 *   `{ memory: { url }, reports: { dir } }` (flat shorthand)
 *
 * @param {unknown} pluginConfig the plugin row's `config` (may be undefined)
 * @returns {{memory: {url: string, origin: string}, reports: {dir: string},
 *   errors: string[]}}
 */
export function readActionConfig(pluginConfig) {
  const shaped = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {}
  const nested = shaped.actions && typeof shaped.actions === 'object' ? shaped.actions : {}
  const memory = nested.memory && typeof nested.memory === 'object'
    ? nested.memory
    : (shaped.memory && typeof shaped.memory === 'object' ? shaped.memory : {})
  const reports = nested.reports && typeof nested.reports === 'object'
    ? nested.reports
    : (shaped.reports && typeof shaped.reports === 'object' ? shaped.reports : {})

  const errors = []
  let url = MEMORY_DEFAULT_URL
  const rawUrl = typeof memory.url === 'string' ? memory.url.trim() : ''
  if (rawUrl !== '') {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push('config.actions.memory.url 只支持 http/https')
      } else if (parsed.username !== '' || parsed.password !== '') {
        // Credentials in a URL must never reach the page or a log line.
        errors.push('config.actions.memory.url 不允许携带用户名/密码')
      } else {
        parsed.hash = ''
        url = parsed.href
      }
    } catch {
      errors.push('config.actions.memory.url 不是合法 URL')
    }
  }
  if (!url.endsWith('/')) url += '/'

  const configuredReports = readDirectoryOption(reports.dir)
  if (reports.dir !== undefined && configuredReports === undefined) {
    errors.push('config.actions.reports.dir 必须是绝对路径')
  }

  return {
    memory: { url, origin: new URL(url).origin },
    reports: { dir: configuredReports ?? defaultReportsDir() },
    errors,
  }
}

/** A failure result; every reason is a sentence written here, never an error object. */
function failure(action, code, reason) {
  return { ok: false, action, code, reason }
}

/** Network-error code → one short human clause. */
function describeNetworkError(error) {
  const name = error && error.name
  if (name === 'TimeoutError' || name === 'AbortError') return '超时'
  const cause = error && error.cause
  const code = String((cause && cause.code) || (error && error.code) || '')
  if (code === 'ECONNREFUSED') return '连接被拒绝（ECONNREFUSED）'
  if (code === 'ENOTFOUND') return '域名解析失败（ENOTFOUND）'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达（' + code + '）'
  if (code !== '') return code
  return String((error && error.message) || '网络错误').slice(0, 120)
}

/**
 * Probe the configured OpenViking origin (GET the Studio entry page).
 *
 * Returns the page URL only when the origin really answered, so the page can
 * open it in a new tab; an unreachable origin yields `{ok:false}` with the
 * transport reason and is never opened silently.
 *
 * @param {ReturnType<typeof readActionConfig>} config
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function probeMemory(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const url = config.memory.url
  const started = Date.now()
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(deps.memoryTimeoutMs ?? MEMORY_TIMEOUT_MS),
    })
  } catch (error) {
    return failure(ACTION_PROBE_MEMORY, 'memory-unreachable',
      'OpenViking 不可达（' + config.memory.origin + '）：' + describeNetworkError(error))
  }
  const latencyMs = Math.max(0, Date.now() - started)
  if (response.status >= 400) {
    return failure(ACTION_PROBE_MEMORY, 'memory-http-' + response.status,
      'OpenViking 返回 HTTP ' + response.status + '（' + config.memory.origin + '）')
  }
  return {
    ok: true,
    action: ACTION_PROBE_MEMORY,
    url,
    origin: config.memory.origin,
    status: response.status,
    latencyMs,
  }
}

/** Reject a directory path that would escape the configured root. */
function insideDirectory(root, name) {
  const target = resolve(join(root, name))
  return target.startsWith(resolve(root) + sep) ? target : undefined
}

/**
 * Find the newest regular markdown file directly inside the reports directory.
 * @param {ReturnType<typeof readActionConfig>} config
 * @param {object} [deps]
 * @returns {Promise<{ok:true, action:string, dir:string, file:{name:string,
 *   path:string, mtime:number, size:number}} | {ok:false, action:string,
 *   code:string, reason:string}>}
 */
export async function findLatestReport(config, deps = {}) {
  const readdirImpl = deps.readdirImpl ?? readdir
  const statImpl = deps.statImpl ?? stat
  const dir = config.reports.dir
  let entries
  try {
    entries = await readdirImpl(dir, { withFileTypes: true })
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return failure(ACTION_LATEST_REPORT, 'reports-dir-missing', '报告目录不存在：' + dir)
    }
    return failure(ACTION_LATEST_REPORT, 'reports-dir-unreadable',
      '报告目录不可读：' + dir + '（' + String(code || '未知错误') + '）')
  }

  const candidates = []
  for (const entry of entries) {
    if (candidates.length >= (deps.maxEntries ?? REPORT_MAX_ENTRIES)) break
    if (!entry || typeof entry.name !== 'string') continue
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    if (typeof entry.isFile === 'function' && !entry.isFile()) continue
    const path = insideDirectory(dir, entry.name)
    if (path === undefined) continue
    let info
    try {
      info = await statImpl(path)
    } catch {
      continue // 读不到大小/时间的条目跳过：不能让一条坏文件拖垮整个动作
    }
    if (!info || typeof info.mtimeMs !== 'number' || !Number.isFinite(info.mtimeMs)) continue
    candidates.push({ name: entry.name, path, mtime: info.mtimeMs, size: info.size })
  }

  if (candidates.length === 0) {
    return failure(ACTION_LATEST_REPORT, 'no-reports', '报告目录里没有 .md 文件：' + dir)
  }
  candidates.sort((left, right) => (right.mtime - left.mtime) || left.name.localeCompare(right.name))
  const latest = candidates[0]
  return { ok: true, action: ACTION_LATEST_REPORT, dir, file: latest }
}

/**
 * Read the newest report, capped at {@link REPORT_MAX_BYTES}; larger files are
 * truncated and flagged so the page can say so.
 * @param {ReturnType<typeof readActionConfig>} config
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function readLatestReport(config, deps = {}) {
  const readFileImpl = deps.readFileImpl ?? readFile
  const found = await findLatestReport(config, deps)
  if (!found.ok) return found
  const maxBytes = deps.maxReportBytes ?? REPORT_MAX_BYTES
  let buffer
  try {
    buffer = await readFileImpl(found.file.path)
  } catch (error) {
    return failure(ACTION_LATEST_REPORT, 'report-unreadable',
      '报告读取失败：' + found.file.name + '（' + String((error && error.code) || '未知错误') + '）')
  }
  const truncated = buffer.length > maxBytes
  const content = buffer.subarray(0, maxBytes).toString('utf8')
  return {
    ok: true,
    action: ACTION_LATEST_REPORT,
    dir: found.dir,
    dirLabel: found.dir.split(/[\\/]/).filter(Boolean).pop() ?? found.dir,
    file: { name: found.file.name, mtime: found.file.mtime, size: found.file.size },
    content,
    truncated,
    readBytes: Math.min(buffer.length, maxBytes),
  }
}

/**
 * Ask Explorer to open the fixed reports directory, using an argv array — no
 * shell string is ever built, so no path config can smuggle a command.
 * @param {ReturnType<typeof readActionConfig>} config
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function openReportsFolder(config, deps = {}) {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return failure(ACTION_OPEN_REPORTS, 'windows-only', '只在 Windows 宿主上支持打开目录（当前 ' + platform + '）')
  }
  const dir = config.reports.dir
  const statImpl = deps.statImpl ?? stat
  try {
    const info = await statImpl(dir)
    if (!info || !info.isDirectory()) {
      return failure(ACTION_OPEN_REPORTS, 'reports-dir-missing', '报告目录不存在：' + dir)
    }
  } catch {
    return failure(ACTION_OPEN_REPORTS, 'reports-dir-missing', '报告目录不存在：' + dir)
  }

  const spawnImpl = deps.spawnImpl ?? spawn
  let child = null
  const outcome = await new Promise((resolvePromise) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    try {
      child = spawnImpl('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false })
    } catch (error) {
      settle({ ok: false, detail: String((error && error.code) || 'spawn-failed') })
      return
    }
    if (child && typeof child.once === 'function') {
      child.once('spawn', () => settle({ ok: true }))
      child.once('error', error => settle({ ok: false, detail: String((error && error.code) || 'spawn-failed') }))
    } else {
      settle({ ok: true })
    }
    const timer = setTimeout(() => settle({ ok: true }), deps.spawnSettleMs ?? SPAWN_SETTLE_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  child?.unref?.()
  if (!outcome.ok) {
    return failure(ACTION_OPEN_REPORTS, 'spawn-failed',
      '无法启动资源管理器（explorer.exe）：' + outcome.detail)
  }
  return {
    ok: true,
    action: ACTION_OPEN_REPORTS,
    dir,
    dirLabel: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
    detail: '已在资源管理器打开报告目录',
  }
}

/**
 * Run one whitelisted action.
 *
 * @param {string} action action id from the request (already a string)
 * @param {ReturnType<typeof readActionConfig>} config
 * @param {object} [deps]
 * @returns {Promise<object>} result body; `ok` is the only success flag
 */
export async function runAction(action, config, deps = {}) {
  if (!ACTION_WHITELIST.includes(action)) {
    return failure(String(action).slice(0, 40), 'unknown-action', '未知动作：只接受白名单动作')
  }
  if (config.errors.length > 0) {
    return failure(action, 'bad-config', '动作配置无效：' + config.errors.join('；'))
  }
  if (action === ACTION_PROBE_MEMORY) return probeMemory(config, deps)
  if (action === ACTION_LATEST_REPORT) return readLatestReport(config, deps)
  return openReportsFolder(config, deps)
}
