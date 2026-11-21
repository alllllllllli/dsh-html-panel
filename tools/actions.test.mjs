#!/usr/bin/env node
/**
 * tools/actions.test.mjs —— Host 半动作层（lib/actions.js）与动作端点
 * （lib/index.js 的 handleActionRequest）的单元测试。零依赖，node:test。
 *
 * 用法: node --test tools/actions.test.mjs
 *
 * 覆盖的是**能造成真实副作用的那一层**：白名单、固定路径、请求信封、失败原因。
 * 这里用注入的 fake fetch / spawn / fs 断言参数，不碰真实桌面（不弹 explorer）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  ACTION_LATEST_REPORT, ACTION_OPEN_REPORTS, ACTION_PROBE_MEMORY, ACTION_WHITELIST,
  MEMORY_DEFAULT_URL, defaultReportsDir, findLatestReport, openReportsFolder, probeMemory,
  readActionConfig, readLatestReport, runAction,
} from '../lib/actions.js'
import { handleActionRequest } from '../lib/index.js'

/** One fake Node request with a method, headers and body. */
function makeRequest({ method = 'POST', headers = {}, body = '' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.headers = headers
  return stream
}

/** One fake Node response capturing status, headers and body. */
function makeResponse() {
  return {
    status: null,
    headers: null,
    headersSent: false,
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(text) {
      if (text !== undefined) this.chunks.push(String(text))
    },
    get body() {
      return this.chunks.join('')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/** A fake child process: records spawn/error, then reports spawn success. */
function fakeSpawn(outcome = 'spawn') {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = {
      unrefCalled: false,
      once(event, listener) {
        if (outcome === 'spawn' && event === 'spawn') queueMicrotask(listener)
        if (outcome === 'error' && event === 'error') queueMicrotask(() => listener(Object.assign(new Error('boom'), { code: 'ENOENT' })))
        return child
      },
      unref() {
        this.unrefCalled = true
      },
    }
    return child
  }
  return { spawnImpl, calls }
}

/** Create a temp reports dir with the given names/mtimes; cleanup is the caller's. */
async function makeReportsDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'panel-actions-'))
  for (const [name, { mtime, content }] of Object.entries(files)) {
    const path = join(dir, name)
    await writeFile(path, content ?? '# ' + name, 'utf8')
    if (mtime !== undefined) await utimes(path, mtime, mtime)
  }
  return dir
}

test('readActionConfig: defaults are the mcloud OpenViking origin and the mesh dev reports dir', () => {
  const config = readActionConfig(undefined)
  assert.deepEqual(config.errors, [])
  assert.equal(config.memory.url, MEMORY_DEFAULT_URL)
  assert.equal(config.memory.origin, 'http://172.24.112.11:1933')
  assert.equal(config.reports.dir, defaultReportsDir())
  assert.equal(config.reports.dir, join(homedir(), 'mesh-0.6-dev', 'repo', 'docs'))
})

test('readActionConfig: flat and nested shapes both work; trailing slash is normalized', () => {
  const flat = readActionConfig({ memory: { url: 'http://10.0.0.9:1933' }, reports: { dir: 'D:\\reports' } })
  assert.deepEqual(flat.errors, [])
  assert.equal(flat.memory.url, 'http://10.0.0.9:1933/')
  assert.equal(flat.reports.dir, 'D:\\reports')
  const nested = readActionConfig({ actions: { memory: { url: 'https://example.test/studio/' }, reports: { dir: 'D:\\docs' } } })
  assert.equal(nested.memory.url, 'https://example.test/studio/')
  assert.equal(nested.reports.dir, 'D:\\docs')
})

test('readActionConfig: rejects credentials, non-http protocols and relative dirs', () => {
  const credentialed = readActionConfig({ actions: { memory: { url: 'http://user:secret@172.24.112.11:1933/' } } })
  assert.equal(credentialed.errors.length, 1)
  assert.match(credentialed.errors[0], /不允许携带用户名\/密码/)
  assert.ok(!credentialed.memory.url.includes('secret'))
  const badProtocol = readActionConfig({ actions: { memory: { url: 'file:///C:/x' } } })
  assert.equal(badProtocol.errors.length, 1)
  const relative = readActionConfig({ actions: { reports: { dir: 'reports' } } })
  assert.equal(relative.errors.length, 1)
  assert.match(relative.errors[0], /绝对路径/)
})

