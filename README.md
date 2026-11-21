# dsh-html-panel · 大管家（Butler Console）

**0.6.0** — DSH 侧栏入口（「大管家 / Butler Console」）。点开后主区域用 iframe 加载本插件
`public/` 目录里的单文件控制台页面；页面是磁盘上的普通文件，改页面刷新即生效，改 `lib/` 需重启 DSH。

0.6.0 在大管家页接入了 **TRAIL 失败分类**（MIT）的**规则化告警**：新增只读路由 `GET api/alerts`，
把共享板任务/事件、层级节点、官方任务板投影按真实字段推导成「高 / 中 / 低」三档告警；三问条第一问
「是否需要我」由告警驱动，任务页命中告警的卡片带可点小标记。**只搬分类体系与规则，TRAIL 的 LLM judge
没有接**——不联网、不花钱、不编数据（详见下文「TRAIL 告警」一节）。

页面是 V7 界面稿（`html-panel-designs/v7-butler-console.html`）的落地版：

- **左栏**：品牌「大管家」+ 五项导航（大管家 / 任务 / 集群 / 记忆 / 设置）+ 本机与链路状态；
- **中栏**：按导航切换五页。大管家页是 DSH 风格对话区（对话 / 轨迹两个 tab，**明确标注「示例对话 · 静态演示」**），
  composer 行挂真实快捷动作；任务 / 集群 / 记忆 / 设置四页读真实数据；
- **右栏**：**派活层级 T0 → T1 → T2 → T3**，层级优先、设备只做节点标签；数据来自真实活会话与
  子代理血缘（新路由 `GET api/tiers`），取不到时标「降级」并给原因，不编节点。

视觉 token 取自本机 DSH 安装包 `app.asar` 的深色主题（`design-platform.css` / `base.css` /
`ConversationRoot.module.css` / `InputBar.module.css` 等），当前项高亮用 DSH 侧栏真实灰底
`rgb(67,69,74)`，不用绿色。页面零外链、单文件（内联 CSS/JS）。

> 运行中的 DSH 未重启（本轮红线）：**页面**刷新即为新版；**Host 侧新增的路由/字段**要重启 DSH 后
> 才出现——0.6.0 的 `api/alerts` 路由本身即属此类（0.5.0 的 `api/tiers`、`api/board.official` 已在
> 当前运行实例里生效）。重启前页面按「api/alerts 404 → 退回 0.5.0 的按板状态列需要我」如实降级，
> 并在「系统是否健康」里写明要重启，不是故障；页面不会白屏、不会编告警。

---

## 0.6.0 改了什么

> 定位：**不接 LLM、不加依赖、不重做布局**。把 TRAIL（MIT）的失败 taxonomy 搬进来，用我们已有的
> 真实字段写规则化分类器，做成「异常/告警」能力；规则拿不到字段就不写规则（10 条全部可指回字段/事件）。

| # | 变更 | 落点 |
|---|---|---|
| 1 | **搬 TRAIL taxonomy（21 个叶子类目，id 未改名）**：`id/label/what/evidenceHint` + 三大类九组；来源与 20/21 差异写进注释；MIT 版权声明随代码保留 | `lib/trail.js`（新增）、`lib/trail.LICENSE`（新增） |
| 2 | **规则化分类器 `classifyAlerts()`（纯函数，零依赖）**：10 条规则、阈值集中常量、每条告警带 `severity/category/subject/why/evidence[]/suggestion`；输出为空是合法结果 | `lib/trail.js` |
| 3 | **新增只读路由 `GET api/alerts`**：复用 `api/board` 与 `api/tiers` 的**现成快照**（不另开网络请求），4 s 缓存 + 单飞，任何失败结构化降级；顺手给板读取器加了单飞（两个路由同时打进来只碰板一次） | `lib/index.js`、`lib/board.js` |
| 4 | **页面**：三问第一问接告警——高/中显示「需要你：N 条」并可展开告警卡（严重度颜色 + 中文类目 + 一句话为什么 + 建议动作 + 证据字段），无告警明说「当前没有需要你处理的异常」，低优先级单独折叠不占计数；任务卡命中告警加可点小标记（跳回大管家并展开定位）；设置页显示告警数据源 | `public/index.html` |
| 5 | **测试**：新增 `tools/trail.test.mjs`（38 条：taxonomy 保真 / 10 规则正反例 / 真实快照 / 人造边界快照 / 降级 / 路由 / 单飞）；新增 `tools/cdp-alerts.mjs`（43 条断言 + 7 张截图，含 `--live` 真实页面降级验证）；`check-page` 161→173 项 | `tools/`、`tools/fixtures/` |

版本：`0.5.0 → 0.6.0`。测试基线：单测 **140/140**（8 个测试文件，0.5.0 的 102 条一条没删）、静态自检
**173/173**、CDP 告警 **43/43**、CDP 大管家 100/100。

---

## 0.5.0 改了什么

> 定位：**不重写**，把官方 DSH 0.2.2-rc.5 已内置的 Agent Teams 契约**接进面板**，并补官方没有的跨机层。
> 官方任务视图/层级树的算法与字段全部照官方源码移植或对齐（MIT/BSD-3-Clause），不自造概念。

| # | 变更 | 落点 |
|---|---|---|
| 1 | **移植官方任务视图纯函数**：`taskReady` / `projectTaskView`（逐行对齐官方 `src/task-view.ts`，含 `ready` 与只警告不阻塞的 `writeScopeWarnings`）；mesh 板投影成官方 `TeamTaskView` 形状（`subject/description/status/revision/blockedBy/writeScopes/ownerName`，`source:'mesh'`） | `lib/taskview.js`（新增）、`lib/boardmap.js` |
| 2 | **`api/board` 输出对齐官方 `TeamTaskView`**：mesh 任务叠加官方字段；新增 `official` 段读官方 `agentTeam` 投影（`ctx.sessionProjections.snapshot(session).values.agentTeam`，只读、只扫活根会话）；拿不到就 `{available:false, reason}`，**绝不编任务** | `lib/board.js`、`lib/index.js` |
| 3 | **`api/tiers` 对齐官方 subagent 契约**：本机 T1/T2/T3 节点补 `{parentSessionId, childSessionId, mode}`（`mode` 来自官方 `subagentCatalog` / `subagent` 投影，取不到给官方允许的 `unknown`）；`source.subagentMode` 单独报官方投影可达性 | `lib/tiers.js` |
| 4 | **页面（V7 方向不变）**：大管家页顶部加官方「三问」条（是否需要我 / 系统是否健康 / 这件事的历史，健康态不占位、每行说「在等谁、要什么」、计数=列表长度）；任务卡片用 `TeamTaskView` 字段渲染（状态点照 `TeamBoard.tsx` 的 `StateDot` 映射与配色）；新增「官方任务板（只读）」卡片与降级文案；层级卡片显示官方 `mode` 与血缘 id | `public/index.html` |
| 5 | **测试**：新增 `tools/taskview.test.mjs`（19 条，含真实板数据快照 + 依赖链 / 写域重叠用例）；`tools/board.test.mjs` 15→19、`tools/tiers.test.mjs` 21→25；`tools/check-page.mjs` 139→161 项 | `tools/` |

版本：`0.4.0 → 0.5.0`。测试基线：单测 **102/102**（7 个测试文件）、静态自检 **161/161**。

---

## 0.4.0 改了什么

