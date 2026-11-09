/**
 * 独立软件（app/）的服务器测试：真起一个 HTTP 服务，真打接口。
 *
 * 重点：
 *   - 数据目录被钉死在临时目录里（`DSH_HOME` 在 startServer 里被改写），
 *     所以这组测试**绝不会**碰到 ~/.dsh 里的真实记忆库
 *   - 静态资源与路径穿越防护
 *   - 界面用到的每个接口都能用
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startServer } = await import('../app/server.mjs');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-app-'));
const app = await startServer({ port: 0, data: dataDir });
const base = app.url;

test.after(async () => {
  await app.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/* ── 静态资源 ── */

test('首页返回 HTML，且引用了 app.js 与 styles.css', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /app\.js/);
  assert.match(html, /styles\.css/);
});

test('界面静态文件可访问', async () => {
  for (const [file, mime] of [['/app.js', /javascript/], ['/styles.css', /text\/css/]]) {
    const res = await fetch(base + file);
    assert.equal(res.status, 200, file + ' 应可访问');
    assert.match(res.headers.get('content-type'), mime);
  }
});

test('关系图布局算法以 ESM 形式暴露给浏览器（同一个文件，不是复制品）', async () => {
  const res = await fetch(base + '/core/graph-layout.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const src = await res.text();
  assert.match(src, /export function createLayout/);
  assert.match(src, /export function stepLayout/);
});

test('路径穿越被拒绝（../ 拿不到仓库里的其他文件）', async () => {
  const res = await fetch(base + '/core/../../package.json');
  assert.ok(res.status === 404 || res.status === 403, '不应返回 200，实际 ' + res.status);
});

test('/core/ 只暴露 js（不给读任意文件类型）', async () => {
  const res = await fetch(base + '/core/../ui/index.html');
  assert.ok(res.status === 403 || res.status === 404);
});

/* ── 数据接口 ── */

test('GET /state 返回统计，且数据目录是临时目录（没碰真实库）', async () => {
  const res = await fetch(base + '/dsh-local-memory/state');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.stats.total, 0, '空库起步');
  assert.equal(process.env.DSH_HOME, dataDir, 'DSH_HOME 应被钉在临时目录');
});

test('新增 → 检索 → 软删 → 恢复 闭环', async () => {
  const created = await (await fetch(base + '/dsh-local-memory/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '独立版测试：主人喜欢喝美式咖啡', tags: ['test'], kind: 'preference' }),
  })).json();
  assert.equal(created.ok, true);
  const id = created.id;

  const found = await (await fetch(base + '/dsh-local-memory/memories?q=咖啡')).json();
  assert.equal(found.matched, 1, '中文两字词应能命中');
  assert.match(found.memories[0].content, /美式咖啡/);

  const del = await (await fetch(base + '/dsh-local-memory/memories/' + id, { method: 'DELETE' })).json();
  assert.equal(del.softDeleted, true);
  const afterDel = await (await fetch(base + '/dsh-local-memory/memories')).json();
  assert.equal(afterDel.memories.length, 0);

  const back = await (await fetch(base + '/dsh-local-memory/memories/' + id + '/restore', { method: 'POST' })).json();
  assert.equal(back.ok, true);
  const afterRestore = await (await fetch(base + '/dsh-local-memory/memories')).json();
  assert.equal(afterRestore.memories.length, 1);
});

test('GET /graph 返回点与边（界面直接拿来画）', async () => {
  const res = await fetch(base + '/dsh-local-memory/graph');
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(json.nodes));
  assert.ok(Array.isArray(json.edges));
  assert.ok(json.stats);
});

test('GET /memories?kind=unknown 用于补标队列', async () => {
  await fetch(base + '/dsh-local-memory/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '这条还没分类' }),
  });
  const json = await (await fetch(base + '/dsh-local-memory/memories?kind=unknown')).json();
  assert.equal(json.memories.length, 1);
  assert.match(json.memories[0].content, /还没分类/);
});

test('POST /maintenance 可用', async () => {
  const json = await (await fetch(base + '/dsh-local-memory/maintenance', { method: 'POST' })).json();
  assert.equal(json.ok, true);
  assert.equal(json.result.ran, true);
});

