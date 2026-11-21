/**
 * TRAIL 失败分类（taxonomy）+ 规则化告警分类器 —— `GET /dsh-html-panel/api/alerts` 的全部逻辑。
 *
 * ## 来源与许可
 * 分类体系搬自 **TRAIL: Trace Reasoning and Agentic Issue Localization**
 * （<https://github.com/patronus-ai/trail-benchmark>，MIT，Copyright (c) 2025 patronus-ai；
 * 许可原文随代码放在 `lib/trail.LICENSE`，MIT 要求随副本保留版权声明）。
 * 提取位置（2026-11-21 实读本地 clone `super-agent-reuse/work/papers/trail-benchmark`）：
 *   - 21 个**叶子类目**的权威清单在 `benchmarking/calculate_scores.py` 的 `all_categories`；
 *   - 类目**树**（3 大类 / 9 组）在 `benchmarking/run_eval.py` 的 `get_prompt()` taxonomy 文本里。
 *   - 两处有一个差异，如实记在这里：prompt 树是 20 个叶子（没有 `Incorrect Memory Usage`），
 *     `calculate_scores.py` 的评分清单是 21 个（多 `Incorrect Memory Usage`）。本文件按
 *     **21 个**收录（与社区/报告口径一致），把 `Incorrect Memory Usage` 挂在
 *     `Information Processing` 组下，**类目名一个都没改**；没有合并、没有省略。
 *
 * ## 只搬了什么
 * **只搬了「分类体系 + 规则化分类器」；TRAIL 的 LLM judge（run_eval.py 的 prompt + litellm 调用）
 * 没有接，也不会接**：本模块零网络、零依赖、不花钱，只按我们现有数据结构里的真实字段推导告警。
 * Travis 的 judge 输出是「类别 + span location + 证据 + 影响」，本模块没有 location 级定位能力
 * （我们的板/层级数据没有 span id 这一层），只能把告警指回具体字段路径与事件 seq —— 这是
 * 已知限制，README「TRAIL 来源与已知限制」一节也写明。
 *
 * ## 输入 / 输出
 * `classifyAlerts(input)` 是纯函数，输入是两条只读路由的原始响应（都可缺）：
 *   - `input.board`   = `/api/board` 响应体（`tasks[]`、`events[]`、`official` 段）；
 *   - `input.tiers`   = `/api/tiers` 响应体（`nodes[]`、`root`、`source`、`degraded`）；
 *   - `input.agents`  = 可选，`ctx.agents.list()` 行；只在 tiers 节点状态缺失时当兜底状态源
 *                       （tiers 节点 status 本来就是从这里来的，所以一般不用传）；
 *   - `input.now`     = 可选注入的判定时刻（毫秒），测试用。
 * 输出告警数组，每条：
 *   `{ id, severity, category, categoryLabel, subject, why, evidence[], suggestion,
 *      ruleId, subjectType:'task'|'node'|'team', subjectId, relatedIds? }`
 * `evidence` 每项是「字段路径=值」或事件 id，例如
 * `tasks.t-e5b4cb53.evidenceCount=0`、`events.seq=23.kind=task.gate_rejected`。
 * 规则全部基于真实字段；**输出为空是合法结果**，不许为了有告警而造规则。
 *
 * 本模块任何输入都不抛错（脏行跳过、缺字段跳过），时间单位一律毫秒。
 */

/** TRAIL 原始仓库与提取说明（写进 /api/alerts 的 source，也方便审计）。 */
export const TRAIL_SOURCE = Object.freeze({
  repo: 'patronus-ai/trail-benchmark',
  license: 'MIT',
  copyright: 'Copyright (c) 2025 patronus-ai',
  extractedFrom: 'benchmarking/run_eval.py(taskonomy tree) + benchmarking/calculate_scores.py(all_categories)',
  extractedAt: '2026-11-21',
  leafCategories: 21,
  judge: 'not-ported',
})

/**
 * TRAIL 的 21 个叶子类目（**id 是 TRAIL 原名，未翻译未改名**；label/what 是面板中文释义）。
 *
 * 字段：
 *   - `group`    三大类：Reasoning Errors / System Execution Errors / Planning and Coordination Errors；
 *   - `branch`   二级组：Hallucinations / Information Processing / …；
 *   - `evidenceHint` 我们体系里对应哪些字段；`未落地` 表示 0.6.0 没有规则消费它（诚实标注，
 *                不硬凑规则：没有可判别字段就不编）。
 */
