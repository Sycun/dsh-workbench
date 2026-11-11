import { required } from './core.js';
import { assignment } from './prompts.js';

export function guard(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new Error('只允许本机访问');
  const host = new URL(`http://${req.headers.host}`).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('Host 不在本机白名单');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new Error('禁止跨站请求');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new Error('禁止跨站请求');
  if (req.method === 'POST' && req.headers['x-dsh-workbench'] !== '1') throw new Error('缺少工作台请求标识');
}
export async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('请求体过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function routes(wb, connectors) {
  const result = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  return [{ kind: 'exact', path: '/api/dsh-workbench', handler: async (req, res) => {
    try {
      guard(req);
      if (req.method === 'GET') { result(res, 200, await wb.snapshot()); return; }
      if (req.method !== 'POST') { result(res, 405, { error: 'method not allowed' }); return; }
      const a = await body(req); let value;
      if (a.action === 'project') value = await wb.project(a);
      else if (a.action === 'create') value = await wb.create(a);
      else if (a.action === 'bind') value = await wb.bind(a.taskId, a.sessionId);
      else if (a.action === 'answer') value = await wb.answer(a.taskId, a.questionId, a.answer);
      else if (a.action === 'delivered') value = await wb.delivered(a.taskId, a.questionId);
      else if (a.action === 'pause') value = await wb.pause(a.taskId);
      else if (a.action === 'resume') value = await wb.resume(a.taskId);
      else if (a.action === 'accept') value = await wb.accept(a.taskId);
      else if (a.action === 'reconcile') {
        const t = (await wb.snapshot()).tasks.find(t => t.id === a.taskId); if (!t) throw new Error('任务不存在');
        value = await connectors.reconcile(t, a.runId, a.evidence, a.outcome);
      } else if (a.action === 'assignment') {
        const s = await wb.snapshot(), t = s.tasks.find(t => t.id === a.taskId); if (!t) throw new Error('任务不存在');
        value = { prompt: assignment(t, s.projects.find(p => p.id === t.projectId)) };
      } else throw new Error('不支持的操作');
      result(res, 200, value);
    } catch (e) { result(res, 400, { error: required(e.message || '请求失败', '错误') }); }
  } }];
}
