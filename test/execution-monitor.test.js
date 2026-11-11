import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { ExecutionMonitor } from '../lib/execution-monitor.js';
import { Connectors } from '../lib/connectors.js';
import { ChangeFeed } from '../lib/change-feed.js';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-monitor-')), store = await new Store(join(dir, 'state.json')).open(), wb = new Workbench(store);
  const project = await wb.project({ cwd: dir }); const task = await wb.create({ projectId: project.id, brief: '离线验证执行监控' });
  await wb.bind(task.id, 'employee'); await wb.plan(task.id, { objective: '检查监控', stages: [{ title: '验证', acceptance: '有独立证据' }] });
  const prompts = [], sessions = { state: async () => ({ cursor: 1, running: false, queue: [], pendingInput: [] }), prompt: async r => { prompts.push(r); } };
  const connectors = new Connectors(store, { cyberstrikeai: { baseUrl: 'http://localhost:1' }, artex: { baseUrl: 'http://localhost:2' } });
  const monitor = new ExecutionMonitor(wb, connectors, sessions);
  t.after(async () => { await monitor.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, wb, project, task, monitor, connectors, sessions, prompts };
}
test('原生流只展示正文和工具名，跨会话隔离且不逐 token 落盘', async t => {
  const f = await fixture(t), before = await readFile(f.store.file, 'utf8');
  f.monitor.stream('unrelated', { type: 'start' }); assert.deepEqual(f.monitor.live, {});
  f.monitor.stream('employee', { type: 'start', attemptId: 'a', revision: 1 });
  for (const [index, chunk] of [{ type: 'reasoning-delta', index: 0, text: 'private-thought' }, { type: 'text-delta', index: 1, text: '公开内容' }, { type: 'tool-call-delta', index: 2, name: 'read_file', argumentsDelta: 'private-argument' }].entries()) f.monitor.stream('employee', { type: 'chunk', attemptId: 'a', index, chunk });
  assert.equal(f.monitor.live[f.task.id].text, '公开内容'); assert.equal(f.monitor.live[f.task.id].tool, 'read_file');
  assert.ok(!JSON.stringify(f.monitor.view()).includes('private-')); assert.equal(await readFile(f.store.file, 'utf8'), before);
  await f.monitor.event('employee', { type: 'assistant/message', seq: 9, time: Date.now(), data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '已读取资料' }] } } });
  await f.monitor.event('employee', { type: 'turn/end', seq: 10, data: { reason: { kind: 'completed' } } });
  const saved = (await f.wb.snapshot()).tasks[0]; assert.equal(saved.status, 'running'); assert.equal(saved.lastExecution.status, 'idle'); assert.equal(saved.assistantMessages[0].text, '已读取资料');
});
test('Cyber 独立回执自动结束、保存本机结果、幂等通知；不向无关项目派工', async t => {
  const f = await fixture(t); await f.wb.linkProject(f.project.id, 'cyberstrikeai', 'p7');
  await f.store.change(s => { s.tasks[0].runs.push({ id: 'r1', connector: 'cyberstrikeai', status: 'accepted', receipt: { runId: 'remote1', conversationId: 'c1' } }); return null; });
  const calls = []; f.connectors.request = async (_, path) => { calls.push(path); return { runId: 'remote1', conversationId: 'c1', status: 'completed', result: { response: '离线结果' } }; };
  await f.monitor.tick(); await f.monitor.tick();
  const saved = (await f.wb.snapshot()).tasks[0]; assert.equal(saved.runs[0].status, 'completed');
  assert.equal(saved.runs[0].reconciliation.by, 'platform-receipt');
  assert.ok((await readFile(saved.runs[0].reconciliation.evidence, 'utf8')).includes('离线结果'));
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].requestId, 'workbench-result:r1');
  assert.deepEqual(calls, ['/api/eino-agent/runs/remote1']); assert.equal(saved.status, 'running');
});
test('暂停和待决策时仍回收结果，但不会自动唤醒；恢复后只通知一次', async t => {
  const f = await fixture(t); await f.wb.pause(f.task.id);
  await f.store.change(s => { s.tasks[0].runs.push({ id: 'r', status: 'accepted', connector: 'cyberstrikeai' }); return null; });
  f.connectors.observeRun = async () => ({ result: { status: 'completed' }, outcome: 'completed', status: 'completed' });
  await f.monitor.tick(); assert.equal(f.prompts.length, 0);
  await f.wb.resume(f.task.id); await f.monitor.tick(); assert.equal(f.prompts.length, 1);
  const current = (await f.wb.snapshot()).tasks[0];
  await f.monitor.deliver({ ...current, questions: [{ answer: null }], runs: [{ ...current.runs[0], notification: { id: 'another', delivered: false } }] }, { running: false, queue: [], pendingInput: [] });
  assert.equal(f.prompts.length, 1);
});
test('ARTEX 空闲不等于完成；观察不会调用停止或提交接口', async t => {
  const f = await fixture(t); await f.wb.linkProject(f.project.id, 'artex', '7');
  await f.store.change(s => { s.tasks[0].runs.push({ id: 'r', status: 'accepted', connector: 'artex' }); return null; });
  const calls = []; f.connectors.request = async (_, path, body) => { calls.push({ path, body }); return path.endsWith('/status') ? { running: false } : { status: 'running' }; };
  await f.monitor.tick(); assert.equal((await f.wb.snapshot()).tasks[0].runs[0].status, 'accepted'); assert.equal(f.prompts.length, 0);
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.body === undefined));
});
test('断线退避、不重放提交；回执 ID 错配不标完成', async t => {
  const f = await fixture(t); await f.wb.linkProject(f.project.id, 'cyberstrikeai', 'p');
  await f.store.change(s => { s.tasks[0].runs.push({ id: 'r', status: 'accepted', connector: 'cyberstrikeai', receipt: { runId: 'owned' } }); return null; });
  let calls = 0; f.connectors.request = async () => { calls++; return { runId: 'different', status: 'completed' }; };
  await f.monitor.tick(); await f.monitor.tick();
  assert.equal(calls, 1); assert.equal((await f.wb.snapshot()).tasks[0].runs[0].status, 'accepted'); assert.equal(f.monitor.remote.r.status, 'unavailable');
});
test('暂停只移除工作台自有排队消息并取消本会话当前轮', async t => {
  const f = await fixture(t), calls = [];
  f.sessions.state = async () => ({ queue: [{ id: 'mine', rpcId: f.task.requestId }, { id: 'other', rpcId: 'manual-user-message' }] });
  f.sessions.updateQueue = async r => calls.push(r.itemId); f.sessions.cancel = async r => calls.push(r.sessionId);
  await f.monitor.pause((await f.wb.snapshot()).tasks[0]); assert.deepEqual(calls, ['mine', 'employee']);
});
test('重复返回内容与无变化事务不重写状态或成果索引', async t => {
  const f = await fixture(t), payload = { result: 'same' };
  const first = await f.wb.outputs.receive(f.task.id, 'artex', 'status', payload);
  const index = first.localOutput.manifestPath, original = (await stat(index)).mtimeMs, stateTime = (await stat(f.store.file)).mtimeMs;
  const next = await f.wb.outputs.receive(f.task.id, 'artex', 'status', payload);
  assert.equal(first.item.id, next.item.id); assert.equal((await stat(index)).mtimeMs, original); assert.equal((await stat(f.store.file)).mtimeMs, stateTime);
  await f.wb.outputs.ensureReady(f.task.id); assert.equal((await stat(index)).mtimeMs, original);
});
test('增量接口只返回变更任务，旧游标失效后安全全量恢复且不下发审计事件', () => {
  const feed = new ChangeFeed(), base = { projects: [{ id: 'p' }], tasks: [{ id: 'a', brief: 'A' }, { id: 'b', brief: 'B' }], events: [{ secret: 'unused-history' }], executionStates: {} };
  const first = feed.read(base); assert.equal(first.reset, true); assert.equal(first.events, undefined);
  assert.equal(feed.read(base, first.cursor).unchanged, true);
  const changed = feed.read({ ...base, tasks: [{ id: 'a', brief: 'changed' }, base.tasks[1]] }, first.cursor);
  assert.deepEqual(changed.tasks, [{ id: 'a', brief: 'changed' }]); assert.deepEqual(changed.projects, []);
  assert.equal(feed.read(base, 'stale-cursor').reset, true);
});
test('取消与后台结果通知串行化，暂停返回前停止已入队的本任务通知', async t => {
  const f = await fixture(t), calls = [];
  let start, finish; const started = new Promise(resolve => { start = resolve; }), release = new Promise(resolve => { finish = resolve; });
  await f.store.change(s => { s.tasks[0].runs.push({ id: 'r', status: 'completed', notification: { id: 'notice', delivered: false }, reconciliation: { evidence: 'test fixture' } }); return null; });
  f.sessions.prompt = async () => { calls.push('prompt'); start(); await release; };
  f.sessions.cancel = async () => { calls.push('cancel'); };
  const delivery = f.monitor.deliver((await f.wb.snapshot()).tasks[0], { running: false, queue: [], pendingInput: [] });
  await started; const paused = await f.wb.pause(f.task.id), pausing = f.monitor.pause(paused);
  finish(); await Promise.all([delivery, pausing]);
  assert.deepEqual(calls, ['prompt', 'cancel']); assert.equal((await f.wb.snapshot()).tasks[0].status, 'paused');
});
test('对话配置保存后以稳定消息 ID 通知员工，无效读取恢复后清除断线错误', async t => {
  const f = await fixture(t);
  await f.store.change(s => { s.tasks[0].connectionProposals = [{ id: 'cp1', status: 'applied', notification: { id: 'workbench-connection:cp1', delivered: false } }]; return null; });
  f.monitor.publish(f.task.id, { status: 'unavailable', error: '断线' });
  await f.monitor.tick(); await f.monitor.tick();
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].requestId, 'workbench-connection:cp1'); assert.equal(f.monitor.live[f.task.id].error, null);
});
