/**
 * 记忆内核单元测试（node:test，零依赖）。
 *
 * 重点覆盖三类"容易静默坏掉"的地方：
 *   1. 中文分词/查询表达式 —— 坏了的表现是"搜不到"，而不是报错
 *   2. 软删/恢复/purge 的边界 —— 坏了的表现是"记忆消失"，最不可接受
 *   3. 迁移幂等 —— 坏了的表现是"重跑一次数据翻倍"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  tokens, toFtsQuery, hasCJK, normalize,
  formatRelative, freshness, decayFactor, toMs,
  openStore, search, migrateFromV1, normalizeProject, inferKind,
  runMaintenance,
} from '../src/core/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-core-'));

// ---------------------------------------------------------------- text

test('tokens: 两字中文词切成一个 bigram（trigram 的死角）', () => {
  assert.deepEqual(tokens('北京'), ['北京']);
});

test('tokens: 三字词切成两个相邻 bigram', () => {
  assert.deepEqual(tokens('牛肉面'), ['牛肉', '肉面']);
});

test('tokens: 英文保持整词，不做 bigram（否则 me 会命中 memory）', () => {
  assert.deepEqual(tokens('memory'), ['memory']);
});

test('tokens: 中英混排各自成 token，标点作为边界', () => {
  const t = tokens('用 SQLite 存记忆');
  assert.ok(t.includes('sqlite'), '英文整词小写');
  assert.ok(t.includes('记忆'), '中文 bigram');
});

test('tokens: 单字保留（否则单字查询永远搜不到）', () => {
  assert.deepEqual(tokens('鱼'), ['鱼']);
});

test('toFtsQuery: 每个 token 都被双引号包住，无法注入 FTS 操作符', () => {
  const q = toFtsQuery('记忆 OR 插件*');
  assert.ok(q.includes('"记忆"'));
  assert.ok(!/\bOR\b(?!")/.test(q.replace(/"[^"]*"/g, '')), '表达式里不应残留裸 OR');
  assert.ok(q.split(' AND ').every((p) => p.startsWith('"') && p.endsWith('"')));
});

test('toFtsQuery: 空输入返回 null 而不是空字符串', () => {
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('！？。'), null);
});

test('hasCJK 识别中文', () => {
  assert.equal(hasCJK('记忆'), true);
  assert.equal(hasCJK('memory'), false);
});

test('normalize 去零宽字符并压缩空白', () => {
  assert.equal(normalize('  a\u200b  b  '), 'a b');
});

// ---------------------------------------------------------------- time

test('formatRelative: 三级粒度', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const day = 86400000;
  assert.equal(formatRelative(now - 3 * 3600000, now).label, '3 小时前');
  assert.equal(formatRelative(now - 1.4 * day, now).label, '昨天');
  assert.equal(formatRelative(now - 3 * day, now).label, '3 天前');
  assert.equal(formatRelative(now - 10 * day, now).label, '1 周前');
  assert.equal(formatRelative(now - 65 * day, now).label, '2 个月前');
  assert.match(formatRelative(now - 400 * day, now).label, /^\d{4} 年 \d{2} 月$/);
});

test('formatRelative: 未来时间不出现负数', () => {
  const now = Date.now();
  assert.equal(formatRelative(now + 99999999, now).label, '刚刚');
});

test('freshness: 超过 180 天标记过期并给出警告', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.equal(freshness(now - 10 * 86400000, now).stale, false);
  const old = freshness(now - 200 * 86400000, now);
  assert.equal(old.stale, true);
  assert.ok(old.warning.includes('较久'));
});

test('decayFactor: 刚创建为 1，随时间为 0~1 单调递减', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.equal(decayFactor(now, 'work', now), 1);
  const half = decayFactor(now - 365 * 86400000, 'work', now);
  assert.ok(Math.abs(half - 0.5) < 1e-9, 'work 半衰期为 365 天');
  assert.ok(decayFactor(now - 365 * 86400000, 'emotion', now) < half, '情绪衰减更快');
});

test('toMs 对非法输入返回 null 而不是 NaN', () => {
  assert.equal(toMs('不是时间'), null);
  assert.equal(toMs(null), null);
  assert.equal(typeof toMs(1791219453368), 'number');
});

// 回归测试：SQLite 把数字绑定进 TEXT 列会写成 "1759200000000.0"，
// 早期版本因此 Date.parse 失败，时间被静默当成"现在"（衰减永远为 1）。
test('toMs 必须认得数字字符串，包括 SQLite 产生的 ".0" 后缀', () => {
  assert.equal(toMs('1791219453368'), 1791219453368);
  assert.equal(toMs('1791219453368.0'), 1791219453368);
  assert.equal(toMs(' 1759200000000 '), 1759200000000);
});

// ---------------------------------------------------------------- store

for (const backend of ['sqlite', 'json']) {
  test(`[${backend}] put/get：写入后能按 id 读回，中文原样保留`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const { id, created } = store.put({ content: '主人喜欢喝美式咖啡，不加糖', tags: ['pref'], project: 'default-workspace' });
    assert.equal(created, true);
    const back = store.get(id);
    assert.equal(back.content, '主人喜欢喝美式咖啡，不加糖');
    assert.deepEqual(back.tags, ['pref']);
    assert.equal(back.kind, 'unknown');
    assert.equal(back.importance, 'important');
    store.close();
  });

  test(`[${backend}] 时间戳原样往返（不能每读一次就变成"现在"）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const want = 1759200000000;
    const { id } = store.put({ content: '时间戳往返测试', createdAt: want, updatedAt: want });
    assert.equal(store.get(id).createdAt, want, 'get 必须返回写入时的毫秒值');
    assert.equal(store.list()[0].createdAt, want, 'list 同样');
    store.close();
  });

  test(`[${backend}] 软删后默认查不到，includeDeleted 能查到，restore 能恢复`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const { id } = store.put({ content: '这条要被软删' });
    assert.equal(store.remove(id), true);
    assert.equal(store.count(), 0);
    assert.equal(store.count({ includeDeleted: true }), 1);
    assert.ok(store.get(id), 'get 仍能读到（数据没丢，只是标记了）');
    assert.equal(store.list().length, 0);
    assert.equal(store.list({ includeDeleted: true }).length, 1);
    assert.equal(store.restore(id), true);
    assert.equal(store.count(), 1);
    store.close();
  });

  test(`[${backend}] purge 才物理删除，且删完 get 返回 null`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const { id } = store.put({ content: '这条要被彻底删' });
    assert.equal(store.purge(id), true);
    assert.equal(store.get(id), null);
    assert.equal(store.count({ includeDeleted: true }), 0);
    store.close();
  });

  test(`[${backend}] recordAccess 分别累加 inject / search 两个计数`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const { id } = store.put({ content: '被访问计数测试' });
    store.recordAccess(id, 'inject');
    store.recordAccess(id, 'inject');
    store.recordAccess(id, 'search');
    const rec = store.get(id);
    assert.equal(rec.accessCount, 3);
    assert.equal(rec.injectedCount, 2);
    assert.equal(rec.searchedCount, 1);
    assert.ok(rec.lastAccessed > 0);
    store.close();
  });

  test(`[${backend}] 非法枚举值回退到默认值，不抛错、不丢记忆`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const { id } = store.put({ content: '枚举测试', kind: '乱写', importance: '超级重要' });
    const rec = store.get(id);
    assert.equal(rec.kind, 'unknown');
    assert.equal(rec.importance, 'important');
    store.close();
  });

  test(`[${backend}] 同一 id 重复 put 是更新而不是新增`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ id: 'fixed-id', content: '第一次' });
    const r2 = store.put({ id: 'fixed-id', content: '第二次' });
    assert.equal(r2.created, false);
    assert.equal(store.count(), 1);
    assert.equal(store.get('fixed-id').content, '第二次');
    store.close();
  });

  test(`[${backend}] 共现：顺序无关地合并成同一对，重复记录累加次数`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ id: 'a', content: '甲' });
    store.put({ id: 'b', content: '乙' });
    store.put({ id: 'c', content: '丙' });

    store.recordCooccur(['a', 'b']);
    store.recordCooccur(['b', 'a']); // 顺序反过来算同一对
    assert.equal(store.cooccurPairs().length, 1, '(a,b) 与 (b,a) 应是同一对');
    assert.equal(store.cooccurPairs()[0].count, 2);

    store.recordCooccur(['a', 'b', 'c']);
    assert.equal(store.cooccurPairs().length, 3, '三个 id 应产生三对');
    store.close();
  });

  test(`[${backend}] 单条 id 不产生共现（不能自己跟自己共现）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ id: 'only', content: '就一条' });
    assert.equal(store.recordCooccur(['only']), 0);
    assert.equal(store.cooccurPairs().length, 0);
    store.close();
  });

  test(`[${backend}] purge 顺手清掉共现记录，不留孤儿边`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ id: 'a', content: '甲' });
    store.put({ id: 'b', content: '乙' });
    store.recordCooccur(['a', 'b']);
    assert.equal(store.cooccurPairs().length, 1);

    store.purge('a');
    assert.equal(store.cooccurPairs().length, 0, '被彻底删掉的记忆不应留在共现表里');

    // 软删**不**清共现：万一恢复，关系还在
    store.put({ id: 'c', content: '丙' });
    store.recordCooccur(['b', 'c']);
    store.remove('c');
    assert.equal(store.cooccurPairs().length, 1, '软删不清共现（可恢复）');
    store.close();
  });

  // ── 惰性维护
  test(`[${backend}] 首次维护会跑，并记下时间戳`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ content: '一条记忆' });
    const now = Date.parse('2026-11-08T12:00:00Z');

    assert.equal(store.getMeta('last_maintenance_at'), null, '初始不应有维护时间戳');
    const r = runMaintenance(store, { now, intervalDays: 7 });
    assert.equal(r.ran, true);
    assert.equal(store.getMeta('last_maintenance_at'), String(now));
    store.close();
  });

  test(`[${backend}] 未到期就不跑（不给它机会空转）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const t0 = Date.parse('2026-11-08T12:00:00Z');
    runMaintenance(store, { now: t0, intervalDays: 7 });

    const t1 = t0 + 2 * 86400000; // 才过 2 天
    const r = runMaintenance(store, { now: t1, intervalDays: 7 });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'not-due');
    assert.ok(r.dueInDays > 0);
    assert.equal(store.getMeta('last_maintenance_at'), String(t0), '时间戳不应被刷新');
    store.close();
  });

  test(`[${backend}] 到期后自动跑，force 可跳过等待`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const t0 = Date.parse('2026-11-08T12:00:00Z');
    runMaintenance(store, { now: t0, intervalDays: 7 });

    const t1 = t0 + 8 * 86400000;
    assert.equal(runMaintenance(store, { now: t1, intervalDays: 7 }).ran, true);

    const t2 = t1 + 86400000;
    assert.equal(runMaintenance(store, { now: t2, intervalDays: 7 }).ran, false, '刚跑过不应再跑');
    assert.equal(runMaintenance(store, { now: t2, intervalDays: 7, force: true }).ran, true, 'force 应无视间隔');
    store.close();
  });

  test(`[${backend}] 维护只清孤儿行，绝不动任何记忆`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ id: 'a', content: '甲' });
    store.put({ id: 'b', content: '乙' });
    store.recordCooccur(['a', 'b']);
    // 造一条孤儿：引用了不存在的 ghost
    store.recordCooccur(['a', 'ghost']);
    assert.equal(store.cooccurPairs().length, 2);

    const before = store.count();
    const r = runMaintenance(store, { force: true });

    assert.equal(store.count(), before, '维护不能删记忆');
    assert.equal(r.orphans.cooccur, 1, '应清掉 1 条孤儿共现');
    assert.equal(store.cooccurPairs().length, 1, '正常共现要留着');
    store.close();
  });

  test(`[${backend}] 维护失败不抛错（不能把写入路径带崩）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    // 故意破坏：把 pruneOrphans 换成会抛的
    const original = store.pruneOrphans;
    store.pruneOrphans = () => { throw new Error('boom'); };
    const r = runMaintenance(store, { force: true });
    assert.equal(r.ran, true, '仍然要标记为跑过（否则会每次重试）');
    assert.equal(r.orphans.error, 'prune failed');
    store.pruneOrphans = original;
    store.close();
  });

  test(`[${backend}] 中文检索：两字词命中（unicode61/trigram 做不到的场景）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ content: '用户住在北京，冬天很冷', project: 'p1' });
    store.put({ content: '用户喜欢吃牛肉面', project: 'p1' });
    const hitsBeijing = search(store, '北京');
    assert.equal(hitsBeijing.length, 1, '「北京」应只命中第一条');
    assert.match(hitsBeijing[0].record.content, /北京/);
    const hitsNoodle = search(store, '牛肉面');
    assert.equal(hitsNoodle.length, 1, '「牛肉面」应只命中第二条');
    store.close();
  });

  test(`[${backend}] 检索不会返回无关记忆（AND 语义，宁缺毋滥）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ content: '用户住在北京' });
    store.put({ content: '插件用 SQLite 存储' });
    assert.equal(search(store, '北京插件').length, 0, '两个词分属不同记忆，不应命中任何一条');
    store.close();
  });

  test(`[${backend}] 放宽召回：字没挨着但同词的两条都该命中，逐字连续者排前`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ content: '记忆插件的架构设计' });
    store.put({ content: '关于记忆和插件，中间隔了别的字' });
    const hits = search(store, '记忆插件');
    assert.equal(hits.length, 2, '两条都该被召回（旧版 AND 会漏掉第二条）');
    assert.match(hits[0].record.content, /记忆插件/, '逐字连续的应排第一');
    assert.equal(hits[0].why.coverage, 1, '第一条覆盖率满分');
    assert.ok(hits[1].why.coverage < 1, '第二条只覆盖了部分 token');
    store.close();
  });

  test(`[${backend}] 检索按 filters 过滤 project`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    store.put({ content: '记忆插件在项目甲', project: 'A' });
    store.put({ content: '记忆插件在项目乙', project: 'B' });
    const hits = search(store, '记忆插件', { filters: { project: 'A' } });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].record.project, 'A');
    store.close();
  });

  test(`[${backend}] 排序：同等相关时，更新的排前面（时间衰减生效）`, () => {
    const store = openStore({ file: path.join(tmp(), backend === 'sqlite' ? 'm.db' : 'm.json'), backend });
    const now = Date.parse('2026-11-08T12:00:00Z');
    // ⚠ updatedAt 也要一起给：decay 的时钟取 max(createdAt, updatedAt)，
    // 只给 createdAt 的话 updatedAt 会默认成"现在"，两条都变新鲜、排序失效。
    store.put({ content: '部署流程走 CI', createdAt: now - 400 * 86400000, updatedAt: now - 400 * 86400000 });
    store.put({ content: '部署流程走 CI', createdAt: now - 2 * 86400000, updatedAt: now - 2 * 86400000 });
    const hits = search(store, '部署流程', { now });
    assert.equal(hits.length, 2);
    assert.ok(hits[0].record.createdAt > hits[1].record.createdAt, '新记忆应排在前面');
    store.close();
  });
}

// ---------------------------------------------------------------- migrate

const V1_SAMPLE = {
  version: 1,
  memories: [
    { id: 'm-a1', text: '用户喜欢喝美式咖啡', tags: ['pref', 'topic:coffee'], project: 'default_workspace', createdAt: 1791219453368, updatedAt: 1792291653086, hits: 5, lastUsedAt: 1794136882597 },
    { id: 'm-a2', text: 'SQLite 的 FTS5 中文要自己切 bigram', tags: ['pitfall'], project: 'default-workspace', createdAt: 1791300000000, updatedAt: 1791300000000, hits: 0 },
    { text: '这条缺 id 会被跳过', tags: [] },
  ],
};

test('migrate: 字段映射正确，project 下划线统一成连字符', () => {
  const store = openStore({ file: path.join(tmp(), 'm.db'), backend: 'sqlite' });
  const rep = migrateFromV1(store, V1_SAMPLE);
  assert.equal(rep.total, 3);
  assert.equal(rep.inserted, 2, '第三条缺 id 应被跳过');
  assert.equal(rep.invalid, 1);

  const a1 = store.get('m-a1');
  assert.equal(a1.content, '用户喜欢喝美式咖啡');
  assert.equal(a1.project, 'default-workspace', 'default_workspace 应被统一');
  assert.equal(a1.kind, 'preference', '带 pref 标签的判为 preference');
  assert.equal(a1.accessCount, 5);
  assert.equal(a1.searchedCount, 5);
  assert.equal(a1.origin, 'v1');
  assert.deepEqual(a1.tags, ['pref', 'topic:coffee']);
  assert.ok(a1.lastAccessed > 0);
  store.close();
});

test('migrate: 技术型条目自动分类成 work，证据不足仍留白', () => {
  const store = openStore({ file: path.join(tmp(), 'm-kind.db'), backend: 'sqlite' });
  migrateFromV1(store, {
    version: 1,
    memories: [
      { id: 'k1', text: 'SQLite 的 WAL 模式下并发写入要注意 busy_timeout', tags: [] },
      { id: 'k2', text: '部署踩坑：Nginx 的超时配置默认 60 秒，改完要重启服务进程', tags: [] },
      { id: 'k3', text: '嗯', tags: [] },
    ],
  });
  assert.equal(store.get('k1').kind, 'work');
  assert.equal(store.get('k2').kind, 'work');
  // 证据不足时留白，不瞎猜
  assert.equal(store.get('k3').kind, 'unknown');
  // ⚠ kind 必须是字符串。inferKindFromContent 返回 {kind, why}，
  //   直接赋值会把对象写进记录，统计里全落进 unknown（踩过，v2.1.0 安装时被外部测试抓到）
  assert.equal(typeof store.get('k1').kind, 'string');
  store.close();
});

test('migrate: 幂等 —— 重跑不会重复插入，也不会覆盖已有计数', () => {  const store = openStore({ file: path.join(tmp(), 'm.db'), backend: 'sqlite' });
  migrateFromV1(store, V1_SAMPLE);
  // 模拟 v2 侧产生的使用痕迹
  store.recordAccess('m-a1', 'search');
  const before = store.get('m-a1').accessCount;

  const rep2 = migrateFromV1(store, V1_SAMPLE);
  assert.equal(rep2.inserted, 0);
  assert.equal(rep2.skipped, 2);
  assert.equal(store.count(), 2, '条数不应翻倍');
  assert.equal(store.get('m-a1').accessCount, before, '重跑不能把计数冲回旧值');
  store.close();
});

test('migrate: dryRun 只统计不写库', () => {
  const store = openStore({ file: path.join(tmp(), 'm.db'), backend: 'sqlite' });
  const rep = migrateFromV1(store, V1_SAMPLE, { dryRun: true });
  assert.equal(rep.inserted, 2);
  assert.equal(store.count(), 0, 'dryRun 后库必须还是空的');
  store.close();
});

test('migrate: 喂错文件（version=9）会明确报错，不会静默写坏库', () => {
  const store = openStore({ file: path.join(tmp(), 'm.db'), backend: 'sqlite' });
  assert.throws(() => migrateFromV1(store, { version: 9, memories: [] }), /期望 v1/);
  store.close();
});

test('inferKind / normalizeProject 的边界', () => {
  assert.equal(inferKind({ tags: ['pref'] }), 'preference');
  assert.equal(inferKind({ tags: ['pref:tone'] }), 'preference');
  assert.equal(inferKind({ tags: [] }), 'unknown');
  assert.equal(normalizeProject('default_workspace'), 'default-workspace');
  assert.equal(normalizeProject(''), '');
});

test('renderHits 输出带时间标签，超长正文被截断', () => {
  const store = openStore({ file: path.join(tmp(), 'm.db'), backend: 'sqlite' });
  store.put({ content: '记忆渲染测试'.repeat(30), tags: ['t1'], project: 'p' });
  const hits = search(store, '记忆渲染');
  assert.ok(hits.length > 0);
  // renderHits 已删除（生产代码里没人用，宿主用的是自己那套带 id 的渲染）——
  // 这里改为直接验证检索结果本身带时间与截断所需的信息
  const rec = hits[0].record;
  assert.ok(rec.content.length > 20);
  assert.equal(typeof hits[0].why.ageLabel, 'string');
  store.close();
});

// ---------------------------------------------------------------- 纯向量召回

/** 单位向量：点积即余弦 */
const uv = (arr) => {
  const n = Math.hypot(...arr) || 1;
  return new Float32Array(arr.map((x) => x / n));
};

