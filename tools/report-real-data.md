# 交付报告：V5 工作台 + 集群拓扑接真实 interconnect 数据

- 日期：2026-11-21
- 范围：`dsh-html-panel` 插件的 Host 路由、`public/index.html` 页面、README、测试与证据
- 明确未做：**没有重启 / 结束 DSH 进程**，没有改 `cordis.patch.yml`，没有跑 pnpm，没有碰 git

## 1. 结论

1. Host 半新增只读路由 `GET /dsh-html-panel/api/cluster`：从本机 `ctx.interconnect` 的
   `peers()` / `selfSender()`（都是本地同步调用）生成 JSON，`origin` 只保留
   `host[:port]`，不含任何 userinfo / path / query / token。服务缺失或读取失败都答
   `200` 结构化 JSON（`interconnect:false` / `error`），其他方法 `405` JSON，未知
   `api/*` 路径 `404` JSON。
2. 页面（`public/index.html`）载入时 `fetch('api/cluster')`（同源相对路径，3s 超时）：
   四个固定槽位按 `instanceId` 匹配真实链路 —— `up` 亮蓝在线、`down` 灰离线、不在
   peers 里虚线未知；`cloud` 这类额外对端进「其它已配置对端」一行。`<title>` 只写实例 /
   origin / 链路 / 本实例标记 / 数据时间，**不再有「最后心跳」**。失败/超时/非 JSON/
   结构不符/`interconnect:false` 一律保留 mock 渲染，并在面板右上角明确标
   「mock 兜底 · 真实数据不可用：<短原因>」。
3. 测试三组全绿：`node --test "tools/*.test.mjs"` **17/17**（新路由/脱敏 16 例 + 旧
   snapshot 套件 123 条断言）、静态自检 **54/54**、Edge headless + CDP 页面验证
   **151/151 断言、8 个场景、0 页面 JS 异常**。3 张截图见 `tools/shots/`。
4. 两处物理副本（源码副本与已装副本）本轮改动的文件**逐字节一致**（sha256 见第 6 节）。

## 2. 真实环境事实（不是 bug，报告里如实写）

- 本机 interconnect 配置了 **4 个对端**：`server`、`s5`、`cloud`、`mcloud`，全部是
  `origin` 指向本机回环端口的隧道入口。
- 交付时这些入口**都没有监听**（四个回环入口逐一实测均不可连），原因是
  本机 VNT 虚拟网卡未启动，隧道全断。另据现场核实，运行中实例的 `peers()` 返回 4 行、
  `link` 全部 `down`。
- 因此 DSH 重启本路由生效后，正常显示应为：`pc-ky614` 在线（本实例），`mcloud` /
  `server` / `s5` 三格灰「离线（链路 down）」，`cloud` 出现在
  「其它已配置对端：cloud（down）」。**这不是「未在 interconnect 配置」**——链路恢复
  后无需改代码，页面会自动变在线。
- 本轮新增一个 `live-shape-1440` 场景专门按这个真实形状验证过（四槽位
  `offline, online, offline, offline` + cloud 进「其它」行）。

## 3. 改了什么（文件级）