export const TRAIL_TAXONOMY = Object.freeze([
  {
    id: 'Language-only',
    group: 'Reasoning Errors',
    branch: 'Hallucinations',
    label: '语言性幻觉',
    what: '凭空编造事实或数值，没有工具证据支撑。',
    evidenceHint: '未落地：板/层级没有「模型话术」字段，无法区分编造与真实回忆。',
  },
  {
    id: 'Tool-related',
    group: 'Reasoning Errors',
    branch: 'Hallucinations',
    label: '工具性幻觉',
    what: '编造工具返回、或声称用了某个工具（能力）实际没调用。',
    evidenceHint: '弱线索：`tasks[].evidenceCount`（done 却 0 条证据）——但本版把它归到 Instruction Non-compliance，不冒充幻觉。',
  },
  {
    id: 'Poor Information Retrieval',
    group: 'Reasoning Errors',
    branch: 'Information Processing',
    label: '检索无关信息',
    what: '检索了与任务无关的信息，偏离信息需求。',
    evidenceHint: '未落地：没有检索记录字段。',
  },
  {
    id: 'Incorrect Memory Usage',
    group: 'Reasoning Errors',
    branch: 'Information Processing',
    label: '错误使用记忆',
    what: '错误引用或错误忽略上下文/记忆内容（仅 calculate_scores 清单有，prompt 树没有）。',
    evidenceHint: '未落地：没有记忆读写事件与会话上下文字段。',
  },
  {
    id: 'Tool Output Misinterpretation',
    group: 'Reasoning Errors',
    branch: 'Information Processing',
    label: '误读工具输出',
    what: '对工具输出做了错误假设，或在错误上下文里使用工具输出。',
    evidenceHint: '未落地：事件只有一行 payload 摘要（`events[].text`），不足以判定误读。',
  },
  {
    id: 'Incorrect Problem Identification',
    group: 'Reasoning Errors',
    branch: 'Decision Making',
    label: '认错问题',
    what: '误解整体任务或局部子任务。',
    evidenceHint: '未落地：需要任务意图对照，板只有标题/验收文本。',
  },
  {
    id: 'Tool Selection Errors',
    group: 'Reasoning Errors',
    branch: 'Decision Making',
    label: '选错工具',
    what: '用了不适合当前任务的工具。',
    evidenceHint: '未落地：板不记录调用链。',
  },
  {
    id: 'Formatting Errors',
    group: 'Reasoning Errors',
    branch: 'Output Generation',
    label: '格式错误',
    what: '代码执行格式或输出结构不符合要求。',
    evidenceHint: '未落地：验收文本是自由文本，没有结构化格式校验结果。',
  },
  {
    id: 'Instruction Non-compliance',
    group: 'Reasoning Errors',
    branch: 'Output Generation',
    label: '不按指令完成',
    what: '没有按要求完成任务，而是做了别的事（或跳过必需步骤）。',
    evidenceHint: '落地规则 `evidence_gate`：`tasks[].state=done` 但 `evidenceCount=0`；或 canceled 且事件流里有 `task.gate_rejected`、证据仍为 0。',
  },
  {
    id: 'Tool Definition Issues',
    group: 'System Execution Errors',
    branch: 'Configuration',
    label: '工具定义问题',
    what: '工具定义本身有错，与描述不一致。',
    evidenceHint: '未落地：工具定义由 DSH 宿主提供，面板不可见。',
  },
  {
    id: 'Environment Setup Errors',
    group: 'System Execution Errors',
    branch: 'Configuration',
    label: '环境/凭据问题',
    what: '权限、密钥或资源访问配置问题。',
    evidenceHint: '旁证：`/api/board` 的 `error.code=http-401/http-403`；本版归在「系统是否健康」问里，不单独产告警。',
  },
  {
    id: 'Rate Limiting',
    group: 'System Execution Errors',
    branch: 'API Issues',
    label: '限流',
    what: '被上游限流（如 429）。',
    evidenceHint: '未落地：板/层级没有调用计数与 429 字段。',
  },
  {
    id: 'Authentication Errors',
    group: 'System Execution Errors',
    branch: 'API Issues',
    label: '鉴权失败',
    what: '鉴权失败（如 401/403）。',
    evidenceHint: '旁证：`/api/board` 的 `error.code=http-401/http-403`（见「系统是否健康」）。',
  },
  {
    id: 'Service Errors',
    group: 'System Execution Errors',
    branch: 'API Issues',
    label: '服务端错误',
    what: '服务返回 5xx 等错误。',
    evidenceHint: '旁证：`/api/board` 的 `error.code=http-5xx`、`/api/alerts` 的 `degraded.reasons`。',
  },
  {
    id: 'Resource Not Found',
    group: 'System Execution Errors',
    branch: 'API Issues',
    label: '资源不存在',
    what: '请求的资源/路由不存在（如 404）。',
    evidenceHint: '旁证：板任务 404、路由未加载时的 HTTP 404（页面按健康问处理）。',
  },
  {
    id: 'Resource Exhaustion',
    group: 'System Execution Errors',
    branch: 'Resource Management',
    label: '资源耗尽',
    what: '内存/句柄等资源耗尽。',
    evidenceHint: '未落地：本机内存由 `/api/host` 展示，但「耗尽」阈值与失败无因果字段，不造规则。',
  },
  {
    id: 'Timeout Issues',
    group: 'System Execution Errors',
    branch: 'Resource Management',
    label: '超时',
    what: '系统响应超过预期时间（含等待没有结果）。',
    evidenceHint: '落地规则 `lease_expired`（`tasks[].leaseDeadline` 已过期 / `state=stale`）、`ack_timeout`（`ackDeadline` 已过且 `ackAt=null` / `ackState=timeout`）。',
  },
  {
    id: 'Context Handling Failures',
    group: 'Planning and Coordination Errors',
    branch: 'Context Management',
    label: '上下文处理失败',
    what: '上下文溢出、状态跟踪失败或遗忘关键上下文。',
    evidenceHint: '落地规则 `subagent_anomaly` 的孤儿分支：`nodes[].kind=subagent` 且 `tier=1`（父会话已不在活会话列表 = 血缘状态跟踪断了）。',
  },
  {
    id: 'Resource Abuse',
    group: 'Planning and Coordination Errors',
    branch: 'Context Management',
    label: '资源滥用',
    what: '因状态问题过度调用工具/反复重试。',
    evidenceHint: '未落地：事件计数只能说明「有事件」，判不了「过度」。',
  },
  {
    id: 'Goal Deviation',
    group: 'Planning and Coordination Errors',
    branch: 'Task Management',
    label: '目标偏离',
    what: '偏离任务或子任务目标。',
    evidenceHint: '弱线索：`duplicate_work`（同标题重开/并存）只是重复劳动迹象，不冒充目标偏离。',
  },
  {
    id: 'Task Orchestration',
    group: 'Planning and Coordination Errors',
    branch: 'Task Management',
    label: '任务编排',
    what: '子任务协调或进度监控出问题（多智能体任务管理类）。',
    evidenceHint: '落地规则 `task_stalled`、`subagent_stalled`、`duplicate_work`、`dispatch_undelivered`、`subagent_anomaly` 的阻塞分支、`official_team_failure`。',
  },
])

