# dsh-html-panel

Sidebar row → main-area panel → the **V6 工作台 + 集群拓扑** page: a quick workbench
(clock, actions, receipts, recent board tasks, event stream, local widgets, todos) with an
inline-SVG cluster topology on top.

Version **0.3.0** — the page's six 「常用动作」 buttons are no longer a static prototype:
each one either **really does the work** (new session, open board, open OpenViking Studio,
read the latest report, open the reports folder) or answers **「暂不支持：原因」** with a
human reason. There is no local fake receipt any more. The Host side gains one write path,
`POST /dsh-html-panel/api/action`, which accepts **only whitelisted action ids** (never a
path, command or URL) — see **Action buttons**.

The page is still fed by **three real, read-only, same-origin routes**:

| Route | Data |
|---|---|
| `GET /dsh-html-panel/api/cluster` | this instance's live interconnect links (`ctx.interconnect`) |
| `GET /dsh-html-panel/api/board` | the shared board's tasks / events / health (`dsh-team-mesh` HTTP service, token header) |
| `GET /dsh-html-panel/api/host` | the local machine's memory / CPU / disks (`node:os` + `fs.statfs`) |
| `POST /dsh-html-panel/api/action` | whitelisted real action: `probe-memory` / `latest-report` / `open-reports-folder` |

Every module falls back to its own clearly-labelled mock only when its source fails on the
first load; a later poll failure keeps the last good data and only adds a
`数据过期 · HH:MM:SS / 原因` badge. The page never presents mock values as real.

The page is a real file: `public/index.html`. The Host half serves that directory at
`/dsh-html-panel/`, and the browser half iframes `/dsh-html-panel/index.html` into the main
panel. Editing the HTML and refreshing the GUI is the whole edit loop — no client rebuild,
no repackage. **A new Host route, a changed browser-half bundle, and any new action config
only take effect after DSH restarts** (the shell loads plugin client bundles from an
immutable boot-time batch; `dsh-client-modules/src/index.ts` §`bundleResource`).

The page has **no external references**: inline CSS and JS, no CDN, no external fonts,
icons or images, no third-party scripts. The only page-originated requests are the
same-origin relative paths above; the two URLs the page opens in a new tab (shared board,
OpenViking Studio) come from the Host at click time — they are never written into the page.

## Layout

