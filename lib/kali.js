import { spawn } from 'node:child_process';

const names = ['artex', 'cyberstrikeai'];
export class KaliLink {
  constructor(config, credentials) { this.config = config; this.credentials = credentials; this.tail = Promise.resolve(); this.cache = null; this.checkedAt = 0; this.checking = null; this.children = new Set(); this.closed = false; }
  close() { this.closed = true; for (const child of this.children) child.kill('SIGTERM'); }
  key(kind) { if (!names.includes(kind)) throw new Error('未知平台'); return `WORKBENCH_${kind.toUpperCase()}_TOKEN`; }
  async token(kind) { return (await this.credentials.resolve(this.key(kind)))?.value; }
  call(payload) {
    // Queue guest RPCs; never invoke prlctl start, shell interpolation or arbitrary commands.
    const run = this.tail.then(() => new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Kali 连接已关闭')); return; }
      if (!this.config.vm || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(this.config.guestUser || '') || !/^\/[A-Za-z0-9_./-]+$/.test(this.config.guestBridge || '') || (this.config.guestPython && !/^\/[A-Za-z0-9_./-]+$/.test(this.config.guestPython))) { reject(new Error('请配置虚拟机名称、guestUser 和 guestBridge')); return; }
      const child = spawn(this.config.prlctl || '/usr/local/bin/prlctl', ['exec', this.config.vm, '/usr/sbin/runuser', '-u', this.config.guestUser, '--', this.config.guestPython || '/usr/bin/python3', this.config.guestBridge], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child); child.once('close', () => this.children.delete(child));
      let output = '', size = 0, settled = false;
      const done = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
      const timer = setTimeout(() => { child.kill('SIGTERM'); done(new Error('Kali 通道超时；请检查虚拟机和 Parallels Tools')); }, 30000);
      child.on('error', () => done(new Error('Parallels 通道不可用')));
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 3 * 1024 * 1024) { child.kill(); done(new Error('Kali 响应过大')); } else output += chunk.toString(); });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('close', code => { if (code !== 0) return done(new Error('Kali 未运行、服务不可用或桥接程序尚未安装')); try { const value = JSON.parse(output); value.error ? done(new Error(value.error)) : done(null, value); } catch { done(new Error('Kali 桥接响应无效')); } });
      child.stdin.end(JSON.stringify(payload));
    }));
    this.tail = run.catch(() => {}); return run;
  }
  async status(force = false) {
    if (this.checking) return this.checking;
    if (!force && this.cache && Date.now() - this.checkedAt < 15000) return this.cache;
    this.checking = (async () => {
      try {
        const tokens = Object.fromEntries(await Promise.all(names.map(async kind => [kind, await this.token(kind)])));
        this.cache = await this.call({ operation: 'probe', tokens });
      } catch (error) { this.cache = { vm: 'unavailable', error: error.message, platforms: [] }; }
      this.checkedAt = Date.now(); return { ...this.cache, checkedAt: new Date(this.checkedAt).toISOString() };
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
  async request(kind, path, body, key) {
    const token = await this.token(kind);
    if (!token) throw new Error('平台已发现，请先在工作台登录');
    const result = await this.call({ operation: 'request', connector: kind, path, token, ...(body === undefined ? {} : { body }), ...(key ? { key } : {}) });
    if (result.status === 401 || result.status === 403) throw new Error('平台登录已过期或权限不足，请在工作台重新登录');
    if (result.status < 200 || result.status >= 300) throw new Error(`平台 HTTP ${result.status}`);
    return result.data;
  }
  async login(kind, username, password) {
    this.key(kind);
    if (!password || typeof password !== 'string' || password.length > 4096) throw new Error('请输入现有账号密码');
    const response = await this.call({ operation: 'request', connector: kind, path: '/api/auth/login', body: { username: username || (kind === 'artex' ? 'ARTEX' : 'admin'), password } });
    if (response.status !== 200 || !response.data?.token) throw new Error(`登录失败（HTTP ${response.status}），请检查现有账号`);
    await this.credentials.set(this.key(kind), response.data.token);
    this.checkedAt = 0;
    return { authenticated: true, message: '已连接；登录令牌保存在 DSH 凭据存储，密码未保存。' };
  }
}
