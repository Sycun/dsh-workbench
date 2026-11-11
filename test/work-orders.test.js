import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { WorkOrders } from '../lib/work-orders.js';
import { ExecutionMonitor } from '../lib/execution-monitor.js';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-team-')), store = await new Store(join(dir, 'state.json')).open(), wb = new Workbench(store);
  const p = await wb.project({ cwd: dir }), task = await wb.create({ projectId: p.id, brief: '用独立专员整理本地资料' });
  await wb.bind(task.id, 'boss-agent'); await wb.plan(task.id, { objective: '完整结果', stages: [{ title: '收集', acceptance: '有两项证据' }, { title: '交付', acceptance: '有文件' }] });
  const starts = [], states = new Map(), resolvers = new Map(), cancels = [], prompts = [];
  const host = {
    available: () => true, tools: () => [{ name: 'read_file', description: 'read' }, { name: 'write_file', description: 'write' }, { name: 'spawn_agent', description: 'delegate' }],
    isDelegation: name => name === 'spawn_agent', validateExecution: async x => x,
    state: async id => { if (!states.has(id)) throw new Error('not found'); return states.get(id); },
    cancel: async (_, id) => { cancels.push(id); states.set(id, { running: false, queue: [], pendingInput: [] }); },
    start: async value => { starts.push(value); states.set(value.attempt.workerSessionId, { running: true, queue: [], pendingInput: [] }); let resolve; const result = new Promise(r => { resolve = r; }); resolvers.set(value.attempt.workerSessionId, resolve); return { childId: value.attempt.workerSessionId, result, dispose: async () => { resolve({ stopReason: 'aborted' }); } }; }
  };
  const orders = new WorkOrders(wb, host, {}); wb.orders = orders;
  t.after(async () => { await orders.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const spec = key => ({ stageId: 's1', key, title: key, objective: '整理两项', inputs: ['本地样例'], constraints: ['只做本地验证'], acceptance: ['第一项', '第二项'], allowedTools: ['read_file'] });
  const get = async id => (await wb.snapshot()).tasks[0].workOrders.find(o => o.id === id);
  const finish = async (order, result = {}) => {
    const attempt = order.attempts.at(-1), args = { taskId: task.id, orderId: order.id, revision: order.revision, outcome: 'completed', summary: '两项已整理', completed: ['A','B'], missing: [], evidence: ['source:A', 'source:B'], artifacts: [], ...result };
    await orders.report(args, attempt.workerSessionId);
    states.set(attempt.workerSessionId, { running: false, queue: [], pendingInput: [] });
    await orders.settle(task.id, order.id, order.revision, { stopReason: 'completed' });
    return get(order.id);
  };
  const verify = (order, passed = true) => orders.verify(task, { orderId: order.id, revision: order.revision, resultDigest: order.attempts.at(-1).result.digest, checks: order.acceptance.map((c, i) => ({ criterionId: c.id, passed, evidence: passed ? ['source:' + (i ? 'B' : 'A')] : [], method: passed ? '已核对源资料' : '缺少第二项' })), feedback: passed ? '' : '请补齐第二项，保持原范围' });
  return { dir, wb, store, task, orders, starts, states, resolvers, cancels, prompts, host, spec, get, finish, verify };
}
test('主管工作单→独立专员→证据验收→主任务交付，未验收不能先完成阶段', async t => {
  const f = await fixture(t); let order = await f.orders.dispatch(f.task, f.spec('collect'), {});
  assert.equal(order.state, 'running'); assert.equal(f.starts.length, 1); assert.ok(f.starts[0].prompt.includes(order.id));
  await assert.rejects(f.wb.checkpoint(f.task.id, { stageId: 's1', summary: '假完成', remaining: [], evidence: ['fake'], done: true }), /工作单/);
  order = await f.finish(order); assert.equal(order.state, 'reported');
  order = await f.verify(order); assert.equal(order.state, 'accepted');
  await f.wb.checkpoint(f.task.id, { stageId: 's1', summary: '主管已核实', remaining: [], evidence: ['source:A'], done: true });
  assert.equal((await f.wb.snapshot()).tasks[0].plan.stages[0].status, 'done');
});
test('工作单幂等、全局最多两个专员，依赖验收通过后才启动', async t => {
  const f = await fixture(t), a = await f.orders.dispatch(f.task, f.spec('a'), {}), b = await f.orders.dispatch(f.task, f.spec('b'), {});
  const c = await f.orders.dispatch(f.task, { ...f.spec('c'), dependencies: [a.id] }, {});
  assert.equal(c.state, 'queued'); assert.equal(f.starts.length, 2);
  const same = await f.orders.dispatch(f.task, f.spec('a'), {}); assert.equal(same.id, a.id); assert.equal(f.starts.length, 2);
  await assert.rejects(f.orders.dispatch(f.task, { ...f.spec('a'), objective: 'changed' }, {}), /幂等键/);
  const result = await f.finish(a); await f.verify(result); assert.equal(f.starts.length, 3); assert.equal((await f.get(c.id)).state, 'running');
  await assert.rejects(f.orders.dispatch(f.task, { ...f.spec('bad'), dependencies: ['foreign-task-order'] }, {}), /依赖/);
});
test('验收不通过自动返工，保留旧结果并拒绝旧专员覆盖新版本', async t => {
  const f = await fixture(t); const first = await f.orders.dispatch(f.task, f.spec('a'), {}), reported = await f.finish(first), second = await f.verify(reported, false);
  assert.equal(second.revision, 2); assert.equal(second.state, 'running'); assert.equal(second.attempts.length, 2); assert.equal(second.attempts[0].verification.passed, false);
  assert.ok(f.starts[1].prompt.includes('补齐第二项'));
  await assert.rejects(f.orders.worker(f.task.id, second.id, 1, first.attempts[0].workerSessionId), /当前工作单/);
  await assert.rejects(f.orders.worker(f.task.id, second.id, 2, 'another-worker'), /当前工作单/);
});
test('两次返工后转阻塞，不能通过重试突破预算', async t => {
  const f = await fixture(t); let order = await f.orders.dispatch(f.task, f.spec('a'), {});
  for (let i = 0; i < 3; i++) { order = await f.finish(order); order = await f.verify(order, false); }
  assert.equal(order.state, 'blocked'); assert.equal(order.attempts.length, 3); assert.equal(f.starts.length, 3);
  await assert.rejects(f.orders.retry(f.task, { orderId: order.id, revision: order.revision, reason: '再试' }), /预算/);
});
test('专员工具范围、一层委派、暂停和调用预算在执行前检查', async t => {
  const f = await fixture(t), order = await f.orders.dispatch(f.task, f.spec('a'), {}), agent = { id: order.attempts[0].workerSessionId };
  assert.match(f.orders.guard({ name: 'spawn_agent', agent }), /工具/); assert.match(f.orders.guard({ name: 'write_file', agent }), /工具/);
  assert.equal(f.orders.guard({ name: 'read_file', agent }), undefined);
  for (let i = 0; i < 39; i++) assert.equal(f.orders.guard({ name: 'read_file', agent }), undefined);
  assert.match(f.orders.guard({ name: 'read_file', agent }), /上限/); assert.equal(f.orders.guard({ name: 'workbench_worker_report', agent }), undefined);
  await f.wb.pause(f.task.id); await f.orders.pause(f.task.id); assert.equal(f.cancels.length, 1); assert.match(f.orders.guard({ name: 'read_file', agent }), /暂停/);
});
test('检查必须覆盖全部标准且引用当前结果；本地文件改变不能通过验收', async t => {
  const f = await fixture(t), file = join(f.dir, 'result.txt'); await writeFile(file, 'original');
  let order = await f.orders.dispatch(f.task, f.spec('a'), {}); order = await f.finish(order, { artifacts: [file] });
  await writeFile(file, 'changed'); await assert.rejects(f.verify(order), /已变化/);
  await writeFile(file, 'original');
  await assert.rejects(f.orders.verify(f.task, { orderId: order.id, revision: order.revision, resultDigest: 'stale', checks: [] }), /结果版本/);
  await assert.rejects(f.orders.verify(f.task, { orderId: order.id, revision: order.revision, resultDigest: order.attempts[0].result.digest, checks: [{ criterionId: 'c1', passed: true, evidence: ['invented'], method: '猜测' }, { criterionId: 'c2', passed: true, evidence: ['invented'], method: '猜测' }] }), /证据/);
});
test('重启核对已有专员，不重放启动；已结束但无报告转中断', async t => {
  const f = await fixture(t), order = await f.orders.dispatch(f.task, f.spec('a'), {});
  const recovered = new WorkOrders(f.wb, f.host, {}); t.after(() => recovered.close());
  await recovered.tick(); assert.equal(f.starts.length, 1); assert.equal((await f.get(order.id)).state, 'running');
  f.states.set(order.attempts[0].workerSessionId, { running: false, queue: [], pendingInput: [] });
  await recovered.tick(); assert.equal((await f.get(order.id)).state, 'interrupted'); assert.equal(f.starts.length, 1);
});
test('专员回报 blocked 由主管处理，不自动返工或猜老板答案', async t => {
  const f = await fixture(t); let order = await f.orders.dispatch(f.task, f.spec('a'), {});
  order = await f.finish(order, { outcome: 'blocked', missing: ['需要选择资料源'], requestedDecision: '采用 A 还是 B？' });
  order = await f.verify(order, false); assert.equal(order.state, 'blocked'); assert.equal(f.starts.length, 1); assert.equal(order.blocker, '采用 A 还是 B？');
});
test('完成通知唤醒主管一次，阶段问题不会阻塞其他阶段的结果验收通知', async t => {
  const f = await fixture(t); const a = await f.orders.dispatch(f.task, { ...f.spec('a'), stageId: 's2' }, {}); await f.finish(a);
  await f.wb.question(f.task.id, { stageId: 's1', question: '确认资料源', reason: '两个选项', recommendation: 'A', options: ['A','B'] });
  const monitor = new ExecutionMonitor(f.wb, {}, { prompt: async r => f.prompts.push(r) }); t.after(() => monitor.close());
  await monitor.deliver((await f.wb.snapshot()).tasks[0], { running: false, queue: [], pendingInput: [] });
  await monitor.deliver((await f.wb.snapshot()).tasks[0], { running: false, queue: [], pendingInput: [] });
  assert.equal(f.prompts.length, 1); assert.ok(f.prompts[0].content[0].text.includes('workbench_verify'));
});
test('启动未知时不盲目重派，人工核实时仍拒绝运行中的旧专员', async t => {
  const f = await fixture(t); const order = await f.orders.dispatch(f.task, f.spec('a'), {});
  await f.store.change(s => { const o = s.tasks[0].workOrders[0]; o.state = 'interrupted'; o.attempts[0].unknownStart = true; return null; });
  await assert.rejects(f.orders.retry(f.task, { orderId: order.id, revision: 1, reason: '重试' }), /结果未知/);
  await assert.rejects(f.orders.reconcile(f.task.id, order.id, '查过记录'), /仍在运行/);
  f.states.set(order.attempts[0].workerSessionId, { running: false, queue: [], pendingInput: [] });
  await f.orders.reconcile(f.task.id, order.id, '原会话已停止，未运行远端任务');
  assert.equal((await f.get(order.id)).attempts[0].unknownStart, false);
});
