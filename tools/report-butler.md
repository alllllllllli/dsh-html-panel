# 「大管家」0.4.0 落地报告 —— V7 界面稿进 dsh-html-panel + 右栏真实派活层级

> **结论**：`dsh-html-panel` 已从 0.3.0 升到 **0.4.0**：侧栏入口改名为「大管家」，页面按已定稿 V7
> 重写成三栏 / 五页，右栏 T0–T3 派活层级接**真实数据**（新增只读路由 `GET api/tiers`，数据来自 Host 的
> 活会话 + 子代理血缘 + `interconnect.list()`）；0.3.0 的四条路由、六个真实动作、四态回执、待办等能力
> 全部保留。单测 **75/75**、静态自检 **139/139**、CDP 运行时 **81/81**（13 张截图、页面 JS 报错 0）、
> 两份副本 **72 个文件 sha256 全等**。全程**未重启 / 未 kill DSH、未跑 pnpm、未改 profile 配置、未改 mesh
> 插件、未碰 git/GitHub、未输出任何密钥**。
>
> 因为没重启：**页面已热更新生效**（运行中 DSH 返回的 `index.html` sha256 == 源文件），而**侧栏改名与
> `api/tiers` 路由要重启 DSH 后才有**；重启前页面右栏如实显示「降级：api/tiers 路由尚未加载（HTTP 404）：
> 新版 Host 需重启 DSH 后生效」。这不是失败，是明确的中间态。

- 交付日期：2026-11-21
- 页面：`public/index.html`（156,626 B，sha256 `94d080e87b83f6440b47dfaadce37ee4f54e428ed9ef95e554ae468a42d34ee4`）
- 版本：`package.json` `0.3.0 → 0.4.0`
- 运行中 DSH：`http://127.0.0.1:53499`（**未重启**，只做只读 GET）

---

## 1. 交付物

| 项 | 路径 | 说明 |
|---|---|---|
| 页面 | `public/index.html` | 单文件、内联 CSS/JS、零外链；V7 三栏 + 五页导航 + 右栏 T0–T3 |
| 宿主层 | `lib/tiers.js`（新增，19,619 B） | 层级组装纯函数 + 4 s 缓存/单飞 + 结构降级 |
| 宿主层 | `lib/index.js` | 注册 `GET api/tiers`，创建 tiers reader（懒取 `sessions`/`agents`/`sessionProjections`） |
| 浏览器半 | `lib/client.js` | 侧栏 label「大管家」、iframe title、控制台图标；`PANEL_ID`/路由前缀不变 |
| 改名 | `locale/zh.json`、`locale/en.json`、`package.json`、`icon.svg` | 大管家 / Butler Console |
| 单测 | `tools/tiers.test.mjs`（新增，21 条） | 层级/状态/远端/降级/缓存/单飞/路由 |
| 静态自检 | `tools/check-page.mjs`（重写，139 项） | 零外链、四条路由、五页、示例 badge、层级元素、动作四态… |
| 运行时自检 | `tools/cdp-butler.mjs`（新增，81 断言） | 无头 Edge + CDP；real / degraded / tiers404 / mock 四场景 |
| 副本校验 | `tools/verify-copies.mjs`（新增） | 源 ↔ 已装副本逐文件 sha256，`--sync` 可镜像 |
| 活体冒烟 | `tools/live-check.mjs`（新增） | 运行中 DSH 页面热更新与四条路由状态的只读记录 |
| 证据 | `tools/shots/check-page.json`、`cdp-butler-report.json`、`copy-verify.json`、`live-check.json`、`shot-butler-01..13.png` | 机器可读 + 截图 |
| 文档 | `README.md`（重写）、本报告 | 契约 / 数据来源 / 降级 / 安装回滚 / 验收 |

页面构建方式（透明说明）：以定稿 `html-panel-designs/v7-butler-console.html` 为基准，用一次性拼接脚本把
新增 CSS、左/中/右栏结构与整段页面 JS 替换进去；**拼接脚本留在临时目录、不随包交付**，交付物就是最终
`public/index.html` 本身（后续直接编辑该文件即可）。

---

## 2. 改了什么

### 2.1 改名「大管家」

