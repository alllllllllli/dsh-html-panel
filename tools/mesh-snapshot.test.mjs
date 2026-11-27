#!/usr/bin/env node
/**
 * tools/mesh-snapshot.test.mjs —— tools/mesh-snapshot.mjs 的断言集（零依赖自跑）。
 *
 * 跑法：
 *   "C:\Users\demo\AppData\Local\Programs\DeepSeek Harness\resources\runtime\
 *    primary-runtime\dependencies\node\bin\node.exe" tools\mesh-snapshot.test.mjs
 *
 * 覆盖什么（按被断言的东西分三组）：
 *   A. 状态映射：六种 lifecycle、租约过期、stale=1、ack 回执分支、认不出来的值
 *   B. 数据形状：事件只在顶层、时间单位是毫秒且原样透传、acceptance 拆行、
 *      超长 title 不被砍、NULL 字段、老库缺列、坏 payload、空库
 *   C. CLI：成功行的格式、退出码、只读打开失败的人话、2 空格缩进、UTF-8 无 BOM
 *
 * 为什么自己写断言而不引测试框架：这个包零依赖（`package.json` 里没有
 * devDependencies），为一个导出器拉一个框架进来不划算；断言数量也就几十条。
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DB,
  DEFAULT_OUT,
  buildSnapshot,
  exportSnapshot,
  mapState,
  parseArgs,
  splitAcceptance,
} from './mesh-snapshot.mjs';

/** 被测 CLI 的绝对路径。 */
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'mesh-snapshot.mjs');

/** 所有用例共用的"现在"：固定值，好断言换算后的数字。 */
const NOW = 1_795_000_000_000;
const FUTURE = NOW + 300_000;
const EXPIRED = NOW - 300_000;

/* ─────────────────────────── 断言小工具 ─────────────────────────── */
let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  ✗ ${label}`);
  return false;
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return ok(a === b, a === b ? label : `${label} —— 期望 ${b}，实际 ${a}`);
}

/* ─────────────────────────── 假库 ─────────────────────────── */
/** 与实测 dump 一致的 task / event 两表（v4 列全）。 */
const DDL_V4 = `
CREATE TABLE task (
  task_id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open','claimed','working','blocked','done','canceled')),
  owner_session TEXT, created_by TEXT NOT NULL, request_id TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  lease_pid INTEGER, lease_start_sec INTEGER, lease_host TEXT,
  require_independent_review INTEGER NOT NULL DEFAULT 0,
  ack_state TEXT NOT NULL DEFAULT 'none', ack_deadline_at INTEGER, ack_at INTEGER,
  lease_owner TEXT, lease_until INTEGER,
  stale INTEGER NOT NULL DEFAULT 0, stale_at INTEGER);
CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT, actor TEXT,
  payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
