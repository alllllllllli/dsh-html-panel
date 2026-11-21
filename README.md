# dsh-html-panel

Sidebar row → main-area panel → the **V5 工作台 + 集群拓扑** page: a quick workbench
(clock, actions, receipts, recent tasks/docs, widgets, todos) with an inline-SVG cluster
topology on top.

The topology is fed by **real interconnect data**: the page fetches this plugin's own
read-only route `GET /dsh-html-panel/api/cluster`, which the Host half builds from the
running `ctx.interconnect` service (`peers()` / `selfSender()`). When that route or the
service is unavailable, the page keeps rendering its `MOCK` topology and **says so** in the
panel header — it never presents mock values as real.

The page is a real file: `public/index.html`. The Host half serves that directory at
`/dsh-html-panel/`, and the browser half iframes `/dsh-html-panel/index.html` into the main
panel. Editing the HTML and refreshing the GUI is the whole edit loop — no client rebuild,
no repackage.

The page has **no external references**: inline CSS and JS, no CDN, no external fonts,
icons or images, no third-party scripts. The only network request it makes is one
same-origin, relative `fetch('api/cluster')` (3 s timeout). Everything else on the page is
local mock data and is labelled as such.

## Layout

| Path | Half | Role |
|---|---|---|
| `lib/index.js` | Host (node) | Registers the `prefix` route `/dsh-html-panel` → `public/`, `no-store`, traversal-guarded. Answers the cluster child path `api/cluster` (built by `lib/cluster.js`) and keeps the legacy `snapshot.json` child path. Declares `inject: ['webServer', 'interconnect']`; a missing interconnect is tolerated (the route answers `interconnect: false`). |
| `lib/cluster.js` | Host (node) | Pure functions behind `api/cluster`: `buildCluster(interconnect)` turns `peers()` / `selfSender()` into the JSON contract, `sanitizeOrigin()` reduces an origin to `host[:port]`. No I/O, no dependencies, never throws. |
| `lib/client.js` | Browser | Registers `sidebar.panellist` (`id: dsh-html-panel`, icon + label) and the keyed `main` panel with the same key. On each iframe `load` it still fetches the **legacy** snapshot and `postMessage`s it in; the V5 page currently ignores that message. |
| `public/index.html` | Page | The panel: V5 quick workbench + inline-SVG cluster topology. Topology renders from `api/cluster` (real) or `MOCK.topology` (fallback, labelled). Other cards are mock. |
| `public/index.placeholder.html` | Page | The original 186-byte placeholder, kept only as a rollback copy. Nothing references it (it is still reachable at `/dsh-html-panel/index.placeholder.html` if you want to look at it). |
| `cordis.patch.yml` | Bundle | Inserts the plugin row into the profile roster. No config is needed for the cluster route. |
| `locale/{en,zh}.json` | Display | Plugin Manager title and description. |
| `tools/` | Dev only | Tests and evidence scripts, see **Acceptance**. Not needed at runtime. |

## Data source 1: `GET /api/cluster` (real interconnect)

The page calls `fetch('api/cluster')` — a relative URL, same origin as the page, so it works
under any mount prefix. The route is read-only and always answers JSON with `no-store`.

```js
{
  generatedAt: '2026-11-21T04:20:00.000Z',   // when this snapshot was built (ISO)
  interconnect: true,                        // is there a readable interconnect service?
  self: { instanceId: 'this-instance' },     // 'unknown' when it cannot be read
  peers: [
    { instanceId: 'peer-a', origin: '10.0.0.2:9100', link: 'up'   },
    { instanceId: 'peer-b', origin: '10.0.0.3:9101', link: 'down' }
  ],
  board: null,                               // reserved: no board data is wired yet
  error: '读取 peers 失败'                     // only when the service exists but peers() threw
}
```

- **Only local, synchronous calls.** `peers()` and `selfSender('__probe__')` are read; the
  network-bound `ping()` / `list()` are never called, so opening the panel can never wait on
  a peer.
- **Origin is desensitized** to `host[:port]`: userinfo, scheme, path, query (which may
  carry a token) and fragment are stripped by `sanitizeOrigin()`. A function origin (the
  `self` route form) or an unparsable one becomes `null`, rendered as 「未配置或无固定
  host:port」. No credential can reach the page.
