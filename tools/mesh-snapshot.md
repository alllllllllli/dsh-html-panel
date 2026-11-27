# mesh-snapshot —— dsh-team-mesh 板库 → dsh-html-panel 只读快照

一句话：把 `%USERPROFILE%\.dsh\team\team.db`（dsh-team-mesh 的板库）里的 `task` /
`event` 两张表读出来，写成面板宿主能吃的那份 JSON。

```
tools\mesh-snapshot.mjs          导出器（零依赖，只读打开板库）
tools\mesh-snapshot.test.mjs     断言集（自跑，零依赖）
tools\mesh-snapshot.md           本文件
data\snapshot.json               对真实库跑一次的产物
```

## 为什么是"外面一个脚本"而不是让插件直接读库

`lib/index.js` 的 `loadSnapshotMessage()`（`lib/index.js:103-136`）只认**一个 JSON 文件
或一个 URL**；它不知道 SQLite 存在，也不知道 dsh-team-mesh 存在。这是有意的隔离
（README「The plugin does not read the board service」）。板库的 schema 属于另一个包，
面板是只读显示件 —— 所以"读库"这件事落在插件外面，就是这个脚本。插件本身一个字没改。

## 用法

mcloud 上 `node` 不在 PATH，用绝对路径（这也是本交付实际跑的命令）：

```powershell
$node = 'C:\Users\demo\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd 'C:\Users\demo\work-20261114\dsh-html-panel'

# 一次性：读默认板库，写 data\snapshot.json
& $node tools\mesh-snapshot.mjs
# → tasks=0 events=478 bytes=120180 out=C:\Users\demo\work-20261114\dsh-html-panel\data\snapshot.json

# 循环写（每 5 秒）
& $node tools\mesh-snapshot.mjs --watch 5

# 换库 / 换输出
& $node tools\mesh-snapshot.mjs --db D:\tmp\team.db --out D:\tmp\snapshot.json --quiet

# 跑断言
& $node tools\mesh-snapshot.test.mjs
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--db <path>` | `%USERPROFILE%\.dsh\team\team.db` | 板库路径。相对路径按**当前工作目录**解析 |
| `--out <path>` | `..\data\snapshot.json`（相对**脚本目录**解析） | 显式给的相对路径按当前工作目录解析 |
| `--watch <秒>` | 不循环（一次性） | 循环重写。**首轮失败仍然非零退出**（不在坏配置上空转）；后续某轮失败只告警、继续 |
| `--quiet` / `-q` | 关 | 不打印成功行和循环告警；错误照常打印 |
| `-h` / `--help` | — | 用法 |

退出码：`0` 成功；`1` 读不到板库 / 打不开 / 不是板库 / 写不出快照；`2` 参数不对。
失败时只打印一行 `mesh-snapshot: <人话>`，不抛栈。

接给面板：插件行的 config 指向这个文件即可（路径按你的实际布局写）：

```yaml
- insert:
    - id: dsh-html-panel
      name: 'dsh-html-panel'
      config:
        snapshot:
          path: 'C:\Users\demo\work-20261114\dsh-html-panel\data\snapshot.json'
```

面板每次加载都重读这个文件（`lib/index.js:106-109`），所以 `--watch` 或定时任务
跑着的时候刷新 GUI 就能看到新数据。**注意**：本交付**没有**改 profile、没有去配
这一行 —— 那是另一件事。

## 输出形状

```json
{ "generatedAt": 1795194890853, "tasks": [], "events": [ ... ], "nodes": [] }
```

- UTF-8 **无 BOM**，2 空格缩进，末尾一个换行。
- `type` / `generatedAt` / `source` 由 Host 自己补（`lib/index.js:128-135`），Host 会**覆盖**
  这里的 `generatedAt`；写它只是给人和测试看。
- 上限 4 MiB（`lib/index.js:122`）。真实库 478 条事件 = 117 KiB，离上限很远。
- 先写临时文件再 `rename`：面板随时可能读这个文件，不能让它读到半个 JSON。

## 状态映射表（板子 → 面板五态）