/** id → 类目对象（页面/测试查 label 用；未知名给 undefined，不编）。 */
export const TRAIL_BY_ID = Object.freeze(Object.fromEntries(TRAIL_TAXONOMY.map(item => [item.id, item])))

/**
 * 阈值（毫秒）与依据，全部集中在这里，不散落魔法数字。
 *
 * 依据取自**本机真实板数据**的字段语义（不是拍脑袋）：
 *   - `/task/list` 的 `lease_ms` 实测 300000（5 分钟），面板显示 `leaseDeadline`，
 *     所以「10 分钟没更新」= 两个租约周期都没有任何写入，算「长时间无进展」；
 *     30 分钟 = 6 个周期，判「高」。
 *   - 子代理（`tiers.nodes[].kind=subagent`）一次性任务通常几分钟到几十分钟；
 *     一次性/可续聊子代理创建 2 小时后仍是 `running`，需要人看一眼。
 *   - 重复劳动：只看 24 小时内重开/并存的卡，更早的算历史，不打扰人。
 *   - 单次响应最多 50 条告警，防止异常数据把页面撑爆。
 */
export const THRESHOLDS = Object.freeze({
  TASK_STALL_WARN_MS: 10 * 60 * 1000,
  TASK_STALL_HIGH_MS: 30 * 60 * 1000,
  SUBAGENT_STALL_MS: 2 * 60 * 60 * 1000,
  DUPLICATE_WINDOW_MS: 24 * 60 * 60 * 1000,
  MAX_ALERTS: 50,
})

/** 规则清单（README/测试/`source.rules` 用）：ruleId → 类目 + 说明。 */
export const ALERT_RULES = Object.freeze([
  { id: 'task_stalled', category: 'Task Orchestration', label: '任务长时间无进展（租约仍有效但长时间没更新）' },
  { id: 'subagent_stalled', category: 'Task Orchestration', label: '子代理长时间仍处于运行中' },
  { id: 'lease_expired', category: 'Timeout Issues', label: '租约/心跳过期（state=stale）' },
  { id: 'ack_timeout', category: 'Timeout Issues', label: '派发回执超时（ackDeadline 已过且未 ack）' },
  { id: 'dispatch_undelivered', category: 'Task Orchestration', label: '派发未送达（ackState 缺失，没人接过卡）' },
  { id: 'duplicate_work', category: 'Task Orchestration', label: '重复劳动迹象（同标题并存/取消后重开）' },
  { id: 'evidence_gate', category: 'Instruction Non-compliance', label: '证据门禁未过（done 无证据，或门禁驳回后取消）' },
  { id: 'subagent_anomaly', category: 'Task Orchestration', label: '子代理异常（阻塞 / 父已完成子仍在跑）' },
  { id: 'subagent_orphan', category: 'Context Handling Failures', label: '孤儿子代理（父会话已不在活会话列表）' },
  { id: 'official_team_failure', category: 'Task Orchestration', label: '官方团队投影报告 failure' },
])

/** 规则 id → 元信息。 */
export const RULE_BY_ID = Object.freeze(Object.fromEntries(ALERT_RULES.map(item => [item.id, item])))

const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 })
const ACTIVE_LIFECYCLES = new Set(['open', 'claimed', 'working', 'blocked'])
const TERMINAL_LIFECYCLES = new Set(['done', 'canceled'])
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/

/**
 * `ctx.agents.list()` 的 `agent.status` → tiers 五态（与 `lib/tiers.js` 的 STATUS_MAP 同口径）。
 * 只在 tiers 节点缺 status 时做兜底：tiers 正常时不走这里，避免两套映射打架。
 */
const AGENT_STATUS_MAP = Object.freeze({
  running: 'run', run: 'run', active: 'run',
  idle: 'idle', inactive: 'idle',
  queued: 'queue', queue: 'queue', waiting: 'queue',
  blocked: 'blocked', failed: 'blocked', error: 'blocked',
  done: 'done', completed: 'done', finished: 'done',
})

/** agents 状态归一化；未知值按 tiers 口径落 idle（不冒充正在运行）。 */
function normalizeAgentStatus(value) {
  if (typeof value !== 'string') return 'idle'
  return AGENT_STATUS_MAP[value.toLowerCase()] || 'idle'
}

/* ─────────────────────────── 小工具（全部防脏值） ─────────────────────────── */

const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 外部字符串截断；非字符串给 ''（不 String() 化对象）。 */
export function text(value, max = 120) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
}

