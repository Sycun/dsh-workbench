export class NativeWorkers {
  constructor(ctx, runtime) { this.ctx = ctx; this.runtime = runtime; }
  service() { return this.ctx.get?.('subagents'); }
  available() { const p = this.service()?.getProvider('spawn'); return Boolean(p?.prepareContinuable && !p.inheritsParentContext && p.capabilities.depthLimit); }
  tools(agent) { return this.ctx.tools.definitions(agent); }
  isDelegation(name, agent) {
    const tool = this.ctx.tools.get(name, agent);
    return /(?:subagent|spawn_agent|fork_agent|team_create|create_team)/i.test(name) || /Delegate a .*subagent|starts an independently managed subagent/i.test(tool?.description || '');
  }
  validateExecution(value) { return this.runtime.validate(value); }
  state(sessionId) { return this.ctx.sessionController.state({ sessionId }, AbortSignal.timeout(5000)); }
  async start({ task, order, attempt, project, prompt, signal }) {
    const resolved = await this.ctx.sessionController.agents.resolveAgent(task.sessionId);
    if (resolved.error) throw resolved.error;
    const parent = resolved.agent;
    if (parent.session.header.cwd !== project.cwd) throw new Error('主管会话目录与项目不一致');
    await this.runtime.validate(order.execution);
    return this.service().startActivation({ provider: 'spawn', childId: attempt.workerSessionId, label: order.title, signal, delivery: 'caller', request: {
      parent, cwd: project.cwd, prompt: [{ type: 'text', text: prompt }], maxDepth: 1,
      ...(order.execution.agentPreset ? { agentPreset: order.execution.agentPreset } : {}),
      ...(order.execution.model ? { agentOptions: order.execution.model } : {})
    } });
  }
  async cancel(parentSessionId, childId) { this.service()?.interrupt(childId, { kind: 'user', parentSessionId }); }
}
