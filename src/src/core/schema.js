/**
 * 存储结构（v2）。
 *
 * 设计要点：
 *   1. `rid` 是自增整数主键，给 FTS5 的 rowid 用；业务 id 是 TEXT 的 `id`（沿用 v1 的 m-xxx 格式，
 *      这样迁移过来历史 id 不变，老笔记/引用都对得上）。
 *   2. 软删：`deleted_at` 非空即视为删除。**永不物理删除**——删对话删出过事，记忆更不能。
 *      物理清除只走 purge()，且必须调用方显式要求。
 *   3. `tags`/`updates` 这类不定长结构存 JSON 文本。不建 tag 关联表，
 *      因为按标签过滤用 FTS 的 tags_big 列 + LIKE 已经够（几万条量级），少一张表少一处不一致。
 *   4. FTS5 是**普通表**（非 contentless）：多存一份 bigram 文本换代码简单，
 *      contentless 表的删除/更新需要特殊指令，是 bug 温床。体积换正确性，划算。
 *   5. `injected_count` 与 `searched_count` 分开记：
 *      前者=系统自动塞进上下文，后者=模型主动检索命中。两者比值能判断哪些记忆是"真有用"。
 */

export const SCHEMA_VERSION = 2;

export const DDL = [
  `PRAGMA journal_mode=WAL`,
  `PRAGMA foreign_keys=ON`,
  `PRAGMA busy_timeout=5000`,

  `CREATE TABLE IF NOT EXISTS memory (
     rid            INTEGER PRIMARY KEY AUTOINCREMENT,
     id             TEXT    NOT NULL UNIQUE,
     created_at     TEXT    NOT NULL,
     updated_at     TEXT    NOT NULL,
     kind           TEXT    NOT NULL DEFAULT 'unknown',
     topic          TEXT    NOT NULL DEFAULT '',
     content        TEXT    NOT NULL,
     importance     TEXT    NOT NULL DEFAULT 'important',
     status         TEXT    NOT NULL DEFAULT 'active',
     project        TEXT    NOT NULL DEFAULT '',
     source         TEXT    NOT NULL DEFAULT '',
     tags           TEXT    NOT NULL DEFAULT '[]',
     parent_id      TEXT,
     access_count   INTEGER NOT NULL DEFAULT 0,
     injected_count INTEGER NOT NULL DEFAULT 0,
     searched_count INTEGER NOT NULL DEFAULT 0,
     last_accessed  TEXT,
     pinned         INTEGER NOT NULL DEFAULT 0,
     deleted_at     TEXT,
     origin         TEXT    NOT NULL DEFAULT 'v2',
     schema_version INTEGER NOT NULL DEFAULT 2
   )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_created  ON memory(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_project  ON memory(project)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_kind     ON memory(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_deleted  ON memory(deleted_at)`,

  // 中文靠 bigram，见 src/core/text.js 顶部注释。unicode61 只负责按空格切 token。
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
     content_big,
     topic_big,
     tags_big,
     tokenize='unicode61'
   )`,

  // updates[] 展开成行，好在 UI 里画时间轴（当前版本先不用，结构留好）
  `CREATE TABLE IF NOT EXISTS memory_update (
     uid       INTEGER PRIMARY KEY AUTOINCREMENT,
     memory_id TEXT NOT NULL,
     at        TEXT NOT NULL,
     text      TEXT NOT NULL,
     status    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_update_memory ON memory_update(memory_id)`,

  // 键值元信息：schema 版本、上次维护时间、上次体检时间等
  `CREATE TABLE IF NOT EXISTS memory_meta (
     k TEXT PRIMARY KEY,
     v TEXT
   )`,

  // 共现：两条记忆在同一次检索/注入里同时出现 → 语义上多半相关。
  // **这个数据没法补录**：今天不记，过去一个月"哪些记忆总被一起用到"就永远丢了。
  // 所以哪怕节点图还没做，也先把它记起来。a<b 做规范化，避免 (x,y)/(y,x) 存两份。
  `CREATE TABLE IF NOT EXISTS memory_cooccur (
     a       TEXT NOT NULL,
     b       TEXT NOT NULL,
     count   INTEGER NOT NULL DEFAULT 1,
     last_at TEXT,
     PRIMARY KEY (a, b)
   )`,

  // 可选 embedding 的向量。存 base64 而不是 BLOB：两个后端都能安全存字符串，
  // 不必赌 SQLite 驱动对 Uint8Array/Buffer 的绑定行为。
  // model 单独存，是为了将来换模型时能判断"哪些向量要重算"而不必全表作废。
  `CREATE TABLE IF NOT EXISTS memory_vec (
     memory_id TEXT PRIMARY KEY,
     model     TEXT NOT NULL,
     dim       INTEGER NOT NULL,
     vec       TEXT NOT NULL,
     at        TEXT
   )`,
];

/** 允许的枚举值（写库前校验，防止拼错后静默降级成垃圾数据） */
export const ENUMS = {
  kind: ['work', 'emotion', 'preference', 'unknown'],
  importance: ['key', 'important', 'casual', 'transient'],
  status: ['active', 'resolved', 'expired', 'superseded', 'consolidated'],
};

/** 重要性 → 权重（打分用）。key 最高，transient 最低。 */
export const IMPORTANCE_WEIGHT = {
  key: 1.0,
  important: 0.8,
  casual: 0.5,
  transient: 0.25,
};
