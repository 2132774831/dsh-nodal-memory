/**
 * 端到端验证"图扩展召回"（用**真库副本**，绝不碰真库）。
 *
 * 走的是真实代码路径：
 *   - buildTools() → memory_search 工具
 *   - createRecallHandler() → 自动回忆注入
 *
 * 场景：写入一对"被一起用过"的记忆，其中只有一条能被关键词命中；
 * 打开 graphExpand 后，另一条应该被补进来；关掉时不该出现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-local-memory';
const REAL_DB = 'C:/Users/Administrator/.dsh/dsh-local-memory.db';

const { openStore } = await import('file:///' + ROOT + '/src/core/index.js');
const { buildTools } = await import('file:///' + ROOT + '/src/host/tools.js');
const { createRecallHandler } = await import('file:///' + ROOT + '/src/host/recall.js');

// 1) 复制真库到临时目录
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-graph-e2e-'));
const dbFile = path.join(dir, 'dsh-local-memory.db');
for (const suffix of ['', '-wal', '-shm']) {
  const src = REAL_DB + suffix;
  if (fs.existsSync(src)) fs.copyFileSync(src, dbFile + suffix);
}
console.log('  用真库副本: ' + dbFile);

const store = openStore({ file: dbFile });
const before = store.count();
console.log('  副本里原有记忆: ' + before + ' 条');

// 2) 造一对：A 能被关键词命中，B 只能靠共现
const A = store.put({ content: '验证用例甲：玄武岩项目的部署端口是 9401', kind: 'work', importance: 'important' });
const B = store.put({ content: '发布前必须双人复核，不接受单人直接发布', kind: 'work', importance: 'important' });
// 让它们"被一起用过"两次
store.recordCooccur([A.id, B.id]);
store.recordCooccur([A.id, B.id]);
console.log('  造了 2 条用例，并记了 2 次共现');

// 3) 配置：先关
let cfg = {
  enabled: true, autoRecall: true, autoRecallMaxItems: 5, autoRecallMinChars: 2,
  forgetAfterDays: 9999,
  halfLifeDays: { work: 365, preference: 730, emotion: 60, unknown: 365 },
  kindWeight: { work: 1, preference: 1, emotion: 1, unknown: 1 },
  features: { softForget: true, graphExpand: false },
};
const tools = buildTools({
  getStore: () => store,
  getConfig: () => cfg,
  readConfig: () => cfg,
});
const searchTool = tools.find((t) => t.name === 'memory_search');

// 只让 A 命中：查询里带"部署端口"，B 没有这些字
const query = '玄武岩项目的部署端口';

async function runSearch(label) {
  const out = await searchTool.execute({ query, limit: 5 }, {});
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  const hasA = text.includes('部署端口');
  const hasB = text.includes('双人复核');
  console.log('\n  [' + label + ']');
  console.log('    甲（关键词命中）: ' + (hasA ? '有' : '无'));
  console.log('    乙（只能靠共现）: ' + (hasB ? '有' : '无'));
  if (hasB) {
    const line = text.split('\n').find((l) => l.includes('双人复核')) || '';
    console.log('    乙那行长这样: ' + line.trim().slice(0, 120));
  }
  return { hasA, hasB };
}

const off = await runSearch('图扩展 = 关');
cfg = { ...cfg, features: { softForget: true, graphExpand: true } };
const on = await runSearch('图扩展 = 开');

// 4) 自动回忆路径
const recall = createRecallHandler({ getStore: () => store, getConfig: () => cfg });
const decision = await recall(
  { agent: { id: 'e2e-graph' } },
  async () => ({ kind: 'enter', messages: [{ role: 'user', content: query }] }),
);
const injected = (decision.messages || [])[0];
const text = injected && injected.source && injected.source.form === 'recall'
  ? JSON.stringify(injected.content) : '';
console.log('\n  [自动回忆注入]');
console.log('    甲出现: ' + (text.includes('部署端口') ? '有' : '无'));
console.log('    乙出现（靠图扩展）: ' + (text.includes('双人复核') ? '有' : '无'));

// 结论
console.log('\n  ── 结论 ──');
const pass = off.hasA && !off.hasB && on.hasA && on.hasB;
console.log('  关闭时只有甲、打开后甲乙都有: ' + (pass ? '✅ 符合预期' : '❌ 不符合'));

store.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