/** 有限正数毫秒；其它给 null（不拿 0/NaN 当时间）。 */
function ms(value) {
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 毫秒时间 → 中文时长（「12 分钟」「1.5 小时」「3 天」）。 */
function durationText(value) {
  if (value < 60 * 1000) return Math.max(1, Math.round(value / 1000)) + ' 秒'
  if (value < 60 * 60 * 1000) {
    const minutes = value / (60 * 1000)
    return (minutes >= 60 ? minutes.toFixed(0) : minutes.toFixed(minutes >= 10 ? 0 : 1)) + ' 分钟'
  }
  if (value < 24 * 60 * 60 * 1000) return (value / (60 * 60 * 1000)).toFixed(1) + ' 小时'
  return (value / (24 * 60 * 60 * 1000)).toFixed(1) + ' 天'
}

/** 毫秒时间 → ISO 字符串；非法给 null（证据里不放编的时间）。 */
function isoAt(value) {
  const at = ms(value)
  if (at === null) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 任务/节点的简短可读 id（证据里仍用完整 id，这里只给 subject）。 */
function shortId(value) {
  const id = typeof value === 'string' ? value : ''
  if (id.length <= 22) return id
  return id.slice(0, 8) + '…' + id.slice(-6)
}

/** 稳定告警 id：ruleId + 主体 id，只留安全字符（页面拿去做 DOM id）。 */
function alertId(ruleId, subjectType, subjectId) {
  const safe = String(subjectId).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80)
  return 'trail-' + ruleId + '-' + subjectType + '-' + safe
}

/** 一行任务的可读名「任务 t-x「标题」」。 */
function taskName(task) {
  const title = text(task.title || task.subject || '', 42)
  const id = text(task.id, 60)
  return '任务 ' + shortId(id) + (title === '' ? '' : '「' + title + '」')
}

/** 一行层级节点的可读名。 */
function nodeName(node) {
  const title = text(node.title || '', 36)
  const id = text(node.id, 80)
  return (node.kind === 'subagent' ? '子代理 ' : '会话 ') + (title === '' ? shortId(id) : '「' + title + '」') + '（' + shortId(id) + '）'
}

/** 任务主体类型（任务节点不是字符串就跳过）。 */
function taskIdOf(task) {
  const id = task && typeof task.id === 'string' ? task.id.trim() : ''
  return TASK_ID_RE.test(id) ? id : ''
}

/** 告警对象工厂：字段一次给齐，规则里只填业务部分。 */
function makeAlert(ruleId, severity, subjectType, subjectId, fields) {
  const rule = RULE_BY_ID[ruleId]
  const category = fields.category || rule.category
  const meta = TRAIL_BY_ID[category]
  return {
    id: alertId(ruleId, subjectType, subjectId),
    ruleId,
    severity,
    category,
    categoryLabel: meta ? meta.label : category,
    subjectType,
    subjectId,
    subject: fields.subject,
    why: fields.why,
    evidence: Array.isArray(fields.evidence) ? fields.evidence : [],
    suggestion: fields.suggestion,
    ...(Array.isArray(fields.relatedIds) && fields.relatedIds.length ? { relatedIds: fields.relatedIds.slice() } : {}),
  }
}

/* ─────────────────────────── 规则实现 ─────────────────────────── */

/** 规则 1：任务租约仍有效、但长时间没有任何更新（Task Orchestration，进度监控）。 */
function ruleTaskStalled(tasks, now) {
  const out = []
  for (const task of tasks) {
    const id = taskIdOf(task)
    if (id === '') continue
    const lifecycle = typeof task.lifecycle === 'string' ? task.lifecycle : ''
    if (!ACTIVE_LIFECYCLES.has(lifecycle)) continue
    const updatedAt = ms(task.updatedAt)
    const leaseDeadline = ms(task.leaseDeadline)
    if (updatedAt === null) continue
    // 租约已经过期的不走这条（交给 lease_expired，避免同一条任务双报）。
    if (leaseDeadline === null || leaseDeadline <= now) continue
    const idle = now - updatedAt
    if (idle < THRESHOLDS.TASK_STALL_WARN_MS) continue
    const high = idle >= THRESHOLDS.TASK_STALL_HIGH_MS
    out.push(makeAlert('task_stalled', high ? 'high' : 'medium', 'task', id, {
      subject: taskName(task),
      why: '租约仍有效（' + durationText(leaseDeadline - now) + '后到期），但最近 ' + durationText(idle) + '没有任何更新（阈值 ' + durationText(THRESHOLDS.TASK_STALL_WARN_MS) + '）。',
      evidence: [
        'tasks.' + id + '.state=' + String(task.state || lifecycle),
        'tasks.' + id + '.updatedAt=' + (isoAt(updatedAt) || ''),
        'tasks.' + id + '.leaseDeadline=' + (isoAt(leaseDeadline) || ''),
        'tasks.' + id + '.owner=' + text(task.owner || '', 80),
      ],
      suggestion: high
        ? '直接问 ' + (text(task.owner, 40) || 'owner') + ' 是否卡住；超过 30 分钟按租约接管（mesh_task_claim）或重派。'
        : '发一条进度询问；若 30 分钟内仍无更新，按租约接管或重派。',
    }))
  }
  return out
}

/** 规则 2：子代理长时间仍 running（Task Orchestration；创建时刻来自 tiers 的 startedAt）。 */
function ruleSubagentStalled(nodes, now) {
  const out = []
  for (const node of nodes) {
    if (!isObj(node) || node.kind !== 'subagent') continue
    const id = text(node.id, 200)
    if (id === '') continue
    if (node.status !== 'run') continue
    const startedAt = ms(Date.parse(node.startedAt))
    if (startedAt === null) continue
    const running = now - startedAt
    if (running < THRESHOLDS.SUBAGENT_STALL_MS) continue
    out.push(makeAlert('subagent_stalled', 'medium', 'node', id, {
      subject: nodeName(node),
      why: '子代理会话创建于 ' + durationText(running) + '前，当前仍是 running（阈值 ' + durationText(THRESHOLDS.SUBAGENT_STALL_MS) + '）。',
      evidence: [
        'nodes.' + id + '.status=run',
        'nodes.' + id + '.startedAt=' + String(node.startedAt || ''),
        'nodes.' + id + '.mode=' + String(node.mode || 'unknown'),
      ],
      suggestion: '确认它是否真的还在干活；若父会话已完成，让它收尾或结束该子代理会话。',
    }))
  }
  return out
}

/** 规则 3：租约/心跳过期（Timeout Issues）。 */
function ruleLeaseExpired(tasks, now) {
  const out = []
  for (const task of tasks) {
    const id = taskIdOf(task)
    if (id === '') continue
    const lifecycle = typeof task.lifecycle === 'string' ? task.lifecycle : ''
    if (TERMINAL_LIFECYCLES.has(lifecycle)) continue
    if (task.state !== 'stale') continue
    const leaseDeadline = ms(task.leaseDeadline)
    const expiredAt = ms(task.expiredAt)
    const evidence = ['tasks.' + id + '.state=stale', 'tasks.' + id + '.lifecycle=' + (lifecycle || 'unknown')]
    if (leaseDeadline !== null) {
      evidence.push('tasks.' + id + '.leaseDeadline=' + (isoAt(leaseDeadline) || '') +
        (leaseDeadline <= now ? '（已过期 ' + durationText(now - leaseDeadline) + '）' : ''))
    }
    if (expiredAt !== null) evidence.push('tasks.' + id + '.expiredAt=' + (isoAt(expiredAt) || ''))
    out.push(makeAlert('lease_expired', 'high', 'task', id, {
      subject: taskName(task),
      why: (leaseDeadline !== null && leaseDeadline <= now
        ? '租约已过期 ' + durationText(now - leaseDeadline)
        : '板子把它标成 stale（租约失效）') + '，任务还没完成，原负责人没有续租。',
      evidence,
      suggestion: '先确认原负责人是否还活着；确认失联就接管（mesh_task_claim）或重派。',
    }))
  }
  return out
}

/** 规则 4：派发回执超时（Timeout Issues）。 */
function ruleAckTimeout(tasks, now) {
  const out = []
  for (const task of tasks) {
    const id = taskIdOf(task)
    if (id === '') continue
    const lifecycle = typeof task.lifecycle === 'string' ? task.lifecycle : ''
    if (!ACTIVE_LIFECYCLES.has(lifecycle)) continue
    const ackDeadline = ms(task.ackDeadline)
    const ackAt = ms(task.ackAt)
    const ackState = typeof task.ackState === 'string' ? task.ackState : ''
    const overdue = ackDeadline !== null && ackDeadline <= now && ackAt === null
    if (!overdue && ackState !== 'timeout') continue
    const evidence = ['tasks.' + id + '.ackState=' + (ackState || 'unknown')]
    if (ackDeadline !== null) evidence.push('tasks.' + id + '.ackDeadline=' + (isoAt(ackDeadline) || ''))
    evidence.push('tasks.' + id + '.ackAt=' + (ackAt !== null ? (isoAt(ackAt) || '') : 'null'))
    out.push(makeAlert('ack_timeout', 'medium', 'task', id, {
      subject: taskName(task),
      why: (overdue
        ? '回执期限已过 ' + durationText(now - ackDeadline) + '，仍没有 ack'
        : '板子把回执标成 timeout（派发出去没人确认）') + '。',
      evidence,
      suggestion: '重新派发或换一个会话投递；ack 超时说明对方没接单，别等它自己好。',
    }))
  }
  return out
}

/** 规则 5：派发未送达（Task Orchestration：协调/投递问题）。 */
function ruleDispatchUndelivered(tasks) {
  const out = []
  for (const task of tasks) {
    const id = taskIdOf(task)
    if (id === '') continue
    const lifecycle = typeof task.lifecycle === 'string' ? task.lifecycle : ''
    if (lifecycle !== 'open') continue
    if (task.state !== 'undelivered') continue
    out.push(makeAlert('dispatch_undelivered', 'medium', 'task', id, {
      subject: taskName(task),
      why: '任务还没人认领，但派发回执状态是「未送达」（ackState=' + String(task.ackState || 'none') + '）。',
      evidence: [
        'tasks.' + id + '.state=undelivered',
        'tasks.' + id + '.lifecycle=open',
        'tasks.' + id + '.ackState=' + String(task.ackState || 'none'),
      ],
      suggestion: '重新派发一次（确认目标会话在线）；没送达的卡不会自己变成已认领。',
    }))
  }
  return out
}

/** 规则 6：重复劳动（Task Orchestration）。按标题分组，三种形态分开报。 */
function ruleDuplicateWork(tasks, now) {
  const groups = new Map()
  for (const task of tasks) {
    const id = taskIdOf(task)
    if (id === '') continue
    const title = text(task.title || task.subject || '', 200).replace(/\s+/g, ' ')
    if (title.length < 6) continue // 太短的标题（空、"--"、探针名）不参与，避免误报
    if (!groups.has(title)) groups.set(title, [])
    groups.get(title).push(task)
  }
  const out = []
  for (const [title, rows] of groups) {
    if (rows.length < 2) continue
    const active = rows.filter(task => ACTIVE_LIFECYCLES.has(String(task.lifecycle || '')))
    const canceled = rows.filter(task => task.lifecycle === 'canceled')
    // 按 createdAt 排序（缺 createdAt 的行不参与「先取消后重开」的因果判断，但仍计入重复）。
    const timed = rows
      .map(task => ({ task, id: taskIdOf(task), createdAt: ms(task.createdAt) }))
      .filter(row => row.createdAt !== null)
      .sort((left, right) => left.createdAt - right.createdAt)
    const ids = rows.map(taskIdOf).filter(id => id !== '')
    const freshCanceled = canceled.filter(task => {
      const updatedAt = ms(task.updatedAt)
      return updatedAt !== null && now - updatedAt <= THRESHOLDS.DUPLICATE_WINDOW_MS
    })
    // 「取消后重开」要求重开的那张还在用（进行中/已完成）；重开后又取消的，算反复建卡（低频提示）。
    const reopened = []
    for (let index = 1; index < timed.length; index += 1) {
      const row = timed[index]
      if (row.task.lifecycle === 'canceled') continue
      const previousIds = timed.slice(0, index).map(previous => previous.id)
      const previousCanceled = rows.some(task => previousIds.includes(taskIdOf(task)) && task.lifecycle === 'canceled')
      if (previousCanceled) reopened.push(row.id)
    }
    let severity = null
    let why = ''
    if (active.length >= 2) {
      severity = 'high'
      why = '同一标题有 ' + active.length + ' 张进行中/待接手的卡并存（' + active.map(taskIdOf).join('、') + '），疑似重复派活。'
    } else if (reopened.length > 0) {
      severity = 'medium'
      why = '同标题出现过取消（' + canceled.map(taskIdOf).join('、') + '），之后又新建了同样的卡（' + reopened.join('、') + '），像取消后重开。'
    } else if (freshCanceled.length >= 2) {
      severity = 'low'
      why = '最近 24 小时有 ' + freshCanceled.length + ' 张同标题的卡都被取消（' + freshCanceled.map(taskIdOf).join('、') + '），疑似反复建卡又放弃。'
    }
    if (severity === null) continue
    const primaryId = ids.find(id => id !== '') || ''
    const evidence = []
    for (const task of rows.slice(0, 4)) {
      const id = taskIdOf(task)
      evidence.push('tasks.' + id + '.title=' + title)
      evidence.push('tasks.' + id + '.lifecycle=' + String(task.lifecycle || 'unknown') + ' · updatedAt=' + (isoAt(task.updatedAt) || ''))
    }
    out.push(makeAlert('duplicate_work', severity, 'task', primaryId, {
      subject: '同标题任务 ×' + rows.length + '「' + text(title, 40) + '」',
      why,
      evidence,
      relatedIds: ids.filter(id => id !== ''),
      suggestion: '确认哪张是唯一有效卡：取消多余的，或把验收标准合并到一张；避免两边各做一遍。',
    }))
  }
  return out
}

/** 规则 7：证据门禁未过（Instruction Non-compliance：完成协议没走完）。 */
function ruleEvidenceGate(tasks, events) {
  const out = []
  const gateEvents = new Map()
  for (const event of events) {
    if (!isObj(event)) continue
    if (event.kind !== 'task.gate_rejected') continue
    const taskId = typeof event.task === 'string' ? event.task : ''
    if (taskId === '') continue
    if (!gateEvents.has(taskId)) gateEvents.set(taskId, [])
    gateEvents.get(taskId).push(event)
  }
  for (const task of tasks) {
    const id = taskIdOf(task)
    if (id === '') continue
    const evidenceCount = Number.isInteger(task.evidenceCount) ? task.evidenceCount : null
    if (evidenceCount !== 0) continue // 证据数未知(null)不算 0，不猜
    const lifecycle = typeof task.lifecycle === 'string' ? task.lifecycle : ''
    const gateRows = gateEvents.get(id) || []
    if (task.state === 'done') {
      out.push(makeAlert('evidence_gate', 'high', 'task', id, {
        subject: taskName(task),
        why: '任务已是 done，但证据条数是 0（完成门禁要求可采信证据）。',
        evidence: ['tasks.' + id + '.state=done', 'tasks.' + id + '.evidenceCount=0', 'tasks.' + id + '.updatedAt=' + (isoAt(task.updatedAt) || '')],
        suggestion: '让执行方补证据后重新走完成门禁；done 但无证据的卡不能当交付。',
      }))
    } else if (lifecycle === 'canceled' && gateRows.length > 0) {
      const lastGate = gateRows.slice().sort((left, right) => (ms(right.at) || 0) - (ms(left.at) || 0))[0]
      out.push(makeAlert('evidence_gate', 'medium', 'task', id, {
        subject: taskName(task),
        why: '任务被门禁驳回过（task.gate_rejected），随后以「已取消」收尾且没有留下任何证据。',
        evidence: [
          'tasks.' + id + '.lifecycle=canceled',
          'tasks.' + id + '.evidenceCount=0',
          'events.seq=' + String(lastGate.seq ?? '') + '.kind=task.gate_rejected',
        ],
        suggestion: '确认是丢弃还是重开：重开就补证据，丢弃就在取消原因里写明，别留一张没证据的卡。',
      }))
    }
  }
  return out
}

/** 规则 8/9：子代理异常（阻塞 / 父已完成子仍在跑）与孤儿子代理。 */
function ruleSubagentAnomaly(nodes, now) {
  const out = []
  const byId = new Map()
  for (const node of nodes) {
    if (!isObj(node)) continue
    const id = text(node.id, 200)
    if (id !== '') byId.set(id, node)
  }
  for (const node of byId.values()) {
    const id = text(node.id, 200)
    const isSubagent = node.kind === 'subagent'
    if (!isSubagent) continue
    const parentId = typeof node.parentId === 'string' ? node.parentId : ''
    const parent = byId.get(parentId)
    if (node.status === 'blocked') {
      out.push(makeAlert('subagent_anomaly', 'high', 'node', id, {
        subject: nodeName(node),
        why: '子代理状态是「阻塞」（agents 报告 running 之外的失败/错误态）。',
        evidence: ['nodes.' + id + '.status=blocked', 'nodes.' + id + '.parentId=' + (parentId || ''), 'nodes.' + id + '.startedAt=' + String(node.startedAt || '')],
        suggestion: '去父会话看它卡在哪一步；必要时重派这个子任务，别让整条链等它。',
      }))
    }
    if (parent && (parent.status === 'done' || parent.status === 'blocked') && node.status === 'run') {
      out.push(makeAlert('subagent_anomaly', 'medium', 'node', id, {
        subject: nodeName(node),
        why: '父节点已经是「' + (parent.status === 'done' ? '已完成' : '阻塞') + '」，子代理却还在 running。',
        evidence: [
          'nodes.' + id + '.status=run',
          'nodes.' + parentId + '.status=' + parent.status,
          'nodes.' + id + '.parentId=' + parentId,
        ],
        suggestion: '确认子代理是否还在产出；父任务已收尾的话让它停，或把它的结果补登记后结束。',
      }))
    }
    // 孤儿子代理：tier=1 的 subagent 说明父会话已经不在活会话列表（tiers.js 就是这么挂的）。
    if (Number(node.tier) === 1 && (parent === undefined || parent === null)) {
      const startedAt = ms(Date.parse(node.startedAt))
      out.push(makeAlert('subagent_orphan', 'low', 'node', id, {
        subject: nodeName(node),
        why: '父会话已不在活会话列表（tiers 把它挂到 T1）' +
          (startedAt === null ? '，创建时间未知。' : '，会话创建于 ' + isoAt(startedAt) + '（' + durationText(now - startedAt) + '前）。'),
        evidence: [
          'nodes.' + id + '.kind=subagent',
          'nodes.' + id + '.tier=1',
          'nodes.' + id + '.parentId=' + (parentId || ''),
          'nodes.' + id + '.status=' + String(node.status || ''),
        ],
        suggestion: '父会话已结束，它不会再收到指令；确认无用就结束这个遗留子代理会话，别让它占着活会话名额。',
      }))
    }
  }
  return out
}

/** 规则 10：官方团队投影报告 failure（Task Orchestration；failure 是官方 wire 字段）。 */
function ruleOfficialTeamFailure(official) {
  if (!isObj(official)) return []
  if (official.available !== true) return []
  const teams = Array.isArray(official.teams) ? official.teams : []
  const out = []
  for (const team of teams) {
    if (!isObj(team) || team.enabled !== true) continue
    const failure = text(team.failure, 160)
    if (failure === '') continue
    const sessionId = text(team.sessionId, 120)
    out.push(makeAlert('official_team_failure', 'medium', 'team', sessionId || 'unknown', {
      subject: '官方团队' + (text(team.title, 30) ? '「' + text(team.title, 30) + '」' : '') + '（会话 ' + shortId(sessionId) + '）',
      why: '官方 TeamTaskView 投影里带 failure：「' + failure + '」。',
      evidence: ['official.teams.' + sessionId + '.failure=' + failure, 'official.teams.' + sessionId + '.enabled=true'],
      suggestion: '按 failure 原文去对应会话排查；官方任务板只读，面板不替它做决定。',
    }))
  }
  return out
}

/* ─────────────────────────── 对外接口 ─────────────────────────── */

/**
 * 纯函数：把两条只读快照变成告警数组。
 *
 * @param {object} [input] `{ board?, tiers?, agents?, official?, now? }`（board/tiers 是路由响应体）
 * @param {number} [nowInput] 判定时刻（毫秒）；缺省用 input.now，再缺省 Date.now()
 * @returns {object[]} 告警数组（最多 {@link THRESHOLDS.MAX_ALERTS} 条，按严重度→类目→主体排序）
 */
export function classifyAlerts(input = {}, nowInput) {
  const rawInput = isObj(input) ? input : {}
  const explicitNow = ms(nowInput)
  const inputNow = ms(rawInput.now)
  const now = explicitNow !== null ? explicitNow : (inputNow !== null ? inputNow : Date.now())

  const board = isObj(rawInput.board) ? rawInput.board : {}
  const tasks = Array.isArray(board.tasks) ? board.tasks.filter(isObj) : []
  const events = Array.isArray(board.events) ? board.events.filter(isObj) : []
  const official = isObj(board.official) ? board.official : (isObj(rawInput.official) ? rawInput.official : null)
  const tiers = isObj(rawInput.tiers) ? rawInput.tiers : {}
  const nodes = Array.isArray(tiers.nodes) ? tiers.nodes.filter(isObj) : []

  // agents 只做兜底：tiers 节点没有 status 时，用 agents.list() 的行补一次（返回副本，不改输入）。
  const agentStatus = new Map()
  if (Array.isArray(rawInput.agents)) {
    for (const agent of rawInput.agents) {
      if (!isObj(agent) || typeof agent.id !== 'string' || agent.id === '') continue
      if (typeof agent.status === 'string') agentStatus.set(agent.id, agent.status)
    }
  }
  let tierNodes = nodes
  if (agentStatus.size > 0) {
    tierNodes = nodes.map(node => {
      if (typeof node.id !== 'string') return node
      if (typeof node.status === 'string' && node.status !== '') return node
      const status = agentStatus.get(node.id)
      return status === undefined ? node : { ...node, status: normalizeAgentStatus(status) }
    })
  }

  const collected = [
    ...ruleTaskStalled(tasks, now),
    ...ruleSubagentStalled(tierNodes, now),
    ...ruleLeaseExpired(tasks, now),
    ...ruleAckTimeout(tasks, now),
    ...ruleDispatchUndelivered(tasks),
    ...ruleDuplicateWork(tasks, now),
    ...ruleEvidenceGate(tasks, events),
    ...ruleSubagentAnomaly(tierNodes, now),
    ...ruleOfficialTeamFailure(official),
  ]

  // 同一条规则对同一主体只留一条（防御未来规则重复产出）；**不同规则不互相吞**：
  // 同一个子代理同时「跑太久」和「被阻塞」是两件事，都如实报。
  const deduped = new Map()
  for (const alert of collected) {
    const key = alert.ruleId + '|' + alert.subjectType + '|' + alert.subjectId + '|' + alert.category
    const existing = deduped.get(key)
    if (existing === undefined || SEVERITY_RANK[alert.severity] < SEVERITY_RANK[existing.severity]) {
      deduped.set(key, alert)
    }
  }
  const alerts = [...deduped.values()]
  alerts.sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    if (bySeverity !== 0) return bySeverity
    const byCategory = left.category.localeCompare(right.category)
    if (byCategory !== 0) return byCategory
    return String(left.subjectId).localeCompare(String(right.subjectId))
  })
  return alerts.slice(0, THRESHOLDS.MAX_ALERTS)
}

