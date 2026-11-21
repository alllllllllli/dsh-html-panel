#!/usr/bin/env node
/**
 * tools/mesh-snapshot.mjs —— dsh-team-mesh 的板库（SQLite）→ dsh-html-panel 只读快照。
 *
 * 一句话：把 `%USERPROFILE%\.dsh\team\team.db` 里的 task / event 两张表读出来，
 * 按面板的字段契约写成一份 JSON，面板宿主（`lib/index.js`）把它当快照源推给页面。
 *
 * 为什么单独一个脚本而不是让插件直接读库：
 * `lib/index.js` 的 `loadSnapshotMessage()` 只认"一个 JSON 文件或 URL"，它不知道
 * SQLite 的存在，也不知道 dsh-team-mesh 的存在（见该包的 README「The plugin does
 * not read the board service」）。这一层隔离是有意的：面板是只读显示件，板库的
 * schema 属于另一个包。所以"读库"这件事必须落在插件外面 —— 就是这个脚本。
 *
 * 硬约束（每一条都有出处，别"顺手优化"掉）：
 *   1. 零依赖，只用 `node:*`。`DatabaseSync` 以 `readOnly: true` 打开板库，
 *      绝不写它一个字节 —— 板服务可能正在跑，写锁会把它卡住。
 *   2. 顶层键就是 `lib/index.js:132-135` 认的形状（tasks/events/nodes）；
 *      `type`/`generatedAt`/`source` 由 Host 自己补（Host 会覆盖我们的
 *      generatedAt），这里写 generatedAt 只是给人和测试看的。
 *   3. 字段名一律用 `public/index.html` 的 `normTask()`/`normEvent()` 的**首选名**
 *      （id / state / leaseDeadline / at / text …），不去依赖它的别名表。
 *   4. 事件只进顶层 `events`，**绝不嵌进 `task.events`**：页面的 `applySnapshot()`
 *      会把嵌入的和顶层的都推进同一个全局事件流（`public/index.html:716` 与
 *      `:717-725`），两边都写就会把同一件事渲染两份。理由详见 tools/mesh-snapshot.md。
 *   5. 时间列都是**毫秒**（`store.js` 全部用 `Date.now()` 写），原样透传，不换算。
 *   6. 字符串超长/含换行原样给 —— 面板自己截断（`MAX_TEXT = 2000`，
 *      `public/index.html:579`）。这里砍一刀等于替别人做决定。
 *   7. 任何失败只打印一句人话，不抛栈；库里没有 task/event 表、只读打不开、
 *      老库缺列，都算"说清原因然后失败/降级"，不算崩溃。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 五态映射 / acceptance 拆行 / 事件正文摘要与 Host 路由共用同一份实现（lib/boardmap.js），
// 为什么抽出去：面板的 HTTP 路径与这个离线工具必须给出**同一套语义**。
import { asNumber, asText, toSnapshotEvent, toSnapshotTask } from '../lib/boardmap.js';
export { eventText, mapState, splitAcceptance } from '../lib/boardmap.js';

/** 本文件绝对路径（用来判断"是被当脚本跑还是被 import"）。 */
const SELF = fileURLToPath(import.meta.url);
/** 脚本所在目录：默认输出路径相对它解析。 */
const SCRIPT_DIR = dirname(SELF);

/** 板库默认位置（与 dsh-team-mesh 的 `LocalSqliteBackend` 默认一致）。 */
export const DEFAULT_DB = join(process.env.USERPROFILE || homedir(), '.dsh', 'team', 'team.db');

/** 快照默认输出：插件包自己的 `data\snapshot.json`（相对脚本目录的 `..\data\`）。 */
export const DEFAULT_OUT = resolve(SCRIPT_DIR, '..', 'data', 'snapshot.json');

/**
 * 可能要读的 task 列。
 *
 * 为什么不直接 `SELECT *`：v1 建的库没有 `ack_state` / `stale` / `lease_until` /
 * `lease_host` 这些列（它们是 v2/v4 用 `ALTER TABLE ADD COLUMN` 补的，见
 * `dsh-team-mesh/src/backend.js:192-221`）。按实际存在的列取，老库也能读，
 * 缺的字段在映射里按"没有这个信息"处理，而不是抛 `no such column`。
 */
const TASK_COLUMNS = [
  'task_id', 'title', 'brief', 'acceptance', 'lifecycle', 'owner_session', 'created_by',
  'version', 'created_at', 'updated_at', 'lease_pid', 'lease_start_sec', 'lease_host',
  'require_independent_review', 'ack_state', 'ack_deadline_at', 'ack_at',
  'lease_owner', 'lease_until', 'stale', 'stale_at',
];

