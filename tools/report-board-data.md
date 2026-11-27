# dsh-html-panel 0.2.0 —— 面板剩余 mock 清理（共享板 + 本机数据接入）

日期：2026-11-21。版本：`0.1.0` → **`0.2.0`**（首次接真实共享板与本机数据）。
本轮红线全部遵守：**没有重启/结束 DSH、没有 git 操作、没有推 GitHub、没有跑 pnpm、没改
dsh-team-mesh 与 interconnect 配置**；只编辑了 `C:\Users\demo\dsh-plugins\dsh-html-panel`
（唯一编辑处）与 desktop profile 的 `cordis.patch.yml`（备份见下）；已装副本只在最后同步。

---

## 一、结论

V6 页面里 **没有真假混用的 mock 了**：顶栏三段假文案、右上三个假 chip、最近任务列表、
「最近文档」、系统小部件、看板假地址全部换成三条同源只读路由的真实数据
（`api/cluster` 保留、新增 `api/board` / `api/host`）。只剩两种明确的边界：

- **mock 只做兜底**：某模块**首次加载**失败才渲染本页 `MOCK`，并在模块标题旁明确写
  `mock 兜底 · <原因>`；拿不到就不冒充。
- **轮询失败不闪回 mock**：保留上一次好数据，只在顶栏出现
  `数据过期 · HH:MM:SS / 原因` badge（30 秒轮询，页面隐藏时跳过）。

真实共享板的端到端联调**做不了**：本机到板服务 `http://172.24.112.14:13090` 的网络当前
不通（`/health` 直接超时）。所以 `/api/board` 是对着**假板服务**（真 HTTP、真校验
`x-team-token`）验证的，且这一点在验收表里如实标为「未验证」。

新 Host 路由需要重启 DSH 才存在，本轮不允许重启：运行中的 DSH **旧 Host 半**仍然
`api/board` / `api/host` 返回 404，但**页面文件已从磁盘更新**（刷新即生效），页面会自
动如实标 mock 兜底（实机验证见 §六.3）。

---

## 二、改了什么

### 2.1 新增文件（Host 半）

| 文件 | 作用 |
|---|---|
| `lib/board.js` | `/api/board` 的读取器：解析 `config.board`、带 `x-team-token` 读板服务的 `/health`、`/task/list`、`/task/evidence`、`/events`；3 秒进程内缓存；所有失败折成结构化 JSON；token 只进请求头。 |
| `lib/boardmap.js` | 共享映射层：板 lifecycle → 面板五态、acceptance 按换行拆、事件 payload 摘要、task/event 字段形状。**HTTP 路径与离线工具 `tools/mesh-snapshot.mjs` 共用这一份**，没有造第二套语义（原 `mesh-snapshot.mjs` 里的同名函数改为从 `../lib/boardmap.js` import / re-export，测试仍全绿）。 |
| `lib/host.js` | `/api/host`：`node:os` + `fs.statfs` 生成主机名 / 平台 / 运行时长 / 内存 / CPU / C: D: 磁盘。零外部依赖；`statfs` 失败只是该项数值 `null` + 错误码，不抛。 |

### 2.2 修改

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 新增 `BOARD_FILE = 'api/board'`、`HOST_FILE = 'api/host'` 与两个路由；`jsonResponse` 支持附加头；非 GET/HEAD 统一 405 JSON；`apply()` 创建一个带缓存的板读取器；模块头注释更新。`inject` 保持 `['webServer','interconnect']`（无新服务依赖）。 |
| `public/index.html` | V6 页面（见 §三）。 |
| `tools/check-page.mjs` | 允许同源 `api/*`（且断言 `api/cluster|board|host` 三条都读）；新增假值、五态、事件流、轮询、兜底、落点 id 等断言。 |
| `tools/cdp-live.mjs` | 重写为全页 CDP 验证：三路由可控 fixture、7 个场景、6 张截图、V4 交互回归（原拓扑专项断言并入）。 |
| `tools/board.test.mjs` | 新增 15 个 `node:test` 用例：配置解析、映射、正常路由、缓存、错误脱敏、`/api/host`、405/HEAD。 |
| `package.json` | `0.1.0` → `0.2.0`；`files` 补 `lib/board.js`、`lib/boardmap.js`、`lib/host.js`；描述更新。 |
| `README.md` | 重写：三条数据源契约、profile 配置示例（token 用 `<boardToken>` 占位）、五态映射、缓存与失败语义、兜底/轮询行为、验收数字、「新路由需重启」、未接项。 |

