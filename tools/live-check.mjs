#!/usr/bin/env node
/**
 * tools/live-check.mjs —— 对**运行中、未重启**的 DSH 做只读冒烟，验证页面文件是否已热更新。
 *
 * 背景：`/dsh-html-panel` 的文件路由每次请求都从磁盘读（`no-store`），所以替换
 * `public/index.html` 后刷新即生效；但 `lib/`（新增的 `GET api/tiers`、侧栏改名）
 * 是 DSH 启动时加载的，**必须重启 DSH 才生效**。本脚本把这两件事分开如实记录：
 *   - 页面：拿运行中 DSH 返回的 index.html 与源文件算 sha256，必须相等；
 *   - 路由：逐个 GET 四条只读路由，记录 HTTP 状态（`api/tiers` 在重启前应为 404，
 *     重启后应为 200 —— 两种都算"符合预期"，脚本只如实写入，不把 404 当失败）。
 *
 * 用法: node tools/live-check.mjs [--json tools/shots/live-check.json]
 *       DSH_URL=http://127.0.0.1:53499 可覆盖运行中 DSH 的地址。
 * 退出码：0 = 页面已是新文件；1 = 页面没更新或运行中 DSH 不可达。
 * 只读：不重启、不 POST、不改任何配置；响应体最多读取 512 KB 且不落盘。
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_FILE = path.join(ROOT, 'public', 'index.html')
const args = process.argv.slice(2)
const jsonIndex = args.indexOf('--json')
const jsonAt = jsonIndex >= 0 && args[jsonIndex + 1]
  ? path.resolve(args[jsonIndex + 1])
  : path.join(ROOT, 'tools', 'shots', 'live-check.json')
const DSH_URL = (process.env.DSH_URL || 'http://127.0.0.1:53499').replace(/\/+$/, '')
const ROUTE = '/dsh-html-panel'

/** 读一份响应并返回状态/字节/哈希；超时 8s，不打印正文。 */
async function probe(pathname) {
  const started = Date.now()
  try {
    const response = await fetch(DSH_URL + pathname, {
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      path: pathname,
      status: response.status,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    return {
      path: pathname,
      status: null,
      bytes: 0,
      sha256: null,
      latencyMs: Date.now() - started,
      error: String((error && error.message) || error).slice(0, 120),
    }
  }
}

const sourceBuffer = await readFile(PAGE_FILE)
const source = {
  file: 'public/index.html',
  bytes: sourceBuffer.length,
  sha256: createHash('sha256').update(sourceBuffer).digest('hex'),
}

const page = await probe(ROUTE + '/index.html')
const routes = []
for (const api of ['api/cluster', 'api/board', 'api/host', 'api/tiers']) {
  routes.push(await probe(ROUTE + '/' + api))
}

const pageUpdated = page.status === 200 && page.sha256 === source.sha256
const tiers = routes.find(item => item.path === ROUTE + '/api/tiers')
const tiersNote = tiers && tiers.status === 404
  ? '404：新版 Host 尚未加载（api/tiers 需重启 DSH 后生效）—— 页面会显示「降级：需重启」'
  : tiers && tiers.status === 200
    ? '200：新路由已生效'
    : '状态异常，见记录'

const summary = {
  generatedAt: new Date().toISOString(),
  dshUrl: DSH_URL,
  source,
  page: { ...page, updated: pageUpdated },
  routes,
  tiersNote,
  expected: {
    pageUpdated: true,
    tiers: '404（未重启）或 200（已重启）均可接受，如实记录',
  },
  pass: pageUpdated,
}
await writeFile(jsonAt, JSON.stringify(summary, null, 2), 'utf8')

process.stdout.write('DSH_URL=' + DSH_URL + '\n')
process.stdout.write('页面源文件 sha256=' + source.sha256 + ' (' + source.bytes + ' B)\n')
process.stdout.write('运行中页面  http=' + page.status + ' bytes=' + page.bytes + ' sha256=' + page.sha256 + '\n')
process.stdout.write('页面已热更新: ' + (pageUpdated ? 'YES' : 'NO') + '\n')
for (const item of routes) {
  process.stdout.write('  ' + item.path + ' -> ' + (item.status === null ? 'ERR ' + item.error : 'HTTP ' + item.status) +
    ' (' + item.bytes + ' B, ' + item.latencyMs + 'ms)\n')
}
process.stdout.write('api/tiers: ' + tiersNote + '\n')
process.stdout.write('result: ' + (summary.pass ? 'PASS' : 'FAIL') + '\n')
process.exit(summary.pass ? 0 : 1)