| Path | Half | Role |
|---|---|---|
| `lib/index.js` | Host (node) | Registers the `prefix` route `/dsh-html-panel` → `public/`, `no-store`, traversal-guarded. Dispatches the three read-only `api/…` child paths, keeps the legacy `snapshot.json` child path. Also registers the **exact raw handler** `POST /dsh-html-panel/api/action` (a `resource` route would turn POST into 405 before our code runs) and owns that endpoint's request envelope. Declares `inject: ['webServer', 'interconnect']`; a missing interconnect is tolerated (the cluster route answers `interconnect: false`). |
| `lib/actions.js` | Host (node) | The action layer behind `POST api/action`: normalizes `config.actions.memory.url` / `config.actions.reports.dir` (defaults: `http://172.24.112.11:1933/`, `%USERPROFILE%\mesh-0.6-dev\repo\docs`), probes OpenViking, finds/reads the newest `.md` (64 KiB cap, truncation flagged), and spawns `explorer.exe` with an argv array for the fixed reports directory. Failure is always `{ok:false, code, reason}`; every side effect is injectable, so the tests never touch the desktop. |
| `lib/cluster.js` | Host (node) | Pure functions behind `api/cluster`: `buildCluster(interconnect)` turns `peers()` / `selfSender()` into the JSON contract, `sanitizeOrigin()` reduces an origin to `host[:port]`. No I/O, no dependencies, never throws. |
| `lib/board.js` | Host (node) | Reader behind `api/board`: parses `config.board`, calls the board's read-only routes with `x-team-token`, maps tasks/events, keeps a 3 s in-process cache, and folds every failure into a structured JSON body (never throws, never echoes the token). |
| `lib/boardmap.js` | Host (node) | Pure mapping shared by `lib/board.js` (HTTP board) and `tools/mesh-snapshot.mjs` (offline SQLite board): lifecycle → five-state mapping, acceptance line splitting, event text extraction, task/event shaping. One implementation, two callers. |
| `lib/host.js` | Host (node) | Builds `api/host` from `node:os` + `fs.statfs` (C:/D: on Windows). Zero external dependencies; a failed `statfs` turns that disk's numbers into `null` instead of throwing. |
| `lib/client.js` | Browser | Registers `sidebar.panellist` (`id: dsh-html-panel`, icon + label) and the keyed `main` panel with the same key. On each iframe `load` it still fetches the **legacy** snapshot and `postMessage`s it in; the V6 page ignores that message. It also **bridges the DSH-side actions**: a `{type:'panel-action', action, requestId}` message is accepted only from this panel's own iframe, checked against a local whitelist, run through the real client services (`ctx.get('uiWorkspace').startSession(...)`), and answered with `{type:'panel-action-result'}`. It never touches the filesystem or spawns anything. |
| `public/index.html` | Page | The panel: V6 quick workbench + inline-SVG cluster topology. Cluster from `api/cluster`, tasks/events from `api/board`, widgets from `api/host`; labelled `MOCK` fallback per module. Buttons send `panel-action` to the parent window, POST `api/action` for Host work, or open the real board/Studio URL; receipts are rendered as 成功 / 失败 / 暂不支持 / 进行中. |
| `public/index.placeholder.html` | Page | The original 186-byte placeholder, kept only as a rollback copy. |
| `cordis.patch.yml` | Bundle | Inserts the plugin row into the profile roster. Board config lives in the profile's patch layer, not here. |
| `locale/{en,zh}.json` | Display | Plugin Manager title and description. |
| `tools/` | Dev only | Tests and evidence scripts, see **Acceptance**. Not needed at runtime. |

## Data source 1: `GET /api/cluster` (real interconnect)

The page calls `fetchJson('api/cluster')` — a relative URL, same origin as the page, so it
works under any mount prefix. The route is read-only and always answers JSON with `no-store`.

```js
{
  generatedAt: '2026-11-21T04:20:00.000Z',   // when this snapshot was built (ISO)
  interconnect: true,                        // is there a readable interconnect service?
  self: { instanceId: 'this-instance' },     // 'unknown' when it cannot be read
  peers: [
    { instanceId: 'peer-a', origin: '10.0.0.2:9100', link: 'up'   },
    { instanceId: 'peer-b', origin: '10.0.0.3:9101', link: 'down' }
  ],
  board: null,                               // reserved, kept for the old payload shape
  error: '读取 peers 失败'                     // only when the service exists but peers() threw
}
```

- **Only local, synchronous calls.** `peers()` and `selfSender('__probe__')` are read; the
  network-bound `ping()` / `list()` are never called, so opening the panel can never wait on
  a peer.
- **Origin is desensitized** to `host[:port]`: userinfo, scheme, path, query and fragment
  are stripped by `sanitizeOrigin()`. No credential can reach the page.
- **`link` only says `up` or `down`**: any other value is reported as `down`.
- Missing service answers `200` with `interconnect: false`; a throwing `peers()` answers
  `200` with `interconnect: true` and `error`.

## Data source 2: `GET /api/board` (shared board via `dsh-team-mesh`)

The board is served by the **`dsh-team-mesh` plugin's HTTP service** (default
`127.0.0.1:13090`). The Host half reads four read-only routes from it:

| Board route | Purpose |
|---|---|
| `GET /health` | reachability + service / version / schema version + latency |
| `GET /task/list?limit=20` | most recent tasks |
| `GET /task/evidence?taskId=…` | evidence count per task (`/task/list` has no such count) |
| `GET /events?limit=12` | most recent events |

