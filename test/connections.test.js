import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { Connectors } from '../lib/connectors.js';
import { normalizeConnection, expandPath } from '../lib/connection-config.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-tools-')), file = join(dir, 'state.json');
  const store = await new Store(file).open(), wb = new Workbench(store), secrets = new Map();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const credentials = { resolve: async key => secrets.has(key) ? { value: secrets.get(key) } : undefined, set: async (key, value) => secrets.set(key, value) };
  const connectors = new Connectors(store, {}, fetch, null, credentials);
  const project = await wb.project({ name: '', cwd: dir });
  const task = await wb.create({ projectId: project.id, brief: '验证自定义工具协议' }); await wb.bind(task.id, 'employee');
  await wb.plan(task.id, { objective: '验证协议', stages: [{ title: '检查', acceptance: '回执可追踪' }] });
  return { file, wb, store, project, task, connectors, secrets };
}
const config = baseUrl => ({ id: 'my-tool', label: '我的工具', adapter: 'http-json', baseUrl, authType: 'bearer', tokenRef: 'MY_TOOL_TOKEN', healthPath: '/health', statusPath: '/status/{projectId}', submitPath: '/jobs/{projectId}', bodyTemplate: { input: '{message}', context: { task: '{taskId}', project: '{projectId}' }, key: '{idempotencyKey}' }, runStatusPath: '/runs/{runId}', runIdField: 'job.id' });
test('默认接入列表为空；自定义工具真实 HTTP 往返、模板、鉴权和回执查询可用', async t => {
  const f = await fixture(t), calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, key: req.headers['idempotency-key'], body: body ? JSON.parse(body) : null });
    res.writeHead(req.headers.authorization === 'Bearer synthetic-tool-token' ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.method === 'POST' ? { job: { id: 'run-1' }, status: 'accepted' } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(f.connectors.catalog(), []);
  await f.connectors.save(config(`http://127.0.0.1:${server.address().port}`)); assert.equal(calls.length, 0);
  await f.connectors.setToken('my-tool', 'synthetic-tool-token');
  assert.ok(!(await readFile(f.file, 'utf8')).includes('synthetic-tool-token'));
  await f.wb.linkProject(f.project.id, 'my-tool', 'remote-project');
  await f.wb.authorize(f.task.id, 'my-tool', '本地模拟接口', '2099-01-01T00:00:00Z');
  await f.connectors.probe('my-tool');
  const task = await f.wb.owned(f.task.id, 'employee');
  const receipt = await f.connectors.submit(task, 'my-tool', '包含双引号 " 的指令', 'step-1');
  assert.equal(receipt.receipt.job.id, 'run-1');
  const request = calls.find(c => c.method === 'POST');
  assert.equal(request.path, '/jobs/remote-project'); assert.equal(request.body.context.task, task.id); assert.ok(request.body.input.includes('"'));
  assert.equal(request.key, `${task.id}:step-1`);
  await f.connectors.status(await f.wb.owned(task.id, 'employee'), 'my-tool');
  assert.ok(calls.some(c => c.path === '/runs/run-1')); assert.ok(calls.some(c => c.path === '/status/remote-project'));
  await assert.rejects(f.connectors.save(config('http://localhost:1')), /未核实/);
});
test('连接改动撤销旧范围，禁用连接不能提交；宿主连接不能被表单覆盖', async t => {
  const f = await fixture(t);
  await f.connectors.save(config('http://localhost:1234')); await f.wb.linkProject(f.project.id, 'my-tool', 'demo');
  await f.wb.authorize(f.task.id, 'my-tool', '范围', '2099-01-01T00:00:00Z');
  await f.connectors.save({ ...config('http://localhost:1234'), enabled: false });
  assert.equal((await f.wb.snapshot()).tasks[0].authorizations['my-tool'], undefined);
  await assert.rejects(f.connectors.submit(await f.wb.owned(f.task.id, 'employee'), 'my-tool', '工作', 'one'), /禁用/);
  const managed = new Connectors(f.store, { 'my-tool': config('http://localhost:1') });
  await assert.rejects(managed.save(config('http://localhost:2')), /宿主配置管理/);
});
test('拒绝配置中的密钥、危险 ID、异源路径和未知模板变量', () => {
  const good = config('https://tool.example');
  for (const patch of [{ token: 'do-not-save' }, { baseUrl: 'https://user:secret@tool.example' }, { id: 'constructor' }, { submitPath: '//another.example/job' }, { bodyTemplate: { command: '{unknown}' } }, { bodyTemplate: JSON.parse('{"__proto__":{}}') }]) assert.throws(() => normalizeConnection({ ...good, ...patch }));
  assert.equal(expandPath('/status/{projectId}', { projectId: '../other?x=1' }), '/status/..%2Fother%3Fx%3D1');
});
test('未配置的连接不能绑定到模型执行端；归档后不能从旧任务快照派工', async t => {
  const f = await fixture(t); assert.throws(() => f.connectors.configured('missing'), /未配置/);
  await f.connectors.save({ ...config('http://localhost:1'), authType: 'none' }); await f.wb.linkProject(f.project.id, 'my-tool', 'demo');
  await f.wb.authorize(f.task.id, 'my-tool', '范围', '2099-01-01T00:00:00Z'); const old = await f.wb.owned(f.task.id, 'employee');
  await f.store.change(s => { s.projects[0].lifecycle = 'archiving'; return null; });
  await assert.rejects(f.connectors.submit(old, 'my-tool', '工作', 'one'), /归档/);
});
