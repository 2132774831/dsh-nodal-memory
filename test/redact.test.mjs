/**
 * PII / 密钥脱敏 + 状态追加（updates）。
 *
 * 这两块是"需求文档里明确要求、但之前完全没实现"的部分：
 *   - 脱敏：记忆库是明文文件，开了语义检索还会把正文发到外部端点
 *   - updates：只留了表结构没留写入路径，"电脑坏了→买了新的"这种永远记不上
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskPII } from '../src/core/redact.js';
import { openStore } from '../src/core/store.js';

function tmpFile(name = 'x.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-redact-'));
  return path.join(dir, name);
}

/* ── 脱敏：该遮的必须遮 ── */

test('脱敏：API key / GitHub token / AWS key / Bearer', () => {
  const cases = [
    '我的 key 是 sk-ws-abcdefghijklmnopqrstuvwxyz1234',
    '用这个 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 推送',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
  ];
  for (const c of cases) {
    const r = maskPII(c);
    assert.ok(r.hits.length > 0, '应该被遮住：' + c);
    assert.ok(!/sk-ws-|ghp_|AKIA|Bearer\s+eyJ/.test(r.text), '明文还在：' + r.text);
  }
});

test('脱敏：手机号 / 邮箱 / 身份证', () => {
  const r1 = maskPII('我的手机号是 13812345678，随时联系');
  assert.equal(r1.text, '我的手机号是 [已脱敏:手机号]，随时联系');

  const r2 = maskPII('发到 zhangsan@example.com 就行');
  assert.ok(!r2.text.includes('zhangsan@example.com'));
  assert.ok(r2.text.includes('[已脱敏:邮箱]'));

  const r3 = maskPII('身份证 110101199003071234 记一下');
  assert.ok(!r3.text.includes('110101199003071234'));
});

test('脱敏：键值对保留字段名，只遮值', () => {
  const r = maskPII('password=SuperSecret123');
  assert.ok(r.text.startsWith('password='), '字段名要留着，否则看不懂这里是什么：' + r.text);
  assert.ok(!r.text.includes('SuperSecret123'));
});

test('脱敏：整段私钥', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
  const r = maskPII('看这个 ' + pem);
  assert.ok(!r.text.includes('MIIEow'), '私钥正文必须遮掉');
});

/* ── 脱敏：不该动的别乱动（宁可漏，不可错） ── */

test('不误伤：版本号 / 端口 / 时间 / 哈希 / IP', () => {
  const safe = [
    '版本从 1.1.1 升到 2.0.0',
    '端口 7787 被占用了',
    '2026-11-09T18:56:09+08:00 这次提交',
    'sha256 是 82320783921c9879bea684b04c93f47f54460141f28c3d9b9e59cd608710ea08',
    '服务监听 127.0.0.1:7787',
    '超时设成 30 秒，重试 3 次',
    'npm 包 dsh-local-memory@2.1.3',
  ];
  for (const s of safe) {
    const r = maskPII(s);
    assert.equal(r.text, s, '不该被改：' + s + ' → ' + r.text);
    assert.equal(r.hits.length, 0);
  }
});

test('脱敏是幂等的：同一段文字跑两遍结果一样', () => {
  const src = '手机 13812345678，key sk-abcdefghijklmnopqrst';
  const once = maskPII(src).text;
  const twice = maskPII(once).text;
  assert.equal(once, twice, '第二遍不该再改动（否则每次编辑记忆都会漂移）');
});

test('脱敏：可以关掉（给"我就是要存完整原文"的人留口子）', () => {
  const r = maskPII('手机 13812345678', { enabled: false });
  assert.equal(r.text, '手机 13812345678');
  assert.equal(r.hits.length, 0);
});

test('脱敏：命中时会报出类型和次数（给"已脱敏"提示用）', () => {
  const r = maskPII('手机 13812345678，另一个 13900001111');
  assert.deepEqual(r.hits, [{ type: '手机号', count: 2 }]);
  assert.equal(maskPII('版本 1.1.1').hits.length, 0);
});

/* ── 与 store 的接线 ── */

test('store.put 默认脱敏落盘', () => {
  const file = tmpFile();
  const store = openStore({ file, backend: 'sqlite' });
  const { record } = store.put({ content: '用户手机 13812345678，key sk-abcdefghijklmnopqrst' });
  assert.ok(!record.content.includes('13812345678'), '手机号不能落盘');
  assert.ok(!record.content.includes('sk-abcdefghijklmnopqrst'), 'key 不能落盘');
  // 读回来也是脱敏后的
  assert.ok(!store.get(record.id).content.includes('13812345678'));
  store.close();
});

test('store 可以显式关掉脱敏', () => {
  const file = tmpFile();
  const store = openStore({ file, backend: 'sqlite', maskPII: false });
  const { record } = store.put({ content: '用户手机 13812345678' });
  assert.ok(record.content.includes('13812345678'));
  store.close();
});

/* ── 状态追加 ── */

test('updates：追加进展不动原文，按时间排序', () => {
  const file = tmpFile();
  const store = openStore({ file, backend: 'sqlite' });
  const { record } = store.put({ content: '用户的电脑进水坏了，很焦虑' });

  store.addUpdate(record.id, { text: '买了一台新电脑', at: Date.now() - 86400000 });
  store.addUpdate(record.id, { text: '已经恢复工作，心情变好了', status: 'resolved' });

  const list = store.getUpdates(record.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '买了一台新电脑', '应该按时间正序');
  assert.equal(list[0].status, null);
  assert.equal(list[1].status, 'resolved');

  // 原文一个字都不能变
  const after = store.get(record.id);
  assert.equal(after.content, '用户的电脑进水坏了，很焦虑');
  assert.equal(after.status, 'resolved', '状态要跟着更新');
  store.close();
});

test('updates：给不存在的记忆追加返回 null', () => {
  const store = openStore({ file: tmpFile(), backend: 'sqlite' });
  assert.equal(store.addUpdate('m-not-exist', { text: '随便' }), null);
  store.close();
});

test('updates：空内容不写入', () => {
  const store = openStore({ file: tmpFile(), backend: 'sqlite' });
  const { record } = store.put({ content: '原记忆' });
  assert.equal(store.addUpdate(record.id, { text: '   ' }), null);
  assert.equal(store.getUpdates(record.id).length, 0);
  store.close();
});

test('updates 也走脱敏', () => {
  const store = openStore({ file: tmpFile(), backend: 'sqlite' });
  const { record } = store.put({ content: '原记忆' });
  store.addUpdate(record.id, { text: '新进展：手机 13812345678 打不通' });
  const [u] = store.getUpdates(record.id);
  assert.ok(!u.text.includes('13812345678'), '进展里的手机号也要遮');
  store.close();
});

test('updates 在 JSON 后端同样可用（兜底后端不许功能缺失）', () => {
  const file = tmpFile('x.json');
  const store = openStore({ file, backend: 'json' });
  const { record } = store.put({ content: '原记忆' });
  store.addUpdate(record.id, { text: '进展一', status: 'resolved' });
  store.addUpdate(record.id, { text: '进展二' });
  assert.equal(store.getUpdates(record.id).length, 2);
  assert.equal(store.get(record.id).status, 'resolved');
  store.close();

  // 重开还能读到（要真的落盘）
  const again = openStore({ file, backend: 'json' });
  assert.equal(again.getUpdates(record.id).length, 2);
  assert.equal(again.getUpdates(record.id)[1].text, '进展二');
  again.close();
});