| # | 变更 | 落点 |
|---|---|---|
| 1 | 侧栏入口 / iframe 标题 / locale / README / 包描述改名「大管家」（英文 Butler Console），图标换成控制台风格内联 SVG；`PANEL_ID` 与路由前缀仍是 `dsh-html-panel`（不搬 key、不搬 URL） | `lib/client.js`、`locale/*.json`、`package.json`、`icon.svg` |
| 2 | 页面按 V7 结构重写：三栏 + 五页导航 + 示例对话区 + 任务/集群/记忆/设置 + 右栏派活层级 + 900 抽屉 | `public/index.html` |
| 3 | **新增只读路由 `GET api/tiers`**：T0 根 + T1 活会话 + T2/T3 子代理血缘 + 远端 `interconnect.list()`；4 s 缓存、2 s 远端超时、结构化降级 | `lib/tiers.js`、`lib/index.js` |
| 4 | 0.3.0 能力全保留：`api/cluster` / `api/board` / `api/host` / `POST api/action`、六个真实动作与四态回执、报告预览、待办 localStorage、30 秒轮询与数据过期横幅 | 页面 + 既有 `lib/*` |
| 5 | 测试：新增 `tools/tiers.test.mjs`（21 条）、重写 `tools/check-page.mjs`（139 项）、新增 `tools/cdp-butler.mjs`（81 条断言 / 13 张截图）、`tools/verify-copies.mjs`、`tools/live-check.mjs` | `tools/` |

版本：`0.3.0 → 0.4.0`。0.3.0 的 54 条单测基线继续全过（现共 75 条）。

---

## 三栏与五页

```
┌──────────────┬───────────────────────────────────────────────┬─────────────────────┐
│ 大管家        │ 中栏（按导航切换）                             │ 派活层级             │
│ BUTLER CONSOLE│                                               │  T0 大管家           │
│              │ 大管家：示例对话 / 轨迹 + composer 真动作        │   ├─ T1 本机会话     │
│ 大管家   T0   │ 任务  ：共享板任务 / 事件流 / 待办               │   ├─ T1 server 会话  │
│ 任务     6    │ 集群  ：interconnect 拓扑 + 设备/链路列表         │   │   ├─ T2 子代理   │
│ 集群   1/4    │ 记忆  ：OpenViking 探测入口                      │   │   └─ T3 孙代理   │
│ 记忆          │ 设置  ：版本 / 路由 / 数据源 / 回滚（只读）       │   └─ …              │
│ 设置          │                                               │ 设备只作节点标签      │
│ ─────────    │                                               │                     │
│ 本机在线      │                                               │                     │
│ 4 台设备·1 up │                                               │                     │
└──────────────┴───────────────────────────────────────────────┴─────────────────────┘
```

导航项 5 个（≤6 项的要求）。页脚「本机在线 / N 台设备 · M 条链路 up」来自 `api/cluster` 真实字段，
不写死「链路正常」。右栏在 ≤1200px 收成右侧抽屉（默认收起，点「派活层级」滑出，带遮罩，Esc 关闭）。

---

## 数据来源（同源只读路由，全部在 Host 侧）

| 路由 | 内容 | 页面落点 |
|---|---|---|
| `GET /dsh-html-panel/api/cluster` | 本实例 interconnect 身份 + 每个对端的 `{instanceId, origin(脱敏 host:port), link:'up'\|'down'}` | 顶栏、左栏底部、集群页拓扑与设备列表 |
| `GET /dsh-html-panel/api/board` | **两条独立数据源**：① 共享板（`dsh-team-mesh` HTTP 服务，`x-team-token` 只在请求头）任务 / 事件 / 健康；② `official` 段 = 官方 Agent Teams 投影（只读）；任一源失败各自结构化降级，互不拖累 | 任务页、官方任务板、看板按钮、报告动作 |
| `GET /dsh-html-panel/api/host` | `node:os` + `fs.statfs` 的本机内存 / CPU / 磁盘（零外部依赖） | 设置页、composer 状态条 |
| **`GET /dsh-html-panel/api/tiers`** | 派活层级快照（0.5.0 起节点带官方 subagent 契约字段），见下节 | 右栏派活层级 |
| **`GET /dsh-html-panel/api/alerts`** | **0.6.0**：TRAIL 规则化异常告警（只吃上面 board/tiers 的现成快照，4 s 缓存 + 单飞，零网络零 LLM），见「TRAIL 告警」一节 | 大管家三问第一问、任务卡告警标记、设置页 |
| `POST /dsh-html-panel/api/action` | 唯一写通道：body 只有一个白名单动作 id（`probe-memory` / `latest-report` / `open-reports-folder`）；非 POST / 跨站 Origin / 非 JSON / 超 4 KiB / 未知动作一律在副作用之前拒绝 | 动作按钮与回执 |

浏览器半与页面之间的 DSH 客户端动作走 `window.postMessage({type:'panel-action', action, requestId})`，
由 `lib/client.js` 调用真实客户端服务（`uiWorkspace.startSession`，与 Ctrl+Alt+N 同一个 API），
结果以 `{type:'panel-action-result', requestId, ok, …}` 回传。

---

## `api/tiers` 契约

```jsonc
{
  "generatedAt": "2026-11-21T09:00:00.000Z",
  "source": {
    "local": "sessions+agents",                       // 或 "unavailable"
    "subagents": "session-header(origin+parentSession)",
    "subagentMode": "official-projection",            // 0.5.0：官方 subagent 投影可达性
                                                      //   或 "official-projection(no-mode)" / "unavailable"
    "remote": [                                        // 每个配置对端一行，配置顺序
      { "instanceId": "server", "link": "up", "sessions": 2 },
      { "instanceId": "s5", "link": "down", "sessions": 0, "error": "timeout" } // error 可选
    ],
    "cached": false, "ageMs": 0
  },
  "root": { "id": "pc-ky614", "label": "大管家", "device": "pc-ky614",
            "tier": 0, "status": "run", "startedAt": "2026-11-21T08:00:00.000Z" },
  "nodes": [
    { "id": "session-…", "parentId": "pc-ky614", "tier": 1, "kind": "session",
      "device": "pc-ky614", "title": "主控会话", "status": "run", "startedAt": "…",
      "childSessionId": "session-…", "parentSessionId": null, "mode": null },
    { "id": "server:session-…", "parentId": "pc-ky614", "tier": 1, "kind": "session",
      "device": "server", "title": "查看本机SSH公钥", "status": "idle", "startedAt": null },
    { "id": "session-…", "parentId": "session-…", "tier": 2, "kind": "subagent",
      "device": "pc-ky614", "title": "层级交互", "status": "idle", "startedAt": "…",
      "childSessionId": "session-…", "parentSessionId": "session-…", "mode": "continuable" }
  ],
  "degraded": { "reason": "远端设备的子代理层级不可见（interconnect 只列顶层活会话）" } // 可选
}
```

字段规则：

- **tier**：`1` = 会话（本机 + 其它设备平级），`2` = 子代理，`3+` = 子代理再开的代理；逐级递推并封顶
  `MAX_TIER = 8`。T1 的 `parentId` 是 `root.id`，其余指向父节点 `id`。
- **kind**：`session` | `subagent`；**device**：只作节点标签（`pc-ky614` / `server` / `mcloud` / `s5`），不参与分组。
- **status**：`run` / `idle` / `queue` / `blocked` / `done`（未知状态落 `idle`，不冒充运行中）。
- **startedAt**：ISO 字符串或 `null`（远端列表不提供创建时间，不编）。
- **官方 subagent 地址契约（0.5.0，仅本机节点）**：`childSessionId` = 节点自身的会话 id；
  `parentSessionId` = DSH 持久化的直接创建者（`header.parentSession`，与官方同源同口径）；`mode` =
  `one-shot` / `continuable` / `unknown`（官方 `SubagentAddress` 的三个合法值，来自官方 `subagentCatalog`
  优先、子会话自身 `subagent` 投影其次，都没有给 `unknown`，不猜）。**本机 T1 顶层会话没有父会话**：
  `parentSessionId` 与 `mode` 都是 `null`（不拿树根实例 id 冒充 session id）。远端节点不带这三个字段
  （跨实例的 session id 不是本机可打开地址）。
