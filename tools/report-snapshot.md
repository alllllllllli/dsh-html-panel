# 交付报告：板库 → 只读快照导出器（dsh-html-panel）

- 机器：mcloud（DESKTOP-3B45810），PowerShell 5.1，`node` 不在 PATH
- node：`C:\Users\demo\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）
- 板库：`C:\Users\demo\.dsh\team\team.db`（WAL，实测只读打开成功）
- 本报告只写文件 + 跑测试：**没有**改 `lib/`、`public/`、`package.json`、`README.md`，**没有**碰
  profile，**没有**动任何在跑的 GUI/板服务进程

## 1. 交付物

| 文件（绝对路径） | 字节 | sha256 |
|---|---|---|
| `C:\Users\demo\work-20261114\dsh-html-panel\tools\mesh-snapshot.mjs` | 22784 | `b9e6e8aedca4d11b23435b0bd6b8102d95d8542d82bcbfc6ec87a546ec71a1b3` |
| `C:\Users\demo\work-20261114\dsh-html-panel\tools\mesh-snapshot.test.mjs` | 28404 | `6572d5abb0fea6cfb41fe35752bfdd8d2b800126f3ab7ff4d187b71d524d3daf` |
| `C:\Users\demo\work-20261114\dsh-html-panel\tools\mesh-snapshot.md` | 14597 | `f9aec014c200d08bbad2ddf0d60d01c545269eba6669867b5a0094372f87763d` |
| `C:\Users\demo\work-20261114\dsh-html-panel\data\snapshot.json` | 120180 | `1b4f22b79019fb4b651d1a8f8da8e004dcc0412584795fdcad33c352056ec2ea` |

本文件（`tools\report-snapshot.md`）不在表内：自己写自己，字节数和哈希必然自指。复核命令：

```powershell
Get-ChildItem C:\Users\demo\work-20261114\dsh-html-panel\tools | Get-FileHash -Algorithm SHA256
(Get-Item C:\Users\demo\work-20261114\dsh-html-panel\data\snapshot.json).Length
```

`data\snapshot.json` 的哈希只对"这一次运行"有效：`--watch` 或再跑一次都会变（内容取决于
`generatedAt` 和板库当前状态）。

## 2. 测试：真实输出

命令（工作目录 `C:\Users\demo\work-20261114\dsh-html-panel`）：

```powershell
& 'C:\Users\demo\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' tools\mesh-snapshot.test.mjs
```

退出码 `0`，真实输出（原样）：

```
临时目录：C:\Users\demo\AppData\Local\Temp\mesh-snapshot-test-dLkcNC

A. 状态映射 rule by rule
  ✓ done → done
  ✓ done 残留 stale 标记仍是 done
  ✓ canceled 原样透传（不猜成 done）
  ✓ blocked 原样透传（不猜成 done）
  ✓ claimed + 租约在未来 → leased
  ✓ working + 租约在未来 → leased
  ✓ 租约已过期 → stale
  ✓ stale=1 优先于有效租约
  ✓ lease_until 恰好等于 now → stale（<= 口径）
  ✓ open + ack_state=none → undelivered
  ✓ open + ack_state=pending → awaiting
  ✓ open + ack_state=timeout → awaiting（信到了没人管）
  ✓ open + ack_state=acked → 原样 open（五态无槽位）
  ✓ 老库没有 ack_state 列 → undelivered（保守：不声称有回执）
  ✓ claimed 但没有 lease_until（老库）→ 原样透传
  ✓ 认不出来的 lifecycle 原样透传
  ✓ 完全没有 lifecycle → unknown
  ✓ null 行 → unknown（不抛错）

