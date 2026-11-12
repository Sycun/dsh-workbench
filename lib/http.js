import { required } from './core.js';
import { assignment } from './prompts.js';
import { ChangeFeed } from './change-feed.js';

// DSH connection authenticates the owner Peer and checks Host/Origin before dispatch.
// Register through this seam so desktop forwarding and Web use the same boundary.
export function guard(req) {
  if (req.method === 'POST' && req.headers.get('x-dsh-workbench') !== '1') throw new Error('缺少工作台请求标识');
}
export async function body(req) {
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 65536) throw new Error('请求体过大');
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function routes(wb, lifecycle = null, runtime = null, monitor = null, taskLifecycle = null) {
  const feed = new ChangeFeed();
  const result = (code, value) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  return [{ path: '/api/dsh-workbench', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async req => {
    try {
      guard(req);
      if (req.method === 'GET') {
        const { connections, ...state } = await wb.snapshot();
        const snapshot = { ...state, ...monitor?.view(), imageLimits: wb.images?.limits() || null, workspaces: runtime?.workspaces() || [], projectWarnings: lifecycle ? await lifecycle.warnings() : [] };
        const query = new URL(req.url).searchParams;
        return result(200, query.has('feed') ? feed.read(snapshot, query.get('cursor')) : snapshot);
      }
      if (req.method !== 'POST') return result(405, { error: 'method not allowed' });
      const a = await body(req); let value;
      if (a.action === 'image_attach') { if (!wb.images) throw new Error('图片服务不可用'); value = await wb.images.attach(a); }
      else if (a.action === 'image_send') { if (!wb.images) throw new Error('图片服务不可用'); value = monitor ? await monitor.serialize(a.taskId, () => wb.images.send(a)) : await wb.images.send(a); }
      else if (a.action === 'task_preview') { if (!taskLifecycle) throw new Error('任务管理服务不可用'); value = await taskLifecycle.preview(a.taskId, a.operation); }
      else if (a.action === 'task_lifecycle') { if (!taskLifecycle) throw new Error('任务管理服务不可用'); value = await taskLifecycle.run(a.taskId, a.operation); }
      else if (a.action === 'adopt_workspace') { if (!runtime) throw new Error('工作区服务不可用'); value = await runtime.adoptWorkspace(a.workspaceId); }
      else if (a.action === 'export_task') value = await wb.outputs.ensureReady(a.taskId, { verify: true });
      else if (a.action === 'runtime_catalog') { if (!runtime) throw new Error('模型服务不可用'); value = await runtime.catalog(); }
      else if (a.action === 'runtime_apply') { if (!runtime) throw new Error('模型服务不可用'); value = await runtime.apply(a.taskId); }
      else if (a.action === 'project_preview') { if (!lifecycle) throw new Error('工作区服务不可用'); value = await lifecycle.preview(a.projectId, a.operation); }
      else if (a.action === 'project_lifecycle') { if (!lifecycle) throw new Error('工作区服务不可用'); value = await lifecycle.run(a.projectId, a.operation); }
      else if (a.action === 'project') value = await wb.project(a);
      else if (a.action === 'workspace') value = await wb.workspace(a.projectId, a.workspaceId);
      else if (a.action === 'create') { if (runtime) await runtime.validate(a.execution || {}); value = await wb.create(a); }
      else if (a.action === 'bind') value = await wb.bind(a.taskId, a.sessionId);
      else if (a.action === 'message') value = await wb.message(a.taskId, a.text, a.imageCount);
      else if (a.action === 'message_delivered') value = await wb.messageDelivered(a.taskId, a.messageId);
      else if (a.action === 'answer') value = await wb.answer(a.taskId, a.questionId, a.answer, a.imageCount);
      else if (a.action === 'delivered') value = await wb.delivered(a.taskId, a.questionId);
      else if (a.action === 'pause') { value = await wb.pause(a.taskId); if (monitor) await monitor.pause(value); }
      else if (a.action === 'resume') value = await wb.resume(a.taskId);
      else if (a.action === 'accept') value = await wb.accept(a.taskId);
      else if (a.action === 'assignment') {
        const s = await wb.snapshot(), t = s.tasks.find(t => t.id === a.taskId); if (!t) throw new Error('任务不存在');
        const localOutput = await wb.outputs.ensureReady(t.id);
        value = { prompt: assignment({ ...t, localOutput }, s.projects.find(p => p.id === t.projectId)) };
      } else throw new Error('不支持的操作');
      return result(200, value);
    } catch (e) { return result(400, { error: required(e.message || '请求失败', '错误') }); }
  } }];
}
