import { taskActive } from './lifecycle-state.js';

const activeProject = p => p && (!p.lifecycle || p.lifecycle === 'active');
const unfinishedWorkers = t => (t.workOrders || []).some(o => ['starting', 'running', 'reporting'].includes(o.state));
const unresolved = t => t.runs.some(r => ['submitting', 'accepted', 'unknown'].includes(r.status));

/** Reversible task organization. Native conversations are archived; project files are never deleted. */
export class TaskLifecycle {
  constructor(wb, projects, registry, activity) { this.wb = wb; this.projects = projects; this.registry = registry; this.activity = activity; this.dispatch = (_, operation) => operation(); }
  async preview(taskId, action) {
    if (!['archive', 'delete', 'restore'].includes(action)) throw new Error('不支持的任务操作');
    const state = await this.wb.snapshot(), task = state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error('任务不存在');
    const project = state.projects.find(p => p.id === task.projectId);
    if (!project) throw new Error('所属项目不存在');
    const own = task.lifecycle || 'active', retry = ['sync-error', 'archiving', 'deleting', 'restoring'].includes(own) && task.taskArchive?.action === action;
    const previousLifecycle = retry ? task.taskArchive.previousLifecycle : own;
    const targetLifecycle = retry ? task.taskArchive.targetLifecycle : action === 'archive' ? 'archived' : action === 'delete' ? 'deleted' : own === 'deleted' && task.taskArchive?.previousLifecycle === 'archived' ? 'archived' : 'active';
    return { taskId, projectId: project.id, projectName: project.name, name: task.brief.split(/[。！？\n]/)[0].slice(0, 80), path: project.cwd, action, previousLifecycle, targetLifecycle, sessionId: task.sessionId, filesRetained: true };
  }
  async run(taskId, action) {
    const preview = await this.preview(taskId, action);
    return this.projects.serialized(preview.projectId, () => this.dispatch(taskId, () => this.perform(taskId, action)));
  }
  async perform(taskId, action) {
    const preview = await this.preview(taskId, action), state = await this.wb.snapshot();
    const task = state.tasks.find(t => t.id === taskId), project = state.projects.find(p => p.id === task.projectId);
    if (['archiving', 'deleting', 'restoring', 'sync-error'].includes(project.lifecycle)) throw new Error('请先完成所属项目的同步或恢复');
    if (action === 'restore' && !activeProject(project)) throw new Error('该任务随所属项目一起归档或删除，请先恢复项目');
    if (action !== 'restore' && project.lifecycle === 'deleted') throw new Error('请先恢复所属项目，再整理单个任务');
    if ((action === 'archive' && task.lifecycle === 'archived') || (action === 'delete' && task.lifecycle === 'deleted') || (action === 'restore' && taskActive(task))) return task;
    if (action === 'archive' && task.lifecycle === 'deleted') throw new Error('请先从回收站恢复任务');
    if (action === 'restore' && !task.taskArchive) throw new Error('没有任务归档快照，请检查所属项目');
    if (unresolved(task)) throw new Error('任务还有未核实的远端执行，请先核实结果');
    if (unfinishedWorkers(task)) throw new Error('专员仍在执行，请先暂停任务并等待专员停止');
    if (task.sessionId && (await this.activity(task.sessionId)).length) throw new Error('DSH 会话仍在执行，请先暂停或等待本轮结束');
    await this.wb.store.change(s => {
      const t = s.tasks.find(t => t.id === taskId);
      if (unresolved(t) || unfinishedWorkers(t)) throw new Error('任务刚收到新的执行工作，请先暂停并核实');
      t.lifecycle = action === 'restore' ? 'restoring' : action === 'archive' ? 'archiving' : 'deleting';
      t.taskArchive = preview; t.lifecycleError = null;
      // Restoring a historical task never resumes old work automatically.
      if (!['review', 'accepted', 'paused'].includes(t.status)) t.status = 'paused';
      if (action !== 'restore') t.authorizations = {};
      return null;
    });
    try {
      if (task.sessionId) {
        if (preview.targetLifecycle === 'active') {
          const workspace = await this.registry.create(project.cwd, project.name);
          await workspace.attachSession(task.sessionId);
          await this.wb.workspace(project.id, workspace.id);
          await this.registry.unarchiveSession(task.sessionId);
        } else await this.registry.archiveSession(task.sessionId);
      }
      return this.wb.store.change(s => {
        const t = s.tasks.find(t => t.id === taskId);
        t.lifecycle = preview.targetLifecycle; t.lifecycleError = null; t.lifecycleChangedAt = new Date().toISOString();
        if (t.lifecycle === 'active') t.taskArchive = null;
        s.events.push({ id: `task-lifecycle:${t.id}:${t.lifecycleChangedAt}`, taskId: t.id, at: t.lifecycleChangedAt, type: `task.${action}`, data: { collection: t.lifecycle, filesRetained: true } });
        return t;
      });
    } catch (error) {
      await this.wb.store.change(s => { const t = s.tasks.find(t => t.id === taskId); t.lifecycle = 'sync-error'; t.lifecycleError = error.message; return null; });
      throw new Error('任务与 DSH 同步未完成，文件已保留，可重试或恢复。' + error.message);
    }
  }
}
