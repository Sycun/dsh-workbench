import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Workbench } from '../lib/core.js';
import { InputImages } from '../lib/input-images.js';
import { transferImages, validateImages, stageDraftImages } from '../lib/image-drafts.js';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF0cAAAAASUVORK5CYII=', 'base64');
async function fixture(t, count = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-image-')), store = await new Store(join(dir, 'state.json')).open(), wb = new Workbench(store);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const p = await wb.project({ cwd: dir }), task = await wb.create({ projectId: p.id, brief: '查看所附图片', imageCount: count }); await wb.bind(task.id, 'agent-1');
  await store.change(s => { s.tasks[0].runtimeApplied = { sessionId: 'agent-1' }; return null; });
  const ref = { attachmentId: 'native-image', mediaType: 'image/png', width: 1, height: 1, bytes: PNG.length, name: '截图.png' }, prompts = [], receipts = new Map([['owned', { type: 'image', attachment: ref }]]);
  const host = { attachments: { imageLimits: { maxImagesPerMessage: 8 }, readImage: async value => ({ ref: value, data: PNG }) }, fileUploads: { resolve: (agent, id) => agent.id === 'agent-1' ? receipts.get(id) : undefined }, sessions: { agents: { resolveAgent: async id => ({ agent: { id } }) }, prompt: async request => { prompts.push(request); return { accepted: true }; } } };
  const images = new InputImages(wb, host); return { dir, project: p, store, wb, task, images, host, receipts, ref, prompts };
}
test('粘贴图片进入独立附件路径，普通文本粘贴不被截获', () => {
  const png = { type: 'image/png', size: 100 }, text = { kind: 'string', type: 'text/plain' };
  assert.deepEqual(transferImages({ items: [text] }), []);
  assert.deepEqual(transferImages({ items: [{ kind: 'file', type: png.type, getAsFile: () => png }], files: [png] }), [png]);
  assert.deepEqual(transferImages({ items: [{ kind: 'file', type: '', getAsFile: () => png }] }), [png]);
  assert.deepEqual(transferImages({ files: [png] }), [png]);
  assert.throws(() => validateImages([{ type: 'image/svg+xml', size: 50 }]), /格式/);
  assert.throws(() => validateImages([png, png], { maxImagesPerMessage: 1 }), /最多/);
  assert.throws(() => validateImages([png], { maxImageBytes: 50 }), /大小/);
});
test('上传或登记失败保留草稿，同会话重试复用上传凭证，切换会话重新上传', async () => {
  const drafts = [{ id: 'draft', file: { type: 'image/png', size: 100 } }], status = []; let uploads = 0, fail = true;
  const upload = async () => ({ receiptId: 'receipt-' + ++uploads });
  const register = async id => { if (fail) throw new Error('保存失败'); return { id }; };
  await assert.rejects(stageDraftImages(drafts, 'session-a', upload, register, (...args) => status.push(args)), /保存失败/);
  fail = false; const result = await stageDraftImages(drafts, 'session-a', upload, register); assert.equal(uploads, 1); assert.equal(result[0].receiptId, 'receipt-1'); assert.equal(drafts.length, 1); assert.equal(status.at(-1)[1], 'error');
  await stageDraftImages(drafts, 'session-b', upload, register); assert.equal(uploads, 2);
});
test('图片以原生附件随消息发送，规范化图片归档到 Mac 项目，重复发送不重复派工', async t => {
  const f = await fixture(t), image = await f.images.attach({ taskId: f.task.id, messageId: f.task.requestId, draftId: 'draft-1', receiptId: 'owned' });
  assert.ok(image.path.startsWith(f.project.cwd + '/工作台产出/')); assert.ok(image.path.includes('/输入图片/')); assert.deepEqual(await readFile(image.path), PNG);
  await f.images.send({ taskId: f.task.id, messageId: f.task.requestId, images: [{ id: image.id, receiptId: 'owned' }] });
  assert.deepEqual(f.prompts[0].content[0], { type: 'file', receiptId: 'owned' }); assert.ok(f.prompts[0].content.at(-1).text.includes(image.path));
  await f.images.send({ taskId: f.task.id, messageId: f.task.requestId }); assert.equal(f.prompts.length, 1);
  assert.ok(!(await readFile(f.store.file, 'utf8')).includes(PNG.toString('base64')));
  const task = (await f.wb.snapshot()).tasks[0]; assert.equal(task.initialDelivered, true); assert.deepEqual(task.initialImageIds, ['draft-1']);
});
test('图片不齐不能静默发送；拒绝其他会话、普通文件和伪造消息凭证', async t => {
  const f = await fixture(t, 2);
  const image = await f.images.attach({ taskId: f.task.id, messageId: f.task.requestId, draftId: 'one', receiptId: 'owned' });
  await assert.rejects(f.images.send({ taskId: f.task.id, messageId: f.task.requestId, images: [{ id: image.id }] }), /需要 2 张/);
  await assert.rejects(f.images.attach({ taskId: f.task.id, messageId: f.task.requestId, draftId: 'two', receiptId: 'foreign' }), /凭证/);
  f.receipts.set('file', { type: 'file', attachment: {} }); await assert.rejects(f.images.attach({ taskId: f.task.id, messageId: f.task.requestId, draftId: 'two', receiptId: 'file' }), /凭证/);
  await assert.rejects(f.images.attach({ taskId: f.task.id, messageId: 'other-message', draftId: 'two', receiptId: 'owned' }), /属于本任务/); assert.equal(f.prompts.length, 0);
});
test('发送失败后可从已保存图片恢复，使用同一请求 ID；已归档任务不能发送', async t => {
  const f = await fixture(t), image = await f.images.attach({ taskId: f.task.id, messageId: f.task.requestId, draftId: 'one', receiptId: 'owned' });
  f.host.sessions.prompt = async request => { f.prompts.push(request); throw new Error('临时失败'); };
  await assert.rejects(f.images.send({ taskId: f.task.id, messageId: f.task.requestId, images: [{ id: image.id, receiptId: 'owned' }] }), /临时失败/);
  f.receipts.clear(); f.host.sessions.prompt = async request => { f.prompts.push(request); return { accepted: true }; };
  await f.images.send({ taskId: f.task.id, messageId: f.task.requestId });
  assert.equal(f.prompts[1].requestId, f.prompts[0].requestId); assert.equal(f.prompts[1].content[0].type, 'image'); assert.equal(f.prompts[1].content[0].data, PNG.toString('base64'));
  await f.store.change(s => { s.tasks[0].lifecycle = 'archived'; return null; });
  await assert.rejects(f.images.send({ taskId: f.task.id, messageId: f.task.requestId }), /任务已归档/);
});
test('补充消息和决策答复图片归属正确，发送后更新各自回执', async t => {
  const f = await fixture(t, 0); await f.wb.plan(f.task.id, { objective: '读图', stages: [{ title: '检查', acceptance: '有结果' }] });
  const message = await f.wb.message(f.task.id, '补充截图', 1);
  let image = await f.images.attach({ taskId: f.task.id, messageId: message.id, draftId: 'm-image', receiptId: 'owned' });
  await f.images.send({ taskId: f.task.id, messageId: message.id, images: [{ id: image.id, receiptId: 'owned' }] });
  const question = await f.wb.question(f.task.id, { question: '哪一张？', reason: '需要定位', recommendation: '提供截图', options: [] });
  const answer = await f.wb.answer(f.task.id, question.id, '用这张图', 1);
  await assert.rejects(f.wb.checkpoint(f.task.id, { stageId: 's1', summary: '不能提前继续', remaining: [], evidence: [], done: false }), /等待老板决策/);
  image = await f.images.attach({ taskId: f.task.id, messageId: answer.deliveryId, draftId: 'q-image', receiptId: 'owned' });
  await f.images.send({ taskId: f.task.id, messageId: answer.deliveryId, images: [{ id: image.id, receiptId: 'owned' }] });
  const saved = (await f.wb.snapshot()).tasks[0]; assert.equal(saved.messages[0].delivered, true); assert.equal(saved.questions[0].delivered, true); assert.ok(f.prompts[1].content.at(-1).text.includes('用这张图'));
});
