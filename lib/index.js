import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store, Workbench } from './core.js';
import { Connectors } from './connectors.js';
import { routes } from './http.js';
import { GUIDANCE } from './prompts.js';
import { RuntimeSelection } from './runtime-selection.js';
import { InputImages } from './input-images.js';
import { TaskLifecycle } from './task-lifecycle.js';
import { ProjectLifecycle } from './project-lifecycle.js';
import { KaliLink } from './kali.js';
import { ExecutionMonitor } from './execution-monitor.js';
import { WorkOrders } from './work-orders.js';
import { NativeWorkers } from './native-workers.js';
import { teamTools } from './team-tools.js';
import { SUPERVISOR_GUIDANCE } from './team-prompts.js';

export const name = 'workbench';
export const inject = ['tools', 'systemPrompt', 'connection', 'workspaceRegistry', 'credentials', 'sessionController', 'llm', 'attachments', 'fileUploads'];
const text = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const array = (required = false) => ({ type: 'array', items: text(), ...(required ? { required: true } : {}) });

export function makeTools(wb, connectors) {
  const tool = (name, description, parameters, execute) => defineTool({
    name, description, parameters: { taskId: text(true), ...parameters },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { const task = await wb.owned(args.taskId, exec.agent?.id); const value = await execute(task, args); const current = (await wb.snapshot()).tasks.find(t => t.id === task.id); return JSON.parse(JSON.stringify({ ...value, localOutput: current?.localOutput })); }
  });
  return [
    tool('workbench_get', '读取本员工任务、阶段、待决策事项及项目。', {}, async task => ({ task, project: (await wb.snapshot()).projects.find(p => p.id === task.projectId), connectors: connectors.catalog() })),
    tool('workbench_plan', '记录语义解析后的任务契约；缺少必需信息先提问。', { objective: text(true), constraints: array(), assumptions: array(), stages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: text(true), acceptance: text(true) } } } }, (task, a) => wb.plan(task.id, a)),
    tool('workbench_checkpoint', '提交阶段回报。证据引用仍需核实，不能虚构完成。', { stageId: text(true), summary: text(true), remaining: array(true), evidence: array(), done: { type: 'boolean', required: true } }, (task, a) => wb.checkpoint(task.id, a)),
    tool('workbench_question', '向老板发起持久化决策。仅阻塞 stageId 对应阶段；省略则阻塞全任务。其他独立工作继续，之后结束当前轮等待答复。', { stageId: text(), question: text(true), reason: text(true), recommendation: text(true), options: array() }, (task, a) => wb.question(task.id, a)),
    tool('workbench_review', '阶段全部交付后申请老板验收。', { summary: text(true) }, (task, a) => wb.review(task.id, a.summary)),
    tool('workbench_output_register', '登记交付文件。本地文件须已在该项目目录内，工具验证路径和哈希；尚未取回的远端文件登记为 remote，必交文件取回前不能验收。', { kind: { type: 'string', enum: ['local', 'remote'], required: true }, location: text(true), sourceReference: text(), description: text(), required: { type: 'boolean' } }, (task, a) => wb.outputs.register(task.id, a)),
    tool('workbench_export', '将任务返回内容、阶段汇报和最终报告保存到本机项目目录；也可重试落盘失败或补存历史任务。', {}, task => wb.outputs.ensureReady(task.id, { verify: true })),
    tool('workbench_connection_propose', '根据老板的接入或编辑要求与实际接口文档，生成无密钥的连接配置建议。配置尚未生效，老板在对话卡片确认后保存。禁止猜测接口、夹带凭据、改写宿主管理的连接或自动授权执行。', { configuration: { type: 'object', additionalProperties: true, required: true }, reason: text(true), evidence: text(true) }, (task, a) => connectors.propose(task, a.configuration, a.reason, a.evidence)),
    tool('workbench_connector_list', '列出用户已配置的执行端 ID、名称、适配器及启用状态；没有配置时为空，不猜测连接。', {}, async () => ({ connectors: connectors.catalog(), editableSettings: connectors.settings().filter(c => c.editable).map(c => c.config) })),
    tool('workbench_connector_status', '读取项目已绑定的执行端状态；connector 使用已配置的连接 ID。', { connector: text(true) }, (task, a) => connectors.status(task, a.connector)),
    tool('workbench_connector_submit', '向已绑定且已授权的执行端派工，返回回执，不代表完成。同一工作使用稳定 key。', { connector: text(true), message: text(true), key: text(true) }, (task, a) => connectors.submit(task, a.connector, a.message, a.key))
  ];
}

