/**
 * HTTP 路由测试：假 webServer + 假 req/res，不需要启动真服务器。
 *
 * 重点验证：
 *   - 信任栅栏生效（任意网页不能读写记忆库）
 *   - 增删改查 + 软删/恢复/彻底删 的语义
 *   - /graph 直接吐出算好的边
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { apply } = await import('../src/host/index.js');

const BASE = '/dsh-local-memory';

/** 挂一个假宿主，返回路由注册结果 */
function mount({ reject = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-routes-'));
  process.env.DSH_HOME = home;

  const holder = { spec: null, registered: 0 };
  const ctx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    get: (name) => (name === 'connection'
      ? { requestRejection: () => reject }
      : undefined),
    webServer: {
      register: (spec) => {
        holder.spec = spec;
        holder.registered += 1;
        return () => {};
      },
    },
  };

  apply(ctx);
  return { home, holder };
}

/** 假请求：body 在 handler 订阅之后异步吐出 */
function makeReq({ url, method = 'GET', body }) {
  const listeners = new Map();
  const req = {
    url,
    method,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== undefined) for (const cb of listeners.get('data') || []) cb(Buffer.from(body, 'utf8'));
    for (const cb of listeners.get('end') || []) cb();
  });
  return req;
}

function makeRes() {
  const state = { code: 0, headers: {}, body: '' };
  const res = {
    set statusCode(v) { state.code = v; },
    get statusCode() { return state.code; },
    writeHead(code, headers) { state.code = code; state.headers = headers || {}; },
    end(chunk) { if (chunk) state.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); },
  };
  return { res, state };
}

async function request(holder, { method = 'GET', sub = '/state', body } = {}) {
  assert.ok(holder.spec, '应该已注册路由');
  const req = makeReq({ url: BASE + sub, method, body });
  const { res, state } = makeRes();
  await holder.spec.handler(req, res);
  let json = null;
  try { json = state.body ? JSON.parse(state.body) : null; } catch { /* 可能是纯文本 */ }
  return { code: state.code, headers: state.headers, body: state.body, json };
}

// ---------------------------------------------------------------- 基础

test('注册了一个 prefix 路由，前缀是 /dsh-local-memory', () => {
  const { holder } = mount();
  assert.equal(holder.registered, 1);
  assert.equal(holder.spec.kind, 'prefix');
  assert.equal(holder.spec.path, BASE);
  assert.equal(typeof holder.spec.handler, 'function');
});

test('GET /state 返回配置 + 统计 + 后端类型', async () => {
  const { holder } = mount();
  const r = await request(holder, { sub: '/state' });
  assert.equal(r.code, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.config.enabled, true);
  assert.equal(r.json.stats.total, 0);
  assert.ok(['sqlite', 'json'].includes(r.json.backend));
});

test('信任栅栏：被拒的请求直接 403，不返回任何数据', async () => {
  const { holder } = mount({ reject: 403 });
  const r = await request(holder, { sub: '/state' });
  assert.equal(r.code, 403);
  assert.equal(r.body, '', '不应该吐出任何 JSON');
});

test('未知路由返回 404 并带上路径', async () => {
  const { holder } = mount();
  const r = await request(holder, { sub: '/nope' });
  assert.equal(r.code, 404);
  assert.equal(r.json.ok, false);
});

// ---------------------------------------------------------------- 增删改查

test('POST /memories 新增，GET /memories 能查到', async () => {
  const { holder } = mount();
  const created = await request(holder, {
    method: 'POST', sub: '/memories',
    body: JSON.stringify({ content: '主人喜欢喝美式咖啡', tags: ['pref'], kind: 'preference' }),
  });
  assert.equal(created.code, 200);
  assert.equal(created.json.ok, true);
  assert.ok(created.json.id);
  assert.equal(created.json.memory.kind, 'preference');

  const list = await request(holder, { sub: '/memories' });
  assert.equal(list.json.total, 1);
  assert.equal(list.json.memories.length, 1);
  assert.equal(list.json.memories[0].content, '主人喜欢喝美式咖啡');
});