面板只认 `undelivered`(未送达) / `awaiting`(等回执) / `leased`(租约中) / `stale` / `done`，
其余字符串一律落 `unknown` 并把原始值显示在详情行（`public/index.html:751-760`、
`:627-630`、`:972`）。板子的 `lifecycle` 是 `open/claimed/working/blocked/done/canceled`
（`dsh-team-mesh/src/domain.js:21`），所以必须显式映射。

判定**按顺序**，先命中先返回（顺序即优先级）：

| # | 板子状态 | 条件 | 面板 | 为什么 |
|---|---|---|---|---|
| 1 | `done` | 无 | `done` | 终态。哪怕 `stale=1` 残留也是"已完成" |
| 2 | `canceled` | 无 | `canceled`（原样透传） | 面板没有"已取消"。透传 → 面板显示「未知」+ 原始值，**不猜成 done** |
| 3 | 任意非终态 | `stale=1`，或 `lease_until <= now` | `stale` | 租约失效优先于"收到哪一步"：`stale` 标记是扫描器写的（`store.js:509`），租约过期口径与 `canReclaim()` 一致（`store.js:774-783`） |
| 4 | `claimed` / `working` | `lease_until > now` | `leased` | 有人正在跑，且租约有效 |
| 5 | `blocked` | 无 | `blocked`（原样透传） | 面板没有"受阻"。透传 → 「未知」+ 原始值，**不猜成 done** |
| 6 | `open` | `ack_state` = `pending` / `timeout` | `awaiting` | 信已投递、没人回执（`store.js:769`、`:853`）。`timeout` 也算等回执 —— 面板没有"送到了没人管"这一态，但**绝不能**说成"未送达"（那是假话，见 `domain.js:277-294` 的三种真相） |
| 6 | `open` | `ack_state` = `none` / 空 / 老库没这列 | `undelivered` | 没有在途的派发。老库缺列时保守取"未送达"：不声称有回执 |
| 6 | `open` | `ack_state` = `acked` | `open`（原样透传） | 「已回执但还没人认领」五态无槽位。宁可显示原始值，也不硬塞进 `awaiting`（那会声称还在等回执） |
| 7 | 其余 | 例如老库 `claimed` 但没有 `lease_until` | 原样透传 / `unknown` | 信息不足就不编 |

映射的可执行版本在 `tools\mesh-snapshot.test.mjs` 的 A 组，18 条断言逐条钉住上表。
每条 task 里还额外带原始 `lifecycle` / `ackState` 两个字段（面板不读），方便人工查
JSON 时看出"这个 `stale` 是从哪个 lifecycle 来的"。

## 时间单位：**毫秒**，原样透传，不换算

结论：库里 `created_at` / `updated_at` / `lease_until` / `stale_at` / `ack_deadline_at` /
`ack_at` / `event.created_at` **全部是 `Date.now()` 风格的毫秒时间戳**；面板也按毫秒
（`public/index.html:601-611` 的 `toMs()`）。所以导出器**不做任何单位转换**。

证据（文件:行号）：

| 证据 | 出处 | 说明 |
|---|---|---|
| 写入点全是 `Date.now()` | `dsh-team-mesh/src/store.js:150`（event）、`:168`+`:179-180`（created/updated）、`:246`+`:284`+`:345`（lease_until = now + leaseMs）、`:506`（stale_at）、`:779-780`（ack_deadline_at）、`:826`（ack_at）、`:941`/`:945`（event） | 单位就是 `Date.now()` 的单位，即毫秒 |
| 时长常量是毫秒 | `domain.js:227-231` `DEFAULT_ACK_TIMEOUT_MS = 60_000`、`DEFAULT_LEASE_MS = 10 * 60_000` | 与毫秒时间戳相加，单位必须一致 |
| 读侧按毫秒比较/格式化 | `domain.js:302` `task.lease_until > now`、`domain.js:582` / `:703-704` / `:780` 都用 `new Date(leaseUntil).toISOString()` | 秒级数值会得到 1970 年，只有毫秒才落在 2026 |
| 真实数据反证 | 本机板库 `event.created_at` 最大 `1795187712124` | 当毫秒 = `2026-11-20T15:15:12Z`（= 2026-11-20 23:15 +08，与该库文件最后写入时间 23:17 吻合）；当秒 = `+058857-03-26`，显然错 |