| 文件 | 类型 | 内容 |
|---|---|---|
| `lib/cluster.js` | 新增 | 纯函数层：`sanitizeOrigin()`（origin → `host[:port]`，剥 userinfo/path/query/fragment/token，函数或坏值 → `null`）、`buildCluster(interconnect, now)`（`peers()`/`selfSender()` → 契约 JSON，任何输入都不抛错，`link` 只认 `up`，垃圾行跳过，超长实例名截断 80 字符）。无 I/O、无新依赖。 |
| `lib/index.js` | 修改 | `inject` 改为 `['webServer', 'interconnect']`（服务缺失仍不抛错）；新增常量 `CLUSTER_FILE = 'api/cluster'`；`serveCluster()` 处理 GET/HEAD、405 JSON、异常降级；`api/` 命名空间未知路径 JSON 404；`interconnectOf(ctx)` 按请求惰性读取（服务晚激活也能拿到）；注册时把 getter 传进 `servePublic`。 |
| `public/index.html` | 修改 | 唯一 `MOCK` 常量保留为兜底；新增 `mockView()` / `realView(data)` 两个视图构建器，`renderTopology(view)` 仍只有一份渲染逻辑（4 槽位 / 5 边 / 空心待接入圆不变）；新增 `isClusterPayload()` 形状校验、`loadCluster()`、3s 超时、短原因文案、`setTopoBadge()`；面板头新增数据来源 badge（真实/兜底/载入中）；图例下新增「其它已配置对端」一行；删除节点的 `heartbeat`/`link` mock 字段与「最后心跳」文案；`<title>`/`aria-label` 按视图模型生成并做转义；页面注释、meta、noscript 同步改成「同源 api/cluster + mock 兜底」。V4 的时钟、动作回执、待办 localStorage、标签页、系统小部件、布局断点全部未动。 |
| `package.json` | 修改 | `files` 数组补 `lib/cluster.js`（打包清单与实现一致）。 |
| `README.md` | 重写 | 页面描述改成 V5（快捷工作台 + 集群拓扑），删掉「dense table + event stream」过时说法；新增 `api/cluster` 契约与脱敏规则；旧的 snapshot 管线**如实**写成「路由与 postMessage 保留，但 V5 页面目前不消费，任务列表仍是 mock」；Layout 表补 `lib/cluster.js` 与 `public/index.html` 现状；Acceptance 换成本轮实测证据与未验证项；安装/卸载保留，路径用 `C:\Users\demo\...` 占位。 |
| `tools/cluster.test.mjs` | 新增 | `node:test` 用例：`sanitizeOrigin` 脱敏矩阵、`buildCluster` 契约/缺失/抛错/垃圾行、真 socket HTTP 路由（200/405/404/403/HEAD/204/无服务/读失败）、`inject` 与 prefix 注册断言。 |
| `tools/check-page.mjs` | 新增 | 页面静态自检（零依赖）：禁止一切外部 URL、`fetch` 只允许同源相对路径且必须是 `api/cluster`、标签闭合、内联 CSS/JS 可解析、`MOCK` 唯一、四槽位/五边、badge 元素、无心跳文案、900px 断点。旧检查「禁止 fetch」已更新为「禁止外部 URL，允许同源相对 fetch」，没有放宽成全放行。 |
| `tools/cdp-live.mjs` | 新增 | 起**同源静态服务器**（页面直接读 `public/index.html`，`api/cluster` 按场景给 fixture），Edge headless + CDP 断言 + 截图；8 场景：真实数据 1440、404 兜底、900 窄宽拓扑、非 JSON、结构不符、3s 超时、`interconnect:false`、真实形状（4 peer 全 down）；含 V4 交互回归与「只有同源请求」网络断言。 |
| `tools/report-real-data.md` | 新增 | 本报告。 |
| `tools/shots/shot-01-live-data-1440.png` | 新增 | 真实数据渲染（self pc-ky614 + server up + s5 down + cloud down + mcloud 未配置；badge「真实 · interconnect · 生成 12:20:00」）。 |
| `tools/shots/shot-02-mock-fallback-1440.png` | 新增 | 兜底态（`api/cluster` 404；badge「mock 兜底 · 真实数据不可用：HTTP 404」，拓扑保留 mock 并标 mock）。 |
| `tools/shots/shot-03-narrow-900-topology.png` | 新增 | 900 宽拓扑特写（2x；四槽位 + 三态 + 其它对端行，无溢出）。 |
| `tools/shots/cdp-report.json` | 新增 | CDP 每场景的节点数/边数/状态序列/badge 文案/title 片段/网络请求/交互结果。 |
| `tools/shots/check-page.json` | 新增 | 静态自检 54 条逐项结果。 |