### 2.3 页面 mock 清理对照（逐项）

| 原 mock 位置 | 现在 |
|---|---|
| 顶栏日期行 `mcloud · 共享板 127.0.0.1:13090 · DSH 0.4.0` | 日期 + `实例 <self>` + `板 <source.origin>`（或「板未配置 / 板不可达」）+ `数据 HH:MM:SS`；假值字符串已从页面删除（静态检查钉死）。 |
| 右上 3 个 chip：`DSH mock 在线` / `共享板 13090 · 11ms` / `s5 离线` | ① `interconnect <up>/<total> up`（cluster）② `板 在线 · 37ms` / `板 不可达` / `板 未配置`（board health）③ `板上 N 任务`；另有按需出现的 `数据过期 · …` badge。 |
| 「最近任务」6 条假任务 | `/api/board` 的 tasks：五态徽章（leased/awaiting/undelivered/stale/done，其余原样透传为「未知 · 原值」）、标题、id、owner、node（`lease_host`）、证据数、相对更新时间；行展开看原始 lifecycle/回执/时间/验收/说明。空 → 「板上暂无任务」。 |
| 「最近文档」5 条假文档 | 改成**事件流**标签页：task/events 的时间、任务、节点（actor）、类型、正文，最近在前；空 → 「暂无事件」。 |
| 系统小部件磁盘 `已用 43 / 80 GB`、内存 `18.4 GB 58%`、板延迟 `p95 34ms` + 假 sparkline | C:/D: 真实总量/已用/比例 + 进度条；内存真实总量/已用/比例；「板健康：最近一次 /health 延迟」。标题「本机状态」，hint「本机 · 只读」。 |
| 「打开看板」desc 写死 `共享板 127.0.0.1:13090` | 从 `source.origin` 动态填；拿不到就**置灰**并写原因（「板未配置」/「板不可达」），不留假地址。 |
| 5000ms 定时滚动假延迟序列 | 删除；改为 30 秒静默轮询三条路由（`document.hidden` 时跳过）。 |

保留不动：常用动作其余四项仍是静态原型（只记本地回执）、时钟、动作回执、待办
localStorage、标签页键盘交互、900px 布局断点、集群拓扑（inline SVG，真实+兜底两视图）。

---

## 三、页面行为要点

- **三条同源路由**：`fetchJson('api/cluster' | 'api/board' | 'api/host')`，均为相对路径；
  页面零外链（无 CDN/外部字体/第三方脚本）。
- **状态机**：每个模块 `loading | real | mock | unconfigured`。
  - 首次加载失败 → 该模块 `mock` + 标题旁 `mock 兜底 · <原因>`；
  - 轮询失败且已有真实数据 → 保留旧渲染，只加顶部 `数据过期 · HH:MM:SS / 原因`，不重渲染 mock；
  - 板 `configured:false` → 「板未配置」空态（不造假任务、不冒充故障）。
- **超时**：cluster/host 5 s、board 8 s（Host 侧板回调另有 4 s 上限）。
- **安全**：板返回的所有文本在拼 HTML 前过 `esc()`；页面永远看不到 token（token 只在
  Host 发出的请求头里）；`source.origin` 只含 `http(s)://host[:port]`。
- **不白屏**：接口 404 / 非 JSON / 超时 / 结构不符 / `interconnect:false` / `configured:false`
  都有渲染路径；CDP 断言页面零 JS 报错（7 个场景 `.pageErrors == []`）。

---

## 四、profile 配置变更（唯一写 token 的地方）

文件：`C:\Users\demo\.dsh\profiles\desktop\cordis.patch.yml`
备份：同目录 `cordis.patch.yml.bak-before-panel-board-20261121`（**先备份后改**，备份 = 改前原文）。

### 4.1 diff（token 已遮蔽）

原有 641 行内容**逐字节未变**（脚本断言 `old content is prefix: true`），只在文件末尾
追加 6 行（新文件第 642 行起）：

```diff
@@ 文件末尾追加
+- id: dsh-html-panel
+  config:
+    board:
+      endpoint: 'http://172.24.112.14:13090'
+      token: '<MASKED>'          # 64 字符；sha256 与 dsh-team-mesh 的 boardToken 相同
+      timeoutMs: 4000
```