`;

/** v1 时代的 task 表：没有 ack_* / lease_* / stale* / require_independent_review。 */
const DDL_V1 = `
CREATE TABLE task (
  task_id TEXT PRIMARY KEY, title TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '', lifecycle TEXT NOT NULL,
  owner_session TEXT, created_by TEXT NOT NULL, request_id TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT, actor TEXT,
  payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
`;

/**
 * 建一个临时库。
 * @param {string} dir 临时目录
 * @param {string} name 文件名
 * @param {string} ddl 建表语句
 */
function makeDb(dir, name, ddl) {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec(ddl);
  return { db, path };
}

/** 通用插入：只写给出的列，其余走 DDL 默认值。 */
function insert(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  db.prepare(sql).run(...keys.map((key) => row[key]));
}

/** 用文件重定向抓子进程输出（不建管道：受限环境下管道会 EPERM）。 */
function runCli(args) {
  const stem = join(TMP, `cli-${(runCli.counter = (runCli.counter ?? 0) + 1)}`);
  const outPath = `${stem}.stdout`;
  const errPath = `${stem}.stderr`;
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      encoding: 'utf8',
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: result.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

// 临时目录放在系统 tmp 下：本用例不碰插件包里的任何东西（除了 --out 的默认值常量）
const TMP = mkdtempSync(join(tmpdir(), 'mesh-snapshot-test-'));
console.log(`临时目录：${TMP}`);
console.log('');

try {
  /* ─────────── A. 状态映射（直接打 mapState，先把映射表钉死） ─────────── */
  console.log('A. 状态映射 rule by rule');
  eq(mapState({ lifecycle: 'done', stale: 0, lease_until: null }, NOW), 'done', 'done → done');
  eq(mapState({ lifecycle: 'done', stale: 1, stale_at: NOW - 1 }, NOW), 'done', 'done 残留 stale 标记仍是 done');
  eq(mapState({ lifecycle: 'canceled' }, NOW), 'canceled', 'canceled 原样透传（不猜成 done）');
  eq(mapState({ lifecycle: 'blocked' }, NOW), 'blocked', 'blocked 原样透传（不猜成 done）');
  eq(mapState({ lifecycle: 'claimed', lease_until: FUTURE, stale: 0 }, NOW), 'leased', 'claimed + 租约在未来 → leased');
  eq(mapState({ lifecycle: 'working', lease_until: FUTURE, stale: 0 }, NOW), 'leased', 'working + 租约在未来 → leased');
  eq(mapState({ lifecycle: 'working', lease_until: EXPIRED, stale: 0 }, NOW), 'stale', '租约已过期 → stale');
  eq(mapState({ lifecycle: 'working', lease_until: FUTURE, stale: 1 }, NOW), 'stale', 'stale=1 优先于有效租约');
  eq(mapState({ lifecycle: 'claimed', lease_until: NOW, stale: 0 }, NOW), 'stale', 'lease_until 恰好等于 now → stale（<= 口径）');
  eq(mapState({ lifecycle: 'open', ack_state: 'none' }, NOW), 'undelivered', 'open + ack_state=none → undelivered');
  eq(mapState({ lifecycle: 'open', ack_state: 'pending' }, NOW), 'awaiting', 'open + ack_state=pending → awaiting');
  eq(mapState({ lifecycle: 'open', ack_state: 'timeout' }, NOW), 'awaiting', 'open + ack_state=timeout → awaiting（信到了没人管）');
  eq(mapState({ lifecycle: 'open', ack_state: 'acked' }, NOW), 'open', 'open + ack_state=acked → 原样 open（五态无槽位）');
  eq(mapState({ lifecycle: 'open' }, NOW), 'undelivered', '老库没有 ack_state 列 → undelivered（保守：不声称有回执）');
  eq(mapState({ lifecycle: 'claimed' }, NOW), 'claimed', 'claimed 但没有 lease_until（老库）→ 原样透传');
  eq(mapState({ lifecycle: 'mystery' }, NOW), 'mystery', '认不出来的 lifecycle 原样透传');
  eq(mapState({}, NOW), 'unknown', '完全没有 lifecycle → unknown');
  eq(mapState(null, NOW), 'unknown', 'null 行 → unknown（不抛错）');

  /* ─────────── B1. 主假库：六种 lifecycle + 各种边角 ─────────── */
  console.log('');
  console.log('B1. 快照数据形状（六 lifecycle / 过期 / stale / NULL / 超长 / 空 acceptance）');
  const main = makeDb(TMP, 'main.db', DDL_V4);
  const LONG_TITLE = `长标题-${'x'.repeat(3500)}`;

  // 六种 lifecycle 各一条（open 的那条顺便兼"未送达"）
  insert(main.db, 'task', {
    task_id: 't-open', title: '打开的', brief: '背景 A', acceptance: '',
    lifecycle: 'open', owner_session: null, created_by: 'orch',
    created_at: NOW - 90_000, updated_at: NOW - 80_000,
  });
  insert(main.db, 'task', {
    task_id: 't-claimed', title: '已认领的', brief: '', acceptance: 'A01 甲\nA02 乙\n',
    lifecycle: 'claimed', owner_session: 'sess-A', created_by: 'orch',
    created_at: NOW - 70_000, updated_at: NOW - 60_000,
    lease_owner: 'sess-A', lease_until: FUTURE, lease_host: 'DESKTOP-3B45810',
    lease_pid: 1234, lease_start_sec: Math.floor(NOW / 1000) - 100,
  });
  insert(main.db, 'task', {
    task_id: 't-working', title: '在做的', brief: '', acceptance: 'A01 丙',
    lifecycle: 'working', owner_session: 'sess-B', created_by: 'orch',
    created_at: NOW - 50_000, updated_at: NOW - 40_000,
    lease_owner: 'sess-B', lease_until: FUTURE, require_independent_review: 1,
  });
  insert(main.db, 'task', {
    task_id: 't-blocked', title: '受阻的', brief: '', acceptance: '',
    lifecycle: 'blocked', owner_session: 'sess-C', created_by: 'orch',
    created_at: NOW - 30_000, updated_at: NOW - 20_000,
  });
  insert(main.db, 'task', {
    task_id: 't-done', title: '完成的', brief: '', acceptance: '',
    lifecycle: 'done', owner_session: 'sess-D', created_by: 'orch',
    created_at: NOW - 200_000, updated_at: NOW - 5_000,
  });
  insert(main.db, 'task', {
    task_id: 't-canceled', title: '取消的', brief: '', acceptance: '',
    lifecycle: 'canceled', owner_session: null, created_by: 'orch',
    created_at: NOW - 150_000, updated_at: NOW - 10_000,
  });
  // 租约过期（stale 标记没置）
  insert(main.db, 'task', {
    task_id: 't-expired', title: '租约过期的', brief: '', acceptance: '',
    lifecycle: 'working', owner_session: 'sess-E', created_by: 'orch',
    created_at: NOW - 400_000, updated_at: NOW - 350_000,
    lease_owner: 'sess-E', lease_until: EXPIRED, stale: 0,
  });
  // stale=1（租约时间还在未来，但扫描器已宣告失效）
  insert(main.db, 'task', {
    task_id: 't-stale-flag', title: '被标 stale 的', brief: '', acceptance: '',
    lifecycle: 'working', owner_session: 'sess-F', created_by: 'orch',
    created_at: NOW - 500_000, updated_at: NOW - 450_000,
    lease_owner: 'sess-F', lease_until: FUTURE, stale: 1, stale_at: NOW - 1_000,
  });
  // owner_session 为 NULL
  insert(main.db, 'task', {
    task_id: 't-no-owner', title: '没人认领的（NULL owner）', brief: '', acceptance: '',
    lifecycle: 'open', owner_session: null, created_by: 'orch',
    created_at: NOW - 20_000, updated_at: NOW - 20_000, ack_state: 'pending',
    ack_deadline_at: NOW + 60_000,
  });
  // 超长 title（>3000 字符）+ 空 acceptance
  insert(main.db, 'task', {
    task_id: 't-long', title: LONG_TITLE, brief: '', acceptance: '',
    lifecycle: 'open', owner_session: null, created_by: 'orch',
    created_at: NOW - 10_000, updated_at: NOW - 10_000,
  });
  // 有 3 条事件的任务
  insert(main.db, 'task', {
    task_id: 't-events-3', title: '有三条事件的', brief: '',
    acceptance: '  前后都有空白的单条  ',
    lifecycle: 'claimed', owner_session: 'sess-G', created_by: 'orch',
    created_at: NOW - 60_000, updated_at: NOW - 30_000,
    lease_owner: 'sess-G', lease_until: FUTURE,
  });

  // 事件：3 条属于 t-events-3；1 条指向不存在的任务；1 条 task_id 为 NULL；
  //       1 条 payload 不是合法 JSON；1 条 actor 为 NULL
  insert(main.db, 'event', { kind: 'task.created', task_id: 't-events-3', actor: 'orch', payload: '{"title":"有三条事件的"}', created_at: NOW - 60_000 });
  insert(main.db, 'event', { kind: 'task.claimed', task_id: 't-events-3', actor: 'sess-G', payload: '{"lease_ms":600000}', created_at: NOW - 50_000 });
  insert(main.db, 'event', { kind: 'lease.renewed', task_id: 't-events-3', actor: 'sess-G', payload: '{"via":"heartbeat"}', created_at: NOW - 40_000 });
  insert(main.db, 'event', { kind: 'task.done', task_id: 't-ghost', actor: 'sess-Z', payload: '{"evidence_count":2}', created_at: NOW - 30_000 });
  insert(main.db, 'event', { kind: 'peer.event', task_id: null, actor: null, payload: '{"kind":"agent/status","status":"idle"}', created_at: NOW - 20_000 });
  insert(main.db, 'event', { kind: 'task.canceled', task_id: 't-canceled', actor: 'orch', payload: '{not json', created_at: NOW - 10_000 });
  main.db.close();

  const snap = (() => {
    const db = new DatabaseSync(main.path, { readOnly: true });
    try { return buildSnapshot(db, NOW); } finally { db.close(); }
  })();
  const byId = new Map(snap.tasks.map((task) => [task.id, task]));

  eq(snap.tasks.length, 11, '11 条任务全部导出');
  eq(snap.events.length, 6, '6 条事件全部导出');
  eq(snap.nodes, [], 'nodes 是空数组（板库没有节点表）');
  eq(snap.generatedAt, NOW, 'generatedAt 用注入的 now');

  // 六种 lifecycle 的映射结果（也就是交付报告里那张表的可执行版本）
  eq(byId.get('t-open').state, 'undelivered', 'lifecycle=open → undelivered');
  eq(byId.get('t-claimed').state, 'leased', 'lifecycle=claimed + 租约在未来 → leased');
  eq(byId.get('t-working').state, 'leased', 'lifecycle=working + 租约在未来 → leased');
  eq(byId.get('t-blocked').state, 'blocked', 'lifecycle=blocked → 原样 blocked');
  eq(byId.get('t-done').state, 'done', 'lifecycle=done → done');
  eq(byId.get('t-canceled').state, 'canceled', 'lifecycle=canceled → 原样 canceled');
  eq(byId.get('t-expired').state, 'stale', '租约过期未完成 → stale');
  eq(byId.get('t-stale-flag').state, 'stale', 'stale=1 → stale（优先于未来租约）');

  // 时间：毫秒原样透传，不 ×1000 也不 ÷1000
  eq(byId.get('t-claimed').leaseDeadline, FUTURE, 'leaseDeadline 就是库里的毫秒值（不换算）');
  eq(byId.get('t-done').doneAt, NOW - 5_000, 'done 行 doneAt = updated_at（毫秒）');
  eq(byId.get('t-expired').expiredAt, EXPIRED, 'stale（过期）expiredAt = lease_until');
  eq(byId.get('t-stale-flag').expiredAt, NOW - 1_000, 'stale（标记）expiredAt = stale_at');
  eq(byId.get('t-no-owner').ackDeadline, NOW + 60_000, 'ackDeadline 就是库里的毫秒值');
  eq(byId.get('t-claimed').createdAt, NOW - 70_000, 'createdAt 原样给出');
  eq(byId.get('t-done').expiredAt, null, '非 stale 行 expiredAt 为 null');

  // 文本：超长不砍、空 acceptance 给空数组、多行按行拆
  eq(byId.get('t-long').title.length, LONG_TITLE.length, `超长 title（${LONG_TITLE.length} 字符）原样给出，不截断`);
  eq(byId.get('t-long').title, LONG_TITLE, '超长 title 内容逐字相同');
  eq(byId.get('t-long').acceptance, [], 'acceptance 空串 → 空数组');
  eq(byId.get('t-claimed').acceptance, ['A01 甲', 'A02 乙'], 'acceptance 多行 → 按行拆、去空行');
  eq(byId.get('t-events-3').acceptance, ['前后都有空白的单条'], 'acceptance 单行（带首尾空白）→ 一个元素且已 trim');
  eq(byId.get('t-open').brief, '背景 A', 'brief 原样给');

  // NULL / 布尔
  eq(byId.get('t-open').owner, null, 'owner_session 为 NULL → owner=null（不编造）');
  eq(byId.get('t-working').requireReview, true, 'require_independent_review=1 → requireReview=true');
  eq(byId.get('t-claimed').requireReview, false, 'require_independent_review 默认 0 → requireReview=false');
  eq(byId.get('t-claimed').node, 'DESKTOP-3B45810', 'lease_host → node');
  eq(byId.get('t-blocked').node, undefined, '没有 lease_host 的任务不写 node 键');
  eq(byId.get('t-blocked').lifecycle, 'blocked', '原始 lifecycle 一并带出（给人查 JSON 用）');

  // 事件契约：只出现在顶层
  ok(snap.tasks.every((task) => !Object.prototype.hasOwnProperty.call(task, 'events')),
    '没有任何 task 带 events 键（事件只在顶层，避免面板推两份）');
  eq(byId.get('t-events-3').eventTotal, 3, 'eventTotal 精确等于该任务的事件条数');
  const eventsOf = (id) => snap.events.filter((event) => event.task === id);
  eq(eventsOf('t-events-3').length, 3, 't-events-3 的 3 条事件都在顶层 events 里');
  eq(eventsOf('t-events-3').map((event) => event.kind), ['task.created', 'task.claimed', 'lease.renewed'], '事件 kind 与库里一致，顺序按 seq');
  eq(eventsOf('t-events-3')[0].at, NOW - 60_000, '事件 at 是毫秒原值');
  eq(eventsOf('t-events-3')[0].node, 'orch', '事件 node 取 actor');
  eq(eventsOf('t-events-3')[2].text, '{"via":"heartbeat"}', 'payload 没有可读字段时给一行 JSON');
  eq(eventsOf('t-ghost').length, 1, '指向不存在任务的事件照样导出（不丢、不挂）');
  ok(!byId.has('t-ghost'), '而且不会因此凭空造出一个任务行');
  eq(snap.events.filter((event) => event.task === '').length, 1, 'task_id 为 NULL 的事件 → task=""（面板列为未关联）');
  const badPayload = snap.events.find((event) => event.kind === 'task.canceled');
  eq(badPayload.text, '{not json', 'payload 不是合法 JSON → 原样给字符串，不抛错');
  const nullActor = snap.events.find((event) => event.kind === 'peer.event');
  eq(nullActor.node, '', 'actor 为 NULL → node=""');

  /* ─────────── B2. 空库 ─────────── */
  console.log('');
  console.log('B2. 空库');
  const emptyDb = makeDb(TMP, 'empty.db', DDL_V4);
  emptyDb.db.close();
  const emptySnap = exportSnapshot({ db: emptyDb.path, out: join(TMP, 'out', 'empty.json') });
  eq(emptySnap.tasks, 0, '空库导出 0 条任务');
  eq(emptySnap.events, 0, '空库导出 0 条事件');
  const emptyJson = JSON.parse(readFileSync(join(TMP, 'out', 'empty.json'), 'utf8'));
  eq(emptyJson, { generatedAt: emptyJson.generatedAt, tasks: [], events: [], nodes: [] }, '空库 JSON 形状完整（四个键都在）');
  ok(Number.isFinite(emptyJson.generatedAt), '空库也有 generatedAt');

  /* ─────────── B3. 老库（v1，缺 ack/lease/stale 列） ─────────── */
  console.log('');
  console.log('B3. 老库缺列（v1 task 表）');
  const oldDb = makeDb(TMP, 'old.db', DDL_V1);
  insert(oldDb.db, 'task', {
    task_id: 'o-open', title: '老库 open', lifecycle: 'open', created_by: 'orch',
    created_at: NOW - 2_000, updated_at: NOW - 2_000,
  });
  insert(oldDb.db, 'task', {
    task_id: 'o-claimed', title: '老库 claimed', lifecycle: 'claimed', owner_session: 'sess-old',
    created_by: 'orch', created_at: NOW - 1_000, updated_at: NOW - 1_000,
  });
  oldDb.db.close();
  let oldSnapError = null;
  let oldSnap = null;
  try {
    const db = new DatabaseSync(oldDb.path, { readOnly: true });
    try { oldSnap = buildSnapshot(db, NOW); } finally { db.close(); }
  } catch (error) {
    oldSnapError = error;
  }
  ok(oldSnapError === null, oldSnapError === null ? '老库缺列不抛错' : `老库缺列抛错了：${oldSnapError && oldSnapError.message}`);
  if (oldSnap !== null) {
    const oldById = new Map(oldSnap.tasks.map((task) => [task.id, task]));
    eq(oldById.get('o-open').state, 'undelivered', '老库 open → undelivered（没有回执信息，不声称有）');
    eq(oldById.get('o-claimed').state, 'claimed', '老库 claimed 无租约 → 原样 claimed');
    eq(oldById.get('o-claimed').leaseDeadline, null, '缺 lease_until 列 → leaseDeadline=null');
    eq(oldById.get('o-open').node, undefined, '缺 lease_host 列 → 不写 node');
  }

  /* ─────────── B4. 坏值不抛错 ─────────── */
  console.log('');
  console.log('B4. 坏值 / 缺字段不抛错');
  eq(splitAcceptance(null), [], 'splitAcceptance(null) → []');
  eq(splitAcceptance(undefined), [], 'splitAcceptance(undefined) → []');
  eq(splitAcceptance('   \n  \n'), [], 'splitAcceptance(全空白) → []');
  eq(splitAcceptance('单条'), ['单条'], 'splitAcceptance(单条) → 一个元素');
  eq(splitAcceptance(12345), ['12345'], 'splitAcceptance(数字) 不抛错');
  let weirdError = null;
  let snapOfWeird = null;
  try {
    // lifecycle 被 CHECK 约束挡着插不进去，所以直接喂映射函数（等价于库里出现脏值）
    snapOfWeird = {
      a: mapState({ lifecycle: 'weird', stale: '1' }, NOW),
      b: mapState({ lifecycle: 'open', ack_state: 'PENDING' }, NOW),
      c: mapState({ lifecycle: 'claimed', lease_until: String(FUTURE) }, NOW),
    };
  } catch (error) {
    weirdError = error;
  }
  ok(weirdError === null, '脏字段进 mapState 不抛错');
  if (snapOfWeird !== null) {
    eq(snapOfWeird.a, 'stale', 'stale 是字符串 "1" 也认');
    eq(snapOfWeird.b, 'undelivered', 'ack_state 大小写不符（PENDING）不认，落 undelivered');
    eq(snapOfWeird.c, 'leased', 'lease_until 是数字字符串也能比');
  }

  /* ─────────── C. CLI ─────────── */
  console.log('');
  console.log('C. CLI 行为');

  // 默认值就是契约里写的那两个
  ok(isAbsolute(DEFAULT_DB) && DEFAULT_DB.endsWith(join('.dsh', 'team', 'team.db')), `默认库路径指向 .dsh\\team\\team.db（${DEFAULT_DB}）`);
  ok(isAbsolute(DEFAULT_OUT) && DEFAULT_OUT.endsWith(join('dsh-html-panel', 'data', 'snapshot.json')), `默认输出相对脚本目录解析成绝对路径（${DEFAULT_OUT}）`);

  // 成功：stdout 一行、2 空格缩进、无 BOM、退出码 0
  const goodOut = join(TMP, 'out', 'snap.json');
  const good = runCli(['--db', main.path, '--out', goodOut]);
  eq(good.status, 0, '成功时退出码 0');
  const line = good.stdout.trim();
  ok(/^tasks=\d+ events=\d+ bytes=\d+ out=/.test(line), `stdout 是 tasks=N events=M bytes=B out=<abs>（实际：${line}）`);
  const parsedLine = Object.fromEntries(line.split(/\s+/).map((part) => {
    const at = part.indexOf('=');
    return [part.slice(0, at), part.slice(at + 1)];
  }));
  eq(Number(parsedLine.tasks), 11, 'stdout 报的 tasks 数与 JSON 一致');
  eq(Number(parsedLine.events), 6, 'stdout 报的 events 数与 JSON 一致');
  eq(Number(parsedLine.bytes), statSync(goodOut).size, 'stdout 报的 bytes 就是磁盘上的真实字节数');
  eq(parsedLine.out, goodOut, 'stdout 报的 out 是绝对路径');
  eq(good.stderr, '', '成功时 stderr 为空');
  const goodBytes = readFileSync(goodOut);
  ok(!(goodBytes[0] === 0xef && goodBytes[1] === 0xbb && goodBytes[2] === 0xbf), '输出文件无 UTF-8 BOM');
  const goodText = goodBytes.toString('utf8');
  ok(goodText.includes('\n  "tasks": ['), '输出是 2 空格缩进');
  ok(goodText.endsWith('}\n'), '输出以换行结尾');
  const goodJson = JSON.parse(goodText);
  eq(Object.keys(goodJson), ['generatedAt', 'tasks', 'events', 'nodes'], '顶层键顺序为 generatedAt/tasks/events/nodes');
  ok(goodJson.tasks.every((task) => !('events' in task)), '落盘文件里也没有嵌套 events');

  // --quiet 静默
  const quiet = runCli(['--db', main.path, '--out', join(TMP, 'out', 'quiet.json'), '--quiet']);
  eq(quiet.status, 0, '--quiet 同样成功');
  eq(quiet.stdout, '', '--quiet 不打印成功行');

  // 覆盖写：再跑一次，文件仍是一个完整 JSON（rename 覆盖，不残留临时文件）
  const second = runCli(['--db', main.path, '--out', goodOut]);
  eq(second.status, 0, '同一 --out 再跑一次成功');
  eq(JSON.parse(readFileSync(goodOut, 'utf8')).tasks.length, 11, '覆盖后 JSON 仍然完整');
  ok(!readdirSync(join(TMP, 'out')).some((name) => name.includes('.tmp-')), '不留临时文件（rename 后目录里没有 .tmp-*）');

  // 库不存在：非零退出 + 一句人话 + 不建输出文件
  const missingOut = join(TMP, 'out', 'never.json');
  const missing = runCli(['--db', join(TMP, 'no-such.db'), '--out', missingOut]);
  eq(missing.status, 1, '库不存在时退出码 1');
  eq(missing.stdout, '', '库不存在时 stdout 为空');
  eq(missing.stderr.trim().split(/\r?\n/).length, 1, '库不存在时 stderr 只有一行');
  ok(missing.stderr.includes('板库不存在'), `stderr 说的是人话（${missing.stderr.trim()}）`);
  ok(!missing.stderr.includes('    at '), 'stderr 里没有调用栈');
  ok(!existsSync(missingOut), '库不存在时不留下输出文件');

  // 不是板库的库：说得清原因
  const notBoard = join(TMP, 'not-a-board.db');
  const naked = new DatabaseSync(notBoard);
  naked.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY);');
  naked.close();
  const wrongDb = runCli(['--db', notBoard, '--out', join(TMP, 'out', 'wrong.json')]);
  eq(wrongDb.status, 1, '不是板库时退出码 1');
  ok(wrongDb.stderr.includes('没有 task 表'), `不是板库时说清原因（${wrongDb.stderr.trim()}）`);

  // 参数错误：退出码 2，也不抛栈
  const badArgs = runCli(['--watch', 'abc']);
  eq(badArgs.status, 2, '--watch 非数字时退出码 2');
  ok(badArgs.stderr.trim().split(/\r?\n/).length === 1, '参数错误也只是一行');
  const noValue = runCli(['--out']);
  eq(noValue.status, 2, '--out 缺值时退出码 2');
  ok(noValue.stderr.includes('缺一个值'), '缺值提示明确');

  // --help
  const help = runCli(['--help']);
  eq(help.status, 0, '--help 退出码 0');
  ok(help.stdout.includes('--db') && help.stdout.includes('--watch'), '--help 列出了参数');

  // --watch 真的会循环重写：0.2 秒一轮，跑 ~0.9 秒后杀掉，至少要写出两轮成功行
  const watchOut = join(TMP, 'out', 'watch.json');
  const watchStdout = join(TMP, 'watch.stdout');
  const watchStderr = join(TMP, 'watch.stderr');
  const watchOutFd = openSync(watchStdout, 'w');
  const watchErrFd = openSync(watchStderr, 'w');
  let watchChild;
  try {
    watchChild = spawn(process.execPath, [CLI, '--db', main.path, '--out', watchOut, '--watch', '0.2'], {
      stdio: ['ignore', watchOutFd, watchErrFd],
      windowsHide: true,
    });
  } finally {
    closeSync(watchOutFd);
    closeSync(watchErrFd);
  }
  const watchExited = new Promise((done) => {
    watchChild.once('exit', () => done(true));
    setTimeout(() => done(false), 5_000);
  });
  await new Promise((done) => setTimeout(done, 900));
  watchChild.kill();
  const watchStopped = await watchExited;
  const watchLines = readFileSync(watchStdout, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  ok(watchLines.length >= 2, `--watch 循环重写（0.9 秒内写成 ${watchLines.length} 轮）`);
  ok(watchLines.every((l) => /^tasks=11 events=6 bytes=\d+ out=/.test(l)), '--watch 每轮都是同一行格式、数字不变');
  eq(readFileSync(watchStderr, 'utf8'), '', '--watch 正常时不告警');
  ok(existsSync(watchOut) && JSON.parse(readFileSync(watchOut, 'utf8')).tasks.length === 11, '--watch 落盘结果仍是完整 JSON');
  ok(watchStopped === true, '--watch 进程能被正常终止');

  // 参数解析：显式相对路径按 cwd 解析，--watch 收正数
  const parsed = parseArgs(['--db', 'a.db', '--out', 'b.json', '--watch', '2.5']);
  eq(parsed.db, resolve('a.db'), '--db 相对路径按 cwd 解析成绝对路径');
  eq(parsed.out, resolve('b.json'), '--out 相对路径按 cwd 解析成绝对路径');
  eq(parsed.watchSec, 2.5, '--watch 接受小数秒');
  eq(parseArgs([]).db, DEFAULT_DB, '不传 --db 时用默认板库');
  eq(parseArgs([]).out, DEFAULT_OUT, '不传 --out 时写默认位置');
  eq(parseArgs([]).watchSec, 0, '不传 --watch 时是一次性');
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶发占用，留着也无害 */ }
}

console.log('');
if (failures.length === 0) {
  console.log(`全部通过：${passed}/${passed} 条断言`);
  process.exit(0);
}
console.log(`失败 ${failures.length} 条（通过 ${passed} 条）：`);
for (const label of failures) console.log(`  - ${label}`);
process.exit(1);
