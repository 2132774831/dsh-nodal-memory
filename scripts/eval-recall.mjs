// 用真实记忆库（副本）跑一组现实查询，检查召回是否合理。
import { openStore, search } from '../src/core/index.js';

const [dbPath] = process.argv.slice(2);
const store = openStore({ file: dbPath, backend: 'sqlite' });

const queries = [
  '抖音', '人设', 'Python', 'voice-mode', '记忆插件', '虚拟声卡',
  'Blender', '插件 注入', 'DeepSeek', '隐私', '录音', 'sqlite 中文分词',
];

console.log('库内条数:', store.count(), '\n');
for (const q of queries) {
  const hits = search(store, q, { limit: 5 });
  console.log(`「${q}」→ ${hits.length} 条`);
  for (const h of hits) {
    const c = h.record.content.replace(/\s+/g, ' ').slice(0, 46);
    console.log(`   ${h.score.toFixed(3)} cov=${h.why.matchedTokens} ${h.why.ageLabel} | ${c}`);
  }
}
store.close();
