/**
 * 只读集群快照的纯函数层：`/dsh-html-panel/api/cluster` 的内容全在这里生成。
 *
 * 为什么单独一个文件：路由里只留取服务、拼响应，**形状与脱敏都能被单测直接断言**
 * （`tools/cluster.test.mjs` 不需要起 DSH，也不需要真的 interconnect）。
 *
 * 数据来源只有一个：本机 DSH 进程里的 cordis 服务 `ctx.interconnect`。
 * 只调它两个**本地、同步、不走网络**的方法：
 *   - `peers()`   → 每行 `{ instanceId, origin, link }`，origin 可能是 self 路由的解析函数；
 *   - `selfSender('__probe__')` → `{ instanceId, ... }`，拿本实例 id。
 * `ping()` / `list()` 是异步且真的过网络，**这里绝不调用**——面板路由不能因为对端慢而卡住。
 *
 * 契约（页面按这个读）：
 *   {
 *     generatedAt: '<ISO>',            // 本函数生成时间
 *     interconnect: true|false,        // 本实例有没有可读的 interconnect 服务
 *     self: { instanceId: '...' },      // 取不到就是 'unknown'，不编
 *     peers: [{ instanceId, origin, link }],  // origin 已脱敏成 host[:port] 或 null；link 只 up|down
 *     board: null,                     // 预留：本轮没有接共享板，如实为 null
 *     error?: '读取 peers 失败'          // 仅在服务在、但读失败时出现；不含任何原始错误文本
 *   }
 *
 * 硬约束：**本模块任何输入都不许抛错**，也不许把 origin 里的 userinfo / path / query /
 * fragment / token 带出去。
 */

/** `selfSender()` 的占位 sessionId：本实例 id 与 session 无关，随便给一个不会有人用的值。 */
export const PROBE_SESSION_ID = '__probe__'

/** 取不到本实例 id 时的值。绝不用编出来的字符串冒充实例名。 */
export const UNKNOWN_INSTANCE = 'unknown'

/** 实例名上限：配置是本机的，但页面要往 SVG 文本里塞，截断比撑爆布局好。 */
const INSTANCE_ID_MAX = 80

/**
 * 把 interconnect 配置里的 origin 脱敏成 `host[:port]`。
 *
 * 剥掉的是：userinfo（`user:pass@`）、scheme、path、query（可能带 token）、fragment。
 * `URL.host` 已经丢掉默认端口（`http://h:80` → `h`），正好是「host[:port]」的语义。
 *
 * @param {unknown} origin - `peers()` 里那一行的 origin：字符串、self 解析函数、或空。
 * @returns {string|null} `host[:port]`；函数 / 空值 / 解析失败一律 `null`（页面显示「未配置」）。
 */
export function sanitizeOrigin(origin) {
  if (typeof origin !== 'string') return null
  const raw = origin.trim()
  if (raw === '') return null
  let url
  try {
    url = new URL(raw)
  } catch {
    // 少数配置直接写 `127.0.0.1:13080`（无 scheme）：补一个 http:// 再解析
    try {
      url = new URL(`http://${raw}`)
    } catch {
      return null
    }
  }
  if (typeof url.host !== 'string' || url.host === '') return null
  return url.host
}

/**
 * 生成本实例的集群快照（只读、同步、无 I/O）。
 *
 * @param {unknown} interconnect - `ctx.interconnect`，可以是 undefined / null / 假对象。
 * @param {number} [now] - 生成时间（毫秒）；非法值回落到 `Date.now()`，方便单测固定断言。
 * @returns {{generatedAt:string, interconnect:boolean, self:{instanceId:string}, peers:Array<{instanceId:string, origin:string|null, link:'up'|'down'}>, board:null, error?:string}}
 */
export function buildCluster(interconnect, now = Date.now()) {
  const generatedAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString()
  const empty = {
    generatedAt,
    interconnect: false,
    self: { instanceId: UNKNOWN_INSTANCE },
    peers: [],
    board: null,
  }
  if (interconnect === null || typeof interconnect !== 'object') return empty
  // 「服务在」的判据是它真的能读 peers，而不是 ctx 上恰好挂了个对象。
  // 没有 peers 方法的对象按「没有 interconnect」处理，如实返回 false。
  if (typeof interconnect.peers !== 'function') return empty

  let selfId = UNKNOWN_INSTANCE
  try {
    const sender = interconnect.selfSender?.(PROBE_SESSION_ID)
    if (sender !== null && typeof sender === 'object' && typeof sender.instanceId === 'string') {
      const trimmed = sender.instanceId.trim()
      if (trimmed !== '') selfId = trimmed.slice(0, INSTANCE_ID_MAX)
    }
  } catch {
    /* 服务没激活或签名不同：不猜，留 unknown */
  }

  let rows
  try {
    rows = interconnect.peers?.()
  } catch {
    // 服务在、但这一行读失败：如实标 error；**不把原始错误文本带出去**（可能含配置细节）
    return { ...empty, interconnect: true, self: { instanceId: selfId }, error: '读取 peers 失败' }
  }

  const peers = []
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const instanceId = typeof row.instanceId === 'string' ? row.instanceId.trim() : ''
      if (instanceId === '') continue
      peers.push({
        instanceId: instanceId.slice(0, INSTANCE_ID_MAX),
        origin: sanitizeOrigin(row.origin),
        // 只认 'up'；别的值一律 down，不把未知状态说成在线
        link: row.link === 'up' ? 'up' : 'down',
      })
    }
  }

  return { generatedAt, interconnect: true, self: { instanceId: selfId }, peers, board: null }
}
