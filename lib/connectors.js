import { createHash, randomUUID } from 'node:crypto';
import { required } from './core.js';

/** Configuration is host-owned. A model cannot choose arbitrary hosts, secrets or external projects. */
export class Connectors {
  constructor(store, config = {}, fetchImpl = fetch) { this.store = store; this.config = config; this.fetch = fetchImpl; }
  binding(task, kind, action) {
    if (!['cyberstrikeai', 'artex'].includes(kind)) throw new Error('未知执行端');
    const config = this.config[kind], mapping = config?.projects?.[task.projectId];
    if (!mapping?.externalId) throw new Error('该项目尚未绑定此执行端');
    const base = new URL(config.baseUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('执行端 baseUrl 必须为 HTTP(S) origin，不含路径或凭据');
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('远端请使用 HTTPS，或通过 SSH 隧道连接本地回环端口');
    if (action !== 'status') {
      // Exact task grants are entered in host config, never inferred from model text or a confidence score.
      const grant = mapping.grants?.find(g => g.taskId === task.id && g.actions?.includes(action));
      if (!grant || !grant.scope || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('此动作缺少有效的任务授权配置');
    }
    const token = process.env[config.tokenEnv];
    if (!token) throw new Error(`未设置 ${config.tokenEnv || 'tokenEnv'}`);
    return { config, mapping, base, token };
  }
  async request(binding, path, body, idempotencyKey) {
    const response = await this.fetch(new URL(path, binding.base), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${binding.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    // Never include response bodies in thrown errors: upstream failures can echo credentials.
    if (!response.ok) throw new Error(`执行端 HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; if (bytes > 2 * 1024 * 1024) throw new Error('执行端响应超过 2 MiB'); chunks.push(Buffer.from(r.value)); }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async status(task, kind) {
    const b = this.binding(task, kind, 'status'), id = encodeURIComponent(b.mapping.externalId);
    if (kind === 'artex') {
      const results = await Promise.all([this.request(b, `/api/tasks/${id}`), this.request(b, `/api/tasks/${id}/chat/status`)]);
      return { task: results[0], chat: results[1], note: 'chat.running=false 仅表示主对话空闲，不证明任务或 Worker 已完成。' };
    }
    const runs = task.runs.filter(r => r.connector === kind && r.receipt?.runId);
    return { project: await this.request(b, `/api/projects/${id}`), runs: await Promise.all(runs.map(async r => ({ localId: r.id, result: await this.request(b, `/api/eino-agent/runs/${encodeURIComponent(r.receipt.runId)}`) }))) };
  }
  async submit(task, kind, message, key) {
    if (!task.plan || !['running', 'waiting'].includes(task.status) || task.questions.some(q => !q.answer)) throw new Error('执行前需有计划且没有待回答的问题');
    const b = this.binding(task, kind, 'submit');
    required(message, '执行指令'); required(key, '幂等键', 100);
    const grant = b.mapping.grants.find(g => g.taskId === task.id && g.actions.includes('submit'));
    const fullMessage = `工作台任务 ${task.id}\n授权范围：${grant.scope}\n约束：${task.plan.constraints.join('；')}\n完成标准：${task.plan.stages.map(s => s.acceptance).join('；')}\n具体指令：${message}\n需要扩大范围或人工决策时停止相关分支并报告。`;
    const digest = createHash('sha256').update(fullMessage).digest('hex');
    const run = await this.store.change(s => {
      const live = s.tasks.find(t => t.id === task.id);
      if (!['running', 'waiting'].includes(live.status) || live.questions.some(q => !q.answer)) throw new Error('任务状态已改变');
      const old = live.runs.find(r => r.connector === kind && r.key === key);
      if (old) { if (old.digest !== digest) throw new Error('同一幂等键的指令发生变化'); return { ...old, duplicate: true }; }
      if (live.runs.some(r => ['submitting', 'accepted', 'unknown'].includes(r.status))) throw new Error('已有外部任务待核实，不能重复提交');
      const r = { id: randomUUID(), connector: kind, key, digest, status: 'submitting', at: new Date().toISOString() };
      live.runs.push(r); return r;
    });
    if (run.duplicate) return run;
    const update = (status, receipt) => this.store.change(s => {
      const live = s.tasks.find(t => t.id === task.id), r = live.runs.find(r => r.id === run.id);
      Object.assign(r, { status, ...(receipt ? { receipt } : {}) });
      s.events.push({ id: randomUUID(), taskId: task.id, at: new Date().toISOString(), type: 'connector.submission', data: { runId: r.id, status, connector: kind } }); return r;
    });
    try {
      const receipt = kind === 'cyberstrikeai'
        ? await this.request(b, '/api/eino-agent/runs', { projectId: b.mapping.externalId, message: fullMessage }, `${task.id}:${key}`)
        : await this.request(b, `/api/chat?task=${encodeURIComponent(b.mapping.externalId)}`, { message: fullMessage });
      return await update('accepted', receipt);
    } catch (error) { await update('unknown'); throw new Error(`${error.message}；提交结果未知，先查询远端，不能换幂等键重发。`); }
  }
  async reconcile(task, runId, evidence, outcome) {
    // Human-only operation. ARTEX has no per-message run receipt, so idle is insufficient for automatic completion.
    required(evidence, '远端结果证据');
    if (!['completed', 'failed', 'cancelled'].includes(outcome)) throw new Error('无效的核实结果');
    return this.store.change(s => {
      const r = s.tasks.find(t => t.id === task.id)?.runs.find(r => r.id === runId);
      if (!r) throw new Error('外部执行记录不存在');
      Object.assign(r, { status: outcome, reconciliation: { by: 'human', evidence, at: new Date().toISOString() } });
      s.events.push({ id: randomUUID(), taskId: task.id, at: new Date().toISOString(), type: 'connector.reconciled', data: { runId, outcome, evidence } }); return r;
    });
  }
}
