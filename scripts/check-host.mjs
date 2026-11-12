import { register } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
register('./dsh-loader.mjs', import.meta.url);
const { makeTools, apply } = await import('../lib/index.js');
const { Store, Workbench } = await import('../lib/core.js');
const dir = await mkdtemp(join(tmpdir(), 'dsh-workbench-host-'));
const store = await new Store(join(dir, 'test.json')).open();
try {
  const wb = new Workbench(store), p = await wb.project({ name: '离线兼容性验证', cwd: dir });
  const task = await wb.create({ projectId: p.id, brief: '生成本地摘要' }); await wb.bind(task.id, 'test-session');
  const tools = makeTools(wb); assert.equal(tools.length, 7);
  const plan = tools.find(t => t.name === 'workbench_plan');
  await plan.execute({ taskId: task.id, objective: '生成摘要', stages: [{ title: '读取资料', acceptance: '有来源' }] }, { agent: { id: 'test-session' } });
  await assert.rejects(plan.execute({ taskId: task.id, objective: 1 }, { agent: { id: 'test-session' } }));
  await store.change(s => { s.tasks[0].localOutput = { status: 'pending', error: undefined }; return null; }, { notify: false });
  const getTool = tools.find(t => t.name === 'workbench_get');
  const transient = await getTool.execute({ taskId: task.id }, { agent: { id: 'test-session' } });
  assert.equal(Object.hasOwn(transient.localOutput, 'error'), false, 'DSH tool output must be lossless JSON during concurrent export');
  const disposes = [], registered = [], registeredRoutes = [], sections = [];
  await apply({
    workspaceRegistry: { initializeDefault: async () => undefined, list: () => [] },
    tools: { register: tool => registered.push(tool.name) },
    connection: { fetch: { register: route => registeredRoutes.push(route) } },
    systemPrompt: { section: section => sections.push(section.name) },
    effect: fn => disposes.push(fn())
  }, { dataFile: join(dir, 'host.json') });
  assert.deepEqual(registered, tools.map(tool => tool.name));
  assert.deepEqual(sections, ['plugin:dsh-workbench']);
  assert.equal(registeredRoutes.length, 1);
  const route = registeredRoutes[0];
  const url = new URL(route.path, 'http://localhost');
  const snapshot = await route.fetch(new Request(url));
  const payload = await snapshot.json();
  assert.equal(snapshot.status, 200, payload.error);
  assert.deepEqual(payload.tasks, []);
  const unavailable = await route.fetch(new Request(url, {
    method: 'POST',
    headers: { 'X-DSH-Workbench': '1' },
    body: JSON.stringify({ action: 'connection_save' })
  }));
  assert.equal(unavailable.status, 400);
  assert.deepEqual(await unavailable.json(), { error: '不支持的操作' });
  for (const dispose of disposes) await dispose();
  // Exercise the generated client against actual React and SSR; no browser or model API call.
  const React = await import('react'), renderer = await import('react-dom/server');
  let client;
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: def => { client = def.factory(name => { if (name === 'react') return React; if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: ({ anchor }) => anchor }; throw new Error('Unexpected runtime module: ' + name); }); } } }, fetch, setInterval, clearInterval, Intl });
  const slots = [];
  client.apply({ slots: { inject: (_, fn) => fn(), register: (meta, component) => slots.push({ meta, component }) }, remote: {}, uiWorkspace: {} });
  assert.deepEqual(slots.map(s => s.meta.name), ['main', 'sidebar.panellist']);
  const html = renderer.renderToString(React.createElement(slots[0].component));
  assert.ok(html.includes('交办工作')); assert.ok(html.includes('探索未至之境'));
  assert.ok(client.inject.includes('layout')); assert.ok(client.inject.includes('fileUpload')); assert.ok(client.inject.includes('remote.session')); assert.ok(client.inject.includes('remote.workspace'));
  console.log('PASS: 7 local tool definitions, schema validation, host registration, local HTTP routes, client slots and React SSR');
} finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
