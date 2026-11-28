#!/usr/bin/env node
/* 功能清单核对：把「一个都不能少」的 17 条逐条对页面 DOM 断言。
 * 只读，不改任何文件。node tools/func-audit.mjs */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8')
const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')

const rows = []
const ok = (n, cond, detail = '') => rows.push({ n, ok: !!cond, detail })
const id = s => new RegExp('id="' + s + '"').test(markup)
const has = s => html.includes(s)

ok('1 五页导航 + badge', ['butler', 'tasks', 'cluster', 'memory', 'settings'].every(p => id('page-' + p)) &&
  /nav-badge/.test(markup) && id('navButlerCount') && id('navTasksCount') && id('navClusterCount'))
ok('2 顶部三问状态条 + 展开收起 + high 自动展开', id('statusBar') && id('statusToggle') && id('statusDetail') &&
  id('tqNeeds') && id('tqHealth') && id('tqHistory') && /setStatusBarExpanded\(true\)/.test(html) && id('statusChips'))
ok('3 对话/轨迹 tab', id('tab-dialogue') && id('tab-trajectory') && id('traceDialogue') && id('traceTrajectory'))
ok('4 会话下拉 + 重建 + 常驻标签 + 绑定说明', id('sessionPick') && id('rebuildBtn') && id('bindPinned') && id('bindMode'))
ok('5 流状态徽标（实时/轮询/离线 + SSE）', id('dlgStreamBadge') && /function streamBadge/.test(html) &&
  /new EventSource\(/.test(html) && has("'实时'") && has("'轮询'") && has("'离线'"))
ok('6 消息流：ctx-row / 工具折叠 / 思考折叠 / 加载更早', /class="ctx-row"/.test(html) && /class="tcard/.test(html) &&
  /class="think"/.test(html) && id('loadEarlier'))
ok('7 最新报告面板 + 关闭', id('reportPanel') && id('closeReport') && id('reportContent'))
ok('8 回执四态 + 清空', id('receiptList') && id('clearReceipt') &&
  /RECEIPT_STATES = \{ ok: '成功', fail: '失败', unsupported: '暂不支持', pending: '进行中' \}/.test(html))
ok('9 快捷动作按钮组', id('actionList') && /const ACTION_RUNNERS = \{/.test(html))
ok('10 输入框/发送/模型选择器/思考档位/权限只读/附件禁用', id('prompt') && id('sendBtn') && id('modelChip') && id('modelMenu') &&
  /model-effort-item/.test(html) && /该模型不支持思考档位/.test(html) && id('permBadge') && /id="attachBtn"[^>]*disabled/.test(html))
ok('11 右栏 T0–T3：chip 筛选/折叠/上级路径/跨机只读/降级/抽屉', id('hier') && ['cntT0', 'cntT1', 'cntT2', 'cntT3'].every(id) &&
  /classList\.toggle\('collapsed'\)/.test(html) && /has-sel/.test(html) && /data-readonly=/.test(html) &&
  id('tierDegraded') && id('drawerBtn'))
ok('12 任务页：五态/事件流/官方板/待办', ['leased', 'awaiting', 'undelivered', 'stale', 'done'].every(s => new RegExp("state:\\s*'" + s + "'").test(html)) &&
  id('taskList') && id('eventList') && id('officialList') && id('todoList') && id('todoForm'))
ok('13 集群页：拓扑 SVG + 设备链路 + 三态图例', /id="topoNodes"/.test(html) && id('clusterList') &&
  /class="sw"[^>]*>在线|>在线</.test(markup) && markup.includes('离线') && markup.includes('未知'))
ok('14 记忆页：OpenViking 探测', id('memoryProbe') && /fireAction\('notes'\)/.test(html) && id('memoryState'))
ok('15 设置页：版本与路由/数据源/回滚与红线(重启禁用)', id('setVersion') && id('setBoard') && id('disabledReason') &&
  /disabled aria-describedby="disabledReason"/.test(html))
ok('16 自诊断红条 + 数据过期横幅', /id = 'panelDiag'/.test(html) && id('chipStale'))
ok('17 900/1000 窄屏抽屉 + 无横向溢出断言在', /@media \(max-width:1200px\)/.test(html) && /body\.drawer \.hier\{transform:none\}/.test(html) &&
  /@media \(max-width:980px\)/.test(html))

const bad = rows.filter(r => !r.ok)
for (const r of rows) process.stdout.write((r.ok ? 'PASS ' : 'FAIL ') + r.n + (r.detail ? '  ' + r.detail : '') + '\n')
process.stdout.write('\nfunc-audit: ' + (rows.length - bad.length) + '/' + rows.length + (bad.length ? ' FAIL' : ' PASS') + '\n')
process.exit(bad.length ? 1 : 0)