未改动：`lib/client.js`、`locale/*`、`icon.svg`、`cordis.patch.yml`、`public/index.placeholder.html`、
参考图 `ref-topology.png`、V5 视觉风格（配色/布局/字体/边框语义均沿用），也未改 profile 里其它插件。

## 4. 数据契约（页面与 Host 的约定）

```json
{
  "generatedAt": "2026-11-21T04:20:00.000Z",
  "interconnect": true,
  "self": { "instanceId": "this-instance" },
  "peers": [ { "instanceId": "peer-a", "origin": "10.0.0.2:9100", "link": "down" } ],
  "board": null,
  "error": "读取 peers 失败"
}
```

- `origin`：仅 `host[:port]`；函数（self 路由解析器）/空/解析失败 → `null`，页面显示
  「未配置或无固定 host:port」。
- `link`：只会是 `up` / `down`。
- `board`：本轮固定 `null`（没有接共享板，不编数据）。
- `error`：仅「服务在但 `peers()` 抛错」时出现，文案固定、不含原始错误文本。
- 路由方法：GET/HEAD；其它方法 `405` + `Allow: GET, HEAD`；未知 `api/*` → `404`
  `{ ok:false, error:'not-found' }`；全部 `cache-control: no-store`。

页面映射规则：`mcloud`→顶部居中、`pc-ky614`→下排左（本实例永远在线）、`server`→下排中、
`s5`→下排右；其余已配置对端只进「其它已配置对端」一行；`server` 下空心圆保持「待接入 · 未知」。

## 5. 验证证据（命令与结果）

环境：本机 Windows 11，Node **v24.19.0**，Edge headless（CDP，零第三方依赖）；**未重启 DSH**。

| 命令（插件根目录） | 结果 |
|---|---|
| `node --test "tools/*.test.mjs"` | **PASS**：`tests 17 / pass 17 / fail 0`；其中新套件 16 个用例，旧 `mesh-snapshot` 脚本 `123/123` 条断言也仍通过 |
| `node tools/check-page.mjs --json tools/shots/check-page.json` | **PASS 54/54**；页面 56,198 B，sha256 `2c679e12…`；所有外部引用检查为 0 命中，`fetch` 只有同源相对 `api/cluster` |
| `node tools/cdp-live.mjs` | **PASS**：8 场景、`151 passed / 0 failed`、`pageErrors=0`；每场景 4 节点 + 1 待接入、5 条边；真实场景 badge/三态/title/其它行正确；5 种兜底原因（HTTP 404 / 响应不是 JSON / 结构不符 / 超时 3s / 本实例没有 interconnect 服务）逐一命中；900 宽 `scrollWidth==innerWidth`、拓扑面板与 SVG 无溢出；V4 交互（时钟走秒、动作回执、待办写 localStorage、标签页、6 个动作含禁用重启）全过 |
| `node --check` 相关脚本 + `node tools/check-page.mjs` 内联 JS 解析 | 通过（无语法错误） |

运行中 DSH 的实际状态（只读探测，未重启）：

- `GET http://127.0.0.1:54584/dsh-html-panel/index.html` → `200`，56,198 B，
  sha256 与源码/已装副本的 `public/index.html` **完全一致** —— 页面文件改完刷新即生效。
- `GET http://127.0.0.1:54584/dsh-html-panel/api/cluster` → **404** —— 新增 Host 路由
  需要 DSH 重启才挂上，本轮按红线未重启。也就是说：**现在刷新 GUI 会看到新页面 +
  「mock 兜底 · 真实数据不可用：HTTP 404」**；重启后同一页面自动变成真实数据，无需再改。
- 四个回环入口逐一实测均无监听（VNT 未启动，4 个对端全 down）。
- `cordis.patch.yml` 未改（`inject` 是模块级声明，不需要配置）。

截图（均在 `tools/shots/`，相对插件根）：

