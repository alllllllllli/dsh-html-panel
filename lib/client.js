/**
 * Browser half of `dsh-html-panel` (v0.4.0 — the sidebar entry is named 大管家).
 *
 * Registers two seats that always travel together:
 *   - `sidebar.panellist` — the navigation row (icon component + label 大管家);
 *     its list id is also the key of the main panel below.
 *   - `main` (keyed) — the panel body, which is a single iframe pointing at the
 *     Host route that serves this package's `public/index.html`.
 *
 * Renaming note (0.3.0 → 0.4.0): only the display label / iframe title / icon
 * changed here. `PANEL_ID` and the route prefix stay `dsh-html-panel` so the
 * stored panel key and the page URL do not move. The shell serves plugin client
 * bundles from an immutable in-memory batch built at boot, so the new label
 * shows after a DSH restart; the page itself is read from disk on every request
 * and takes effect on refresh.
 * It also delivers the Host's read-only snapshot into that iframe. The Host
 * half (`lib/index.js`) produces the snapshot from a configured JSON file or
 * URL; this half fetches it once per iframe load and `postMessage`s it in,
 * because only the frame holding the `<iframe>` can post to it. No source
 * configured (204) means no message: the page keeps its empty state.
 *
 * **Action bridge (v0.3.0).** The page cannot touch DSH client services, and
 * this half cannot touch the filesystem or spawn processes — so the two split
 * the panel's buttons:
 *   - DSH-side actions (`new-session`, `dispatch` + its `dispatch-draft`
 *     fallback) arrive here as `{ type:'panel-action', action, requestId }`,
 *     are checked against the local whitelist, and run through the real client
 *     services (`ctx.get('uiWorkspace').startSession(...)` — the same call the
 *     Ctrl+Alt+N shortcut binds). The answer goes back as
 *     `{ type:'panel-action-result', requestId, ok, ... }`.
 *   - Host-side actions (`probe-memory`, `latest-report`,
 *     `open-reports-folder`) are POSTed by the page itself to the Host's
 *     `/dsh-html-panel/api/action` route; nothing here touches them.
 * The message is only accepted from this panel's own iframe window, so a
 * sibling frame (or a foreign window) cannot drive the panel's actions.
 *
 * The action bridge needs a DSH restart to load: the shell serves plugin client
 * bundles from an immutable in-memory batch built at boot
 * (`dsh-client-modules/src/index.ts`, `bundleResource`), so an old bundle keeps
 * answering with `client-timeout` until DSH restarts. The page says so in its
 * receipt instead of pretending the click did anything.
 *
 * No styles of its own beyond the flex box that gives the iframe the panel's
 * height: the page inside is the deliverable and it is styled (or not) there.
 */