/** 统计告警条数（高/中/低/总）。 */
export function countAlerts(alerts) {
  const rows = Array.isArray(alerts) ? alerts : []
  const counts = { high: 0, medium: 0, low: 0, total: rows.length }
  for (const alert of rows) {
    if (alert && (alert.severity === 'high' || alert.severity === 'medium' || alert.severity === 'low')) {
      counts[alert.severity] += 1
    }
  }
  return counts
}

/** 数据源整体不可用时的兜底响应体：同一份契约、0 告警、degraded 写原因（页面照常渲染）。 */
export function fallbackAlerts(reason, now = Date.now()) {
  const at = ms(now) !== null ? now : Date.now()
  return {
    generatedAt: new Date(at).toISOString(),
    source: {
      classifier: 'trail-rules-v1',
      taxonomy: TRAIL_TAXONOMY.length,
      rules: ALERT_RULES.length,
      board: 'missing',
      tiers: 'missing',
      cached: false,
      ageMs: 0,
    },
    counts: { high: 0, medium: 0, low: 0, total: 0 },
    alerts: [],
    degraded: { reasons: [reason || '告警生成失败'] },
  }
}

/**
 * 把 board 快照的可用性归一成三个词，写进 `source.board`。
 * @returns {'real'|'unconfigured'|'unreachable'|'missing'}
 */