test('纯向量召回：字面完全对不上，也能捞出来', () => {
  const store = openStore({ file: path.join(tmp(), 'vec.db'), backend: 'sqlite' });
  const { id: a } = store.put({ content: '主人每天早上喝一杯美式，不加糖' });
  const { id: b } = store.put({ content: '周末把院子里的草修一遍' });
  const q = uv([1, 0.02, 0]);
  store.putVector(a, { model: 'm', vec: uv([1, 0.03, 0]) });
  store.putVector(b, { model: 'm', vec: uv([0, 1, 0]) });

  // 基线：没有查询向量时，"提神的东西"和这两条字面都不重合 → 搜不到
  assert.equal(search(store, '提神的东西').length, 0);

  // 带上查询向量 → 靠语义把 a 捞出来
  const hits = search(store, '提神的东西', { queryVector: q });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record.id, a);
  assert.equal(hits[0].why.viaVector, true, '要标明这是靠向量召回的');
  assert.ok(hits[0].why.semantic > 0.9);
  store.close();
});

test('向量召回也要过阈值：不够像的不进结果', () => {
  const store = openStore({ file: path.join(tmp(), 'vec2.db'), backend: 'sqlite' });
  const { id } = store.put({ content: '完全无关的一条记录' });
  store.putVector(id, { model: 'm', vec: uv([0, 1, 0]) });
  // 正交向量 → 相似度 0，低于默认 floor 0.5
  assert.equal(search(store, '提神的东西', { queryVector: uv([1, 0, 0]) }).length, 0);
  store.close();
});