- **上限**：节点 ≤ 200；单个远端会话行 ≤ 40；`title` ≤ 120 字符、`instanceId` ≤ 80。
- **缓存**：进程内 4 s（`TIERS_CACHE_MS`），并发请求共用同一个 in-flight promise；命中带
  `source.cached:true` + `ageMs`。
- **超时**：所有对端并行 `interconnect.list()`，单个上限 2 s（`TIERS_TIMEOUT_MS`）；失败/超时/无应答
  都写进 `source.remote[].error` 与 `degraded.reason`，接口本身仍 200。
- **数据源整体不可用**：仍返回 `root`（T0）+ `nodes: []` + `degraded`，页面照常渲染根节点。

### tiers 的真实数据来源（Host 侧，只读）

1. **本机会话与父子血缘**：`ctx.sessions.list()`（`SessionStore`，只含活会话）里每个 `Session` 的不可变
   `header`：
   - `origin === 'subagent'` 才能判定为子代理（普通 fork 也可能带 `parentSession`，但 `origin` 不是 `subagent`）；
   - `parentSession` 是子代理的直接父会话 id —— 这就是 **DSH 自己持久化的真实血缘**；
   - `createdAt` 用于 `startedAt` 与兄弟排序；`delegationDepth` 仅参考，tier 由父链重算。
2. **本机会话状态**：`ctx.agents.list()` 的 `agent.status`（`running` / `idle`；`agent.id === session.id`）。
3. **标题**：`ctx.sessionProjections.snapshot(session).values.title`（best-effort），取不到用短 id。
4. **其它设备会话**：`ctx.interconnect.list(instanceId)`——只对 `ctx.interconnect.peers()` 中
   `link === 'up'` 的对端发；返回该实例的活会话行 `{sessionId, title?, status?}`。
   `down` 的对端不发请求，如实把 `link:'down'` 交给页面。

**为什么不用 `ctx.subagents.listDescendants`**：它需要 `sessionQuery` 服务与 `subagentCatalog` 投影，逐会话
异步读会话日志，桥接不到 2 s 的远端预算内；而它多给的只是"已结束的子代理"。本面板是**活控台**，
只列活会话与活子代理是产品口径（页面空态写明「暂无活子代理」）。若将来要展示已结束的子代理，升级路径
就是把 `listDescendants` 结果 merge 进本模块（字段形状已兼容 `parentId`/`depth`），且延后到 8 s 档。

### 降级原因对照

| 场景 | `degraded.reason` 示例 | 页面表现 |
|---|---|---|
| 没有 interconnect 服务 | 本实例没有可用的 interconnect 服务：其它设备的会话不可见 | T0 + 本机会话仍在，降级 badge |
| 没有 sessions 服务 | DSH 没有可用的 sessions 服务：本机会话层级不可见 | T0 + 远端会话（若有），降级 badge |
| 对端 link down | 不写 degraded（这是链路事实），`source.remote[].link = down` | 该设备不出 T1；集群页显示 down |
| 对端 list 超时 / 失败 / 无应答 | `server 的会话列表超时（2000ms）` / `…失败：该设备会话不可见` / `…不可达（链路无应答）` | 该设备不出 T1，降级 badge |
| 有远端 T1 | 远端设备的子代理层级不可见（interconnect 只列顶层活会话） | 远端 T1 正常显示，降级 badge 说明缺口 |
| 子代理父会话已不在活会话里 | 有子代理的父会话已不在活会话列表里，已把它挂到 T1 | 节点不丢，挂到 T1 |
| 节点超上限 | 层级节点超过上限，已截断（只列前 200 个） | 截断并标降级 |
| 路由本身 404（未重启） | 页面显示：api/tiers 路由尚未加载（HTTP 404）：新版 Host 需重启 DSH 后生效 | 只渲染 T0 + 空态，降级 badge |

---

## `api/board` 契约（0.5.0：mesh + 官方两条源）

```jsonc
{
  "generatedAt": "…",
  "configured": true,
  "source": { "origin": "http://127.0.0.1:13090" },   // 只有 scheme+host，token 不进这里
  "health": { "ok": true, "latencyMs": 4, "service": "…", "version": "…", "schema_version": 4 },
  "tasks": [ /* mesh 任务：旧字段 + 官方 TeamTaskView 字段叠加 */ ],
  "events": [ /* 最近事件（最多 12） */ ],
  "official": { /* 官方 Agent Teams 投影，见下 */ },
  "cached": false
}
```

### mesh 任务行（`tasks[]`，`source:"mesh"`）

旧字段全部保留（页面旧代码继续读 `title/state/owner/evidenceCount/...`），另叠加官方 `TeamTaskView`：

| 字段 | 来源 / 语义 |
|---|---|
| `subject` / `description` | 板子的 `title` / `brief` |
| `status` | 五态 → 官方四态：`leased→in_progress`、`done→completed`、`canceled→deleted`、其余 `pending`（原 `state`/`lifecycle` 保留，五态不丢） |
| `revision` | 板子的 `version` 列；没有给 `null`（不编数字） |
| `blockedBy` / `writeScopes` | **恒为空数组**，并带 `unsupported:["blockedBy","writeScopes"]`——mesh 板服务没有这两列，页面据此显示「数据源不含依赖/写域」，不假装"没有依赖" |
| `ownerName` | 板子的 `owner_session`（通常是 agent 路径，如 `agent-team:mcloud:worker-1`） |
| `ready` | 官方规则：`status==='pending' && blockedBy 全部 completed`（mesh 无依赖列时等价于"pending 即可接手"） |
| `writeScopeWarnings` | 官方规则：与其它 `in_progress` 任务写域重叠时告警（mesh 无写域列，当前恒空） |
| `source` | `"mesh"` |

### `official` 段

```jsonc
{
  "available": true,                 // false 时带 reason，页面显示「官方任务板不可用（原因）」
  "teams": [
    { "sessionId": "session-…", "title": "主控会话", "enabled": true, "taskCount": 2, "shownTasks": 2 }
    // enabled:false 的团队不进 tasks，只在 teams 里留痕；failure 字段可选，原样带出官方投影错误
  ],
  "tasks": [
    { "id": "task-1", "revision": 3, "subject": "…", "description": "…",
      "status": "pending", "blockedBy": [], "writeScopes": ["lib/a"], "ownerId": "…", "ownerName": "…",
      "ready": true, "writeScopeWarnings": [],
      "source": "official", "sessionId": "session-…", "sessionTitle": "主控会话", "teamEnabled": true }
  ],
  "hiddenTasks": 0,                  // Team 模式关闭、被隐藏的任务数
  "truncated": false,                // 超过 OFFICIAL_TASK_LIMIT=50 时为 true
  "failedSessions": 1                // 可选：部分会话投影读取失败的数量
}
```

**Host 侧怎么读（就一条只读路径）**：`ctx.sessionProjections.snapshot(session, ['agentTeam','title'])`，
取 `values.agentTeam`（官方 `dsh-agent-team` 的投影键，wire 形状 `{enabled, tasks: TeamTaskView[], failure?}`）。
只扫 `ctx.sessions.list()` 里的**活根会话**（`header.origin !== 'subagent'`，团队挂在根会话上）；
`agentTeam` 键缺失（服务未注册）与"读失败"分开报。

### 官方任务板降级对照

| 场景 | `official` | 页面 |
|---|---|---|
| 缺 `sessions` / `sessionProjections` 服务 | `{available:false, reason:"DSH 没有可用的 … 服务…"}` | 空态 + 原因 |
| 所有活会话都没有 `agentTeam` 键 | `{available:false, reason:"官方 agentTeam 投影未注册（agent-team 插件未启用）"}` | 空态 + 原因 |
| 投影读取全部抛错 | `{available:false, reason:"官方 agentTeam 投影读取失败（N 个活会话全部失败）"}` | 空态 + 原因（原始异常文本不进响应） |
| 部分会话失败 | `available:true` + `failedSessions` | 正常显示，settings 页可见 |
| 共享板本身不可达 | `official` **照常读**（两条源独立降级） | 官方任务板正常，mesh 区显示不可达 |
| Team 模式关闭但历史有任务 | `tasks` 不含它们，`hiddenTasks` 记数 | 显示「官方任务板为空：…没有开启团队模式的任务板」 |

