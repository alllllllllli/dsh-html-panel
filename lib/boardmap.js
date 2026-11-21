/**
 * 共享板数据 → 面板字段的**纯函数映射层**。
 *
 * 为什么单独一个文件：面板现在有两条读板路径 ——
 *   1. `lib/board.js`（Host 路由 `/api/board`，走板服务的 HTTP 只读路由）；
 *   2. `tools/mesh-snapshot.mjs`（离线工具，直接只读打开板库 SQLite）。
 * 两条路径的**状态语义必须一模一样**，所以五态映射、acceptance 拆行、事件正文摘要
 * 都只在这里写一份，两边 import。改这里的映射表前先读 `tools/mesh-snapshot.md`。
 *
 * 本模块零依赖、纯函数、**任何输入都不抛错**。时间单位一律**毫秒**，原样透传。
 */

/** 把任意值转成数字或 null（SQLite 可能给 number / bigint / 文本，HTTP 是 number）。 */
export function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 把任意值转成字符串或 null（不字符串化 null/undefined）。 */
export function asText(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * 板子的 lifecycle + 租约 + 回执 → 面板的五态。
 *
 * **这张表就是数据契约**（可执行版本见 `tools/mesh-snapshot.test.mjs` 的 A 组）。
 * 面板只认 undelivered / awaiting / leased / stale / done，其余字符串一律原样透传
 * （页面显示「未知」并保留原始值）。
 *
 * 顺序是判定优先级：
 *   1. done        —— 终态，哪怕 stale 标记残留也是"已完成"
 *   2. canceled    —— 面板五态里没有"已取消"，**原样透传**，不猜成 done
 *   3. stale       —— `stale=1` 优先于租约时间；其次"租约到期且任务未完成"
 *   4. leased      —— claimed/working 且租约还在未来
 *   5. blocked     —— 面板没有"受阻"，原样透传
 *   6. open        —— 看派发回执：pending/timeout = awaiting；acked = 原样 open；
 *                     其余 = undelivered
 *   7. 其余 → 原样透传 / unknown
 *
 * @param {object} row task 行（原始值；缺列时为 undefined）
 * @param {number} now 判定时刻（毫秒）
 * @returns {string} 面板状态串（五态之一，或原样透传的 lifecycle，或 'unknown'）
 */
export function mapState(row, now) {
  const src = row && typeof row === 'object' ? row : {};
  const lifecycle = typeof src.lifecycle === 'string' ? src.lifecycle : '';

  // 1) 终态先行
  if (lifecycle === 'done') return 'done';
  // 2) canceled：五态无槽位 → 原样透传
  if (lifecycle === 'canceled') return 'canceled';

  // 3) 租约失效
  const staleFlag = asNumber(src.stale) === 1;
  const leaseUntil = asNumber(src.lease_until);
  const leaseExpired = leaseUntil !== null && leaseUntil <= now;
  if (staleFlag || leaseExpired) return 'stale';

  // 4) 认领 + 租约有效
  if ((lifecycle === 'claimed' || lifecycle === 'working') && leaseUntil !== null && leaseUntil > now) {
    return 'leased';
  }

  // 5) blocked：原样透传
  if (lifecycle === 'blocked') return 'blocked';

  // 6) open：还没人认领，只能靠回执窗口说话
  if (lifecycle === 'open') {
    const ack = typeof src.ack_state === 'string' ? src.ack_state : '';
    if (ack === 'pending' || ack === 'timeout') return 'awaiting';
    if (ack === 'acked') return 'open';
    return 'undelivered';
  }

  // 7) 认不出来原样给，不编
  return lifecycle === '' ? 'unknown' : lifecycle;
}

/**
 * 库里的 `acceptance`（单个自由文本串）→ 面板要的字符串数组。
 *
 * 板库只约定**一个字符串**；唯一能认的分隔约定是**换行**（`acceptanceRef` 说明多条
 * 目是作者自己分行写的）。有换行按行拆（去空行、去首尾空白），拆不出来整条一个元素。
 * @param {unknown} value
 * @returns {string[]} 空串给空数组
 */
export function splitAcceptance(value) {
  const text = asText(value);
  if (text === null || text.trim() === '') return [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return lines;
}

/**
 * 事件 payload → 界面上一行正文。
 *
 * 两种输入形态都要认：
 *   - SQLite 路径给的是**原始 TEXT**（`tools/mesh-snapshot.mjs`）；
 *   - HTTP 路径给的是**已 JSON.parse 的对象**（`lib/board.js` → `/events`）。
 * 不认识的 payload 压成一行 JSON，比编一句话诚实。payload 不是合法 JSON 时原样返回。
 * @param {unknown} raw event.payload
 * @returns {string} 可能是空串
 */
export function eventText(raw) {
  if (raw === null || raw === undefined) return '';
  let payload;
  if (typeof raw === 'object') {
    payload = raw;
  } else {
    const source = asText(raw);
    if (source === null || source === '') return '';
    try {
      payload = JSON.parse(source);
    } catch {
      return source;
    }
  }
  if (payload === null) return '';
  if (typeof payload !== 'object') return String(payload);
  // 板服务的 safeParse() 解析失败时给 `{ _raw: '<原文>' }`
  if (typeof payload._raw === 'string') return payload._raw;
  const TEXT_KEYS = ['message', 'note', 'reason', 'meaning', 'detail', 'text', 'title'];
  for (const key of TEXT_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}

/**
 * 一行 task → 面板任务条目（离线快照与 HTTP 路由共用）。
 *
 * 只写面板认的字段；**不写 `events`**（事件只进顶层 `events`，否则重复渲染）。
 * 额外带上原始 `lifecycle` / `ackState`，人工查 JSON 时能看出五态怎么映射来的。
 *
 * @param {object} row task 行
 * @param {number} now 判定时刻（毫秒）
 * @param {number} [eventTotal] 该任务的事件条数（离线快照用；HTTP 路径不关心）
 * @returns {object}
 */
export function toSnapshotTask(row, now, eventTotal = 0) {
  const source = row && typeof row === 'object' ? row : {};
  const lifecycle = typeof source.lifecycle === 'string' ? source.lifecycle : '';
  const state = mapState(source, now);

  const leaseUntil = asNumber(source.lease_until);
  const ackDeadlineAt = asNumber(source.ack_deadline_at);
  const updatedAt = asNumber(source.updated_at);
  const staleAt = asNumber(source.stale_at);

  // stale 行的「过期于 X 前」用哪个时刻：扫描器标记时刻 → 租约/回执期限 → 最后更新时间
  const expiredAt = state === 'stale'
    ? (staleAt ?? leaseUntil ?? ackDeadlineAt ?? updatedAt)
    : null;

  const item = {
    id: asText(source.task_id) ?? '',
    title: asText(source.title) ?? '',
    state,
    owner: asText(source.owner_session),
    requireReview: asNumber(source.require_independent_review) === 1,
    eventTotal,
    brief: asText(source.brief) ?? '',
    acceptance: splitAcceptance(source.acceptance),
    // 时间列全是毫秒，原样交给面板
    createdAt: asNumber(source.created_at),
    updatedAt,
    leaseDeadline: leaseUntil,
    ackDeadline: ackDeadlineAt,
    ackAt: asNumber(source.ack_at),
    expiredAt,
    doneAt: state === 'done' ? updatedAt : null,
    // 原始值：面板不读，留给查 JSON 的人
    lifecycle,
    ackState: asText(source.ack_state),
  };

  // 板子没有"任务在哪台机器"的独立列，`lease_host` 是唯一能回答"谁在跑它"的字段。
  const leaseHost = asText(source.lease_host);
  if (leaseHost !== null && leaseHost !== '') item.node = leaseHost;

  return item;
}

/**
 * HTTP 路径专用：板服务 `/task/list` 的行 → 面板任务条目。
 *
 * 与 `toSnapshotTask` 的差别只有两处，且都是 HTTP 板服务的信息边界决定的：
 *   - `/task/list` 不返回事件条数，没有 `eventTotal`；
 *   - 证据要单独打 `/task/evidence?taskId=` 才有条数，所以交给调用方带进来，
 *     拿不到就是 `null`（页面显示「证据 —」，不编 0）。
 *
 * @param {object} row 板服务返回的 task 行（snake_case）
 * @param {number} now 判定时刻（毫秒）
 * @param {number|null} evidenceCount 该任务的证据条数；null = 没取到
 * @returns {object}
 */
export function mapBoardTask(row, now, evidenceCount) {
  const task = toSnapshotTask(row, now, 0);
  delete task.eventTotal;
  task.evidenceCount = Number.isInteger(evidenceCount) && evidenceCount >= 0 ? evidenceCount : null;
  return task;
}

/**
 * 一行 event → 面板事件条目。
 *
 * `task` 是任务 id（可为空串：板允许 task_id 为 NULL 的事件，照实列出、不丢）。
 * `node` 列放的是 `actor` —— 板库/板服务都没有 host 列，actor 是唯一"谁干的"。
 * @param {object} row event 行（SQLite 原始行或 HTTP 行）
 * @returns {object}
 */
export function toSnapshotEvent(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    task: asText(source.task_id) ?? '',
    at: asNumber(source.created_at),
    kind: asText(source.kind) ?? 'event',
    node: asText(source.actor) ?? '',
    text: eventText(source.payload),
    seq: asNumber(source.seq),
  };
}
