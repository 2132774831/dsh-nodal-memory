/**
 * 可选 embedding 层测试。
 *
 * 没有真 endpoint 也要能测：起一个本地 HTTP 假服务器冒充 OpenAI 兼容接口，
 * 这样超时、报错、返回格式不对、缓存命中这些路径全都能真跑一遍。
 * 「等有真实 key 再验证」这个借口不成立——契约是可以本地测的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createEmbedder, normalizeVec, cosine, encodeVec, decodeVec,
  openStore, search,
} from '../src/core/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-embed-'));

/* ── 假的 OpenAI 兼容 /embeddings 服务 ── */
async function startFakeServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const out = handler(payload, req);
      if (out.delayMs) {
        setTimeout(() => respond(res, out), out.delayMs);
        return;
      }
      respond(res, out);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: 'http://127.0.0.1:' + port, stop: () => new Promise((r) => server.close(r)) };
}

function respond(res, out) {
  if (out.status && out.status !== 200) {
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body || { error: 'boom' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out.body));
}

/** 假向量：按文本长度/首字符造一个稳定但可区分的二维向量 */
function fakeEmbedding(text) {
  const s = String(text);
  return [s.length, s.charCodeAt(0) || 1];
}

/* ── 向量数学 ── */

test('normalizeVec 归一化到单位长度，零向量返回 null', () => {
  const v = normalizeVec([3, 4]);
  assert.equal(v.length, 2);
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
  assert.equal(normalizeVec([0, 0]), null);
  assert.equal(normalizeVec([1, NaN]), null);
  assert.equal(normalizeVec([]), null);
});

test('cosine：同向为 1，垂直为 0，维度不同返回 0', () => {
  assert.ok(Math.abs(cosine(normalizeVec([1, 0]), normalizeVec([2, 0])) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(normalizeVec([1, 0]), normalizeVec([0, 1]))) < 1e-6);
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0])), 0);
});

test('向量编码解码无损往返', () => {
  const original = normalizeVec([0.3, -0.5, 1.7, 9]);
  const round = decodeVec(encodeVec(original));
  assert.equal(round.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(round[i] - original[i]) < 1e-7, `第 ${i} 位丢了精度`);
  }
  assert.equal(decodeVec('不是base64'), null);
  assert.equal(decodeVec(''), null);
});

/* ── provider 客户端 ── */

test('未启用时直接返回 ok:false，不发起任何请求', async () => {
  const e = createEmbedder({ enabled: false, baseUrl: 'http://127.0.0.1:1', model: 'x' });
  assert.equal(e.enabled, false);
  const r = await e.embed(['hello']);
  assert.equal(r.ok, false);
  assert.match(r.error, /未启用/);
});

test('缺少 baseUrl 或 model 时视为未启用（配置不全不能半启动）', () => {
  assert.equal(createEmbedder({ enabled: true, baseUrl: 'http://x', model: '' }).enabled, false);
  assert.equal(createEmbedder({ enabled: true, baseUrl: '', model: 'm' }).enabled, false);
});

test('正常调用：按 index 归位并归一化', async () => {
  const fake = await startFakeServer((payload) => ({
    body: {
      data: payload.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })),
    },
  }));
  try {
    const e = createEmbedder({ enabled: true, baseUrl: fake.baseUrl, model: 'test-model' }, { fetchImpl: fetch });
    const r = await e.embed(['hello', 'a much longer sentence']);
    assert.equal(r.ok, true);
    assert.equal(r.vectors.length, 2);
    for (const v of r.vectors) {
      assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5, '向量应归一化');
    }
  } finally { await fake.stop(); }
});

test('服务端打乱顺序时按 index 归位（不能靠返回顺序猜）', async () => {
  const fake = await startFakeServer((payload) => ({
    body: {
      data: payload.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })).reverse(),
    },
  }));
  try {
    const e = createEmbedder({ enabled: true, baseUrl: fake.baseUrl, model: 'm' }, { fetchImpl: fetch });
    const r = await e.embed(['aaa', 'bbbbbbbbbb']);
    assert.equal(r.ok, true);
    // 第一个文本更短，长度分量应更小
    assert.ok(r.vectors[0][0] < r.vectors[1][0], '顺序被搞乱说明没有按 index 归位');
  } finally { await fake.stop(); }
});

test('HTTP 500 时返回 ok:false，不抛异常', async () => {
  const fake = await startFakeServer(() => ({ status: 500, body: { error: 'server exploded' } }));
  try {
    const e = createEmbedder({ enabled: true, baseUrl: fake.baseUrl, model: 'm' }, { fetchImpl: fetch });
    const r = await e.embed(['x']);
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.equal(e.stats().failures, 1);
  } finally { await fake.stop(); }
});

test('返回格式不对（数量不匹配）时优雅失败', async () => {
  const fake = await startFakeServer(() => ({ body: { data: [{ index: 0, embedding: [1, 0] }] } }));
  try {
    const e = createEmbedder({ enabled: true, baseUrl: fake.baseUrl, model: 'm' }, { fetchImpl: fetch });
    const r = await e.embed(['a', 'b']); // 要 2 个只给 1 个
    assert.equal(r.ok, false);
    assert.match(r.error, /数量不匹配/);
  } finally { await fake.stop(); }
});

test('超时会失败而不是永久挂起', async () => {
  const fake = await startFakeServer((payload) => ({
    delayMs: 800,
    body: { data: payload.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })) },
  }));
  try {
    const e = createEmbedder(
      { enabled: true, baseUrl: fake.baseUrl, model: 'm' },
      { fetchImpl: fetch, timeoutMs: 120 },
    );
    const r = await e.embed(['x']);
    assert.equal(r.ok, false, '超时应当失败');
  } finally { await fake.stop(); }
});