---

## TRAIL 告警（0.6.0）

### 来源与许可

- 分类体系搬自 **TRAIL: Trace Reasoning and Agentic Issue Localization**
  （<https://github.com/patronus-ai/trail-benchmark>，**MIT**，`Copyright (c) 2025 patronus-ai`）。
- **只搬了「分类体系 + 规则化分类器」**：
  - 21 个叶子类目的权威清单在 `benchmarking/calculate_scores.py` 的 `all_categories`；
  - 类目树（3 大类 / 9 组）在 `benchmarking/run_eval.py` 的 `get_prompt()` taxonomy 文本里；
  - 两处有一个差异：prompt 树 20 个叶子（无 `Incorrect Memory Usage`），评分清单 21 个（多它）。
    本插件按 **21 个**收录，把它挂在 `Information Processing` 组下，**类目名一个都没改**；
    没有合并、没有省略。
- **TRAIL 的 LLM judge（`run_eval.py` 的 prompt + litellm 调用）没有接，也不会接**：
  `lib/trail.js` 零 import、零网络、零进程、零费用，只按现有数据结构的真实字段推导。
- MIT 版权声明随代码保留在 **`lib/trail.LICENSE`**（`lib/trail.js` 文件头也写了出处）。

### 类目映射表（21 个叶子类目，TRAIL 原名 → 中文释义）

`evidenceHint` 是「我们体系里对应哪些真实字段」；标「未落地」的类目**本版没有规则消费它**
（没有可判别字段就不造规则）。

| # | TRAIL 类目 id（原名） | 分组 | 中文释义 | 我们体系里的字段 / 落地情况 |
|---|---|---|---|---|
| 1 | `Language-only` | Reasoning / Hallucinations | 语言性幻觉 | 未落地：没有模型话术字段 |
| 2 | `Tool-related` | Reasoning / Hallucinations | 工具性幻觉 | 弱线索 `tasks[].evidenceCount`；本版归到 Instruction Non-compliance，不冒充幻觉 |
| 3 | `Poor Information Retrieval` | Reasoning / Information Processing | 检索无关信息 | 未落地：没有检索记录 |
| 4 | `Incorrect Memory Usage` | Reasoning / Information Processing | 错误使用记忆 | 未落地（20/21 差异项，见上） |
| 5 | `Tool Output Misinterpretation` | Reasoning / Information Processing | 误读工具输出 | 未落地：事件只有一行摘要 |
| 6 | `Incorrect Problem Identification` | Reasoning / Decision Making | 认错问题 | 未落地：没有任务意图对照 |
| 7 | `Tool Selection Errors` | Reasoning / Decision Making | 选错工具 | 未落地：不记录调用链 |
| 8 | `Formatting Errors` | Reasoning / Output Generation | 格式错误 | 未落地：验收是自由文本 |
| 9 | `Instruction Non-compliance` | Reasoning / Output Generation | 不按指令完成 | **规则 `evidence_gate`**：`state=done` 且 `evidenceCount=0`；或 canceled 且有 `task.gate_rejected` 且证据 0 |
| 10 | `Tool Definition Issues` | System / Configuration | 工具定义问题 | 未落地：工具定义在 DSH 宿主 |
| 11 | `Environment Setup Errors` | System / Configuration | 环境/凭据问题 | 旁证：`/api/board` 的 `error.code=http-401/403`（进「系统是否健康」，不产告警） |
| 12 | `Rate Limiting` | System / API Issues | 限流 | 未落地：没有调用计数/429 字段 |
| 13 | `Authentication Errors` | System / API Issues | 鉴权失败 | 旁证：`error.code=http-401/403`（同上） |
| 14 | `Service Errors` | System / API Issues | 服务端错误 | 旁证：`error.code=http-5xx`、`degraded.reasons`（同上） |
| 15 | `Resource Not Found` | System / API Issues | 资源不存在 | 旁证：板任务/路由 404（同上） |
| 16 | `Resource Exhaustion` | System / Resource Management | 资源耗尽 | 未落地：内存由 `/api/host` 展示，但没有和失败因果绑定的字段 |
| 17 | `Timeout Issues` | System / Resource Management | 超时 | **规则 `lease_expired`**（`leaseDeadline` 过期 / `state=stale`）、**`ack_timeout`**（`ackDeadline` 已过且 `ackAt=null` / `ackState=timeout`） |
| 18 | `Context Handling Failures` | Planning / Context Management | 上下文处理失败 | **规则 `subagent_orphan`**：`nodes[].kind=subagent` 且 `tier=1`（父会话已不在活会话列表 = 血缘状态跟踪断） |
| 19 | `Resource Abuse` | Planning / Context Management | 资源滥用 | 未落地：事件计数判不了「过度」 |
| 20 | `Goal Deviation` | Planning / Task Management | 目标偏离 | 弱线索：`duplicate_work` 只是重复劳动迹象，不冒充目标偏离 |
| 21 | `Task Orchestration` | Planning / Task Management | 任务编排 | **规则 `task_stalled` / `subagent_stalled` / `duplicate_work` / `dispatch_undelivered` / `subagent_anomaly`（阻塞、父已完成子仍在跑）/ `official_team_failure`** |

> 诚实说明：21 个类目全在表里，但 **0.6.0 只有 4 个类目有规则**（Task Orchestration / Timeout Issues /
> Instruction Non-compliance / Context Handling Failures）；另有 **4 个类目只有健康问旁证**
> （Environment Setup Errors / Authentication Errors / Service Errors / Resource Not Found，
> 在「系统是否健康」里如实列出，不产告警）、**2 个类目只是弱线索**（Tool-related、Goal Deviation，
> 不冒充结论）、其余 **11 个类目未落地**（现有数据里没有可判别字段，明确标「未落地」，不硬凑）。

### 阈值（集中在 `lib/trail.js::THRESHOLDS`，不散落魔法数字）

| 常量 | 值 | 依据 |
|---|---|---|
| `TASK_STALL_WARN_MS` | 10 分钟 | 本机真实板 `lease_ms=300000`（5 分钟）；10 分钟 = 两个租约周期都没有任何更新 |
| `TASK_STALL_HIGH_MS` | 30 分钟 | 6 个租约周期无更新 → 判「高」 |
| `SUBAGENT_STALL_MS` | 2 小时 | 子代理（一次性/可续聊）创建 2 小时后仍 `running`，需要人看一眼 |
| `DUPLICATE_WINDOW_MS` | 24 小时 | 只看 24 小时内重开/并存的卡，更早的算历史，不打扰人 |
| `MAX_ALERTS` | 50 条 | 防异常数据把页面撑爆 |

### 规则清单（10 条，全部基于真实字段）

