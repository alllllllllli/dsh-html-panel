/**
 * 大管家「领导预设」的 agent-plane 插件（0.8.1，2026-11-27 主人拍板「单做」）。
 *
 * 职责只有一件：**把继承来的全局工具裁到领导白名单，同时保留预设自挂的 scoped 工具**。
 *
 * 0.8.0 的弯路（实测教训）：在预设作用域用 `tools.restrict({ allow })` 做白名单，会把
 * 「从该作用域继承的工具」**全部**按 allow 过滤 —— 包括同一预设里 `team_task_*`、
 * `subagent`、`schedule_*`、`todo_write` 这些 scoped 工具，结果大管家只剩 21 个全局白名单工具。
 *
 * 0.8.1 的口径：**用 deny 差集，不用 allow**。
 *   - 只 deny「全局工具里不在白名单内的那些」——预设自挂的 scoped 工具不在全局清单里，
 *     因此不会被 deny 命中，正常暴露；
 *   - 全局执行类（shell/文件/浏览器/MCP 执行/office…）一个不剩；
 *   - 全局工具集合可能变化（MCP 重连等）：监听 `tools/change`，重算差集、换一条 restriction。
 *
 * 本插件只应挂在 `@deepseek-ai/dsh-agent-preset` 的 `plugins` 里（agent 作用域）。
 *
 * 0.8.1 补丁（2026-11-27 主人拍板）：**挂上来的 agent/created 自动开启 Team 模式**。
 * `team_task_*` 是宿主全局工具，由 `agentTeams.isEnabled(rootSession)` 门控、默认关闭；
 * 面板「创建/重建专属会话」走的就是 `sessionController.create({agentPreset:'butler-lead'})`，
 * 本插件在该预设作用域监听 `agent/created`，给新根会话调官方 `agentTeams.setEnabled(agent, true)`，
 * 这样以后每次重建都不用手工补开 Team 模式（失败只记日志，不影响会话创建）。
 */

/** 允许大管家看见的**全局**工具（预设自挂的 scoped 工具不需要列在这里）。 */
export const TOOL_WHITELIST = Object.freeze([
  // 跨机任务板（dsh-team-mesh）
  'mesh_peers',
  'mesh_peer_probe',
  'mesh_dispatch',
  'mesh_events',
  'mesh_inbox',
  'mesh_task_create',
  'mesh_task_list',
  'mesh_task_claim',
  'mesh_task_heartbeat',
  'mesh_task_report',
  'mesh_task_complete',
  'mesh_task_cancel',
  'mesh_task_ack',
  'mesh_task_adopt',
  // 跨实例通信（dsh-interconnect）
  'interconnect_peers',
  'interconnect_list',
  'interconnect_ping',
  'interconnect_send',
  'interconnect_reply',
  // 只读记忆检索（OpenViking MCP；不包含 write/edit/remember）
  'mcp__openviking__find',
  'mcp__openviking__search',
  // Team 共享任务板（宿主全局工具；由 Team 模式门控，未开启时不出现）
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
])

/** 执行类工具清单：仅作文档（0.8.1 靠 deny 差集覆盖它们，不再手工点名）。 */
export const TOOL_DENY = Object.freeze([
  'bash', 'pwsh', 'persistent_pwsh', 'job_output', 'job_kill',
  'read', 'write', 'edit', 'apply_patch', 'glob', 'grep',
  'working_directory', 'web_search', 'web_fetch', 'present',
  'sandbox_exec', 'run_code',
])

/** DSH 插件名（Loader 展示用）。 */
export const name = 'butler-preset'

/** 只依赖工具服务；预设挂载时该服务在预设作用域里必然存在。 */
export const inject = ['tools', 'agentTeams']

/** 本预设自动开过 Team 模式的会话 id（诊断用；只增不减）。 */
export const enabledAgents = []

/**
 * 从 tools 服务读出当前 **全局视图** 的全部工具名。
 * @param {object} tools dsh-tools 服务
 * @returns {string[]} 去重后的工具名（不含预设 scoped 工具）
 */
