# 常用动作真实化 · 研究报告（dsh-html-panel 0.2.0 → 0.3.0）

日期：2026-11-21 · 本机：DESKTOP-OR1HA06（Windows 11）· Node 24.19.0 · DSH 桌面端 0.2.2-rc.5
约束：未重启 / 未 kill 运行中的 DSH（`http://127.0.0.1:51539`）；未跑 pnpm；未改 DSH 安装目录（app.asar 只解包到临时目录）；未改 profile 配置；未碰 git。

## 1. 研究：能力边界从哪来

DSH 安装包 `D:\Tools\DeepSeekHarness-Desktop\resources\app.asar` 用 `@electron/asar`
解包到临时目录（`D:\<workspace>\_asar-panel-research\asar`，209,083,008 B），
以下结论都能在解包后的源码里复核：

| 问题 | 结论 | 证据（解包内路径） |
|---|---|---|
| 有没有「新建会话 / 切工作区」的客户端 API？ | **有。** 浏览器半可 `ctx.get('uiWorkspace')`，调 `startSession(workspaceId?, options?)` 或 `connectWorkspace(...)`。DSH 自己的「新会话」快捷键就是同一入口：`session.new` 快捷键 resolve 到 `navigation.startSession()`。第三方面板里的真实先例：`dsh-client-ui-entry-customization` 用 `inject: ['slots','locale','uiWorkspace']` 后调 `ctx.uiWorkspace.startSession(void 0, {agentPreset:'cordis', prompt, whenDraftExists:'append'})` 来「新建会话并预填提示」。 | `@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts`（`UiWorkspace.startSession` / `replaceMain` / `layout.selectPanel`）、`.../shortcuts.ts`（`register('session.new', …, () => ({status:'handled', run: () => navigation.startSession()}))`）、`@deepseek-ai/dsh-client-ui-entry-customization/lib/client.js`（`const inject=[\`slots\`,\`locale\`,\`uiWorkspace\`]` … `ctx.uiWorkspace.startSession(void 0,{agentPreset:\`cordis\`,prompt:t(...),whenDraftExists:\`append\`})`） |
| 客户端能用的服务清单？ | `layout`（`selectPanel(panelId)` / `beginNavigation()` / `toggleSidebar()`）、`sessions`（`create/fork/retain/…`）、`uiWorkspace`、`workspaces`、`slots`、`locale`、`theme`、`timer`。生成式目录 `SERVICE_API` 里有完整签名。 | `@deepseek-ai/dsh-cordis-client-runner/src/client/api-catalog.ts`（`key: 'layout' | 'locale' | 'sessions' | 'slots' | 'theme' | 'timer' | 'uiWorkspace' | 'workspaces'`） |
| 有没有「打开/切换面板、聚焦某个视图」的 API，「打开看板」能改成 DSH 内面板吗？ | 有 `ctx.layout.selectPanel(panelId)`，但**没有任务看板面板**：内建 main key 只有 `conversation`；自带 main 面板的插件只有 `plugins`（插件管理页）和 `schedules`（定时页）。`dsh-team-mesh` **没有浏览器半**（package.json 无 `dsh.client`），板服务 `server.js` 只回 JSON（无 `text/html`）。所以「打开看板」只能打开外部真实地址，不能切到 DSH 内面板。 | `dsh-client-ui-plugin-manager/lib/client.js`（`PANEL_ID=\`plugins\`` … `ctx.layout.selectPanel(PANEL_ID)`）、`dsh-client-ui-schedule`（`PANEL_ID=\`schedules\``）、`dsh-team-mesh/package.json`（无 `dsh.client` 段）、`dsh-team-mesh/src/server.js`（路由表只有 `/health`、`/task/*`、`/events`、`/blob/*`，`content-type` 只有 `application/json` / `application/octet-stream`） |
| Host 侧能不能安全做 OS 动作？ | **能。** Host 半是普通 Node 代码，可 `child_process.spawn('explorer.exe', [固定目录])`；但没有现成的「安全动作」API，得自己加一条受控路由。**关键坑**：`webServer` 的 `resource` 路由只接 GET/HEAD（`RESOURCE_METHODS='GET, HEAD'`，其它方法在进业务代码前就是 405），要 POST 必须注册**exact raw handler**（`WebRoute.handler(req,res)`，自管完整响应）。`match()` 里 exact 优先于 prefix，所以可以在同一个 `/dsh-html-panel` 前缀下再加一条精确 `/dsh-html-panel/api/action`。 | `@deepseek-ai/dsh-host-webserver/src/index.ts`（L291 `const RESOURCE_METHODS = 'GET, HEAD'`、`serveResource()` 405 分支、`WebRoute.handler` 定义、`match()`：exact table 先于 longest-prefix） |
| Host 能不能调 `mesh_*` 工具来「派发任务」？ | **不能安全调。** 工具注册表是 agent 作用域（`ScopeKey`；`executable(name, scope, toolSet)` 需要 agent 的 step 视图），插件 Host 上下文没有「按名字执行工具」的公开入口；`mesh_dispatch` 还要求任务卡 + 目标会话。硬调 `definition.execute()` 绕过了 guard/审批/执行身份，属于不安全做法。→ 「派发任务」如实标暂不支持，给真实的「新会话 + 预填 mesh_dispatch 提示草稿」替代。 | `@deepseek-ai/dsh-tools/src/index.ts`（`view(scope)` / `executable(name, scope, toolSet)` / `resolve({agent, signal})`；无插件级 execute API） |
| 记忆检索（OpenViking）网页可达吗？ | **可达。** mcloud 现地址 `http://172.24.112.11:1933/` → 200，`<title>OpenViking Studio</title>`；`/health` → 200 JSON。旧地址 `10.26.0.4:1933` 已不通。 | 本机实测：`Invoke-WebRequest http://172.24.112.11:1933/` → `200 2682 bytes CT=text/html; charset=utf-8 title=OpenViking Studio`；TCP 探测 `172.24.112.11:1933=True`、`10.26.0.4:1933=False` |
| 报告目录在哪？ | `%USERPROFILE%\mesh-0.6-dev\repo\docs` 真实存在（17 个文件，最新 `.md` = `0.4.0-跨端验证与安装排障-20261121.md`，mtime 2026-11-21 09:26）。`mesh-0.5-dev/repo/docs` 也存在。 | 本机实测 `Get-ChildItem $env:USERPROFILE\mesh-0.6-dev\repo\docs` |
| 运行中的 DSH 能否立刻吃到页面改动？ | **页面能，Host/client 不能。** 页面由本插件 Host 路由每次请求读盘（`cache-control: no-store`），实测运行中 DSH 返回的新页面 sha256 与源文件完全一致；而 Host 路由要重启才注册，浏览器半的 client bundle 由 `dsh-client-modules` 在启动时打包成不可变批次（`IMMUTABLE_CACHE`、`this.responses`），也要重启。 | `lib/index.js` `servePublic()`（`readFile` per request + `no-store`）；`@deepseek-ai/dsh-client-modules/src/index.ts`（`bundleResource()` 用启动时构建的 `responses`，`cache-control: IMMUTABLE_CACHE`） |

