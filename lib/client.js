/**
 * Browser half of `dsh-html-panel`.
 *
 * Registers two seats that always travel together:
 *   - `sidebar.panellist` — the new navigation row (icon component + label);
 *     its list id is also the key of the main panel below.
 *   - `main` (keyed) — the panel body, which is a single iframe pointing at the
 *     Host route that serves this package's `public/index.html`.
 *
 * It also delivers the Host's read-only snapshot into that iframe. The Host
 * half (`lib/index.js`) produces the snapshot from a configured JSON file or
 * URL; this half fetches it once per iframe load and `postMessage`s it in,
 * because only the frame holding the `<iframe>` can post to it. No source
 * configured (204) means no message: the page keeps its empty state.
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
     * Resolve one file under the plugin's Host route against the document base,
     * so a sub-path mount keeps working. The shipped Web shell sets
     * `<base href="./">`.
     * @param file - File name inside `public/`.
     * @returns absolute URL of that file.
     */
    function routeUrl(file) {
      return new URL(ROUTE_PREFIX.replace(/^\//, '') + '/' + file, document.baseURI).href
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

    /** Navigation-row glyph: a framed page. */
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
      h('rect', { x: 2.2, y: 1.6, width: 11.6, height: 12.8, rx: 1.8 }),
      h('path', { d: 'M4.6 5.2h6.8M4.6 8h6.8M4.6 10.8h4.2' }))
    }

    /** Main-panel body: the plugin's own page, edge to edge. */
    function HtmlPanel() {
      const frame = React.useRef(null)
      return h('div', {
        style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }, h('iframe', {
        ref: frame,
        src: routeUrl(PAGE_FILE),
        title: 'HTML 面板',
        onLoad: () => { pushSnapshot(frame) },
        style: { flex: 1, minHeight: 0, width: '100%', border: '0', display: 'block', background: 'transparent' },
      }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, HtmlPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: 'HTML 面板',
        }, PanelIcon))
      },
    }
  },
})
