/**
 * 记忆内核入口（零宿主依赖）。
 *
 * 这个目录下的任何文件都**不允许** import DSH / cordis / 任何插件 API。
 * 目的：同一份内核既能被插件进程内直接 import（今天），
 * 也能被未来的独立软件以本地 HTTP / stdio 方式调用（明天），不用重写。
 *
 * 判断规则很简单：如果某个需求需要访问"宿主的能力"（注册工具、注入提示词、读会话），
 * 它就不属于 core/，属于 host/。
 */

export {
  normalize, segments, tokens, toIndexText, toFtsQuery, tokenSet, hasCJK,
} from './text.js';

export {
  toMs, toIso, formatRelative, freshness, decayFactor, stamp, HALF_LIFE_DAYS, STALE_DAYS,
} from './time.js';

export { SCHEMA_VERSION, DDL, ENUMS, IMPORTANCE_WEIGHT } from './schema.js';

export { openStore, normalizeRecord, sqliteAvailable } from './store.js';

export { search, renderHits } from './search.js';

export { buildGraph } from './graph.js';

export {
  createLayout, stepLayout, isSettled, bounds,
  KIND_COLORS, EDGE_STYLES, kindColor, edgeStyle,
} from './graph-layout.js';

export { runMaintenance, maintenanceInfo, DEFAULT_INTERVAL_DAYS } from './maintenance.js';

export { findConflicts, reviewCandidates } from './insight.js';

export { inferKindFromContent, classifyBatch } from './classify.js';

export {
  createEmbedder, embedderFromConfig, normalizeVec, cosine, encodeVec, decodeVec,
} from './embed.js';

export { migrateFromV1, inferKind, normalizeProject } from './migrate.js';