| ruleId | 严重度 | 类目 | 触发字段 | 建议动作 |
|---|---|---|---|---|
| `task_stalled` | 中/高 | Task Orchestration | `tasks[].lifecycle∈{open,claimed,working,blocked}` + `leaseDeadline>now` + `now-updatedAt≥10min`（≥30min 高） | 问 owner；超时接管或重派 |
| `subagent_stalled` | 中 | Task Orchestration | `nodes[].kind=subagent` + `status=run` + `now-startedAt≥2h` | 确认是否真在干活；父会话完成就收尾 |
| `lease_expired` | 高 | Timeout Issues | `tasks[].state=stale`（且非终态）+ `leaseDeadline`/`expiredAt` | 确认失联则接管或重派 |
| `ack_timeout` | 中 | Timeout Issues | 非终态 + `ackDeadline` 已过且 `ackAt=null`，或 `ackState=timeout` | 重新派发/换会话投递 |
| `dispatch_undelivered` | 中 | Task Orchestration | `tasks[].lifecycle=open` + `state=undelivered` | 重派并确认目标会话在线 |
| `duplicate_work` | 高/中/低 | Task Orchestration | 按 `title` 分组：≥2 张活跃同题（高）、取消后重开（中）、24h 内两张同题都取消（低） | 取消多余的卡或合并验收 |
| `evidence_gate` | 高/中 | Instruction Non-compliance | `state=done` + `evidenceCount=0`（高）；canceled + `events[].kind=task.gate_rejected` + `evidenceCount=0`（中） | 补证据重走门禁 / 写清丢弃原因 |
| `subagent_anomaly` | 高/中 | Task Orchestration | `nodes[].status=blocked`（高）；父节点 done/blocked 而子节点 run（中） | 看卡在哪；父已完成就让子收尾 |
| `subagent_orphan` | 低 | Context Handling Failures | `nodes[].kind=subagent` + `tier=1`（父会话已不在活会话列表） | 确认无用就结束遗留会话 |
| `official_team_failure` | 中 | Task Orchestration | `official.teams[].enabled=true` + `failure` 非空（官方 wire 字段） | 按 failure 原文去会话排查 |

**去重与排序**：同一条规则对同一主体只留一条；**不同规则不互相吞**（同一子代理「跑太久」和「被阻塞」是两件事）。
输出按 严重度（高→中→低）→ 类目 → 主体 id 稳定排序，同一份数据重复跑结果一致。
**输出为空是合法结果**（规则不为了有告警而造）。

### `api/alerts` 契约

```jsonc
{
  "generatedAt": "2026-11-21T12:12:06.226Z",
  "source": {
    "classifier": "trail-rules-v1",   // 规则化分类器版本（不是 LLM）
    "taxonomy": 21,                    // TRAIL 叶子类目数
    "rules": 10,                       // 生效规则数
    "board": "real",                   // real | unconfigured | unreachable | missing（共享板快照可用性）
    "tiers": "degraded",               // real | degraded | missing（层级快照可用性）
    "cached": false, "ageMs": 0        // 4 s 进程内缓存命中标记
  },
  "counts": { "high": 0, "medium": 0, "low": 1, "total": 1 },
  "alerts": [
    {
      "id": "trail-subagent_orphan-node-session-…",  // 稳定 id（ruleId + 主体）
      "ruleId": "subagent_orphan",
      "severity": "low",                             // high | medium | low
      "category": "Context Handling Failures",       // TRAIL 叶子类目 id（原名）
      "categoryLabel": "上下文处理失败",              // 中文释义
      "subjectType": "task",                         // task | node | team（页面据此把标记挂到任务卡）
      "subjectId": "t-…",
      "subject": "任务 t-…「标题」（或 子代理/会话/团队）",
      "why": "一句话为什么（带数字，例如「租约已过期 20 分钟…」）",
      "evidence": ["tasks.t-….leaseDeadline=2026-11-21T11:52:06.226Z（已过期 20 分钟）"],
      "suggestion": "建议动作（可执行的一句话）",
      "relatedIds": ["t-…", "t-…"]                   // 可选：同一组告警的其它主体（如重复劳动两张卡）
    }
  ],
  "degraded": { "reasons": [] }                      // 始终有该字段；空数组 = 数据源完整
}
```

- **4 s 缓存 + 单飞**：`createAlertsReader` 缓存整个响应体；同一时刻多个请求只组装一次。
- **不新增网络/进程调用**：`buildAlerts` 只 await 板/层级两个 reader 的 `read()`，复用它们自己的缓存；
  顺手给 `lib/board.js` 的读取器加了单飞（`api/board` 与 `api/alerts` 同时打进来时只碰板一次）。
- **错误降级与既有路由同样式**：始终 200 + 结构化 JSON；`degraded.reasons` 写人话原因，
  不把 stack/URL/原始异常交给页面；数据源缺一个，另一个照常出告警。

### 页面上的表现

- **三问第一问（是否需要我）**：告警路由可用时由告警驱动——
  - 高/中：`需要你：N 条`（N=high+medium）+ 高·中计数，默认展开告警卡（严重度颜色 + 中文类目 +
    一句话为什么 + 建议动作 + 证据字段）；
  - 无高/中：明说「当前没有需要你处理的异常」，不渲染假 0 条卡片；
  - 低优先级单独折叠为「另有 N 条低优先级提示」，**不占「需要你」计数**；
  - 官方任务板里「可认领但没负责人」的卡仍单独列一行（告警不覆盖官方卡）；
  - 数据源覆盖不完整时，在「系统是否健康」与第一问下方如实写「告警覆盖不完整：…」。
  - **路由不存在（Host 未重启 / HTTP 404）时**：退回 0.5.0 的「按板状态直接列 awaiting/undelivered/stale」
    路径，行为不变；同时在「系统是否健康」加一行「api/alerts … 重启 DSH 后路由生效」。
- **任务页**：命中告警的 mesh 任务卡在标题后加小标记（`⚠ 高 · 超时` / `中 · 任务编排`，按严重度配色），
  点击/Enter 跳到大管家、展开对应告警卡并定位闪烁；一张卡可挂多条（不同规则）。
- **设置页**：显示「告警」数据源（规则数 / 类目数 / 高·中·低 / 板与层级可用性 / 覆盖不完整项数）。
- **轮询**：告警与 cluster/board/host 一起每 30 s 刷新；页面隐藏跳过；轮询失败保留上一次好数据
  （右上角「数据过期」横幅里会带「告警：…」）。

### 已知限制（如实列出）

1. **规则化 ≠ LLM judge**：本版只搬了 TRAIL 的分类体系与规则，**没有接 TRAIL 的 LLM judge**；
   不做语义推理，只做字段规则判定。想接 judge 需要模型通道与费用，不在 0.6.0 范围。
2. **没有 location（span id）级定位**：TRAIL judge 输出「类目 + span 位置」，我们的板/层级数据没有 span 层，
   `evidence` 只能指回「字段路径=值」与事件 `seq`；`api/alerts` 也没有 TRAIL 的 reliability/security
   等 0–5 主观评分（不编分数）。
3. **覆盖分布说实话**：21 类中 **4 类有规则**、**4 类只有健康问旁证**、**2 类只是弱线索**、
   **11 类未落地**（现有数据里没有可判别字段，见映射表）；不硬凑规则，也不把旁证冒充告警。
4. **远端板依赖**：任务类告警依赖共享板快照；板不可达/未配置时任务规则不跑（`source.board` 与
   `degraded.reasons` 如实写），不会编告警。远端 mcloud 板服务升级期间可能短暂 5xx，按降级处理。
5. **阈值是工程经验值**：10 分钟/30 分钟/2 小时/24 小时来自本机真实租约与使用习惯，不是统计标定；
   改阈值只改 `lib/trail.js` 顶部常量。
6. **只读活数据**：已结束会话/任务的历史事件只从 `/api/board` 的最近 12 条事件来，更早的门禁事件
   可能看不到（证据门禁规则对 `done` 无证据仍然有效，因为它只依赖任务行）。
7. **`api/alerts` 是新 Host 路由**：运行中的 DSH 不重启的话页面会按 404 降级；重启后页面第一问自动切到
   告警模式（前端代码已就位）。

---
## 页面行为

- **中栏示例对话**：`#demoBadge` 常驻「示例对话 · 静态演示（不是真实聊天…）」；轨迹 tab 也标注
  「示例轨迹 · 静态演示」。示例区不发送、不持久化；composer 的快捷动作与右栏层级才是真实数据/真实调用。