Auth header: **`x-team-token: <boardToken>`** (same as `dsh-team-mesh/src/remote.js`). The
token is a string in `config.board.token` and **never leaves the request header**: it is not
in the page, not in the response body, not in error messages, not in logs.

Configure it in the **profile patch layer** (`%DSH_PROFILE_DIR%\cordis.patch.yml`), not in
this package:

```yaml
- id: dsh-html-panel
  config:
    board:
      endpoint: 'http://127.0.0.1:13090'
      token: '<boardToken>'      # same value as the dsh-team-mesh row
      timeoutMs: 4000            # clamped to 500..10000, default 4000
```

`endpoint` must be `http:` or `https:`. Its userinfo / path prefix / query are stripped from
the displayed origin (`source.origin` is only `http(s)://host[:port]`); query and fragment
are never used. Invalid config does not throw: the route answers `configured: false` with a
structured `error`, and the page shows 「板未配置」.

Response contract (always `200`, always `no-store`; the page reads `configured`/`error`):

```js
{
  generatedAt: '2026-11-21T06:00:00.000Z',
  configured: true,
  source: { origin: 'http://127.0.0.1:13090' },   // no token, no path/query
  health: { ok: true, latencyMs: 37, service: 'dsh-team-mesh board', version: '0.5.0', schema_version: 4 },
  tasks: [/* shared task shape, see below */],
  events: [/* { task, at, kind, node, text, seq } — newest first */],
  cached: false,
  error: { code: 'timeout', message: '连共享板超时（4000ms）：http://127.0.0.1:13090' }  // only on failure
}
```

- **Task shape** (same field names as `tools/mesh-snapshot.mjs`, one shared mapping in
  `lib/boardmap.js`): `id`, `title`, `state` (`leased` / `awaiting` / `undelivered` /
  `stale` / `done`, or the raw lifecycle when the board has no equivalent), `owner`
  (`owner_session`), `node` (`lease_host`, absent when null), `evidenceCount` (`null` when
  the per-task call failed), `requireReview`, `brief`, `acceptance[]`, `createdAt`,
  `updatedAt`, `leaseDeadline`, `ackDeadline`, `ackAt`, `expiredAt`, `doneAt`, plus raw
  `lifecycle` / `ackState`.
- **Events** carry `task` (empty string when the board event has no task), `at` (ms),
  `kind`, `node` (`actor` — the board has no host column), `text` (payload summary), `seq`.
- **3 s in-process cache**: a second read inside the window answers `cached: true` without
  touching the board, so a page refresh storm cannot hammer it. Errors are cached for the
  same window too.
- **Failure is data, not an exception**: unreachable / timeout / non-JSON / 401 / 500-turned-
  structured-error all become `{ configured: true, health, tasks: [], events: [], error }`.
  Error messages are origin-only (no userinfo, no token) and truncated.
- **No new dependency**: plain `fetch` + `AbortSignal.timeout`, timeout clamped to
  500–10000 ms.

### Lifecycle → five-state mapping (shared with the offline tool)

| # | board lifecycle / condition | panel state |
|---|---|---|
| 1 | `done` | `done` |
| 2 | `canceled` | passed through (page shows 「未知 · canceled」) |
| 3 | `stale=1`, or `lease_until <= now` | `stale` |
| 4 | `claimed` / `working` and lease still valid | `leased` |
| 5 | `blocked` | passed through (page shows its raw value) |
| 6 | `open` + `ack_state=pending/timeout` → `awaiting`; `acked` → `open` (pass through); none → `undelivered` |
| 7 | anything else | passed through / `unknown` |

Times are **milliseconds**, passed through unchanged. `acceptance` is one free-text string on
the board; it is split on newlines (that is the only convention the board documents).

## Data source 3: `GET /api/host` (local machine, read-only)

