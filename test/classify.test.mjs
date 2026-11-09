/**
 * 类别推断测试。
 * 重点同样是"不该猜的别乱猜"——误判会改半衰期，一条工作记忆被当成情感会 60 天就衰减掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inferKindFromContent } from '../src/core/index.js';

test('情绪 + 时间锚点 → 情感', () => {
  const r = inferKindFromContent('今天有点烦躁，不太想干活');
  assert.equal(r.kind, 'emotion');
});

test('长期偏好 → 偏好', () => {
  const r = inferKindFromContent('主人不喜欢被叫老板，以后都叫主人');
  assert.equal(r.kind, 'preference');
});

test('技术词够多 → 工作', () => {
  const r = inferKindFromContent('接口 /v2 的配置字段改了，需要重新部署脚本并跑测试');
  assert.equal(r.kind, 'work');
});

test('证据不足就留未分类（宁缺勿滥）', () => {
  assert.equal(inferKindFromContent('明天去一趟银行').kind, 'unknown');
  assert.equal(inferKindFromContent('').kind, 'unknown');
});

test('带标签的以标签为准', () => {
  assert.equal(inferKindFromContent('随便一句话', { tags: ['pref'] }).kind, 'preference');
  assert.equal(inferKindFromContent('随便一句话', { tags: ['emotion'] }).kind, 'emotion');
});

test('技术记忆里出现"必须"不该被判成偏好（真实误判回归）', () => {
  // 这条正文里有"必须"，早期词表把"必须"当偏好词，结果工作笔记被划成偏好
  const r = inferKindFromContent('给关系图做布局时，组规模超过 12 就必须整组不连');
  assert.notEqual(r.kind, 'preference');
});

test('只提一个技术词不足以判工作（详略差异不该改变类别）', () => {
  const r = inferKindFromContent('那个文件我看过了');
  assert.equal(r.kind, 'unknown');
});

test('情绪词只出现在技术语境里，不算情感', () => {
  // "报错很烦人"是工作记录，不是情绪记录
  const r = inferKindFromContent('这个接口报错很烦人，日志里全是超时');
  assert.notEqual(r.kind, 'emotion');
});