B1. 快照数据形状（六 lifecycle / 过期 / stale / NULL / 超长 / 空 acceptance）
  ✓ 11 条任务全部导出
  ✓ 6 条事件全部导出
  ✓ nodes 是空数组（板库没有节点表）
  ✓ generatedAt 用注入的 now
  ✓ lifecycle=open → undelivered
  ✓ lifecycle=claimed + 租约在未来 → leased
  ✓ lifecycle=working + 租约在未来 → leased
  ✓ lifecycle=blocked → 原样 blocked
  ✓ lifecycle=done → done
  ✓ lifecycle=canceled → 原样 canceled
  ✓ 租约过期未完成 → stale
  ✓ stale=1 → stale（优先于未来租约）
  ✓ leaseDeadline 就是库里的毫秒值（不换算）
  ✓ done 行 doneAt = updated_at（毫秒）
  ✓ stale（过期）expiredAt = lease_until
  ✓ stale（标记）expiredAt = stale_at
  ✓ ackDeadline 就是库里的毫秒值
  ✓ createdAt 原样给出
  ✓ 非 stale 行 expiredAt 为 null
  ✓ 超长 title（3504 字符）原样给出，不截断
  ✓ 超长 title 内容逐字相同
  ✓ acceptance 空串 → 空数组
  ✓ acceptance 多行 → 按行拆、去空行
  ✓ acceptance 单行（带首尾空白）→ 一个元素且已 trim
  ✓ brief 原样给
  ✓ owner_session 为 NULL → owner=null（不编造）
  ✓ require_independent_review=1 → requireReview=true
  ✓ require_independent_review 默认 0 → requireReview=false
  ✓ lease_host → node
  ✓ 没有 lease_host 的任务不写 node 键
  ✓ 原始 lifecycle 一并带出（给人查 JSON 用）
  ✓ 没有任何 task 带 events 键（事件只在顶层，避免面板推两份）
  ✓ eventTotal 精确等于该任务的事件条数
  ✓ t-events-3 的 3 条事件都在顶层 events 里
  ✓ 事件 kind 与库里一致，顺序按 seq
  ✓ 事件 at 是毫秒原值
  ✓ 事件 node 取 actor
  ✓ payload 没有可读字段时给一行 JSON
  ✓ 指向不存在任务的事件照样导出（不丢、不挂）
  ✓ 而且不会因此凭空造出一个任务行
  ✓ task_id 为 NULL 的事件 → task=""（面板列为未关联）
  ✓ payload 不是合法 JSON → 原样给字符串，不抛错
  ✓ actor 为 NULL → node=""

B2. 空库
  ✓ 空库导出 0 条任务
  ✓ 空库导出 0 条事件
  ✓ 空库 JSON 形状完整（四个键都在）
  ✓ 空库也有 generatedAt

B3. 老库缺列（v1 task 表）
  ✓ 老库缺列不抛错
  ✓ 老库 open → undelivered（没有回执信息，不声称有）
  ✓ 老库 claimed 无租约 → 原样 claimed
  ✓ 缺 lease_until 列 → leaseDeadline=null
  ✓ 缺 lease_host 列 → 不写 node

B4. 坏值 / 缺字段不抛错
  ✓ splitAcceptance(null) → []
  ✓ splitAcceptance(undefined) → []
  ✓ splitAcceptance(全空白) → []
  ✓ splitAcceptance(单条) → 一个元素
  ✓ splitAcceptance(数字) 不抛错
  ✓ 脏字段进 mapState 不抛错
  ✓ stale 是字符串 "1" 也认
  ✓ ack_state 大小写不符（PENDING）不认，落 undelivered
  ✓ lease_until 是数字字符串也能比

