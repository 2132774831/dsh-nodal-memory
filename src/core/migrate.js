/**
 * v1（JSON，9 个字段）→ v2（SQLite/JSON）的迁移。
 *
 * 铁律：
 *   1. **迁移器只读源文件**，绝不修改 v1 原始库。
 *   2. **幂等**：同一个 id 已存在就跳过，不覆盖。这样才能放心重跑——
 *      重跑不会把 v2 里累积的 access_count 冲回 v1 的旧值。
 *   3. 迁移完必须能核对：返回逐项计数，调用方打印出来对账。
 *
 * v1 字段 → v2 字段映射：
 *   text        → content       （原文不动，记忆是可追溯的证据）
 *   tags        → tags
 *   project     → project       （统一 default_workspace → default-workspace）
 *   createdAt   → createdAt
 *   updatedAt   → updatedAt
 *   hits        → accessCount + searchedCount（v1 的 hits 是"被检索命中次数"）
 *   lastUsedAt  → lastAccessed
 *
 * 两个需要判断的地方：
 *   kind：v1 没有分类，只有"带 pref 标签 → preference"这一条。
 *         现在接上 v2 的纯本地分类器（证据不足仍返回 unknown，不瞎猜）——
 *         否则迁移完 17 条全 unknown，"情感忘得快/偏好记得久"这套设计等于空转。
 *   importance：v1 没有重要度。**全部 important**（这些条目都是用户确认过的长期记忆）。
 *         v2 的枚举是 key/important/casual/transient，没有"中间档"，硬造一个 normal
 *         会连累检索权重和界面文案；而"被用户确认过的长期记忆"语义上就是 important。
 *         代价是迁移来的这批在"重要度"这个维度上没有区分度，需要时用「补标」逐条重评。
 */

import { toMs, toIso } from './time.js';
import { inferKindFromContent } from './classify.js';

/** 工程里 project 字段出现过两种写法，统一成连字符版 */
export function normalizeProject(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  return s.replace(/_/g, '-');
}

export function inferKind(v1Record) {
  const tags = Array.isArray(v1Record.tags) ? v1Record.tags : [];
  if (tags.includes('pref')) return 'preference';
  if (tags.some((t) => String(t).startsWith('pref:'))) return 'preference';
  return 'unknown';
}

/**
 * @param {object} store openStore() 返回的存储
 * @param {object} v1    已经 JSON.parse 过的 v1 库内容
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] 只统计不写库
 * @param {boolean} [opts.force=false]  已存在的 id 也重写（默认跳过）
 */
export function migrateFromV1(store, v1, opts = {}) {
  const { dryRun = false, force = false } = opts;

  const list = Array.isArray(v1) ? v1 : v1?.memories;
  if (!Array.isArray(list)) {
    throw new Error('迁移失败：输入不是 v1 记忆库（缺少 memories 数组）');
  }
  if (Array.isArray(v1?.version) === false && v1?.version !== undefined && v1.version !== 1) {
    // 允许无 version 字段，但明确写别的版本号就是喂错文件了
    throw new Error(`迁移失败：期望 v1 数据，实际 version=${v1.version}`);
  }

  const report = {
    total: list.length,
    inserted: 0,
    skipped: 0,
    updated: 0,
    invalid: 0,
    kindTally: {},
    projectTally: {},
    earliest: null,
    latest: null,
  };

  const existing = new Set();
  if (!dryRun) {
    for (const r of store.list({ includeDeleted: true, limit: 100000 })) existing.add(r.id);
  }

  const work = () => {
    for (const src of list) {
      const id = src?.id ? String(src.id) : null;
      const text = String(src?.text ?? src?.content ?? '').trim();
      if (!id || !text) { report.invalid++; continue; }

      if (existing.has(id) && !force) { report.skipped++; continue; }

      const createdAt = toMs(src.createdAt) ?? toMs(src.updatedAt) ?? Date.now();
      const updatedAt = toMs(src.updatedAt) ?? createdAt;
      const hits = Number.isFinite(src.hits) ? src.hits : 0;
      // v1 只有"带 pref 标签才算偏好"这一条规则，其余全 unknown → 迁移后分类维度等于白给。
      // 这里接上 v2 已有的纯本地分类器（证据不足仍返回 unknown，不瞎猜）。
      // ⚠ inferKindFromContent 返回的是 {kind, why}，不是字符串 —— 直接当字符串赋给 kind
      //   会把对象写进记录，统计里全落进 unknown（踩过）。
      const tagged = inferKind(src);
      const kind = tagged !== 'unknown' ? tagged : inferKindFromContent(text).kind;
      const project = normalizeProject(src.project);
      const tags = Array.isArray(src.tags) ? src.tags : [];

      const rec = {
        id,
        createdAt,
        updatedAt,
        kind,
        topic: '',
        content: text,
        importance: 'important',
        status: 'active',
        project,
        source: 'v1',
        tags,
        parentId: null,
        accessCount: hits,
        injectedCount: 0,
        searchedCount: hits,
        lastAccessed: toMs(src.lastUsedAt),
        pinned: 0,
        deletedAt: null,
        origin: 'v1',
      };

      if (!dryRun) store.put(rec);

      report.inserted++;
      report.kindTally[kind] = (report.kindTally[kind] ?? 0) + 1;
      report.projectTally[project] = (report.projectTally[project] ?? 0) + 1;
      if (report.earliest == null || createdAt < report.earliest) report.earliest = createdAt;
      if (report.latest == null || createdAt > report.latest) report.latest = createdAt;
    }
  };

  if (dryRun) work();
  else if (typeof store.batch === 'function') store.batch(work);
  else work();

  report.earliest = report.earliest == null ? null : toIso(report.earliest);
  report.latest = report.latest == null ? null : toIso(report.latest);
  return report;
}
