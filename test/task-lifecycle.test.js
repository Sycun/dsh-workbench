import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { TaskLifecycle } from '../lib/task-lifecycle.js';
import { ProjectLifecycle } from '../lib/project-lifecycle.js';
import { ExecutionMonitor } from '../lib/execution-monitor.js';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-history-')), store = await new Store(join(dir, 'state.json')).open(), wb = new Workbench(store);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = await wb.project({ cwd: dir }), tasks = [];
  for (let i = 0; i < 3; i++) { const task = await wb.create({ projectId: project.id, brief: '历史测试任务' + i }); await wb.bind(task.id, 'session-' + i); tasks.push(task); }
  await writeFile(join(dir, 'keep.md'), '项目交付文件');
  const workspaces = new Map(), registry = {
    archivedSessionIds: [], calls: [], fail: false,
    get: id => workspaces.get(id),
    async create(path, title) { const old = [...workspaces.values()].find(w => w.path === path); if (old) return old; const w = { id: 'native', path, title, sessionIds: [], async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); } }; workspaces.set(w.id, w); return w; },
    async archiveSession(id) { if (this.fail) throw new Error('模拟 DSH 归档失败'); this.calls.push(['archive', id]); if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id); },
    async unarchiveSession(id) { this.calls.push(['restore', id]); this.archivedSessionIds = this.archivedSessionIds.filter(x => x !== id); },
    async delete(id) { workspaces.delete(id); }
  };
  const native = await registry.create(project.cwd, project.name); for (const task of tasks) await native.attachSession('session-' + tasks.indexOf(task)); await wb.workspace(project.id, native.id);
  const projectLifecycle = new ProjectLifecycle(wb, registry), lifecycle = new TaskLifecycle(wb, projectLifecycle, registry, async () => []);
  const saved = async i => (await wb.snapshot()).tasks.find(t => t.id === tasks[i].id);
  return { dir, store, wb, project, tasks, registry, projectLifecycle, lifecycle, saved };
}
test('任务归档、回收站、恢复同步 DSH 会话，保留项目文件并且不自动继续', async t => {
  const f = await fixture(t), id = f.tasks[0].id;
  await f.lifecycle.run(id, 'archive'); assert.equal((await f.saved(0)).historyCollection, 'archived'); assert.ok(f.registry.archivedSessionIds.includes('session-0'));
  await assert.rejects(f.wb.owned(id, 'session-0'), /任务已归档/); await assert.rejects(f.wb.resume(id), /任务已归档/);
  await f.lifecycle.run(id, 'restore'); assert.equal((await f.saved(0)).historyCollection, 'active'); assert.equal((await f.saved(0)).status, 'paused'); assert.ok(!f.registry.archivedSessionIds.includes('session-0'));
  await f.lifecycle.run(id, 'delete'); assert.equal((await f.saved(0)).historyCollection, 'deleted'); assert.ok(f.registry.get('native'));
  await f.lifecycle.run(id, 'restore'); assert.equal((await f.saved(0)).historyCollection, 'active'); assert.equal(await readFile(join(f.dir, 'keep.md'), 'utf8'), '项目交付文件');
});
test('从已归档删除的任务恢复到归档区，不意外重新显示在 DSH 活动会话', async t => {
  const f = await fixture(t), id = f.tasks[0].id;
  await f.lifecycle.run(id, 'archive'); await f.lifecycle.run(id, 'delete'); await f.lifecycle.run(id, 'restore');
  assert.equal((await f.saved(0)).lifecycle, 'archived'); assert.ok(f.registry.archivedSessionIds.includes('session-0'));
  await f.lifecycle.run(id, 'restore'); assert.equal((await f.saved(0)).lifecycle, 'active');
});
test('任务随项目归档，恢复项目保持单独归档与删除状态', async t => {
  const f = await fixture(t); await f.lifecycle.run(f.tasks[0].id, 'delete'); await f.lifecycle.run(f.tasks[1].id, 'archive');
  await f.projectLifecycle.run(f.project.id, 'archive');
  assert.equal((await f.saved(0)).historyCollection, 'deleted'); assert.equal((await f.saved(1)).historyCollection, 'archived'); assert.equal((await f.saved(2)).historyCollection, 'archived');
  await assert.rejects(f.lifecycle.run(f.tasks[1].id, 'restore'), /先恢复项目/);
  await f.projectLifecycle.run(f.project.id, 'restore');
  assert.equal((await f.saved(0)).historyCollection, 'deleted'); assert.equal((await f.saved(1)).historyCollection, 'archived'); assert.equal((await f.saved(2)).historyCollection, 'active');
  assert.deepEqual(f.registry.archivedSessionIds.sort(), ['session-0', 'session-1']);
});
test('项目先归档再移入回收站，恢复时仍保留原来的会话归档边界', async t => {
  const f = await fixture(t); await f.registry.archiveSession('session-0');
  await f.projectLifecycle.run(f.project.id, 'archive'); await f.projectLifecycle.run(f.project.id, 'delete'); await f.projectLifecycle.run(f.project.id, 'restore');
  assert.deepEqual(f.registry.archivedSessionIds, ['session-0']);
});
test('执行中的会话、专员和未知远端回执不能直接归档或删除', async t => {
  const f = await fixture(t), id = f.tasks[0].id;
  f.lifecycle.activity = async () => [{ kind: 'agent' }]; await assert.rejects(f.lifecycle.run(id, 'delete'), /仍在执行/);
  f.lifecycle.activity = async () => []; await f.store.change(s => { s.tasks[0].runs.push({ status: 'unknown' }); return null; });
  await assert.rejects(f.lifecycle.run(id, 'archive'), /远端执行/);
  await f.store.change(s => { s.tasks[0].runs = []; s.tasks[0].workOrders = [{ id: 'o', title: '执行中', revision: 1, state: 'running', attempts: [] }]; return null; });
  await assert.rejects(f.lifecycle.run(id, 'delete'), /专员仍在执行/); assert.equal((await f.saved(0)).historyCollection, 'active');
});
test('同步失败可重试或恢复，失败时任务不能继续派工', async t => {
  const f = await fixture(t), id = f.tasks[0].id; f.registry.fail = true;
  await assert.rejects(f.lifecycle.run(id, 'archive'), /同步未完成/); assert.equal((await f.saved(0)).lifecycle, 'sync-error');
  await assert.rejects(f.wb.owned(id, 'session-0'), /任务已归档/);
  f.registry.fail = false; await f.lifecycle.run(id, 'archive'); assert.equal((await f.saved(0)).lifecycle, 'archived');
  await f.lifecycle.run(id, 'restore'); assert.equal((await f.saved(0)).lifecycle, 'active');
});
test('单个任务均已归档时不误报项目未同步；历史任务不再自动唤醒', async t => {
  const f = await fixture(t); for (const task of f.tasks) await f.lifecycle.run(task.id, 'archive');
  assert.deepEqual(await f.projectLifecycle.warnings(), []);
  const prompts = []; const monitor = new ExecutionMonitor(f.wb, {}, { prompt: async r => prompts.push(r) }); t.after(() => monitor.close());
  await f.store.change(s => { s.tasks[0].status = 'running'; s.tasks[0].runs.push({ id: 'r', status: 'completed', notification: { id: 'notice', delivered: false }, reconciliation: { evidence: 'test' } }); return null; });
  await monitor.deliver((await f.saved(0)), { running: false, pendingInput: [], queue: [] }); assert.equal(prompts.length, 0);
});
