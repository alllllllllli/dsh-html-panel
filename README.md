# dsh-html-panel · 大管家（Butler Console）

**0.4.0** — DSH 侧栏入口，原名「HTML 面板」，本版改名为**大管家**。点开后主区域用 iframe 加载本插件
`public/` 目录里的单文件控制台页面；页面是磁盘上的普通文件，改页面刷新即生效，改 `lib/` 需重启 DSH。

页面是 V7 界面稿（`html-panel-designs/v7-butler-console.html`）的落地版：

- **左栏**：品牌「大管家」+ 五项导航（大管家 / 任务 / 集群 / 记忆 / 设置）+ 本机与链路状态；
- **中栏**：按导航切换五页。大管家页是 DSH 风格对话区（对话 / 轨迹两个 tab，**明确标注「示例对话 · 静态演示」**），
  composer 行挂真实快捷动作；任务 / 集群 / 记忆 / 设置四页读真实数据；
- **右栏**：**派活层级 T0 → T1 → T2 → T3**，层级优先、设备只做节点标签；数据来自真实活会话与
  子代理血缘（新路由 `GET api/tiers`），取不到时标「降级」并给原因，不编节点。

视觉 token 取自本机 DSH 安装包 `app.asar` 的深色主题（`design-platform.css` / `base.css` /
`ConversationRoot.module.css` / `InputBar.module.css` 等），当前项高亮用 DSH 侧栏真实灰底
`rgb(67,69,74)`，不用绿色。页面零外链、单文件（内联 CSS/JS）。

> 运行中的 DSH 未重启（本轮红线）：**页面**刷新即为新版；**侧栏改名与 `api/tiers` 路由**要重启 DSH 后
> 才出现。重启前右栏会显示「降级：api/tiers 路由尚未加载（HTTP 404）：新版 Host 需重启 DSH 后生效」，
> 这是如实降级，不是故障。

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
| `GET /dsh-html-panel/api/board` | 共享板（`dsh-team-mesh` HTTP 服务，`x-team-token` 只在请求头）任务 / 事件 / 健康；未配置/不可达/坏响应都是结构化 JSON | 任务页、看板按钮、报告动作 |
| `GET /dsh-html-panel/api/host` | `node:os` + `fs.statfs` 的本机内存 / CPU / 磁盘（零外部依赖） | 设置页、composer 状态条 |
| **`GET /dsh-html-panel/api/tiers`（0.4.0 新增）** | 派活层级快照，见下节 | 右栏派活层级 |
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
      "device": "pc-ky614", "title": "主控会话", "status": "run", "startedAt": "…" },
    { "id": "server:session-…", "parentId": "pc-ky614", "tier": 1, "kind": "session",
      "device": "server", "title": "查看本机SSH公钥", "status": "idle", "startedAt": null },
    { "id": "session-…", "parentId": "session-…", "tier": 2, "kind": "subagent",
      "device": "pc-ky614", "title": "层级交互", "status": "idle", "startedAt": "…" }
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
- **任务页**：共享板最近 20 任务 / 12 事件（五态徽标 + 证据数 + 相对时间 + 可展开详情）；待办仍在
  `localStorage`（`dsh-workbench-todos-b`）。
- **集群页**：inline SVG 拓扑（4 槽位 + 5 条边 + 待接入空心圆）+ 设备/链路列表（`origin` 已脱敏）。
- **记忆页**：真探测按钮 + 探测结果（origin / 延迟 / 原因）。
- **设置页**：插件版本、四条只读路由、写动作路由、当前数据源（板 / 链路 / 层级 / 本机）、回滚说明与红线。
- **轮询**：cluster/board/host 每 30 s，tiers 每 15 s；`document.hidden` 时跳过；**轮询失败保留上一次好数据**，
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
**整包回滚 0.3.0**：把 `node_modules\dsh-html-panel` 换回 0.3.0 备份（或源目录 `git`/备份目录）后重启 DSH。

---

## 文件布局

```
lib/index.js      Host 半：路由注册（prefix 文件 + 四条 api GET + api/action POST）
lib/tiers.js      0.4.0：派活层级组装 + 4s 缓存/单飞 + 降级（纯函数，可单测）
lib/cluster.js    api/cluster：interconnect 链路快照
lib/board.js      api/board：共享板读取（token 只进请求头，3s 缓存）
lib/boardmap.js   板数据 → 页面字段（与离线工具同一份实现）
lib/host.js       api/host：本机 os/statfs
lib/actions.js    api/action：白名单动作（报告 / 记忆探测 / 打开目录）
lib/client.js     浏览器半：侧栏行（label=大管家）+ iframe 面板 + 动作消息桥
public/index.html 单文件页面（内联 CSS/JS，零外链）
locale/*.json     插件标题/描述（大管家 / Butler Console）
icon.svg          插件图标
tools/            单测（actions/board/cluster/client-actions/tiers/mesh-snapshot）、
                  check-page 静态自检、cdp-butler 运行时自检、verify-copies、live-check、截图与报告
```

