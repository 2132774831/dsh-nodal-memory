/**
 * 图片库测试：独立于记忆、按时间/说明/关联找、删除后文件也没了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openStore } = await import('../src/core/index.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-media-'));
  return { store: openStore({ file: path.join(dir, 'm.db'), backend: 'sqlite' }), dir };
}

test('图片库：存进去能列出来，按时间倒序', () => {
  const { store } = mkStore();
  const now = Date.now();
  const a = store.putMedia({ file: 'a.jpg', name: 'a.jpg', mime: 'image/jpeg', bytes: 100, note: '第一张', createdAt: now - 10000 });
  const b = store.putMedia({ file: 'b.png', name: 'b.png', mime: 'image/png', bytes: 200, note: '第二张', createdAt: now });
  const list = store.listMedia({});
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id, '新的在前');
  assert.equal(list[1].id, a.id);
  assert.equal(list[0].note, '第二张');
  store.close();
});

test('图片库：按说明关键词 / 标签 / 关联记忆筛', () => {
  const { store } = mkStore();
  const m = store.put({ content: '关联用的记忆' });
  store.putMedia({ file: 'x.jpg', note: '截图：报错信息', tags: ['bug', 'screenshot'], memoryId: m.id });
  store.putMedia({ file: 'y.jpg', note: '随手拍', tags: ['photo'] });

  assert.equal(store.listMedia({ q: '报错' }).length, 1, '按说明搜');
  assert.equal(store.listMedia({ q: 'screenshot' }).length, 1, '按标签搜');
  assert.equal(store.listMedia({ memoryId: m.id }).length, 1, '按关联记忆筛');
  assert.equal(store.listMedia({ q: '不存在的东西' }).length, 0);
  store.close();
});

test('图片库：改说明、软删、彻底删', () => {
  const { store } = mkStore();
  const rec = store.putMedia({ file: 'z.jpg', note: '旧说明' });
  const upd = store.updateMedia(rec.id, { note: '新说明' });
  assert.equal(upd.note, '新说明');

  store.removeMedia(rec.id);
  assert.equal(store.listMedia({}).length, 0, '软删后列表里没有');
  assert.equal(store.listMedia({ includeDeleted: true }).length, 1, '带已删能查到');

  const fileName = store.purgeMedia(rec.id);
  assert.equal(fileName, 'z.jpg', '彻底删要返回文件名，好把实体文件也删了');
  assert.equal(store.getMedia(rec.id), null);
  store.close();
});

test('图片库：不影响记忆条数（两套数据互不干扰）', () => {
  const { store } = mkStore();
  const before = store.count();
  store.putMedia({ file: 'p.jpg' });
  assert.equal(store.count(), before, '存图片不该改变记忆条数');
  assert.equal(store.countMedia(), 1);
  store.close();
});