- **`link` only says `up` or `down`**: any other value is reported as `down`, never as
  online.
- **Missing service is not an error.** No `ctx.interconnect` (or one without `peers`)
  answers `200` with `interconnect: false`; if `peers()` throws, the answer is `200` with
  `interconnect: true` and `error`. The page treats both as "no real data" and falls back.
- Other methods (`POST`, `PUT`, `DELETE`, …) answer `405` with
  `{ ok: false, error: 'method-not-allowed' }` and `Allow: GET, HEAD`; every unknown
  `api/…` path answers `404` with `{ ok: false, error: 'not-found' }`. Both are JSON, never
  HTML.
- No new dependency, no config change: `inject` is a module-level declaration, and the route
  is resolved per request (a service that activates later is picked up without a restart).

## Data source 2: the legacy snapshot (present, but not consumed by V5)

`/dsh-html-panel/snapshot.json` still works exactly as before: it reads a JSON file or URL
named in the plugin row's `config.snapshot` (`{ path, url }`, `path` wins, 5 s timeout,
4 MiB cap, `204` when nothing is configured, `502` with `{ type: 'snapshot-error', message }`
on failure), and `lib/client.js` forwards that body into the page with `postMessage`.

**Status: no page uses it right now.** The V5 page renders tasks, documents, actions,
widgets and the legacy snapshot message is ignored; those cards are mock. The route and the
`postMessage` delivery are kept for the archived table page and for a future wiring, and their
payload shape (`{ type: 'snapshot', generatedAt, source, tasks, events, nodes }`) is unchanged
from the previous delivery. Do not describe the task list as live data until somebody
actually wires it up.

## Page behaviour (V5 topology)

Four fixed slots are matched by `instanceId`; the layout never changes with the data:

| Slot | Position | Source |
|---|---|---|
| `mcloud` | top centre | peer row |
| `pc-ky614` | bottom left | peer row, or **online** when it is `self.instanceId` |
| `server` | bottom centre | peer row |
| `s5` | bottom right | peer row |

- `link === 'up'` → **online** (blue border); `link === 'down'` → **offline** (grey);
  not present in `peers` → **unknown** (dashed grey, title says 「未在 interconnect 配置」).
- Any configured peer outside the four slots (e.g. `cloud`) is listed under the legend as
  「其它已配置对端：cloud（down）」 instead of being forced into the fixed layout.
- The hollow circle under `server` stays 「待接入 · 未知」: it is not a configured peer.
- Node `<title>`s only contain fields the page actually has — instance id, `origin`
  `host[:port]`, link `up|down`, a 「本实例」 marker and the snapshot time. There is no
  heartbeat concept in this data, so no heartbeat is shown.
- Header badge: `真实 · interconnect · 生成 HH:MM:SS` (green dot) when real data rendered;
  `mock 兜底 · 真实数据不可用：<short reason>` (amber dot) otherwise, with the short reason
  being e.g. `HTTP 404`, `响应不是 JSON`, `超时 3s`, `结构不符`, `本实例没有 interconnect
  服务`. The same badge text is mirrored into the SVG `<title>`.
- Fallback is total: fetch failure, non-JSON body, 3 s timeout, a payload whose shape does
  not match the contract, or `interconnect: false` all keep the mock render. The page never
  white-screens and never throws.
- Layout is fixed at 1440 and 900 wide (the sidebar iframe case): the 900 px viewport has no
  horizontal overflow and the topology does not overflow its panel.

## Acceptance (this delivery, 2026-11-21)

Run on the Windows workstation with the bundled Node 24.19.0 and headless Edge over CDP. The
Host route under test is the real `lib/index.js` mounted behind a stub `ctx` and reached over
a real HTTP socket; the page under test is the real `public/index.html` served from a local
same-origin server with controllable `api/cluster` fixtures. Commands and full numbers are in
`tools/report-real-data.md`; machine-readable logs in `tools/shots/cdp-report.json`.

