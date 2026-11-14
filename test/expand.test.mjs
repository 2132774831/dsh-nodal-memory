/**
 * 图扩展召回的测试。
 *
 * 重点不在"能扩"，而在**扩得克制**：只有在命中很少时才补、最多 3 条、
 * 权重打折、一次巧合的共现不认。这几条是防止自我强化回路的全部依据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openStore, search } = await import('../src/core/index.js');
const { expandByGraph, GRAPH_EXPAND } = await import('../src/core/expand.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-expand-'));
  return openStore({ file: path.join(dir, 'e.db'), backend: 'sqlite' });
}

test('命中够多时完全不扩展（不搅浑已经很准的结果）', () => {
  const store = mkStore();
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(store.put({ content: '数据库迁移步骤第 ' + i + ' 条', kind: 'work', createdAt: now, updatedAt: now }).id);
  }
  store.recordCooccur(ids);
  const hits = search(store, '数据库迁移', { limit: 5 });
  assert.ok(hits.length >= 3, '前提：命中应 >= 3，实际 ' + hits.length);
  const expanded = expandByGraph(store, hits);
  assert.equal(expanded.length, hits.length, '命中足够时不该再加东西');
  store.close();
});

test('命中少时沿共现边补邻居，且最多补 3 条', () => {
  const store = mkStore();
  const now = Date.now();
  const main = store.put({ content: '主记忆：数据库口令轮换流程', kind: 'work', createdAt: now, updatedAt: now });
  const others = [];
  for (let i = 0; i < 6; i++) {
    others.push(store.put({ content: '邻居记忆 ' + i + '：和口令有关的细节', kind: 'work', createdAt: now, updatedAt: now }).id);
  }
  // 记两次：设计要求'至少一起出现过 2 次'才算相关（一次可能是巧合）
  store.recordCooccur([main.id, ...others]);
  store.recordCooccur([main.id, ...others]);

  const hits = search(store, '口令轮换流程', { limit: 5 });
  assert.ok(hits.length < 3, '前提：命中应少于 3 条，实际 ' + hits.length);
  const expanded = expandByGraph(store, hits);
  const added = expanded.length - hits.length;
  assert.ok(added > 0, '应该补进来至少一条');
  assert.ok(added <= GRAPH_EXPAND.maxAdded, '最多补 ' + GRAPH_EXPAND.maxAdded + ' 条，实际 ' + added);
  assert.ok(expanded.some((r) => r.why && r.why.graphExpanded), '补进来的要标记 graphExpanded');
  store.close();
});

test('补进来的分数打折（不能压过真正命中的）', () => {
  const store = mkStore();
  const now = Date.now();
  const a = store.put({ content: '唯一命中的那条记忆', kind: 'work', createdAt: now, updatedAt: now });
  const b = store.put({ content: '靠共现补进来的邻居', kind: 'work', createdAt: now, updatedAt: now });
  store.recordCooccur([a.id, b.id]);
  store.recordCooccur([a.id, b.id]);

  const hits = search(store, '唯一命中的那条记忆', { limit: 5 });
  assert.equal(hits.length, 1);
  const expanded = expandByGraph(store, hits);
  const added = expanded.find((r) => r.why && r.why.graphExpanded);
  assert.ok(added, '应有补进来的条目');
  assert.ok(added.score < hits[0].score, '补进来的分数必须低于原命中');
  assert.equal(added.why.via, a.id, '要记清楚是从哪条扩出来的');
  store.close();
});

test('只共现过 1 次的边不认（一次巧合不算相关）', () => {
  const store = mkStore();
  const now = Date.now();
  const a = store.put({ content: '只有一条命的记忆', kind: 'work', createdAt: now, updatedAt: now });
  const b = store.put({ content: '只一起出现过一次的', kind: 'work', createdAt: now, updatedAt: now });
  store.recordCooccur([a.id, b.id]);   // 只记一次

  const hits = search(store, '只有一条命的记忆', { limit: 5 });
  const expanded = expandByGraph(store, hits);
  assert.equal(expanded.length, hits.length, '只共现 1 次不该被扩展进来');
  store.close();
});

test('不重复添加已在结果里的记忆', () => {
  const store = mkStore();
  const now = Date.now();
  const a = store.put({ content: '第一条 数据库', kind: 'work', createdAt: now, updatedAt: now });
  const b = store.put({ content: '第二条 数据库', kind: 'work', createdAt: now, updatedAt: now });
  store.recordCooccur([a.id, b.id]);
  store.recordCooccur([a.id, b.id]);

  const hits = search(store, '第一条 数据库', { limit: 5 });
  const expanded = expandByGraph(store, hits);
  const ids = expanded.map((r) => r.record.id);
  assert.equal(new Set(ids).size, ids.length, '结果里不能有重复 id');
  store.close();
});
