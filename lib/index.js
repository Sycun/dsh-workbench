import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store, Workbench } from './core.js';
import { Connectors } from './connectors.js';
import { routes } from './http.js';
import { GUIDANCE } from './prompts.js';
import { ProjectLifecycle } from './project-lifecycle.js';
import { KaliLink } from './kali.js';

export const name = 'workbench';
export const inject = ['tools', 'systemPrompt', 'connection', 'workspaceRegistry', 'credentials'];
const text = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const array = (required = false) => ({ type: 'array', items: text(), ...(required ? { required: true } : {}) });

export function makeTools(wb, connectors) {
  const tool = (name, description, parameters, execute) => defineTool({
    name, description, parameters: { taskId: text(true), ...parameters },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { const task = await wb.owned(args.taskId, exec.agent?.id); return execute(task, args); }
  });
  return [
    tool('workbench_get', '读取本员工任务、阶段、待决策事项及项目。', {}, async task => ({ task, project: (await wb.snapshot()).projects.find(p => p.id === task.projectId), connectors: connectors.catalog() })),
    tool('workbench_plan', '记录语义解析后的任务契约；缺少必需信息先提问。', { objective: text(true), constraints: array(), assumptions: array(), stages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: text(true), acceptance: text(true) } } } }, (task, a) => wb.plan(task.id, a)),
    tool('workbench_checkpoint', '提交阶段回报。证据引用仍需核实，不能虚构完成。', { stageId: text(true), summary: text(true), remaining: array(true), evidence: array(), done: { type: 'boolean', required: true } }, (task, a) => wb.checkpoint(task.id, a)),
    tool('workbench_question', '向老板发起持久化决策。仅阻塞 stageId 对应阶段；省略则阻塞全任务。其他独立工作继续，之后结束当前轮等待答复。', { stageId: text(), question: text(true), reason: text(true), recommendation: text(true), options: array() }, (task, a) => wb.question(task.id, a)),
    tool('workbench_review', '阶段全部交付后申请老板验收。', { summary: text(true) }, (task, a) => wb.review(task.id, a.summary)),
    tool('workbench_connector_list', '列出用户已配置的执行端 ID、名称、适配器及启用状态；没有配置时为空，不猜测连接。', {}, async () => ({ connectors: connectors.catalog() })),
    tool('workbench_connector_status', '读取项目已绑定的执行端状态；connector 使用已配置的连接 ID。', { connector: text(true) }, (task, a) => connectors.status(task, a.connector)),
    tool('workbench_connector_submit', '向已绑定且已授权的执行端派工，返回回执，不代表完成。同一工作使用稳定 key。', { connector: text(true), message: text(true), key: text(true) }, (task, a) => connectors.submit(task, a.connector, a.message, a.key))
  ];
}

export async function apply(ctx, config = {}) {
  const file = config.dataFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'workbench', 'state.json');
  const store = await new Store(file).open();
  ctx.effect(() => () => store.close(), 'workbench: store');
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
  for (const tool of makeTools(wb, connectors)) ctx.tools.register(tool);
  for (const route of routes(wb, connectors, kali, lifecycle)) ctx.connection.fetch.register(route);
  ctx.systemPrompt.section({ name: 'plugin:dsh-workbench', order: 160, text: GUIDANCE });
}
