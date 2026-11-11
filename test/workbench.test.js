import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Workbench, intentHints } from '../lib/core.js';
import { Connectors } from '../lib/connectors.js';
import { guard } from '../lib/http.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbench-')), file = join(dir, 'state.json');
  const store = await new Store(file).open(), wb = new Workbench(store);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = await wb.project({ name: '样例项目', cwd: dir });
  const task = await wb.create({ projectId: project.id, brief: '整理项目进度并给出后续建议' });
  await wb.bind(task.id, 'employee-1');
  return { dir, file, store, wb, project, task };
}
const plan = { objective: '给老板一个可决策的进度摘要', constraints: ['只读现有资料'], assumptions: [], stages: [{ title: '整理进度', acceptance: '每个结论有来源' }, { title: '后续建议', acceptance: '建议有优先级和依据' }] };
test('完整任务：分支提问、独立阶段继续、持久答复、阶段交付、人工验收', async t => {
  const { wb, task, file } = await fixture(t);
  await wb.plan(task.id, plan);
  const q = await wb.question(task.id, { stageId: 's2', question: '优先交付还是性能？', reason: '优先级影响后续安排', recommendation: '先交付', options: ['先交付', '先性能'] });
  await wb.checkpoint(task.id, { stageId: 's1', summary: '进度已整理', remaining: ['等待下一阶段决策'], evidence: ['文档：progress.md'], done: true });
  await assert.rejects(wb.checkpoint(task.id, { stageId: 's2' }), /等待老板决策/);
  await assert.rejects(wb.review(task.id, '完成'), /未交付阶段/);
  const answered = await wb.answer(task.id, q.id, '先交付'); assert.ok(answered.deliveryId); assert.equal(answered.delivered, false);
  await wb.delivered(task.id, q.id);
  await wb.checkpoint(task.id, { stageId: 's2', summary: '建议已排序', remaining: [], evidence: ['文档：next.md'], done: true });
  await wb.review(task.id, '请验收进度和建议'); assert.equal((await wb.snapshot()).tasks[0].status, 'review');
  await wb.accept(task.id); assert.equal(JSON.parse(await readFile(file)).tasks[0].status, 'accepted');
});
test('没有证据不能完成；不同员工不能操作；拒绝重复计划', async t => {
  const { wb, task } = await fixture(t); await wb.plan(task.id, plan);
  await assert.rejects(wb.owned(task.id, 'other-session'), /绑定的员工/);
  await assert.rejects(wb.plan(task.id, plan), /已有计划/);
  await assert.rejects(wb.checkpoint(task.id, { stageId: 's1', summary: '好了', remaining: [], evidence: [], done: true }), /证据引用/);
});
test('人工暂停不会因为回答问题自动恢复', async t => {
  const { wb, task } = await fixture(t); await wb.plan(task.id, plan);
  const q = await wb.question(task.id, { question: '选择范围', reason: '范围不明', recommendation: '本地资料' });
  await wb.pause(task.id); await wb.answer(task.id, q.id, '只看本地');
  assert.equal((await wb.snapshot()).tasks[0].status, 'paused');
  await assert.rejects(wb.checkpoint(task.id, {}), /已暂停/);
  await wb.resume(task.id); assert.equal((await wb.snapshot()).tasks[0].status, 'running');
});
test('并发写入不丢任务；拒绝第二写入进程；失败事务不污染内存', async t => {
  const { store, wb, file, project } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => wb.create({ projectId: project.id, brief: `工作 ${i}` })));
  assert.equal((await wb.snapshot()).tasks.length, 21);
  await assert.rejects(new Store(file).open(), /EEXIST/);
  await assert.rejects(store.change(s => { s.tasks = []; throw new Error('rollback'); }), /rollback/);
  assert.equal((await wb.snapshot()).tasks.length, 21);
});
test('重启恢复任务、回报和待决策，不自动重放执行', async t => {
  const { store, wb, task, file } = await fixture(t); await wb.plan(task.id, plan);
  await wb.question(task.id, { question: '还缺预算', reason: '需要成本上限', recommendation: '先估算' });
  await store.close(); const next = await new Store(file).open();
  try { assert.equal((await next.read()).tasks[0].questions.length, 1); assert.equal((await next.read()).tasks[0].status, 'waiting'); } finally { await next.close(); }
});
test('分词不能把两个同名候选变成唯一项目或授权', () => {
  const hints = intentHints('查看银行项目', [{ id: 'a', name: '银行', aliases: [] }, { id: 'b', name: '银行项目', aliases: [] }]);
  assert.deepEqual(hints.projectCandidates, ['a', 'b']); assert.equal(hints.needsSemanticParsing, true); assert.ok(hints.terms.length);
});
test('跨站写入、DNS rebinding Host 和非本地请求被拒绝', () => {
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7777', origin: 'http://127.0.0.1:7777', 'x-dsh-workbench': '1' } };
  guard(req);
  assert.throws(() => guard({ ...req, headers: { ...req.headers, origin: 'https://unrelated.example' } }), /跨站/);
  assert.throws(() => guard({ ...req, headers: { ...req.headers, host: 'unrelated.example' } }), /Host/);
  assert.throws(() => guard({ ...req, socket: { remoteAddress: '192.0.2.1' } }), /本机/);
});
async function connectorFixture(t, fetchImpl) {
  const f = await fixture(t); await f.wb.plan(f.task.id, plan);
  process.env.DSH_WORKBENCH_TEST_TOKEN = 'test-only'; t.after(() => delete process.env.DSH_WORKBENCH_TEST_TOKEN);
  const config = { baseUrl: 'http://127.0.0.1:9999', tokenEnv: 'DSH_WORKBENCH_TEST_TOKEN', projects: { [f.project.id]: { externalId: 'demo', grants: [{ taskId: f.task.id, actions: ['submit'], scope: '本地实验资料', expiresAt: '2099-01-01T00:00:00Z' }] } } };
  return { ...f, connectors: new Connectors(f.store, { cyberstrikeai: config, artex: config }, fetchImpl) };
}
test('外部提交绑定项目、发送幂等键、重复调用不重复派工', async t => {
  const requests = [];
  const f = await connectorFixture(t, async (url, opts) => { requests.push({ url: url.href, opts }); return new Response(JSON.stringify({ runId: 'r1', status: 'running' })); });
  const task = await f.wb.owned(f.task.id, 'employee-1');
  const a = await f.connectors.submit(task, 'cyberstrikeai', '整理本地资料', 'step1');
  const b = await f.connectors.submit(task, 'cyberstrikeai', '整理本地资料', 'step1');
  assert.equal(a.id, b.id); assert.equal(requests.length, 1); assert.equal(JSON.parse(requests[0].opts.body).projectId, 'demo');
  assert.equal(requests[0].opts.headers['Idempotency-Key'], `${task.id}:step1`);
  await assert.rejects(f.connectors.submit(task, 'cyberstrikeai', '改变指令', 'step1'), /发生变化/);
});
test('超时保留未知状态，禁止换键重试，也不把空闲当作完成', async t => {
  let calls = 0;
  const f = await connectorFixture(t, async () => { calls++; throw new Error('timeout'); });
  const task = await f.wb.owned(f.task.id, 'employee-1');
  await assert.rejects(f.connectors.submit(task, 'artex', '整理', 'one'), /结果未知/);
  await assert.rejects(f.connectors.submit(task, 'artex', '整理', 'two'), /待核实/);
  assert.equal(calls, 1); assert.equal((await f.wb.snapshot()).tasks[0].runs[0].status, 'unknown');
});
test('没有任务级 grant 不允许派工，不能借用另一个项目', async t => {
  const f = await connectorFixture(t, async () => { throw new Error('不应联网'); });
  const task = await f.wb.owned(f.task.id, 'employee-1');
  await assert.rejects(f.connectors.submit({ ...task, id: 'other-task' }, 'artex', '整理', 'one'), /授权配置/);
  await assert.rejects(f.connectors.status({ ...task, projectId: 'other-project' }, 'artex'), /尚未绑定/);
});