- **快捷动作**（composer 上方「快捷动作」行，全部走 0.3.0 的三条真实通道）：

  | 动作 id | 通道 | 行为 |
  |---|---|---|
  | `new-session` | DSH 客户端（postMessage） | 调 `uiWorkspace.startSession()`（与 Ctrl+Alt+N 同一 API） |
  | `dispatch` | DSH 客户端 | 面板没有 mesh_* 工具通道 → 如实「暂不支持」，回执里给「草稿替代」按钮 |
  | `dispatch-draft` | DSH 客户端 | 新会话 + 输入框填入 mesh_dispatch 提示（草稿不自动发送） |
  | `board` | 页面本地 | 用 `api/board` 拿到的真实 origin 打开共享板；不可达只给原因，不静默置灰 |
  | `notes` | Host `POST api/action` | 真探测 OpenViking，可达才打开 Studio；失败给原因 |
  | `latest-report` | Host `POST api/action` | 真读最新 `.md`（≤64 KiB），内容显示在本页「最新报告」面板 |
  | `open-reports-folder` | Host `POST api/action` | `explorer.exe` 打开固定报告目录（回执里的二级动作） |
  | `restart-dsh` | — | **永久禁用**：红线，不由面板重启 DSH |

- **回执四态**：成功 / 失败 / 暂不支持 / 进行中；没有本地假回执。
- **三问条（0.5.0 起，大管家页顶部）**：官方 `docs/005-panel.md` 的信息架构——「是否需要我 / 系统是否健康 /
  这件事的历史」。**健康态不占位**（没有内容就 hidden，三条都空整条不显示）；每行写「在等谁、要什么」；
  计数 = 列表长度。**0.6.0 起第一问由 `api/alerts` 告警驱动**（高/中 →「需要你：N 条」可展开告警卡；
  无 →「当前没有需要你处理的异常」；低优先级单独折叠不占计数；官方可认领任务仍单独一行）；
  告警路由 404（Host 未重启）时退回 0.5.0 的「只认板上 `awaiting/undelivered/stale`」路径。
  第二问逐行列链路 down / 板不可达 / 官方投影不可用 / 本机不可读 / `api/tiers`、`api/alerts` 404 /
  告警覆盖不完整等真实问题；第三问优先右栏选中节点（状态/开始时间/子代理模式/子代理数），
  否则给共享板最近一条任务的历史摘要。
- **任务页**：共享板最近 20 任务 / 12 事件（五态徽标 + 证据数 + 相对时间 + 可展开详情），每行带官方
  `TeamTaskView` 状态点（`pending→idle`、`in_progress→ongoing`、`completed→done`，`pending 且未 ready →
  warning`）与 `ready / blockedBy / writeScopes / writeScopeWarnings` 详情；另有只读「官方任务板」卡片，
  不可用时显示原因。**0.6.0 起命中告警的任务卡标题后带可点小标记**（点了跳到大管家并展开对应告警卡）。
  待办仍在 `localStorage`（`dsh-workbench-todos-b`）。
- **任务状态文案**：官方报告五态用中文——进行中 / 可接手 / 受阻 / 失败 / 已撤销（页面不直接显示英文状态值）；
  任务状态中文：待办 / 进行中 / 已完成 / 已取消。
- **集群页**：inline SVG 拓扑（4 槽位 + 5 条边 + 待接入空心圆）+ 设备/链路列表（`origin` 已脱敏）。
- **记忆页**：真探测按钮 + 探测结果（origin / 延迟 / 原因）。
- **设置页**：插件版本、五条只读路由（cluster / board / host / tiers / alerts）、写动作路由、当前数据源
  （板 / 链路 / 层级 / 告警 / 本机）、回滚说明与红线。
- **轮询**：cluster/board/host/alerts 每 30 s，tiers 每 15 s；`document.hidden` 时跳过；**轮询失败保留上一次好数据**，
  只在右上角出「数据过期 · HH:MM:SS / 原因」横幅，不闪回 mock；只有**首次**失败才落 MOCK 并标
  「mock 兜底 · 原因」。
- **窄屏**：≤1200px 右栏抽屉；900px 实测无横向溢出。
- 无障碍：导航/动作是原生 button，层级树 `role=tree/treeitem`、可 Tab 聚焦、Enter 选中；
  `prefers-reduced-motion` 降级动画。

---

## 安装 / 配置 / 回滚

装法（二选一）：

```
plugin_manager: install_bundle  target: <本仓库>\dsh-plugins\dsh-html-panel
```

或在 GUI：**Plugins → Add plugin → 本地目录**。profile 里会出现 `dsh-html-panel: file:...` 并选中该 bundle。

**重启要求**：新增/替换包、以及本版 `lib/`（新 `api/tiers` 路由、侧栏改名）都需要 **重启 DSH** 后生效；
**只改 `public/index.html` 刷新页面即生效**（Host 每次请求都从磁盘读，`cache-control: no-store`）。

共享板配置（profile patch 层，token 用 `dsh-team-mesh` 行里同一个值；不配置也能跑，任务页显示「板未配置」）：

```yaml
- id: dsh-html-panel
  config:
    board:
      endpoint: 'http://127.0.0.1:13090'
      token: '<boardToken>'
      timeoutMs: 4000
    # 可选：动作默认值
    actions:
      memory: { url: 'http://172.24.112.11:1933/' }
      reports: { dir: 'C:\Users\<user>\mesh-0.6-dev\repo\docs' }
```

卸载 / 回滚：

```
plugin_manager: remove_bundle  target: dsh-html-panel   # 然后重启 DSH
```

手动作业：删 profile `package.json` 的依赖行与 `dsh.profile.bundles` 项、删 `cordis.patch.yml` 的
`- id: dsh-html-panel` 块、删 `node_modules\dsh-html-panel`，再重启。

**页面级回滚**（保留插件，只恢复占位页）：`copy /Y public\index.placeholder.html public\index.html`。
**整包回滚 0.5.0**：把 `node_modules\dsh-html-panel` 换回
`node_modules\dsh-html-panel.bak-before-0.6.0-20261121`（本机已建好的整目录备份）后重启 DSH。
更早的回滚点：`dsh-html-panel.bak-before-0.5.0-20261121`（0.4.0）。

---

## 文件布局

```
lib/index.js      Host 半：路由注册（prefix 文件 + 五条 api GET + api/action POST）
lib/tiers.js      0.4.0：派活层级组装 + 4s 缓存/单飞 + 降级（纯函数，可单测）
lib/trail.js      0.6.0：TRAIL taxonomy（21 类目）+ 规则化分类器 + api/alerts 组装（零依赖纯函数）
lib/trail.LICENSE 0.6.0：TRAIL（MIT，Copyright (c) 2025 patronus-ai）许可原文，随代码保留
lib/cluster.js    api/cluster：interconnect 链路快照
lib/board.js      api/board：共享板读取（token 只进请求头，3s 缓存 + 单飞）+ 官方 agentTeam 投影只读段
lib/boardmap.js   板数据 → 页面字段（与离线工具同一份实现）
lib/taskview.js   0.5.0：官方任务视图纯函数移植 + mesh→TeamTaskView 投影（零依赖）
lib/host.js       api/host：本机 os/statfs
lib/actions.js    api/action：白名单动作（报告 / 记忆探测 / 打开目录）
lib/client.js     浏览器半：侧栏行（label=大管家）+ iframe 面板 + 动作消息桥
public/index.html 单文件页面（内联 CSS/JS，零外链）
locale/*.json     插件标题/描述（大管家 / Butler Console）
icon.svg          插件图标
tools/            单测（actions/board/cluster/client-actions/taskview/tiers/trail/mesh-snapshot）、
                  check-page 静态自检、cdp-butler / cdp-alerts 运行时自检、verify-copies、live-check、
                  fixtures（board/tiers 真实快照 + alerts-edge 人造边界快照）、截图与报告
```