| # | Claim | Result |
|---|---|---|
| A | `node --test "tools/*.test.mjs"`: new route + sanitization suite (16 cases) plus the pre-existing snapshot suite (123 assertions) all pass | **pass** (17/17 test files/cases, 0 fail) |
| B | Static check `node tools/check-page.mjs`: no external URL of any kind, exactly one same-origin relative `fetch('api/cluster')`, tags balanced, inline JS parses, single `MOCK`, 4 slots / 5 edges, no heartbeat wording, badge elements present, 900 px breakpoint present | **pass** (54/54) |
| C | Route over HTTP: 200 contract fields; an origin carrying userinfo, path, query and fragment is reduced to `host:port` and none of those fragments appear in the body (the case uses fake values); `405` JSON for `POST`/`PUT`/`DELETE`; unknown `api/*` → JSON `404`; encoded traversal → `403`; page file still `200`; legacy snapshot (unconfigured) still `204`; no interconnect → `200` + `interconnect:false`; throwing `peers()` → `200` + structured `error` | **pass** |
| D | Page, fixture `self=pc-ky614, server up, s5 down, cloud down, mcloud 未配置`: badge `真实 · interconnect` + 生成时间; node statuses `unknown, online, online, offline`; 4 nodes + 1 pending, 5 edges; titles contain 「链路：up」/「链路：down」/「本实例」/「未在 interconnect 配置」; 「其它已配置对端：cloud（down）」 shown; only same-origin requests; no JS error | **pass** |
| E | Page fallbacks: route 404, non-JSON, 3 s timeout, shape mismatch and `interconnect:false` each keep the mock render with the matching reason in the badge; no JS error; mock node titles are marked 「mock 示例」 | **pass** |
| F | 900 px viewport: `scrollWidth == innerWidth`, topology panel and SVG do not overflow; 3 screenshots captured (1440 real, 1440 fallback, 900 topology close-up) | **pass** |
| G | V4 regression: clock ticks, action receipt appears, todo checkbox is written to `localStorage`, tabs switch, 6 action buttons incl. the disabled restart button | **pass** |
| H | The two physical copies (source-of-truth directory and the installed copy under the profile's `node_modules`) are byte-identical for every file changed this round (sha256 list in the report) | **pass** |

**Not verified (stated as such, not as success):**

- The new Host route and the live page were **not** observed inside the running DSH GUI.
  Adding a Host route needs a DSH restart, and this round was explicitly forbidden to restart
  DSH. The route was exercised as the real module over HTTP behind a stub `ctx`; the page was
  exercised over same-origin HTTP with fixtures, not through the real shell/iframe.
- The real interconnect state at delivery time is: four peers configured
  (`server`, `s5`, `cloud`, `mcloud`), **all links down** because the VNT virtual adapter is
  not up. So the live panel will currently show `pc-ky614` online and the other three slots
  offline (with `cloud` under 「其它已配置对端」). That is a link-state fact, not missing
  configuration; the page turns them online by itself once the links come back.
- The `board` field is always `null`: no board/task data source is wired, so tasks and
  documents stay mock.

## Install

```
plugin_manager: install_bundle  target: C:\Users\Admin\dsh-plugins\dsh-html-panel
```

or, in the GUI, **Plugins → Add plugin → 本地目录** with the same directory.
The profile entry becomes `dsh-html-panel: file:...` and the bundle is selected in
`dsh.profile.bundles`.

First activation of a new package needs a DSH restart (a replaced module needs one too). In
particular, a **new Host route only exists after DSH restarts**; a page edit alone needs
nothing but a refresh.

## Uninstall / rollback

```
plugin_manager: remove_bundle  target: dsh-html-panel
```

then restart DSH. Manual equivalent, if the tool is unavailable:

1. Remove the `"dsh-html-panel": "file:..."` line from
   `%DSH_PROFILE_DIR%\package.json` `dependencies` and the `"dsh-html-panel"` entry from
   `dsh.profile.bundles`.
2. `pnpm remove dsh-html-panel` in `%DSH_PROFILE_DIR%` (or delete the linked
   `node_modules\dsh-html-panel` entry).
3. Restart DSH. The `/dsh-html-panel` route disappears with the Host half, and the sidebar
   row disappears with the browser half.

Page-only rollback (keeps the plugin, restores the placeholder):

```
copy /Y public\index.placeholder.html public\index.html
```

`lib/index.js`, `lib/cluster.js` and `lib/client.js` stay compatible with the placeholder
page: it simply never fetches `api/cluster` and never answers a `snapshot` message. Deleting
`C:\Users\Admin\dsh-plugins\dsh-html-panel` alone is not enough while the profile still
lists it.
