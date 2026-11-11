import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Workbench } from '../lib/core.js';
import { RuntimeSelection, normalizeExecution } from '../lib/runtime-selection.js';

async function fixture(t, execution = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-model-'));
  const store = await new Store(join(dir, 'state.json')).open(), wb = new Workbench(store);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const p = await wb.project({ cwd: dir }), task = await wb.create({ projectId: p.id, brief: '测试模型配置', execution });
  await wb.bind(task.id, 'employee');
  const defaultSelection = { provider: 'provider-a', model: 'fast', reasoningEffort: 'low' };
  let selected = { ...defaultSelection };
  const selections = [], resolutions = [];
  const agent = { session: { header: { cwd: p.cwd }, requestHeader: () => undefined }, model: { current: () => selected, select: value => { selected = { ...value }; selections.push(value); } } };
  const catalog = { default: defaultSelection, groups: [{ id: 'provider-a', name: '已有提供方', models: [
    { id: 'fast', name: '快速模型', reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' } },
    { id: 'strong', name: '推理模型', reasoning: { efforts: [{ id: 'high', name: '高' }] } }
  ] }], failures: [] };
  const host = {
    sessionController: { modelCatalog: async () => structuredClone(catalog), agents: { resolveAgent: async () => ({ agent }) } },
    presets: { remoteExportList: async () => ({ presets: [{ id: 'standard', name: '标准', isDefault: true }, { id: 'broken', broken: 'unavailable' }] }), presetForSession: () => 'standard' },
    llm: { resolveCallConfig: async value => { resolutions.push(value); return value; } }, activity: async () => []
  };
  return { wb, store, task, host, agent, catalog, selections, resolutions, runtime: new RuntimeSelection(wb, host) };
}
test('跟随 DSH 默认时不写模型选择，记录员工实际启动配置', async t => {
  const f = await fixture(t);
  const applied = await f.runtime.apply(f.task.id);
  assert.equal(f.selections.length, 0); assert.equal(f.resolutions.length, 0);
  assert.deepEqual(applied.model, f.catalog.default); assert.equal(applied.agentPreset, 'standard');
});
test('指定模式、模型和推理等级随任务持久化，仅作用于员工会话', async t => {
  const execution = { agentPreset: 'standard', model: { provider: 'provider-a', model: 'strong', reasoningEffort: 'high' } };
  const f = await fixture(t, execution), beforeDefault = structuredClone(f.catalog.default);
  const applied = await f.runtime.apply(f.task.id);
  assert.deepEqual(applied.model, execution.model); assert.deepEqual(f.catalog.default, beforeDefault);
  assert.deepEqual((await f.wb.snapshot()).tasks[0].execution, execution);
  assert.deepEqual((await f.wb.snapshot()).tasks[0].runtimeApplied, applied);
  await f.runtime.apply(f.task.id); assert.equal(f.selections.length, 1);
});
test('下架模型、不支持的推理等级和损坏模式拒绝执行，不静默回退', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.validate({ model: { provider: 'provider-a', model: 'removed' } }), /不可用/);
  await assert.rejects(f.runtime.validate({ model: { provider: 'provider-a', model: 'fast', reasoningEffort: 'high' } }), /不支持/);
  await assert.rejects(f.runtime.validate({ agentPreset: 'broken' }), /不可用/);
  assert.equal(f.selections.length, 0);
});
test('目录错配、实际模式不符或会话已执行时不能更改启动配置', async t => {
  const f = await fixture(t, { agentPreset: 'standard', model: { provider: 'provider-a', model: 'fast' } });
  const cwd = f.agent.session.header.cwd; f.agent.session.header.cwd = '/other-project';
  await assert.rejects(f.runtime.apply(f.task.id), /目录/); f.agent.session.header.cwd = cwd;
  f.host.presets.presetForSession = () => 'different'; await assert.rejects(f.runtime.apply(f.task.id), /模式/);
  f.host.presets.presetForSession = () => 'standard'; f.host.activity = async () => [{ kind: 'agent' }];
  await assert.rejects(f.runtime.apply(f.task.id), /已开始执行/); assert.equal(f.selections.length, 0);
});
test('并发重试只应用一次，已归档的项目不接收启动设置', async t => {
  const f = await fixture(t, { model: { provider: 'provider-a', model: 'strong', reasoningEffort: 'high' } });
  await Promise.all([f.runtime.apply(f.task.id), f.runtime.apply(f.task.id)]); assert.equal(f.selections.length, 1);
  const second = await f.wb.create({ projectId: f.task.projectId, brief: '不应启动', execution: { model: { provider: 'provider-a', model: 'fast' } } });
  await f.wb.bind(second.id, 'second');
  await f.store.change(s => { s.projects[0].lifecycle = 'archived'; return null; });
  await assert.rejects(f.runtime.apply(second.id), /归档/);
});
test('目录读取失败保留其他可用目录；配置不接收凭据或全局设置字段', async t => {
  const f = await fixture(t); f.host.sessionController.modelCatalog = async () => { throw new Error('unavailable'); };
  const value = await f.runtime.catalog(); assert.equal(value.models, null); assert.equal(value.presets.length, 2); assert.ok(value.errors.length);
  assert.throws(() => normalizeExecution({ apiKey: 'do-not-accept' }), /不支持/);
  assert.throws(() => normalizeExecution({ model: { model: 'x' } }), /提供方/);
});
test('选择原生工作区复用已存在的项目，归档项目不能绕过恢复流程', async t => {
  const f = await fixture(t); const p = (await f.wb.snapshot()).projects[0];
  f.host.workspaces = { list: () => [{ id: 'native-workspace', path: p.cwd, title: '现有文件夹' }] };
  const imported = await f.runtime.adoptWorkspace('native-workspace'); assert.equal(imported.id, p.id); assert.equal(imported.workspaceId, 'native-workspace');
  assert.equal((await f.wb.snapshot()).projects.length, 1);
  await f.store.change(s => { s.projects[0].lifecycle = 'archived'; return null; });
  await assert.rejects(f.runtime.adoptWorkspace('native-workspace'), /归档/);
});
