import { assertTaskActive } from './lifecycle-state.js';
import { required } from './core.js';
import { assignment } from './prompts.js';

function messageTarget(task, messageId) {
  if (messageId === task.requestId) return { owner: task, countKey: 'initialImageCount', idsKey: 'initialImageIds', deliveredKey: 'initialDelivered' };
  const message = task.messages?.find(m => m.id === messageId);
  if (message) return { owner: message, countKey: 'imageCount', idsKey: 'imageIds', deliveredKey: 'delivered' };
  const question = task.questions.find(q => q.deliveryId === messageId);
  if (question) return { owner: question, countKey: 'imageCount', idsKey: 'imageIds', deliveredKey: 'delivered' };
  throw new Error('图片必须属于本任务的交办、补充消息或答复');
}

export class InputImages {
  constructor(wb, host) { this.wb = wb; this.host = host; }
  limits() { return this.host.attachments?.imageLimits || null; }
  async attach({ taskId, messageId, draftId, receiptId }) {
    required(draftId, '图片草稿标识', 100); required(receiptId, '图片上传凭证', 300);
    const state = await this.wb.snapshot(), task = state.tasks.find(t => t.id === taskId);
    if (!task?.sessionId) throw new Error('请先创建任务会话');
    assertTaskActive(task);
    if (!['draft', 'running', 'waiting'].includes(task.status)) throw new Error('当前任务不能接收新图片');
    const target = messageTarget(task, messageId);
    const existing = task.images?.find(i => i.id === draftId && i.messageId === messageId);
    if (existing) return existing;
    if (target.owner[target.deliveredKey]) throw new Error('该消息已经发送，不能追加图片');
    const resolved = await this.host.sessions.agents.resolveAgent(task.sessionId);
    if (resolved.error) throw resolved.error;
    const staged = this.host.fileUploads.resolve(resolved.agent, receiptId);
    if (!staged || staged.type !== 'image') throw new Error('图片上传凭证无效或不属于当前会话，请重新添加图片');
    const stored = await this.host.attachments.readImage(staged.attachment);
    return this.wb.outputs.saveInputImage(taskId, { id: draftId, messageId, ref: stored.ref }, stored.data);
  }
  async send({ taskId, messageId, images }) {
    const state = await this.wb.snapshot(), task = state.tasks.find(t => t.id === taskId);
    if (!task?.sessionId) throw new Error('任务会话不存在');
    assertTaskActive(task);
    const target = messageTarget(task, messageId);
    if (target.owner[target.deliveredKey]) return { accepted: true, duplicate: true };
    if (!['draft', 'running', 'waiting'].includes(task.status)) throw new Error('当前任务不能发送消息');
    const project = state.projects.find(p => p.id === task.projectId);
    if (project.lifecycle && project.lifecycle !== 'active') throw new Error('请先恢复所属项目');
    if (messageId === task.requestId && task.status === 'draft' && !task.runtimeApplied) throw new Error('请先应用任务模型配置');
    const wanted = images || (target.owner[target.idsKey] || []).map(id => ({ id }));
    const count = target.owner[target.countKey] || 0, limits = this.limits();
    if (!count || !Array.isArray(wanted) || wanted.length !== count || new Set(wanted.map(i => i.id)).size !== count) throw new Error(`本条消息需要 ${count} 张图片，请重新添加完整图片后重试`);
    if (limits && count > limits.maxImagesPerMessage) throw new Error('图片数量超过 DSH 限制');
    const resolved = await this.host.sessions.agents.resolveAgent(task.sessionId);
    if (resolved.error) throw resolved.error;
    const content = [], selected = [];
    for (const item of wanted) {
      const image = task.images?.find(i => i.id === item.id && i.messageId === messageId);
      if (!image) throw new Error('图片尚未保存完整，请重新添加并上传');
      await this.wb.outputs.inspect(taskId, image.path, image);
      const receipt = item.receiptId && this.host.fileUploads.resolve(resolved.agent, item.receiptId);
      if (receipt?.type === 'image' && receipt.attachment.attachmentId === image.ref.attachmentId) content.push({ type: 'file', receiptId: item.receiptId });
      else {
        const stored = await this.host.attachments.readImage(image.ref);
        content.push({ type: 'image', mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64'), ...(stored.ref.name ? { name: stored.ref.name } : {}) });
      }
      selected.push(image);
    }
    await this.wb.store.change(s => {
      const t = s.tasks.find(t => t.id === taskId); assertTaskActive(t);
      const live = messageTarget(t, messageId); if (live.owner[live.deliveredKey]) return null;
      live.owner[live.idsKey] = selected.map(i => i.id); return null;
    });
    const output = await this.wb.outputs.ensureReady(taskId);
    const text = messageId === task.requestId ? assignment({ ...task, localOutput: output }, project) : target.owner.text || `老板已回答工作台决策 ${target.owner.id}：${target.owner.answer}\n请读取 workbench_get 最新状态并继续。`;
    content.push({ type: 'text', text: text + '\n本条消息的图片已保存到当前 Mac 项目：\n' + selected.map(i => i.path).join('\n') });
    await this.host.sessions.prompt({ sessionId: task.sessionId, requestId: messageId, mode: 'queue', content }, AbortSignal.timeout(15000));
    if (messageId === task.requestId) await this.wb.store.change(s => { s.tasks.find(t => t.id === taskId).initialDelivered = true; return null; });
    else if (task.messages?.some(m => m.id === messageId)) await this.wb.messageDelivered(taskId, messageId);
    else await this.wb.delivered(taskId, target.owner.id);
    return { accepted: true };
  }
}
