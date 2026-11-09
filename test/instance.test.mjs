/**
 * 单实例锁 / 状态文件 / 生命周期看门狗。
 *
 * 这些逻辑的价值全在"两个入口不会起两份服务"和"没人用会自己收"，单元测试必须覆盖：
 *   1) 状态文件的读写与坏数据兜底
 *   2) 进程探活（kill(pid,0) 的两种失败分支）
 *   3) findLive 要同时满足"进程活着 + 端口真的响应"才算可复用
 *   4) 看门狗：闲置到点退出、父进程消失后才开始计时、活着时永不退
 *   5) 端到端：同一个 state 目录起两次，第二次必须复用而不是抢端口
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appHome, defaultDataDir, statePath, readState, writeState, clearState,
  isPidAlive, probe, findLive, startWatchdog,
  lockPath, acquireInstanceLock, releaseInstanceLock, waitForState,
} from '../app/instance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'app', 'server.mjs');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-instance-'));
  return dir;
}

test('appHome 优先用 DSH_LOCAL_MEMORY_HOME；数据目录必须和插件一致（$DSH_HOME）', () => {
  const oldHome = process.env.DSH_LOCAL_MEMORY_HOME;
  const oldDsh = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(os.tmpdir(), 'lm-dsh-test');
    process.env.DSH_LOCAL_MEMORY_HOME = path.join(os.tmpdir(), 'lm-custom-home');
    assert.equal(appHome(), path.resolve(path.join(os.tmpdir(), 'lm-custom-home')));

    delete process.env.DSH_LOCAL_MEMORY_HOME;
    // 没设 DSH_LOCAL_MEMORY_HOME 时：状态在 $DSH_HOME/local-memory
    assert.equal(appHome(), path.join(process.env.DSH_HOME, 'local-memory'));
    // 数据就是 $DSH_HOME 本身 —— 插件的 defaultDbFile 也在这儿，两边共用同一个库
    assert.equal(defaultDataDir(), process.env.DSH_HOME);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_LOCAL_MEMORY_HOME;
    else process.env.DSH_LOCAL_MEMORY_HOME = oldHome;
    if (oldDsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldDsh;
  }
});

test('状态文件：写入→读回→清除', () => {
  const home = tmpHome();
  assert.equal(readState(home), null, '没写过就该是 null');
  writeState(home, { pid: 1234, port: 5678, host: '127.0.0.1', url: 'http://127.0.0.1:5678' });
  const st = readState(home);
  assert.equal(st.pid, 1234);
  assert.equal(st.port, 5678);
  assert.ok(fs.existsSync(statePath(home)));
  clearState(home);
  assert.equal(readState(home), null);
  clearState(home); // 再删一次不许抛
});

test('状态文件：坏 JSON / 缺字段一律当没有', () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(statePath(home), '{ 这不是 json');
  assert.equal(readState(home), null);
  fs.writeFileSync(statePath(home), JSON.stringify({ pid: 1 }));          // 缺 port
  assert.equal(readState(home), null);
  fs.writeFileSync(statePath(home), JSON.stringify({ port: 1 }));         // 缺 pid
  assert.equal(readState(home), null);
});

test('进程探活：自己活着，随便一个不存在的 pid 是死的', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(NaN), false);
  // Windows 上 999999 这种 pid 不会存在；返回 false 即可
  assert.equal(isPidAlive(999999), false);
});

test('probe：没人监听时返回 false，不抛也不卡', async () => {
  const t0 = Date.now();
  const ok = await probe(1, { timeoutMs: 800 });   // 1 号端口基本不可能有人监听
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 5000, '必须是快速失败，不能挂住');
});

test('probe：真的服务在监听时返回 true', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/dsh-local-memory/state' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    assert.equal(await probe(port), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('findLive：进程死了就不算活实例（哪怕状态文件还在）', async () => {
  const home = tmpHome();
  writeState(home, { pid: 999999, port: 7787, host: '127.0.0.1' });
  assert.equal(await findLive(home), null);
});

test('findLive：进程活着但端口没响应，也不算', async () => {
  const home = tmpHome();
  writeState(home, { pid: process.pid, port: 1, host: '127.0.0.1' });  // 1 号端口没人听
  assert.equal(await findLive(home, { timeoutMs: 500 }), null);
});

test('看门狗：闲置到点就退出', async () => {
  let exited = null;
  const wd = startWatchdog({ idleMs: 150, intervalMs: 40, onExit: async (why) => { exited = why; } });
  await new Promise((r) => setTimeout(r, 400));
  wd.stop();
  assert.equal(exited, 'idle');
});

test('看门狗：一直有请求就不退出', async () => {
  let exited = null;
  const wd = startWatchdog({ idleMs: 150, intervalMs: 40, onExit: async (why) => { exited = why; } });
  const tick = setInterval(() => wd.touch(), 60);   // 比 idle 更频繁地"有人用"
  await new Promise((r) => setTimeout(r, 450));
  clearInterval(tick);
  wd.stop();
  assert.equal(exited, null, 'UI 开着轮询时服务不许自己关掉');
});

test('看门狗：父进程还活着时，闲置再久也不退出', async () => {
  let exited = null;
  const wd = startWatchdog({ parentPid: process.pid, idleMs: 120, intervalMs: 40, onExit: async (why) => { exited = why; } });
  await new Promise((r) => setTimeout(r, 400));
  wd.stop();
  assert.equal(exited, null, 'DSH 还在跑，服务就该一直活着');
});

test('端到端：同一个 state 目录起第二次，必须复用而不是抢端口', async () => {
  const home = tmpHome();
  const data = path.join(home, 'data');
  const args = (port) => [
    SERVER, '--port', String(port), '--state', home, '--data', data,
    '--no-lock',   // 第一个用 no-lock 直接抢占，模拟"先起的那个"
  ];

  // 第一个：正常起，--no-lock 跳过检查
  const first = spawn(process.execPath, args(0), { stdio: ['ignore', 'pipe', 'pipe'] });
  const firstOut = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('第一个实例 15 秒没起来：' + buf)), 15000);
    first.stdout.on('data', (d) => {
      buf += d.toString();
      // ⚠ 必须等到"地址："那一行也到了才算起完。
      // "已启动"出现在地址之前，分两次 chunk 到达——只等第一行会拿到没有端口的半截输出。
      if (buf.includes('记忆软件已启动') && buf.includes('地址：')) { clearTimeout(timer); resolve(buf); }
    });
    first.stderr.on('data', (d) => { buf += d.toString(); });
  });
  const portMatch = /:(\d+)/.exec(firstOut.split('\n').find((l) => l.includes('地址：')) || '');
  const port = Number(portMatch && portMatch[1]);
  assert.ok(port >= 1, '第一个实例应该打印出端口，实际输出：' + firstOut);

  try {
    const st = readState(home);
    assert.equal(st.port, port, '状态文件里的端口要和实际一致');
    assert.equal(st.pid, first.pid);

    // 第二个：带锁检查（不加 --no-lock），应该立刻退出并提示复用
    const second = spawn(process.execPath, [SERVER, '--port', '0', '--state', home, '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    second.stdout.on('data', (d) => { buf += d.toString(); });
    second.stderr.on('data', (d) => { buf += d.toString(); });
    const code = await new Promise((r) => second.on('exit', r));
    assert.equal(code, 0, '复用路径应该正常退出，输出：' + buf);
    assert.match(buf, /复用/);
    assert.ok(buf.includes(String(port)), '要告诉用户已有实例的端口，输出：' + buf);
  } finally {
    first.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { first.kill('SIGKILL'); } catch { /* 已经没了 */ }
  }
});

