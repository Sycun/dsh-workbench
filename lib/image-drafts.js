export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export function transferImages(transfer) {
  if (!transfer) return [];
  const items = Array.from(transfer.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(file => file?.type?.startsWith('image/'));
  return items.length ? items : Array.from(transfer.files || []).filter(file => file.type.startsWith('image/'));
}
export function validateImages(files, limits = {}) {
  const types = limits.mediaTypes || IMAGE_TYPES, count = limits.maxImagesPerMessage || 8;
  if (files.length > count) throw new Error(`每条消息最多添加 ${count} 张图片`);
  let bytes = 0;
  for (const file of files) {
    if (!types.includes(file.type)) throw new Error('此图片格式暂不支持，请使用 PNG、JPEG、WebP 或 GIF');
    if (!file.size || file.size > (limits.maxImageBytes || 20 * 1024 * 1024)) throw new Error('图片为空或超过 DSH 单张图片大小限制');
    bytes += file.size;
  }
  if (bytes > (limits.maxMessageImageBytes || 40 * 1024 * 1024)) throw new Error('本条消息的图片总大小超过 DSH 限制');
  return files;
}

/** Retains each receipt until admission; successful uploads are reused on a same-session retry. */
export async function stageDraftImages(drafts, sessionId, upload, register, onState = () => {}) {
  const results = [];
  for (const draft of drafts) {
    onState(draft.id, 'uploading');
    try {
      if (draft.sessionId !== sessionId || !draft.upload) {
        draft.upload = await upload(draft.file); draft.sessionId = sessionId;
      }
      const saved = await register(draft.id, draft.upload.receiptId);
      results.push({ receiptId: draft.upload.receiptId, image: saved }); onState(draft.id, 'ready');
    } catch (error) { onState(draft.id, 'error', error.message); throw error; }
  }
  return results;
}