```js
{
  generatedAt: '2026-11-21T06:00:00.000Z',
  hostname: 'host-name',
  os: { platform: 'win32', release: '10.0.26340', uptimeSec: 25393 },
  memory: { totalBytes: 34148655104, freeBytes: 20615843021, ratio: 0.4 },  // ratio = used/total
  cpu: { count: 12, load1: 0 },                 // Windows loadavg is always 0 — reported as-is
  disks: [
    { mount: 'C:', label: 'C: 系统盘', totalBytes: 144955146240, freeBytes: 45956136960, ratio: 0.683, error: null },
    { mount: 'D:', label: 'D: 数据盘', totalBytes: 960251648000, freeBytes: 551814352896, ratio: 0.425, error: null }
  ]
}
```

- C: and D: are attempted on Windows (root partition elsewhere); a `statfs` failure leaves
  that disk's numbers `null` and records an `error` code — it never throws.
- Zero external dependencies, zero external links, nothing written anywhere.

## Legacy snapshot source (kept, not consumed by V6)

`/dsh-html-panel/snapshot.json` still works exactly as before: it reads a JSON file or URL
named in the plugin row's `config.snapshot` (`{ path, url }`, `path` wins, 5 s timeout,
4 MiB cap, `204` when nothing is configured, `502` with `{ type: 'snapshot-error', message }`
on failure), and `lib/client.js` forwards that body into the page with `postMessage`.
**Status: the V6 page ignores it.** Kept for the archived table page and a future wiring.

## Page behaviour (V6)

- **Top bar chips** — real values: ① `interconnect <up>/<total> up` from `api/cluster`;
  ② `板 在线 · <N>ms` / `板 不可达` / `板 未配置` from `api/board` health; ③ `板上 <N> 任务`;
  ④ a `数据过期 · HH:MM:SS / 原因` chip that only appears when a **poll** failed while the
  page already had good data.
- **Hero date line** — date + weekday, `实例 <self.instanceId>`, `板 <source.origin>` (or
  「板未配置」/「板不可达」), and the newest data timestamp. The old fake
  `DSH 0.4.0` / `127.0.0.1:13090` strings are gone.
- **Recent tasks** — board tasks with five-state badge + raw-state fallback, title, id,
  owner, node, evidence count, relative update time; row expands to raw lifecycle / ack
  state / timestamps / acceptance / brief. Empty → 「板上暂无任务」.
- **事件流** tab (replaces the mock 「最近文档」 tab) — board events: time, task, node, kind,
  text, newest first. Empty → 「暂无事件」.
- **本机状态 widgets** — disks (used / total, progress bar), memory (used / total / percent),
  board health (last `/health` latency). Header hint 「本机 · 只读」.
- **Common actions really run** (see **Action buttons**); receipts show 成功 / 失败 /
  暂不支持 / 进行中 with the real reason. Nothing says 「演示」/「未发送」. 「重启 DSH」 stays
  permanently disabled and says 「红线：不由面板重启 DSH」.
- **Polling**: `setInterval(..., 30000)` silently refreshes all three sources; skipped while
  `document.hidden`. A failed poll keeps the last good render and only sets the stale badge —
  it never falls back to mock mid-session. Mock is used **only** when the first load already
  failed, and the module says `mock 兜底 · <reason>`.
- Nothing white-screens: fetch failure, non-JSON, timeout, wrong shape, `configured:false`,
  `interconnect:false` all produce rendered states. No uncaught page errors.
- Layout is checked at 1440 and 900 wide (the sidebar iframe case): no horizontal overflow.
- All dynamic strings from the board are HTML-escaped before rendering (`esc()`).

## Action buttons (v0.3.0)

Six buttons; five are clickable, 「重启 DSH」 is permanently disabled (red line — the panel
never restarts, kills or takes over the DSH process).

