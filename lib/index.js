import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Store, Workbench } from './core.js';
import { Connectors } from './connectors.js';
import { routes } from './http.js';
import { GUIDANCE } from './prompts.js';

export const name = 'workbench';
export const inject = ['tools', 'systemPrompt', 'webServer'];
const text = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const array = (required = false) => ({ type: 'array', items: text(), ...(required ? { required: true } : {}) });

export function makeTools(wb, connectors) {
  const tool = (name, description, parameters, execute) => defineTool({
    name, description, parameters: { taskId: text(true), ...parameters },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { const task = await wb.owned(args.taskId, exec.agent?.id); return execute(task, args); }
  });
  return [
    tool('workbench_get', '读取本员工任务、阶段、待决策事项及项目。', {}, async task => ({ task, project: (await wb.snapshot()).projects.find(p => p.id === task.projectId) })),
    tool('workbench_plan', '记录语义解析后的任务契约；缺少必需信息先提问。', { objective: text(true), constraints: array(), assumptions: array(), stages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: text(true), acceptance: text(true) } } } }, (task, a) => wb.plan(task.id, a)),
    tool('workbench_checkpoint', '提交阶段回报。证据引用仍需核实，不能虚构完成。', { stageId: text(true), summary: text(true), remaining: array(true), evidence: array(), done: { type: 'boolean', required: true } }, (task, a) => wb.checkpoint(task.id, a)),
    tool('workbench_question', '向老板发起持久化决策。仅阻塞 stageId 对应阶段；省略则阻塞全任务。其他独立工作继续，之后结束当前轮等待答复。', { stageId: text(), question: text(true), reason: text(true), recommendation: text(true), options: array() }, (task, a) => wb.question(task.id, a)),
    tool('workbench_review', '阶段全部交付后申请老板验收。', { summary: text(true) }, (task, a) => wb.review(task.id, a.summary)),
    tool('workbench_connector_status', '读取项目已绑定的 CyberStrikeAI 或 ARTEX 状态；不会启动工作。', { connector: { type: 'string', enum: ['cyberstrikeai', 'artex'], required: true } }, (task, a) => connectors.status(task, a.connector)),
    tool('workbench_connector_submit', '向已绑定且已授权的执行端派工，返回回执，不代表完成。同一工作使用稳定 key。', { connector: { type: 'string', enum: ['cyberstrikeai', 'artex'], required: true }, message: text(true), key: text(true) }, (task, a) => connectors.submit(task, a.connector, a.message, a.key))
  ];
}

export async function apply(ctx, config = {}) {
  const file = config.dataFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'workbench', 'state.json');
  const store = await new Store(file).open(), wb = new Workbench(store), connectors = new Connectors(store, config.connectors);
  ctx.effect(() => () => store.close(), 'workbench: store');
  for (const tool of makeTools(wb, connectors)) ctx.tools.register(tool);
  for (const route of routes(wb, connectors)) ctx.webServer.register(route);
  ctx.systemPrompt.section({ name: 'plugin:dsh-workbench', order: 160, text: GUIDANCE });
}