test('POST /memories 空内容被拒', async () => {
  const { holder } = mount();
  const r = await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '  ' }) });
  assert.equal(r.code, 400);
});

test('GET /memories?q= 走检索并回带打分细节', async () => {
  const { holder } = mount();
  await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '用户住在北京' }) });
  const r = await request(holder, { sub: '/memories?q=北京' });
  assert.equal(r.json.matched, 1);
  assert.equal(r.json.memories[0].why.coverage, 1);
  assert.ok(typeof r.json.memories[0].score === 'number');
});

test('POST /memories/:id 更新正文与标签', async () => {
  const { holder } = mount();
  const created = await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '旧内容' }) });
  const id = created.json.id;

  const updated = await request(holder, {
    method: 'POST', sub: `/memories/${id}`,
    body: JSON.stringify({ content: '新内容', tags: ['a', 'b'] }),
  });
  assert.equal(updated.code, 200);
  assert.equal(updated.json.memory.content, '新内容');
  assert.deepEqual(updated.json.memory.tags, ['a', 'b']);
});

test('DELETE 是软删：默认查不到，带 includeDeleted 能查到', async () => {
  const { holder } = mount();
  const created = await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '待删记忆' }) });
  const id = created.json.id;

  const del = await request(holder, { method: 'DELETE', sub: `/memories/${id}` });
  assert.equal(del.code, 200);
  assert.equal(del.json.softDeleted, true);

  const list = await request(holder, { sub: '/memories' });
  assert.equal(list.json.memories.length, 0, '默认不返回已删');

  const withDeleted = await request(holder, { sub: '/memories?includeDeleted=1' });
  assert.equal(withDeleted.json.memories.length, 1, '显式要求才返回已删');
});

test('POST /memories/:id/restore 能恢复软删的记忆', async () => {
  const { holder } = mount();
  const created = await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '先删后恢复' }) });
  const id = created.json.id;
  await request(holder, { method: 'DELETE', sub: `/memories/${id}` });

  const restored = await request(holder, { method: 'POST', sub: `/memories/${id}/restore` });
  assert.equal(restored.code, 200);
  assert.equal(restored.json.memory.deletedAt, null);

  const list = await request(holder, { sub: '/memories' });
  assert.equal(list.json.memories.length, 1);
});

test('POST /memories/:id/purge 才是彻底删', async () => {
  const { holder } = mount();
  const created = await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '彻底删掉' }) });
  const id = created.json.id;

  const purged = await request(holder, { method: 'POST', sub: `/memories/${id}/purge` });
  assert.equal(purged.code, 200);
  assert.equal(purged.json.purged, true);

  const withDeleted = await request(holder, { sub: '/memories?includeDeleted=1' });
  assert.equal(withDeleted.json.memories.length, 0);
});

test('不存在的 id 返回 404，不是 500', async () => {
  const { holder } = mount();
  const r = await request(holder, { method: 'POST', sub: '/memories/m-does-not-exist', body: '{}' });
  assert.equal(r.code, 404);
});

test('非法 JSON 返回 400', async () => {
  const { holder } = mount();
  const r = await request(holder, { method: 'POST', sub: '/memories', body: '{oops' });
  assert.equal(r.code, 400);
});

// ---------------------------------------------------------------- 配置 / 图 / 导出

test('POST /config 局部更新并落盘', async () => {
  const { holder } = mount();
  const r = await request(holder, {
    method: 'POST', sub: '/config',
    body: JSON.stringify({ autoRecall: false, autoRecallMaxItems: 3 }),
  });
  assert.equal(r.code, 200);
  assert.equal(r.json.config.autoRecall, false);
  assert.equal(r.json.config.autoRecallMaxItems, 3);
  assert.equal(r.json.config.enabled, true, '没传的字段应保持原值');

  const state = await request(holder, { sub: '/state' });
  assert.equal(state.json.config.autoRecall, false, '再读一次仍是新值（真的落盘了）');
});

