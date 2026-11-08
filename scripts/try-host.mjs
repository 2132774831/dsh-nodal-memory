#!/usr/bin/env node
/**
 * 端到端冒烟：在**临时 DSH_HOME** 里把插件挂起来，验证"首次启动自动迁移 + 立刻可用"。
 *
 * 安全：只往临时目录写，绝不碰真实 ~/.dsh。真实库仅被**读取**一份副本进来。
 *
 * 用法：
 *   node scripts/try-host.mjs [v1库路径]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const v1Source = process.argv[2]
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'dsh-local-memory.json');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-e2e-'));
fs.copyFileSync(v1Source, path.join(home, 'dsh-local-memory.json'));
process.env.DSH_HOME = home;

const { apply } = await import('../src/host/index.js');
const { readConfig } = await import('../src/host/config.js');

const tools = new Map();
const sections = [];
const handlers = new Map();
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
  on: (e, f) => { handlers.set(e, f); return () => {}; },
  effect: () => () => {},
  get: () => undefined,
};

console.log('临时 DSH_HOME:', home);
console.log('v1 源库      :', v1Source);
apply(ctx);
console.log('已注册工具   :', [...tools.keys()].join(', '));
console.log('提示词段     :', sections.length);

const call = (name, args = {}) => tools.get(name).execute(args, {});

// 第一次调工具会触发建库 + 自动迁移
const list = await call('memory_list', { limit: 3 });
console.log('\n=== 首次调用 memory_list ===');
console.log(list);

const cfg = readConfig();
console.log('\n后端配置:', JSON.stringify({ backend: cfg.backend, enabled: cfg.enabled, autoRecall: cfg.autoRecall }));

// 读迁移 meta
const { openStore } = await import('../src/core/index.js');
const { defaultDbFile } = await import('../src/host/config.js');
const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
console.log('迁移标记  :', store.getMeta('migrated_from_v1'));
console.log('迁移错误  :', store.getMeta('migrate_error'));
console.log('库内条数  :', store.count());
console.log('分类统计  :', JSON.stringify(store.stats().byKind));
store.close();

// 搜索
console.log('\n=== 检索 ===');
for (const q of ['人设', 'Blender', '记忆插件']) {
  const r = await call('memory_search', { query: q, limit: 2 });
  console.log(`「${q}」→`, r.split('\n')[0]);
}

// 自动回忆注入
const decision = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: '上次说的那个人设插件的事，我记得我们说好用哪个' }], source: { kind: 'user' } }],
};
const out = await handlers.get('agent/pre-step')({ agent: { id: 'demo-session' } }, async () => decision);
console.log('\n=== 自动回忆 ===');
console.log('注入条数:', out.messages.length - 1);
if (out.messages.length > 1) {
  console.log('source  :', JSON.stringify(out.messages[0].source));
  console.log('正文前 300 字:\n' + out.messages[0].content[0].text.slice(0, 300));
}

const brief = sections[0].text();
console.log('\n=== 常驻提示词（前 400 字）===');
console.log(brief.slice(0, 400));

// ── 关系图：在真实数据上看"毛线球"防线是否生效
const { buildGraph } = await import('../src/core/graph.js');
const store2 = openStore({ file: defaultDbFile(), backend: 'sqlite' });
const records = store2.list({ limit: 100000 });
const graph = buildGraph(records, {
  cooccur: typeof store2.cooccurPairs === 'function' ? store2.cooccurPairs({ minCount: 1 }) : [],
});
store2.close();

console.log('\n=== 关系图（真实数据）===');
console.log('点 / 边       :', graph.stats.nodes, '/', graph.stats.edges);
console.log('孤岛（无语义边）:', graph.stats.isolated);
console.log('被压掉的泛滥标签:', JSON.stringify(graph.stats.dominantTags));
const byKind = {};
for (const e of graph.edges) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log('边的类型分布   :', JSON.stringify(byKind));
console.log('权重最高的 5 条边:');
for (const e of graph.edges.slice(0, 5)) {
  console.log(`  ${e.weight}  [${e.kind}] ${e.source} <-> ${e.target}  ${JSON.stringify(e.detail)}`);
}

console.log('\n临时目录（验证完可删）:', home);
