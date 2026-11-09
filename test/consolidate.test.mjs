/**
 * 记忆整合：同一件事反复出现 → 合成一条高阶结论并提高权重。
 *
 * 这是"频次压制"的正确做法：不是让 10 条碎片各自涨分（那会挤满检索结果），
 * 而是合成 1 条结论、给最高重要度，碎片退居证据（仍可搜，但不再自动注入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, search } from '../src/core/index.js';
import { findConsolidationGroups, findSimilarityGroups, applyConsolidation } from '../src/core/consolidate.js';

const DAY = 86400000;

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cons-'));
  return { store: openStore({ file: path.join(dir, 'c.db'), backend: 'sqlite' }), dir };
}

/** 造三条"同一件事的不同说法" */
function putNoodle(store, now) {
  const texts = [
    '今天中午吃了牛肉面，挺好吃的',
    '中午又去吃了牛肉面，还是熟悉的味道',
    '晚上想起来中午吃的牛肉面真不错',
  ];
  return texts.map((t, i) => store.put({
    content: t,
    tags: ['饮食'],
    kind: 'emotion',
    createdAt: now - (10 - i) * DAY,
    updatedAt: now - (10 - i) * DAY,
  }).record);
}

test('内容相似：同一件事说了三次 → 能被聚成一组', () => {
  const { store } = mkStore();
  const now = Date.now();
  const recs = putNoodle(store, now);
  const groups = findSimilarityGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  assert.equal(groups.length, 1, '应该聚出 1 组，实际 ' + groups.length);
  assert.equal(groups[0].size, 3);
  assert.deepEqual(groups[0].memberIds.sort(), recs.map((r) => r.id).sort());
  store.close();
});

test('只出现两次不整合（避免把偶然重复当成偏好）', () => {
  const { store } = mkStore();
  const now = Date.now();
  store.put({ content: '今天吃了牛肉面', kind: 'emotion', createdAt: now - DAY, updatedAt: now - DAY });
  store.put({ content: '中午又吃了牛肉面', kind: 'emotion', createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY });
  const groups = findSimilarityGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  assert.equal(groups.length, 0);
  store.close();
});

test('整合落地：生成一条 key 级结论，原文全部保留且标记 consolidated', () => {
  const { store } = mkStore();
  const now = Date.now();
  const recs = putNoodle(store, now);
  const groups = findSimilarityGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  const r = applyConsolidation(store, groups[0]);
  assert.equal(r.ok, true);
  assert.equal(r.affected, 3);

  const summary = store.get(r.id);
  assert.equal(summary.importance, 'key', '整合出来的结论必须是最高的重要度（这就是"提高权重"）');
  assert.match(summary.content, /牛肉面|饮食/, '归纳正文要能读');
  assert.match(summary.content, /原始 3 条仍保留/, '要写明原文还在');

  // 原文一条都不能少，正文一个字都不能改
  for (const rec of recs) {
    const after = store.get(rec.id);
    assert.equal(after.content, rec.content, '原文不许被改写');
    assert.equal(after.status, 'consolidated');
    assert.equal(after.parentId, r.id, '要挂到归纳条目下面');
  }
  assert.equal(store.count(), 4, '3 条原文 + 1 条归纳');
  store.close();
});

test('已整合的碎片不会再被重复整合', () => {
  const { store } = mkStore();
  const now = Date.now();
  putNoodle(store, now);
  const first = findSimilarityGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  applyConsolidation(store, first[0]);
  const second = findConsolidationGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  assert.equal(second.groups.filter((g) => g.by === 'similar').length, 0, '已经并过的不该再冒出来');
  store.close();
});

test('预览（dryRun）绝不写库', () => {
  const { store } = mkStore();
  const now = Date.now();
  putNoodle(store, now);
  const before = store.count();
  findConsolidationGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  assert.equal(store.count(), before, '只预览不该新增任何记录');
  store.close();
});

test('搜索去重：归纳条和它的碎片同时命中时，只留归纳条', () => {
  const { store } = mkStore();
  const child = store.put({ content: '牛肉面 原始碎片记录', status: 'consolidated' }).record;
  const parent = store.put({ content: '牛肉面 归纳结论', importance: 'key' }).record;
  store.put({ ...child, parentId: parent.id, status: 'consolidated' });

  const hits = search(store, '牛肉面');
  assert.ok(hits.some((h) => h.record.id === parent.id), '归纳条要在');
  assert.ok(!hits.some((h) => h.record.id === child.id), '父条也在结果里时，碎片要让位');
  store.close();
});

test('搜索去重不该把碎片藏起来：父条没命中时，碎片照样能搜到', () => {
  const { store } = mkStore();
  const child = store.put({ content: '独角兽关键词 只在碎片里出现', status: 'consolidated' }).record;
  const parent = store.put({ content: '完全不相干的归纳结论', importance: 'key' }).record;
  store.put({ ...child, parentId: parent.id, status: 'consolidated' });

  const hits = search(store, '独角兽关键词');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record.id, child.id, '碎片是可查的证据，不该被藏掉');
  store.close();
});

test('默认**不**把"同一标签"当成可整合组（那是话题桶，不是同一件事）', () => {
  const { store } = mkStore();
  const now = Date.now();
  const texts = [
    '部署时 Nginx 要调 proxy_read_timeout，默认 60 秒会把长任务切断',
    '数据库连接池上限改成 20，压测时超过会排队',
    '前端构建产物必须 gzip，否则首屏三秒起步',
  ];
  texts.forEach((t, i) => {
    store.put({
      content: t,
      tags: ['topic:deploy'],
      kind: 'work',
      createdAt: now - i * DAY,
      updatedAt: now - i * DAY,
    });
  });
  const { groups } = findConsolidationGroups(store.list({ limit: 1000 }), { minGroupSize: 3, now });
  assert.equal(groups.length, 0, '三条不同的事实只共享标签，不该被建议整合');
  store.close();
});

test('需要时仍可打开标签分组（将来做"话题摘要"用）', () => {
  const { store } = mkStore();
  const now = Date.now();
  const texts = [
    '部署时 Nginx 要调 proxy_read_timeout，默认 60 秒会把长任务切断',
    '数据库连接池上限改成 20，压测时超过会排队',
    '前端构建产物必须 gzip，否则首屏三秒起步',
  ];
  texts.forEach((t, i) => {
    store.put({
      content: t,
      tags: ['topic:deploy'],
      kind: 'work',
      createdAt: now - i * DAY,
      updatedAt: now - i * DAY,
    });
  });
  const { groups } = findConsolidationGroups(store.list({ limit: 1000 }), {
    minGroupSize: 3, now, includeTagGroups: true,
  });
  assert.ok(groups.some((g) => g.tag === 'topic:deploy'), '显式打开时应该能找出');
  store.close();
});