## 2. 动作映射（最终实现）

| # | 按钮 | 真实执行路径 | 做不到时的回执 | 依据 |
|---|---|---|---|---|
| 1 | 新会话（Ctrl+Alt+N） | 页面 `postMessage({type:'panel-action',action:'new-session',requestId})` → `lib/client.js` 白名单校验 → `ctx.get('uiWorkspace').startSession()`（与快捷键同一个 API，无参数，用宿主默认工作区/预设） | 无 `uiWorkspace` 服务 →「暂不支持：当前 DSH 客户端没有提供 uiWorkspace.startSession…请用 Ctrl+Alt+N」；client bundle 未更新（2.5s 无响应）→「暂不支持：DSH 客户端 2.5 秒内没响应动作（client.js 改动需重启 DSH 后生效）」 | `shortcuts.ts` 的 `session.new` + `navigation.ts` 的 `startSession` |
| 2 | 派发任务 | **不伪造。** 直接回「暂不支持：面板不能直接调用 mesh_* 任务工具…」，并给一个可点的二级动作「在新会话草稿里填入 mesh_dispatch 提示」→ 再走 `panel-action: dispatch-draft` → `startSession(undefined,{prompt, whenDraftExists:'append'})` 打开真实新会话并预填草稿（草稿不会自动发送） | 同上；直接派发永远不支持（设计如此，避免假派发） | `dsh-tools` 作用域模型 + `entry-customization` 的 `startSession(prompt)` 先例 |
| 3 | 打开看板 | 用页面已拿到的 `api/board` 的 `source.origin` 真实地址 `window.open(origin,'_blank')`；回执写明 origin，弹窗被拦时给可点链接 | 板未配置 →「暂不支持：共享板未配置…」；不可达 →「失败：共享板不可达：<api/board 结构化原因（如 timeout）>」；按钮**不再静默置灰**（点一下必有回执） | `api/board` 已有 `source.origin`；`dsh-team-mesh` 无 HTML 看板 |
| 4 | 查记忆 | 页面 `POST api/action {action:'probe-memory'}` → Host 真 GET `http://172.24.112.11:1933/`（1.5s 超时，redirect 不跟随）→ 可达时页面 `window.open(studioUrl)`；回执带 origin + 探测延迟 | 不可达/超时/HTTP 错 →「失败：OpenViking 不可达（origin）：连接被拒绝（ECONNREFUSED）/ 超时 / HTTP n」；老宿主无路由 →「暂不支持：宿主还没有 api/action 路由…需要重启 DSH」；失败**不打开新标签页** | 实测 1933 可达 + `Probe` 设计 |
| 5 | 读最新报告 | 页面 `POST api/action {action:'latest-report'}` → Host 在固定目录找最新 `*.md`（按 mtime，目录内解析并防逃逸）→ 读内容（64 KiB 上限，截断标记）→ 页面「最新报告」面板用 `textContent` 显示；回执带文件名/大小/更新时间 + 二级动作「在资源管理器中打开报告目录」（`open-reports-folder` → `spawn('explorer.exe',[固定目录])`，argv 数组、无 shell 字符串） | 目录不存在/无 .md/读失败 →「失败：报告目录不存在 / 没有 .md 文件 / 报告读取失败：name（code）」；老宿主 → 暂不支持 | 任务书建议的 `open-reports-folder` + 真实目录实测 |
| 6 | 重启 DSH | **永久 disabled**（红线）。描述/aria tooltip：「红线：不由面板重启 DSH」；`runRestart()` 仅作不可达兜底返回「暂不支持：红线…」 | — | 本轮红线 |