| 文件 | 场景 |
|---|---|
| `shot-01-live-data-1440.png` | 1440px、真实 fixture：badge「真实 · interconnect · 生成 12:20:00」；mcloud 虚线未知、pc-ky614/server 亮蓝、s5 灰；图例下「其它已配置对端：cloud（down）」 |
| `shot-02-mock-fallback-1440.png` | 1440px、`api/cluster` 404：badge「mock 兜底 · 真实数据不可用：HTTP 404」，拓扑保留 mock（节点 title 标「mock 示例」） |
| `shot-03-narrow-900-topology.png` | 900px 拓扑特写（2x）：三态图例、其它对端行、无横向溢出 |

## 6. 两份副本同步与哈希

- 源码/部署目录（权威）：`C:\Users\demo\dsh-plugins\dsh-html-panel`（本文用占位路径）
- 已装副本（运行中 DSH 实际加载）：`%DSH_PROFILE_DIR%\node_modules\dsh-html-panel`
- 做法：逐文件 `Copy-Item -Force`（只覆盖本轮改动的文件，不整目录镜像，避免动到别的文件），
  然后对每个文件分别算 sha256 比较。`tools/shots/` 为新目录，已一并复制到已装副本。

| 文件（相对插件根） | 字节 | 源码副本 sha256 | 已装副本 sha256 | 一致 |
|---|---|---|---|---|
| `lib/cluster.js` | 5,406 | `aadb7c4a5db20bd7539ce6247c5b9fffc6165aac06a35617254d903aedfc6b02` | 同左 | 是 |
| `lib/index.js` | 12,237 | `7f925cb0a617e6d7ed176cec66b90fefff6ae066519fb6b778651bc788348c5d` | 同左 | 是 |
| `public/index.html` | 56,198 | `2c679e12a979168e029aa69f14ba471ae00bfd38861b549bc9bf9fd2adf04847` | 同左 | 是 |
| `package.json` | 1,165 | `d58fee686d27a6495160b1f63315337ab124961d1222d9aad0ce7f2bfcf7d308` | 同左 | 是 |
| `README.md` | 12,977 | `be23725a3ac1892de83e28a60aeb118ab690d68f0639b2a5ccb4bb9a759eb2b3` | 同左 | 是 |
| `tools/cluster.test.mjs` | 16,149 | `dd5190be68e049bbace4e705ab9180a083bdb551aaf3c5686c70c7e91434a937` | 同左 | 是 |
| `tools/check-page.mjs` | 11,502 | `326bada6f80329d60af3c56f3f024c2e7c4e4b574afe4b4081503e7e78685ba5` | 同左 | 是 |
| `tools/cdp-live.mjs` | 27,405 | `062c8378db82b19bd8714161d77275f338e8603ba89cb28eb8f074813a70adcd` | 同左 | 是 |
| `tools/shots/shot-01-live-data-1440.png` | 238,624 | `86bdca85fc1269a33668b807b4e22aef4e080d8624561dcee9d8935cf5c2bb74` | 同左 | 是 |
| `tools/shots/shot-02-mock-fallback-1440.png` | 241,555 | `e5c849b6ae0ab3f086ac733eab42743219b474506c77a0c0d90aad03a8342181` | 同左 | 是 |
| `tools/shots/shot-03-narrow-900-topology.png` | 111,842 | `bf4970565968b422d697c09eb327e99fcfad5316c8050ba0e50aaa5ed809a62a` | 同左 | 是 |
| `tools/shots/cdp-report.json` | 13,294 | `105959107604bf15f7eba721ed762bd08cb73206cd4872cb76659d1e66a1e374` | 同左 | 是 |
| `tools/shots/check-page.json` | 5,627 | `d909f0ca5cfc361d1f8c77ec8c453a415fe54fc66021ce4aaee5b8fb0e5a7cc3` | 同左 | 是 |

