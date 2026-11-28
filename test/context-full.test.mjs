import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, createRecallHandler } from '../src/host/recall.js';
import { buildBrief } from '../src/host/prompt.js';
import { openStore } from '../src/core/index.js';

test('estimateTokens: 中文按字、英文按 3.5 字符', () => {
  assert.equal(estimateTokens([]), 0);
  assert.equal(estimateTokens([{ role: 'user', content: '字'.repeat(100) }]), 100);
  assert.equal(estimateTokens([{ role: 'user', content: 'a'.repeat(350) }]), 100);
  // 数组形式的 content
  assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'text', text: '字'.repeat(50) }] }]), 50);
});

test('常驻提示词里不再有「上下文快满」那行（改成按需注入）', () => {
  const brief = buildBrief({
    config: { enabled: true, injectBrief: true, organizeOnContextFull: true },
    count: 10,
    noKind: 0,
    review: { overdue: false },
  });
  assert.equal(brief.includes('上下文快满时先落盘'), false);
});

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmctx-test-'));
  const store = openStore({ file: path.join(dir, 't.db') });
  store.put({ content: '项目约定：所有回复用中文', kind: 'work', importance: 'key' });
  return { store, dir };
}

const baseCfg = (over = {}) => ({
  enabled: true,
  autoRecall: true,
  autoRecallMinChars: 1,
  autoRecallMaxItems: 5,
  features: { pinAlways: false, softForget: false },
  halfLifeDays: 365,
  kindWeight: {},
  forgetAfterDays: 3650,
  organizeOnContextFull: true,
  contextWindowTokens: 10000,
  contextFullRatio: 0.75,
  ...over,
});

async function runForms(handler, msgs, sid) {
  const d = await handler({ agent: { id: sid } }, async () => ({ kind: 'enter', messages: msgs }));
  return (d.messages || []).filter((m) => m.source && m.source.kind === 'dsh-local-memory').map((m) => m.source.form);
}

test('上下文没满时不注入提醒', async () => {
  const { store, dir } = makeCtx();
  const h = createRecallHandler({ getStore: () => store, getConfig: () => baseCfg() });
  const forms = await runForms(h, [{ role: 'user', content: [{ type: 'text', text: '今天天气不错' }] }], 'short-1');
  assert.equal(forms.includes('context-full'), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('上下文超过阈值注入一次，同会话不重复，新会话会再提醒', async () => {
  const { store, dir } = makeCtx();
  const h = createRecallHandler({ getStore: () => store, getConfig: () => baseCfg() });
  const big = [{ role: 'user', content: [{ type: 'text', text: '上下文'.repeat(5000) }] }];
  assert.equal((await runForms(h, big, 'big-1')).includes('context-full'), true);
  assert.equal((await runForms(h, big, 'big-1')).includes('context-full'), false);
  assert.equal((await runForms(h, big, 'big-2')).includes('context-full'), true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关掉开关后不再提醒', async () => {
  const { store, dir } = makeCtx();
  const h = createRecallHandler({ getStore: () => store, getConfig: () => baseCfg({ organizeOnContextFull: false }) });
  const big = [{ role: 'user', content: [{ type: 'text', text: '上下文'.repeat(5000) }] }];
  const forms = await runForms(h, big, 'off-1');
  assert.equal(forms.includes('context-full'), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('阈值可调：容量放大后同样的对话不再触发', async () => {
  const { store, dir } = makeCtx();
  const h = createRecallHandler({ getStore: () => store, getConfig: () => baseCfg({ contextWindowTokens: 1000000 }) });
  const big = [{ role: 'user', content: [{ type: 'text', text: '上下文'.repeat(5000) }] }];
  const forms = await runForms(h, big, 'wide-1');
  assert.equal(forms.includes('context-full'), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