test('runAction: only whitelisted ids pass; bad config is refused before side effects', async () => {
  assert.deepEqual(ACTION_WHITELIST.slice().sort(), [ACTION_LATEST_REPORT, ACTION_OPEN_REPORTS, ACTION_PROBE_MEMORY].sort())
  const unknown = await runAction('open-calculator', readActionConfig(undefined))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'unknown-action')
  const badConfig = await runAction(ACTION_PROBE_MEMORY, readActionConfig({ actions: { memory: { url: 'nope' } } }))
  assert.equal(badConfig.ok, false)
  assert.equal(badConfig.code, 'bad-config')
})

test('probeMemory: reachable origin returns the configured URL and measured latency', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { status: 200 }
  }
  const config = readActionConfig({ actions: { memory: { url: 'http://172.24.112.11:1933/' } } })
  const result = await probeMemory(config, { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'http://172.24.112.11:1933/')
  assert.equal(result.origin, 'http://172.24.112.11:1933')
  assert.equal(typeof result.latencyMs, 'number')
  assert.ok(result.latencyMs >= 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://172.24.112.11:1933/')
  assert.equal(calls[0].init.method, 'GET')
})

test('probeMemory: timeout / refused / HTTP error are honest failures', async () => {
  const config = readActionConfig(undefined)
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  const timeoutResult = await probeMemory(config, { fetchImpl: async () => { throw timeout } })
  assert.equal(timeoutResult.ok, false)
  assert.equal(timeoutResult.code, 'memory-unreachable')
  assert.match(timeoutResult.reason, /超时/)

  const refused = Object.assign(new Error('connect failed'), { cause: { code: 'ECONNREFUSED' } })
  const refusedResult = await probeMemory(config, { fetchImpl: async () => { throw refused } })
  assert.match(refusedResult.reason, /ECONNREFUSED/)

  const down = await probeMemory(config, { fetchImpl: async () => ({ status: 503 }) })
  assert.equal(down.ok, false)
  assert.equal(down.code, 'memory-http-503')
  assert.match(down.reason, /HTTP 503/)
})

test('findLatestReport: newest .md wins; txt is ignored; missing/empty dirs have reasons', async () => {
  const dir = await makeReportsDir({
    'old.md': { mtime: new Date('2026-11-01T00:00:00Z') },
    'new.md': { mtime: new Date('2026-11-21T00:00:00Z') },
    'notes.txt': { mtime: new Date('2026-11-22T00:00:00Z') },
  })
  try {
    const config = readActionConfig({ actions: { reports: { dir } } })
    const found = await findLatestReport(config)
    assert.equal(found.ok, true)
    assert.equal(found.file.name, 'new.md')
    assert.equal(found.dir, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const missing = await findLatestReport(readActionConfig({ actions: { reports: { dir: join(tmpdir(), 'panel-actions-missing-' + Date.now()) } } }))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'reports-dir-missing')

  const emptyDir = await mkdtemp(join(tmpdir(), 'panel-actions-empty-'))
  try {
    const empty = await findLatestReport(readActionConfig({ actions: { reports: { dir: emptyDir } } }))
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'no-reports')
  } finally {
    await rm(emptyDir, { recursive: true, force: true })
  }
})