function boardSourceOf(board) {
  if (!isObj(board)) return 'missing'
  if (board.configured !== true) return 'unconfigured'
  if (isObj(board.error) && Object.keys(board.error).length > 0) return 'unreachable'
  return 'real'
}

/** 把 tiers 快照的可用性归一成三个词，写进 `source.tiers`。 */
function tiersSourceOf(tiers) {
  if (!isObj(tiers)) return 'missing'
  const nodes = Array.isArray(tiers.nodes) ? tiers.nodes : []
  const local = tiers.source && typeof tiers.source === 'object' ? tiers.source.local : undefined
  // 节点为空且本机源不可用：先判 missing（degraded 文本只是原因说明，数据确实没有）。
  if (nodes.length === 0 && (local === 'unavailable' || local === undefined)) return 'missing'
  if (isObj(tiers.degraded) && text(tiers.degraded.reason, 200) !== '') return 'degraded'
  return 'real'
}

/**
 * 组装一次 `/api/alerts` 响应（不做缓存；缓存由 {@link createAlertsReader} 负责）。
 *
 * 输入是两个**现成读取器**（`lib/board.js` / `lib/tiers.js` 的 reader），直接复用它们
 * 自己的缓存，不另开网络请求；两个 reader 谁失败都不拖垮另一个。
 *
 * @param {{board?:{read:Function}, tiers?:{read:Function}, now?:number|Function}} deps
 * @returns {Promise<object>} 永不 reject
 */
