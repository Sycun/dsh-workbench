import test from 'node:test';
import assert from 'node:assert/strict';
import { KaliLink } from '../lib/kali.js';

test('Kali 登录只持久化令牌，界面返回值不含密码或令牌', async () => {
  const saved = new Map(), link = new KaliLink({}, { resolve: async key => saved.has(key) ? { value: saved.get(key) } : undefined, set: async (key, value) => saved.set(key, value) });
  link.call = async request => { assert.equal(request.path, '/api/auth/login'); return { status: 200, data: { token: 'test-session-token' } }; };
  const result = await link.login('artex', 'ARTEX', 'synthetic-test-password');
  assert.equal(saved.get('WORKBENCH_ARTEX_TOKEN'), 'test-session-token');
  assert.ok(!JSON.stringify(result).includes('synthetic-test-password')); assert.ok(!JSON.stringify(result).includes('test-session-token'));
});
test('连接中断与登录过期被明确报告，不重复启动 VM 或执行任务', async () => {
  const link = new KaliLink({}, { resolve: async () => ({ value: 'synthetic-token' }) });
  let calls = 0;
  link.call = async request => { calls++; assert.equal(request.operation, 'probe'); throw new Error('offline'); };
  assert.equal((await link.status()).vm, 'unavailable'); await link.status(); assert.equal(calls, 1);
  link.call = async () => ({ status: 401 });
  await assert.rejects(link.request('artex', '/api/version'), /过期/);
});
test('未登录不能派工；关闭后的连接不创建子进程', async () => {
  const link = new KaliLink({}, { resolve: async () => undefined });
  await assert.rejects(link.request('cyberstrikeai', '/api/projects'), /先在工作台登录/);
  link.close(); await assert.rejects(link.call({ operation: 'probe' }), /已关闭/);
});