C. CLI 行为
  ✓ 默认库路径指向 .dsh\team\team.db（C:\Users\demo\.dsh\team\team.db）
  ✓ 默认输出相对脚本目录解析成绝对路径（C:\Users\demo\work-20261114\dsh-html-panel\data\snapshot.json）
  ✓ 成功时退出码 0
  ✓ stdout 是 tasks=N events=M bytes=B out=<abs>（实际：tasks=11 events=6 bytes=9969 out=C:\Users\demo\AppData\Local\Temp\mesh-snapshot-test-dLkcNC\out\snap.json）
  ✓ stdout 报的 tasks 数与 JSON 一致
  ✓ stdout 报的 events 数与 JSON 一致
  ✓ stdout 报的 bytes 就是磁盘上的真实字节数
  ✓ stdout 报的 out 是绝对路径
  ✓ 成功时 stderr 为空
  ✓ 输出文件无 UTF-8 BOM
  ✓ 输出是 2 空格缩进
  ✓ 输出以换行结尾
  ✓ 顶层键顺序为 generatedAt/tasks/events/nodes
  ✓ 落盘文件里也没有嵌套 events
  ✓ --quiet 同样成功
  ✓ --quiet 不打印成功行
  ✓ 同一 --out 再跑一次成功
  ✓ 覆盖后 JSON 仍然完整
  ✓ 不留临时文件（rename 后目录里没有 .tmp-*）
  ✓ 库不存在时退出码 1
  ✓ 库不存在时 stdout 为空
  ✓ 库不存在时 stderr 只有一行
  ✓ stderr 说的是人话（mesh-snapshot: 板库不存在：C:\Users\demo\AppData\Local\Temp\mesh-snapshot-test-dLkcNC\no-such.db）
  ✓ stderr 里没有调用栈
  ✓ 库不存在时不留下输出文件
  ✓ 不是板库时退出码 1
  ✓ 不是板库时说清原因（mesh-snapshot: 这个库里没有 task 表，不像 dsh-team-mesh 的板库）
  ✓ --watch 非数字时退出码 2
  ✓ 参数错误也只是一行
  ✓ --out 缺值时退出码 2
  ✓ 缺值提示明确
  ✓ --help 退出码 0
  ✓ --help 列出了参数
  ✓ --watch 循环重写（0.9 秒内写成 4 轮）
  ✓ --watch 每轮都是同一行格式、数字不变
  ✓ --watch 正常时不告警
  ✓ --watch 落盘结果仍是完整 JSON
  ✓ --watch 进程能被正常终止
  ✓ --db 相对路径按 cwd 解析成绝对路径
  ✓ --out 相对路径按 cwd 解析成绝对路径
  ✓ --watch 接受小数秒
  ✓ 不传 --db 时用默认板库
  ✓ 不传 --out 时写默认位置
  ✓ 不传 --watch 时是一次性