`--watch` 的秒数只影响轮询间隔，不影响数据。

## 字段映射表

### task

| 快照字段（面板首选名） | 来源列 | 说明 |
|---|---|---|
| `id` | `task_id` | 面板会把它规整成 `[A-Za-z0-9_.:#-]`（`index.html:648-649`） |
| `title` | `title` | **原样**，超长不砍（面板截到 300，`MAX_TEXT` 2000） |
| `state` | 见上面的映射表 | 五态或原样透传 |
| `owner` | `owner_session` | NULL → `null`（面板显示 `—`），不编造 |
| `node` | `lease_host` | 板子没有"任务在哪台机器"的独立列，`lease_host` 是唯一能回答的字段（`domain.js:403` 同口径）。为 NULL 时不写这个键 |
| `requireReview` | `require_independent_review == 1` | 布尔 |
| `eventTotal` | `event` 表按 `task_id` 计数 | **必须给**：既然不再嵌 `events`，不给就是 0（`index.html:662`、`:729`） |
| `brief` | `brief` | 原样 |
| `acceptance` | `acceptance` | 字符串 → 数组，按换行拆（见下） |
| `createdAt` / `updatedAt` | `created_at` / `updated_at` | 毫秒 |
| `leaseDeadline` | `lease_until` | 毫秒绝对值（面板 `futureMs` 优先用它，`:670`） |
| `ackDeadline` | `ack_deadline_at` | 毫秒绝对值（`:671`） |
| `ackAt` | `ack_at` | 毫秒（面板不读，留档） |
| `expiredAt` | 仅 `stale` 行：`stale_at` → `lease_until` → `ack_deadline_at` → `updated_at` | 面板用它显示"过期 N 前"（`:946-949`） |
| `doneAt` | 仅 `done` 行：`updated_at` | 面板用它显示"完成于 N 前"（`:956-957`）；板子没有单独的 `done_at` 列 |
| `lifecycle` / `ackState` | 同名列 | 原始值，面板不读 |
| `tags` / `evidence` / `retries` / `leaseTotalSec` / `ackTotalSec` | — | **不给**：板库没有对应数据（没有 tags 列、本轮 schema 里没有 evidence 计数），面板会用默认值。硬塞一个 0 或编一个标签，比留空更糟 |

**`acceptance` 怎么拆**：板库对它只有一个约定 —— 一个自由文本串（`backend.js:48`
`acceptance TEXT NOT NULL DEFAULT ''`，`spec.js:84` 描述为「验收标准：怎样算做完
（≤4000 字）」），写入时不拆行不加分隔符（`store.js:174` 原样落库，`domain.js:205`
输出时也是 `验收标准：${acceptance}` 一行）。唯一能认的约定是**换行** —— 因为
`spec.js:217-219` 的 `acceptanceRef` 说的是「对应任务 acceptance 里的哪一条（如 A03）」，
说明多条目本来就是作者自己分行写的。所以：有换行按行拆（去空行、去首尾空白），
拆不出来就整条当一个元素，空串给 `[]`。

### event

事件**只**出现在顶层 `events` 数组里，每条：

| 快照字段 | 来源列 | 说明 |
|---|---|---|
| `task` | `task_id` | 任务 id。为 NULL 时给 `""`（面板把它列进事件流、降亮度、不可定位 —— 照实显示，不丢） |
| `at` | `created_at` | 毫秒原值 |
| `kind` | `kind` | 原值（`task.created` / `task.dispatched` / `peer.event` …） |
| `node` | `actor` | 板库 event 表**没有 host 列**，`actor` 是唯一"谁干的"。这一条是刻意的取舍，别把它当主机名 |
| `text` | `payload` | 依次找 `message`/`note`/`reason`/`meaning`/`detail`/`text`/`title`，都没有就把整个 payload 压成一行 JSON；payload 不是合法 JSON 就原样给字符串 |
| `seq` | `seq` | 审计序号（面板不读，留档用；导出顺序按它升序） |

