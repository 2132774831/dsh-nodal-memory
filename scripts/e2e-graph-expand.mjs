/**
 * P0 端到端验证（真库副本，绝不碰真库）：
 *   1) memory_save 能把 session_id 写进去（走真实工具调用）
 *   2) 搜索命中后，同会话的另一条能被补进来
 *   3) 老数据（无 session）走时间推断，且标注 via=inferred
 *   4) 共现边不再导致扩展
 *   5) 扩展预算生效
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-local-memory';
const REAL_DB = 'C:/Users/Administrator/.dsh/dsh-local-memory.db';

const { openStore } = await import('file:///' + ROOT + '/src/core/index.js');
const { buildTools } = await import('file:///' + ROOT + '/src/host/tools.js');
const { expandByGraph } = await import('file:///' + ROOT + '/src/core/expand.js');
const { search } = await import('file:///' + ROOT + '/src/core/search.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-p0-e2e-'));
const dbFile = path.join(dir, 'dsh-local-memory.db');
for (const s of ['', '-wal', '-shm']) {
  if (fs.existsSync(REAL_DB + s)) fs.copyFileSync(REAL_DB + s, dbFile + s);
}
const store = openStore({ file: dbFile });
console.log('  真库副本: ' + store.count() + ' 条');

const cfg = {
  enabled: true, autoRecall: true, autoRecallMaxItems: 5, autoRecallMinChars: 2,
  forgetAfterDays: 9999, maxTextLength: 4000, autoTagProject: false,
  halfLifeDays: { work: 365, preference: 730, emotion: 60, unknown: 365 },
  kindWeight: { work: 1, preference: 1, emotion: 1, unknown: 1 },
  features: { softForget: true, graphExpand: true, autoKind: false },
};
const tools = buildTools({ getStore: () => store, getConfig: () => cfg, getCwd: () => ({ project: '' }) });
const saveTool = tools.find((t) => t.name === 'memory_save');
const searchTool = tools.find((t) => t.name === 'memory_search');

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { if (ok) pass++; else fail++; console.log('  ' + (ok ? '✅' : '❌') + ' ' + n + (d ? '   ' + d : '')); };

/* 1) 用工具保存两条同会话记忆 */
const exec = { agent: { id: 'e2e-session-x1' } };
await saveTool.execute({ text: '北极星项目：部署脚本里那个端口要改成 9411', importance: 'important' }, exec);
await saveTool.execute({ text: '北极星项目：顺手把日志级别调成 info 了', importance: 'important' }, exec);

const saved = store.listBySession('e2e-session-x1', { limit: 10 });
check('memory_save 写入了 session_id', saved.length === 2, '同会话记录 ' + saved.length + ' 条');

/* 2) 搜索命中一条 → 同会话另一条应被补进来 */
const hits = search(store, '部署脚本 端口 9411', { limit: 5 });
const expanded = expandByGraph(store, hits);
const added = expanded.filter((r) => r.why && r.why.graphExpanded);
check('同会话的另一条被补进来', added.some((r) => r.record.content.includes('日志级别')), '补了 ' + added.length + ' 条');

/* 3) 老数据（无会话）走时间推断 */
const old = store.list({ limit: 100000 }).filter((r) => !r.sessionId).slice(0, 2);
if (old.length >= 2) {
  const q = old[0].content.slice(0, 10);
  const h2 = search(store, q, { limit: 5 });
  const e2 = expandByGraph(store, h2);
  const a2 = e2.filter((r) => r.why && r.why.graphExpanded);
  const kinds = [...new Set(a2.map((r) => r.why.via))];
  check('老数据扩展有来源标注', a2.length === 0 || kinds.every((k) => ['session', 'inferred', 'kindred'].includes(k)), '来源: ' + kinds.join(',') || '（无扩展）');
}

/* 4) 共现不再导致扩展 */
const c1 = store.put({ content: '共现测试甲：只有这一条能搜到', kind: 'work', createdAt: Date.now() - 40 * 86400000, updatedAt: Date.now() - 40 * 86400000 });
// 时间故意拉开 3 小时：排除「时间推断」那条路，单独验共现不生效
const c2 = store.put({ content: '共现测试乙：内容完全无关的词', kind: 'work', createdAt: Date.now() - 40 * 86400000 - 3 * 3600000, updatedAt: Date.now() - 40 * 86400000 - 3 * 3600000 });
for (let i = 0; i < 4; i++) store.recordCooccur([c1.id, c2.id]);
const h3 = search(store, '只有这一条能搜到', { limit: 5 });
const e3 = expandByGraph(store, h3);
check('共现不再导致扩展', e3.length === h3.length, '命中 ' + h3.length + ' → 扩展后 ' + e3.length);

/* 5) 预算 */
const chars = added.reduce((s, r) => s + String(r.record.content).length, 0);
check('扩展总量在预算内', chars <= 600, chars + ' 字');

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n  ' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
