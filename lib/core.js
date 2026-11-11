import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export function required(value, label, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 必须为非空文本，最多 ${max} 字符`);
  return value.trim();
}
function strings(value, label, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > 100) throw new Error(`${label} 数量无效`);
  return value.map(v => required(v, label, 4000));
}
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const event = (state, task, type, data) => {
  const item = { id: randomUUID(), taskId: task.id, at: now(), type, data };
  state.events.push(item); task.updatedAt = item.at;
};
const taskOf = (state, id) => {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw new Error('任务不存在');
  return task;
};
function writable(task) {
  if (['paused', 'review', 'accepted'].includes(task.status)) throw new Error('任务已暂停或待验收，不能继续写入执行结果');
}

/** One host owns one store. The directory lock also rejects a second profile. */
export class Store {
  constructor(file) { this.file = file; this.tail = Promise.resolve(); this.closed = false; }
  async open() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await mkdir(`${this.file}.lock`); // Fail closed on a second writer or an unreconciled crash.
    try {
      await writeFile(`${this.file}.lock/owner.json`, JSON.stringify({ pid: process.pid, startedAt: now() }));
      try { this.state = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; this.state = { version: 1, projects: [], tasks: [], events: [] }; }
      if (this.state.version !== 1 || !['projects', 'tasks', 'events'].every(k => Array.isArray(this.state[k]))) throw new Error('不支持或损坏的工作台数据');
      return this;
    } catch (e) { await rm(`${this.file}.lock`, { recursive: true, force: true }); throw e; }
  }
  async read() { await this.tail; return clone(this.state); }
  change(fn) {
    const work = this.tail.then(async () => {
      if (this.closed) throw new Error('工作台已关闭');
      const next = clone(this.state);
      const result = fn(next);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temp, this.file); }
      finally { await rm(temp, { force: true }); }
      this.state = next;
      return clone(result);
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async close() { if (this.closed) return; await this.tail; if (this.closed) return; this.closed = true; await rm(`${this.file}.lock`, { recursive: true, force: true }); }
}

/** Segmentation offers retrieval hints only; it never grants permission or chooses a project. */
export function intentHints(text, projects) {
  const normalized = required(text, '任务描述').normalize('NFKC');
  return {
    terms: [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(normalized)].filter(s => s.isWordLike).map(s => s.segment).slice(0, 80),
    projectCandidates: projects.filter(p => [p.name, ...(p.aliases || [])].some(n => normalized.toLowerCase().includes(n.toLowerCase()))).map(p => p.id),
    needsSemanticParsing: true
  };
}

export class Workbench {
  constructor(store) { this.store = store; }
  async snapshot() { return this.store.read(); }
  project(input) {
    const name = required(input.name, '项目名称', 100), cwd = required(input.cwd, '项目目录', 4000);
    if (!isAbsolute(cwd)) throw new Error('项目目录必须为绝对路径');
    return this.store.change(s => {
      if (s.projects.some(p => p.name === name)) throw new Error('项目名已存在');
      const p = { id: randomUUID(), name, cwd, aliases: strings(input.aliases || [], '别名'), createdAt: now() };
      s.projects.push(p); return p;
    });
  }
  create(input) {
    return this.store.change(s => {
      const project = s.projects.find(p => p.id === input.projectId);
      if (!project) throw new Error('必须明确选择项目');
      const brief = required(input.brief, '老板的任务描述');
      const task = { id: randomUUID(), projectId: project.id, brief, status: 'draft', sessionId: null, requestId: randomUUID(), plan: null, reports: [], questions: [], runs: [], createdAt: now(), updatedAt: now() };
      s.tasks.push(task); event(s, task, 'task.created', { brief, hints: intentHints(brief, s.projects) }); return task;
    });
  }
  bind(id, sessionId) {
    return this.store.change(s => {
      const t = taskOf(s, id);
      if (t.sessionId && t.sessionId !== sessionId) throw new Error('任务已绑定另一个会话');
      if (s.tasks.some(other => other.id !== id && other.sessionId === sessionId)) throw new Error('每个员工会话只能绑定一个任务');
      t.sessionId = required(sessionId, '会话 ID'); event(s, t, 'session.bound', { sessionId }); return t;
    });
  }
  async owned(id, sessionId) {
    const t = taskOf(await this.store.read(), id);
    if (!sessionId || t.sessionId !== sessionId) throw new Error('只允许任务绑定的员工会话操作；子 Agent 应向父会话回报');
    return t;
  }
  plan(id, input) {
    return this.store.change(s => {
      const t = taskOf(s, id); writable(t);
      if (t.plan) throw new Error('已有计划；需要变更时提交决策事项，不覆盖已交付阶段');
      if (!Array.isArray(input.stages) || input.stages.length < 1 || input.stages.length > 12) throw new Error('计划应有 1–12 个阶段');
      const stages = input.stages.map((item, i) => ({ id: `s${i + 1}`, title: required(item.title, '阶段名称', 300), acceptance: required(item.acceptance, '完成标准', 2000), status: 'pending', evidence: [] }));
      t.plan = { objective: required(input.objective, '目标'), constraints: strings(input.constraints || [], '约束'), assumptions: strings(input.assumptions || [], '假设'), stages };
      t.status = t.questions.some(q => !q.answer) ? 'waiting' : 'running'; event(s, t, 'plan.created', t.plan); return t;
    });
  }
  checkpoint(id, input) {
    return this.store.change(s => {
      const t = taskOf(s, id); writable(t);
      if (!t.plan) throw new Error('先记录任务契约和计划');
      const stage = t.plan.stages.find(item => item.id === input.stageId);
      if (!stage || stage.status === 'done') throw new Error('阶段不存在或已完成');
      if (t.questions.some(q => !q.answer && (!q.stageId || q.stageId === stage.id))) throw new Error('该阶段正在等待老板决策');
      const evidence = strings(input.evidence || [], '证据引用');
      if (input.done && !evidence.length) throw new Error('完成阶段必须附证据引用；模型陈述不等于已核实证据');
      if (t.reports.length >= 100) throw new Error('达到阶段更新上限，请老板检查任务');
      const report = { at: now(), stageId: stage.id, summary: required(input.summary, '本次完成'), remaining: strings(input.remaining, '未完成事项'), evidence, evidenceVerification: 'reported-by-agent' };
      t.reports.push(report); stage.status = input.done ? 'done' : 'running'; stage.evidence = evidence;
      t.status = t.questions.some(q => !q.answer) ? 'waiting' : 'running'; event(s, t, 'stage.reported', report); return t;
    });
  }
  question(id, input) {
    return this.store.change(s => {
      const t = taskOf(s, id); writable(t);
      if (input.stageId && !t.plan?.stages.some(st => st.id === input.stageId)) throw new Error('问题对应的阶段不存在');
      const q = { id: randomUUID(), stageId: input.stageId || null, question: required(input.question, '需决策的问题', 2000), reason: required(input.reason, '为何需要老板判断', 2000), options: strings(input.options || [], '选项'), recommendation: required(input.recommendation, '员工建议', 2000), answer: null, createdAt: now() };
      t.questions.push(q); t.status = 'waiting'; event(s, t, 'decision.requested', q); return q;
    });
  }
  answer(id, questionId, answer) {
    return this.store.change(s => {
      const t = taskOf(s, id), q = t.questions.find(q => q.id === questionId);
      if (!q || q.answer || ['review', 'accepted'].includes(t.status)) throw new Error('问题已回答或任务已结束');
      q.answer = required(answer, '老板的答复', 4000); q.answeredAt = now(); q.deliveryId = randomUUID(); q.delivered = false;
      // A reply never resumes a manually paused task.
      if (t.status !== 'paused') t.status = t.questions.some(q => !q.answer) ? 'waiting' : (t.plan ? 'running' : 'draft');
      event(s, t, 'decision.answered', { questionId, answer: q.answer }); return q;
    });
  }
  delivered(id, questionId) {
    return this.store.change(s => { const t = taskOf(s, id), q = t.questions.find(q => q.id === questionId); if (!q?.answer) throw new Error('没有待投递答复'); q.delivered = true; event(s, t, 'decision.delivered', { questionId }); return q; });
  }
  pause(id) { return this.store.change(s => { const t = taskOf(s, id); if (t.status === 'accepted') throw new Error('任务已验收'); t.status = 'paused'; event(s, t, 'task.paused', {}); return t; }); }
  resume(id) { return this.store.change(s => { const t = taskOf(s, id); if (t.status !== 'paused') throw new Error('任务未暂停'); t.status = t.questions.some(q => !q.answer) ? 'waiting' : t.plan ? 'running' : 'draft'; event(s, t, 'task.resumed', {}); return t; }); }
  review(id, summary) {
    return this.store.change(s => {
      const t = taskOf(s, id); writable(t);
      if (!t.plan || t.plan.stages.some(st => st.status !== 'done') || t.questions.some(q => !q.answer)) throw new Error('还有未交付阶段或未回答问题');
      if (t.runs.some(r => ['submitting', 'unknown', 'accepted'].includes(r.status))) throw new Error('外部执行结果尚未核实');
      t.summary = required(summary, '交付摘要'); t.status = 'review'; event(s, t, 'task.review', { summary: t.summary }); return t;
    });
  }
  accept(id) { return this.store.change(s => { const t = taskOf(s, id); if (t.status !== 'review') throw new Error('仅待验收任务可以验收'); t.status = 'accepted'; event(s, t, 'task.accepted', {}); return t; }); }
}