| # | Button | Real behavior | When it cannot work | Needs DSH restart? |
|---|---|---|---|---|
| 1 | 新会话 (Ctrl+Alt+N) | Calls the **same API the shortcut binds**: `ctx.get('uiWorkspace').startSession()` (client half). Panel switches to the conversation view; no arguments, host default workspace/preset. | No `uiWorkspace` service → 「暂不支持：当前 DSH 客户端没有提供 uiWorkspace.startSession…请用 Ctrl+Alt+N」. Old client bundle (message timeout 2.5 s) → 「暂不支持：DSH 客户端 2.5 秒内没响应动作（client.js 改动需重启 DSH 后生效）」. | client bundle, yes |
| 2 | 派发任务 | **Never fakes dispatch.** The panel has no `mesh_*` tool channel (tool registry is agent-scoped), so it answers 「暂不支持：面板不能直接调用 mesh_* 任务工具…」 and offers a real fallback button: 在新会话草稿里填入 mesh_dispatch 提示 — which opens a real new session with an unsent draft prompt (`startSession(undefined,{prompt,whenDraftExists:'append'})`). | always unsupported for direct dispatch, by design | client bundle, yes |
| 3 | 打开看板 | Reads the board origin from the already-fetched `api/board` (`source.origin`) and `window.open`s it in a new tab. | Board unconfigured → 「暂不支持：共享板未配置…」; unreachable → 「失败：共享板不可达：<api/board 的结构化原因>」; popup blocked → reason + a clickable 手动打开 link. Button is **never silently disabled**: clicking always produces a receipt. | no (page-only) |
| 4 | 查记忆 | Host `POST api/action {action:'probe-memory'}` really GETs the configured OpenViking Studio origin (1.5 s timeout, redirects not followed). Reachable → the page opens that URL in a new tab and the receipt includes origin + latency. | Unreachable/timeout/HTTP error → 「失败：OpenViking 不可达（origin）：连接被拒绝（ECONNREFUSED）/ 超时 / HTTP n」; old host without the route → 「暂不支持：宿主还没有 api/action 路由…」. No tab is opened on failure. | Host route, yes |
| 5 | 读最新报告 | Host `POST api/action {action:'latest-report'}` stats the configured reports directory, picks the newest `*.md` by mtime, reads it (64 KiB cap, truncation flagged) and returns metadata + content; the page renders the content in a 「最新报告」 panel. Receipt also offers 「在资源管理器中打开报告目录」 (`open-reports-folder`, `spawn('explorer.exe',[fixedDir])`). | Directory missing / no `.md` / read error → 「失败：报告目录不存在 / 没有 .md 文件 / 报告读取失败：name（code）」. Old host → 暂不支持 as above. | Host route, yes |
| 6 | 重启 DSH | disabled forever. Tooltip/description: 「红线：不由面板重启 DSH」. `runRestart()` exists only as an unreachable fallback returning 「暂不支持：红线…」. | — | — |

**Protocol** (page ↔ browser half): the page posts `{type:'panel-action', action, requestId}`
to `window.parent`; the browser half accepts it only when `event.source === this panel's
iframe.contentWindow`, checks `action` against `['new-session','dispatch','dispatch-draft']`,
and replies `{type:'panel-action-result', requestId, action, at, ok, code?, reason?, detail?,
hint?}`. The page matches `requestId` and falls back to an honest timeout after 2.5 s.

**Protocol** (page ↔ Host): `POST api/action` with `content-type: application/json` and a
body of exactly `{"action":"<whitelisted id>"}`. Rejections, in order: non-POST → 405
(`Allow: POST`); `Origin` present but not this Host → 403; non-JSON content type → 415; body
> 4 KiB → 413; invalid JSON/object → 400; unknown action id → 400. Business failures answer
200 with `{ok:false, code, reason}` (same contract style as the read routes). Unexpected
throws answer a generic 500 — **no stack, no token, no echoed path**.

