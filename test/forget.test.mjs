/**
 * 软遗忘：**只降权，永不删除**。
 *
 * 为什么改成这样：直接物理删是不可逆的，误判一次就永远找不回来；
 * 而"很久没用过"不等于"没用"——有些结论一年才用一次。
 * 所以规则是：低价值类 + 长期闲置 → 排序往后压，但数据一直在、精确命中照样能搜到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, search } from '../src/core/index.js';

const DAY = 86400000;

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-forget-'));
  return openStore({ file: path.join(dir, 'f.db'), backend: 'sqlite' });
}

function hitOf(store, query, opts) {
  const hits = search(store, query, opts);
  return hits.find((h) => h.record.content.includes(query)) || hits[0] || null;
}

test('低价值 + 长期闲置 → 降权（但还在）', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 400 * DAY;
  store.put({ content: '随手记的一条闲聊内容', importance: 'casual', createdAt: old, updatedAt: old, lastAccessed: old });

  const r = hitOf(store, '闲聊', { now, forgetAfterDays: 180 });
  assert.ok(r, '必须还能搜到——软遗忘不是删除');
  assert.ok(r.why.neglect < 1, '应该被降权，实际 neglect=' + r.why.neglect);
  assert.equal(r.why.forgotten, true);
  assert.equal(store.count(), 1, '数据条数不能变');
  store.close();
});

test('key / important 永不降权（用户确认过要长期保留）', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 1000 * DAY;
  store.put({ content: '关键结论甲', importance: 'key', createdAt: old, updatedAt: old, lastAccessed: old });
  store.put({ content: '重要结论乙', importance: 'important', createdAt: old, updatedAt: old, lastAccessed: old });

  for (const q of ['关键结论', '重要结论']) {
    const r = hitOf(store, q, { now });
    assert.equal(r.why.neglect, 1, q + ' 不该被降权');
    assert.equal(r.why.forgotten, false);
  }
  store.close();
});

test('经常被用到的记忆不降权（看的是最后使用时间，不是创建时间）', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({
    content: '很老但一直在用的条目',
    importance: 'casual',
    createdAt: now - 900 * DAY,   // 创建得很早
    updatedAt: now - 900 * DAY,
    lastAccessed: now - 2 * DAY,  // 但前天还用过
  });
  const r = hitOf(store, '一直在用', { now });
  assert.equal(r.why.neglect, 1, '最近用过就不该被压');
  store.close();
});

test('关掉开关就完全不降权', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 900 * DAY;
  store.put({ content: '关了开关也还在这', importance: 'transient', createdAt: old, updatedAt: old, lastAccessed: old });

  const r = hitOf(store, '关了开关', { now, softForget: false });
  assert.equal(r.why.neglect, 1);
  store.close();
});

test('降权有下限：再久也不会归零', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 5000 * DAY;
  store.put({ content: '超级久远的琐事', importance: 'transient', createdAt: old, updatedAt: old, lastAccessed: old });

  const r = hitOf(store, '超级久远', { now });
  assert.ok(r, '再久也要能搜到');
  assert.ok(r.why.neglect >= 0.4, '最低只能压到 0.4，实际 ' + r.why.neglect);
  store.close();
});

test('情感类即使 importance 不低也会按情绪半衰期处理', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 400 * DAY;
  store.put({ content: '那天心情很差', kind: 'emotion', importance: 'important', createdAt: old, updatedAt: old, lastAccessed: old });
  const r = hitOf(store, '心情', { now });
  // emotion 属于"低价值类"（会过期），但 importance=important 不在降权名单里走的是另一条：
  // 这里只断言它仍能搜到，且没有因为情绪而被误删
  assert.ok(r, '情绪记忆必须还在');
  assert.equal(store.count(), 1);
  store.close();
});

test('衰减速度可调：调大半衰期 → 衰减更慢，调小 → 更快', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 90 * DAY;
  // 用 key + work：排除软遗忘干扰，只看 decay
  store.put({ content: '九十天前的工作结论', kind: 'work', importance: 'key', createdAt: old, updatedAt: old, lastAccessed: old });

  const base = hitOf(store, '九十天前', { now }).why.decay;                    // 默认 365 天
  const fast = hitOf(store, '九十天前', { now, halfLifeDays: { work: 30 } }).why.decay;
  const slow = hitOf(store, '九十天前', { now, halfLifeDays: { work: 3650 } }).why.decay;

  assert.ok(fast < base, `调小半衰期应该衰减更快：${fast} 应 < ${base}`);
  assert.ok(slow > base, `调大半衰期应该衰减更慢：${slow} 应 > ${base}`);

  // 非法值（0 / 负数）必须退回默认，否则整类记忆会被瞬间清空
  const bad = hitOf(store, '九十天前', { now, halfLifeDays: { work: 0 } }).why.decay;
  assert.equal(bad, base, '半衰期写坏要退回默认值');
  store.close();
});

test('不同类别用各自的半衰期：同样 90 天，情感比偏好衰减得多', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 90 * DAY;
  store.put({ content: '情感条目甲', kind: 'emotion', importance: 'key', createdAt: old, updatedAt: old, lastAccessed: old });
  store.put({ content: '偏好条目乙', kind: 'preference', importance: 'key', createdAt: old, updatedAt: old, lastAccessed: old });

  const e = hitOf(store, '情感条目', { now }).why.decay;
  const p = hitOf(store, '偏好条目', { now }).why.decay;
  assert.ok(e < p, `情感（60天）应比偏好（730天）衰减得快：${e} vs ${p}`);
  store.close();
});

test('时钟基准取 max(创建,更新)：老记忆刚更新过就不算陈旧', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({
    content: '很久以前写、昨天刚更新过的结论',
    kind: 'work',
    importance: 'key',
    createdAt: now - 400 * DAY,
    updatedAt: now - 1 * DAY,   // 昨天还动过
  });
  const r = hitOf(store, '刚更新过的结论', { now });
  assert.equal(r.why.stale, false, '刚更新过就不该报"距今较久"');
  assert.ok(r.why.decay > 0.9, '衰减要按更新时间算，实际 ' + r.why.decay);
  store.close();
});

test('自动注入不参与频次加成（掐掉"注入越多越容易被注入"的自增强回路）', () => {
  const store = mkStore();
  const now = Date.now();
  const a = store.put({ content: '被注入五十次的条目', kind: 'work', importance: 'important' }).record;
  const b = store.put({ content: '被检索五十次的条目', kind: 'work', importance: 'important' }).record;
  for (let i = 0; i < 50; i++) {
    store.recordAccess(a.id, 'inject', now);
    store.recordAccess(b.id, 'search', now);
  }
  const ua = hitOf(store, '被注入五十次', { now }).why.usage;
  const ub = hitOf(store, '被检索五十次', { now }).why.usage;
  assert.ok(ub > ua, `模型主动检索的加成应高于被动注入：${ub} 应 > ${ua}`);
  assert.ok(ua <= 2, '加成有上限，不能无限涨');
  store.close();
});

test('衰减看"最后一次被用到"，不是创建时间（天天用的老记忆不该被压）', () => {
  const store = mkStore();
  const now = Date.now();
  const year = now - 365 * DAY;
  // 一年前写的，但昨天还被检索到
  store.put({
    content: '一年前定的约定，但昨天刚被用到',
    kind: 'work', importance: 'key',
    createdAt: year, updatedAt: year, lastAccessed: now - DAY,
  });
  // 昨天刚写，一次没用过
  store.put({
    content: '昨天刚写还没用过的',
    kind: 'work', importance: 'key',
    createdAt: now - DAY, updatedAt: now - DAY,
  });

  const used = hitOf(store, '一年前定的约定', { now });
  const fresh = hitOf(store, '昨天刚写还没用过', { now });
  assert.ok(used.why.decay > 0.95, '一直在用的记忆不该衰减，实际 ' + used.why.decay);
  assert.ok(used.why.decay >= fresh.why.decay - 1e-9, '用过的老记忆不应该比没用过的新记忆更糟');
  store.close();
});

test('衰减：用过一阵子后又没人用了，从那之后开始衰减', () => {
  const store = mkStore();
  const now = Date.now();
  const year = now - 365 * DAY;
  store.put({
    content: '一年前写的，半年前最后用过一次',
    kind: 'work', importance: 'key',
    createdAt: year, updatedAt: year, lastAccessed: now - 180 * DAY,
  });
  const r = hitOf(store, '半年前最后用过', { now });
  // 半衰期 365 天，180 天 ≈ 0.5^(180/365) ≈ 0.71
  assert.ok(r.why.decay > 0.6 && r.why.decay < 0.8, '应从最后一次使用算起，实际 ' + r.why.decay);
  store.close();
});
/* ───────────── 类别权重 ─────────────
 * 主人要的："能不能单独提高情感这一类什么的命中率"。
 * 只影响排序，不动数据。 */