- `lib/client.js`：`sidebar.panellist` 的 `label` 从 `HTML 面板` → **`大管家`**；图标换成「控制台提示符」内联 SVG；
  iframe `title` → `大管家 · DSH 控制台`。`PANEL_ID` 仍是 `dsh-html-panel`、路由前缀不变（不搬 panel key、不搬 URL）。
- `locale/zh.json` → `{ title: "大管家", description: "…五页导航 / 实时数据 / T0–T3 派活层级" }`；
  `locale/en.json` → `Butler Console`。
- 页面 `<title>` → `大管家 · DSH 控制台`；README 标题/描述、`package.json` `description` 同步；版本 → `0.4.0`。
- 注意：**浏览器半在 DSH 启动时打包**，所以侧栏「大管家」三个字要重启后才显示；页面本身刷新即新。

### 2.2 页面换成 V7 结构（能力零回归）

- 左栏：品牌「大管家 / BUTLER CONSOLE」+ 5 项导航（大管家 / 任务 / 集群 / 记忆 / 设置）+ 真实页脚
  （本机在线 · `pc-ky614` · `4 台设备 · 1 条链路 up`，来自 `api/cluster`；不写死「链路正常」）。
- 中栏五页：
  - **大管家**：DSH 风格头部（真实设备/任务统计）+ 对话/轨迹 tab + **明确标注「示例对话 · 静态演示
    （不是真实聊天…）」**的静态会话区 + composer。composer 上方「快捷动作」行的 5 个按钮是真调用；报告
    预览面板、动作回执（四态）也在这一页；输入框与发送按钮明确是示例（不可发送）。
  - **任务**：共享板 20 任务 / 12 事件、五态徽标、证据数/节点/相对时间、可展开详情、待办 localStorage。
  - **集群**：V6 拓扑（4 槽位 + 5 条边 + 待接入空心圆）+ 设备/链路列表（origin 已脱敏）。
  - **记忆**：OpenViking 真探测（走 `POST api/action probe-memory`）并显示可达/不可达原因。
  - **设置**：插件版本 0.4.0、四条只读路由、写动作路由、当前数据源（板/链路/层级/本机）、回滚说明、重启禁用红线。
- 右栏：V7 派活层级（T0–T3 chip、状态点、层级缩进/连线、折叠、点节点高亮上级路径、tooltip、900 抽屉），
  数据源换成 `api/tiers`；`degraded` 时头部显示琥珀色「降级」badge，脚注写缺口原因；只渲染 T0、不编节点。
- 视觉：V7 的 CSS token 原样沿用（`--bg-base:rgb(21,21,23)`、`--sidebar-active:rgb(67,69,74)`、
  `--accent:rgb(122,170,255)`、`--chat-w:clamp(680px,64%,920px)` 等），当前导航项是 DSH 真实灰底，不是绿色。
- 900/≤1200：右栏收抽屉，实测无横向溢出；`prefers-reduced-motion` 降级动画。
- 保留 0.3.0 的数据状态机：首次失败落 MOCK 并标「mock 兜底 · 原因」；轮询失败保留旧数据只出「数据过期」横幅。

### 2.3 新增只读路由 `GET api/tiers`

- 组装在 `lib/tiers.js`（纯函数 + reader），路由在 `lib/index.js`：
  - `GET|HEAD` 200 JSON；其它方法 405 JSON + `Allow`；
  - 4 s 进程内缓存（`TIERS_CACHE_MS`），并发单飞；命中带 `source.cached/ageMs`；
  - 多个对端**并行** `interconnect.list()`，单个上限 2 s（`TIERS_TIMEOUT_MS`）；
  - 任何失败都结构化进 `degraded.reason`，接口始终 200（组装层意外异常另有 `fallbackTiers` 兜底）。
- 宿主侧懒取服务：`ctx.get('sessions' | 'agents' | 'sessionProjections')`，缺任何一个都不影响其它源；
  `ctx.interconnect` 沿用 0.3.0 的惰性读取。
- 契约、字段规则、降级矩阵详见 `README.md` 的「`api/tiers` 契约」与「降级原因对照」两节。

---

## 3. tiers 研究结论（先研究，再实现）

### 3.1 方法

- 用一次性、零依赖的最小 asar 读取器（临时脚本，**只读**）从
  `D:\Tools\DeepSeekHarness-Desktop\resources\app.asar` 抽取了 6 个相关包的 `src/`（不改安装目录、
  不 `npm i`、不落盘到安装目录），据此确认 Host 侧真实可用服务与方法签名；