`public/index.v1-team-board.html`、`index.v3-cluster-overview.html`、`index.placeholder.html` 是历史版本/占位页，
保留作回滚素材，不被路由默认加载。

---

## 测试与验收（0.6.0，本机 Windows / Node 24.19.0 / 无头 Edge + CDP）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| A1 | `node --test` | **140 / 140 pass**（trail 38 + taskview 19 + board 19 + tiers 25 + cluster 16 + actions 14 + client-actions 8 + mesh-snapshot 1；0.5.0 的 102 条一条没删） | 终端输出 |
| A2 | `node tools/check-page.mjs --json tools/shots/check-page.json` | **173 / 173 PASS**（0.5.0 的 161 项：**159 项原样保留 + 2 项按事实改名**——设置页版本改 0.6.0、只读路由改五条，断言更严；**12 项新增** api/alerts / 三问告警 / 告警卡 / 任务标记检查；无删除、无弱化） | `tools/shots/check-page.json` |
| A3 | `node tools/cdp-butler.mjs` | **100 / 100 PASS**，14 张截图（版本期望更新到 0.6.0、健康问新增 api/alerts 404 行；其余断言不变） | `tools/shots/cdp-butler-report.json` |
| A4 | `node tools/cdp-alerts.mjs --live --live-port <运行中端口>` | **43 / 43 PASS**，7 张截图（有告警 / 无告警 × 1440/900 + 任务标记/跳转 + 真实运行页面降级）；页面 JS 报错 0 | `tools/shots/cdp-alerts-report.json` |
| A5 | `node tools/trail.test.mjs` | **38 / 38 pass**（taxonomy 保真 6 / 规则正反例 14 / 真实快照 2 / 人造边界 3 / 组装缓存降级 6 / 路由 4 / 零依赖 1 + 去重排序纯函数等） | 终端输出 |
| A6 | `node tools/verify-copies.mjs --sync` | 两份副本逐文件 sha256 全等（源 ↔ `node_modules/dsh-html-panel`），含新增 `lib/trail.js`、`lib/trail.LICENSE`、`tools/trail.test.mjs`、`tools/cdp-alerts.mjs`、`tools/fixtures/`、`tools/shots/shot-alerts-*` | `tools/shots/copy-verify.json` |
| A7 | `DSH_URL=<运行中地址> node tools/cdp-alerts.mjs --live` | 运行中页面已是 0.6.0（页面热更新 YES）；Host 仍是部署前的 0.5.0 代码 → `api/alerts` 404、页面退回 0.5.0 行为并在健康问写明重启；页面无白屏 | `tools/shots/shot-alerts-07-live-real-1440.png` |

`trail.test.mjs`（新增 38 条）覆盖：
- **taxonomy 保真**：21 个 id 与 TRAIL `calculate_scores.py::all_categories` 逐字一致、字段齐全、
  3 大类 9 组、`Incorrect Memory Usage` 的 20/21 来源差异有记录、MIT 来源与「judge 未接」写死；
- **10 条规则逐条正例 + 反例**（含阈值边界：25 分钟报中、45 分钟报高、1 小时子代理不报；
  done+0 证据报高、done+有证据不报；终态 stale 不报；已 ack 不报等）；
- **真实快照**：`tools/fixtures/board-2026-11-21.json` + `tiers-2026-11-21.json`（真实 `/api/board`、
  `/api/tiers` 返回，无 token）跑出 1 条低优先级（孤儿子代理），并锁住「184 小时前的旧重复卡按 24 h
  窗口不打扰」；同一份数据重复跑结果完全一致（幂等）、输入不被修改；
- **人造边界快照**：`tools/fixtures/alerts-edge-2026-11-21.json`（**字段结构逐字照真实行复制**、
  值是构造的，文件里带 note 说明）覆盖真实快照没触发的规则——10 条规则全部命中，高 5 / 中 8 / 低 2；
- **降级与健壮**：空输入/脏行/字段缺失/时间字符串/超长标题不抛；`buildAlerts` 两个 reader 各自失败
  都结构化降级；`createAlertsReader` 4 s 缓存（cached/ageMs）与并发单飞；`fallbackAlerts` 契约一致；
- **路由（真 socket）**：`GET/HEAD/POST api/alerts`、未知 `api/*` JSON 404、假板服务端到端命中
  `lease_expired`、**响应里 grep 不到板 token**、`api/board`+`api/alerts` 并发只碰板一次（单飞）；
- **零依赖**：`lib/trail.js` 的代码里没有 import/require/fetch/child_process，注释保留 TRAIL 出处。

### 0.6.0 告警截图（`tools/shots/shot-alerts-*.png`，headless Edge 实拍）

| 文件 | 档位/场景 | 画面里能看到什么 |
|---|---|---|
| `shot-alerts-01-needs-1440.png` | 1440 · 有告警（fixture） | 三问第一问「需要你：3 条 · 高 2 · 中 1」展开 3 张告警卡（红/橙左边条 + 高/中徽标 + 中文类目「不按指令完成/超时/任务编排」+ 为什么一句话 + 建议动作 + 证据字段「tasks.…evidenceCount=0」）；下面一行「另有 2 条低优先级提示 … 不占「需要你」计数」；再一行「告警覆盖不完整：层级快照有降级…」；「系统是否健康 2」里有告警分类器降级行；页脚 v0.6.0 |
| `shot-alerts-02-tasks-flags-1440.png` | 1440 · 任务页（有告警） | 5 张任务卡，其中 4 张标题后带告警小标记：`高 · 不按指令完成`（done 无证据）、`高 · 超时`（租约过期）、`中 · 任务编排` ×2（同标题并存两张卡） |
| `shot-alerts-03-jump-1440.png` | 1440 · 点任务卡标记跳转后 | 回到大管家页，告警折叠已展开、对应告警卡在页面里（跳转定位） |
| `shot-alerts-04-needs-900.png` | 900 · 有告警 | 窄屏下三问条与 3 张告警卡完整可读、无横向溢出、右栏收起为「派活层级 T1×2」按钮 |
| `shot-alerts-05-empty-1440.png` | 1440 · 无告警（fixture） | 「是否需要我 0 · 当前没有需要你处理的异常 · 告警分类器已跑（高 0 · 中 0）」——**不渲染假卡片**；健康问只剩链路 down；任务卡无标记 |
| `shot-alerts-06-empty-900.png` | 900 · 无告警 | 窄屏同样的「当前没有需要你处理的异常」，无横向溢出 |
| `shot-alerts-07-live-real-1440.png` | **真实运行中的 DSH 页面**（1440，非 fixture，`--live`） | 页面文件已是 0.6.0（页脚 v0.6.0），但 Host 未重启：`api/alerts` 404 → 「系统是否健康 4」多一行「在等 api/alerts（TRAIL 告警）要 重启 DSH 后路由生效（当前 HTTP 404）」；真实板上此刻没有 awaiting/undelivered/stale，「是否需要我 0」不占位（没有编造告警）；右栏是真实层级（T1×10 / T2×1）、任务页 20 任务、页脚 v0.6.0 —— 如实降级的样子 |

### 0.5.0 验收（历史，保留）

单测 102/102（taskview 19 + board 19 + tiers 25 + cluster 16 + actions 14 + client-actions 8 +
mesh-snapshot 1）、静态 161/161、CDP 100/100（14 张截图）、live：页面热更新为 0.5.0 但 Host
仍是 0.4.0（`api/board` 无 official 段、`api/tiers` 无契约字段）→ 需重启。