test('同一文本第二次走缓存，不再发请求', async () => {
  const fake = await startFakeServer((payload) => ({
    body: { data: payload.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })) },
  }));
  try {
    const e = createEmbedder({ enabled: true, baseUrl: fake.baseUrl, model: 'm' }, { fetchImpl: fetch });
    await e.embed(['same text']);
    await e.embed(['same text']);
    const s = e.stats();
    assert.equal(s.requests, 1, '第二次应命中缓存');
    assert.equal(s.cacheHits, 1);
  } finally { await fake.stop(); }
});

test('批量超过 batch 大小时自动分片', async () => {
  let calls = 0;
  const fake = await startFakeServer((payload) => {
    calls++;
    return { body: { data: payload.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })) } };
  });
  try {
    const e = createEmbedder(
      { enabled: true, baseUrl: fake.baseUrl, model: 'm' },
      { fetchImpl: fetch, batch: 2 },
    );
    const r = await e.embed(['a1', 'a2', 'a3', 'a4', 'a5']);
    assert.equal(r.ok, true);
    assert.equal(r.vectors.length, 5);
    assert.equal(calls, 3, '5 条按每批 2 条应发 3 次');
  } finally { await fake.stop(); }
});

// 回归：真实环境里千问转发站拒绝 32 条一批（400 batch size is invalid），
// 写死批大小必撞墙，所以要能自适应二分拆批。
test('服务端嫌批次太大时自动二分拆小，最终仍然全部拿到向量', async () => {
  const maxAllowed = 2;
  let calls = 0;
  const fake = await startFakeServer((payload) => {
    calls++;
    if (payload.input.length > maxAllowed) {
      return { status: 400, body: { error: { message: 'Value error, batch size is invalid, it should not be larger than 2' } } };
    }
    return { body: { data: payload.input.map((t, i) => ({ index: i, embedding: fakeEmbedding(t) })) } };
  });
  try {
    const e = createEmbedder(
      { enabled: true, baseUrl: fake.baseUrl, model: 'm' },
      { fetchImpl: fetch, batch: 10 },
    );
    const r = await e.embed(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']);
    assert.equal(r.ok, true, '拆批后应当成功');
    assert.equal(r.vectors.length, 7);
    for (const v of r.vectors) assert.ok(v && v.length === 2);
    assert.ok(calls > 1, '应该发生了拆批重试');
  } finally { await fake.stop(); }
});

test('鉴权失败不拆批（拆了也没用，别白试几十次）', async () => {
  const fake = await startFakeServer(() => ({ status: 401, body: { error: 'unauthorized' } }));
  try {
    const e = createEmbedder({ enabled: true, baseUrl: fake.baseUrl, model: 'm' }, { fetchImpl: fetch, batch: 4 });
    const r = await e.embed(['a', 'b', 'c', 'd']);
    assert.equal(r.ok, false);
    assert.equal(e.stats().requests, 1, '401 只应尝试一次');
  } finally { await fake.stop(); }
});

/* ── 向量落库 + 混合打分 ── */

for (const backend of ['sqlite', 'json']) {
  test(`[${backend}] 向量能存能取，purge 会清掉`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const { id } = store.put({ content: '一条要算向量的记忆' });
    const vec = normalizeVec([1, 2, 3]);
    assert.equal(store.putVector(id, { model: 'm1', vec }), true);

    const back = store.getVector(id);
    assert.ok(back);
    assert.equal(back.length, 3);
    assert.ok(Math.abs(back[0] - vec[0]) < 1e-6);

    assert.equal(store.vectorStats().withVector, 1);
    store.purge(id);
    assert.equal(store.getVector(id), null, 'purge 后向量应一起清掉');
    store.close();
  });

  test(`[${backend}] 有 queryVector 时语义分参与排序（并写进 why）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const a = store.put({ content: '部署流程走 CI 流水线' }).id;
    const b = store.put({ content: '部署流程要小心回滚' }).id;

    // a 的向量与查询完全同向，b 的向量正交
    store.putVector(a, { model: 'm', vec: normalizeVec([1, 0]) });
    store.putVector(b, { model: 'm', vec: normalizeVec([0, 1]) });

    const hits = search(store, '部署流程', { queryVector: normalizeVec([1, 0]) });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].record.id, a, '语义更近的应排前面');
    assert.ok(hits[0].why.semantic > 0.9);
    assert.ok(Math.abs(hits[1].why.semantic) < 0.1);
    store.close();
  });

  test(`[${backend}] 没有向量时退化为纯关键词，不报错`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ content: '这条没有向量' });
    const hits = search(store, '向量', { queryVector: normalizeVec([1, 0]) });
    // 命中与否不重要，关键是 semantic 为 null 且不抛错
    for (const h of hits) assert.equal(h.why.semantic, null);
    store.close();
  });

  test(`[${backend}] 维度不一致的向量被忽略（换过模型的情况）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const id = store.put({ content: '旧模型的向量' }).id;
    store.putVector(id, { model: 'old', vec: normalizeVec([1, 0, 0]) }); // 3 维

    const hits = search(store, '旧模型', { queryVector: normalizeVec([1, 0]) }); // 2 维
    assert.equal(hits.length, 1);
    assert.equal(hits[0].why.semantic, null, '维度不一致必须当作没有向量，不能硬算');
    store.close();
  });
}