test('类别权重：把情感调高，同样的查询情感就能排到工作前面', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({ content: '关于记忆插件的偏好说明', kind: 'work', importance: 'important', createdAt: now, updatedAt: now });
  store.put({ content: '关于记忆插件的心情感受', kind: 'emotion', importance: 'important', createdAt: now, updatedAt: now });

  const base = search(store, '记忆插件', { now });
  const workBase = base.findIndex((h) => h.record.kind === 'work');
  const emotBase = base.findIndex((h) => h.record.kind === 'emotion');

  const boosted = search(store, '记忆插件', { now, kindWeight: { work: 1, preference: 1, emotion: 3, unknown: 1 } });
  const emotBoost = boosted.findIndex((h) => h.record.kind === 'emotion');
  assert.equal(emotBoost, 0, '情感权重调到 3 之后应排第一（原来第 ' + (emotBase + 1) + '）');
  assert.ok(workBase >= 0, '工作那条不该消失');
  store.close();
});

test('类别权重：压到 0.1 也不会让这一类彻底消失', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({ content: '一条情感记忆', kind: 'emotion', importance: 'important', createdAt: now, updatedAt: now });
  const hits = search(store, '情感记忆', { now, kindWeight: { work: 1, preference: 1, emotion: 0.1, unknown: 1 } });
  assert.ok(hits.length > 0, '压权重只是排序靠后，不该查不到');
  store.close();
});

