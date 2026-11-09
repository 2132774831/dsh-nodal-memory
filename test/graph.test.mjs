/**
 * 关系图算法测试（纯函数，不需要宿主）。
 *
 * 重点验证的是"别画成毛线球"那几条防线：
 *   - 泛滥标签不连边
 *   - 边去重但保留全部理由
 *   - 边数上限生效
 *   - 孤岛能被识别出来
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/core/graph.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const day = 86400000;

function rec(id, over = {}) {
  return {
    id,
    content: over.content || ('记忆 ' + id),
    tags: over.tags || [],
    project: over.project || '',
    kind: over.kind || 'unknown',
    importance: over.importance || 'important',
    createdAt: over.createdAt ?? NOW,
    accessCount: over.accessCount ?? 0,
  };
}

test('共享标签会连边，并带上 idf 权重与标签名', () => {
  // 时间错开 20 天以上，避免"时间相邻"边干扰断言
  const g = buildGraph([
    rec('a', { tags: ['topic:x'], createdAt: NOW - 40 * day }),
    rec('b', { tags: ['topic:x'], createdAt: NOW - 20 * day }),
    rec('c', { tags: ['topic:y'], createdAt: NOW }),
  ], { now: NOW });

  assert.equal(g.nodes.length, 3);
  const tagEdge = g.edges.find((e) => e.kind === 'tag');
  assert.ok(tagEdge, '应有一条标签边');
  assert.deepEqual([tagEdge.source, tagEdge.target].sort(), ['a', 'b']);
  assert.ok(tagEdge.kinds.includes('tag'));
  assert.ok(tagEdge.detail.includes('topic:x'));
  assert.ok(tagEdge.weight > 0);
  assert.equal(g.stats.isolated, 1, 'c 没有共享标签，应是孤岛');
});

test('孤岛判定只看"有语义"的边：时间相邻连了也不算孤岛消除', () => {
  // 三条同一时刻创建、毫无共同标签/项目 → 会被时间边串起来，但语义上仍是孤岛
  const g = buildGraph([
    rec('a', { createdAt: NOW }),
    rec('b', { createdAt: NOW }),
    rec('c', { createdAt: NOW }),
  ], { now: NOW });

  assert.ok(g.edges.every((e) => e.kind === 'time'), '只应有时间边');
  assert.equal(g.stats.isolated, 3, '三条都该算孤岛');
  for (const n of g.nodes) {
    assert.ok(n.degree > 0, '布局上它们有连接');
    assert.equal(n.linkDegree, 0, '但语义上没有关系');
    assert.equal(n.isolated, true);
  }
});

test('共现边的权重高于普通标签边，且类型标为 cooccur', () => {
  const g = buildGraph([
    rec('a', { tags: ['topic:rare'] }),
    rec('b', { tags: ['topic:rare'] }),
  ], { now: NOW, cooccur: [{ a: 'a', b: 'b', count: 5 }] });

  const e = g.edges[0];
  assert.equal(e.kind, 'cooccur', '共现优先级最高');
  assert.ok(e.kinds.includes('tag'), '同一对节点同时有标签关系也要记下来');
  assert.match(e.detail.join(','), /共同命中 5 次/);
  assert.ok(e.weight > 1.5, '共现权重应明显高于单纯标签边');
});

test('泛滥标签（超过 30% 节点）不连边，避免蜘蛛网', () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(rec('m' + i, { tags: ['topic:huge'] }));
  const g = buildGraph(records, { now: NOW, dominantTagRatio: 0.3 });

  assert.deepEqual(g.stats.dominantTags, ['topic:huge']);
  assert.equal(g.edges.filter((e) => e.kind === 'tag').length, 0, '泛滥标签不应产生标签边');
});

test('同项目连边', () => {
  const g = buildGraph([
    rec('a', { project: 'p1' }),
    rec('b', { project: 'p1' }),
    rec('c', { project: 'p2' }),
  ], { now: NOW });
  const e = g.edges.find((x) => x.kind === 'project');
  assert.ok(e);
  assert.deepEqual([e.source, e.target].sort(), ['a', 'b']);
  assert.ok(e.detail.includes('p1'));
});

test('时间相邻只连最近的一条，不会 O(n²) 糊成一团', () => {
  const g = buildGraph([
    rec('a', { createdAt: NOW - 3 * day }),
    rec('b', { createdAt: NOW - 2 * day }),
    rec('c', { createdAt: NOW - 1 * day }),
  ], { now: NOW, timeWindowDays: 7 });

  const timeEdges = g.edges.filter((e) => e.kind === 'time');
  assert.equal(timeEdges.length, 2, '三个点最多两条时间边');
});

test('边去重：同一对节点只有一条边，但保留全部理由', () => {
  const g = buildGraph([
    rec('a', { tags: ['t1', 't2'], project: 'p' }),
    rec('b', { tags: ['t1', 't2'], project: 'p' }),
  ], { now: NOW });

  assert.equal(g.edges.length, 1, '同一对只留一条边');
  const e = g.edges[0];
  assert.ok(e.kinds.includes('tag'));
  assert.ok(e.kinds.includes('project'));
  assert.ok(e.detail.length >= 2, '两个共享标签都应记进 detail');
});

test('超大分组不连边（真实数据里 59 条同项目 = 1711 条边，纯噪声）', () => {
  // 60 个点，其中 15 个共享标签 mid：15 < 60*0.3=18（不算泛滥），但 > maxGroupSize=12
  const records = [];
  for (let i = 0; i < 15; i++) records.push(rec('mid' + i, { tags: ['mid'], createdAt: NOW - i * 30 * day }));
  for (let i = 0; i < 45; i++) records.push(rec('x' + i, { createdAt: NOW - (100 + i) * 30 * day }));

  const g = buildGraph(records, { now: NOW, maxGroupSize: 12 });
  assert.equal(g.edges.filter((e) => e.kind === 'tag').length, 0, '超大分组不应连标签边');
  const skipped = g.stats.oversizedGroups.find((x) => x.name === 'mid');
  assert.ok(skipped, '应报告被跳过的分组');
  assert.equal(skipped.size, 15);
});

test('maxEdges 生效并上报被截断数量', () => {
  const records = [];
  for (let i = 0; i < 20; i++) records.push(rec('m' + i, { tags: ['shared'] }));
  const g = buildGraph(records, { now: NOW, maxEdges: 10, dominantTagRatio: 0.9 });
  assert.equal(g.edges.length, 10);
  assert.ok(g.stats.truncatedEdges > 0);
});

test('degree / isolated 计算正确', () => {
  const g = buildGraph([
    rec('a', { tags: ['t'], createdAt: NOW - 40 * day }),
    rec('b', { tags: ['t'], createdAt: NOW - 20 * day }),
    rec('solo', { createdAt: NOW }),
  ], { now: NOW });

  const a = g.nodes.find((n) => n.id === 'a');
  const solo = g.nodes.find((n) => n.id === 'solo');
  assert.equal(a.degree, 1);
  assert.equal(a.isolated, false);
  assert.equal(solo.degree, 0);
  assert.equal(solo.isolated, true);
});

test('节点带上渲染要用的字段（标签、项目、类别、年龄）', () => {
  const g = buildGraph([rec('a', {
    content: '一条很长的记忆内容'.repeat(10),
    tags: ['x'], project: 'p', kind: 'work', importance: 'key',
    createdAt: NOW - 10 * day,
  })], { now: NOW, labelChars: 20 });

  const n = g.nodes[0];
  assert.equal(n.project, 'p');
  assert.equal(n.kind, 'work');
  assert.equal(n.importance, 'key');
  assert.deepEqual(n.tags, ['x']);
  assert.equal(n.ageDays, 10);
  assert.ok(n.label.length <= 21, 'label 应被截断');
});

test('共现里引用了已删除的 id 不会炸，也不会造出假节点', () => {
  const g = buildGraph([rec('a')], { now: NOW, cooccur: [{ a: 'a', b: 'gone', count: 3 }] });
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 0);
});

/* ── 语义连线（需要向量） ── */