`taskview.test.mjs`（新增 19 条）覆盖：官方 `task-view.ts` 规则逐条移植断言（blocker 全完成才 ready、未知 blocker
不算完成、ready 只在 pending、写域按路径分量判重叠、只跟 in_progress 比、多任务告警、字段副本与 owner 省略）；
**本机真实板数据**（2026-11-21 从共享板 `/task/list` 只读取回的 10 条任务快照，无 token）投影成 `TeamTaskView`；
真实任务 id 上另造依赖链与写域重叠用例（明确标注"板子本身没有这两列"）；`readOfficialBoard` 的 8 种降级/成功分支。

`board.test.mjs` 15→19、`tiers.test.mjs` 21→25：新增 mesh 任务 TeamTaskView 字段、官方 `official` 段（同时给/缺失/
抛错/与 mesh 独立降级）、本机节点 `{parentSessionId, childSessionId, mode}` 与官方投影优先/回退/全失败降级。

CDP 断言（摘要）：五页导航与真实渲染（任务 6 / 事件 8 / 官方任务板 2 / 拓扑 4 节点）、三问条三条计数与
「在等谁/要什么」文案、任务行 StateDot 6 个、官方任务行 source 标记与写域告警详情、右栏 13 节点与计数
`1/4/6/2`、mode 徽标（可续聊/一次性/未知）与 childSessionId/parentSessionId、T1 折叠、点 T2 高亮上级路径
（并让三问历史切到该节点）、动作四态、报告预览、900 无横向溢出与抽屉开合、降级只渲染 T0、404 文案含「重启」、
接口全挂时 MOCK 兜底且官方任务板不冒充数据。

**截图（本机 headless Edge 实拍，`tools/shots/`）**

| 文件 | 档位/场景 | 画面里能看到什么 |
|---|---|---|
| `shot-butler-01-dashboard-1440.png` | 1440 · real | 三问条三块（是否需要我 4 行 / 系统是否健康 3 行 down 对端 / 这件事的历史 2 行）；左栏五页导航 + 任务 6；右栏 T0→T3 树，子代理节点带「可续聊/一次性/未知」徽标；页脚 v0.5.0 |
| `shot-butler-02-tasks-1440.png` | 1440 · 任务页（事件 tab 态） | 任务/事件 tab、共享板真实数据、板 badge「真实 · 共享板」 |
| `shot-butler-14-official-board-1440.png` | 1440 · 任务页滚到官方卡片 | 6 条 mesh 任务（各带官方 StateDot：租约中蓝/已完成绿/等回执橙/未送达红/已过期灰/已取消红）与「官方任务板（只读）2」卡片：待办·可接手 + 进行中两条、`官方` source 标记、只读团队数、报告五态说明 |
| `shot-butler-09-narrow-900.png` | 900 · 窄屏 | 右栏收起为「派活层级 T1×4」按钮，三问条与对话区无横向溢出 |
| `shot-butler-10-narrow-900-drawer.png` | 900 · 抽屉态 | 右侧抽屉滑出 + 遮罩，树 T0–T3 与 mode 徽标完整可见，Esc/关闭按钮在 |
| 其余 9 张 | 1440 · 集群/记忆/设置/动作回执/报告/层级选中/降级/404/mock | 由 `cdp-butler-report.json` 记录对应断言 |
| `shot-live-0.5.0-downgrade-1440.png` | **真实运行中的 DSH 页面**（1440，非 fixture） | 页面已热更新为 0.5.0，但 Host 仍是 0.4.0：三问条只保留「系统是否健康 4」（3 条 down 链路 + 「在等 新版 Host 要 重启 DSH 后 /api/board 才有 official 段」）与「这件事的历史 2」，「是否需要我」因没有待办而**不占位**；右栏真实 6×T1/2×T2 节点 mode 显示「未知」、页脚写「mode：未知（官方投影不可用）」——这就是如实降级的样子 |

**0.6.0 未验证 / 已知限制（如实列出，不当作成功）**：

1. **Host 侧新路由需要重启 DSH**：本轮运行中的实例是部署前启动的 **0.5.0** 代码（红线：不重启），
   所以 `api/alerts` 仍是 404（`lib/trail.js` 已随整目录同步到已装副本，重启后即生效）；页面文件本身
   已热更新为 0.6.0（`cdp-alerts --live` 实拍 `shot-alerts-07-live-real-1440.png`）。重启前第一问按
   0.5.0 路径退回、健康问写明「api/alerts … 重启 DSH 后路由生效」，不白屏、不编告警。
   历史上 0.5.0 时同一现象是 `api/board` 无 `official` 段、`api/tiers` 无契约字段。
2. **官方投影只在本机活根会话上可读**：`sessions.list()` 只含活会话，已结束会话的 `agentTeam` 投影拿不到；
   本版只扫根会话（`origin !== 'subagent'`），不递归子代理的团队（团队本来就挂在根会话上）。
3. **官方任务板默认可能是"空"而不是"坏"**：官方 Agent Teams 的 `defaultEnabled` 默认 false，只有主人给某个
   会话打开「团队模式」后才有任务；此时 `official.available:true` + `tasks:[]`，页面区分「没有开启团队模式」
   与「不可用」两种空态。
4. **mesh 板没有依赖/写域列**：`blockedBy` / `writeScopes` 对 mesh 任务恒空，并带 `unsupported` 标记；页面对
   mesh 任务显示「数据源不含依赖/写域」，不假装"没有依赖"。真实依赖链/写域告警只在官方任务板上出现。
5. **只列活会话**：已结束的会话 / 子代理不会出现在层级树（SessionStore 只存活会话）；这是产品口径。
6. **远端子代理层级仍不可见**：`interconnect.list()` 只列顶层活会话；远端节点也不带官方 subagent 地址字段
   （跨实例 session id 不是本机可打开地址）。
7. 页面对 900 / 1440 两档做了断言；1200–1440 之间是同一套 flex + 断点，未逐档截图。
8. **告警是规则化的，不是 LLM judge**：`api/alerts` 的判定全部是可复核的字段规则（10 条、阈值见上），
   TRAIL 的 LLM judge 与 location 级定位**没有接**；上面「TRAIL 告警 → 已知限制」一节有完整清单。
   规则化判不准的地方（例如 done 无证据也可能只是忘了登记）会给出证据字段让人自己判断，不冒充结论。
### 0.3.0 验收（历史，保留）

- 单测 54/54、静态 116/116、CDP 动作 124/124（6 场景）、live 只读冒烟通过；动作真实化（新会话走
  `uiWorkspace.startSession`、派发如实「暂不支持」+ 草稿替代、看板/记忆/报告真调用）、四态回执、报告预览、
  重启禁用；详见 `tools/report-actions.md` 与 `tools/shots/cdp-actions-report.json`。

### 0.2.0 验收（历史，保留）

- 共享板 / 本机 / 集群三源真实数据接入、五态映射、30 s 轮询不闪回 mock、双副本 sha256 一致；
  详见 `tools/report-board-data.md`、`tools/report-real-data.md`。

---

## 安全与红线

- 页面零外链：无 `http(s)://`、无 `<link>`、无外链脚本/图片/字体、无 XHR/WebSocket；`fetch` 只走同源
  相对路径；`href` 只有站内锚点与 SVG `<use>`。
- 共享板 token 只在 Host 的请求头里；页面响应、错误文本、日志都没有它。
- 动作端点只收白名单 id，不接受路径/命令/URL；拒绝先于副作用。
- 面板**不提供**重启、结束或接管 DSH 进程的能力（按钮永久禁用，页面写明红线）。
- **告警只做字段规则**：`api/alerts` 不接 LLM / 外部 API、不联网跑判定、不加 npm 依赖、不花钱；
  输出为空是合法结果；每条告警必须能指回真实字段/事件 id（`evidence[]`），不为了凑数造告警。
  规则阈值集中在 `lib/trail.js::THRESHOLDS`，可审计可修改。
- 本页所有外部文本（任务、事件、会话标题、实例名、告警文本）渲染前都过 `esc()`；回执/报告用
  `textContent` 或 DOM 构建，不拼 HTML。
