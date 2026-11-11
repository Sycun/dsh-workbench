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
  for (const text of ['需要你决定', '阶段汇报', '整理现状', '暂停 DSH 员工', '答复员工', '核实为已完成']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<script>untrusted()')); assert.ok(html.includes('&lt;script&gt;'));
});
test('只有待验收状态展示验收动作', () => {
  const Panel = createPanel(React, {});
  const render = status => renderToString(React.createElement(Panel, { initialSnapshot: { projects: [], tasks: [{ ...task, status }], events: [] }, initialTaskId: task.id }));
  assert.ok(!render('running').includes('验收通过')); assert.ok(render('review').includes('验收通过'));
});