- 覆盖形式用 `id + config`（**不 insert、不写 name**）：与该文件里既有的
  `- id: interconnect`、`- id: dsh-team-mesh` 覆盖行完全同形，是本机 profile 已被验证过的写法。
- token 的复制**全程由脚本完成**：读 patch 文本 → 正则取出 mesh 段 `boardToken` → 写入新块 →
  重新读回计算 sha256 比对。脚本输出只有：

  ```
  backup created: true
  mesh token length: 64
  token copied: true
  panel token length: 64
  lines before: 642 lines after: 648
  panel block count: 1
  ```

  没有打印 token，也没有打印其哈希值。
- **YAML 结构校验**：用 `yaml` 解析器真正 parse 通过 —— 顶层 15 项，`dsh-html-panel` 行唯一、
  `config.board` 恰为 `endpoint, timeoutMs, token` 三键，`dsh-team-mesh` 行原值未变
  （`boardEndpoint` / `boardTimeoutMs` 仍在）。
- **token 泄漏扫描**：把真实 token 读进内存后扫插件源码树 + 已装副本 + 全部证据文件
  （含截图二进制、JSON），命中 **0** 个文件；profile patch 内共出现 **2** 次
  （mesh 的 `boardToken` + 面板的 `token`），符合设计。扫描脚本只打印文件名/次数，从不打印值。

回滚：`copy /Y cordis.patch.yml.bak-before-panel-board-20261121 cordis.patch.yml`，重启 DSH。

---

## 五、测试与证据

### 5.1 `node --test "tools/*.test.mjs"` —— 全绿

```
tests 32 / pass 32 / fail 0
├ tools/cluster.test.mjs      16 个 test()：原集群路由/脱敏/静态路由不退化
├ tools/board.test.mjs        15 个 test()：本轮新增（见下）
└ tools/mesh-snapshot.test.mjs 自跑断言 123/123（抽取映射层后仍全绿）
```

`tools/board.test.mjs` 覆盖（全部用**真 socket**：假板服务 + 真 `apply()` + 真 `fetch`）：

- 配置解析：合法配置/默认 4000/夹取 500–10000、非法 timeout、非法 token、无 endpoint、
  非法 URL、平铺简写；带 `user:pass@…/path?token=abc#frag` 的 endpoint 只输出
  `http://host:port` 且请求基址不含凭据/query。
- 映射：六种板状态 → `leased/done/awaiting/undelivered/stale/blocked`，`node=lease_host`、
  `evidenceCount`、毫秒时间原样、acceptance 拆行。
- 正常路由：契约字段、health 只挑 5 个字段（板服务 `/health` 返回的 dbPath **未**透传）、
  6 任务/8 事件顺序与字段、每请求都带 `x-team-token`、响应体无 token、3 秒缓存
  （第二次 `cached:true` 且板服务零新增请求）。
- 错误形状：连不上 / 超时（实测等满 500ms）/ 非 JSON / 401 / 结构化板错误 / 未配置，
  响应与 console 都 grep 不到 token，也不回显 endpoint 的 userinfo。
- `/api/host`：字段范围、C: 盘、`statfs` 失败项数值 `null` 不抛、os 读不到不抛、
  HEAD 同头无体、POST/PUT/DELETE 405 JSON + `Allow`。

### 5.2 静态检查 `node tools/check-page.mjs` —— PASS 99/99

```
bytes=74933  sha256=130870454874f6c710408fa9c418ce0052452015c9d2be4a24dd46bb45fe198b
result: PASS (99/99)
```

钉住的关键项：零外链（`http(s)://`、`<link>`、`<script src>`、`<img src>`、`<iframe>`、
XHR/WebSocket/importScripts、非 data: `url()` 全禁）；只允许同源相对 `fetchJson('api/…')`
且三条都读；无 `DSH 0.4.0` / `127.0.0.1:13090` / `共享板 13090` / `p95 34ms` /
`已用 43 / 80 GB` 等假值；顶栏不含 mock 字样；无「最近文档」/`docList` 残留；
五态类与文案、事件流字段、三 chip/日期行/小部件 id、mock 兜底与过期 badge 文案、
30 秒轮询 + `document.hidden` 跳过、`renderBoardAction` 置灰逻辑、XSS `esc()` 全在。
机读结果：`tools/shots/check-page.json`。

### 5.3 CDP（Edge headless，Node 内置 WebSocket，零依赖）—— PASS 253/253

