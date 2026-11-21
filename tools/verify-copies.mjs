#!/usr/bin/env node
/**
 * tools/verify-copies.mjs —— 源目录与已安装副本的逐文件 sha256 对比（可选镜像同步）。
 *
 * 本插件有两份副本：
 *   源（唯一编辑处）: <本仓库>/dsh-plugins/dsh-html-panel
 *   已装副本:        <DSH profile>/node_modules/dsh-html-panel
 * 运行中的 DSH 从已装副本读 `public/index.html` 与 `lib/`，所以交付必须两份一致。
 *
 * 用法:
 *   node tools/verify-copies.mjs                 # 只比对，写 --json
 *   node tools/verify-copies.mjs --sync          # 先把源镜像到已装副本，再比对
 *   node tools/verify-copies.mjs --json <path>   # 指定报告输出（默认 tools/shots/copy-verify.json）
 *   DSH_PROFILE_DIR=<dir> 可覆盖 profile 目录（默认 ~/.dsh/profiles/desktop）
 *
 * 退出码：0 = 全部一致；1 = 有差异/缺失。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const SYNC = args.includes('--sync')
const jsonIndex = args.indexOf('--json')
const jsonAt = jsonIndex >= 0 && args[jsonIndex + 1] ? path.resolve(args[jsonIndex + 1]) : null

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_ROOT = process.env.DSH_PROFILE_DIR
  ? path.resolve(process.env.DSH_PROFILE_DIR)
  : path.join(homedir(), '.dsh', 'profiles', 'desktop')
const INSTALLED = path.join(PROFILE_ROOT, 'node_modules', 'dsh-html-panel')
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 递归列出目录下所有普通文件（相对路径，正斜杠）。 */
async function listFiles(root, prefix = '', out = []) {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await listFiles(root, relative, out)
    } else if (entry.isFile()) {
      out.push(relative)
    }
  }
  return out
}

async function sha256Of(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function shortPath(absolute) {
  const home = homedir()
  if (absolute.startsWith(home)) return '~' + absolute.slice(home.length).split(path.sep).join('/')
  return absolute.split(path.sep).join('/')
}

const sourceFiles = (await listFiles(SOURCE)).sort()
const outputPath = jsonAt ?? path.join(SOURCE, 'tools', 'shots', 'copy-verify.json')
/** 报告文件自身无法给自己算哈希：它不参与对比，但写入后会同步到副本（见下）。 */
const selfRelative = outputPath.startsWith(SOURCE + path.sep)
  ? path.relative(SOURCE, outputPath).split(path.sep).join('/')
  : null
const sync = { enabled: SYNC, copied: 0, selfReport: selfRelative, errors: [] }
if (SYNC) {
  for (const relative of sourceFiles) {
    const from = path.join(SOURCE, ...relative.split('/'))
    const to = path.join(INSTALLED, ...relative.split('/'))
    try {
      await mkdir(path.dirname(to), { recursive: true })
      await cp(from, to)
      sync.copied += 1
    } catch (error) {
      sync.errors.push(relative + ': ' + String((error && error.message) || error))
    }
  }
}

const installedFiles = await listFiles(INSTALLED)
const sourceSet = new Set(sourceFiles)
const installedSet = new Set(installedFiles)
const files = []
let mismatched = 0
for (const relative of sourceFiles) {
  // 报告自身不参与自哈希（内容包含其它文件哈希，写入时间在同步之后）。
  if (relative === selfRelative) continue
  const from = path.join(SOURCE, ...relative.split('/'))
  const to = path.join(INSTALLED, ...relative.split('/'))
  const sourceInfo = await stat(from)
  const sourceHash = await sha256Of(from)
  let destinationHash = null
  if (installedSet.has(relative)) {
    try {
      destinationHash = await sha256Of(to)
    } catch {
      destinationHash = null
    }
  }
  const identical = destinationHash !== null && destinationHash === sourceHash && sourceInfo.isFile()
  if (!identical) mismatched += 1
  files.push({
    path: relative,
    bytes: sourceInfo.size,
    sha256: sourceHash,
    destinationSha256: destinationHash,
    identical,
  })
}
const missingInDestination = sourceFiles.filter(file => !installedSet.has(file))
const extraInDestination = installedFiles.filter(file => !sourceSet.has(file))

const summary = {
  generatedAt: new Date().toISOString(),
  source: shortPath(SOURCE),
  installedCopy: shortPath(INSTALLED),
  profileDir: shortPath(PROFILE_ROOT),
  note: selfRelative === null
    ? '逐文件 sha256 对比；报告文件不在源目录内。'
    : '逐文件 sha256 对比；报告自身（' + selfRelative + '）不参与自哈希，但写入后会同步到副本。',
  sync,
  comparedFiles: files.length,
  mismatched,
  missingInDestination,
  extraInDestination,
  allIdentical: mismatched === 0 && missingInDestination.length === 0,
  files,
}
const output = outputPath
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(summary, null, 2), 'utf8')
// 报告自身：写入源之后同步到副本，保证两份副本在静止状态下也是同一份（除时间戳外内容一致）。
if (SYNC && selfRelative !== null) {
  try {
    await cp(output, path.join(INSTALLED, ...selfRelative.split('/')))
    sync.selfReportCopied = true
  } catch (error) {
    sync.errors.push(selfRelative + ': ' + String((error && error.message) || error))
  }
}

process.stdout.write('sync=' + (SYNC ? 'yes (' + sync.copied + ' copied)' : 'no') + '\n')
process.stdout.write('source=' + summary.source + '\ninstalled=' + summary.installedCopy + '\n')
process.stdout.write('compared=' + files.length + ' mismatched=' + mismatched +
  ' missing=' + missingInDestination.length + ' extra=' + extraInDestination.length +
  (selfRelative === null ? '' : ' (报告自身不参与自哈希，已同步)') + '\n')
for (const file of files.filter(item => !item.identical).slice(0, 10)) {
  process.stdout.write('  DIFF ' + file.path + '\n')
}
for (const file of missingInDestination.slice(0, 10)) process.stdout.write('  MISSING ' + file + '\n')
for (const file of extraInDestination.slice(0, 10)) process.stdout.write('  EXTRA ' + file + '\n')
process.stdout.write('result: ' + (summary.allIdentical ? 'IDENTICAL' : 'MISMATCH') + '\n')
process.exit(summary.allIdentical ? 0 : 1)