### 协议与安全边界

- 页面 → 浏览器半：`{type:'panel-action', action, requestId}`；`lib/client.js` 只在
  `event.source === 本面板 iframe.contentWindow` 时接受，动作白名单
  `['new-session','dispatch','dispatch-draft']`，回复
  `{type:'panel-action-result', requestId, action, at, ok, code?, reason?, detail?, hint?}`；
  页面按 `requestId` 配对，2.5s 无回复就如实报超时。**浏览器半不碰文件/进程。**
- 页面 → Host：只 `POST api/action`，`content-type: application/json`，body 只有
  `{"action":"<白名单 id>"}`。按序拒绝：非 POST → 405（`Allow: POST`）；`Origin` 存在但不是本
  Host → 403；非 JSON content-type → 415；body > 4 KiB → 413；JSON/对象非法 → 400；动作不在
  白名单 → 400。业务失败仍 200 + `{ok:false, code, reason}`；意外异常 → 通用 500，**不带
  stack / token / 回显路径**。不加 CORS 头。
- 路径/URL/程序全部服务端固定（`config.actions.memory.url`、`config.actions.reports.dir`
  或内置默认），报告文件解析后再次校验目录内；`explorer.exe` 用 argv 数组、从不拼 shell。
- 端点实现是 `kind:'exact'` 的 raw handler（不是 `resource`），否则 POST 会被 webserver
  在业务代码前转成 405。

