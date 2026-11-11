export function normalizeExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('员工配置必须为对象');
  for (const key of Object.keys(input)) if (!['agentPreset', 'model'].includes(key)) throw new Error('不支持的员工配置字段');
  const string = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`${label} 无效`); return value.trim(); };
  const result = {};
  if (input.agentPreset) result.agentPreset = string(input.agentPreset, '智能体模式');
  if (input.model !== undefined && input.model !== null) {
    const model = input.model;
    if (typeof model !== 'object' || Array.isArray(model)) throw new Error('模型选择无效');
    for (const key of Object.keys(model)) if (!['provider', 'model', 'reasoningEffort'].includes(key)) throw new Error('不支持的模型配置字段');
    result.model = { provider: string(model.provider, '模型提供方'), model: string(model.model, '模型 ID') };
    if (model.reasoningEffort) result.model.reasoningEffort = string(model.reasoningEffort, '推理等级');
  }
  return result;
}

/** Uses the installed DSH model catalog and AgentModel without writing its global default. */
export class RuntimeSelection {
  constructor(wb, host) { this.wb = wb; this.host = host; this.pending = new Map(); }
  async catalog() {
    const [models, presets] = await Promise.allSettled([
      this.host.sessionController.modelCatalog(),
      this.host.presets?.remoteExportList() || Promise.resolve({ presets: [] })
    ]);
    return {
      models: models.status === 'fulfilled' ? models.value : null,
      presets: presets.status === 'fulfilled' ? presets.value.presets : [],
      errors: [models.status === 'rejected' ? '模型列表暂不可用' : null, presets.status === 'rejected' ? '模式列表暂不可用' : null].filter(Boolean)
    };
  }
  async validate(input) {
    const execution = normalizeExecution(input);
    if (execution.agentPreset) {
      if (!this.host.presets) throw new Error('当前 DSH 未提供智能体模式');
      const preset = (await this.host.presets.remoteExportList()).presets.find(p => p.id === execution.agentPreset);
      if (!preset || preset.broken) throw new Error('所选智能体模式不可用，请刷新模式列表');
    }
    if (execution.model) {
      const catalog = await this.host.sessionController.modelCatalog();
      const entry = catalog.groups.find(p => p.id === execution.model.provider)?.models.find(m => m.id === execution.model.model);
      if (!entry) throw new Error('所选模型已不可用，请刷新模型列表');
      if (execution.model.reasoningEffort && !entry.reasoning?.efforts.some(e => e.id === execution.model.reasoningEffort)) throw new Error('该模型不支持所选推理等级');
      await this.host.llm.resolveCallConfig(execution.model);
    }
    return execution;
  }
  apply(taskId) {
    if (this.pending.has(taskId)) return this.pending.get(taskId);
    const promise = this.applyOnce(taskId);
    this.pending.set(taskId, promise);
    promise.finally(() => { if (this.pending.get(taskId) === promise) this.pending.delete(taskId); }).catch(() => {});
    return promise;
  }
  async applyOnce(taskId) {
    const state = await this.wb.snapshot(), task = state.tasks.find(t => t.id === taskId);
    if (!task?.sessionId) throw new Error('任务尚未绑定员工会话');
    if (task.runtimeApplied?.sessionId === task.sessionId) return task.runtimeApplied;
    if (task.status !== 'draft') throw new Error('启动配置仅能在任务开始前应用');
    await this.wb.owned(taskId, task.sessionId);
    const execution = await this.validate(task.execution || {});
    const found = await this.host.sessionController.agents.resolveAgent(task.sessionId);
    if (found.error) throw found.error;
    const agent = found.agent;
    if (!agent || agent.session.header.cwd !== state.projects.find(p => p.id === task.projectId)?.cwd) throw new Error('员工会话目录与项目不一致');
    if (agent.session.requestHeader() || (await this.host.activity(task.sessionId)).length) throw new Error('员工会话已开始执行，不能重新应用启动配置');
    const preset = this.host.presets?.presetForSession(agent.session);
    if (execution.agentPreset && preset !== execution.agentPreset) throw new Error('员工实际模式与选择不一致');
    if (execution.model) agent.model.select(execution.model);
    const applied = {
      sessionId: task.sessionId,
      ...(preset ? { agentPreset: preset } : {}),
      ...(agent.model.current() ? { model: agent.model.current() } : {}),
      appliedAt: new Date().toISOString()
    };
    return this.wb.store.change(s => {
      const current = s.tasks.find(t => t.id === taskId);
      if (current.sessionId !== task.sessionId || current.status !== 'draft') throw new Error('任务状态已变化，未发送任务指令');
      const project = s.projects.find(p => p.id === current.projectId);
      if (project?.lifecycle && project.lifecycle !== 'active') throw new Error('项目当前不能派工');
      current.runtimeApplied = applied;
      return applied;
    });
  }
}
