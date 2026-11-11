const reserved = new Set(['constructor', 'prototype', '__proto__']);
export function connectionId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value) || reserved.has(value)) throw new Error('连接 ID 需使用小写字母、数字、下划线或连字符，且以字母开头');
  return value;
}
export function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写完整的 HTTP(S) 服务地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('服务地址只填写 origin，不含路径、查询参数或凭据');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远端请使用 HTTPS，或通过隧道连接本机回环地址');
  return url.origin;
}
const variables = new Set(['projectId', 'taskId', 'message', 'idempotencyKey', 'runId']);
export function endpoint(value, optional = false) {
  if (optional && !value) return '';
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\#\r\n]/.test(value) || value.length > 2000) throw new Error('接口路径须以单个 / 开头，不含主机名、片段或换行');
  for (const [, key] of value.matchAll(/\{([^{}]+)\}/g)) if (!['projectId', 'taskId', 'runId'].includes(key)) throw new Error('接口路径仅支持 {projectId}、{taskId}、{runId}');
  return value;
}
export function expandPath(path, values) {
  return endpoint(path).replace(/\{([^{}]+)\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) throw new Error(`缺少接口变量 ${key}`);
    return encodeURIComponent(String(values[key]));
  });
}
export function expandBody(value, values, depth = 0) {
  if (depth > 16) throw new Error('请求模板嵌套过深');
  if (typeof value === 'string') return value.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!variables.has(key)) throw new Error(`未知请求模板变量 ${key}`);
    if (values[key] === undefined) throw new Error(`缺少请求模板变量 ${key}`);
    return String(values[key]);
  });
  if (Array.isArray(value)) return value.map(item => expandBody(item, values, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (reserved.has(key)) throw new Error('请求模板包含保留字段');
    return [key, expandBody(item, values, depth + 1)];
  }));
  return value;
}
export function normalizeConnection(input) {
  const allowed = new Set(['id', 'label', 'adapter', 'baseUrl', 'enabled', 'authType', 'tokenRef', 'healthPath', 'statusPath', 'submitPath', 'bodyTemplate', 'runStatusPath', 'runIdField', 'transport']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('连接配置必须为对象');
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`不支持的连接字段 ${key}；令牌需通过单独的凭据入口保存`);
  if (input.transport !== undefined && input.transport !== 'http') throw new Error('自定义连接仅支持 HTTP 通道，不能改写宿主 Kali 通道');
  const id = connectionId(input.id), adapter = input.adapter || 'http-json';
  if (!['http-json', 'artex', 'cyberstrikeai'].includes(adapter)) throw new Error('不支持的适配器');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : id;
  if (label.length > 100 || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('连接名称或启用状态无效');
  const authType = input.authType || 'none', tokenRef = input.tokenRef || '';
  if (!['none', 'bearer'].includes(authType) || (authType === 'bearer' && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenRef))) throw new Error('Bearer 认证需填写凭据引用名，例如 MY_TOOL_TOKEN');
  const connection = { id, label, adapter, baseUrl: origin(input.baseUrl), transport: 'http', enabled: input.enabled !== false, authType, tokenRef: authType === 'bearer' ? tokenRef : '', healthPath: endpoint(input.healthPath, true) };
  if (connection.healthPath.includes('{')) throw new Error('连接测试路径不能依赖项目或任务变量');
  if (adapter === 'http-json') {
    const bodyTemplate = input.bodyTemplate ?? { projectId: '{projectId}', taskId: '{taskId}', message: '{message}', idempotencyKey: '{idempotencyKey}' };
    if (!bodyTemplate || typeof bodyTemplate !== 'object' || Array.isArray(bodyTemplate) || JSON.stringify(bodyTemplate).length > 16000) throw new Error('请求模板应是小于 16 KiB 的 JSON 对象');
    expandBody(bodyTemplate, Object.fromEntries([...variables].map(key => [key, 'example'])));
    const runIdField = input.runIdField || 'runId';
    if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){0,5}$/.test(runIdField) || runIdField.split('.').some(key => reserved.has(key))) throw new Error('回执 ID 字段无效');
    Object.assign(connection, { statusPath: endpoint(input.statusPath), submitPath: endpoint(input.submitPath), bodyTemplate, runStatusPath: endpoint(input.runStatusPath, true), runIdField });
  }
  return connection;
}
export function readField(value, path) {
  for (const key of path.split('.')) { if (!value || !Object.hasOwn(value, key)) return undefined; value = value[key]; }
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