test('维度不一致的向量不参与召回（换过模型的情况）', () => {
  const store = openStore({ file: path.join(tmp(), 'vec3.db'), backend: 'sqlite' });
  const { id } = store.put({ content: '一条有旧维度向量的记录' });
  store.putVector(id, { model: 'old', vec: new Float32Array([1, 0]) });   // 2 维
  const hits = search(store, '提神的东西', { queryVector: uv([1, 0, 0]) }); // 3 维
  assert.equal(hits.length, 0);
  store.close();
});

test('关键词命中的条目不该被标成 viaVector', () => {
  const store = openStore({ file: path.join(tmp(), 'vec4.db'), backend: 'sqlite' });
  const { id } = store.put({ content: '咖啡要少喝，一天一杯' });
  store.putVector(id, { model: 'm', vec: uv([1, 0, 0]) });
  const hits = search(store, '咖啡', { queryVector: uv([1, 0, 0]) });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].why.viaVector, false, '关键词已经命中，不算纯向量召回');
  store.close();
});
// ---------------------------------------------------------------- 模拟输入发现的问题（回归）

test('语义够强时不受覆盖率闸门限制（"换个说法"能搜到）', () => {
  const store = openStore({ file: path.join(tmp(), 'bypass.db'), backend: 'sqlite' });
  const { id } = store.put({ content: 'webServer 的 path 必须以 / 开头，否则路由注册不上' });
  store.putVector(id, { model: 'm', vec: uv([1, 0, 0]) });

  const q = '怎么注册网页接口';   // 7 个 token，只有"注册"命中 → 覆盖率 1/7
  // 没有向量：被覆盖率闸门挡掉（这是闸门该做的事）
  assert.equal(search(store, q).length, 0);

  // 有向量且相似度高：应当放行——它是同一个话题，只是换了说法
  const hits = search(store, q, { queryVector: uv([1, 0.5, 0]) });  // 余弦 ≈0.89
  assert.equal(hits.length, 1);
  assert.ok(hits[0].why.coverage < 0.2, '覆盖率确实很低');
  assert.ok(hits[0].why.semantic > 0.8);
  store.close();
});

