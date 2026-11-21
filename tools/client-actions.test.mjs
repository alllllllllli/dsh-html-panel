#!/usr/bin/env node
/**
 * tools/client-actions.test.mjs —— 浏览器半 `lib/client.js` 的动作分派单元测试。
 * 零依赖，node:test + node:vm：在沙箱里加载真实的 client.js（不启动 DSH、不启动
 * 浏览器），把 `window.__DSH_HTML_PANEL_TEST__` 打开后取到测试钩子，直接验证
 * `runClientAction` 的每个分支与 `apply()` 的挂载行为。
 *
 * 用法: node --test tools/client-actions.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = resolve(ROOT, 'lib', 'client.js')

/** Load the real browser-half bundle in a sandbox and return its hooks. */
async function loadClientBundle() {
  const source = await readFile(CLIENT_FILE, 'utf8')
  const captured = []
  const listeners = []
  const windowObject = {
    __ModuleLoader__: { load: definition => captured.push(definition) },
    __DSH_HTML_PANEL_TEST__: true,
    location: { origin: 'http://127.0.0.1:51539' },
    addEventListener: (name, fn) => listeners.push({ name, fn }),
    removeEventListener: () => {},
    postMessage: () => {},
  }
  windowObject.window = windowObject
  const sandbox = {
    window: windowObject,
    document: { baseURI: 'http://127.0.0.1:51539/' },
    console,
    URL,
    setTimeout,
    clearTimeout,
    Date,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  assert.equal(captured.length, 1, 'client.js 只注册一个模块 factory')
  const definition = captured[0]
  assert.equal(definition.id, 'dsh-html-panel')
  const reactStub = {
    createElement: () => null,
    useRef: () => ({ current: null }),
  }
  const mod = definition.factory(spec => {
    if (spec === 'react') return reactStub
    throw new Error('unexpected require: ' + spec)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.equal(JSON.stringify(mod.inject), '["slots"]', '不硬依赖 uiWorkspace：面板必须能先挂起来')
  const hook = sandbox.window.__dshHtmlPanelTest
  assert.ok(hook && typeof hook.runClientAction === 'function', '测试钩子只在测试宿主里暴露')
  return { mod, hook, listeners, sandbox }
}

/** uiWorkspace stub recording startSession calls. */
function fakeUiWorkspace() {
  const calls = []
  return {
    calls,
    startSession(workspaceId, options) {
      calls.push({ workspaceId, options })
    },
  }
}

test('unknown / malformed action ids are refused before any service call', async () => {
  const { hook } = await loadClientBundle()
  for (const action of ['open-calculator', 'restart-dsh', '', null, 42]) {
    const result = hook.runClientAction(action, { get: () => fakeUiWorkspace() })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unknown-action')
  }
})

test('new-session calls the real uiWorkspace.startSession() entry with no arguments', async () => {
  const { hook } = await loadClientBundle()
  const uiWorkspace = fakeUiWorkspace()
  const result = hook.runClientAction('new-session', { get: name => (name === 'uiWorkspace' ? uiWorkspace : undefined) })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'session-requested')
  assert.match(result.detail, /uiWorkspace\.startSession/)
  assert.equal(uiWorkspace.calls.length, 1)
  assert.equal(uiWorkspace.calls[0].workspaceId, undefined)
  assert.equal(uiWorkspace.calls[0].options, undefined)
})

test('new-session without uiWorkspace says 暂不支持 and points at Ctrl+Alt+N', async () => {
  const { hook } = await loadClientBundle()
  const result = hook.runClientAction('new-session', { get: () => undefined })
  assert.equal(result.ok, false)
  assert.equal(result.unsupported, true)
  assert.equal(result.code, 'ui-workspace-unavailable')
  assert.match(result.reason, /Ctrl\+Alt\+N/)
})

test('a throwing service accessor degrades to 暂不支持 instead of throwing', async () => {
  const { hook } = await loadClientBundle()
  const result = hook.runClientAction('new-session', { get: () => { throw new Error('service exploded') } })
  assert.equal(result.ok, false)
  assert.equal(result.unsupported, true)
  assert.equal(result.code, 'ui-workspace-unavailable')
})

test('dispatch is never faked: unsupported reason + a real draft fallback hint', async () => {
  const { hook } = await loadClientBundle()
  const uiWorkspace = fakeUiWorkspace()
  const result = hook.runClientAction('dispatch', { get: () => uiWorkspace })
  assert.equal(result.ok, false)
  assert.equal(result.unsupported, true)
  assert.equal(result.code, 'mesh-tool-unavailable')
  assert.match(result.reason, /mesh_dispatch/)
  assert.equal(JSON.stringify(result.hint), JSON.stringify({ action: 'dispatch-draft', label: '在新会话草稿里填入 mesh_dispatch 提示' }))
  assert.equal(uiWorkspace.calls.length, 0, 'dispatch 不能偷偷调用任何会话/工具服务')
})

test('dispatch-draft opens a real draft with the mesh_dispatch prompt appended', async () => {
  const { hook } = await loadClientBundle()
  const uiWorkspace = fakeUiWorkspace()
  const result = hook.runClientAction('dispatch-draft', { get: () => uiWorkspace })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'draft-opened')
  assert.equal(uiWorkspace.calls.length, 1)
  const call = uiWorkspace.calls[0]
  assert.equal(call.workspaceId, undefined)
  assert.equal(call.options.whenDraftExists, 'append')
  assert.match(call.options.prompt, /mesh_task_create/)
  assert.match(call.options.prompt, /mesh_dispatch/)
})

test('apply() mounts the slots and listens for panel messages without touching DOM of the page', async () => {
  const { mod, listeners } = await loadClientBundle()
  const registrations = []
  const injections = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (slot, callback) => { injections.push(slot); callback() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.deepEqual(injections, ['main', 'sidebar.panellist'])
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.key, 'dsh-html-panel')
  assert.equal(registrations[1].options.id, 'dsh-html-panel')
  assert.equal(registrations[1].options.label, 'HTML 面板')
  const messageListeners = listeners.filter(item => item.name === 'message')
  assert.equal(messageListeners.length, 1, '只注册一个 message 监听')
  // 非本面板 iframe 的消息（source 不匹配）不能触发任何动作
  assert.doesNotThrow(() => messageListeners[0].fn({ source: null, data: { type: 'panel-action', action: 'new-session' } }))
  assert.equal(disposers.length, 1)
  assert.doesNotThrow(() => disposers[0]())
})

test('nothing in the browser half touches child processes or the filesystem', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  for (const forbidden of ['child_process', 'spawn(', 'explorer.exe', 'fs/promises', 'readFile(']) {
    assert.ok(!source.includes(forbidden), '浏览器半不应出现 ' + forbidden)
  }
})
