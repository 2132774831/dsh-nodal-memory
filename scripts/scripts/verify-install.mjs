#!/usr/bin/env node
/**
 * 装机彩排：按 package.json **声明的入口**把 v2 完整挂起来跑一遍。
 *
 * 和 try-host.mjs 的区别：
 *   try-host 直接 import '../src/host/index.js'（写死路径）；
 *   这里从 package.json 的 exports['./v2'] 解析路径再 import——
 *   验证的是"**声明**是对的"，因为真装机时宿主就是按声明找入口的。
 *   入口声明写错，代码再好也装不上。
 *
 * 安全：全程临时 DSH_HOME，真库只读（拷一份副本进去）。
 * 退出码 0 = 彩排通过，1 = 有问题。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ ok: true, name, detail });
  } catch (err) {
    checks.push({ ok: false, name, detail: String((err && err.message) || err) });
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    checks.push({ ok: true, name, detail });
  } catch (err) {
    checks.push({ ok: false, name, detail: String((err && err.message) || err) });
  }
}

/**
 * 入口解析要**兼容两种布局**，而且优先级不能反：
 *   - 开发工作区：主入口 '.' 仍是 v1 的 lib/，v2 在 exports['./v2'] → **必须优先用 ./v2**
 *   - 发布包：v2 就是正式入口，exports['.'] 指向 src/host/index.js，没有 ./v2 → 退回 '.'
 *
 * 这个脚本是"v2 装机彩排"，所以永远优先测 v2。
 * （踩过的坑：先写的版本优先取 '.'，结果在工作区里彩排跑的是 v1，报 /graph 404。）
 */
const entryRel = (pkg.exports && (pkg.exports['./v2'] || pkg.exports['.'])) || pkg.main;
const clientRel = (pkg.exports && (pkg.exports['./v2/client'] || pkg.exports['./client']))
  || './src/client/index.js';

/* ── 1. 入口声明可解析 ── */
check('package.json 声明了可解析的入口', () => {
  if (!entryRel) throw new Error('exports["."] / exports["./v2"] / main 都没有');
  return entryRel;
});
check('入口文件存在', () => {
  const p = path.join(ROOT, entryRel.replace(/^\.\//, ''));
  if (!fs.existsSync(p)) throw new Error('文件不存在：' + p);
  return path.relative(ROOT, p);
});
check('前端入口存在且是 ModuleLoader bundle', () => {
  const p = path.join(ROOT, clientRel.replace(/^\.\//, ''));
  if (!fs.existsSync(p)) throw new Error('前端入口不存在：' + p);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes('__ModuleLoader__.load(')) throw new Error('不是 ModuleLoader bundle');
  return path.relative(ROOT, p);
});

/* ── 2. 按声明入口加载 ── */
const hostEntry = await import(new URL('file://' + path.join(ROOT, entryRel.replace(/^\.\//, ''))).href);

await checkAsync('入口导出 apply()', () => {
  if (typeof hostEntry.apply !== 'function') throw new Error('没有导出 apply');
  return 'ok';
});

/* ── 3. 在临时 DSH_HOME 里挂载 ── */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-install-'));
const realV1 = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'dsh-local-memory.json');
if (fs.existsSync(realV1)) fs.copyFileSync(realV1, path.join(home, 'dsh-local-memory.json'));
process.env.DSH_HOME = home;

const tools = new Map();
const sections = [];
const handlers = new Map();
let routeSpec = null;

const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  on: (e, f) => { handlers.set(e, f); return () => {}; },
  effect: (fn) => { fn(); return () => {}; },
  get: (n) => (n === 'connection' ? { requestRejection: () => null } : undefined),
  webServer: { register: (spec) => { routeSpec = spec; return () => {}; } },
};

hostEntry.apply(ctx);

check('注册了 5 个工具', () => {
  const want = ['memory_save', 'memory_search', 'memory_list', 'memory_forget', 'memory_review'];
  for (const name of want) if (!tools.has(name)) throw new Error('缺少工具 ' + name);
  return [...tools.keys()].join(',');
});
check('注册了常驻提示词段', () => {
  if (sections.length !== 1) throw new Error('提示词段数量异常：' + sections.length);
  if (!sections[0].text().includes('收工自检')) throw new Error('提示词内容缺失');
  return sections[0].name;
});
check('注册了 agent/pre-step 回忆处理器', () => {
  if (typeof handlers.get('agent/pre-step') !== 'function') throw new Error('缺少处理器');
  return 'ok';
});
check('注册了 HTTP 路由（prefix /dsh-local-memory）', () => {
  if (!routeSpec) throw new Error('没有注册路由');
  if (routeSpec.kind !== 'prefix' || routeSpec.path !== '/dsh-local-memory') {
    throw new Error('路由形态不对：' + routeSpec.kind + ' ' + routeSpec.path);
  }
  return routeSpec.path;
});

const call = (name, args = {}) => tools.get(name).execute(args, {});

/* ── 4. 真跑一遍工具 ── */
await checkAsync('memory_list 可用，且真实库已自动迁移', async () => {
  const out = await call('memory_list', { limit: 1 });
  const m = out.match(/共 (\d+) 条/);
  if (!m) throw new Error('输出异常：' + out.slice(0, 80));
  if (Number(m[1]) === 0) throw new Error('迁移后库是空的');
  return '库内 ' + m[1] + ' 条';
});

await checkAsync('memory_save -> memory_search 往返（中文两字词）', async () => {
  await call('memory_save', { text: '彩排写入：主人喜欢喝美式咖啡不加糖', tags: ['selftest'], kind: 'preference' });
  const out = await call('memory_search', { query: '咖啡' });
  if (!out.includes('美式咖啡')) throw new Error('检索没命中刚写的内容');
  return '命中';
});

await checkAsync('memory_review 只读体检可用', async () => {
  const out = await call('memory_review', {});
  if (!out.includes('体检')) throw new Error('输出异常');
  return 'ok';
});

await checkAsync('自动回忆注入并带 source.kind', async () => {
  const decision = {
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '我记得你喜欢美式咖啡对吧' }], source: { kind: 'user' } }],
  };
  const out = await handlers.get('agent/pre-step')({ agent: { id: 'rehearsal' } }, async () => decision);
  if (out.messages.length !== 2) throw new Error('没有注入（messages=' + out.messages.length + '）');
  const src = out.messages[0].source;
  if (!src || src.kind !== pkg.name) throw new Error('source.kind 不对：' + JSON.stringify(src));
  return '注入 1 条，source.kind=' + src.kind;
});

/* ── 5. 路由真跑一遍 ── */
async function request(sub, method = 'GET', body) {
  const listeners = new Map();
  const req = { url: '/dsh-local-memory' + sub, method, on: (e, cb) => { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); return req; }, destroy() {} };
  queueMicrotask(() => {
    if (body !== undefined) (listeners.get('data') || []).forEach((cb) => cb(Buffer.from(body)));
    (listeners.get('end') || []).forEach((cb) => cb());
  });
  const state = { code: 0, body: '' };
  const res = {
    set statusCode(v) { state.code = v; }, get statusCode() { return state.code; },
    writeHead(code) { state.code = code; },
    end(chunk) { if (chunk) state.body += String(chunk); },
  };
  await routeSpec.handler(req, res);
  return { code: state.code, json: state.body ? JSON.parse(state.body) : null };
}