/** event 表要读的列（v1 DDL 就全有，仍然照上面同样的理由过滤一遍）。 */
const EVENT_COLUMNS = ['seq', 'kind', 'task_id', 'actor', 'payload', 'created_at'];

/**
 * 事件正文用哪个 payload 字段当"人话"。
 *
 * 按 payload 里**实际出现过的**键排序（`store.js` 各处 appendEvent 的 payload：
 * task.canceled→reason、ack_timeout→meaning、evidence.recorded→note …）。都不命中
 * 就把整个 payload 压成一行 JSON —— 宁可给原始结构，也不编一句话。
 */
const TEXT_KEYS = ['message', 'note', 'reason', 'meaning', 'detail', 'text', 'title'];

const USAGE = `用法：node tools/mesh-snapshot.mjs [--db <path>] [--out <path>] [--watch <秒>] [--quiet]

  --db <path>     板库路径（默认 ${DEFAULT_DB}）
  --out <path>    快照输出路径（默认 ${DEFAULT_OUT}，相对脚本目录解析）；
                  显式给的相对路径按当前工作目录解析
  --watch <秒>     循环重写（默认一次性）。首轮失败仍然非零退出
  --quiet         不打印成功行 / 循环告警（错误照常打印）
  -h, --help      这段文字

退出码：0 成功；1 读不到板库 / 打不开 / 不是板库 / 写不出快照；2 命令行参数不对
`;

/** 读一张表的列名集合。表名是代码里的字面量，不接受外部输入。 */
function columnSet(db, table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)),
  );
}

/** 库里的表名集合。 */
function tableSet(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String(row.name)),
  );
}

/**
 * 读板库里的 task + event，组装成快照对象（纯读）。
 * @param {DatabaseSync} db 已打开的只读连接
 * @param {number} [now] 判定时刻（毫秒），测试可注入
 * @returns {{generatedAt:number, tasks:object[], events:object[], nodes:object[]}}
 */
export function buildSnapshot(db, now = Date.now()) {
  const tables = tableSet(db);
  if (!tables.has('task')) {
    throw new Error('这个库里没有 task 表，不像 dsh-team-mesh 的板库');
  }
  if (!tables.has('event')) {
    throw new Error('这个库里没有 event 表，不像 dsh-team-mesh 的板库');
  }

  const taskColumns = columnSet(db, 'task');
  if (!taskColumns.has('task_id') || !taskColumns.has('lifecycle')) {
    throw new Error('这个库的 task 表缺 task_id / lifecycle 列，不像 dsh-team-mesh 的板库');
  }
  const eventColumns = columnSet(db, 'event');
  if (!eventColumns.has('kind') || !eventColumns.has('created_at')) {
    throw new Error('这个库的 event 表缺 kind / created_at 列，不像 dsh-team-mesh 的板库');
  }

  const tasks = db
    .prepare(`SELECT ${TASK_COLUMNS.filter((c) => taskColumns.has(c)).join(', ')} FROM task`)
    .all();
  const events = db
    .prepare(`SELECT ${EVENT_COLUMNS.filter((c) => eventColumns.has(c)).join(', ')} FROM event`)
    .all();

  // 每个任务的事件条数：面板的「事件」列读 eventTotal（normTask:662），
  // 不写它就会显示 0，因为我们已经不给 task 嵌 events 了。
  const counts = new Map();
  for (const event of events) {
    const taskId = asText(event.task_id);
    if (taskId === null || taskId === '') continue;
    counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
  }

  const outTasks = tasks
    .map((row) => toSnapshotTask(row, now, counts.get(asText(row.task_id) ?? '') ?? 0))
    // 稳定顺序：先建的在前；同一毫秒按 id。面板自己还会按列排，这只是让 diff 好读。
    .sort((a, b) => ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const outEvents = events
    .map(toSnapshotEvent)
    .sort((a, b) => ((a.seq ?? 0) - (b.seq ?? 0)));

  return { generatedAt: now, tasks: outTasks, events: outEvents, nodes: [] };
}

/**
 * 以**只读**方式打开板库。
 *
 * 只读打开失败的三种现实原因（在本机都见过或可预期）：文件不在、被板服务独占、
 * WAL 的 `-shm` 边车文件不可用。这里**刻意不降级**成读写打开 —— 本工具的身份就是
 * "只读"，宁可报一句人话让人处理，也不冒险去写别人的板子（写锁能把板服务卡住）。
 *
 * @param {string} dbPath 绝对路径
 * @returns {DatabaseSync} 只读连接（调用方负责 close）
 */
export function openBoardReadOnly(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`板库不存在：${dbPath}`);
  let stat;
  try {
    stat = statSync(dbPath);
  } catch (error) {
    throw new Error(`读不到板库文件：${dbPath}（${(error && error.code) || error.message || error}）`);
  }
  if (!stat.isFile()) throw new Error(`板库路径不是文件：${dbPath}`);
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`打不开板库（只读）：${dbPath}（${(error && error.message) || error}）`);
  }
}