**Security boundary**: the request carries an action id only. Paths/URLs/programs are fixed
server-side (`config.actions.memory.url`, `config.actions.reports.dir`, built-in defaults);
the report file is resolved inside that directory and re-checked for escape; Explorer is
spawned with an argv array (never a shell string); no CORS headers are added. The browser
half never receives filesystem or process power — it can only call the two DSH client
services named above.

**Configuration** (optional; the defaults are the mcloud OpenViking Studio and
`%USERPROFILE%\mesh-0.6-dev\repo\docs`, so an existing panel keeps working without change):

```yaml
- id: dsh-html-panel
  config:
    board:
      endpoint: 'http://172.24.112.14:13090'
      token: '<boardToken>'
      timeoutMs: 4000
    actions:
      memory:
        url: 'http://172.24.112.11:1933/'   # OpenViking Studio origin (http/https, no credentials)
      reports:
        dir: 'C:\Users\ky614\mesh-0.6-dev\repo\docs'   # absolute; newest *.md is read
```

Changing this config, the browser half or any Host route needs a DSH restart; a page-only
change is visible after a GUI refresh.

## Acceptance v0.3.0 (this delivery, 2026-11-21)

Run on the Windows workstation, Node 24.19.0, headless Edge over CDP. This round's commands
and full numbers are in `tools/report-actions.md`; machine-readable logs in
`tools/shots/cdp-actions-report.json`.

| # | Claim | Result |
|---|---|---|
| A1 | `node --test tools/actions.test.mjs` (14 host cases): config normalization/defaults/credential rejection, whitelist, probe ok/timeout/refused/HTTP-error, newest `.md` selection, 64 KiB truncation, `explorer.exe` argv (`[fixedDir]`, no shell), method/origin/media-type/body-size/JSON/action envelope rejections, generic 500 without stack | **pass** |
| A2 | `node --test tools/client-actions.test.mjs` (8 cases): real `client.js` loaded in a `node:vm` sandbox (not a copy) — unknown ids refused, `new-session` → `uiWorkspace.startSession()` with no args, missing service → 暂不支持 + Ctrl+Alt+N, throwing accessor degraded, `dispatch` never calls a session/tool (hint only), `dispatch-draft` passes the mesh prompt with `whenDraftExists:'append'`, `apply()` mounts both slots + one message listener, browser half has no child-process/fs code | **pass** |
| A3 | `node tools/check-page.mjs`: 116/116 — plus new checks: no 「演示/未发送」 text, four receipt states + CSS, all five actions wired, same-origin `POST api/action` body shape, timeout/old-host failure strings, report preview ids + `textContent` rendering, disabled restart + red line | **pass** (116/116) |
| A4 | `node tools/cdp-actions.mjs`: 124 assertions over 6 scenarios — standalone page (real: board opens real origin tab, memory probe opens Studio tab, report content rendered from host fixture, secondary folder action, 6 receipts), board/OV/report unreachable (failures + reasons, no tab, no silent disable), old host 404 (暂不支持 + needs restart), stub parent (新会话/派发任务/草稿替代 over the real `panel-action` protocol), silent parent (2.5 s honest timeout), board unconfigured; every scenario 6 buttons / only restart disabled / no 演示 text / no JS error / same-origin only | **pass** (124/124, page JS errors 0) |
| A5 | Regression: pre-existing `tools/cdp-live.mjs` (252→253 assertions, updated only where behavior intentionally changed: board button stays clickable, receipt text is real) and the full `node --test tools/*.test.mjs` suite | **pass** |
| A6 | Two copies (source-of-truth and installed profile copy) byte-identical for every changed file; version `0.2.0 → 0.3.0`; UTF-8 without BOM | **pass** (sha256 in `tools/report-actions.md`) |
| A7 | Security spot checks: `GET api/action` → 405; foreign `Origin` → 403; `text/plain` → 415; >4 KiB → 413; unknown action → 400; no token in any response/page/log; no CORS headers | **pass** |
| A8 | Live read-only smoke of the **running, un-restarted DSH** page (headless Edge, `tools/shots/live-check.json` + `shot-actions-07-live-dsh-page.png`): real cluster/board/host data rendered (board source `http://172.24.112.11:13090`, health ok, 20 tasks), 「打开看板」 really opened the live board origin, 「查记忆」/「读最新报告」 answered the honest old-host receipt `暂不支持：宿主还没有可用的 api/action 路由（HTTP 405）：新版 Host 需要重启 DSH 后生效`, page JS errors 0 | **pass** |

