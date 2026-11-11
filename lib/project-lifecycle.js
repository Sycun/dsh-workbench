const active = p => !p.lifecycle || p.lifecycle === 'active';
const unfinishedWorkers = t => (t.workOrders || []).some(o => ['starting', 'running', 'reporting'].includes(o.state) || (t.status !== 'paused' && o.state !== 'accepted'));
export class ProjectLifecycle {
  constructor(wb, registry, activity = async () => []) { this.wb = wb; this.registry = registry; this.activity = activity; this.pending = new Map(); this.dispatch = (_, operation) => operation(); }
  async preview(projectId, action) {
    if (!['archive', 'delete', 'restore'].includes(action)) throw new Error('不支持的项目操作');
    const state = await this.wb.snapshot(), project = state.projects.find(p => p.id === projectId);
    if (!project) throw new Error('项目不存在');
    if (action === 'delete' && project.workspaceId === this.wb.defaultWorkspace?.id) throw new Error('不能移除 DSH 默认工作区登记，可归档其中的会话');
    const workspace = this.registry.get(project.workspaceId);
    if (workspace && workspace.path !== project.cwd) throw new Error('DSH 工作区路径与项目路径不一致，请先修正关联');
    const sessionIds = [...new Set([...(workspace?.sessionIds || []), ...(project.nativeArchive?.sessionIds || []), ...state.tasks.filter(t => t.projectId === projectId && t.sessionId).map(t => t.sessionId)])];
    const previouslyArchivedSessionIds = project.nativeArchive?.previouslyArchivedSessionIds || (active(project) ? sessionIds.filter(id => this.registry.archivedSessionIds.includes(id)) : []);
    return { action, projectId, name: project.name, path: project.cwd, taskCount: state.tasks.filter(t => t.projectId === projectId).length, sessionCount: sessionIds.length, sessionIds, previouslyArchivedSessionIds, workspaceId: workspace?.id || project.workspaceId, title: workspace?.title || project.name, filesRetained: true };
  }
  async warnings() {
    const state = await this.wb.snapshot(), archived = new Set(this.registry.archivedSessionIds);
    return state.projects.flatMap(p => {
      if (p.lifecycle === 'sync-error') return [{ projectId: p.id, name: p.name, message: '项目同步未完成：' + (p.lifecycleError || '请重试或恢复'), action: p.nativeArchive?.action }];
      if (!active(p)) return [];
      const workspace = this.registry.get(p.workspaceId);
      if (p.workspaceId && !workspace) return [{ projectId: p.id, name: p.name, message: 'DSH 工作区登记已移除，但项目工作台内项目还没归档。' }];
      if (workspace?.sessionIds.length && workspace.sessionIds.every(id => archived.has(id)) && workspace.sessionIds.some(id => !state.tasks.some(t => t.sessionId === id && ['archived', 'deleted'].includes(t.lifecycle)))) return [{ projectId: p.id, name: p.name, message: 'DSH 中该项目的全部会话已归档，但项目工作台内项目还没归档。' }];
      return [];
    });
  }
  run(projectId, action) {
    return this.serialized(projectId, () => this.dispatch(projectId, () => this.perform(projectId, action)));
  }
  serialized(projectId, operation) {
    const previous = this.pending.get(projectId) || Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    this.pending.set(projectId, run);
    run.finally(() => { if (this.pending.get(projectId) === run) this.pending.delete(projectId); }).catch(() => {});
    return run;
  }
  async perform(projectId, action) {
    const preview = await this.preview(projectId, action);
    const state = await this.wb.snapshot(), p = state.projects.find(p => p.id === projectId);
    if ((action === 'archive' && p.lifecycle === 'archived') || (action === 'delete' && p.lifecycle === 'deleted') || (action === 'restore' && active(p))) return p;
    if (action === 'restore' && !p.nativeArchive) throw new Error('没有工作台归档快照，无法自动恢复');
    if (action !== 'restore') {
      if (state.tasks.some(t => t.projectId === projectId && unfinishedWorkers(t))) throw new Error('项目还有未结束的专员工作单，请先暂停任务并等待专员停止');
      if (state.tasks.some(t => t.projectId === projectId && t.runs.some(r => ['submitting', 'accepted', 'unknown'].includes(r.status)))) throw new Error('项目还有未核实的外部执行任务，请先核实结果');
      for (const id of preview.sessionIds) if (!this.registry.archivedSessionIds.includes(id) && (await this.activity(id)).length) throw new Error('DSH 项目中仍有活动会话，请先暂停或等待完成后再归档');
    }
    await this.wb.store.change(s => {
      const project = s.projects.find(p => p.id === projectId);
      if (action !== 'restore' && s.tasks.some(t => t.projectId === projectId && unfinishedWorkers(t))) throw new Error('项目刚收到专员工作单，请先暂停任务并等待专员停止');
      if (action !== 'restore' && s.tasks.some(t => t.projectId === projectId && t.runs.some(r => ['submitting', 'accepted', 'unknown'].includes(r.status)))) throw new Error('项目刚收到新的外部执行任务，请先核实结果');
      project.lifecycle = action === 'restore' ? 'restoring' : action === 'delete' ? 'deleting' : 'archiving';
      project.lifecycleError = null;
      project.nativeArchive = { ...preview, action, progress: [] };
      return project;
    });
    try {
      let workspace;
      if (action === 'restore') {
        workspace = await this.registry.create(preview.path, preview.title);
        for (const id of preview.sessionIds) {
          await workspace.attachSession(id);
          const individuallyHidden = state.tasks.some(t => t.sessionId === id && t.lifecycle && t.lifecycle !== 'active');
          if (!individuallyHidden && !preview.previouslyArchivedSessionIds.includes(id)) await this.registry.unarchiveSession(id);
          await this.progress(projectId, id);
        }
      } else {
        for (const id of preview.sessionIds) { await this.registry.archiveSession(id); await this.progress(projectId, id); }
        // DSH archives Sessions, not filesystem directories. Removing only this
        // registration hides the whole project while its files/logs remain intact.
        if (preview.workspaceId && preview.workspaceId !== this.wb.defaultWorkspace?.id) await this.registry.delete(preview.workspaceId);
      }
      return await this.wb.store.change(s => {
        const project = s.projects.find(p => p.id === projectId);
        project.lifecycle = action === 'restore' ? 'active' : action === 'delete' ? 'deleted' : 'archived';
        project.lifecycleChangedAt = new Date().toISOString();
        if (workspace) { project.workspaceId = workspace.id; project.nativeArchive = null; }
        if (action !== 'restore') for (const task of s.tasks.filter(t => t.projectId === projectId)) task.authorizations = {};
        return project;
      });
    } catch (error) {
      await this.wb.store.change(s => { const project = s.projects.find(p => p.id === projectId); project.lifecycle = 'sync-error'; project.lifecycleError = error.message; return project; });
      throw new Error('项目同步未全部完成，文件仍在原路径。' + error.message);
    }
  }
  progress(projectId, sessionId) {
    return this.wb.store.change(s => { const p = s.projects.find(p => p.id === projectId); p.nativeArchive.progress.push(sessionId); return null; });
  }
}