export async function apply(ctx, config = {}) {
  const file = config.dataFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'workbench', 'state.json');
  const store = await new Store(file).open();
  let monitor, orders;
  ctx.effect(() => async () => { await orders?.close(); await monitor?.close(); await store.close(); }, 'workbench: store');
  const defaultWorkspace = await ctx.workspaceRegistry.initializeDefault(() => join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace'));
  const wb = new Workbench(store, defaultWorkspace ? { id: defaultWorkspace.id, path: defaultWorkspace.path } : null);
  // Repair only workbench-owned sessions created before native workspace binding was added.
  for (const project of (await wb.snapshot()).projects.filter(p => !p.workspaceId && (!p.lifecycle || p.lifecycle === 'active'))) {
    try {
      const workspace = await ctx.workspaceRegistry.create(project.cwd, project.name);
      await wb.workspace(project.id, workspace.id);
      for (const task of (await wb.snapshot()).tasks.filter(t => t.projectId === project.id && t.sessionId)) await workspace.attachSession(task.sessionId);
    } catch (error) { ctx.logger?.warn?.(`workbench workspace reconciliation: ${error.message}`); }
  }
  const kali = config.kali?.enabled ? new KaliLink(config.kali, ctx.credentials) : null;
  if (kali) ctx.effect(() => () => kali.close(), 'workbench: kali');
  const connectorConfig = { ...config.connectors };
  if (kali) for (const kind of ['artex', 'cyberstrikeai']) connectorConfig[kind] = { baseUrl: 'http://127.0.0.1', ...connectorConfig[kind], transport: 'kali', adapter: kind, label: kind === 'artex' ? 'ARTEX' : 'CyberStrikeAI' };
  const connectors = new Connectors(store, connectorConfig, fetch, kali, ctx.credentials);
  const lifecycle = new ProjectLifecycle(wb, ctx.workspaceRegistry, id => ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])));
  const taskLifecycle = new TaskLifecycle(wb, lifecycle, ctx.workspaceRegistry, lifecycle.activity);
  const runtime = new RuntimeSelection(wb, { sessionController: ctx.sessionController, llm: ctx.llm, presets: ctx.get?.('agentPresets'), workspaces: ctx.workspaceRegistry, activity: id => ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])) });
  orders = new WorkOrders(wb, new NativeWorkers(ctx, runtime), connectors);
  wb.orders = orders;
  wb.images = new InputImages(wb, { sessions: ctx.sessionController, attachments: ctx.attachments, fileUploads: ctx.fileUploads });
  monitor = new ExecutionMonitor(wb, connectors, ctx.sessionController);
  taskLifecycle.dispatch = (taskId, operation) => monitor.serialize(taskId, operation);
  lifecycle.dispatch = async (projectId, operation) => {
    const ids = (await wb.snapshot()).tasks.filter(t => t.projectId === projectId).map(t => t.id).sort();
    const lock = index => index === ids.length ? operation() : monitor.serialize(ids[index], () => lock(index + 1));
    return lock(0);
  };
  if (ctx.on && ctx.tools.guard) orders.attach(ctx);
  if (ctx.on && ctx.sessionController) monitor.attach(ctx);
  for (const tool of [...makeTools(wb, connectors), ...teamTools(wb, orders, connectors)]) ctx.tools.register(tool);
  for (const route of routes(wb, connectors, kali, lifecycle, runtime, monitor, taskLifecycle)) ctx.connection.fetch.register(route);
  ctx.systemPrompt.section({ name: 'plugin:dsh-workbench', order: 160, text: GUIDANCE });
  ctx.systemPrompt.section({ name: 'plugin:dsh-workbench-supervisor', order: 161, text: context => wb.store.state.tasks.some(t => t.sessionId === context.agent?.id && t.teamMode === 'supervisor') ? SUPERVISOR_GUIDANCE : '' });
}