const unit = (x, y) => {
  const n = Math.hypot(x, y) || 1;
  return new Float32Array([x / n, y / n]);
};
const semanticOnly = (g) => g.edges.filter((e) => e.kind === 'semantic');

test('有向量时按阈值连出语义边，权重就是相似度', () => {
  const records = [rec('a'), rec('b'), rec('c')];
  const vectors = new Map([
    ['a', unit(1, 0)],
    ['b', unit(1, 0.1)],  // 与 a 几乎同向
    ['c', unit(0, 1)],    // 与 a 正交
  ]);
  const g = buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.9 });
  const sem = semanticOnly(g);
  assert.equal(sem.length, 1, '只有 a-b 该连');
  assert.deepEqual([sem[0].source, sem[0].target].sort(), ['a', 'b']);
  assert.ok(sem[0].weight > 0.99, '相似度约 0.995，权重应贴近 1');
  assert.ok(sem[0].detail.join().includes('语义'));
});

test('低于阈值不连（相似度不够就不该画线）', () => {
  const records = [rec('a'), rec('b')];
  const vectors = new Map([['a', unit(1, 0)], ['b', unit(1, 1)]]); // 约 0.707
  assert.equal(semanticOnly(buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.8 })).length, 0);
  assert.equal(semanticOnly(buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.6 })).length, 1);
});