/* ───────────────────── 原子实例锁 ─────────────────────
 * 背景：以前的单实例判断靠 instance.json，但那个文件要等 listen 之后才写，
 * 于是两个几乎同时的启动会都认为"没人跑"→ 起两份（快速双击可复现）。
 * 现在改成启动前先用 open('wx') 原子抢锁，下面覆盖它的几条关键语义。 */

test('抢锁：第一个成功，第二个（同一进程）可以接管自己那份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lock-'));
  const first = acquireInstanceLock(dir);
  assert.equal(first.ok, true);
  assert.equal(first.tookOver, false);
  assert.ok(fs.existsSync(lockPath(dir)));

  // 同一个进程再抢一次：pid 相同，允许（否则自己都没法重启）
  const again = acquireInstanceLock(dir);
  assert.equal(again.ok, true);

  releaseInstanceLock(dir);
  assert.equal(fs.existsSync(lockPath(dir)), false, '释放后锁文件应该没了');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('抢锁：持锁进程还活着时，别人抢不到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lock2-'));
  // 用当前进程的 PID 之外的一个真实活进程
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: child.pid, at: Date.now() }));

    const got = acquireInstanceLock(dir);
    assert.equal(got.ok, false, '活着的持有者不该被抢');
    assert.equal(got.holder.pid, child.pid);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('抢锁：持锁进程已死时允许接管（否则崩一次就再也起不来）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lock3-'));
  // 999999 基本不可能是一个活着的进程
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, at: Date.now() }));

  const got = acquireInstanceLock(dir);
  assert.equal(got.ok, true);
  assert.equal(got.tookOver, true, '应该标记为接管');
  assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid, process.pid);

  releaseInstanceLock(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('释放锁：不删别人的锁', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-lock4-'));
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999999, at: Date.now() }));
  const removed = releaseInstanceLock(dir);
  assert.equal(removed, false);
  assert.ok(fs.existsSync(lockPath(dir)), '别人的锁不许动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('waitForState：没有实例时超时返回 null，有实例时返回状态', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-wait-'));
  const none = await waitForState(dir, { timeoutMs: 300, intervalMs: 50 });
  assert.equal(none, null);

  // 写一个"活着的自己"的状态文件
  writeState(dir, { pid: process.pid, port: 65535, host: '127.0.0.1' });
  const st = await waitForState(dir, { timeoutMs: 1000, intervalMs: 50 });
  assert.ok(st && st.port === 65535);

  clearState(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});