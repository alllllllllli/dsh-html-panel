/**
 * 大管家永续常驻（1.1.0）：宿主侧状态落盘（continuity 观测记录 + 按天 digest 归档）。
 *
 * **落盘位置**：`$DSH_HOME/dsh-html-panel/`
 *   - `continuity.json`          常驻会话观测记录（首次绑定时间 / 最近存活 / 重建次数）
 *   - `digests/<YYYY-MM-DD>.json` 按天归档摘要（同一 date 覆盖写 = 幂等）
 *
 * **为什么选这里（1.1.0 调研结论，写进 README）**
 *   1. DSH 宿主的官方持久化约定是 `ctx.storage`（`@deepseek-ai/dsh-storage` 枢纽 +
 *      `dsh-storage-json` 后端，backend root = `$DSH_HOME/storages`）。但消费方契约要求用
 *      `@deepseek-ai/dsh-storage-domain` 的 `defineDomain()` 声明领域（记录 schema 是 zod），
 *      而本插件是**外部插件**：package.json 只声明 peer `@deepseek-ai/dsh`，profile 的
 *      node_modules 里没有 `dsh-storage-domain`/`zod`（宿主把它们打包在 app.asar 内部）。
 *      硬造一份 spec 去调 `ctx.storageDomain.open()` 等于手写宿主内部契约，宿主升级即碎，
 *      所以不碰官方 storage 根（`$DSH_HOME/storages` 是后端单元命名空间，也不能塞私货）。
 *   2. `$DSH_HOME` 是本机 DSH 的**数据根**（`DSH_HOME` 环境变量，缺省 `~/.dsh`），不是用户目录：
 *      会话、日志、skills、plugins 都在它下面。插件在这里放自己的子目录是本生态既有做法：
 *      `dsh-team-mesh` → `$DSH_HOME/team/team.db`，`dsh-opencode-go-router` →
 *      `$DSH_HOME/storages/opencode-router/state.json`。
 *   3. 插件目录（`lib/`、`public/`）在 profile 的 node_modules 里，可能被重装/覆盖，
 *      不能当数据目录。所以取 `$DSH_HOME/dsh-html-panel/`，与安装位置解耦。
 *
 * 硬约束：本模块任何函数都不抛错给调用方（读取失败给结构化原因）；写盘是
 * tmp + rename 原子替换；不覆盖用户文件（只写自己的数据目录）。
 */
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件在 `$DSH_HOME` 下的数据子目录名。 */
export const STATE_DIR_NAME = 'dsh-html-panel'
/** 常驻会话观测记录文件名。 */
export const CONTINUITY_FILE_NAME = 'continuity.json'
/** 按天归档摘要目录名。 */
export const DIGEST_DIR_NAME = 'digests'
/** 记录格式版本：以后改结构时用来拒绝/迁移旧文件。 */
export const STATE_SCHEMA_VERSION = 1

/**
 * 解析 DSH 数据根：`DSH_HOME` 环境变量优先，缺省 `<用户主目录>/.dsh`
 * （与 `dsh-mobile` / `dsh-opencode-go-router` 的约定一致）。
 * @param {NodeJS.ProcessEnv|object} [env] 环境变量（测试可注入）
 * @param {string} [home] 用户主目录（测试可注入）
 * @returns {string} 绝对路径
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return raw === '' ? join(home, '.dsh') : raw
}

/**
 * 本插件的数据根：`$DSH_HOME/dsh-html-panel`。
 * @param {object} [options] `{ env, home }`（测试可注入）
 * @returns {string} 绝对路径
 */
export function resolveStateRoot(options = {}) {
  return join(resolveDshHome(options.env, options.home), STATE_DIR_NAME)
}

/** 常驻会话观测记录文件路径。 */
export function continuityPathOf(root) {
  return join(root, CONTINUITY_FILE_NAME)
}

/** 某一天（`YYYY-MM-DD`）的归档摘要文件路径。 */
export function digestPathOf(root, date) {
  return join(root, DIGEST_DIR_NAME, date + '.json')
}

/**
 * 读一个 JSON 文件，永不抛错。
 * @param {string} path 绝对路径
 * @param {{readFile?:Function}} [fsDeps] 测试可注入
 * @returns {Promise<{ok:true, value:unknown} | {ok:false, code:'missing'|'corrupt'|'unreadable', reason:string}>}
 */
export async function readJsonFile(path, fsDeps = {}) {
  const read = typeof fsDeps.readFile === 'function' ? fsDeps.readFile : readFile
  let text
  try {
    text = await read(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, code: 'missing', reason: '状态文件不存在（首次运行）' }
    return { ok: false, code: 'unreadable', reason: '状态文件读取失败：' + shortErrorCode(error) }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, code: 'corrupt', reason: '状态文件不是合法 JSON（保留原文件，不自动删除）' }
  }
}