- 同时用本机运行中 DSH 的 model-facing `interconnect_*` 工具（只读）实探 `server` 的活会话列表作为线上证据；
- 结论全部落到 `lib/tiers.js` 的实现与单测里，没有靠猜字段名。

### 3.2 关键证据（asar 内路径为相对 `dsh/node_modules/`）

| 事实 | 证据 |
|---|---|
| Host 服务名 **`sessions`**（`SessionStore`）；`list()` 返回 **live sessions、创建顺序**；`get(id)` 取活会话 | `@deepseek-ai/dsh-session/src/index.ts`：`super(ctx,'sessions')` L1172、`get()` L1455、`list()` L1463 注释 “All live sessions, in creation order.” |
| `Session.header` 是**不可变**元数据：`origin?: 'subagent'`、`parentSession?: SessionId`、`createdAt`、`delegationDepth`、`agentPreset` | 同包 `src/types.ts` `SessionHeader` L95–136（注释明确：`origin` 才是子代理判定，`parentSession` 是直接创建者） |
| Host 服务名 **`agents`**（`AgentRegistry`）；`list()` 给活 agent；`agent.id === session.id`、`agent.status: 'idle'|'running'` | `@deepseek-ai/dsh-agent/src/index.ts` `super(ctx,'agents')` L260、`list()` L588；`src/runtime-types.ts` L136/L200–201 |
| 标题来自 **`sessionProjections`** 服务：`snapshot(session).values.title`（best-effort，含投影缺失时为空） | `@deepseek-ai/dsh-session-projection/src/index.ts` `super(ctx,'sessionProjections')` L296、`snapshot()` L514–527 |
| `interconnect.list(instanceId)` 契约：返回 `{sessions:[{sessionId,title?,status?}], instance}`，`undefined` = 链路失败；**只列非 subagent 的活会话**（实现里 `isSessionOwnedBySubagent` 过滤）；标题同样取 `sessionProjections`，状态取 `agent.status` | 本机已装 `dsh-interconnect@0.15.0`：`lib/types/interconnect/index.d.ts`（`list()` 声明、`InterconnectSessionSummary`、`ListResult`）与 `lib/interconnect/index.js`（`listSessions()` / `sessionRow()` / `isSessionOwnedBySubagent()`） |
| 线上实证：`server` 有 3 个活会话（`session-62cc…`「查看本机SSH公钥」idle 等） | 本机 DSH `interconnect_list('server')` 只读返回 |

### 3.3 结论（口径：层级优先、设备只做标签）

- **T1** = `ctx.sessions.list()` 里 `header.origin !== 'subagent'` 的活会话（本机）**平级** +
  `interconnect.list()` 返回的各设备活会话；`device` 只是节点标签。
- **T2/T3** = `header.origin === 'subagent'` 的活会话按 `header.parentSession` 挂到父节点，tier 沿父链
  `+1` 递推（封顶 8）；孤儿子代理（父已不在活会话）挂 T1 并在 `degraded` 说明。
- **状态**：`agents.list()` 的 `running/idle` → `run/idle`；远端行 `status` 同映射；未知落 `idle`。
- **不接受"看起来能"的替代**：没有把 `delegationDepth` 直接当 tier（它可能缺）、没有把普通 fork 的
  `parentSession` 当子代理（`origin` 才作数）、没有为拿层级去扫描会话日志目录。

---

## 4. 测试与证据

### 4.1 数字

| 命令 | 结果 | 证据 |
|---|---|---|
| `node --test "tools/*.test.mjs"` | **75 tests / 75 pass**（0.3.0 的 54 条基线 + 新增 tiers 21 条） | 终端输出；`tools/tiers.test.mjs` |
| `node tools/check-page.mjs --json tools/shots/check-page.json` | **139/139 PASS** | `tools/shots/check-page.json`（sha256 与页面一致） |
| `node tools/cdp-butler.mjs` | **81/81 PASS**，13 张截图，页面 JS 报错 **0**，CDP 运行时异常 **0** | `tools/shots/cdp-butler-report.json` |
| `node tools/verify-copies.mjs --sync` | 比较 **71 个交付文件**（报告自身不参与自哈希、写完后同步），`mismatched=0 / missing=0 / extra=0` → IDENTICAL | `tools/shots/copy-verify.json` |
| `node tools/live-check.mjs` | 运行中 DSH 页面 sha256 == 源文件（热更新 YES）；`api/tiers` → 404（未重启，符合预期） | `tools/shots/live-check.json` |

