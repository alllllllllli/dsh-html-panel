/**
 * Host 半的本机只读系统快照：`GET /dsh-html-panel/api/host` 的全部逻辑。
 *
 * 只读三样东西，全部来自 Node 内置模块，**零外部依赖、零外链**：
 *   - `node:os`      —— hostname / platform / release / uptime / totalmem / freemem / loadavg / cpus
 *   - `node:fs/promises` 的 `statfs` —— 磁盘总量与可用量（Windows 上对 `C:\` / `D:\` 可用）
 *
 * 契约（页面按这个读）：
 *   {
 *     generatedAt: '<ISO>',
 *     hostname: '...',
 *     os: { platform, release, uptimeSec },
 *     memory: { totalBytes, freeBytes, ratio },   // ratio = 已用 / 总量（0..1）
 *     cpu: { count, load1 },                       // Windows 的 loadavg 恒为 0，如实给 0
 *     disks: [{ mount, label, totalBytes, freeBytes, ratio, error }]
 *   }
 *
 * `disks` 里取不到的盘**不让整个请求失败**：该项数值为 null、`error` 写原因码，
 * 页面显示「读取失败」。本模块任何输入都不抛错。
 */
import { statfs } from 'node:fs/promises'
import os from 'node:os'

/**
 * 默认要报的磁盘。Windows 只报 C: 与 D:（存在才算 —— statfs 失败的那项数值为 null）；
 * 其它平台报根分区，保证模块本身跨平台可跑（测试也在任意平台成立）。
 */
export const HOST_DISKS = Object.freeze(
  process.platform === 'win32'
    ? [{ mount: 'C:\\', label: 'C: 系统盘' }, { mount: 'D:\\', label: 'D: 数据盘' }]
    : [{ mount: '/', label: '系统盘' }],
)

/** 保留 4 位小数：页面显示百分比，不需要更多精度。 */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

/** 数字或 null；不把 NaN/Infinity 交给页面。 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 生成一份本机只读快照。
 * @param {number} [now] 生成时刻（毫秒）；非法值回落到 `Date.now()`，测试可注入
 * @param {{statfs?: Function, mounts?: Array<{mount:string,label?:string}>, osModule?: object}} [deps]
 *   测试注入点：替换 statfs / 磁盘列表 / os 模块，用来验证"statfs 失败也不抛错"
 * @returns {Promise<object>} `/api/host` 的响应体
 */
export async function buildHostInfo(now = Date.now(), deps = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const statfsFn = typeof deps.statfs === 'function' ? deps.statfs : statfs
  const mounts = Array.isArray(deps.mounts) ? deps.mounts : HOST_DISKS
  const osModule = deps.osModule && typeof deps.osModule === 'object' ? deps.osModule : os

  const totalBytes = finiteOrNull(Number(osModule.totalmem?.()))
  const freeBytes = finiteOrNull(Number(osModule.freemem?.()))
  const memory = {
    totalBytes,
    freeBytes,
    // ratio 定义写死：**已用 / 总量**（页面进度条按"已用"填充）
    ratio: totalBytes !== null && totalBytes > 0 && freeBytes !== null
      ? round4(Math.min(1, Math.max(0, (totalBytes - freeBytes) / totalBytes)))
      : null,
  }

  let cpuCount = null
  try {
    const cpus = osModule.cpus()
    if (Array.isArray(cpus)) cpuCount = cpus.length
  } catch {
    /* 读不到就不猜 */
  }
  let load1 = null
  try {
    const load = osModule.loadavg()
    if (Array.isArray(load)) load1 = finiteOrNull(Number(load[0]))
  } catch {
    /* 读不到就不猜 */
  }

  const disks = []
  for (const entry of mounts) {
    const mount = entry && typeof entry.mount === 'string' ? entry.mount.trim() : ''
    if (mount === '') continue
    const label = entry && typeof entry.label === 'string' && entry.label !== '' ? entry.label : mount
    const displayMount = mount.replace(/[\\/]+$/, '') || mount
    const disk = { mount: displayMount, label, totalBytes: null, freeBytes: null, ratio: null, error: null }
    try {
      const stats = await statfsFn(mount)
      const blockSize = Number(stats && stats.bsize)
      const blocks = Number(stats && stats.blocks)
      // bavail = 非特权用户可用块；拿不到就退 bfree
      const avail = Number(stats && (stats.bavail ?? stats.bfree))
      const total = blockSize * blocks
      const free = blockSize * avail
      if (Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0) {
        disk.totalBytes = total
        disk.freeBytes = Math.min(free, total)
        disk.ratio = round4((total - disk.freeBytes) / total)
      } else {
        disk.error = 'statfs-invalid'
      }
    } catch (error) {
      disk.error = error && typeof error.code === 'string' ? error.code : 'statfs-failed'
    }
    disks.push(disk)
  }

  let hostname = null
  let platform = process.platform
  let release = null
  let uptimeSec = null
  try {
    hostname = String(osModule.hostname())
  } catch {
    /* 读不到就不猜 */
  }
  try {
    const value = osModule.release?.()
    if (typeof value === 'string') release = value
  } catch {
    /* 读不到就不猜 */
  }
  try {
    const value = Number(osModule.uptime?.())
    if (Number.isFinite(value)) uptimeSec = Math.round(value)
  } catch {
    /* 读不到就不猜 */
  }

  return {
    generatedAt: new Date(at).toISOString(),
    hostname,
    os: { platform, release, uptimeSec },
    memory,
    cpu: { count: cpuCount, load1 },
    disks,
  }
}