/* ───────────── 强制命中（置顶） ───────────── */

test('置顶：只要进了候选，钉住的就排第一（不靠相关度取胜）', () => {
  const store = mkStore();
  const now = Date.now();
  // 两条都能匹配"中文"，但普通那条的相关度更高、更新、更重要
  store.put({ content: '中文', kind: 'work', importance: 'key', createdAt: now, updatedAt: now, pinned: 1 });
  store.put({
    content: '中文中文中文 记忆插件的完整技术笔记，写得非常详细',
    kind: 'work', importance: 'key', createdAt: now, updatedAt: now,
  });

  const hits = search(store, '中文', { now });
  assert.equal(hits[0].record.content, '中文', '钉住的应排第一，即使它内容更短、相关度更低');
  assert.ok(hits.find((h) => h.record.content.includes('技术笔记')), '普通命中的也要在');
  store.close();
});

test('置顶：完全无关的钉住条目不会污染显式搜索（那是自动回忆的职责）', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({ content: '铁律：回复一律用中文', kind: 'work', importance: 'key', createdAt: now, updatedAt: now, pinned: 1 });
  store.put({ content: '记忆插件的实现笔记', kind: 'work', importance: 'important', createdAt: now, updatedAt: now });
  const hits = search(store, '插件', { now });
  assert.ok(!hits.some((h) => h.record.content.includes('用中文')),
    '显式搜索不该塞入完全无关的条目；每轮必带由 recall.js 负责');
  store.close();
});

test('置顶：钉住的不受"陈旧过滤"影响（长期有效的规矩）', () => {
  const store = mkStore();
  const now = Date.now();
  const old = now - 400 * DAY;
  store.put({ content: '铁律：数据库只读，测试不许写真库', kind: 'work', importance: 'key', createdAt: old, updatedAt: old, lastAccessed: old, pinned: 1 });
  const hits = search(store, '铁律', { now, includeStale: false });
  assert.ok(hits.length > 0, '钉住的老规矩不该被"陈旧"过滤掉');
  store.close();
});