test('readLatestReport: returns content, truncates above the cap and flags it', async () => {
  const dir = await makeReportsDir({ 'big.md': { content: 'x'.repeat(200) } })
  try {
    const config = readActionConfig({ actions: { reports: { dir } } })
    const full = await readLatestReport(config, { maxReportBytes: 4096 })
    assert.equal(full.ok, true)
    assert.equal(full.content.length, 200)
    assert.equal(full.truncated, false)
    const cut = await readLatestReport(config, { maxReportBytes: 64 })
    assert.equal(cut.truncated, true)
    assert.equal(cut.content.length, 64)
    assert.equal(cut.readBytes, 64)
    assert.equal(cut.file.name, 'big.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('openReportsFolder: spawns explorer.exe with the fixed directory only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-actions-open-'))
  try {
    const { spawnImpl, calls } = fakeSpawn('spawn')
    const result = await openReportsFolder(readActionConfig({ actions: { reports: { dir } } }), { platform: 'win32', spawnImpl })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'explorer.exe')
    assert.deepEqual(calls[0].args, [dir])
    assert.equal(calls[0].options.detached, true)
    assert.equal(result.dir, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('openReportsFolder: missing dir, non-Windows host and spawn failure are reported', async () => {
  const missing = await openReportsFolder(readActionConfig({ actions: { reports: { dir: join(tmpdir(), 'panel-actions-nope-' + Date.now()) } } }), { platform: 'win32', spawnImpl: fakeSpawn().spawnImpl })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'reports-dir-missing')

  const dir = await mkdtemp(join(tmpdir(), 'panel-actions-linux-'))
  try {
    const linux = await openReportsFolder(readActionConfig({ actions: { reports: { dir } } }), { platform: 'linux', spawnImpl: fakeSpawn().spawnImpl })
    assert.equal(linux.ok, false)
    assert.equal(linux.code, 'windows-only')

    const failed = await openReportsFolder(readActionConfig({ actions: { reports: { dir } } }), { platform: 'win32', spawnImpl: fakeSpawn('error').spawnImpl })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'spawn-failed')
    assert.match(failed.reason, /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handleActionRequest: method / origin / media type / body envelope are rejected first', async () => {
  const deps = { actions: readActionConfig(undefined), actionDeps: { fetchImpl: async () => ({ status: 200 }) } }
  const cases = [
    { name: 'GET', req: { method: 'GET', headers: {} }, status: 405, code: 'method-not-allowed', allow: 'POST' },
    { name: 'foreign origin', req: { headers: { origin: 'http://evil.test', host: '127.0.0.1:51539', 'content-type': 'application/json' }, body: '{"action":"probe-memory"}' }, status: 403, code: 'origin-rejected' },
    { name: 'text/plain', req: { headers: { 'content-type': 'text/plain' }, body: '{"action":"probe-memory"}' }, status: 415, code: 'unsupported-media-type' },
    { name: 'bad json', req: { headers: { 'content-type': 'application/json' }, body: '{nope' }, status: 400, code: 'bad-json' },
    { name: 'array body', req: { headers: { 'content-type': 'application/json' }, body: '[]' }, status: 400, code: 'bad-body' },
    { name: 'unknown action', req: { headers: { 'content-type': 'application/json' }, body: '{"action":"restart-dsh"}' }, status: 400, code: 'unknown-action' },
    { name: 'oversized', req: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'probe-memory', pad: 'x'.repeat(5000) }) }, status: 413, code: 'body-too-large' },
  ]
  for (const item of cases) {
    const res = makeResponse()
    await handleActionRequest(makeRequest(item.req), res, deps)
    const body = res.json()
    assert.equal(res.status, item.status, item.name)
    assert.equal(body.ok, false, item.name)
    assert.equal(body.code, item.code, item.name)
    if (item.allow !== undefined) assert.equal(res.headers.allow, item.allow, item.name)
  }
})

test('handleActionRequest: whitelisted action runs and answers the structured result', async () => {
  const res = makeResponse()
  const deps = {
    actions: readActionConfig({ actions: { memory: { url: 'http://172.24.112.11:1933/' } } }),
    actionDeps: { fetchImpl: async () => ({ status: 200 }) },
  }
  await handleActionRequest(makeRequest({
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:51539', host: '127.0.0.1:51539' },
    body: JSON.stringify({ action: 'probe-memory' }),
  }), res, deps)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.action, 'probe-memory')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.match(res.headers['content-type'], /application\/json/)
})

test('handleActionRequest: an unexpected throw becomes a generic 500 without a stack', async () => {
  const res = makeResponse()
  const logs = []
  const brokenConfig = {
    get errors() { throw new Error('internal detail that must not reach the page') },
    memory: { url: 'http://127.0.0.1:9/', origin: 'http://127.0.0.1:9' },
    reports: { dir: 'C:\\nope' },
  }
  await handleActionRequest(makeRequest({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'probe-memory' }),
  }), res, { actions: brokenConfig, logger: { warn: error => logs.push(String(error && error.message)) } })
  assert.equal(res.status, 500)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'action-failed')
  assert.ok(!JSON.stringify(body).includes('internal detail'))
  assert.equal(logs.length, 1)
})

test('postAction contract: action ids accepted by the page exist in the host whitelist', async () => {
  // 页面侧硬编码的 6 个按钮动作里，只有 3 个会打到宿主路由；一个个核对拼写。
  assert.ok(ACTION_WHITELIST.includes(ACTION_PROBE_MEMORY))
  assert.ok(ACTION_WHITELIST.includes(ACTION_LATEST_REPORT))
  assert.ok(ACTION_WHITELIST.includes(ACTION_OPEN_REPORTS))
})