## 3. 验证数字（本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| Host 动作单测 | `node --test tools/actions.test.mjs` | **14/14 pass** |
| 浏览器半单测（`node:vm` 加载真实 `lib/client.js`，不是副本） | `node --test tools/client-actions.test.mjs` | **8/8 pass** |
| 全量单测（含 board / cluster / mesh-snapshot 回归） | `node --test tools/board.test.mjs tools/cluster.test.mjs tools/mesh-snapshot.test.mjs tools/actions.test.mjs tools/client-actions.test.mjs` | **54/54 pass**（board 15、actions 14、client 8，其余回归） |
| 页面静态自检 | `node tools/check-page.mjs` | **116/116 pass**（新增：无「演示/未发送」、四态回执与 CSS、五个动作接线、同源 POST 形状、超时/老宿主失败文案、报告预览 id 与 `textContent` 渲染、重启禁用+红线） |
| 动作端到端（CDP，无头 Edge） | `node tools/cdp-actions.mjs` | **124/124 断言 pass，6 场景，页面 JS 报错 0**：独立页真实分支（看板开新标签页到真实 origin、查记忆开 Studio、报告内容来自宿主 fixture、二级目录动作、6 条回执）；板/OV/报告不可达分支（失败+原因、不弹窗、不静默）；老宿主 405 分支（暂不支持+需重启）；桩父窗口分支（新会话/派发任务/草稿替代走真实 `panel-action` 协议）；父窗口不回应分支（2.5s 诚实超时）；板未配置分支。 |
| 旧页面回归（CDP） | `node tools/cdp-live.mjs` | **253/253 断言 pass，7 场景，页面 JS 报错 0**（仅按新行为更新 3 处断言：看板按钮可点、回执文案、V4 回执等待） |
| 运行中 DSH 的页面热更新 | `GET http://127.0.0.1:51539/dsh-html-panel/index.html` | 改动前 **74,933 B / sha256 130870…98b** → 最终 **91,681 B / sha256 ba448f…7a7**，与源文件逐字节一致；页面无「演示」字样 |
| 运行中 DSH 的页面真跑（headless Edge 只读打开 `/dsh-html-panel/index.html`，未重启、未动 GUI） | `tools/shots/live-check.json` | 页面真实渲染（`api/cluster`/`api/board`/`api/host` 都来自运行中 DSH：board 源 `http://172.24.112.11:13090`、健康在线、20 任务/12 事件）；点「打开看板」→ **成功**并真的开了 `http://172.24.112.11:13090/` 新标签页；点「查记忆」「读最新报告」→ **暂不支持：「宿主还没有可用的 api/action 路由（HTTP 405）：新版 Host 需要重启 DSH 后生效」**（运行中的旧 Host 被 webserver 的 resource 405 拦住，页面如实回报）；点「新会话/派发任务」→ 独立页无父窗口 →「暂不支持：当前页面不在 DSH 面板 iframe 里」；页面 JS 报错 **0**，网络异常 **0** |
| 运行中 DSH 的新路由 | `GET http://127.0.0.1:51539/dsh-html-panel/api/action` | 仍 **404 `{"ok":false,"error":"not-found"}`**（GET）/ **405 空体**（POST）—— 旧 Host 半还在内存里，**新路由需重启 DSH 才注册**（本轮不许重启，如实记录） |
| 两处副本 | 源 `C:\Users\demo\dsh-plugins\dsh-html-panel` ↔ 已装 `…\.dsh\profiles\desktop\node_modules\dsh-html-panel` | 10 个改动文件 sha256 **全部相等**（见下表） |
| 版本 | `package.json` | `0.2.0` → **`0.3.0`**，`files` 增加 `lib/actions.js` |

两处副本 sha256（SAME = 源与已装副本逐字节相同）：

```
SAME a27aab99fba02f331950c951865e85e6c7db4b13c6a3527516c4e31fc49ccc54 lib/index.js
SAME dcf00ac586cc3fd9f1160bfc031ce3d20b470900582848eedfe3e084c9e0c1ea lib/client.js
SAME 97c8187ebb40fe3ae73bdc9e63d63946e98257ec6955fea05141b3e519985cec lib/actions.js
SAME aadb7c4a5db20bd7539ce6247c5b9fffc6165aac06a35617254d903aedfc6b02 lib/cluster.js
SAME 4db71d99ae5cb5b022d3f799d60a937ca0cfdb5b56ccc5f3634d86f806304b89 lib/board.js
SAME caaa1074b69a973fab2da4cf8aec86a6dbac411138fddac1d8aa5bcaf1d13177 lib/boardmap.js
SAME 0f6b7a4303497cd07faf3cbdae61160a9c6df3c458e5b5590ab3ac26887e3f2a lib/host.js
SAME ba448f024e566b9a2216879fb74504470e2f67a2f06a0e0439246d85cadcd7a7 public/index.html
SAME 3cfdb0e0d8edca6eee11d76ddc3b3ff6d29c0b135d46144e2573f5ad0fa587da README.md
SAME 953e97179d382115679d58afd38e6df12701d98844bd4a9c7926a1546a6f05f4 package.json
```

