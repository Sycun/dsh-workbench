import { randomUUID, createHash } from 'node:crypto';
import { required } from './core.js';
import { workerAssignment } from './team-prompts.js';

const now = () => new Date().toISOString();
const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const list = (value, label, max = 30) => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} 必须是最多 ${max} 项的列表`);
  return value.map(v => required(v, label, 4000));
};
const last = order => order.attempts.at(-1);
const inFlight = order => ['starting', 'running', 'reporting'].includes(order.state);
const canRun = (task, order, project) => ['running', 'waiting'].includes(task.status)
  && (!project.lifecycle || project.lifecycle === 'active')
  && !task.questions.some(q => !q.answer && (!q.stageId || q.stageId === order.stageId));
const current = (s, taskId, orderId) => {
  const task = s.tasks.find(t => t.id === taskId), order = task?.workOrders?.find(o => o.id === orderId);
  if (!task || !order) throw new Error('工作单不存在');
  return { task, order, attempt: last(order), project: s.projects.find(p => p.id === task.projectId) };
};
const audit = (s, task, order, type, data = {}) => {
  task.updatedAt = now();
  s.events.push({ id: randomUUID(), taskId: task.id, at: task.updatedAt, type, data: { orderId: order.id, revision: order.revision, ...data } });
};
const notice = order => { order.notification = { id: `workbench-order:${order.id}:${order.revision}:${order.state}`, delivered: false }; };
export const TEAM_LIMITS = Object.freeze({ parallel: 2, rework: 2, orders: 12, attempts: 24, toolCalls: 40, timeoutMinutes: 20 });
const WORKER_TOOLS = ['workbench_worker_get', 'workbench_worker_report', 'workbench_worker_connector_status', 'workbench_worker_connector_submit'];

/** Durable work orders. Only the bound supervisor can dispatch/review; workers can only report their own revision. */
export class WorkOrders {
  constructor(wb, host, connectors) {
    this.wb = wb; this.store = wb.store; this.host = host; this.connectors = connectors;
    this.handles = new Map(); this.calls = new Map(); this.workerStates = {}; this.closed = false;
    this.startController = new AbortController();
  }
  locate(sessionId) {
    for (const task of this.store.state.tasks) for (const order of task.workOrders || []) {
      const attempt = order.attempts.find(a => a.workerSessionId === sessionId);
      if (attempt) return { task, order, attempt, project: this.store.state.projects.find(p => p.id === task.projectId) };
    }
  }
  async worker(taskId, orderId, revision, sessionId) {
    await this.store.tail;
    const found = this.locate(sessionId);
    if (!found || found.task.id !== taskId || found.order.id !== orderId || found.order.revision !== revision || found.attempt !== last(found.order)) throw new Error('仅当前工作单绑定的专员可以操作此版本');
    return copy(found);
  }
  guard(exec) {
    const found = this.locate(exec.agent?.id);
    if (!found) {
      const supervisor = this.store.state.tasks.find(t => t.sessionId === exec.agent?.id && t.teamMode === 'supervisor');
      if (supervisor && this.host.isDelegation(exec.name, exec.agent)) return '本工作台请用 workbench_dispatch 创建持久工作单，不直接派生未登记的专员';
      return;
    }
    const { task, order, attempt, project } = found;
    if (attempt !== last(order) || !inFlight(order)) return '该工作单版本已结束，不能继续执行';
    if (exec.name === 'workbench_worker_report') return;
    if (!canRun(task, order, project)) return '主管任务已暂停或本阶段待决策，请停止执行并回报已有结果';
    if (this.host.isDelegation(exec.name, exec.agent) || (!order.allowedTools.includes(exec.name) && !WORKER_TOOLS.includes(exec.name))) return '该工具不在当前工作单允许的工具范围内，请向主管回报需要的能力';
    if (Date.now() >= Date.parse(attempt.deadline)) return '本工作单已达到时间上限，请使用 workbench_worker_report 回报未完成事项';
    const count = (this.calls.get(attempt.workerSessionId) || 0) + 1;
    this.calls.set(attempt.workerSessionId, count);
    if (count > TEAM_LIMITS.toolCalls) return '本工作单已达到工具调用上限，请使用 workbench_worker_report 回报未完成事项';
  }
  capabilities(agent) {
    return { available: this.host.available(), limits: TEAM_LIMITS, tools: this.host.tools(agent).filter(t => !t.name.startsWith('workbench_') && !this.host.isDelegation(t.name, agent) && !['ask_user_question', 'send_message'].includes(t.name)).map(t => ({ name: t.name, description: t.description?.slice(0, 180) })), workerTools: WORKER_TOOLS };
  }
  async dispatch(task, input, agent) {
    if (!this.host.available()) throw new Error('当前 DSH 没有可用的独立上下文子 Agent 提供方');
    const stageId = required(input.stageId, '阶段 ID', 100), key = required(input.key, '工作单幂等键', 100);
    const acceptedTools = new Set([...this.capabilities(agent).tools.map(t => t.name), ...WORKER_TOOLS]);
    const allowedTools = [...new Set(list(input.allowedTools || [], '允许工具', 50))];
    if (allowedTools.some(name => !acceptedTools.has(name))) throw new Error('工作单包含不可用或不能委派的工具，请先读取 workbench_team_capabilities');
    const acceptance = list(input.acceptance, '验收标准', 12); if (!acceptance.length) throw new Error('工作单至少需要一条验收标准');
    const dependencies = [...new Set(list(input.dependencies || [], '依赖工作单', 12))];
    const execution = await this.host.validateExecution(input.execution || {});
    const spec = { stageId, title: required(input.title, '专员工作名称', 200), objective: required(input.objective, '工作目标', 8000), inputs: list(input.inputs || [], '输入资料'), constraints: list(input.constraints || [], '约束'), acceptance, allowedTools, dependencies, execution };
    const fingerprint = digest(spec);
    const order = await this.store.change(s => {
      const t = s.tasks.find(t => t.id === task.id), project = s.projects.find(p => p.id === t.projectId);
      if (!t.plan?.stages.some(st => st.id === stageId && st.status !== 'done') || !canRun(t, spec, project)) throw new Error('当前阶段不可派工，请先计划或处理阻塞');
      t.workOrders ||= [];
      const existing = t.workOrders.find(o => o.key === key);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('同一工作单幂等键的目标或条件发生变化'); return existing; }
      if (t.workOrders.length >= TEAM_LIMITS.orders) throw new Error('已达到本任务工作单上限，请先向老板汇报');
      if (dependencies.some(id => !t.workOrders.some(o => o.id === id))) throw new Error('依赖必须是本任务已登记的工作单');
      const order = { id: randomUUID(), key, fingerprint, ...spec, acceptance: acceptance.map((text, i) => ({ id: `c${i + 1}`, text })), revision: 1, state: 'queued', attempts: [], createdAt: now() };
      t.workOrders.push(order); audit(s, t, order, 'order.created'); return order;
    });
    await this.tick();
    return copy(current(this.store.state, task.id, order.id).order);
  }
  async report(args, sessionId) {
    const found = await this.worker(args.taskId, args.orderId, args.revision, sessionId);
    if (!['completed', 'blocked', 'failed'].includes(args.outcome)) throw new Error('专员回报状态无效');
    const result = { outcome: args.outcome, summary: required(args.summary, '工作摘要', 12000), completed: list(args.completed || [], '完成事项'), missing: list(args.missing || [], '未完成事项'), evidence: list(args.evidence || [], '证据'), artifacts: list(args.artifacts || [], '本地文件', 20), requestedDecision: typeof args.requestedDecision === 'string' ? args.requestedDecision.trim().slice(0, 4000) : '' };
    if (result.outcome === 'completed' && (!result.evidence.length || result.missing.length)) throw new Error('完成回报必须有证据且没有未完成事项');
    if (result.outcome !== 'completed' && !result.missing.length) throw new Error('未完成回报必须说明缺口');
    if (!inFlight(found.order)) throw new Error('工作单已结束');
    const resultDigest = digest(result);
    if (found.attempt.result) { if (found.attempt.result.digest !== resultDigest) throw new Error('该版本已经提交结果'); return found.attempt.result; }
    const artifacts = [];
    for (const path of result.artifacts) {
      const ref = await this.wb.outputs.inspect(args.taskId, path);
      artifacts.push({ path: ref.path, sha256: ref.sha256, bytes: ref.bytes });
    }
    return this.store.change(s => {
      const { task, order, attempt } = current(s, args.taskId, args.orderId);
      if (order.revision !== args.revision || attempt.workerSessionId !== sessionId || !inFlight(order)) throw new Error('工作单版本已变化，旧结果未接收');
      if (attempt.result) { if (attempt.result.digest !== resultDigest) throw new Error('该版本已经提交结果'); return attempt.result; }
      attempt.result = { ...result, artifacts, digest: resultDigest, at: now(), reportedBy: sessionId };
      order.state = 'reporting'; audit(s, task, order, 'order.reported'); return attempt.result;
    });
  }
  async verify(task, input) {
    const state = await this.store.read(), found = current(state, task.id, input.orderId), attempt = found.attempt;
    if (found.order.revision !== input.revision || found.order.state !== 'reported' || !attempt?.result) throw new Error('只能验收已结束专员当前版本的结果');
    if (input.resultDigest !== attempt.result.digest) throw new Error('结果版本已变化，请重新读取工作单');
    if (!Array.isArray(input.checks) || input.checks.length !== found.order.acceptance.length) throw new Error('请逐项核对工作单全部验收标准');
    const allowedEvidence = new Set([...attempt.result.evidence, ...attempt.result.artifacts.map(a => a.path)]);
    const checks = input.checks.map(check => {
      const criterion = found.order.acceptance.find(c => c.id === check.criterionId);
      if (!criterion || typeof check.passed !== 'boolean') throw new Error('验收项或结果无效');
      const evidence = list(check.evidence || [], '核实证据');
      if (check.passed && (!evidence.length || evidence.some(e => !allowedEvidence.has(e)))) throw new Error('通过的验收项必须原样引用本版本回报中的证据或已验证本地文件；可用引用：' + JSON.stringify([...allowedEvidence]).slice(0, 8000));
      return { criterionId: criterion.id, passed: check.passed, evidence, method: required(check.method, '检查方法与结论', 2000) };
    });
    if (new Set(checks.map(c => c.criterionId)).size !== checks.length) throw new Error('验收项不能重复');
    const passed = checks.every(c => c.passed) && attempt.result.outcome === 'completed';
    if (passed) {
      for (const artifact of attempt.result.artifacts) await this.wb.outputs.inspect(task.id, artifact.path, artifact);
      if (found.task.runs.some(r => r.workOrderId === found.order.id && ['submitting', 'unknown', 'accepted'].includes(r.status))) throw new Error('此工作单的远端运行尚未核实完成');
      for (const artifact of attempt.result.artifacts) await this.wb.outputs.register(task.id, { kind: 'local', location: artifact.path, sourceReference: `work-order:${found.order.id}:${artifact.path}`, description: found.order.title, required: true });
      await this.wb.outputs.ensureReady(task.id, { verify: true });
    }
    const feedback = passed ? '' : required(input.feedback, '返工要求或阻塞原因', 4000);
    await this.store.change(s => {
      const { task: t, order: o, attempt: a, project } = current(s, task.id, input.orderId);
      if (o.revision !== input.revision || o.state !== 'reported' || !canRun(t, o, project)) throw new Error('任务状态或工作单版本已变化');
      a.verification = { by: t.sessionId, checks, passed, feedback, at: now() };
      if (passed) o.state = 'accepted';
      else if (a.result.outcome !== 'blocked' && o.attempts.length <= TEAM_LIMITS.rework && t.workOrders.reduce((n, item) => n + item.attempts.length, 0) < TEAM_LIMITS.attempts) {
        o.revision++; o.state = 'queued'; o.feedback = feedback;
      } else { o.state = 'blocked'; o.blocker = a.result.requestedDecision || feedback; notice(o); }
      audit(s, t, o, passed ? 'order.accepted' : 'order.rework', { feedback }); return null;
    });
    await this.tick(); return copy(current(this.store.state, task.id, input.orderId).order);
  }
  async retry(task, input) {
    await this.store.change(s => {
      const { task: t, order, project } = current(s, task.id, input.orderId);
      if (!['failed', 'interrupted', 'blocked', 'paused'].includes(order.state) || !canRun(t, order, project)) throw new Error('该工作单现在不能重派');
      if (order.revision !== input.revision) throw new Error('工作单版本已变化');
      if (order.attempts.length > TEAM_LIMITS.rework || t.workOrders.reduce((n, o) => n + o.attempts.length, 0) >= TEAM_LIMITS.attempts) throw new Error('工作单尝试预算已耗尽，请向老板汇报，不能换幂等键绕过');
      if (last(order)?.unknownStart) throw new Error('上次启动结果未知，需要先核实员工会话，不能重派');
      order.feedback = required(input.reason, '重新派工的依据', 4000); order.revision++; order.state = 'queued'; audit(s, t, order, 'order.retried'); return null;
    });
    await this.tick(); return copy(current(this.store.state, task.id, input.orderId).order);
  }
  async settle(taskId, orderId, revision, result = {}) {
    if (this.closed) return;
    await this.store.change(s => {
      const { task, order, attempt } = current(s, taskId, orderId);
      if (order.revision !== revision || !inFlight(order)) return null;
      attempt.endedAt = now(); attempt.stopReason = result.stopReason || 'inactive'; attempt.toolCalls = this.calls.get(attempt.workerSessionId) || 0;
      if (attempt.result) order.state = 'reported';
      else { order.state = task.status === 'paused' ? 'paused' : result.stopReason === 'error' ? 'failed' : 'interrupted'; order.blocker = '专员本轮已结束但未提交结构化回报；请核对现有记录再决定是否重派'; }
      attempt.state = order.state; notice(order); audit(s, task, order, 'order.settled'); return null;
    });
  }
  tick() {
    if (this.pending) return this.pending;
    const promise = this.tickOnce(); this.pending = promise;
    promise.finally(() => { if (this.pending === promise) this.pending = null; }).catch(() => {}); return promise;
  }
  async tickOnce() {
    if (this.closed) return;
    // Reconcile exact known child IDs before admitting fresh work; never silently replay a starting child.
    for (const task of (await this.store.read()).tasks) for (const order of task.workOrders || []) if (inFlight(order)) {
      const attempt = last(order); if (!attempt) continue;
      try {
        const state = await this.host.state(attempt.workerSessionId); this.workerStates[order.id] = { running: state.running, pendingInput: state.pendingInput || [] };
        if (Date.now() >= Date.parse(attempt.deadline) || !canRun(task, order, this.store.state.projects.find(p => p.id === task.projectId))) await this.host.cancel(task.sessionId, attempt.workerSessionId);
        if (!state.running && !state.queue?.length && !state.pendingInput?.length && !this.starting?.has(attempt.workerSessionId)) await this.settle(task.id, order.id, order.revision);
      } catch (error) {
        // Missing cold child after restart is an interrupted startup, not proof of no side effects.
        if (!this.handles.has(attempt.workerSessionId)) await this.store.change(s => {
          const live = current(s, task.id, order.id); if (live.order.revision !== order.revision || !inFlight(live.order)) return null;
          live.order.state = 'interrupted'; live.order.blocker = '无法核实原专员会话，请从 DSH 检查已有记录'; live.attempt.unknownStart = true; notice(live.order); return null;
        });
      }
    }
    for (const task of (await this.store.read()).tasks) for (const order of task.workOrders || []) {
      if (this.closed) return;
      const project = this.store.state.projects.find(p => p.id === task.projectId);
      if (order.state !== 'queued' || !canRun(task, order, project) || !order.dependencies.every(id => task.workOrders.find(o => o.id === id)?.state === 'accepted')) continue;
      if (this.store.state.tasks.flatMap(t => t.workOrders || []).filter(inFlight).length >= TEAM_LIMITS.parallel) return;
      await this.start(task.id, order.id);
    }
  }
  async start(taskId, orderId) {
    const prepared = await this.store.change(s => {
      const { task, order, project } = current(s, taskId, orderId);
      if (order.state !== 'queued' || !canRun(task, order, project)) return null;
      if (task.workOrders.reduce((n, o) => n + o.attempts.length, 0) >= TEAM_LIMITS.attempts) { order.state = 'blocked'; order.blocker = '本任务已达到专员启动次数上限'; notice(order); return null; }
      const attempt = { revision: order.revision, workerSessionId: `wb-${order.id}-r${order.revision}`, state: 'starting', startedAt: now(), deadline: new Date(Date.now() + TEAM_LIMITS.timeoutMinutes * 60000).toISOString() };
      order.attempts.push(attempt); order.state = 'starting'; audit(s, task, order, 'order.starting'); return { task, order, project, attempt };
    });
    if (!prepared || this.closed) return;
    const { task, order, project, attempt } = prepared;
    this.starting ||= new Set(); this.starting.add(attempt.workerSessionId);
    try {
      await this.wb.outputs.ensureReady(taskId);
      if (!canRun(this.store.state.tasks.find(t => t.id === taskId), order, project)) {
        await this.store.change(s => { current(s, taskId, orderId).order.state = 'paused'; return null; }); return;
      }
      const handle = await this.host.start({ task, order, attempt, project, prompt: workerAssignment(task, order, attempt, project), signal: this.startController.signal });
      this.handles.set(attempt.workerSessionId, handle);
      await this.store.change(s => { const live = current(s, taskId, orderId); if (live.order.state === 'starting') live.order.state = 'running'; last(live.order).state = 'running'; return null; });
      handle.result.then(result => this.settle(taskId, orderId, order.revision, result), () => this.settle(taskId, orderId, order.revision, { stopReason: 'error' }))
        .finally(async () => { this.handles.delete(attempt.workerSessionId); await handle.dispose().catch(() => {}); }).catch(() => {});
      if (!canRun(this.store.state.tasks.find(t => t.id === taskId), order, project)) await this.host.cancel(task.sessionId, attempt.workerSessionId);
    } catch (error) {
      if (!this.closed) await this.store.change(s => { const live = current(s, taskId, orderId); live.order.state = 'failed'; live.order.blocker = '专员启动失败：' + String(error.message).slice(0, 500); last(live.order).unknownStart = error.code === 'DUPLICATE_CHILD'; notice(live.order); return null; });
    } finally { this.starting.delete(attempt.workerSessionId); }
  }
  async pause(taskId) {
    const task = (await this.store.read()).tasks.find(t => t.id === taskId);
    for (const order of task?.workOrders || []) if (inFlight(order)) await this.host.cancel(task.sessionId, last(order).workerSessionId);
  }
  async reconcile(taskId, orderId, evidence) {
    required(evidence, '人工核实记录', 4000);
    const found = current(await this.store.read(), taskId, orderId);
    if (!found.attempt?.unknownStart) throw new Error('该工作单没有待核实的启动记录');
    try {
      const state = await this.host.state(found.attempt.workerSessionId);
      if (state.running || state.queue?.length || state.pendingInput?.length) throw new Error('原专员仍在运行或待处理，不能放行重派');
    } catch (error) {
      if (!/not.found|不存在/i.test(String(error.code || '') + ' ' + error.message)) throw error;
    }
    return this.store.change(s => {
      const { task, order, attempt } = current(s, taskId, orderId);
      if (attempt.workerSessionId !== found.attempt.workerSessionId) throw new Error('工作单版本已变化');
      attempt.unknownStart = false; attempt.humanReconciliation = { evidence, at: now() };
      order.state = 'interrupted'; order.blocker = '老板已核实原运行结束，主管可按原范围决定是否重派';
      order.notification = { id: `workbench-order-reconciled:${randomUUID()}`, delivered: false };
      audit(s, task, order, 'order.reconciled', { evidence }); return order;
    });
  }
  attach(ctx) {
    ctx.tools.guard(exec => this.guard(exec));
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2000); this.timer.unref?.();
    void this.tick().catch(() => {});
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.startController.abort();
    await this.pending?.catch(() => {});
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
  }
}