本报告（`tools/report-real-data.md`）的 sha256 记在 `tools/shots/copy-verify.json` 里；该清单
（机器可读的逐文件 `sha256` 对照表，由脚本在文件定稿后生成）同样已复制到已装副本，两处一致。
清单本身无法可靠地记录自身哈希，故它不在清单条目里。复核命令：

```powershell
$src = 'C:\Users\demo\dsh-plugins\dsh-html-panel'
$dst = Join-Path $env:DSH_PROFILE_DIR 'node_modules\dsh-html-panel'
Get-FileHash -LiteralPath (Join-Path $src 'lib\cluster.js') -Algorithm SHA256
Get-FileHash -LiteralPath (Join-Path $dst 'lib\cluster.js') -Algorithm SHA256
```

## 7. 未做到 / 未验证（如实列）

1. **真实 DSH GUI 内的渲染未验证。** 新 Host 路由要重启 DSH 才生效，本轮红线禁止重启；
   页面在真实 shell/iframe 里的样子、badge 位置、iframe 内 900 宽表现都没有在 GUI 里看过。
   证据止于：模块级 HTTP（假 ctx + 真 socket）+ 同源静态服务器里的真页面 + Edge headless。
2. **新路由需要重启 DSH 才生效**（本轮实测：页面文件已更新、`api/cluster` 仍 404）。
   在重启前，运行中 DSH 的面板会显示新页面 + 「mock 兜底 · 真实数据不可用：HTTP 404」。
3. **真实 interconnect 数据没有在本会话里端到端跑过渲染。** 页面测试用的是按真实契约形状
   构造的 fixture（含本机实际 4 对端全 down 的形状）；运行中服务的 `peers()` 只在现场由
   他人核实过，本会话只读核对了配置与端口监听。重启后若真实返回与契约不同，需要按
   `cdp-report.json` 的形状再核一次。
4. **`mcloud` / `server` / `s5` 当前显示离线是链路事实（VNT 未启动、隧道全断），不是
   「未配置」**；`cloud` 是第 5 个已配置对端，按设计只进「其它已配置对端」一行。链路恢复后
   页面自动更新，无需改代码。
5. **任务/文档/动作/系统小部件仍是 mock**；`board` 恒为 `null`；旧 snapshot 管线
   （`snapshot.json` + `postMessage`）保留、兼容、但 V5 页面不消费。
6. 超时兜底是在 CDP 测试里用「服务端挂起不回包」触发的（真实 3s 计时），不是真实网络抖动；
   真实公网/隧道抖动下未单独演练。
7. 设计稿目录里没有另存 V6 归档副本（任务里这项是「可」，本轮未做；以插件
   `public/index.html` 为准）。

## 8. 回滚

- 只回滚页面：`copy /Y public\index.placeholder.html public\index.html`（占位页；或从改动前
  备份恢复旧 V5 文件）。
- 回滚本轮 Host 改动：删除 `lib/cluster.js`、把 `lib/index.js` 的 `inject` 与路由段恢复，
  然后重启 DSH。
- 回滚 README/工具：直接恢复备份即可，不影响运行时。
- 已装副本与源码副本用同样方式回滚（两处需同时改，否则会不一致）。

## 9. 红线遵守情况

- 未重启 / 未 kill DSH 进程：`TEST-NETCONNECTION`/HTTP 只读探测，未向 54584 发任何控制指令。
- 未改 `cordis.patch.yml`（含 peer 配置）；未跑 pnpm；未碰 profile 其它插件与文件。
- 未碰 git / 未建仓 / 未上传。
- 未改参考图 `ref-topology.png`、未改 V5 视觉风格。
- 所有写入为 UTF-8 无 BOM（已用 `check-page` 的 BOM 断言与字节核对覆盖 HTML；脚本/报告为
  同一写入路径）。
- 文件内无 token / 密钥 / 本机个人绝对路径：README 与报告用 `C:\Users\demo\...` 占位，
  其余文件对外只出现实例名与 `host[:port]`。