`node tools/cdp-live.mjs`：同源静态服务器提供真页面 + 三个路由的可控 fixture，
7 个场景，断言 253 通过 / 0 失败，**页面 JS 报错 0**（页面内 hook + CDP 层双保险），
所有请求同源。机读：`tools/shots/cdp-report.json`。

| 场景 | 视口 | 验证点 | 截图 |
|---|---|---|---|
| real-1440 | 1440×1000 | 板 6 任务 + 8 事件、集群 0/4 up、本机 C/D：chip 文案、实例名、`source.origin`、五态徽章与文案、证据数/节点/相对时间、事件流 8 条、磁盘/内存/板健康真值、看板动作可点且地址为 origin、V4 交互回归 | `shot-01-real-data-1440.png` |
| board-unreachable | 1440×1000 | 板返回结构化 timeout：任务/事件标 `mock 兜底 · …timeout…`、chip「板 不可达」、看板动作置灰；本机与链路仍是真值（模块隔离） | `shot-02-board-unreachable-1440.png` |
| board-unconfigured | 1440×1000 | `configured:false`：任务/事件空态写「板未配置」、chip、板健康、看板动作全部如真标注，不造假数据 | `shot-03-board-unconfigured-1440.png` |
| board-empty | 1440×1000 | 板在线但 0 任务 0 事件：「板上暂无任务」「暂无事件」 | `shot-04-board-empty-1440.png` |
| cluster-down-404 | 1440×1000 | `api/cluster` 404：只有拓扑回落 mock 并写明原因；任务仍是真实 6 条 | — |
| narrow-900 | 900×1000 | `scrollWidth == innerWidth`、面板无溢出 | `shot-05-narrow-900.png` |
| poll-no-flash | 1440×1000 | 首屏真实 → 板 fixture 切成 timeout → 等满 30 秒轮询：仍显示同 6 条真实任务、chip 保留上次延迟、只多出 `数据过期 · HH:MM:SS / 共享板：…超时…` badge，**没有闪回 mock** | `shot-06-stale-after-poll.png` |

（截图共 6 张，均在 `tools/shots/`；目录里另有上一轮的 3 张旧图，只做历史留存，不在本轮证据里引用。）

### 5.4 实机（运行中 DSH，未重启）

- `GET http://127.0.0.1:62273/dsh-html-panel/index.html` → **200 / 74,933 B**，sha256
  与源文件**相同**（`13087045…`）：页面文件从磁盘读，刷新即生效。
- 同实例：`api/cluster` → 200 真实数据（`interconnect:true, self:pc-ky614, 4 个 peer 全 down`）；
  `api/board` → **404**、`api/host` → **404**（旧 Host 半，符合「新路由需重启」）。
- 用 headless Edge 直接打开这个**真实运行地址**（不重启、不改配置）实测渲染：

  ```
  chip ② = 板 不可达            chip ③ = 任务 mock 兜底
  chip ① = interconnect 0/4 up   顶栏 = 实例 pc-ky614 / 板 不可达
  拓扑 badge = real（真实 · interconnect）
  recentHint = mock 兜底 · HTTP 404    widgetsHint = mock 兜底 · HTTP 404
  看板动作 = 置灰 / 板不可达           页面 JS 报错 = 0   无横向溢出
  ```

  即：**新页面在旧 Host 半下不白屏、不抛错、把 404 如实标成 mock 兜底**；等重启后两条新路由
  就绪，板/本机会自动转真实。

---

## 六、两处副本（逐字节）

- 权威源码：`C:\Users\demo\dsh-plugins\dsh-html-panel`
- 已装副本：`%DSH_PROFILE_DIR%\node_modules\dsh-html-panel`
- 同步范围：`lib/`、`public/`、`tools/`、`README.md`、`package.json`（整体镜像，最后只同步这一次）。
- 逐文件 sha256 比对：**33 个文件，0 个不同，`allIdentical: true`**。
  机读清单：`tools/shots/copy-verify.json`（只含相对路径与哈希）。

本轮改动/新增文件（两侧一致）的 sha256：

