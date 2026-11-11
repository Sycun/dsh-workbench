import { mkdir, lstat, realpath, readdir, open, readFile, rename, rm, link } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { join, relative, isAbsolute, basename, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const OUTPUT_FOLDER = '工作台产出';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !r.startsWith('..' + '\\') && !isAbsolute(r)); };
const safeId = id => { if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('无效的成果标识'); return id; };
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const labels = { draft: '待执行', running: '执行中', waiting: '待决策', paused: '已暂停', review: '待验收', accepted: '已验收' };
const cleanTask = task => { const { localOutput, ...value } = task; return value; };

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('成果目录不能是符号链接或普通文件');
  return path;
}
async function immutable(path, bytes) {
  const expected = hash(bytes), temp = join(dirname(path), '.workbench-tmp-' + randomUUID());
  try {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(path)) !== expected) throw new Error('已有成果文件发生变化，未覆盖：' + basename(path));
      return { path, sha256: expected, bytes: bytes.length };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temp, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(path)) !== expected) throw new Error('已有成果文件发生变化，未覆盖：' + basename(path));
    }
    return { path, sha256: expected, bytes: bytes.length };
  } finally { await rm(temp, { force: true }); }
}
async function ownedIndex(path, value) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('成果索引路径被其他文件占用');
    const old = JSON.parse(await readFile(path, 'utf8'));
    if (old.format !== value.format || old.taskId !== value.taskId) throw new Error('成果索引不属于该任务');
    const stable = ({ updatedAt, ...rest }) => JSON.stringify(rest);
    if (stable(old) === stable(value)) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path + '.' + randomUUID() + '.tmp';
  try { const file = await open(temp, 'wx', 0o600); try { await file.writeFile(json(value)); await file.sync(); } finally { await file.close(); } await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function localFile(project, path, expected, verify = true) {
  if (!isAbsolute(path)) throw new Error('本地成果必须填写绝对路径');
  const canonical = await realpath(path);
  if (!inside(project.cwd, canonical)) throw new Error('成果文件不在该项目目录内');
  const info = await lstat(canonical);
  if (!info.isFile()) throw new Error('成果必须是普通文件');
  if (!verify && expected && expected.bytes === info.size && expected.mtimeMs === info.mtimeMs) return expected;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(canonical)) digest.update(chunk);
  const result = { path: canonical, sha256: digest.digest('hex'), bytes: info.size, mtimeMs: info.mtimeMs };
  if (expected && result.sha256 !== expected.sha256) throw new Error('本地成果内容已变化，请重新登记：' + basename(path));
  return result;
}