全部通过：123/123 条断言
```

测试用例覆盖了要求的全部项目：六种 lifecycle 各一条、租约过期、`stale=1`、
`owner_session` NULL、3504 字符超长 title、`acceptance` 空串、某任务 3 条事件、
一条事件指向不存在的任务、空库；另外补了 v1 老库缺列、坏 payload、CLI 退出码/
无 BOM/无调用栈/`--watch` 真的循环写等。

## 3. 真实库导出：真实 stdout

```powershell
& 'C:\Users\demo\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' tools\mesh-snapshot.mjs
```

退出码 `0`，真实输出：

```
tasks=0 events=478 bytes=120180 out=C:\Users\demo\work-20261114\dsh-html-panel\data\snapshot.json
```

- **0 条任务 / 478 条事件**（与任务书给的"当前 0 个任务"一致）
- 120180 字节 = 117.4 KiB，远低于宿主 4 MiB 上限
- 文件无 BOM、2 空格缩进、末尾一个换行、可 `JSON.parse`
- 顶层键 `generatedAt / tasks / events / nodes` 顺序正确
- 478 条事件**全部是 `peer.event`**，`task_id` 全为 NULL（`actor` 全为 `pc-ky614`），
  所以都带 `task: ""`。面板会把它们列在事件流里、降亮度、标记「未关联任务」——
  这是照实显示，没有丢掉、也没有凭空造任务行。

样例（真实文件头几行）：

```json
{
  "generatedAt": 1795194890853,
  "tasks": [],
  "events": [
    {
      "task": "",
      "at": 1794651572825,
      "kind": "peer.event",
      "node": "pc-ky614",
      "text": "{\"kind\":\"agent/status\",\"sessionId\":\"session-9c62470a-d206-46fb-9fe2-021ee4d11668\",\"status\":\"idle\"}",
      "seq": 1
    },
```

### 额外做的一次交叉验证（临时脚本，不在交付物里）

用 `public/index.html` **自己的** `normTask` / `normEvent`（按行范围截出那段源码在 `node` 里
求值，不是复刻实现）跑真实快照与一份 8 任务的临时库快照，结论：

真实库快照上：

- `panelTasks 0`、`panelEvents 478`
- `panelEventsFromEmbedded 0` —— 证实没有任何任务带嵌套事件，**不会重复渲染**
- `eventsWithInsaneMs 0` —— 478 条 `at` 全是合理的毫秒值
- Host 侧契约（`Array.isArray(tasks/events/nodes)` + 4 MiB）成立

8 任务临时库上（映射表在页面侧的实际落点）：

| 板子 lifecycle | 导出 `state` | 页面 `normTask().state` | 页面 `stateRaw` |
|---|---|---|---|
| `open`（ack=none） | `undelivered` | `undelivered` | `undelivered` |
| `open`（ack=pending） | `awaiting` | `awaiting` | `awaiting` |
| `working`（租约未来） | `leased` | `leased` | `leased` |
| `claimed`（租约过期） | `stale` | `stale` | `stale` |
| `working`（`stale=1`） | `stale` | `stale` | `stale` |
| `done` | `done` | `done` | `done` |
| `blocked` | `blocked` | `unknown`（显示「未知」） | `blocked` |
| `canceled` | `canceled` | `unknown`（显示「未知」） | `canceled` |

即：五个面板态全部命中；`blocked` / `canceled` 落 `unknown` 但**原始值照实显示**，
没有被猜成 `done`。

## 4. 状态映射表（正式版）

判定按顺序，先命中先返回：

| # | 板子 | 条件 | 面板终态 |
|---|---|---|---|
| 1 | `done` | — | `done` |
| 2 | `canceled` | — | `canceled`（原样透传 → 页面显示「未知」+ 原始值） |
| 3 | 任意非终态 | `stale=1` 或 `lease_until <= now` | `stale` |
| 4 | `claimed` / `working` | `lease_until > now` | `leased` |
| 5 | `blocked` | — | `blocked`（原样透传） |
| 6 | `open` | `ack_state ∈ {pending, timeout}` | `awaiting` |
| 6 | `open` | `ack_state ∈ {none, 空, 列不存在}` | `undelivered` |
| 6 | `open` | `ack_state = acked` | `open`（原样透传：五态无"已回执待认领"） |
| 7 | 其余 | 如老库 `claimed` 无 `lease_until` / 认不出来的值 | 原样透传 / `unknown` |

同表也写在 `tools\mesh-snapshot.md`（含每条的理由）与 `tools\mesh-snapshot.mjs` 的
`mapState()` docblock 里；可执行版本是测试的 A 组 18 条断言。

## 5. 时间单位结论与证据

**结论：板库所有时间列都是毫秒（`Date.now()` 口径），与面板一致，导出器不做任何换算，
原样透传。**

| 证据 | 文件:行号 | 内容 |
|---|---|---|
| event 写入用 `Date.now()` | `dsh-team-mesh/src/store.js:150` | `created_at: Date.now()` |
| task 创建/更新 | `store.js:168`、`:179-180` | `const now = Date.now();` → `created_at: now, updated_at: now` |
| `lease_until` | `store.js:246`、`:284`、`:345` | `lease_until: now + leaseMs` |
| 时长常量是毫秒 | `dsh-team-mesh/src/domain.js:229`（`:227` 同型） | `DEFAULT_LEASE_MS = 10 * 60_000`、`DEFAULT_ACK_TIMEOUT_MS = 60_000` |
| `stale_at` | `store.js:506` | `stale_at: now`（`now = Date.now()` 默认参，`store.js:480`） |
| `ack_deadline_at` / `ack_at` | `store.js:779-780`、`:826` | `now + ackTimeoutMs` / `now` |
| 读侧按毫秒比较 | `domain.js:302` | `return task.lease_until > now;` |
| 读侧按毫秒格式化 | `domain.js:582`、`:703-704`、`:780` | `new Date(leaseUntil).toISOString()` —— 秒级会得 1970 年 |
| 真实数据反证 | 本机板库 `max(event.created_at) = 1795187712124` | 当毫秒 = `2026-11-20T15:15:12Z`（= 2026-11-20 23:15 +08，与该库文件 LastWriteTime 23:17 吻合）；当秒 = `+058857-03-26`，荒谬 |

`--watch` 的秒数只影响轮询间隔，与数据无关。测试里对 `leaseDeadline` / `ackDeadline` /
`createdAt` / `doneAt` / `expiredAt` / 事件 `at` 都做了"等于原值"的断言（不经 ×1000 或 ÷1000）。

## 6. 没做到 / 不确定的地方（不粉饰）

1. **没在真实 DSH GUI 里看过面板**。本交付只验证到"导出的 JSON 经页面自己的
   `normTask`/`normEvent` 规整后状态、事件、时间都对"，以及"宿主侧 `loadSnapshotMessage()`
   的契约成立（形状 + 4 MiB）"。真实侧边栏里加载面板需要重启 DSH、且要往 profile 里配
   `snapshot.path` —— 两件都被本次任务禁止。所以"页面看起来对不对"这件事**未验证**。
2. **`--watch` 在本机没有长期跑过**。测的是 0.2 秒间隔跑 0.9 秒（写了 4 轮、能正常终止）。
   没验证的是：板服务正在写库时连续只读打开会不会偶发 `SQLITE_BUSY`。风险不高（只读 +
   每轮重新打开并立即关闭），但我没实测，所以只能列为"未验证"。
3. **只读打开 WAL 的前提**：实测当前库（`-wal` 0 字节、`-shm` 存在）只读打开成功。
   如果边车文件状态异常，会按退出码 1 失败并给出人话，**刻意不降级成读写打开**。
   这条限制写在 md 里；没有针对异常边车状态做实测（也没法在不冒险的前提下造）。
4. **`evidence` 恒为 0**：本机板库当前的 task 表没有"任务级证据计数"列（只有独立
   `evidence` 表），我没有去 join 它 —— 因为面板要的只是一个数字，而"证据条数"到底算
   全部还是只算可采信的（`admissible=1`）是个语义决定，不该由导出器擅自定。宁可留 0。
   如果你要这个数，给我一句口径我加（`SELECT count(*) FROM evidence WHERE task_id=?`）。
5. **`node` 列不是主机名**：事件行的第三列放的是 `actor`（event 表没有 host 列）。这是
   取舍，我在 md 的"已知限制"里写明了。
6. **`stale` 会盖掉 `blocked`**：blocked 且租约失效时页面只显示 `stale`，原始 lifecycle
   只在 JSON 的 `lifecycle` 字段里。面板五态装不下两个状态。
7. **`acceptance` 的拆分口径是我推断的**：证据是 `spec.js:84`（一个字符串）+ `spec.js:217-219`
   的 `acceptanceRef`「哪一条，如 A03」（暗示分行写），板库写入时不加任何分隔符。所以按
   换行拆。如果实际习惯是用 `；` 或 `、` 分隔单行文本，那拆不出来 —— 这时整条就是一个
   元素（不会丢信息，只是不成条）。这一点**没有被任何真实数据验证过**（当前库 0 任务，
   测试里的多行 acceptance 是我自己造的）。
8. `data\snapshot.json` 的 sha256 只对本次运行有效（含 `generatedAt`）。
9. 报告里引用的 `store.js` / `domain.js` / `backend.js` / `spec.js` 行号，取自
   `C:\Users\demo\dsh-plugins\dsh-team-mesh\` 当前版本；那边改代码后行号会漂，但
   "毫秒"这个结论有真实数据反证兜底。
10. **"不写板库一个字节"的精确含义**：`team.db` 本身没被写（跑前跑后都是 172032 字节、
    LastWriteTime 仍是 `2026/11/20 23:17:08`，`team.db-wal` 始终 0 字节）。但 SQLite 以
    只读方式打开 WAL 库时会读/映射 `team.db-shm`，该文件的 LastWriteTime 因此被刷新
    （实测跑到 `2026/11/21 1:16:52`）。这是 SQLite 共享内存的簿记，**不是**数据写入，
    也没有向 `team.db` / `-wal` 落任何字节 —— 但既然 mtime 动了就该说，别让人以为工具
    偷偷写了库。
11. `--quiet` 只静音成功行与循环告警；参数错误/失败的原因永远打印（我认为"静默失败"
    比吵更危险）。