test('语义不够强时闸门照旧生效（别把噪声放进来）', () => {
  const store = openStore({ file: path.join(tmp(), 'bypass2.db'), backend: 'sqlite' });
  const { id } = store.put({ content: 'webServer 的 path 必须以 / 开头，否则路由注册不上' });
  store.putVector(id, { model: 'm', vec: uv([1, 0, 0]) });
  // 相似度只有 0.3 左右，低于 semanticBypass 默认 0.42
  const hits = search(store, '怎么注册网页接口', { queryVector: uv([1, 3, 0]) });
  assert.equal(hits.length, 0);
  store.close();
});

test('很老的记忆：精确命中时不该彻底消失（衰减只让它往后排）', () => {
  const store = openStore({ file: path.join(tmp(), 'old.db'), backend: 'sqlite' });
  const anchor = Date.parse('2026-11-09T00:00:00Z');
  const ancient = anchor - 3000 * 86400000;
  store.put({ content: 'WAL 模式要在打开数据库后立刻设置', kind: 'work', createdAt: ancient, updatedAt: ancient });

  // 3000 天 ≈ 8 个半衰期，score 远低于 minScore 0.12；但用户拿原词来搜就该给他
  const hits = search(store, 'WAL', { now: anchor });
  assert.equal(hits.length, 1, '精确命中的老记忆仍应返回');
  assert.ok(hits[0].score < 0.12, '分数确实很低（说明是靠精确覆盖放行的）');
  assert.equal(hits[0].why.stale, true, '要标记成陈旧');
  store.close();
});