export async function buildAlerts(deps = {}) {
  const nowOf = typeof deps.now === 'function' ? deps.now : () => deps.now
  const rawNow = nowOf()
  const now = ms(rawNow) !== null ? Math.round(rawNow) : Date.now()
  const reasons = []
  let board = null
  let tiers = null
  if (deps.board && typeof deps.board.read === 'function') {
    try { board = await deps.board.read(now) } catch { board = null; reasons.push('共享板读取失败：任务类告警不完整') }
  } else {
    reasons.push('共享板读取器不可用：任务类告警无法生成')
  }
  if (deps.tiers && typeof deps.tiers.read === 'function') {
    try { tiers = await deps.tiers.read() } catch { tiers = null; reasons.push('层级读取失败：子代理类告警不完整') }
  } else {
    reasons.push('层级读取器不可用：子代理类告警无法生成')
  }

  const boardSource = boardSourceOf(board)
  const tiersSource = tiersSourceOf(tiers)
  if (boardSource === 'unconfigured') reasons.push('共享板未配置：任务类告警无法生成')
  else if (boardSource === 'unreachable') reasons.push('共享板读取失败（' + String((isObj(board) && isObj(board.error) && board.error.code) || 'error') + '）：任务类告警可能不完整')
  else if (boardSource === 'missing') reasons.push('共享板快照不可用：任务类告警无法生成')
  if (tiersSource === 'degraded' && isObj(tiers.degraded)) {
    reasons.push('层级快照有降级：' + text(tiers.degraded.reason, 160))
  }
  if (tiersSource === 'missing') {
    reasons.push('层级快照不可用：子代理类告警无法生成')
  }

  const alerts = classifyAlerts({ board, tiers, now }, now)
  return {
    generatedAt: new Date(now).toISOString(),
    source: {
      classifier: 'trail-rules-v1',
      taxonomy: TRAIL_TAXONOMY.length,
      rules: ALERT_RULES.length,
      board: boardSource,
      tiers: tiersSource,
      cached: false,
      ageMs: 0,
    },
    counts: countAlerts(alerts),
    alerts,
    degraded: { reasons: [...new Set(reasons)] },
  }
}