test('GET /graph 返回已算好的点与边', async () => {
  const { holder } = mount();
  await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '记忆甲', tags: ['topic:g1'] }) });
  await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '记忆乙', tags: ['topic:g1'] }) });

  const g = await request(holder, { sub: '/graph' });
  assert.equal(g.code, 200);
  assert.equal(g.json.ok, true);
  assert.equal(g.json.nodes.length, 2);
  assert.equal(g.json.edges.length, 1, '共享标签应连出一条边');
  assert.ok(g.json.nodes.every((n) => 'id' in n && 'degree' in n && 'isolated' in n));
  assert.ok('stats' in g.json);
});

test('GET /export 导出 Markdown', async () => {
  const { holder } = mount();
  await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '要导出的记忆', tags: ['x'] }) });
  const r = await request(holder, { sub: '/export' });
  assert.equal(r.code, 200);
  assert.match(r.headers['Content-Type'], /markdown/);
  assert.match(r.body, /# 本地记忆导出/);
  assert.match(r.body, /要导出的记忆/);
});

test('GET /review 返回体检报告', async () => {  const { holder } = mount();
  await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '没标签没分类的记忆' }) });
  const r = await request(holder, { sub: '/review' });
  assert.equal(r.code, 200);
  assert.equal(r.json.report.total, 1);
  assert.equal(r.json.report.noTags.length, 1);
  assert.equal(r.json.report.noKind.length, 1);
});

// ---------------------------------------------------------------- 补标

test('GET /memories?kind=unknown 只返未分类（补标页签的数据源）', async () => {
  const { holder } = mount();
  await request(holder, { method: 'POST', sub: '/memories', body: JSON.stringify({ content: '还没分类的' }) });
  await request(holder, {
    method: 'POST', sub: '/memories',
    body: JSON.stringify({ content: '已经分好类的', kind: 'work' }),
  });

  const onlyUnknown = await request(holder, { sub: '/memories?kind=unknown' });
  assert.equal(onlyUnknown.json.memories.length, 1);
  assert.match(onlyUnknown.json.memories[0].content, /还没分类/);

  const onlyWork = await request(holder, { sub: '/memories?kind=work' });
  assert.equal(onlyWork.json.memories.length, 1);
  assert.match(onlyWork.json.memories[0].content, /已经分好类/);
});

test('补标闭环：POST kind 之后该条从 unknown 队列消失，统计跟着变', async () => {
  const { holder } = mount();
  const created = await request(holder, {
    method: 'POST', sub: '/memories',
    body: JSON.stringify({ content: '这条要补标' }),
  });
  const id = created.json.id;

  const before = await request(holder, { sub: '/memories?kind=unknown' });
  assert.equal(before.json.memories.length, 1);

  const set = await request(holder, {
    method: 'POST', sub: `/memories/${id}`,
    body: JSON.stringify({ kind: 'preference', importance: 'key' }),
  });
  assert.equal(set.json.memory.kind, 'preference');
  assert.equal(set.json.memory.importance, 'key');

  const after = await request(holder, { sub: '/memories?kind=unknown' });
  assert.equal(after.json.memories.length, 0, '补过标的不应再出现在队列里');

  const state = await request(holder, { sub: '/state' });
  const preference = (state.json.stats.byKind || []).find((k) => k.kind === 'preference');
  assert.equal(preference.c, 1);
});

test('补标时改标签：POST tags 会整体替换并去重', async () => {
  const { holder } = mount();
  const created = await request(holder, {
    method: 'POST', sub: '/memories',
    body: JSON.stringify({ content: '标签待补', tags: ['old'] }),
  });
  const id = created.json.id;

  const set = await request(holder, {
    method: 'POST', sub: `/memories/${id}`,
    body: JSON.stringify({ tags: ['pref', 'topic:x', 'pref'] }),
  });
  assert.deepEqual(set.json.memory.tags, ['pref', 'topic:x'], '重复标签应被去掉');
});

// ---------------------------------------------------------------- 维护

