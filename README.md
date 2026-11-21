# dsh-html-panel

Sidebar row → main-area panel → the **V6 工作台 + 集群拓扑** page: a quick workbench
(clock, actions, receipts, recent board tasks, event stream, local widgets, todos) with an
inline-SVG cluster topology on top.

Version **0.2.0** — the first release where the page is fed by **three real, read-only,
same-origin routes** instead of mock data:

| Route | Data |
|---|---|
| `GET /dsh-html-panel/api/cluster` | this instance's live interconnect links (`ctx.interconnect`) |
| `GET /dsh-html-panel/api/board` | the shared board's tasks / events / health (`dsh-team-mesh` HTTP service, token header) |
| `GET /dsh-html-panel/api/host` | the local machine's memory / CPU / disks (`node:os` + `fs.statfs`) |

Every module falls back to its own clearly-labelled mock only when its source fails on the
first load; a later poll failure keeps the last good data and only adds a
`数据过期 · HH:MM:SS / 原因` badge. The page never presents mock values as real.

The page is a real file: `public/index.html`. The Host half serves that directory at
`/dsh-html-panel/`, and the browser half iframes `/dsh-html-panel/index.html` into the main
panel. Editing the HTML and refreshing the GUI is the whole edit loop — no client rebuild,
no repackage. **A new Host route, however, only exists after DSH restarts.**

The page has **no external references**: inline CSS and JS, no CDN, no external fonts,
icons or images, no third-party scripts. The only network requests are the three
same-origin relative paths above.

## Layout

| Path | Half | Role |
|---|---|---|
| `lib/index.js` | Host (node) | Registers the `prefix` route `/dsh-html-panel` → `public/`, `no-store`, traversal-guarded. Dispatches the three `api/…` child paths, keeps the legacy `snapshot.json` child path. Declares `inject: ['webServer', 'interconnect']`; a missing interconnect is tolerated (the cluster route answers `interconnect: false`). |
| `lib/cluster.js` | Host (node) | Pure functions behind `api/cluster`: `buildCluster(interconnect)` turns `peers()` / `selfSender()` into the JSON contract, `sanitizeOrigin()` reduces an origin to `host[:port]`. No I/O, no dependencies, never throws. |
| `lib/board.js` | Host (node) | Reader behind `api/board`: parses `config.board`, calls the board's read-only routes with `x-team-token`, maps tasks/events, keeps a 3 s in-process cache, and folds every failure into a structured JSON body (never throws, never echoes the token). |
| `lib/boardmap.js` | Host (node) | Pure mapping shared by `lib/board.js` (HTTP board) and `tools/mesh-snapshot.mjs` (offline SQLite board): lifecycle → five-state mapping, acceptance line splitting, event text extraction, task/event shaping. One implementation, two callers. |
| `lib/host.js` | Host (node) | Builds `api/host` from `node:os` + `fs.statfs` (C:/D: on Windows). Zero external dependencies; a failed `statfs` turns that disk's numbers into `null` instead of throwing. |
| `lib/client.js` | Browser | Registers `sidebar.panellist` (`id: dsh-html-panel`, icon + label) and the keyed `main` panel with the same key. On each iframe `load` it still fetches the **legacy** snapshot and `postMessage`s it in; the V6 page ignores that message. |
| `public/index.html` | Page | The panel: V6 quick workbench + inline-SVG cluster topology. Cluster from `api/cluster`, tasks/events from `api/board`, widgets from `api/host`; labelled `MOCK` fallback per module. |
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
- **Common actions stay a static prototype** (clicking records a local receipt only). The
  one exception is 「打开看板」: its address is filled from `source.origin` once the board is
  reachable; when the board is not configured/unreachable the button is disabled and says
  why. No fake address remains anywhere.
- **Polling**: `setInterval(..., 30000)` silently refreshes all three sources; skipped while
  `document.hidden`. A failed poll keeps the last good render and only sets the stale badge —
  it never falls back to mock mid-session. Mock is used **only** when the first load already
  failed, and the module says `mock 兜底 · <reason>`.
- Nothing white-screens: fetch failure, non-JSON, timeout, wrong shape, `configured:false`,
  `interconnect:false` all produce rendered states. No uncaught page errors.
- Layout is checked at 1440 and 900 wide (the sidebar iframe case): no horizontal overflow.
- All dynamic strings from the board are HTML-escaped before rendering (`esc()`).

## Acceptance (this delivery, 2026-11-21)

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
particular, **new Host routes only exist after DSH restarts**; a page edit alone needs
nothing but a refresh.

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