/** 告警响应缓存窗口（毫秒）：与页面 30 秒轮询错开，4 秒内同一份结果。 */
export const ALERTS_CACHE_MS = 4000

/**
 * 带 4 秒缓存 + 单飞的告警读取器（一个插件实例一个）。
 * @param {{board?:{read:Function}, tiers?:{read:Function}, now?:number|Function, cacheMs?:number}} deps
 * @returns {{read: () => Promise<object>}}
 */
export function createAlertsReader(deps = {}) {
  const cacheMs = Number.isFinite(deps.cacheMs) && deps.cacheMs >= 0 ? deps.cacheMs : ALERTS_CACHE_MS
  const nowOf = typeof deps.now === 'function' ? deps.now : () => Date.now()
  let cached = null
  let cachedAt = 0
  let inflight = null

  const read = async () => {
    const rawNow = nowOf()
    const now = ms(rawNow) !== null ? Math.round(rawNow) : Date.now()
    if (cached !== null && now >= cachedAt && now - cachedAt < cacheMs) {
      return {
        ...cached,
        source: { ...cached.source, cached: true, ageMs: Math.max(0, now - cachedAt) },
      }
    }
    if (inflight !== null) return inflight
    inflight = (async () => {
      let body
      try {
        body = await buildAlerts({ board: deps.board, tiers: deps.tiers, now })
      } catch {
        body = fallbackAlerts('告警生成失败（详见 DSH 宿主日志）', now)
      }
      cached = body
      cachedAt = now
      return body
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  const clear = () => {
    cached = null
    cachedAt = 0
  }

  return { read, clear }
}