单测里的 tiers 用例（21 条）覆盖：T0 根、本机 T1、`origin/parentSession` 的 T2/T3 真实链、tier 递推与
`MAX_TIER` 封顶、孤儿挂 T1、节点/远端行上限、状态与标题映射、远端 `up` 才问 / `down` 不问 /
`undefined` / 拒绝 / 超时三态降级、缺 sessions / 缺 interconnect 仍给 T0、4 s 缓存命中与过期、
并发单飞、`fallbackTiers`、路由 GET/HEAD/405/全缺仍 200 与字段契约。全部 stub，不启动 DSH。

CDP 场景：

| 场景 | 断言要点 | 截图 |
|---|---|---|
| `real` | 五页导航切换与真实渲染（任务 6 / 事件 8 / 板 badge 真实；拓扑 4 节点 + 待接入 + 设备/链路列表；设置页 0.4.0 与真实数据源；记忆页探测成功）；右栏 13 节点、计数 `1/4/6/2`、设备标签 `pc-ky614/server/mcloud`、降级 badge；T1 折叠/恢复；点 T2 高亮 `T0→…` 上级路径再取消；动作四态（报告成功 / 新会话独立打开时如实「暂不支持」/ 记忆探测成功）；报告预览内容 | 01–08 |
| `degraded` | tiers 返回 T0 + degraded：只渲染 1 个节点、降级 badge、原因写进 title | 11 |
| `tiers404` | 页面把 404 解释成「需重启 DSH」：只渲染 T0、提示含 `404` 与 `重启` | 12 |
| `mock` | 四条接口全 500：cluster/board/host 回落 MOCK 且 badge/文案明确「mock 兜底」，层级降级但仍给 T0 | 13 |
| 900px | 无横向溢出、右栏默认在屏外、抽屉按钮可见、点开后进入可视区、关闭恢复 | 09–10 |

### 4.2 截图（`tools/shots/`，均 1440×1000 或 900×1000）

| 文件 | 内容 |
|---|---|
| `shot-butler-01-dashboard-1440.png` | 大管家页：五页导航 + 示例对话（badge）+ composer 快捷动作 + 右栏真实 T0–T3 |
| `shot-butler-02-tasks-1440.png` | 任务页：事件流（8 条）+ 任务/事件 tab + 待办 |
| `shot-butler-03-cluster-1440.png` | 集群页：真实拓扑 + 待接入空心圆 + 设备/链路列表 |
| `shot-butler-04-memory-1440.png` | 记忆页：真探测成功（origin / 延迟） |
| `shot-butler-05-settings-1440.png` | 设置页：版本 / 路由 / 数据源 / 回滚说明（只读） |
| `shot-butler-06-action-report-1440.png` | 动作：最新报告成功 + `#reportPanel` 内容 |
| `shot-butler-07-action-unsupported-1440.png` | 动作：独立打开时新会话如实「暂不支持」 |
| `shot-butler-08-tiers-selected-1440.png` | 右栏：点 T2 高亮 `T0→T1→T2` 整条上级路径、其余节点压暗 |
| `shot-butler-09-narrow-900.png` | 900 窄屏：右栏收起、tab 行右侧「派活层级」按钮、无横向溢出 |
| `shot-butler-10-narrow-900-drawer.png` | 900 抽屉展开（带遮罩） |
| `shot-butler-11-tiers-degraded-1440.png` | tiers 降级：只渲染 T0 + 空态 + 降级 badge + 原因 |
| `shot-butler-12-tiers-404-1440.png` | tiers 404：页面写「需重启 DSH 后生效」，仍渲染 T0 |
| `shot-butler-13-mock-fallback-1440.png` | 接口全挂：MOCK 兜底并明确标注，拓扑/任务照常可看 |

截图由 `tools/cdp-butler.mjs` 用无头 Edge + CDP（Node 内置 WebSocket，零依赖）生成；same-origin fixture
提供真实形状数据，页面文件就是 `public/index.html` 本体。

### 4.3 两份副本