test('GET /export 返回 Markdown 且带文件名', async () => {
  const res = await fetch(base + '/dsh-local-memory/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /markdown/);
  assert.match(res.headers.get('content-disposition') || '', /dsh-local-memory\.md/);
});

test('未知接口 404，不是 500', async () => {
  const res = await fetch(base + '/dsh-local-memory/nope');
  assert.equal(res.status, 404);
});

/* ── 连接健壮性：切页签会取消请求，绝对不能把服务搞死 ── */

test('客户端中途取消请求（切页签/刷新就是这种）不会让服务退出', async () => {
  const url = new URL(base + '/dsh-local-memory/graph');

  // 连续发 12 个请求，每个连上就立刻掐断 socket —— 复现"切页签打断请求"
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => {
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'GET' });
      req.on('error', () => resolve());
      req.on('socket', (socket) => {
        socket.destroy(); // 立刻掐断，服务器那边写数据就会 EPIPE
        resolve();
      });
      req.end();
    });
  }

  // 给服务一点时间处理这些错误
  await new Promise((r) => setTimeout(r, 300));

  const res = await fetch(base + '/dsh-local-memory/state');
  assert.equal(res.status, 200, '被取消的请求不该导致服务退出（进程还在就该返回 200）');
  const json = await res.json();
  assert.equal(json.ok, true);
});

/* ── 启动脚本的形态约束（踩过一次，非常隐蔽） ── */

test('启动脚本必须是纯 ASCII + CRLF（否则 cmd.exe 会把它拆碎执行）', () => {
  const launcher = path.join(ROOT, '启动记忆软件.cmd');
  assert.ok(fs.existsSync(launcher), '启动脚本不存在');

  const bytes = fs.readFileSync(launcher);

  // 1) 非 ASCII 字节：cmd 按 OEM 代码页读 .bat，UTF-8 中文会变乱码并破坏解析
  const nonAscii = [...bytes].filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, '启动脚本里不能有非 ASCII 字符（中文请放到 node 里打印）');

  // 2) 行尾必须是 CRLF：LF-only 的 .bat 会让 cmd 把语句切错
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) {
      lf++;
      if (i > 0 && bytes[i - 1] === 13) crlf++;
    }
  }
  assert.ok(lf > 0, '脚本不该是空的');
  assert.equal(lf, crlf, `有 ${lf - crlf} 行是 LF-only，必须是 CRLF`);
});

test('`--seed` 不带值时按默认路径处理（从批处理传带空格路径很容易传坏）', async () => {
  // 直接起一个实例，seed 用哨兵；数据目录里没有旧库时不应该阻塞启动
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-seedsentinel-'));
  const appx = await startServer({ port: 0, data: dir, seed: 'default' });
  try {
    const json = await (await fetch(appx.url + '/dsh-local-memory/state')).json();
    assert.equal(json.ok, true, 'seed 哨兵不应让启动失败');
  } finally {
    await appx.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test('--seed：首次启动把 v1 JSON 复制进数据目录，且不修改源文件', async () => {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-seed-'));
  const seedFile = path.join(seedDir, 'v1.json');
  const v1 = {
    version: 1,
    memories: [
      { id: 'm-seed-1', text: '种子记忆：这条来自 v1', tags: ['seed'], project: 'demo', createdAt: Date.now(), updatedAt: Date.now(), hits: 2 },
    ],
  };
  fs.writeFileSync(seedFile, JSON.stringify(v1), 'utf8');
  const before = fs.readFileSync(seedFile, 'utf8');

  const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-seeddata-'));
  const app2 = await startServer({ port: 0, data: data2, seed: seedFile });
  try {
    assert.equal(app2.seeded, true, '首次启动应有种子导入');
    const json = await (await fetch(app2.url + '/dsh-local-memory/memories?limit=10')).json();
    assert.equal(json.total, 1, '种子应被自动迁移进 SQLite');
    assert.match(json.memories[0].content, /来自 v1/);
    assert.equal(fs.readFileSync(seedFile, 'utf8'), before, '源文件必须一字未改');
  } finally {
    await app2.close();
    // 关闭后数据库句柄应已释放；Windows 上偶有文件锁延迟，清理失败不算测试失败
    try { fs.rmSync(data2, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(seedDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