**Not verified (stated as such, not as success):**

- The **new Host route and the new browser half were not observed inside the running DSH
  GUI**: the route needs a DSH restart and this round was forbidden to restart DSH. Evidence
  that the *page* is live-updated: the running DSH serves `public/index.html` read from disk
  on every request (`no-store`) — the live page's sha256 equals the source file (`91,681 B`,
  `ba448f…7a7`), a headless visit rendered real host/board data and produced the honest
  old-host receipts above. Until the restart the page answers the Host-side buttons with
  「暂不支持：宿主还没有可用的 api/action 路由（HTTP 405）…」 and the DSH-side buttons with the
  2.5 s timeout receipt — both are honest, not fake.
- The environment differs from the original brief: `api/board` now points at
  `http://172.24.112.11:13090` (mcloud) and is **online** (health ok, 20 tasks, 12 events,
  TCP true); `172.24.112.14:13090` is still offline. So 看板's success branch was verified
  against the live board origin as well as the fixture; its unreachable branch is covered by
  a structured `timeout` fixture.
- The real OpenViking probe was verified from this machine with HTTP (`172.24.112.11:1933` →
  200, `OpenViking Studio`) but not through the not-yet-restarted Host route; the CDP run uses
  fixtures for both directions.
- The `explorer.exe` spawn path is unit-tested with an injected fake spawn; no real Explorer
  window was opened by the test run.
- 「新会话」's DSH-visible effect (conversation opens) was verified against stubs and the
  first-party API contract (`uiWorkspace.startSession`, same call the Ctrl+Alt+N shortcut
  binds, `dsh-client-ui-workspace/src/client/shortcuts.ts`), not by clicking the live GUI;
  the live standalone page correctly reports the "needs the shell iframe" branch.

## Acceptance v0.2.0 (2026-11-21, kept as history)

Run on the Windows workstation with Node 24.19.0 and headless Edge over CDP. The Host routes
under test are the real `lib/index.js` mounted behind a stub `ctx` and reached over a real
HTTP socket, with a **fake board service** validating the `x-team-token` header. The page
under test is the real `public/index.html` served from a local same-origin server with
controllable fixtures for all three routes. Commands and full numbers are in
`tools/report-board-data.md`; machine-readable logs in `tools/shots/cdp-report.json`.

