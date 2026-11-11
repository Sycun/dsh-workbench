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
  const tools = makeTools(wb, {}); assert.equal(tools.length, 11);
  const plan = tools.find(t => t.name === 'workbench_plan');
  await plan.execute({ taskId: task.id, objective: '生成摘要', stages: [{ title: '读取资料', acceptance: '有来源' }] }, { agent: { id: 'test-session' } });
  await assert.rejects(plan.execute({ taskId: task.id, objective: 1 }, { agent: { id: 'test-session' } }));
  const disposes = [], registered = [];
  await apply({ workspaceRegistry: { initializeDefault: async () => undefined }, tools: { register: t => registered.push(t.name) }, connection: { fetch: { register: r => registered.push(r.path) } }, systemPrompt: { section: s => registered.push(s.name) }, effect: fn => disposes.push(fn()) }, { dataFile: join(dir, 'host.json') });
  assert.equal(registered.length, 13); for (const dispose of disposes) await dispose();
  // Exercise the generated client against actual React and SSR; no browser or model API call.
  const React = await import('react'), renderer = await import('react-dom/server');
  let client;
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: def => { client = def.factory(name => { if (name === 'react') return React; if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: ({ anchor }) => anchor }; throw new Error('Unexpected runtime module: ' + name); }); } } }, fetch, setInterval, clearInterval, Intl });
  const slots = [];
  client.apply({ slots: { inject: (_, fn) => fn(), register: (meta, component) => slots.push({ meta, component }) }, remote: {}, uiWorkspace: {} });
  assert.deepEqual(slots.map(s => s.meta.name), ['main', 'sidebar.panellist']);
  const html = renderer.renderToString(React.createElement(slots[0].component));
  assert.ok(html.includes('交办工作')); assert.ok(html.includes('探索未至之境'));
  assert.ok(client.inject.includes('remote.session')); assert.ok(client.inject.includes('remote.workspace'));
  console.log('PASS: 11 tool definitions, schema validation, host registration, client slots and React SSR against installed DSH runtime');
} finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
