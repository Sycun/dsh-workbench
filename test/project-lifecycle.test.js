import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { ProjectLifecycle } from '../lib/project-lifecycle.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-project-'));
  const store = await new Store(join(dir, 'state.json')).open(), wb = new Workbench(store);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const project = await wb.project({ name: '测试项目', cwd: dir });
  const task = await wb.create({ projectId: project.id, brief: '整理资料' }); await wb.bind(task.id, 'employee');
  await writeFile(join(dir, 'keep.txt'), 'original project file');
  const known = new Set(['employee', 'native-other']), entries = new Map(); let serial = 0;
  const registry = {
    archivedSessionIds: [], failOn: null, calls: [],
    get: id => entries.get(id),
    async create(path, title) {
      const old = [...entries.values()].find(w => w.path === path); if (old) return old;
      const workspace = { id: 'native-' + ++serial, path, title, sessionIds: [], async attachSession(id) { if (!known.has(id)) throw new Error('missing session'); if (!this.sessionIds.includes(id)) this.sessionIds.push(id); } };
      entries.set(workspace.id, workspace); return workspace;
    },
    async archiveSession(id) { if (this.failOn === id) throw new Error('simulated native failure'); this.calls.push(['archive', id]); if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id); },
    async unarchiveSession(id) { this.calls.push(['restore', id]); this.archivedSessionIds = this.archivedSessionIds.filter(v => v !== id); },
    async delete(id) { this.calls.push(['delete', id]); return entries.delete(id); }
  };
  const native = await registry.create(project.cwd, project.name); await native.attachSession('employee'); await native.attachSession('native-other');
  await wb.workspace(project.id, native.id);
  return { dir, store, wb, project, task, registry, native, lifecycle: new ProjectLifecycle(wb, registry) };
}
test('整个项目归档覆盖 DSH 原生会话，恢复原路径，磁盘文件保留', async t => {
  const f = await fixture(t); await f.lifecycle.run(f.project.id, 'archive');
  assert.deepEqual([...f.registry.archivedSessionIds].sort(), ['employee', 'native-other']);
  assert.equal(f.registry.get(f.native.id), undefined); assert.equal((await f.wb.snapshot()).projects[0].lifecycle, 'archived');
  await assert.rejects(f.wb.create({ projectId: f.project.id, brief: '不能派工' }), /归档/);
  await assert.rejects(f.wb.owned(f.task.id, 'employee'), /归档/);
  await f.lifecycle.run(f.project.id, 'restore');
  const p = (await f.wb.snapshot()).projects[0]; assert.equal(p.lifecycle, 'active'); assert.equal(f.registry.get(p.workspaceId).path, f.project.cwd);
  assert.equal(f.registry.archivedSessionIds.length, 0); assert.equal(await readFile(join(f.dir, 'keep.txt'), 'utf8'), 'original project file');
});
test('删除为可恢复移除登记，不删除项目文件或任务记录', async t => {
  const f = await fixture(t); await f.lifecycle.run(f.project.id, 'delete');
  assert.equal((await f.wb.snapshot()).projects[0].lifecycle, 'deleted'); assert.equal((await f.wb.snapshot()).tasks.length, 1);
  await f.lifecycle.run(f.project.id, 'restore'); assert.equal((await f.wb.snapshot()).projects[0].lifecycle, 'active');
  assert.equal(await readFile(join(f.dir, 'keep.txt'), 'utf8'), 'original project file');
});
test('DSH 直接归档产生提示，工作台状态不会自动跟着改变', async t => {
  const f = await fixture(t); await f.registry.archiveSession('employee'); await f.registry.archiveSession('native-other');
  const before = await f.wb.snapshot(), warnings = await f.lifecycle.warnings();
  assert.equal(warnings.length, 1); assert.match(warnings[0].message, /还没归档/); assert.deepEqual(await f.wb.snapshot(), before);
  await f.registry.delete(f.native.id); assert.match((await f.lifecycle.warnings())[0].message, /登记已移除/);
});
test('活动会话与未核实外部任务会阻止整项目归档', async t => {
  const f = await fixture(t);
  const busy = new ProjectLifecycle(f.wb, f.registry, async id => id === 'native-other' ? [{ kind: 'agent' }] : []);
  await assert.rejects(busy.run(f.project.id, 'archive'), /活动会话/); assert.equal(f.registry.calls.length, 0);
  await f.store.change(s => { s.tasks[0].runs.push({ status: 'accepted' }); return null; });
  await assert.rejects(f.lifecycle.run(f.project.id, 'archive'), /外部执行任务/); assert.equal(f.registry.calls.length, 0);
});
test('部分失败保留同步错误和快照，可以恢复，不误报已归档', async t => {
  const f = await fixture(t); f.registry.failOn = 'native-other';
  await assert.rejects(f.lifecycle.run(f.project.id, 'archive'), /未全部完成/);
  const p = (await f.wb.snapshot()).projects[0]; assert.equal(p.lifecycle, 'sync-error'); assert.deepEqual(p.nativeArchive.progress, ['employee']);
  f.registry.failOn = null; await f.lifecycle.run(f.project.id, 'restore'); assert.equal(f.registry.archivedSessionIds.length, 0);
});
test('不允许错配路径的工作区被归档，默认登记不允许删除', async t => {
  const f = await fixture(t); f.native.path = '/different';
  await assert.rejects(f.lifecycle.run(f.project.id, 'archive'), /路径不一致/); assert.equal(f.registry.calls.length, 0);
  f.native.path = f.project.cwd; f.wb.defaultWorkspace = { id: f.native.id, path: f.project.cwd };
  await assert.rejects(f.lifecycle.run(f.project.id, 'delete'), /默认工作区/);
});
test('工作单未结束时先暂停，归档恢复不会自动放行排队专员', async t => {
  const f = await fixture(t);
  await f.store.change(s => { s.tasks[0].workOrders = [{ id: 'o', title: 'queued', state: 'queued', attempts: [], revision: 1 }]; return null; });
  await assert.rejects(f.lifecycle.run(f.project.id, 'archive'), /专员工作单/);
  await f.wb.pause(f.task.id); await f.lifecycle.run(f.project.id, 'archive'); await f.lifecycle.run(f.project.id, 'restore');
  assert.equal((await f.wb.snapshot()).tasks[0].status, 'paused');
});