/** A task's durable state is mirrored into its assigned local project, never into a remote workspace. */
export class ProjectOutputs {
  constructor(store) {
    this.store = store; this.pending = new Map();
    store.afterChange(async (before, after) => {
      const old = new Map(before.tasks.map(t => [t.id, JSON.stringify(cleanTask(t))]));
      for (const task of after.tasks) if (old.get(task.id) !== JSON.stringify(cleanTask(task))) await this.flush(task.id);
    });
  }
  async root(project, task) {
    if (await realpath(project.cwd) !== project.cwd || !(await lstat(project.cwd)).isDirectory()) throw new Error('项目目录不可用或路径已变化');
    const parent = await directory(join(project.cwd, OUTPUT_FOLDER));
    const root = join(parent, safeId(task.id));
    await directory(root);
    const marker = join(root, '.workbench-output.json');
    try {
      const existing = await lstat(marker);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('成果目录标记无效');
      const value = JSON.parse(await readFile(marker, 'utf8'));
      if (value.taskId !== task.id || value.projectId !== project.id) throw new Error('成果目录属于其他项目或任务');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await readdir(root)).some(name => !/^\.workbench-tmp-[a-f0-9-]+$/.test(name))) throw new Error('成果目录已被占用，未写入已有目录');
      await immutable(marker, json({ format: 'dsh-workbench-output/v1', projectId: project.id, taskId: task.id }));
    }
    return root;
  }
  async inspect(taskId, path, expected) {
    const state = await this.store.read(), task = state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error('任务不存在');
    return localFile(state.projects.find(p => p.id === task.projectId), path, expected, true);
  }
  flush(taskId, options = {}) {
    const previous = this.pending.get(taskId) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.flushOnce(taskId, options));
    this.pending.set(taskId, run);
    run.finally(() => { if (this.pending.get(taskId) === run) this.pending.delete(taskId); }).catch(() => {});
    return run;
  }
  async flushOnce(taskId, { verify = false } = {}) {
    let root;
    try {
      let state = await this.store.read(), task = state.tasks.find(t => t.id === taskId);
      if (!task) throw new Error('任务不存在');
      const project = state.projects.find(p => p.id === task.projectId);
      root = await this.root(project, task);
      const dataDir = await directory(join(root, '返回数据')), reportsDir = await directory(join(root, '报告'));
      while ((task.outputItems || []).some(item => Object.hasOwn(item, 'payload'))) {
      for (const item of task.outputItems || []) if (Object.hasOwn(item, 'payload')) {
        const bytes = json({ connector: item.connector, operation: item.operation, source: item.source, payload: item.payload });
        const file = await immutable(join(dataDir, safeId(item.connector) + '-' + safeId(item.operation) + '-' + hash(bytes).slice(0, 16) + '.json'), bytes);
        await this.store.change(s => { const current = s.tasks.find(t => t.id === taskId).outputItems.find(i => i.id === item.id); Object.assign(current, file, { status: 'saved' }); delete current.payload; return null; }, { notify: false });
      }
      state = await this.store.read(); task = state.tasks.find(t => t.id === taskId);
      }
      for (const ref of task.outputReferences || []) if (ref.status === 'local') await localFile(project, ref.path, ref, verify);
      const references = task.outputReferences || [], pending = references.filter(r => r.status === 'remote-only' && r.required !== false);
      const summary = [
        '# ' + (task.summary ? '任务报告' : '阶段汇报'), '',
        '- 项目：' + project.name, '- 任务：' + task.id, '- 状态：' + (labels[task.status] || task.status),
        '- 项目目录：' + project.cwd, '- 成果目录：' + root, '',
        '## 交办要求', '', task.brief, '',
        ...(task.plan ? ['## 目标', '', task.plan.objective, '', '## 约束', '', ...task.plan.constraints.map(v => '- ' + v), ''] : []),
        ...task.reports.flatMap((r, index) => ['## 阶段 ' + (index + 1) + ' · ' + r.stageId, '', r.summary, '', '未完成：' + (r.remaining.join('；') || '无'), '', '证据（员工提供，待核实）：', ...r.evidence.map(v => '- ' + v), '']),
        ...((task.workOrders || []).length ? ['## 专员工作单与主管验收', '', ...task.workOrders.flatMap(order => [
          '### ' + order.title, '', '- 工作单：' + order.id, '- 当前版本：' + order.revision, '- 状态：' + order.state, '',
          ...order.attempts.flatMap(a => [
            `第 ${a.revision} 版 · 专员 ${a.workerSessionId}`, '', a.result?.summary || '尚无结构化结果', '',
            ...(a.verification?.checks || []).map(c => `- ${c.criterionId}：${c.passed ? '通过' : '未通过'}；${c.method}；证据：${c.evidence.join('；')}`),
            ...(a.verification?.feedback ? ['返工反馈：' + a.verification.feedback] : []), ''
          ])
        ])] : []),
        ...(task.summary ? ['## 交付摘要', '', task.summary, ''] : []),
        '## 本地返回数据', '', ...(task.outputItems || []).map(r => '- ' + r.connector + ' / ' + r.operation + '：' + (r.path || '尚未落盘')), '',
        '## 已确认落盘的本地文件', '', ...references.filter(r => r.status === 'local').map(r => '- ' + r.path + '\n  SHA-256: ' + r.sha256), '',
        '## 尚未取回的远端文件', '', ...references.filter(r => r.status === 'remote-only').map(r => '- ' + r.reference + (r.required !== false ? '（必交，未完成）' : '（参考）')), '',
        '返回 JSON 中的远端路径或下载链接，不等于文件已保存在本机。只有上方本地文件可以作为已取回附件；来源关联由员工登记，内容与远端的一致性仍需复核。', ''
      ].join('\n');
      const reportBytes = Buffer.from(summary), label = task.summary ? '最终报告' : '阶段汇报';
      const report = await immutable(join(reportsDir, label + '-' + hash(reportBytes).slice(0, 16) + '.md'), reportBytes);
      const representedTask = JSON.stringify(cleanTask(task));
      const snapshot = { project: { id: project.id, name: project.name, cwd: project.cwd }, task: cleanTask(task), events: state.events.filter(e => e.taskId === taskId) };
      const snapshotBytes = json(snapshot);
      const record = await immutable(join(root, '任务记录-' + hash(snapshotBytes).slice(0, 16) + '.json'), snapshotBytes);
      const index = { format: 'dsh-workbench-output-index/v1', taskId, projectId: project.id, updatedAt: now(), directory: root, report, record, returnedData: task.outputItems || [], files: references, pendingRequiredFiles: pending.length };
      await ownedIndex(join(root, 'manifest.json'), index);
      const localOutput = { status: 'saved', directory: root, reportPath: report.path, recordPath: record.path, manifestPath: join(root, 'manifest.json'), reportSha256: report.sha256, pendingRequiredFiles: pending.length, updatedAt: now() };
      await this.store.change(s => { const current = s.tasks.find(t => t.id === taskId); if (JSON.stringify(cleanTask(current)) !== representedTask) { localOutput.status = 'pending'; localOutput.error = '任务有新进展等待落盘，请重试保存'; } const stable = ({ updatedAt, ...rest }) => JSON.stringify(rest); if (current.localOutput && stable(current.localOutput) === stable(localOutput)) return null; current.localOutput = localOutput; return null; }, { notify: false });
      return localOutput;
    } catch (error) {
      const failure = { status: 'failed', ...(root ? { directory: root } : {}), error: '项目成果保存失败：' + error.message, updatedAt: now() };
      await this.store.change(s => { const t = s.tasks.find(t => t.id === taskId); if (t) t.localOutput = failure; return null; }, { notify: false });
      return failure;
    }
  }
  async ensureReady(taskId, options) {
    const result = await this.flush(taskId, options);
    if (result.status !== 'saved') throw new Error(result.error);
    return result;
  }
  async receive(taskId, connector, operation, payload, source) {
    safeId(connector); safeId(operation);
    const digest = hash(json({ connector, operation, source, payload }));
    const id = await this.store.change(s => { const t = s.tasks.find(t => t.id === taskId); t.outputItems ||= [];
      const existing = t.outputItems.find(i => i.digest === digest); if (existing) return existing.id;
      const id = randomUUID(); t.outputItems.push({ id, digest, connector, operation, receivedAt: now(), status: 'pending', payload, ...(source ? { source } : {}) }); return id; });
    const task = (await this.store.read()).tasks.find(t => t.id === taskId);
    return { item: task.outputItems.find(i => i.id === id), localOutput: task.localOutput };
  }
  async register(taskId, input) {
    const state = await this.store.read(), task = state.tasks.find(t => t.id === taskId), project = state.projects.find(p => p.id === task.projectId);
    if (!['local', 'remote'].includes(input.kind) || typeof input.location !== 'string' || !input.location.trim() || input.location.length > 4000) throw new Error('请选择本地文件或远端引用，并填写位置');
    const location = input.location.trim();
    const details = input.kind === 'local' ? await localFile(project, location) : null;
    if (details && (details.path === await realpath(this.store.file) || details.path === join(project.cwd, OUTPUT_FOLDER, task.id, 'manifest.json'))) throw new Error('不能将工作台状态或索引文件登记为交付文件');
    await this.store.change(s => {
      const t = s.tasks.find(t => t.id === taskId); t.outputReferences ||= [];
      const key = input.sourceReference || location;
      let item = t.outputReferences.find(r => r.reference === key || (details && r.path === details.path));
      if (!item) { item = { id: randomUUID(), reference: key }; t.outputReferences.push(item); }
      if (!details) for (const key of ['path', 'sha256', 'bytes', 'mtimeMs']) delete item[key];
      Object.assign(item, details || {}, { status: details ? 'local' : 'remote-only', required: input.required !== false, description: String(input.description || '').slice(0, 2000), recordedAt: now() });
      return item;
    });
    return { localOutput: (await this.store.read()).tasks.find(t => t.id === taskId).localOutput };
  }
}
