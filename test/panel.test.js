import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createPanel } from '../lib/panel.js';

const task = {
  id: 'demo-task', projectId: 'demo-project', brief: '整理示例项目进度', status: 'waiting', sessionId: 'demo-session',
  plan: { objective: '形成有来源的进度摘要', constraints: ['只读本地资料'], assumptions: [], stages: [{ id: 's1', title: '整理现状', acceptance: '每项结论可追溯', status: 'done' }] },
  questions: [{ id: 'q1', question: '下一阶段优先交付还是性能？', reason: '两个方向占用相同时间', recommendation: '先交付', options: ['先交付', '先性能'], answer: null }],
  reports: [{ at: '2026-01-01T00:00:00Z', summary: '<script>untrusted()</script>', remaining: ['等待优先级决策'], evidence: ['example/notes.md'] }],
  runs: [{ id: 'r1', connector: 'artex', status: 'accepted', receipt: { status: 'accepted' } }]
};
test('原生面板渲染阶段、问题和执行回执，外部文字保持转义', () => {
  const Panel = createPanel(React, {});
  const html = renderToString(React.createElement(Panel, { initialSnapshot: { projects: [{ id: 'demo-project', name: '示例项目' }], tasks: [task], events: [] }, initialTaskId: task.id }));
  for (const text of ['需要你决定', '阶段汇报', '整理现状', '暂停主管与专员', '答复员工', '核实为已完成']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<script>untrusted()')); assert.ok(html.includes('&lt;script&gt;'));
});
test('只有待验收状态展示验收动作', () => {
  const Panel = createPanel(React, {});
  const render = status => renderToString(React.createElement(Panel, { initialSnapshot: { projects: [], tasks: [{ ...task, status, summary: '自检交付' }], events: [] }, initialTaskId: task.id }));
  assert.ok(!render('running').includes('验收通过')); assert.ok(render('review').includes('验收通过'));
});
test('首页默认只有交办入口，连接和项目表单位于设置二级页面', () => {
  const Panel = createPanel(React, {});
  const html = renderToString(React.createElement(Panel));
  assert.ok(html.includes('探索未至之境')); assert.ok(html.includes('交给主管')); assert.ok(html.includes('默认工作区'));
  assert.ok(!html.includes('平台登录')); assert.ok(!html.includes('项目绝对路径')); assert.ok(!html.includes('artex 密码')); assert.ok(html.includes('设置'));
  assert.ok(html.includes('智能体模式')); assert.ok(html.includes('模型与思考强度'));
});
test('模式和模型来自 DSH 目录，显示默认值且不提供 API Key 输入框', () => {
  const Panel = createPanel(React, {});
  const html = renderToString(React.createElement(Panel, { initialRuntimeCatalog: { models: { default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', name: '现有提供方', models: [{ id: 'm', name: '现有模型' }] }] }, presets: [{ id: 'standard', name: '标准模式', isDefault: true }], errors: [] } }));
  for (const text of ['现有模型', '标准模式']) assert.ok(html.includes(text));
  assert.ok(!html.includes('API Key'));
});
test('全新安装的工具接入为空，并提供通用接口表单', () => {
  const Panel = createPanel(React, {});
  const html = renderToString(React.createElement(Panel, { initialScreen: 'settings', initialSettingsTab: 'platforms' }));
  assert.ok(html.includes('还没有外部连接')); assert.ok(html.includes('自定义 HTTP/JSON')); assert.ok(html.includes('服务地址（不含路径）'));
  assert.ok(!html.includes('artex 密码')); assert.ok(!html.includes('已启用 Kali 开机启动'));
});
test('原生归档不同步时显示提醒，项目管理提供整项目归档和删除入口', () => {
  const Panel = createPanel(React, {});
  const html = renderToString(React.createElement(Panel, { initialScreen: 'settings', initialSnapshot: { projects: [{ id: 'p', name: '项目', cwd: '/example' }], tasks: [], projectWarnings: [{ projectId: 'p', name: '项目', message: 'DSH 已归档，工作台还没归档' }] } }));
  for (const label of ['DSH 已归档，工作台还没归档', '归档', '删除', '回收站']) assert.ok(html.includes(label));
});

test('使用 DSH 菜单组件与原生预设翻译，内部 ID 仍用于选择', () => {
  const menus = [];
  const nativeUi = { Menu: props => { menus.push(props); return props.anchor; } };
  const ctx = { locale: { bind: ns => { assert.equal(ns, 'settings.agentPreset'); return key => ({ presetStandardName: '标准模式', presetStandardDescription: 'DSH 的标准模式说明' }[key] || key); } } };
  const Panel = createPanel(React, ctx, nativeUi);
  const html = renderToString(React.createElement(Panel, { initialRuntimeCatalog: { models: null, presets: [{ id: 'standard', isDefault: true }], errors: [] } }));
  assert.ok(html.includes('标准模式')); assert.ok(html.includes('data-workbench-composer'));
  const presetMenu = menus.find(m => m.anchor.props['aria-label'] === '智能体模式');
  assert.equal(presetMenu.portal, true);
  assert.ok(presetMenu.items.some(item => item.id === 'standard' && renderToString(item.label).includes('DSH 的标准模式说明')));
});
test('默认模型的思考强度入口可用，工作区菜单含原生目录与添加入口', () => {
  const menus = [], Panel = createPanel(React, {}, { Menu: props => { menus.push(props); return props.anchor; } });
  const html = renderToString(React.createElement(Panel, { initialSnapshot: { projects: [], tasks: [], workspaces: [{ id: 'native', title: '官方工作区', path: '/example' }] }, initialRuntimeCatalog: { presets: [], errors: [], models: { default: { provider: 'p', model: 'm', reasoningEffort: 'high' }, groups: [{ id: 'p', models: [{ id: 'm', name: '模型', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] } } }));
  const model = menus.find(m => m.anchor.props['aria-label'] === '模型与思考强度');
  assert.equal(model.items.find(i => i.id === '__efforts__').disabled, false); assert.ok(html.includes('High'));
  const workspace = menus.find(m => m.anchor.props['aria-label'] === '选择工作区');
  assert.ok(workspace.items.some(i => i.id === 'workspace:native')); assert.ok(workspace.items.some(i => i.id === '__add__'));
});
test('历史页提供分类和单项整理，不混入已归档或回收站任务', () => {
  const Panel = createPanel(React, {});
  const html = renderToString(React.createElement(Panel, { initialScreen: 'history', initialSnapshot: { projects: [{ id: 'p', name: '示例项目' }], tasks: [
    { ...task, id: 'active', projectId: 'p', status: 'accepted', brief: '当前可见任务' },
    { ...task, id: 'archive', projectId: 'p', status: 'accepted', lifecycle: 'archived', brief: '单独归档内容' },
    { ...task, id: 'trash', projectId: 'p', status: 'accepted', lifecycle: 'deleted', brief: '回收站内容' }
  ] } }));
  for (const label of ['最近任务', '已归档', '回收站', '归档', '移入回收站', '当前可见任务']) assert.ok(html.includes(label));
  assert.ok(!html.includes('单独归档内容')); assert.ok(!html.includes('回收站内容'));
});