function globalToolNames(tools) {
  if (typeof tools.definitions !== 'function') return []
  const definitions = tools.definitions()
  const names = new Set()
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (definition && typeof definition.name === 'string' && definition.name !== '') names.add(definition.name)
  }
  return [...names]
}

/**
 * 计算一条 deny 差集 restriction：保留白名单，deny 其余全局工具。
 * scoped 工具名不会出现在 `globalNames` 里，因此不会被 deny。
 *
 * @param {readonly string[]} globalNames 当前全局工具名
 * @param {readonly string[]} [allowed] 白名单（默认 {@link TOOL_WHITELIST}）
 * @returns {{allow: string[], deny: string[]}} restrict 入参
 */
export function planRestriction(globalNames, allowed = TOOL_WHITELIST) {
  const allow = [...new Set(allowed)].filter(item => typeof item === 'string' && item.trim() !== '')
  const keep = new Set(allow)
  const deny = [...new Set(globalNames)]
    .filter(item => typeof item === 'string' && item !== '' && !keep.has(item))
    .sort()
  return { allow, deny }
}

/**
 * 在预设作用域收紧全局工具。
 *
 * @param {object} ctx 插件上下文（预设作用域）
 * @param {{allow?: string[]}} [config] 可选白名单覆盖；缺省用 {@link TOOL_WHITELIST}
 */
export function apply(ctx, config) {
  const shape = config && typeof config === 'object' ? config : {}
  const allowed = shape.allow === undefined
    ? [...TOOL_WHITELIST]
    : (Array.isArray(shape.allow) ? shape.allow.filter(item => typeof item === 'string' && item.trim() !== '') : [])
  if (allowed.length === 0) {
    throw new Error('butler-preset: config.allow 不能为空；领导预设必须显式给出全局工具白名单')
  }
  const tools = ctx.tools
  let dispose = null
  let appliedKey = null
  let applying = false

  /** 重算差集；全局工具集变化时换一条 restriction（自触发事件用 applying 挡住递归）。 */
  function refresh() {
    if (applying) return
    const plan = planRestriction(globalToolNames(tools), allowed)
    const key = plan.deny.join('\n')
    if (dispose !== null && key === appliedKey) return
    applying = true
    try {
      const previous = dispose
      dispose = null
      if (previous !== null) {
        try { previous() } catch { /* 旧 restriction 已被作用域回收 */ }
      }
      dispose = tools.restrict({ deny: plan.deny })
      appliedKey = key
    } catch (error) {
      // 全局工具表在重算期间变化时可能命中未知名字：保留上一条 restriction，不炸整棵预设。
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('butler-preset: refresh restriction failed: %s', String(error))
    } finally {
      applying = false
    }
  }

  ctx.effect(() => {
    const off = typeof ctx.on === 'function' ? ctx.on('tools/change', refresh) : null
    refresh()
    return () => {
      if (typeof off === 'function') off()
      if (dispose !== null) {
        const current = dispose
        dispose = null
        try { current() } catch { /* scope teardown already released it */ }
      }
    }
  })

  // 新会话自动开 Team 模式：只对根会话、只在未开启时调一次；失败不影响会话本身。
  if (typeof ctx.on === 'function' && ctx.agentTeams && typeof ctx.agentTeams.setEnabled === 'function') {
    ctx.on('agent/created', async ({ agent } = {}) => {
      try {
        if (!agent || !agent.session || !agent.session.header) return
        if (agent.session.header.parentSession !== undefined) return
        if (ctx.agentTeams.isEnabled(agent) === true) return
        await ctx.agentTeams.setEnabled(agent, true)
        enabledAgents.push(String(agent.session.id ?? agent.id ?? ''))
        if (typeof ctx.logger?.info === 'function') ctx.logger.info('butler-preset: auto-enabled Agent Teams for %s', String(agent.session.id ?? agent.id))
      } catch (error) {
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('butler-preset: auto-enable Agent Teams failed: %s', String(error))
      }
    })
  }
}
