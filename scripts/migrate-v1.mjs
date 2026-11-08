#!/usr/bin/env node
/**
 * 把 v1 的 JSON 记忆库迁移到 v2 存储。
 *
 * 用法：
 *   node scripts/migrate-v1.mjs --v1 <v1.json> --out <v2.db> [--backend sqlite|json] [--dry-run] [--force]
 *
 * 安全约定：
 *   - 只读 --v1 指向的文件，绝不写它。
 *   - 建议先跑 --dry-run 看统计，再正式迁。
 *   - 建议迁到**新文件**，不要指向 v2 正在用的库（重跑会 skip 已存在 id，但别给自己找麻烦）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { openStore, migrateFromV1, sqliteAvailable, search, renderHits } from '../src/core/index.js';

function parseArgs(argv) {
  const out = { backend: 'auto', dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--v1') out.v1 = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--backend') out.backend = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--query') out.query = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.v1 || !args.out) {
  console.error('用法: node scripts/migrate-v1.mjs --v1 <v1.json> --out <v2.db> [--backend sqlite|json] [--dry-run] [--force] [--query "测试查询"]');
  process.exit(2);
}

const v1Path = path.resolve(args.v1);
const outPath = path.resolve(args.out);

if (!fs.existsSync(v1Path)) {
  console.error('找不到 v1 文件：' + v1Path);
  process.exit(2);
}
if (path.resolve(v1Path) === path.resolve(outPath)) {
  console.error('拒绝执行：--out 不能和 --v1 是同一个文件（迁移绝不覆盖源库）');
  process.exit(2);
}

const backend = args.backend === 'auto' ? (sqliteAvailable() ? 'sqlite' : 'json') : args.backend;
console.log('后端:', backend, args.dryRun ? '(dry-run，不写库)' : '');
console.log('源  :', v1Path);
console.log('目标:', outPath);

const v1 = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
const beforeHash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(v1Path)).digest('hex');
console.log('源库 SHA256:', beforeHash);

const store = openStore({ file: outPath, backend, home: path.dirname(outPath) });

try {
  const report = migrateFromV1(store, v1, { dryRun: args.dryRun, force: args.force });
  console.log('\n=== 迁移报告 ===');
  console.log('源条目      :', report.total);
  console.log('写入        :', report.inserted);
  console.log('跳过(已存在):', report.skipped);
  console.log('无效条目    :', report.invalid);
  console.log('kind 分布   :', JSON.stringify(report.kindTally));
  console.log('project 分布:', JSON.stringify(report.projectTally));
  console.log('时间范围    :', report.earliest, '→', report.latest);

  if (!args.dryRun) {
    console.log('\n=== 落库核对 ===');
    console.log('库里现有条数:', store.count());
    const stats = store.stats();
    console.log('统计        :', JSON.stringify(stats));
    const afterHash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(v1Path)).digest('hex');
    console.log('源库 SHA256 是否未变:', beforeHash === afterHash);

    for (const q of args.query ? [args.query] : ['记忆插件', '牛肉面', '时间混淆', 'Hindsight', 'sqlite']) {
      const hits = search(store, q, { limit: 3 });
      console.log(`\n--- 查询「${q}」→ ${hits.length} 条 ---`);
      if (hits.length) {
        console.log(renderHits(hits, { maxChars: 90 }));
        console.log('  打分细节:', JSON.stringify(hits[0].why));
      }
    }
  }
} finally {
  store.close();
}