| 文件 | 字节 | sha256 |
|---|---|---|
| `lib/index.js` | 15549 | `bc11f726f691389054f082329b1b09ed786cc69d2caf1782800cc744599e2a6e` |
| `lib/board.js` | 14968 | `4db71d99ae5cb5b022d3f799d60a937ca0cfdb5b56ccc5f3634d86f806304b89` |
| `lib/boardmap.js` | 9383 | `caaa1074b69a973fab2da4cf8aec86a6dbac411138fddac1d8aa5bcaf1d13177` |
| `lib/host.js` | 5288 | `0f6b7a4303497cd07faf3cbdae61160a9c6df3c458e5b5590ab3ac26887e3f2a` |
| `lib/cluster.js`（未改） | 5406 | `aadb7c4a5db20bd7539ce6247c5b9fffc6165aac06a35617254d903aedfc6b02` |
| `lib/client.js`（未改） | 5058 | `eea96ee1d2414128e20e8675aadc3f5ffcc74f15fe01eab40ea62fc265cd9001` |
| `public/index.html` | 74933 | `130870454874f6c710408fa9c418ce0052452015c9d2be4a24dd46bb45fe198b` |
| `tools/check-page.mjs` | 17037 | `0f35f7398f9dcff12025487b81022a2d76ed946476e50c7a19724ab6b6cf5e62` |
| `tools/cdp-live.mjs` | 40994 | `026219d631636a7f393a6a3ff6437413545f731c20c92e348f367902dab2f3a4` |
| `tools/board.test.mjs` | 28487 | `3a61e579263645d8cfe6193b97fe6462bd00308c3b332d629f7692d276be0444` |
| `tools/mesh-snapshot.mjs` | 14145 | `8f1657c432f53444ce0c5c3672f899eb03a8e88e594c907eefb571bcbd916b70` |
| `README.md` | 18682 | `a38d14cee088e806f5f0ed50433f28c1c7fb107b5c3a61ab8eb83942d1397a13` |
| `package.json` | 1324 | `a61a3ac28e76b64d8804e8c1818dc754dfd0ef64b03008d7e3b6312a9352236e` |

（`cordis.patch.yml` 本轮未改，两侧仍是 693 B 原文。）

---

## 七、未做到 / 已知限制（如实列）

1. **真实共享板没有联调**：`http://172.24.112.14:13090/health` 在本机当前网络下超时。
   `/api/board` 是对**假板服务**按同一契约验证的（真 HTTP、真 `x-team-token` 校验、真
   `/task/list`/`/task/evidence`/`/events` 响应形状），真实板上的字段/限流/延迟没有实测。
2. **新 Host 路由没有在运行中的 DSH 里生效**：加路由需要重启 DSH，本轮明令禁止。
   运行中实例的 `api/board`、`api/host` 仍是 404；页面已更新且会如实标 mock 兜底（§5.4 实测）。
   重启后这两条路由才可用。
3. **真实 GUI 侧边栏 iframe 里的渲染没看**：未重启就无法重载 Host 半；本轮用 headless
   Edge 直接打开**同一个运行地址**做了实机渲染验证（§5.4），但没有在 DSH 侧栏 iframe 内看过。
4. **常用动作仍是静态原型**（任务要求保留）：点击只记本地回执；只有「打开看板」的地址动态化/置灰。
5. **事件流的「节点」列是 `actor`**：板库/板服务没有 host 列，`actor` 是唯一「谁干的」，
   与离线工具 `tools/mesh-snapshot.md` 的口径一致（不是主机名）。
6. **证据数逐任务查**：`/task/list` 不返回证据条数，`/api/board` 对最多 20 个任务各打一次
   `/task/evidence`（并行）。板服务限流默认 600/60s，正常轮询（≈23 请求/30s）远低于阈值；
   极端情况下某个任务的证据查询失败只让该任务显示「证据 —」，不影响整表。
7. **`stale` 会盖掉 `blocked`、`canceled` 原样透传**：这是共享映射表的既有取舍（面板只有五态），
   页面把原始 lifecycle 显示在「未知 · 原值」与展开详情里，不硬塞成 done。

## 八、关键命令记录（插件根目录）

```powershell
node --test "tools/*.test.mjs"          # 32/32 pass
node tools/check-page.mjs --json tools/shots/check-page.json   # PASS 99/99
node tools/cdp-live.mjs                 # PASS 253/253, 7 scenarios, 6 shots
# 实机（不重启 DSH）：
node <临时脚本>  # GET 运行中页面 sha256 对比 + headless Edge 打开真实页面读状态
# 两处副本：
node <临时脚本>  # 镜像 lib/ public/ tools/ README.md package.json 后逐文件 sha256 比对
```
