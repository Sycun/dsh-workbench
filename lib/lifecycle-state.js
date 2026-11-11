export const taskActive = task => !task.lifecycle || task.lifecycle === 'active';
export function taskCollection(task, project) {
  if (task.lifecycle === 'deleted' || project?.lifecycle === 'deleted') return 'deleted';
  if (task.lifecycle === 'archived' || project?.lifecycle === 'archived') return 'archived';
  return 'active';
}
export function assertTaskActive(task) {
  if (!taskActive(task)) throw new Error('任务已归档、移入回收站或正在同步，请先恢复任务');
}

export const decisionPending = question => !question.answer || Boolean(question.imageCount && !question.delivered);