test('POST /maintenance 手动跑一次，并回报清理了哪些孤儿行', async () => {
  const { holder } = mount();
  const r = await request(holder, { method: 'POST', sub: '/maintenance' });
  assert.equal(r.code, 200);
  assert.equal(r.json.result.ran, true);
  assert.equal(r.json.result.reason, 'forced');
  assert.ok(r.json.info.lastAt, '跑完要记下时间');
});

test('GET /state 里带维护信息（UI 能显示"上次维护多久前"）', async () => {
  const { holder } = mount();
  await request(holder, { method: 'POST', sub: '/maintenance' });
  const s = await request(holder, { sub: '/state' });
  assert.equal(s.code, 200);
  assert.ok(s.json.maintenance, '/state 应包含 maintenance');
  assert.ok(s.json.maintenance.lastAt > 0);
  assert.equal(s.json.maintenance.lastAgoDays, 0);
});

test('维护接口不接受 GET（别让人用浏览器地址栏误触发）', async () => {
  const { holder } = mount();
  const r = await request(holder, { sub: '/maintenance' });
  assert.equal(r.code, 405);
});

// ---------------------------------------------------------------- embedding

test('GET /state 带 embedding 状态（默认关闭、向量数为 0）', async () => {
  const { holder } = mount();
  const r = await request(holder, { sub: '/state' });
  assert.equal(r.code, 200);
  assert.equal(r.json.embedding.enabled, false);
  assert.equal(r.json.embedding.vectors.withVector, 0);
});

test('POST /embedding/test 未启用时明确说明原因，不假装成功', async () => {
  const { holder } = mount();
  const r = await request(holder, { method: 'POST', sub: '/embedding/test' });
  assert.equal(r.code, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.enabled, false);
  assert.match(r.json.error, /未启用/);
});

test('POST /embedding/backfill 未启用时也给出明确结果而不是报错', async () => {
  const { holder } = mount();
  const r = await request(holder, { method: 'POST', sub: '/embedding/backfill' });
  assert.equal(r.code, 200);
  assert.equal(r.json.result.ok, false);
  assert.equal(r.json.result.filled, 0);
});

test('同一条内容重复新增不会产生第二条（网页端要向 memory_save 看齐）', async () => {
  const { holder } = mount();
  const body = JSON.stringify({ content: '这条会被重复提交两次', tags: ['a'] });

  const first = await request(holder, { method: 'POST', sub: '/memories', body });
  assert.equal(first.code, 200);
  assert.equal(first.json.created, true);

  const second = await request(holder, {
    method: 'POST', sub: '/memories',
    body: JSON.stringify({ content: '这条会被重复提交两次', tags: ['b'] }),
  });
  assert.equal(second.code, 200);
  assert.equal(second.json.created, false, '第二次不该新建');
  assert.equal(second.json.id, first.json.id, '应返回同一条的 id');
  assert.deepEqual(second.json.memory.tags.sort(), ['a', 'b'], '标签应合并');

  const list = await request(holder, { sub: '/memories?limit=100' });
  const same = list.json.memories.filter((m) => m.content === '这条会被重复提交两次');
  assert.equal(same.length, 1, '库里只该有一条');
});

test('保存的 apiKey 绝不经接口回显（只回 hasStoredKey）', async () => {
  const { holder } = mount();
  const secret = 'sk-this-must-never-leak-123';

  const saved = await request(holder, {
    method: 'POST', sub: '/config',
    body: JSON.stringify({
      embedding: { enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: secret },
    }),
  });
  assert.equal(saved.code, 200);
  assert.equal(saved.json.config.embedding.apiKey, '', '保存响应里不能带明文');
  assert.equal(saved.json.config.embedding.hasStoredKey, true, '但要告诉界面"已配置"');
  assert.ok(!saved.body.includes(secret), '响应体整体都不能出现明文');

  const state = await request(holder, { sub: '/state' });
  assert.equal(state.json.config.embedding.apiKey, '');
  assert.ok(!state.body.includes(secret), '/state 也不能出现明文');
});
