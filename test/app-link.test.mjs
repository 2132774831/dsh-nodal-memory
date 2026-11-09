/**
 * 插件侧把独立应用拉起来这条链路。
 *
 * 这是"双击快捷方式 / 插件自动拉起"两个入口收敛成**一个实例**的核心，
 * 所以必须用真实进程验证，不能只靠 mock：
 *   1) 没有任何实例时，ensureAppRunning 能拉起来并返回地址
 *   2) 再调一次必须复用（reused: true），不能再起第二个
 *   3) 状态文件里记的 pid / 端口和实际一致
 *   4) 拉起来的服务监听在 127.0.0.1，且数据目录 = $DSH_HOME（和插件同一个库）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAppRunning, appServerAvailable, APP_SERVER_PATH } from '../src/host/app-link.js';
import { readState, clearState, isPidAlive } from '../app/instance.mjs';

test('app/server.mjs 存在（插件要拉的就是它）', () => {
  assert.equal(appServerAvailable(), true, '找不到 ' + APP_SERVER_PATH);
  assert.ok(fs.existsSync(APP_SERVER_PATH));
});

test('ensureAppRunning：拉起 → 复用 → 状态一致', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-link-'));
  const oldDsh = process.env.DSH_HOME;
  const oldHome = process.env.DSH_LOCAL_MEMORY_HOME;
  process.env.DSH_HOME = home;                 // 数据目录 = $DSH_HOME
  process.env.DSH_LOCAL_MEMORY_HOME = path.join(home, 'local-memory');  // 状态目录
  clearState();

  let firstPid = 0;
  try {
    const t0 = Date.now();
    const a = await ensureAppRunning({ timeoutMs: 20000, pollMs: 150 });
    const costMs = Date.now() - t0;
    assert.equal(a.ok, true, '应该拉起来：' + JSON.stringify(a));
    assert.equal(a.reused, false, '第一次必须是新起的');
    assert.ok(a.port >= 1);
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const st = readState();
    assert.ok(st, '必须写下状态文件，插件才能找到它');
    assert.equal(st.port, a.port);
    assert.equal(st.pid, st.pid | 0);
    assert.equal(st.parentPid, process.pid, '要把自己记成父进程，DSH 退出后应用才知道该收');
    assert.equal(path.resolve(st.dataDir), path.resolve(home), '数据目录必须是 $DSH_HOME（和插件共用同一个库）');
    firstPid = st.pid;
    assert.equal(isPidAlive(firstPid), true);

    // 第二次：必须复用
    const b = await ensureAppRunning({ timeoutMs: 5000, pollMs: 100 });
    assert.equal(b.ok, true);
    assert.equal(b.reused, true, '已有实例时必须复用，不能起第二个');
    assert.equal(b.port, a.port);
    assert.equal(readState().pid, firstPid, 'pid 不能变');

    // 服务真的能响应
    const res = await fetch(a.url + '/dsh-local-memory/state');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.stats.total === 'number');

    // 首次启动耗时要合理（不能秒回也不可能无限等）
    assert.ok(costMs < 20000, '启动耗时 ' + costMs + 'ms');
  } finally {
    if (firstPid && isPidAlive(firstPid)) {
      try { process.kill(firstPid); } catch { /* 已经没了 */ }
      await new Promise((r) => setTimeout(r, 400));
      try { process.kill(firstPid, 'SIGKILL'); } catch { /* 忽略 */ }
    }
    clearState();
    if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh;
    if (oldHome === undefined) delete process.env.DSH_LOCAL_MEMORY_HOME; else process.env.DSH_LOCAL_MEMORY_HOME = oldHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