test('每点最多保留 topK 条语义边（否则泛主题记忆会连成一片）', () => {
  const records = [rec('center')];
  const vectors = new Map();
  vectors.set('center', unit(1, 0));
  // 5 个邻居都在 0.9 以上的相似度
  for (let i = 0; i < 5; i++) {
    records.push(rec('n' + i));
    vectors.set('n' + i, unit(1, i * 0.02));
  }
  const g = buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.8, semanticTopK: 2 });
  const sem = semanticOnly(g);
  // center 只保留 2 条；邻居彼此也相似，但每人也只留 2 条
  const centerDegree = sem.filter((e) => e.source === 'center' || e.target === 'center').length;
  assert.equal(centerDegree, 2, 'center 应只连出 2 条');
});

test('维度不一致的向量被忽略（换过模型的情况）', () => {
  const records = [rec('a'), rec('b')];
  const vectors = new Map([
    ['a', new Float32Array([1, 0, 0])],
    ['b', new Float32Array([1, 0])],
  ]);
  assert.equal(semanticOnly(buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.1 })).length, 0);
});

test('没有向量时语义段整段跳过，其它关系不受影响', () => {
  const g = buildGraph([
    rec('a', { tags: ['t'], createdAt: NOW - 40 * day }),
    rec('b', { tags: ['t'], createdAt: NOW - 20 * day }),
  ], { now: NOW, vectors: null });
  assert.equal(semanticOnly(g).length, 0);
  assert.equal(g.edges.filter((e) => e.kind === 'tag').length, 1, '标签边照旧');
  assert.equal(g.stats.semanticSkipped, null);
});

test('点数超过上限时跳过语义连线，并在 stats 里说明原因', () => {
  const records = [];
  const vectors = new Map();
  for (let i = 0; i < 6; i++) {
    records.push(rec('n' + i));
    vectors.set('n' + i, unit(1, i * 0.01));
  }
  const g = buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.5, semanticMaxNodes: 3 });
  assert.equal(semanticOnly(g).length, 0);
  assert.match(String(g.stats.semanticSkipped), /超过上限/);
});

test('stats.edgeKinds 汇总各类边数（同一对多因合并时只算最强的那个）', () => {
  // 用互相正交的四维向量把两组彻底隔开，避免测试数据自己造出额外的语义边
  const unit4 = (w, x, y, z) => {
    const n = Math.hypot(w, x, y, z) || 1;
    return new Float32Array([w / n, x / n, y / n, z / n]);
  };
  const records = [
    rec('a', { tags: ['t'], createdAt: NOW - 40 * day }),
    rec('b', { tags: ['t'], createdAt: NOW - 20 * day }),
    rec('c', { createdAt: NOW - 60 * day }),
    rec('d', { createdAt: NOW - 80 * day }),
  ];
  const vectors = new Map([
    ['a', unit4(1, 0, 0, 0)], ['b', unit4(0, 1, 0, 0)],   // 只有标签关系
    ['c', unit4(0, 0, 1, 0)], ['d', unit4(0, 0, 1, 0.01)], // 只有语义关系
  ]);
  const g = buildGraph(records, { now: NOW, vectors, semanticThreshold: 0.9 });
  assert.equal(g.stats.edgeKinds.tag, 1);
  assert.equal(g.stats.edgeKinds.semantic, 1);

  // 同一对既有标签又有语义时：只保留一条边，kind 取优先级高的，但 kinds 里两个都记着
  const both = buildGraph([
    rec('x', { tags: ['t'], createdAt: NOW - 40 * day }),
    rec('y', { tags: ['t'], createdAt: NOW - 20 * day }),
  ], { now: NOW, vectors: new Map([['x', unit(1, 0)], ['y', unit(1, 0.01)]]), semanticThreshold: 0.9 });
  const edge = both.edges.find((e) => e.kinds.includes('tag') && e.kinds.includes('semantic'));
  assert.ok(edge, '应有一条同时记录两种关系的边');
  assert.equal(edge.kind, 'tag', 'kind 取优先级高的那个（tag > semantic）');
});