/**
 * 打开 → 组装 → 写文件。
 *
 * 写盘走"临时文件 + rename"：面板每次加载都重读这个文件，读到半个 JSON 会让
 * 页面报 `JSON.parse` 失败。rename 在 NTFS 上是原子的，读方要么看到旧的完整
 * 文件，要么看到新的完整文件。
 *
 * @param {{db:string, out:string, quiet?:boolean}} options
 * @returns {{tasks:number, events:number, bytes:number, out:string}}
 */
export function exportSnapshot(options) {
  const dbPath = resolve(options.db);
  const outPath = resolve(options.out);
  const db = openBoardReadOnly(dbPath);
  let snapshot;
  try {
    snapshot = buildSnapshot(db, Date.now());
  } finally {
    db.close();
  }
  // 2 空格缩进 + 末尾一个换行；UTF-8 无 BOM（writeFileSync 写 'utf8' 不加 BOM）
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  const directory = dirname(outPath);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new Error(`建不了输出目录：${directory}（${(error && error.message) || error}）`);
  }
  const tempPath = `${outPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, text, 'utf8');
    renameSync(tempPath, outPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* 临时文件可能根本没建成 */ }
    throw new Error(`写不出快照：${outPath}（${(error && error.code) || error.message || error}）`);
  }
  return {
    tasks: snapshot.tasks.length,
    events: snapshot.events.length,
    // 用磁盘上的真实大小，而不是字符串长度：这个数字要能被 `dir` 复核
    bytes: statSync(outPath).size,
    out: outPath,
  };
}

/**
 * 解析命令行。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{db:string, out:string, watchSec:number, quiet:boolean, help:boolean}}
 */
export function parseArgs(argv) {
  const options = { db: DEFAULT_DB, out: DEFAULT_OUT, watchSec: 0, quiet: false, help: false };
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const takeValue = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} 后面缺一个值`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--db':
        options.db = resolve(takeValue());
        break;
      case '--out':
        options.out = resolve(takeValue());
        break;
      case '--watch': {
        const raw = takeValue();
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(`--watch 需要正数秒，收到 ${JSON.stringify(raw)}`);
        }
        options.watchSec = seconds;
        break;
      }
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`不认识的参数：${arg}（--help 看用法）`);
    }
  }
  return options;
}

/** 打印一次成功行：`tasks=N events=M bytes=B out=<abs>`。 */
function report(result) {
  console.log(`tasks=${result.tasks} events=${result.events} bytes=${result.bytes} out=${result.out}`);
}

/** CLI 主流程。 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`mesh-snapshot: ${error.message}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  // 首轮失败一律非零退出（包括 --watch：不在坏配置上空转，否则 kill 掉进程前
  // 谁也不知道它在等什么）
  try {
    const result = exportSnapshot(options);
    if (!options.quiet) report(result);
  } catch (error) {
    console.error(`mesh-snapshot: ${error.message}`);
    process.exit(1);
  }

  if (options.watchSec <= 0) return;

  const tick = () => {
    setTimeout(() => {
      try {
        const result = exportSnapshot(options);
        if (!options.quiet) report(result);
      } catch (error) {
        // 循环里出错不退出：板库可能正被 checkpoint / 被换掉，下一轮再试
        console.error(`mesh-snapshot: 本轮失败：${error.message}`);
      }
      tick();
    }, Math.round(options.watchSec * 1000));
  };
  tick();
}

// 只有被当脚本直接跑才进 main()：测试要 import 上面的纯函数，不能被 CLI 抢跑。
// Windows 上 argv[1] 的大小写/短路径形式都可能不同，按不区分大小写比较。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = invokedPath !== '' && (
  process.platform === 'win32'
    ? invokedPath.toLowerCase() === SELF.toLowerCase()
    : invokedPath === SELF
);
if (isMain) main();