| # | Claim | Result |
|---|---|---|
| A | `node --test "tools/*.test.mjs"`: new board/host suite (15 cases) + pre-existing cluster suite + offline snapshot suite (123 assertions) all pass | **pass** (see report for counts) |
| B | Static check `node tools/check-page.mjs`: no external URL of any kind, only the three same-origin relative `api/*` paths, tags balanced, inline JS parses, single `MOCK`, no fake top-bar values, five-state classes, events tab, polling/hidden/stale strings, all data-target ids present | **pass** (99/99) |
| C | `/api/board` normal state: contract fields, `source.origin` desensitized (userinfo/path/query/token stripped), health field whitelist (the board's db path is not leaked), evidence counts, events newest-first, `x-team-token` present on every request, token absent from body, 3 s cache (`cached:true`, no extra board hit) | **pass** |
| D | `/api/board` failures: unreachable / timeout / non-JSON / 401 / structured board error / unconfigured each return a structured body; token and endpoint userinfo appear in neither response nor console; invalid config does not throw | **pass** |
| E | `/api/host`: ranges sane, C:/D: reported, memory ratio 0..1, statfs failure leaves numbers `null` without throwing | **pass** |
| F | Page real state (board 6 tasks + 8 events, cluster 0/4 up): chips, date line, five-state badges, evidence count / node / relative time, event stream, disk+memory+board-latency widgets, board action filled from origin, 4 topology nodes + 5 edges, only same-origin requests, no JS error | **pass** |
| G | Page states: board unreachable (tasks/events labelled mock, host stays real), unconfigured (empty states + grey button), empty board (「板上暂无任务」/「暂无事件」), cluster 404 (only topology falls back to mock) | **pass** |
| H | 30 s poll: after a real first load the board fixture turns into a timeout; after the poll the page still shows the same 6 real tasks, chip keeps the last latency, and only the `数据过期 · HH:MM:SS / 共享板：…超时…` badge appears (no mock flash) | **pass** |
| I | 900 px viewport: `scrollWidth == innerWidth`, no panel overflow; 6 screenshots captured | **pass** |
| J | V4 regression: clock ticks, action receipt, todo checkbox persisted to `localStorage`, tab switch, task row expand, 6 actions incl. disabled restart | **pass** |
| K | The two physical copies (source-of-truth directory and the installed copy under the profile's `node_modules`) are byte-identical for every file changed this round (sha256 list in the report) | **pass** |

**Not verified (stated as such, not as success):**

- The **real board was not exercised end-to-end**: the board endpoint was unreachable from
  this machine at delivery time (network down), so `/api/board` was only verified against a
  fake board service with the real token-header contract.
- The new Host routes were **not observed inside the running DSH GUI**: adding Host routes
  needs a DSH restart, and this round was explicitly forbidden to restart DSH. The running
  DSH still serves the old Host half (so `api/board`/`api/host` answer JSON 404 until the
  next restart), while the **page file itself is updated on disk and refreshes immediately**
  (the page then shows the labelled mock fallback for board/host).
- The page was exercised over same-origin HTTP with fixtures, not through the real shell
  iframe.

## Install

```
plugin_manager: install_bundle  target: C:\Users\Admin\dsh-plugins\dsh-html-panel
```

or, in the GUI, **Plugins → Add plugin → 本地目录** with the same directory.
The profile entry becomes `dsh-html-panel: file:...` and the bundle is selected in
`dsh.profile.bundles`.

**Board configuration** (profile patch layer, token placeholder — use the same value as the
`dsh-team-mesh` row's `boardToken`):

```yaml
- id: dsh-html-panel
  config:
    board:
      endpoint: 'http://127.0.0.1:13090'
      token: '<boardToken>'
      timeoutMs: 4000
```

First activation of a new package needs a DSH restart (a replaced module needs one too). In
particular, **new Host routes and the changed browser half only exist after DSH restarts**;
a page edit alone needs nothing but a refresh. Optional action config: see
**Configuration** in the Action buttons section (defaults work without it).

## Uninstall / rollback

```
plugin_manager: remove_bundle  target: dsh-html-panel
```

then restart DSH. Manual equivalent, if the tool is unavailable:

1. Remove the `"dsh-html-panel": "file:..."` line from `%DSH_PROFILE_DIR%\package.json`
   `dependencies` and the `"dsh-html-panel"` entry from `dsh.profile.bundles`.
2. Remove the `- id: dsh-html-panel` config block from `%DSH_PROFILE_DIR%\cordis.patch.yml`.
3. `pnpm remove dsh-html-panel` in `%DSH_PROFILE_DIR%` (or delete the linked
   `node_modules\dsh-html-panel` entry).
4. Restart DSH. The `/dsh-html-panel` route disappears with the Host half, and the sidebar
   row disappears with the browser half.

Page-only rollback (keeps the plugin, restores the placeholder):

```
copy /Y public\index.placeholder.html public\index.html
```

Removing `C:\Users\Admin\dsh-plugins\dsh-html-panel` alone is not enough while the profile
still lists it.