/**
 * 原子写一个 JSON 文件（同目录 tmp + rename），永不把半截文件留给下一次读取。
 * @param {string} path 绝对路径
 * @param {unknown} value 可 JSON 序列化的值
 * @param {{mkdir?:Function, writeFile?:Function, rename?:Function, unlink?:Function}} [fsDeps] 测试可注入
 * @returns {Promise<{ok:true} | {ok:false, reason:string}>} 永不 reject
 */
export async function writeJsonAtomic(path, value, fsDeps = {}) {
  const mkdirFn = typeof fsDeps.mkdir === 'function' ? fsDeps.mkdir : mkdir
  const writeFn = typeof fsDeps.writeFile === 'function' ? fsDeps.writeFile : writeFile
  const renameFn = typeof fsDeps.rename === 'function' ? fsDeps.rename : rename
  const unlinkFn = typeof fsDeps.unlink === 'function' ? fsDeps.unlink : unlink
  const tmp = path + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 10) + '.tmp'
  try {
    await mkdirFn(dirname(path), { recursive: true })
    await writeFn(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await renameFn(tmp, path)
    return { ok: true }
  } catch (error) {
    try {
      await unlinkFn(tmp)
    } catch {
      /* tmp 不存在/删不掉都不影响主错误 */
    }
    return { ok: false, reason: '状态写盘失败：' + shortErrorCode(error) }
  }
}

/**
 * 把一份读不懂的状态文件复制成同目录带时间戳的备份（`<name>.bak-<infix>-<ts>`）。
 * 只在文件损坏时用：正常写盘走原子替换，不需要每分钟留备份。
 * @param {string} path 原文件绝对路径
 * @param {string} infix 备份原因（进文件名，只留安全字符）
 * @param {number} nowMs 时间戳（毫秒）
 * @param {{copyFile?:Function}} [fsDeps] 测试可注入
 * @returns {Promise<string|null>} 备份路径；失败 null（不阻断主流程）
 */
export async function backupCorruptStateFile(path, infix, nowMs, fsDeps = {}) {
  const copy = typeof fsDeps.copyFile === 'function' ? fsDeps.copyFile : copyFile
  const stamp = new Date(Number.isFinite(nowMs) ? nowMs : Date.now())
  const pad = value => String(value).padStart(2, '0')
  const id = stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate())
    + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds())
  const safeInfix = String(infix).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'corrupt'
  const target = path + '.bak-' + safeInfix + '-' + id
  try {
    await copy(path, target)
    return target
  } catch {
    return null
  }
}

/**
 * 只暴露错误码/名字，不把原始异常文本（可能带路径/凭据）带进响应。
 * @param {unknown} error
 * @returns {string}
 */
function shortErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code !== '') return code
  const name = error && typeof error.name === 'string' ? error.name : ''
  return name === '' ? 'unknown' : name
}

/**
 * 把读到的 continuity 文件收敛成内部记录。任何脏字段都退回默认值，绝不抛错。
 * @param {unknown} raw
 * @returns {{schemaVersion:number, sessionId:string, firstBoundAt:number|null, lastSeenAt:number|null, rebuildCount:number, label:string, title:string}}
 */
export function normalizeContinuityRecord(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const num = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null)
  const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  return {
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : STATE_SCHEMA_VERSION,
    sessionId: str(source.sessionId, 160),
    firstBoundAt: num(source.firstBoundAt),
    lastSeenAt: num(source.lastSeenAt),
    rebuildCount: Number.isInteger(source.rebuildCount) && source.rebuildCount >= 0 ? source.rebuildCount : 0,
    label: str(source.label, 60),
    title: str(source.title, 160),
  }
}

/** 归档摘要里允许出现的日期（严格 `YYYY-MM-DD` 且是真实日历日）。 */
export const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 解析 `YYYY-MM-DD` 并按本地时区给出当天 [start, end) 毫秒区间。
 * @param {string} text 日期串
 * @returns {{date:string, start:number, end:number} | null} 非法日期 null（不猜）
 */
export function dayWindowOf(text) {
  if (typeof text !== 'string') return null
  const matched = DATE_PATTERN.exec(text.trim())
  if (matched === null) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
  const probe = new Date(start)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime()
  return { date: text.trim(), start, end }
}

/**
 * 本地时区的 `YYYY-MM-DD`。
 * @param {number} nowMs 毫秒时间戳
 * @returns {string}
 */
export function localDateOf(nowMs) {
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now())
  const pad = value => String(value).padStart(2, '0')
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
}
