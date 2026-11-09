/**
 * 直觉层测试：矛盾粗筛 + 复习候选。
 *
 * 这组测试的重点不是"能不能挑出来"，而是**能不能不挑出不该挑的**。
 * 误报比漏报烦人得多：漏一条没人知道，误报十条就没人再看了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, reviewCandidates } from '../src/core/index.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const day = 86400000;

const rec = (id, content, over = {}) => ({
  id, content, tags: over.tags || [], project: over.project || 'p',
  kind: 'unknown', importance: over.importance || 'important',
  createdAt: over.createdAt ?? NOW, accessCount: over.accessCount ?? 0,
  deletedAt: over.deletedAt ?? null,
});

/* ── 矛盾：该挑出来的 ── */

test('同一件事 + 互斥表述 → 挑出来', () => {
  const list = [
    rec('a', '部署流程：使用 Docker 部署，配置文件在 C:\\app\\config.yml，先备份数据库再升级'),
    rec('b', '部署流程：不使用 Docker 部署，直接跑二进制，配置文件在 D:\\srv\\config.yml，升级后要重启服务'),
  ];
  const { pairs } = findConflicts(list, { now: NOW });
  assert.equal(pairs.length, 1, '应该挑出这一对');
  assert.match(pairs[0].reasons.join('|'), /互斥|关键值/);
  assert.ok(pairs[0].score > 0);
});

test('同一件事 + 关键值不同（版本/路径）→ 挑出来', () => {
  const list = [
    rec('a', '本机插件装在 C:\\plugins\\dsh-local-memory，版本 1.1.3，用 link 方式安装'),
    rec('b', '本机插件装在 D:\\tools\\dsh-local-memory，版本 2.0.0，用 link 方式安装'),
  ];
  const { pairs } = findConflicts(list, { now: NOW });
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].reasons.join('|'), /关键值不同/);
});

/* ── 矛盾：不该挑出来的（更重要） ── */

test('同主题但只是详略不同 → 不算矛盾', () => {
  const list = [
    rec('a', '部署流程分三步：准备环境、执行脚本、检查日志'),
    rec('b', '部署流程里的日志要保留三十天，方便以后回溯问题'),
  ];
  assert.equal(findConflicts(list, { now: NOW }).pairs.length, 0);
});

test('两条不相干、只是都提到版本号 → 不算矛盾（真实误报案例）', () => {
  const list = [
    rec('a', '剪映专业版在本机的两个目录，11.1.0.14268 是旧版安装残留，0 文件'),
    rec('b', '本机 Python 只剩 3.14.6，位于 C:\\Users\\Administrator\\AppData 下'),
  ];
  assert.equal(findConflicts(list, { now: NOW }).pairs.length, 0, '两条各说各的，没有矛盾');
});

test('长文本不该被长度摊薄掉（Jaccard 的坑，回归）', () => {
  const filler = '这段是用来填充长度的无关内容，讲的是怎么整理文件夹和备份数据。';
  const a = '插件安装方式：使用 link 安装，改 package.json 的 main 就等于装机。' + filler.repeat(12);
  const b = '插件安装方式：不使用 link 安装，要发布到市场再装。' + filler.repeat(12);
  const { pairs } = findConflicts([rec('a', a), rec('b', b)], { now: NOW });
  assert.equal(pairs.length, 1, '两条长文说的就是同一件事，不能被稀释到挑不出来');
});

/* ── 复习候选 ── */

test('复习候选：老、重要、没被用过的排前面', () => {
  const list = [
    rec('old-important', '一条很久以前写下的重要结论', { createdAt: NOW - 120 * day, importance: 'key' }),
    rec('old-used', '一条很久以前但经常被用到的结论', { createdAt: NOW - 120 * day, accessCount: 40 }),
    rec('new', '刚写下的结论', { createdAt: NOW - 1 * day, importance: 'key' }),
  ];
  const rows = reviewCandidates(list, { now: NOW });
  assert.equal(rows.length, 1, '只有"老 + 重要 + 没用过"的那条该复习');
  assert.equal(rows[0].id, 'old-important');
  assert.match(rows[0].why, /一次都没被用过/);
});

test('复习候选：太新的不出现（刚写的不叫遗忘风险）', () => {
  const list = [rec('fresh', '昨天刚写的', { createdAt: NOW - 2 * day, importance: 'key' })];
  assert.equal(reviewCandidates(list, { now: NOW, minDays: 14 }).length, 0);
});

test('复习候选：已删除的不出现', () => {
  const list = [rec('gone', '已删除的', { createdAt: NOW - 90 * day, deletedAt: NOW - 10 * day })];
  assert.equal(reviewCandidates(list, { now: NOW }).length, 0);
});

test('复习候选：按分数降序，并带上天数和次数', () => {
  const list = [
    rec('a', 'A', { createdAt: NOW - 30 * day }),
    rec('b', 'B', { createdAt: NOW - 200 * day }),
  ];
  const rows = reviewCandidates(list, { now: NOW });
  assert.equal(rows[0].id, 'b', '更老的分更高');
  assert.ok(rows[0].days >= 199);
  assert.equal(typeof rows[0].accessCount, 'number');
});

test('数字+单位不同也算关键值冲突（30 秒 vs 45 秒，视频制作时发现的缺口）', () => {
  const list = [
    rec('a', 'nebula-api 的网关超时设成 30 秒，配置在 config/gateway.yaml 的 timeout 字段里'),
    rec('b', 'nebula-api 的网关超时设成 45 秒，配置在 config/gateway.yaml 的 timeout 字段里'),
  ];
  const { pairs } = findConflicts(list, { now: NOW });
  assert.equal(pairs.length, 1, '只差一个数字，必须能挑出来');
  assert.match(pairs[0].reasons.join('|'), /关键值不同/);
});

test('纯数字但没有单位的不算关键值（避免"第 3 步"和"第 5 步"被当冲突）', () => {
  const list = [
    rec('a', '部署流程第 3 步是检查日志'),
    rec('b', '部署流程第 5 步是检查日志'),
  ];
  assert.equal(findConflicts(list, { now: NOW }).pairs.length, 0);
});