window.__ModuleLoader__.load({
  id: 'dsh-html-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Sidebar list id; must equal the keyed `main` panel key. */
    const PANEL_ID = 'dsh-html-panel'
    /** Host route prefix owned by `lib/index.js`. */
    const ROUTE_PREFIX = '/dsh-html-panel'
    /** File the Host half serves from `public/`. */
    const PAGE_FILE = 'index.html'
    /** Reserved Host route that answers the read-only snapshot. */
    const SNAPSHOT_FILE = 'snapshot.json'

    /**
     * Actions this half is allowed to run. The page sends ids only; anything
     * else is refused without touching a DSH service.
     */
    const CLIENT_ACTIONS = Object.freeze(['new-session', 'dispatch', 'dispatch-draft'])

    /**
     * Draft text for the `dispatch` fallback: it lands in a real new session's
     * composer (unsent), where the agent owns the mesh tools. Kept plain so the
     * operator can fill in the blanks.
     */
    const DISPATCH_PROMPT = [
      '请用 mesh 任务工具派发一条任务：',
      '1) 用 mesh_task_create 建任务卡（写清标题/验收标准）；',
      '2) 用 mesh_dispatch 把任务卡投给目标实例的会话。',
      '任务标题：',
      '任务要求（背景、验收、期望回报）：',
    ].join('\n')

    /** The `<iframe>` element currently on screen; message source validation. */
    let currentFrame = null
    /** Root client context captured in `apply`, for soft service lookup. */
    let rootCtx = null

    /**
     * Resolve one file under the plugin's Host route against the document base,
     * so a sub-path mount keeps working. The shipped Web shell sets
     * `<base href="./">`.
     * @param file - File name inside `public/`.
     * @returns absolute URL of that file.
     */
    function routeUrl(file) {
      return new URL(ROUTE_PREFIX.replace(/^\//, '') + '/' + file, document.baseURI).href
    }

    /** Post one protocol message into the page frame; no-op once it is gone. */
    function replyToFrame(target, message) {
      if (!target || typeof target.postMessage !== 'function') return
      let targetOrigin = '*'
      try {
        if (window.location && window.location.origin && window.location.origin !== 'null') {
          targetOrigin = window.location.origin
        }
      } catch {
        /* keep '*' */
      }
      try {
        target.postMessage(message, targetOrigin)
      } catch {
        /* frame was torn down between the click and the answer */
      }
    }

    /**
     * Soft service read: the panel must keep working on a DSH build that does
     * not provide a client service (an injected hard dependency would fail the
     * whole plugin instead of one button).
     * @param name - client service name, e.g. `uiWorkspace`.
     * @returns the service, or undefined.
     */
    function clientService(name) {
      try {
        return rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Read one service through a `{ get }` accessor without letting a throwing
     * accessor escape into the button's result (it becomes "unavailable").
     */
    function readService(services, name) {
      try {
        return services && typeof services.get === 'function' ? services.get(name) : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Run one whitelisted panel action with the DSH client services.
     *
     * Pure by design (`services.get` is the only dependency) so the behavior is
     * unit-testable without a browser shell: every branch returns a structured
     * `{ ok, code?, unsupported?, reason?, detail?, hint? }` and never throws.
     *
     * @param action - action id from the page.
     * @param services - `{ get(name) }` accessor for client services.
     * @returns the result body posted back to the page.
     */
    function runClientAction(action, services) {
      if (typeof action !== 'string' || !CLIENT_ACTIONS.includes(action)) {
        return { ok: false, code: 'unknown-action', reason: '未知动作：不在面板动作白名单里' }
      }
      if (action === 'dispatch') {
        // 不伪造派发：面板没有 mesh_* 工具的调用通道（工具注册表只给 agent 用），
        // 所以如实说明，并给出真实可用的替代步骤。
        return {
          ok: false,
          unsupported: true,
          code: 'mesh-tool-unavailable',
          reason: '面板不能直接调用 mesh_* 任务工具：mesh_dispatch 需要任务卡与会话目标，面板没有 agent 上下文。',
          hint: { action: 'dispatch-draft', label: '在新会话草稿里填入 mesh_dispatch 提示' },
        }
      }
      const uiWorkspace = readService(services, 'uiWorkspace')
      if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
        return {
          ok: false,
          unsupported: true,
          code: 'ui-workspace-unavailable',
          reason: '当前 DSH 客户端没有提供 uiWorkspace.startSession（新建会话入口），请用 Ctrl+Alt+N。',
        }
      }
      if (action === 'new-session') {
        uiWorkspace.startSession()
        return {
          ok: true,
          code: 'session-requested',
          detail: '已调用 DSH 新会话入口（uiWorkspace.startSession，与 Ctrl+Alt+N 同一个 API）；面板会切到会话视图。',
        }
      }
      uiWorkspace.startSession(undefined, { prompt: DISPATCH_PROMPT, whenDraftExists: 'append' })
      return {
        ok: true,
        code: 'draft-opened',
        detail: '已打开 DSH 新会话，并在输入框填入 mesh_dispatch 提示草稿（草稿不会自动发送；发送后由代理执行派发）。',
      }
    }

    /**
     * Handle one `message` event from this panel's iframe.
     * @param event - DOM message event.
     */
    function onPanelMessage(event) {
      const frame = currentFrame
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'panel-action') return
      const action = typeof data.action === 'string' ? data.action : ''
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      let result
      try {
        result = runClientAction(action, { get: clientService })
      } catch (error) {
        // 客户端服务抛错也不能把 stack 送回页面：一句人话足够。
        result = {
          ok: false,
          code: 'action-exception',
          reason: '动作执行异常：' + String((error && error.message) || error).slice(0, 160),
        }
      }
      replyToFrame(event.source, {
        type: 'panel-action-result',
        requestId,
        action,
        at: Date.now(),
        ...result,
      })
    }

    /**
     * Fetch the Host's snapshot and push it into the page frame.
     *
     * Runs on every iframe load, so re-entering the panel re-syncs and the page
     * may receive the same snapshot repeatedly (it replaces, never appends).
     * A missing source or a failure still delivers a message, so the page can
     * explain itself instead of looking stuck.
     *
     * @param frame - Ref holding the `<iframe>` element.
     */
    async function pushSnapshot(frame) {
      const element = frame.current
      const target = element && element.contentWindow
      if (!target) return
      const url = routeUrl(SNAPSHOT_FILE)
      const parsed = new URL(url)
      // Same origin as this shell in practice; a `file:` base has origin "null".
      const targetOrigin = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '*'
      let payload
      try {
        const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
        if (response.status === 204) return // no data source configured: page keeps its empty state
        if (!response.ok) {
          payload = { type: 'snapshot-error', message: '宿主快照路由返回 HTTP ' + response.status }
        } else {
          payload = await response.json()
          if (!payload || typeof payload !== 'object') {
            payload = { type: 'snapshot-error', message: '宿主快照不是 JSON 对象' }
          }
        }
      } catch (error) {
        payload = { type: 'snapshot-error', message: String((error && error.message) || error) }
      }
      target.postMessage(payload, targetOrigin)
    }

    /** Navigation-row glyph: a console prompt (大管家 / 总控). */
    function PanelIcon({ size }) {
      const edge = size ?? 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: edge,
        height: edge,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', { x: 1.8, y: 2.4, width: 12.4, height: 11.2, rx: 2 }),
      h('path', { d: 'M4.6 6.1l2.2 1.8-2.2 1.8' }),
      h('path', { d: 'M8.9 9.7h2.7' }))
    }

    /** Main-panel body: the plugin's own page, edge to edge. */
    function HtmlPanel() {
      const frame = React.useRef(null)
      return h('div', {
        style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }, h('iframe', {
        ref: element => {
          frame.current = element
          currentFrame = element
        },
        src: routeUrl(PAGE_FILE),
        title: '大管家 · DSH 控制台',
        onLoad: () => { pushSnapshot(frame) },
        style: { flex: 1, minHeight: 0, width: '100%', border: '0', display: 'block', background: 'transparent' },
      }))
    }

    // 单测钩子：只在测试宿主显式打开时暴露（生产页面/面板拿不到它）。
    // 放在 factory 里而不是 apply 里，单元测试无需伪造完整的 slots 宿主。
    if (typeof window !== 'undefined' && window.__DSH_HTML_PANEL_TEST__ === true) {
      window.__dshHtmlPanelTest = { runClientAction, CLIENT_ACTIONS }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        rootCtx = ctx
        const listener = event => onPanelMessage(event)
        // cordis 的 effect 会随插件卸载移除监听；没有 effect 的老宿主也照常挂上。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            window.addEventListener('message', listener)
            return () => {
              window.removeEventListener('message', listener)
              currentFrame = null
            }
          }, 'dsh-html-panel: panel action messages')
        } else {
          window.addEventListener('message', listener)
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, HtmlPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: '大管家',
        }, PanelIcon))
      },
    }
  },
})