截图（`tools/shots/`，均由 CDP 实测截取）：

| 文件 | 内容 |
|---|---|
| `shot-actions-01-standalone-real.png` | 独立页：6 次真实动作后的回执（成功/失败/暂不支持并列）+ 报告预览面板 |
| `shot-actions-02-standalone-unreachable.png` | 共享板/OpenViking/报告目录都不可达时的失败回执（含原因，无假成功） |
| `shot-actions-03-old-host.png` | 老宿主（无 `api/action`）：「暂不支持 + 需重启 DSH」 |
| `shot-actions-04-harness-client.png` | 桩父窗口：`panel-action` 协议下的新会话成功、派发任务暂不支持 + 草稿替代 |
| `shot-actions-05-harness-silent.png` | 父窗口不回应：2.5 秒后诚实超时回执 |
| `shot-actions-06-board-unconfigured.png` | 板未配置：点击后「暂不支持：共享板未配置」 |
| `shot-actions-07-live-dsh-page.png` | 运行中 DSH（未重启）真实页面：真实集群/本机/板数据 + 5 条真实回执（看板成功、报告/记忆 405 需重启、新会话/派发需 iframe 宿主） |

机器可读日志：`tools/shots/cdp-actions-report.json`（124 断言明细）、
`tools/shots/cdp-report.json`（253 断言明细）、`tools/shots/check-page.json`（116 检查项）。

## 4. 未做到 / 需重启（如实记录）

1. **新 Host 路由 `POST /dsh-html-panel/api/action` 尚未在运行中的 DSH 生效**：需要重启
   DSH 才注册（本轮红线禁止重启）。重启前：宿主类动作（查记忆 / 读最新报告 / 打开报告目录）
   在真实面板里会回「暂不支持：宿主还没有 api/action 路由…需要重启 DSH 后生效」——这是诚实
   降级，不是失败伪装。
2. **新版 `lib/client.js` 尚未在运行中的 DSH 加载**：插件 client bundle 由 shell 启动时打包成
   不可变批次，也要重启；重启前新会话/派发任务会回「暂不支持：DSH 客户端 2.5 秒内没响应动作
   （client.js 改动需重启 DSH 后生效）」。
3. **环境与任务书背景不一致（如实记录）**：任务书写「server `172.24.112.14` 离线、板/看板不可达」，
   但交付时实测运行中 DSH 的 `api/board` 已指向 `http://172.24.112.11:13090`（mcloud）且
   **在线**（health ok、20 任务、12 事件，TCP 13090=True；`172.24.112.14:13090` 仍 False）。
   所以「看板」的成功分支还额外用运行中的真实 DSH 验证了一次（真的打开了真实板地址）；
   「看板不可达」分支则用返回结构化 `timeout` 的 fixture 覆盖。
4. **真实 OpenViking 探测未走新 Host 路由**：本机实测 `172.24.112.11:1933` 端口可达且返回
   `OpenViking Studio` 页面（200），但新路由未生效（运行中旧 Host 对 POST 回 405），端到端
   用 fixture 覆盖「可达打开」与「不可达回原因」两个方向。
5. **`explorer.exe` 真弹窗未在本轮触发**：单测用注入的 fake spawn 断言 argv
   （`['explorer.exe', [固定目录]]`、`detached:true`、无 shell），未真的在桌面弹资源管理器。
6. **「新会话」在真实 DSH 面板 iframe 内的可见效果未点击验证**：依据是第一方 API 合约
   （`uiWorkspace.startSession`，与 Ctrl+Alt+N 同一个调用）+ 桩协议测试；运行中真实页面以
   独立页方式验证时它走「无父窗口 → 暂不支持」分支（因为不在 shell iframe 里，且旧 client
   bundle 未重启加载）。