`public/index.v1-team-board.html`、`index.v3-cluster-overview.html`、`index.placeholder.html` 是历史版本/占位页，
保留作回滚素材，不被路由默认加载。

---

## 测试与验收（0.4.0，本机 Windows / Node 24.19.0 / 无头 Edge + CDP）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| A1 | `node --test "tools/*.test.mjs"` | **75 / 75 pass**（0.3.0 的 54 条基线全过 + 新增 tiers 21 条） | 终端输出 |
| A2 | `node tools/check-page.mjs --json tools/shots/check-page.json` | **139 / 139 PASS** | `tools/shots/check-page.json` |
| A3 | `node tools/cdp-butler.mjs` | **81 / 81 PASS**，13 张截图，页面 JS 报错 0；场景：real / degraded / tiers404 / mock | `tools/shots/cdp-butler-report.json`、`tools/shots/shot-butler-*.png` |
| A4 | `node tools/verify-copies.mjs --sync` | 两份副本逐文件 sha256 全等（源 ↔ `node_modules/dsh-html-panel`） | `tools/shots/copy-verify.json` |
| A5 | `node tools/live-check.mjs` | 运行中 DSH 返回的页面 sha256 == 源文件（热更新）；`api/tiers` 重启前 404 | `tools/shots/live-check.json` |

`tiers.test.mjs` 覆盖：T0 根、本机 T1、`origin/parentSession` 的真实 T2/T3 链、tier 递推与封顶、孤儿
子代理、节点/远端行上限、状态与标题映射、远端 up/down/undefined/拒绝/超时降级、缺服务仍给 T0、4 s 缓存
与单飞、路由 GET/HEAD/405/降级仍 200 与契约字段。全部用 stub，不需要起 DSH 或真的 interconnect。

CDP 断言（摘要）：五页导航切换与各自真实渲染（任务 6 / 事件 8 / 板 badge、拓扑 4 节点 + 待接入、设置页
版本与数据源）、右栏 13 节点与计数 `1/4/6/2`、设备标签 `pc-ky614/server/mcloud`、T1 折叠与恢复、点 T2
高亮 `T0→…` 上级路径并可取消、动作四态（报告成功 / 新会话独立打开时如实「暂不支持」/ 记忆探测成功）、
报告预览内容、900 无横向溢出与抽屉开合、降级只渲染 T0、404 文案含「重启」、接口全挂时 MOCK 兜底标注。

**未验证 / 已知限制（如实列出，不当作成功）**：

1. **运行中 DSH 未重启**：`api/tiers` 目前 404、侧栏 label 仍是旧值——两件都要重启 DSH 才生效；
   页面文件已热更新（`tools/live-check.mjs` 实测）。重启前页面按「降级：需重启」如实显示。
2. **真实 Host 上的 `api/tiers` 没有被运行中实例执行过**（不能重启）。它的组装逻辑由 21 条单测覆盖，
   页面用 fixture 走通；重启后第一次刷新即可看到真实层级。
3. **只列活会话**：已结束的会话 / 子代理不会出现（SessionStore 只存活会话，agents 注册表同理）；
   这是产品口径，页面空态有说明。
4. **远端子代理层级不可见**：`interconnect.list()` 契约本身只列顶层活会话，远端 T2/T3 拿不到；
   有远端 T1 时页面标「降级」说明这个缺口。要做需要扩展 interconnect 或 Host 侧另一条只读通道。
5. **未在真实 DSH GUI 的侧栏 iframe 里截图/点击**（不重启、不动 GUI）：CDP 用同源 fixture 加载真实页面文件；
   `panel-action` 协议与 `lib/client.js` 的契约由 `tools/client-actions.test.mjs`（vm 沙箱跑真实 `client.js`）覆盖。
6. 页面对 900 / 1440 两档做了断言；1200–1440 之间是同一套 flex + 断点，未逐档截图。

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
- 本页所有外部文本（任务、事件、会话标题、实例名）渲染前都过 `esc()`；回执/报告用 `textContent` 或
  DOM 构建，不拼 HTML。