`node tools/verify-copies.mjs --sync` 把源目录镜像到
`%DSH_PROFILE_DIR%\node_modules\dsh-html-panel`（默认 `~/.dsh/profiles/desktop`），逐文件 sha256 比较：
**71 个交付文件全部一致**（`mismatched=0`、`missing=0`、`extra=0`）。`copy-verify.json` 是报告自身
（`generatedAt` 每次运行都会变），不参与自哈希；脚本在写完后把它也同步到副本，所以两份副本在静止
状态下共 **72 个文件**内容一致（仅报告自身的时间戳随运行更新）。明细在 `tools/shots/copy-verify.json`。

### 4.4 运行中 DSH 只读冒烟（未重启）

`tools/live-check.mjs`（只读 GET，不改任何东西）：

- `GET /dsh-html-panel/index.html` → **200 / 156,626 B / sha256 `94d080e8…`**，与源文件**完全相等** →
  页面已热更新；
- `GET api/cluster` → 200（旧 Host 路由仍在，371 B）；
- `GET api/board` → 200（27,549 B；共享板在线）；
- `GET api/host` → 200（482 B）；
- `GET api/tiers` → **404**（预期：新增路由要重启 DSH 才加载；页面会如实显示降级）。

---

## 5. 未做到 / 缺口 / 建议（如实）

1. **没重启 DSH（红线）**：侧栏「大管家」改名与 `api/tiers` 新路由**没有在运行中的实例里生效过**。
   页面已热更新，重启前右栏按「降级：需重启」显示。**建议**：下次重启后跑一次
   `node tools/live-check.mjs`，应看到 `api/tiers → 200`、侧栏显示「大管家」。
2. **真实 Host 上的 `api/tiers` 没有被运行中实例执行**：组装逻辑由 21 条单测 + fixture 页面测试覆盖，
   重启后第一次刷新即可验证真层级；这是本轮唯一没能"亲眼看"的真实数据路径。
3. **只列活会话**：`sessions.list()` / `agents.list()` 只有活对象，**已结束的会话与子代理不会出现**。
   这是活控台的产品口径（页面空态写明「暂无活子代理」），但也意味着"已完成"节点在实际运行中很少见。
4. **远端子代理层级不可见**：`interconnect.list()` 契约本身过滤了子代理会话，远端只有 T1；有远端 T1 时
   页面标「降级」说明缺口。要做需要扩展 interconnect 的 list 契约（加子代理父子行）或另开只读通道——
   本轮明确不改 mesh / interconnect 配置，故不做。
5. **升级路径（已评估未实现）**：若要展示已结束子代理，`ctx.subagents.listDescendants(rootSessionId)` +
   `sessionQuery`/`subagentCatalog` 投影可给出 `parentId/depth` 与已完成节点；代价是逐会话异步读日志，
   需把 tiers 预算从 2 s 放到 8 s 档、并在无 `sessionQuery` 时降级。字段形状已兼容，建议作为 0.5.0 选项。
6. **未在真实 DSH GUI 的侧栏 iframe 里点击/截图**（不重启、不动 GUI）：页面用同源 fixture 加载真实文件，
   `panel-action` 协议由 `tools/client-actions.test.mjs` 在 vm 沙箱跑**真实 `lib/client.js`** 覆盖。
7. 只对 **1440 / 900** 两档做了截图与断言；1200–1440 之间是同一套 flex + 断点，未逐档验证。

---

## 6. 红线遵守

- 未重启、未 kill、未接管 DSH 进程；未执行 `pnpm`；未改 profile 的 `cordis.yml` / `cordis.patch.yml` /
  board 配置 / interconnect 配置；未改 `dsh-team-mesh` 或其它插件；未执行 git、未推 GitHub。
- 安装目录（`D:\Tools\DeepSeekHarness-Desktop`）**只读**：asar 仅用临时脚本读取，未解包进安装目录。
- 全程未打印任何 token / 密钥：board token 只存在 Host 请求头，页面与报告、截图里都没有。
- 页面零外链（无 `http(s)://`、无 `<link>`/外链脚本/图片/字体/XHR/WebSocket），`href` 只有站内锚点与 SVG `<use>`。
- 中栏示例数据全部标注「示例对话 / 示例轨迹 · 静态演示」；mock 兜底也明确标注；不存在伪造成功或伪造层级。
