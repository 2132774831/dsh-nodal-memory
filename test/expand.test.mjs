/**
 * 图扩展召回测试（v2：共现边已退出扩展路径）
 *
 * 盯五件事：
 *   1. 同一次对话的记忆能补进来（真实事件）
 *   2. 老数据按时间推断，且要降权、要标注
 *   3. 同类事（跨项目但共享标签 + 稀有词）能补进来
 *   4. **共现边不再参与**——这是本轮最重要的回归测试
 *   5. 预算与相关性下限真的生效
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openStore, search } = await import('../src/core/index.js');
const { expandByGraph, GRAPH_EXPAND } = await import('../src/core/expand.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-expand2-'));
  return openStore({ file: path.join(dir, 'e.db'), backend: 'sqlite' });
}

const DAY = 86400000;

test('命中够多时不扩展', () => {
  const store = mkStore();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    store.put({ content: '数据库迁移步骤第 ' + i + ' 条', kind: 'work', createdAt: now, updatedAt: now });
  }
  const hits = search(store, '数据库迁移', { limit: 5 });
  assert.ok(hits.length >= 3, '前提：命中应 >=3，实际 ' + hits.length);
  assert.equal(expandByGraph(store, hits).length, hits.length);
  store.close();
});

test('同一次对话的记忆：命中一条能带出另一条', () => {
  const store = mkStore();
  const now = Date.now();
  const sid = 'sess-111';
  store.put({ content: '修复了玄武岩项目的端口冲突', kind: 'work', createdAt: now, updatedAt: now, sessionId: sid });
  store.put({ content: '顺手把发布脚本也改了', kind: 'work', createdAt: now + 1000, updatedAt: now + 1000, sessionId: sid });
  // 其它会话里无关的
  store.put({ content: '完全无关的一条', kind: 'work', createdAt: now, updatedAt: now, sessionId: 'sess-999' });

  const hits = search(store, '玄武岩项目的端口冲突', { limit: 5 });
  assert.ok(hits.length < 3, '前提：命中少');
  const out = expandByGraph(store, hits);
  assert.ok(out.length > hits.length, '应该补进来');
  const added = out.filter((r) => r.why && r.why.graphExpanded);
  assert.ok(added.some((r) => r.record.content.includes('发布脚本')), '同会话那条要补进来');
  assert.ok(added.every((r) => r.why.via === 'session'), '来源应标 session');
  assert.ok(!added.some((r) => r.record.content.includes('完全无关')), '别的会话不该进来');
  store.close();
});

test('老数据没有会话 id：按时间推断，并且要降权', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({ content: '端口冲突的处理办法（主）', kind: 'work', createdAt: now, updatedAt: now });
  store.put({ content: '同一时段写的另一条', kind: 'work', createdAt: now + 2 * 60000, updatedAt: now });
  store.put({ content: '很久以后写的', kind: 'work', createdAt: now + 10 * DAY, updatedAt: now });

  const hits = search(store, '端口冲突的处理办法', { limit: 5 });
  const out = expandByGraph(store, hits);
  const added = out.filter((r) => r.why && r.why.graphExpanded);
  assert.ok(added.some((r) => r.record.content.includes('同一时段')), '时间窗内的要补');
  assert.ok(added.every((r) => r.why.via === 'inferred'), '来源应标 inferred');
  // 推断边的分数要低于同为 session 的权重
  const inferred = added[0].score;
  assert.ok(inferred < (hits[0].score || 1) * GRAPH_EXPAND.weight, '推断要更进一步降价');
  store.close();
});

test('同类事：不同项目但共享标签 + 稀有词，能连上', () => {
  const store = mkStore();
  const now = Date.now();
  store.put({
    content: 'EasyEDA 封装库导入时报引脚重复，解决办法是先清缓存再重导',
    kind: 'work', tags: ['easyeda', 'pcb'], project: 'proj-a', createdAt: now, updatedAt: now,
  });
  // B 故意不含查询词，且**时间拉开**：这样它只能被「同类事」这条边带进来
  // （否则同时间写入会先走"时间推断"那条路，测不到 kindred）
  store.put({
    content: 'EasyEDA 另一个项目里踩的坑：清缓存再重导就好了',
    kind: 'work', tags: ['easyeda', 'pcb'], project: 'proj-b',
    createdAt: now + 5 * DAY, updatedAt: now + 5 * DAY,
  });

  const hits = search(store, '封装库导入 引脚重复', { limit: 5 });
  assert.ok(hits.length < 3, '前提：命中少，实际 ' + hits.length);
  const out = expandByGraph(store, hits);
  const added = out.filter((r) => r.why && r.why.graphExpanded);
  assert.ok(added.some((r) => r.why.via === 'kindred'), '同类事要补进来');
  store.close();
});

test('回归：共现边不再参与扩展（砍掉自增强回路）', () => {
  const store = mkStore();
  const now = Date.now();
  const a = store.put({ content: '被一起注入过很多次的那条', kind: 'work', createdAt: now, updatedAt: now });
  // 故意把时间拉开一天：排除「时间推断」这条路的干扰，专门验共现不生效
  const b = store.put({ content: '共现搭子（无标签无会话无同主题）', kind: 'work', createdAt: now - 5 * DAY, updatedAt: now - 5 * DAY });
  // 制造很强的共现关系
  for (let i = 0; i < 5; i++) store.recordCooccur([a.id, b.id]);

  const hits = search(store, '被一起注入过很多次', { limit: 5 });
  const out = expandByGraph(store, hits);
  assert.equal(out.length, hits.length, '共现再强也不许补进来');
  store.close();
});

test('预算与相关性下限生效', () => {
  const store = mkStore();
  const now = Date.now();
  const sid = 'sess-budget';
  store.put({ content: '主命中：端口冲突', kind: 'work', createdAt: now, updatedAt: now, sessionId: sid });
  // 一条超长同会话记忆（超过总预算）+ 一条很短的
  store.put({ content: '超长'.repeat(400), kind: 'work', createdAt: now + 1, updatedAt: now + 1, sessionId: sid });
  store.put({ content: '短的补充', kind: 'work', createdAt: now + 2, updatedAt: now + 2, sessionId: sid });

  const hits = search(store, '端口冲突', { limit: 5 });
  const out = expandByGraph(store, hits);
  const added = out.filter((r) => r.why && r.why.graphExpanded);
  assert.ok(added.every((r) => String(r.record.content).length <= GRAPH_EXPAND.maxChars), '超预算的不该进来');
  assert.ok(added.length <= GRAPH_EXPAND.maxAdded, '不能超过条数上限');
  store.close();
});