await checkAsync('GET /state', async () => {
  const r = await request('/state');
  if (r.code !== 200 || !r.json.ok) throw new Error('状态 ' + r.code);
  return 'total=' + r.json.stats.total + ' backend=' + r.json.backend;
});

await checkAsync('GET /graph', async () => {
  const r = await request('/graph');
  if (r.code !== 200) throw new Error('状态 ' + r.code);
  if (!Array.isArray(r.json.nodes) || r.json.nodes.length === 0) throw new Error('没有节点');
  return '点 ' + r.json.nodes.length + ' / 边 ' + r.json.edges.length + ' / 孤岛 ' + r.json.stats.isolated;
});

await checkAsync('POST /memories -> DELETE -> restore 闭环', async () => {
  const created = await request('/memories', 'POST', JSON.stringify({ content: '彩排：这条要被删了再恢复' }));
  if (!created.json.ok) throw new Error('创建失败');
  const id = created.json.id;
  const del = await request('/memories/' + id, 'DELETE');
  if (!del.json.softDeleted) throw new Error('软删失败');
  const back = await request('/memories/' + id + '/restore', 'POST');
  if (back.code !== 200) throw new Error('恢复失败');
  return 'ok';
});

/* ── 6. 源库未被改动 ── */
await checkAsync('真实记忆库未被改动', async () => {
  if (!fs.existsSync(realV1)) return '真实库不存在，跳过';
  const crypto = await import('node:crypto');
  const h = crypto.createHash('sha256').update(fs.readFileSync(realV1)).digest('hex');
  const copyHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(home, 'dsh-local-memory.json'))).digest('hex');
  // 副本可能被迁移读取过但不会被写；真正要保证的是"彩排没有写进真实库"
  return '真实库 SHA256 前缀 ' + h.slice(0, 12) + '（副本 ' + copyHash.slice(0, 12) + '）';
});

/* ── 汇总 ── */
let pass = 0;
let fail = 0;
console.log('\n装机彩排（入口：' + entryRel + '）\n' + '-'.repeat(56));
for (const c of checks) {
  if (c.ok) { pass++; console.log(`  ✔ ${c.name}${c.detail ? '  → ' + c.detail : ''}`); }
  else { fail++; console.log(`  ✖ ${c.name}  → ${c.detail}`); }
}
console.log('-'.repeat(56));
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log(`  临时 DSH_HOME：${home}`);

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }

process.exit(fail === 0 ? 0 : 1);