## 为什么事件只放顶层，绝不嵌进 `task.events`

面板的 `applySnapshot()` 是这样收事件的（`public/index.html:715-725`）：

```js
const events = [];
tasks.forEach(function (t) { t.events.forEach(function (e) { events.push(e); }); });   // ← 先收「嵌入的」
asArray(data.events).forEach(function (raw) {                                          // ← 再收顶层的
  const event = normEvent(raw, taskId, now);
  const owner = byId[event.taskId];
  if (owner) owner.events.push(event);
  events.push(event);
});
```

两处都往同一个 `events` 数组里推。**同一件事两边都写，就会渲染两份**：事件流里重复
出现，`任务事件共 N 条` 那个计数（`:924`、`:1055` 从 `t.eventTotal` / `t.events` 汇总）
也会翻倍。所以导出器只写顶层，`task.eventTotal` 单独给准确条数。断言
`mesh-snapshot.test.mjs` 的「没有任何 task 带 events 键」和「落盘文件里也没有嵌套
events」两条直接钉这个约束。

反方向也是错的：只嵌进 task 而不写顶层，那么**没有对应任务行的事件就整条丢掉**
（比如 `task_id` 指向已删任务、或 `task_id` 为 NULL 的 `peer.event`）。两种都写、
只写一种，唯一正确的选择是只写顶层 —— 面板自己会把匹配到任务的事件折进该任务的
`events`（`:722-724`），页面一样能显示"某任务的最近事件"。

## 只读、安全

- `DatabaseSync(dbPath, { readOnly: true })` 打开，**不写板库一个字节**；只发 SELECT 和
  `PRAGMA table_info` / `sqlite_master` 查询。板服务可能正在跑，抢写锁会把板子卡住。
  只读打开失败时**刻意不降级**成读写打开，而是报一句人话退出 —— 见下面的限制。
- 输出里没有任何密钥/token/凭据；脚本也不读环境里除 `USERPROFILE` 之外的东西。
  脚本自身的日志只有 `tasks/events/bytes/out` 四个数。
- 表名 / 列名都是代码里的字面量，不接受外部输入；`--db` / `--out` 只当路径用。

## 已知限制（如实列，不粉饰）

1. **只读打开的 WAL 前提**：SQLite 只读打开 WAL 库需要 `-shm`/`-wal` 边车文件可用。
   板服务在跑、或至少上次正常关闭时（本机实测两种都行），只读打开成功；如果边车文件
   处于异常状态，会报 `打不开板库（只读）…` 并按退出码 1 失败，**不会**偷偷改成读写打开。
2. **`node` 不在 PATH**：所有命令都得用上面那条绝对路径。定时任务里也一样。
3. **没有 evidence / tags 数据**：板库当前 schema 里没有"任务级证据计数"列，`evidence`
   列在面板上恒为 0；`tags` 恒为空。要显示它们得先给板子加列（那是另一个包的改动）。
4. **事件正文是"猜一次"的摘要**：`payload` 里没有已知文本字段时给的是整段 JSON。它不会
   错，但不好看 —— 想更好看得在 dsh-team-mesh 那边给每个 kind 定一句人话。
5. **`node` 列不是主机名**：事件行第三列放的是 `actor`。板库 event 表没有 host 列。
6. **`ack_state = 'acked'` 且还没人认领的 `open` 任务**：面板五态没有"已回执待认领"，
   导出的是原始串 `open`（面板显示「未知」+ 原始值）。这是刻意选择，不是遗漏。
7. **`stale` 会盖掉 `blocked`**：一个 blocked 任务若租约也失效了，面板只显示 `stale`。
   原始 `lifecycle` 仍在 JSON 的 `lifecycle` 字段里，但页面上看不到。面板五态装不下
   两个状态，这条是取舍。
8. **没在真实 GUI 里点过**：本交付只验证了"导出器写出的 JSON 经页面自己的
   `normTask`/`normEvent` 规整后状态/事件/时间都正确"，**没有**在真实 DSH 侧边栏里
   加载过面板（那需要重启 DSH，本次任务明确不许碰 profile）。
