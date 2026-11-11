import { defineTool } from '@deepseek-ai/dsh-tools';
const text = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const array = (required = false) => ({ type: 'array', items: text(), ...(required ? { required: true } : {}) });
const output = { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] };
export function teamTools(wb, orders, connectors) {
  const manager = (name, description, parameters, run) => defineTool({ name, description, parameters: { taskId: text(true), ...parameters }, output,
    async execute(args, exec) { const task = await wb.owned(args.taskId, exec.agent?.id); return JSON.parse(JSON.stringify(await run(task, args, exec))); } });
  const worker = (name, description, parameters, run) => defineTool({ name, description, parameters: { taskId: text(true), orderId: text(true), revision: { type: 'integer', required: true }, ...parameters }, output,
    async execute(args, exec) { const owned = await orders.worker(args.taskId, args.orderId, args.revision, exec.agent?.id); return JSON.parse(JSON.stringify(await run(owned, args, exec))); } });
  return [
    manager('workbench_team_capabilities', '主管读取当前 DSH 可委派的工具名称、子 Agent 可用性与工作单预算。仅列目录，不执行工具。', {}, async (_, __, exec) => orders.capabilities(exec.agent)),
    manager('workbench_dispatch', '主管创建有验收标准的持久工作单，启动或排队一个独立上下文专员。相同工作使用稳定 key；回执不是完成。返回后继续独立工作或结束本轮等待通知，不轮询。', { stageId: text(true), key: text(true), title: text(true), objective: text(true), inputs: array(), constraints: array(), acceptance: array(true), allowedTools: array(true), dependencies: array(), execution: { type: 'object', additionalProperties: true } }, (task, args, exec) => orders.dispatch(task, args, exec.agent)),
    manager('workbench_verify', '主管逐项核对专员本版本结果。通过项必须引用结果中的证据/本地文件，并描述实际检查方法。不通过时给具体反馈，在预算内自动返工；需要老板决定则先请示。', { orderId: text(true), revision: { type: 'integer', required: true }, resultDigest: text(true), checks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { criterionId: text(true), passed: { type: 'boolean', required: true }, evidence: array(true), method: text(true) } } }, feedback: text() }, (task, args) => orders.verify(task, args)),
    manager('workbench_retry', '主管核实失败、中断或阻塞的工作单后重新派工。保留历史版本并消耗尝试预算；不能盲目重复未知副作用。', { orderId: text(true), revision: { type: 'integer', required: true }, reason: text(true) }, (task, args) => orders.retry(task, args)),
    worker('workbench_worker_get', '专员读取自己当前工作单、验收标准、返工意见及原任务范围，不读取其他专员的工作内容。', {}, async ({ task, order, project }) => ({ order, project: { name: project.name, cwd: project.cwd }, taskStatus: task.status, constraints: task.plan.constraints, outputDirectory: task.localOutput?.directory })),
    worker('workbench_worker_report', '专员提交自己工作单的结构化结果并结束当前轮。真实本地文件填 artifacts；未完成时明确缺口和需要主管/老板决定的事项。', { outcome: { type: 'string', required: true, enum: ['completed', 'blocked', 'failed'] }, summary: text(true), completed: array(true), missing: array(true), evidence: array(true), artifacts: array(), requestedDecision: text() }, async (_, args, exec) => { const result = await orders.report(args, exec.agent.id); exec.concludeTurn(); return result; }),
    worker('workbench_worker_connector_status', '专员读取本项目已绑定执行端的状态，结果保存到 Mac 主项目。', { connector: text(true) }, ({ task }, args) => connectors.status(task, args.connector)),
    worker('workbench_worker_connector_submit', '专员在原任务已有有效授权内向已绑定执行端派工。使用跨返工版本稳定的 key，不重复提交未知结果。', { connector: text(true), message: text(true), key: text(true) }, ({ task, order }, args) => connectors.submit(task, args.connector, `[工作单 ${order.id}：${order.title}]\n${args.message}`, `${order.id}:${args.key}`, { workOrderId: order.id, workOrderRevision: order.revision }))
  ];
}
