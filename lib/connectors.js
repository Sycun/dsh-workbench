import { createHash, randomUUID } from 'node:crypto';
import { required } from './core.js';
import { connectionId, normalizeConnection, origin, expandPath, expandBody, readField } from './connection-config.js';

/** Configuration is host-owned. A model cannot choose arbitrary hosts, secrets or external projects. */
export class Connectors {
  constructor(store, config = {}, fetchImpl = fetch, kali = null, credentials = null) { this.store = store; this.config = config; this.fetch = fetchImpl; this.kali = kali; this.credentials = credentials; this.health = {}; this.outputs = store.outputs; }
  all() { return { ...(this.store.state.connections || {}), ...this.config }; }
  catalog() { return Object.entries(this.all()).map(([id, c]) => ({ id, label: c.label || id, adapter: c.adapter || id, enabled: c.enabled !== false, transport: c.transport || 'http' })); }
  settings() { return Object.entries(this.all()).map(([id, c]) => ({ id, label: c.label || id, adapter: c.adapter || id, enabled: c.enabled !== false, transport: c.transport || 'http', editable: !Object.hasOwn(this.config, id), config: Object.hasOwn(this.config, id) ? undefined : c, health: this.health[id] })); }
  configured(id) { connectionId(id); const c = this.all()[id]; if (!c) throw new Error('执行端未配置'); return c; }
  async save(input) {
    const c = normalizeConnection(input);
    if (Object.hasOwn(this.config, c.id)) throw new Error('该连接由宿主配置管理，请在宿主配置中修改');
    await this.store.change(s => {
      if (s.tasks.some(t => t.runs.some(r => r.connector === c.id && ['submitting', 'accepted', 'unknown'].includes(r.status)))) throw new Error('该执行端仍有未核实的任务，先核实结果再修改连接');
      s.connections = { ...(s.connections || {}), [c.id]: c };
      for (const task of s.tasks) if (task.authorizations) delete task.authorizations[c.id];
      return c;
    });
    delete this.health[c.id]; return { id: c.id, saved: true };
  }
  async setToken(id, value) {
    const c = this.configured(id);
    if (!this.credentials || c.authType !== 'bearer' || !c.tokenRef) throw new Error('该连接未配置可写的 Bearer 凭据引用');
    await this.credentials.set(c.tokenRef, required(value, '令牌', 16000));
    return { configured: true };
  }
  async probe(id) {
    const c = this.configured(id); if (c.transport === 'kali') throw new Error('请使用 Kali 连接状态检查');
    if (!c.healthPath) throw new Error('请先配置只读的连接测试路径');
    await this.request({ config: c, base: new URL(origin(c.baseUrl)), kind: id }, c.healthPath);
    return this.health[id] = { ok: true, checkedAt: new Date().toISOString(), message: '测试接口响应正常；不代表任务已经完成' };
  }
  binding(task, kind, action) {
    connectionId(kind);
    const config = this.configured(kind), mapping = config?.projects?.[task.projectId] || this.store.state.projects.find(p => p.id === task.projectId)?.integrations?.[kind];
    if (!mapping?.externalId) throw new Error('该项目尚未绑定此执行端');
    if (!['artex', 'cyberstrikeai', 'http-json'].includes(config.adapter || kind)) throw new Error('不支持的执行端适配器');
    if (action !== 'status' && config.enabled === false) throw new Error('执行端已禁用');
    const base = new URL(origin(config.baseUrl));
    let grant;
    if (action !== 'status') {
      // Exact task grants are entered in host config, never inferred from model text or a confidence score.
      grant = mapping.grants?.find(g => g.taskId === task.id && g.actions?.includes(action)) || this.store.state.tasks.find(t => t.id === task.id)?.authorizations?.[kind];
      if (!grant || !grant.actions?.includes(action) || !grant.scope || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('此动作缺少有效的任务授权配置');
    }
    return { config, mapping, base, kind, grant };
  }
  async request(binding, path, body, idempotencyKey) {
    if (binding.config.transport === 'kali') {
      if (!this.kali) throw new Error('Kali 通道未启用');
      return this.kali.request(binding.kind, path, body, idempotencyKey);
    }
    const ref = binding.config.tokenRef || binding.config.tokenEnv;
    const token = ref ? ((await this.credentials?.resolve(ref))?.value || process.env[ref]) : undefined;
    if ((binding.config.authType === 'bearer' || ref) && !token) throw new Error('认证令牌未配置，请在工具接入设置中保存凭据');
    const url = new URL(path, binding.base);
    if (url.origin !== binding.base.origin) throw new Error('接口路径不能跳转到其他服务');
    const response = await this.fetch(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    // Never include response bodies in thrown errors: upstream failures can echo credentials.
    if (!response.ok) throw new Error(`执行端 HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; if (bytes > 2 * 1024 * 1024) throw new Error('执行端响应超过 2 MiB'); chunks.push(Buffer.from(r.value)); }
    } finally { await reader.cancel(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('执行端响应不是有效 JSON'); }
  }
  source(binding) { return { adapter: binding.config.adapter || binding.kind, transport: binding.config.transport || 'http', origin: binding.config.transport === 'kali' ? 'parallels:' + (this.kali?.config?.vm || 'unconfigured') : binding.base.origin, externalId: binding.mapping.externalId }; }
  async status(task, kind) {
    const binding = this.binding(task, kind, 'status');
    let value;
    try { value = await this.readStatus(task, kind); }
    catch (error) { await this.outputs.receive(task.id, kind, 'status-error', { error: error.message }, this.source(binding)); throw error; }
    const saved = await this.outputs.receive(task.id, kind, 'status', value, this.source(binding));
    return { ...value, localOutput: saved.localOutput, localResultPath: saved.item.path || null };
  }
  async readStatus(task, kind) {
    const b = this.binding(task, kind, 'status'), id = encodeURIComponent(b.mapping.externalId);
    const adapter = b.config.adapter || kind;
    if (adapter === 'http-json') {
      const values = { projectId: b.mapping.externalId, taskId: task.id };
      const runs = [];
      if (b.config.runStatusPath) for (const r of task.runs.filter(r => r.connector === kind)) { const runId = readField(r.receipt, b.config.runIdField); if (runId !== undefined) runs.push({ localId: r.id, result: await this.request(b, expandPath(b.config.runStatusPath, { ...values, runId })) }); }
      return { project: await this.request(b, expandPath(b.config.statusPath, values)), runs };
    }
    if (adapter === 'artex') {
      const results = await Promise.all([this.request(b, `/api/tasks/${id}`), this.request(b, `/api/tasks/${id}/chat/status`)]);
      return { task: results[0], chat: results[1], note: 'chat.running=false 仅表示主对话空闲，不证明任务或 Worker 已完成。' };
    }
    if (adapter !== 'cyberstrikeai') throw new Error('不支持的执行端适配器');
    const runs = task.runs.filter(r => r.connector === kind && r.receipt?.runId);
    return { project: await this.request(b, `/api/projects/${id}`), runs: await Promise.all(runs.map(async r => ({ localId: r.id, result: await this.request(b, `/api/eino-agent/runs/${encodeURIComponent(r.receipt.runId)}`) }))) };
  }
  async submit(task, kind, message, key) {
    if (!task.plan || !['running', 'waiting'].includes(task.status) || task.questions.some(q => !q.answer)) throw new Error('执行前需有计划且没有待回答的问题');
    const b = this.binding(task, kind, 'submit');
    await this.outputs.ensureReady(task.id);
    required(message, '执行指令'); required(key, '幂等键', 100);
    const grant = b.grant;
    const fullMessage = `工作台任务 ${task.id}\n授权范围：${grant.scope}\n约束：${task.plan.constraints.join('；')}\n完成标准：${task.plan.stages.map(s => s.acceptance).join('；')}\n具体指令：${message}\n需要扩大范围或人工决策时停止相关分支并报告。\n请通过响应返回执行结果；文件产物返回明确的文件标识、导出位置和可用哈希。工作台负责归档到用户指定的本机项目目录，不要求整个目录同步，也不要把本机主工作区路径当作你的本地路径。`;
    const digest = createHash('sha256').update(fullMessage).digest('hex');
    const run = await this.store.change(s => {
      const live = s.tasks.find(t => t.id === task.id);
      const project = s.projects.find(p => p.id === live.projectId);
      if (project?.lifecycle && project.lifecycle !== 'active') throw new Error('项目已归档、移除或正在同步');
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
    let receipt;
    try {
      const adapter = b.config.adapter || kind;
      const values = { projectId: b.mapping.externalId, taskId: task.id, message: fullMessage, idempotencyKey: `${task.id}:${key}` };
      receipt = adapter === 'http-json'
        ? await this.request(b, expandPath(b.config.submitPath, values), expandBody(b.config.bodyTemplate, values), values.idempotencyKey)
        : adapter === 'cyberstrikeai'
        ? await this.request(b, '/api/eino-agent/runs', { projectId: b.mapping.externalId, message: fullMessage }, `${task.id}:${key}`)
        : await this.request(b, `/api/chat?task=${encodeURIComponent(b.mapping.externalId)}`, { message: fullMessage });
    } catch (error) { await update('unknown'); await this.outputs.receive(task.id, kind, 'submit-error', { error: error.message, outcome: 'unknown' }, this.source(b)); throw new Error(`${error.message}；提交结果未知，先查询远端，不能换幂等键重发。`); }
    const runResult = await update('accepted', receipt);
    const saved = await this.outputs.receive(task.id, kind, 'submit', receipt, this.source(b));
    return { ...runResult, localOutput: saved.localOutput, localReceiptPath: saved.item.path || null };
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
