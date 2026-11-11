import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/core.js';
test('异常退出留下的死进程锁可恢复，活进程仍拒绝第二写入者', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', '']); const pid = child.pid; await once(child, 'exit');
  const file = join(dir, 'state.json'); await mkdir(file + '.lock'); await writeFile(file + '.lock/owner.json', JSON.stringify({ pid }));
  const store = await new Store(file).open(); t.after(() => store.close());
  assert.ok((await readdir(dir)).some(name => name.startsWith('state.json.stale-lock-')));
  await assert.rejects(new Store(file).open()); await store.change(s => { s.projects.push({ id: 'p' }); return null; });
  assert.equal((await store.read()).projects[0].id, 'p');
});
