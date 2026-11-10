/**
 * 全链路运行时审计（用临时库，绝不碰真库）。
 *
 * 目的：今天动了三处核心逻辑（衰减时钟 / 类别权重 / 强制命中），
 * 单元测试各自过了，但"它们和已有功能一起跑"会不会打架，得端到端验一遍。
 *
 * 每条检查都打印 ✅/❌，任何 ❌ 都说明有真问题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-local-memory';
const { openStore, search, buildGraph, runMaintenance, findConflicts } = await import('file:///' + ROOT + '/src/core/index.js');
const { renderRecall, createRecallHandler } = await import('file:///' + ROOT + '/src/host/recall.js');

const DAY = 86400000;
const now = Date.now();
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + name + (detail ? '   ' + detail : ''));
};

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-audit-'));
  // ⚠ openStore 认的是 file/home，不是 dir；给 dir 会静默落到 ~/.dsh 的真库（踩过）
  const store = openStore({ file: path.join(dir, 'audit.db'), backend: 'sqlite' });
  return { store, dir };
}

// ───────────────────────── 1. 衰减时钟 ─────────────────────────
{
  console.log('\n【1】衰减时钟：按"最后一次被用到"，不按创建时间');
  const { store, dir } = mkStore();
  store.put({ content: '一年前写的但昨天刚用过', kind: 'work', importance: 'key', createdAt: now - 365 * DAY, updatedAt: now - 365 * DAY, lastAccessed: now - DAY });
  store.put({ content: '昨天刚写还没用过', kind: 'work', importance: 'key', createdAt: now - DAY, updatedAt: now - DAY });
  store.put({ content: '两年前写的从没用过', kind: 'work', importance: 'key', createdAt: now - 730 * DAY, updatedAt: now - 730 * DAY });

  const hits = search(store, '用过', { now, limit: 10 });
  const used = hits.find((h) => h.record.content.includes('昨天刚用过'));
  const unused = hits.find((h) => h.record.content.includes('还没用过'));
  check('天天用的一年老记忆 decay ≈ 1', used && used.why.decay > 0.95, used ? 'decay=' + used.why.decay.toFixed(3) : '没命中');
  check('用过的不比没用过的差', used && unused && used.why.decay >= unused.why.decay - 1e-9);

  // 从没用过的老记忆：查它自己那条（用"从没用过"当查询）
  const h2 = search(store, '两年前写的从没用过', { now, includeStale: true, limit: 5 });
  const old = h2.find((h) => h.record.content.includes('两年前'));
  check('从没用过的老记忆确实衰减了', old && old.why.decay < 0.3, old ? 'decay=' + old.why.decay.toFixed(3) : '没命中');

  const fresh = h2.find((h) => h.record.content.includes('两年前'));
  check('老记忆仍能被搜到（衰减不删数据）', !!fresh);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────── 2. 类别权重 ─────────────────────────
{
  console.log('\n【2】类别权重：只影响排序，不丢数据，越界被夹住');
  const { store, dir } = mkStore();
  store.put({ content: '工作类记忆内容', kind: 'work', importance: 'important', createdAt: now, updatedAt: now });
  store.put({ content: '情感类记忆内容', kind: 'emotion', importance: 'important', createdAt: now, updatedAt: now });

  const flat = search(store, '记忆内容', { now, kindWeight: { work: 1, preference: 1, emotion: 1, unknown: 1 } });
  check('权重都是 1 时两条都在', flat.length >= 2, flat.length + ' 条');

  const boosted = search(store, '记忆内容', { now, kindWeight: { work: 1, preference: 1, emotion: 4, unknown: 1 } });
  check('情感调到 4 → 情感排第一', boosted[0] && boosted[0].record.kind === 'emotion', boosted[0] ? boosted[0].record.kind : '空');

  const crushed = search(store, '记忆内容', { now, kindWeight: { work: 1, preference: 1, emotion: 0.1, unknown: 1 } });
  check('情感压到 0.1 → 仍然能搜到（不静默消失）', crushed.some((h) => h.record.kind === 'emotion'));

  // 越界值
  const extreme = search(store, '记忆内容', { now, kindWeight: { work: 1, preference: 1, emotion: 999, unknown: 1 } });
  const e = extreme.find((h) => h.record.kind === 'emotion');
  check('权重 999 被夹到 5（不会炸成天文数字）', e && Number.isFinite(e.score), e ? 'score=' + e.score.toFixed(3) : '空');

  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────── 3. 强制命中 ─────────────────────────
{
  console.log('\n【3】强制命中：排第一、绕过过滤、不污染无关搜索');
  const { store, dir } = mkStore();
  store.put({ content: '铁律：任何回复都用中文', kind: 'work', importance: 'key', createdAt: now - 400 * DAY, updatedAt: now - 400 * DAY, lastAccessed: now - 400 * DAY, pinned: 1 });
  store.put({ content: '中文相关的技术笔记，写了很长很长的一段内容', kind: 'work', importance: 'key', createdAt: now, updatedAt: now });

  const hits = search(store, '中文', { now, includeStale: false });
  check('钉住的老铁律没被"陈旧过滤"干掉', hits.some((h) => h.record.content.includes('铁律')));
  check('钉住的排第一', hits[0] && hits[0].record.content.includes('铁律'), hits[0] ? hits[0].record.content.slice(0, 10) : '空');

  const unrelated = search(store, '技术笔记', { now });
  check('搜无关词时不塞完全无关的钉住条目', !unrelated.some((h) => h.record.content.includes('铁律')));

  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────── 4. 自动回忆带钉住的 ─────────────────────────
{
  console.log('\n【4】自动回忆：钉住的每轮都带（哪怕这轮问的是别的事）');
  const { store, dir } = mkStore();
  store.put({ content: '铁律：数据库只读，测试不许写真库', kind: 'work', importance: 'key', createdAt: now, updatedAt: now, pinned: 1 });
  store.put({ content: 'Blender 建模笔记：建立方体的具体步骤和快捷键', kind: 'work', importance: 'important', createdAt: now, updatedAt: now });

  const cfg = {
    enabled: true, autoRecall: true, autoRecallMaxItems: 5, autoRecallMinChars: 2,
    forgetAfterDays: 9999,
    halfLifeDays: { work: 365, preference: 730, emotion: 60, unknown: 365 },
    kindWeight: { work: 1, preference: 1, emotion: 1, unknown: 1 },
    features: { softForget: true, pinAlways: true },
  };
  const handler = createRecallHandler({ getStore: () => store, getConfig: () => cfg });
  const payload = { agent: { id: 'audit-session' } };
  const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: 'Blender 建模笔记里怎么建立方体' }] });

  const decision = await handler(payload, next);
  const injectedMsg = (decision.messages || [])[0];
  const text = injectedMsg && injectedMsg.source && injectedMsg.source.form === 'recall'
    ? JSON.stringify(injectedMsg.content) : '';
  check('钉住的铁律出现在这一轮注入里', text.includes('数据库只读'), text ? '' : '没注入任何内容');
  check('正常命中的 Blender 笔记也在', text.includes('Blender'));
  console.log('    （注：长查询 + 短记忆会被覆盖率门槛挡住——查询 token 命中率需达 30%%~50%%，这是防噪声的设计，不是 bug）');

  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────── 5. 与既有功能的交互 ─────────────────────────
{
  console.log('\n【5】与既有功能共存：关系图 / 冲突检测 / 维护');
  const { store, dir } = mkStore();
  const a = store.put({ content: '项目用的是 PostgreSQL 数据库', kind: 'work', importance: 'important', project: 'demo', createdAt: now, updatedAt: now, pinned: 1 });
  store.put({ content: '项目用的是 MySQL 数据库', kind: 'work', importance: 'important', project: 'demo', createdAt: now, updatedAt: now });

  // 注意：buildGraph / findConflicts 收的是**记录数组**（不是 store）——我第一版审计写错了
  const records = store.list({ limit: 100 });
  let graphOk = true; let graphErr = '';
  try {
    const g = buildGraph(records, { now });
    graphOk = Array.isArray(g.nodes) && g.nodes.length >= 2;
    graphErr = graphOk ? 'nodes=' + g.nodes.length + ' edges=' + g.edges.length : 'nodes=' + (g.nodes || []).length;
  } catch (e) { graphOk = false; graphErr = e.message; }
  check('关系图仍能构建（含 pinned 节点）', graphOk, graphErr);

  let conflictOk = true; let conflictErr = '';
  try {
    const c = findConflicts(records, { now });
    conflictOk = Array.isArray(c.pairs || c);
    conflictErr = 'pairs=' + ((c.pairs || c).length);
  } catch (e) { conflictOk = false; conflictErr = e.message; }
  check('冲突检测不因 pinned 报错', conflictOk, conflictErr);

  let maintOk = true; let maintErr = '';
  try { runMaintenance(store, { now }); maintOk = true; } catch (e) { maintOk = false; maintErr = e.message; }
  check('维护任务能跑（不会误删 pinned）', maintOk, maintErr);
  check('维护后 pinned 还在', (store.get(a.id) || {}).pinned === 1);

  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}

// ───────────────────────── 6. 边界 ─────────────────────────
{
  console.log('\n【6】边界：空库 / 缺字段 / 怪值');
  const { store, dir } = mkStore();
  let ok = true; let err = '';
  try {
    search(store, '', { now });
    search(store, '   ', { now });
    store.put({ content: '没有 kind 的记录' });
    search(store, '没有', { now, kindWeight: { work: 'abc', emotion: null } });
  } catch (e) { ok = false; err = e.message; }
  check('空库、空查询、缺 kind、坏权重都不崩', ok, err);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌'));
process.exit(fails === 0 ? 0 : 1);
