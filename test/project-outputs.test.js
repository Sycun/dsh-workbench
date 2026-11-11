import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { Connectors } from '../lib/connectors.js';
import { OUTPUT_FOLDER } from '../lib/project-outputs.js';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'workbench-outputs-')), projectRoot = join(base, 'project');
  await mkdir(projectRoot);
  const store = await new Store(join(base, 'state.json')).open(), wb = new Workbench(store);
  t.after(async () => { await store.close(); await rm(base, { recursive: true, force: true }); });
  const project = await wb.project({ name: '项目', cwd: projectRoot });
  const task = await wb.create({ projectId: project.id, brief: '所有成果保存在这个本机项目' });
  await wb.bind(task.id, 'employee');
  await wb.plan(task.id, { objective: '验证成果落盘', stages: [{ title: '检查', acceptance: '报告和数据在项目目录中' }] });
  return { base, store, wb, project, task, root: join(project.cwd, OUTPUT_FOLDER) };
}
async function finish(f) {
  await f.wb.checkpoint(f.task.id, { stageId: 's1', summary: '已完成落盘检查', remaining: [], evidence: ['本机结果文件'], done: true });
}
test('返回 JSON、阶段回报与最终报告保存在指定项目，重试不制造重复内容文件', async t => {
  const f = await fixture(t);
  const result = await f.wb.outputs.receive(f.task.id, 'my-tool', 'status', { result: 'tool output', remotePath: '/remote/report.pdf' });
  assert.ok(result.item.path.startsWith(f.project.cwd + '/'));
  assert.equal(JSON.parse(await readFile(result.item.path, 'utf8')).payload.result, 'tool output');
  assert.ok(!Object.hasOwn((await f.store.read()).tasks[0].outputItems[0], 'payload'));
  await finish(f); const reviewed = await f.wb.review(f.task.id, '最终报告摘要');
  const report = await readFile(reviewed.localOutput.reportPath, 'utf8');
  assert.ok(report.includes('最终报告摘要')); assert.ok(report.includes('已完成落盘检查'));
  const count = (await readdir(join(reviewed.localOutput.directory, '报告'))).length;
  await f.wb.outputs.ensureReady(f.task.id); assert.equal((await readdir(join(reviewed.localOutput.directory, '报告'))).length, count);
});
test('远端路径不计为本地附件，必交文件取回并登记后才能验收', async t => {
  const f = await fixture(t); await finish(f);
  await f.wb.outputs.register(f.task.id, { kind: 'remote', location: '/remote/report.pdf' });
  await assert.rejects(f.wb.review(f.task.id, '交付'), /必交文件/);
  const file = join(f.project.cwd, '报告.txt'); await writeFile(file, 'retrieved content');
  await f.wb.outputs.register(f.task.id, { kind: 'local', location: file, sourceReference: '/remote/report.pdf' });
  const reviewed = await f.wb.review(f.task.id, '交付'); assert.equal(reviewed.localOutput.pendingRequiredFiles, 0);
  const record = (await f.wb.snapshot()).tasks[0].outputReferences[0]; assert.equal(record.status, 'local'); assert.equal(record.path, await realpath(file)); assert.equal(record.sha256.length, 64);
});
test('本地文件更改后必须重新登记，不能使用过期哈希通过验收', async t => {
  const f = await fixture(t); await finish(f);
  const file = join(f.project.cwd, 'report.txt'); await writeFile(file, 'version one');
  await f.wb.outputs.register(f.task.id, { kind: 'local', location: file });
  await f.wb.review(f.task.id, '交付'); await writeFile(file, 'version two');
  await assert.rejects(f.wb.accept(f.task.id), /内容已变化/);
  await f.wb.outputs.register(f.task.id, { kind: 'local', location: file });
  assert.equal((await f.wb.accept(f.task.id)).status, 'accepted');
});
test('拒绝跨项目文件与符号链接出口，不写入其他目录', async t => {
  const f = await fixture(t), outside = join(f.base, 'outside'); await mkdir(outside); const file = join(outside, 'secret.txt'); await writeFile(file, 'outside');
  await assert.rejects(f.wb.outputs.register(f.task.id, { kind: 'local', location: file }), /项目目录/);
  const alias = join(f.project.cwd, 'outside.txt'); await symlink(file, alias);
  await assert.rejects(f.wb.outputs.register(f.task.id, { kind: 'local', location: alias }), /项目目录/);
  await rename(f.root, f.root + '-saved'); await symlink(outside, f.root);
  await assert.rejects(f.wb.outputs.ensureReady(f.task.id), /符号链接/); assert.deepEqual(await readdir(outside), ['secret.txt']);
});
test('远端接单后本地写入失败保留 accepted 和待保存回执，修复后无需重派', async t => {
  const f = await fixture(t); let calls = 0;
  const c = new Connectors(f.store, { artex: { baseUrl: 'http://127.0.0.1', projects: { [f.project.id]: { externalId: 'test' } } } }, async () => {
    calls++; await rename(f.root, f.root + '-saved'); await writeFile(f.root, 'temporary obstruction');
    return new Response(JSON.stringify({ status: 'accepted', receipt: 'remote-1' }));
  });
  await f.wb.authorize(f.task.id, 'artex', '本地模拟接口', '2099-01-01T00:00:00Z');
  const task = await f.wb.owned(f.task.id, 'employee');
  const result = await c.submit(task, 'artex', '测试', 'one'); assert.equal(result.status, 'accepted'); assert.equal(result.localOutput.status, 'failed');
  const pending = (await f.store.read()).tasks[0].outputItems[0]; assert.equal(pending.payload.receipt, 'remote-1'); assert.equal(pending.status, 'pending');
  await rm(f.root); await rename(f.root + '-saved', f.root); await f.wb.outputs.ensureReady(f.task.id);
  const saved = (await f.wb.snapshot()).tasks[0].outputItems[0]; assert.equal(saved.status, 'saved'); assert.ok((await readFile(saved.path, 'utf8')).includes('remote-1'));
  await c.submit(task, 'artex', '测试', 'one'); assert.equal(calls, 1);
});
test('落盘失败阻止最终验收，修复后可重试；生成文件的人工修改不会被覆盖', async t => {
  const f = await fixture(t); await finish(f);
  await rename(f.root, f.root + '-saved'); await writeFile(f.root, 'obstruction');
  await assert.rejects(f.wb.review(f.task.id, '最终交付'), /保存失败/); await assert.rejects(f.wb.accept(f.task.id), /保存失败/);
  await rm(f.root); await rename(f.root + '-saved', f.root);
  const result = await f.wb.review(f.task.id, '最终交付');
  await writeFile(result.localOutput.reportPath, 'user edited report');
  await assert.rejects(f.wb.outputs.ensureReady(f.task.id), /未覆盖/);
  assert.equal(await readFile(result.localOutput.reportPath, 'utf8'), 'user edited report');
});
test('并发返回内容全部保存，中央台账只保留已写文件的索引', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, n) => f.wb.outputs.receive(f.task.id, 'worker', 'status', { n })));
  const task = (await f.store.read()).tasks[0]; assert.equal(task.outputItems.length, 8); assert.equal(task.localOutput.status, 'saved');
  assert.ok(task.outputItems.every(item => item.status === 'saved' && !Object.hasOwn(item, 'payload')));
  const values = await Promise.all(task.outputItems.map(async item => JSON.parse(await readFile(item.path, 'utf8')).payload.n)); assert.equal(new Set(values).size, 8);
});
