/**
 * 存储层：node:sqlite 为主，JSON 兜底。
 *
 * 为什么两个后端：
 *   node:sqlite 是 Node 22.5+ 才有的内置模块。本机宿主是 Electron 44 / Node 24.21，实测
 *   WAL、FTS5、bm25()、integrity_check 全通——所以主力走 SQLite，白拿事务、索引、全文检索。
 *   但 package.json 声明了 engines.node >= 20，在 Node 20 上跑没有 node:sqlite，
 *   此时自动退回单 JSON 文件（纯 JS 打分），保证"装得上、不崩"。
 *
 * 为什么不需要文件锁（设计文档里那条建议是错的）：
 *   插件的所有读写都发生在**同一个宿主进程**里，且本文件的每个操作都是**同步**的
 *   （DatabaseSync 是同步 API，JSON 后端也是同步改内存 + 原子落盘）。
 *   Node 是单线程，同步操作之间不可能交错，所以"两个异步写互相覆盖"在这里不存在。
 *   真跨进程才需要锁，那时候应该用 SQLite 的 BEGIN IMMEDIATE，而不是"检查 lock 文件存在与否"
 *   ——后者是典型的 TOCTOU 竞态，看着像锁，其实一点保护都没有。
 *
 * 并发安全靠两件事：①同步 API ②JSON 落盘走 temp+rename 原子替换。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SCHEMA_VERSION, DDL, ENUMS } from './schema.js';
import { toIndexText } from './text.js';
import { toMs, toIso } from './time.js';
import { encodeVec, decodeVec } from './embed.js';

// ---------------------------------------------------------------- 公共工具

let _DatabaseSync = null;
function loadSqlite() {
  if (_DatabaseSync !== null) return _DatabaseSync;
  try {
    const require = createRequire(import.meta.url);
    _DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch {
    _DatabaseSync = false;
  }
  return _DatabaseSync;
}

export function sqliteAvailable() {
  return loadSqlite() !== false;
}

function newId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return 'm-' + now.toString(36) + '-' + rand;
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * 标签清洗：去空、去重、**限个数、限长度**。
 * 为什么要限：对抗性测试里塞 2000 个标签会原样入库，
 * 一条记忆就能把库撑大、把关系图的标签边算到卡死。正常使用几十个足够。
 */
const MAX_TAGS = 50;
const MAX_TAG_LEN = 64;
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const s = String(t ?? '').trim().slice(0, MAX_TAG_LEN);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 把外部输入整理成一条合法记录。缺字段给默认值，非法枚举回退到默认值。
 * 这里**不抛错**：记忆写入宁可落个保守默认值，也不要因为一个字段拼错就丢掉整条记忆。
 */
export function normalizeRecord(input, now = Date.now()) {
  const createdAt = toMs(input.createdAt) ?? now;
  const updatedAt = toMs(input.updatedAt) ?? now;
  return {
    id: input.id ? String(input.id) : newId(now),
    createdAt,
    updatedAt,
    kind: pickEnum(input.kind, ENUMS.kind, 'unknown'),
    topic: String(input.topic ?? '').trim(),
    content: String(input.content ?? input.text ?? '').trim(),
    importance: pickEnum(input.importance, ENUMS.importance, 'important'),
    status: pickEnum(input.status, ENUMS.status, 'active'),
    project: String(input.project ?? '').trim(),
    source: String(input.source ?? '').trim(),
    tags: normalizeTags(input.tags),
    parentId: input.parentId ? String(input.parentId) : null,
    accessCount: Number.isFinite(input.accessCount) ? input.accessCount : 0,
    injectedCount: Number.isFinite(input.injectedCount) ? input.injectedCount : 0,
    searchedCount: Number.isFinite(input.searchedCount) ? input.searchedCount : 0,
    lastAccessed: toMs(input.lastAccessed),
    pinned: input.pinned ? 1 : 0,
    deletedAt: toMs(input.deletedAt),
    origin: String(input.origin ?? 'v2'),
    schemaVersion: SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------- SQLite 后端

class SqliteBackend {
  constructor(file) {
    this.backend = 'sqlite';
    this.file = file;
    const DatabaseSync = loadSqlite();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    for (const sql of DDL) this.db.exec(sql);
    this._prepare();
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  _prepare() {
    const db = this.db;
    this.stInsert = db.prepare(`INSERT INTO memory
      (id, created_at, updated_at, kind, topic, content, importance, status, project, source,
       tags, parent_id, access_count, injected_count, searched_count, last_accessed, pinned,
       deleted_at, origin, schema_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.stUpdate = db.prepare(`UPDATE memory SET
       created_at=?, updated_at=?, kind=?, topic=?, content=?, importance=?, status=?, project=?,
       source=?, tags=?, parent_id=?, access_count=?, injected_count=?, searched_count=?,
       last_accessed=?, pinned=?, deleted_at=?, origin=?, schema_version=?
       WHERE id=?`);
    this.stFtsInsert = db.prepare('INSERT INTO memory_fts(rowid, content_big, topic_big, tags_big) VALUES (?,?,?,?)');
    this.stFtsDelete = db.prepare('DELETE FROM memory_fts WHERE rowid=?');
    this.stByRid = db.prepare('SELECT rid, * FROM memory WHERE id=?');
    this.stMetaGet = db.prepare('SELECT v FROM memory_meta WHERE k=?');
    this.stMetaSet = db.prepare('INSERT INTO memory_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  }

  _ftsRow(rec) {
    return [toIndexText(rec.content), toIndexText(rec.topic), toIndexText(rec.tags.join(' '))];
  }

  put(input) {
    const rec = normalizeRecord(input);
    const existing = this.stByRid ? this.db.prepare('SELECT rid FROM memory WHERE id=?').get(rec.id) : null;
    // 时间列在库里是 TEXT（ISO8601）。若直接绑定毫秒数字，SQLite 的 TEXT 亲和性会把它
    // 写成 "1759200000000.0" 这种字符串，读回来 Date.parse 失败 → 时间被静默当成"现在"。
    // 所以这里必须先转 ISO，null 保持 null（toIso(null) 会变成 1970 年，必须挡住）。
    const iso = (ms) => (ms == null ? null : toIso(ms));
    const row = [
      iso(rec.createdAt), iso(rec.updatedAt), rec.kind, rec.topic, rec.content, rec.importance, rec.status,
      rec.project, rec.source, JSON.stringify(rec.tags), rec.parentId, rec.accessCount,
      rec.injectedCount, rec.searchedCount, iso(rec.lastAccessed), rec.pinned, iso(rec.deletedAt),
      rec.origin, rec.schemaVersion,
    ];
    let rid;
    if (existing) {
      this.stUpdate.run(...row, rec.id);
      rid = existing.rid;
      this.stFtsDelete.run(rid);
    } else {
      const info = this.stInsert.run(rec.id, ...row);
      rid = info.lastInsertRowid;
    }
    this.stFtsInsert.run(rid, ...this._ftsRow(rec));
    return { id: rec.id, created: !existing, record: rec };
  }

  _toRecord(row) {
    return normalizeRecord({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kind: row.kind,
      topic: row.topic,
      content: row.content,
      importance: row.importance,
      status: row.status,
      project: row.project,
      source: row.source,
      tags: JSON.parse(row.tags || '[]'),
      parentId: row.parent_id,
      accessCount: row.access_count,
      injectedCount: row.injected_count,
      searchedCount: row.searched_count,
      lastAccessed: row.last_accessed,
      pinned: row.pinned,
      deletedAt: row.deleted_at,
      origin: row.origin,
    });
  }

  get(id) {
    const row = this.db.prepare('SELECT rid, * FROM memory WHERE id=?').get(id);
    return row ? this._toRecord(row) : null;
  }

  list({ project, kind, tag, includeDeleted = false, limit = 100, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (!includeDeleted) where.push('deleted_at IS NULL');
    if (project) { where.push('project=?'); args.push(project); }
    if (kind) { where.push('kind=?'); args.push(kind); }
    if (tag) { where.push(`tags LIKE ?`); args.push(`%"${tag}"%`); }
    const sql = 'SELECT rid, * FROM memory'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?';
    return this.db.prepare(sql).all(...args, limit, offset).map((r) => this._toRecord(r));
  }

  remove(id, now = Date.now()) {
    const info = this.db.prepare('UPDATE memory SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(toIso(now), id);
    return info.changes > 0;
  }

  restore(id) {
    const info = this.db.prepare('UPDATE memory SET deleted_at=NULL WHERE id=?').run(id);
    return info.changes > 0;
  }

  /** 物理清除：只在调用方**显式**要求时用（比如用户点了"彻底删除"） */
  purge(id) {
    const row = this.db.prepare('SELECT rid FROM memory WHERE id=?').get(id);
    if (!row) return false;
    this.stFtsDelete.run(row.rid);
    this.db.prepare('DELETE FROM memory_update WHERE memory_id=?').run(id);
    // 顺手清掉共现记录：留着会变成指向不存在节点的孤儿边，越积越多
    this.db.prepare('DELETE FROM memory_cooccur WHERE a=? OR b=?').run(id, id);
    this.db.prepare('DELETE FROM memory_vec WHERE memory_id=?').run(id);
    this.db.prepare('DELETE FROM memory WHERE id=?').run(id);
    return true;
  }

  recordAccess(id, mode = 'inject', now = Date.now()) {
    const col = mode === 'search' ? 'searched_count' : 'injected_count';
    const info = this.db.prepare(
      `UPDATE memory SET access_count=access_count+1, ${col}=${col}+1, last_accessed=? WHERE id=?`
    ).run(toIso(now), id);
    return info.changes > 0;
  }

  count({ includeDeleted = false } = {}) {
    const sql = includeDeleted ? 'SELECT COUNT(*) c FROM memory' : 'SELECT COUNT(*) c FROM memory WHERE deleted_at IS NULL';
    return this.db.prepare(sql).get().c;
  }

  stats() {
    const total = this.count();
    const deleted = this.count({ includeDeleted: true }) - total;
    const byKind = this.db.prepare('SELECT kind, COUNT(*) c FROM memory WHERE deleted_at IS NULL GROUP BY kind').all();
    const byImportance = this.db.prepare('SELECT importance, COUNT(*) c FROM memory WHERE deleted_at IS NULL GROUP BY importance').all();
    const range = this.db.prepare('SELECT MIN(created_at) a, MAX(created_at) b FROM memory WHERE deleted_at IS NULL').get();
    const neverUsed = this.db.prepare('SELECT COUNT(*) c FROM memory WHERE deleted_at IS NULL AND access_count=0').get().c;
    return { total, deleted, byKind, byImportance, oldest: range.a, newest: range.b, neverUsed };
  }

  getMeta(k) {
    const row = this.stMetaGet.get(k);
    return row ? row.v : null;
  }

  setMeta(k, v) {
    this.stMetaSet.run(k, String(v));
  }

  /**
   * 记录一组记忆的共现（两两配对，a<b 规范化）。
   * 只在同一次检索/注入里同时出现时才记——这是"被一起用到"的事实，不是语义猜测。
   */
  recordCooccur(ids, now = Date.now()) {
    const list = Array.from(new Set((ids || []).filter(Boolean))).sort();
    if (list.length < 2) return 0;
    const iso = toIso(now);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        this.db.prepare(
          `INSERT INTO memory_cooccur(a,b,count,last_at) VALUES(?,?,1,?)
           ON CONFLICT(a,b) DO UPDATE SET count=count+1, last_at=excluded.last_at`
        ).run(list[i], list[j], iso);
        n++;
      }
    }
    return n;
  }

  /** 读共现对，count 高的在前 */
  cooccurPairs({ minCount = 1, limit = 5000 } = {}) {
    return this.db.prepare(
      'SELECT a, b, count FROM memory_cooccur WHERE count >= ? ORDER BY count DESC LIMIT ?'
    ).all(minCount, limit);
  }

  /**
   * 清孤儿行：指向已经不存在的记忆的共现/更新/向量记录。
   * 这是纯垃圾回收——被引用的记忆都没了，这些行不可能有任何用处。
   */
  pruneOrphans() {
    const co = this.db.prepare(
      `DELETE FROM memory_cooccur
       WHERE a NOT IN (SELECT id FROM memory) OR b NOT IN (SELECT id FROM memory)`
    ).run();
    const up = this.db.prepare(
      `DELETE FROM memory_update WHERE memory_id NOT IN (SELECT id FROM memory)`
    ).run();
    const vec = this.db.prepare(
      `DELETE FROM memory_vec WHERE memory_id NOT IN (SELECT id FROM memory)`
    ).run();
    return { cooccur: co.changes || 0, updates: up.changes || 0, vectors: vec.changes || 0 };
  }

  /* ── 向量（可选 embedding） ── */

  /** @param {string} id @param {{model:string, vec:Float32Array}} input */
  putVector(id, { model, vec }) {
    if (!id || !vec || !vec.length) return false;
    this.db.prepare(
      `INSERT INTO memory_vec(memory_id, model, dim, vec, at) VALUES(?,?,?,?,?)
       ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
         vec=excluded.vec, at=excluded.at`
    ).run(id, String(model || ''), vec.length, encodeVec(vec), toIso(Date.now()));
    return true;
  }

  /** @returns {Float32Array|null} */
  getVector(id) {
    const row = this.db.prepare('SELECT vec FROM memory_vec WHERE memory_id=?').get(id);
    return row ? decodeVec(row.vec) : null;
  }

  /** 批量取，返回 Map<id, Float32Array>（缺的不在 Map 里） */
  getVectors(ids) {
    const out = new Map();
    const list = Array.isArray(ids) ? ids : [];
    if (list.length === 0) return out;
    const stmt = this.db.prepare('SELECT vec FROM memory_vec WHERE memory_id=?');
    for (const id of list) {
      const row = stmt.get(id);
      if (row) {
        const v = decodeVec(row.vec);
        if (v) out.set(id, v);
      }
    }
    return out;
  }

  /** 向量覆盖情况（给设置页/调试看"还有多少条没算过向量"） */
  vectorStats() {
    const total = this.count();
    const withVec = this.db.prepare(
      'SELECT COUNT(*) c FROM memory_vec WHERE memory_id IN (SELECT id FROM memory WHERE deleted_at IS NULL)'
    ).get().c;
    const models = this.db.prepare('SELECT model, COUNT(*) c FROM memory_vec GROUP BY model').all();
    return { total, withVector: withVec, models };
  }

  /** 库完整性自检（SQLite 的 PRAGMA integrity_check） */
  integrity() {
    try {
      return this.db.prepare('PRAGMA integrity_check').get().integrity_check;
    } catch (err) {
      return 'error: ' + String((err && err.message) || err);
    }
  }

  /**
   * 检索候选：FTS5 MATCH + bm25 排序。
   * bm25() 返回负数，越小越相关，所以取负号让"越大越好"，与 JSON 后端语义统一。
   */
  candidates({ ftsQuery, limit = 50, filters = {} }) {
    if (!ftsQuery) return [];
    const where = ['memory_fts MATCH ?', 'm.deleted_at IS NULL'];
    const args = [ftsQuery];
    if (filters.project) { where.push('m.project=?'); args.push(filters.project); }
    if (filters.kind) { where.push('m.kind=?'); args.push(filters.kind); }
    if (filters.tag) { where.push('m.tags LIKE ?'); args.push(`%"${filters.tag}"%`); }
    const sql = `SELECT m.rid, m.*, bm25(memory_fts) AS rank
                 FROM memory_fts JOIN memory m ON m.rid = memory_fts.rowid
                 WHERE ${where.join(' AND ')}
                 ORDER BY rank LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit);
    return rows.map((r) => ({ record: this._toRecord(r), rawScore: -r.rank }));
  }

  batch(fn) {
    // SQLite 单条写入本来就快；批量转移包一层事务即可
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------- JSON 后端

class JsonBackend {
  constructor(file) {
    this.backend = 'json';
    this.file = file;
    this.records = new Map();
    this.meta = new Map();
    this.cooccur = new Map();
    this.vectors = new Map();
    this.depth = 0;
    this.dirty = false;
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.version === 1) {
        throw new Error(
          'JSON 兜底后端不能直接读 v1 数据格式，请先运行迁移：node scripts/migrate-v1.mjs <v1.json>'
        );
      }
      this.meta = new Map(Object.entries(data.meta ?? {}));
      for (const [key, v] of Object.entries(data.cooccur ?? {})) this.cooccur.set(key, v);
      for (const [id, v] of Object.entries(data.vectors ?? {})) this.vectors.set(id, v);
      for (const r of data.memories ?? []) {
        const rec = normalizeRecord(r);
        this.records.set(rec.id, rec);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  flush() {
    if (this.depth > 0) { this.dirty = true; return; }
    const payload = {
      version: SCHEMA_VERSION,
      meta: Object.fromEntries(this.meta),
      cooccur: Object.fromEntries(this.cooccur),
      vectors: Object.fromEntries(this.vectors),
      memories: [...this.records.values()],
    };
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // 原子替换，写一半崩了也不会毁掉旧文件
    this.dirty = false;
  }

  batch(fn) {
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.flush();
      return out;
    } catch (e) {
      this.depth--;
      throw e;
    }
  }

  put(input) {
    const rec = normalizeRecord(input);
    const created = !this.records.has(rec.id);
    this.records.set(rec.id, rec);
    this.flush();
    return { id: rec.id, created, record: rec };
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  list({ project, kind, tag, includeDeleted = false, limit = 100, offset = 0 } = {}) {
    let rows = [...this.records.values()].filter((r) => includeDeleted || r.deletedAt == null);
    if (project) rows = rows.filter((r) => r.project === project);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (tag) rows = rows.filter((r) => r.tags.includes(tag));
    rows.sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
    return rows.slice(offset, offset + limit);
  }

  remove(id, now = Date.now()) {
    const rec = this.records.get(id);
    if (!rec || rec.deletedAt != null) return false;
    rec.deletedAt = now;
    this.flush();
    return true;
  }

  restore(id) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.deletedAt = null;
    this.flush();
    return true;
  }

  purge(id) {
    const existed = this.records.delete(id);
    if (!existed) return false;
    // 顺手清掉共现记录（与 SQLite 后端保持一致）
    for (const key of [...this.cooccur.keys()]) {
      if (key.split('|').includes(id)) this.cooccur.delete(key);
    }
    this.vectors.delete(id);
    this.flush();
    return true;
  }

  recordAccess(id, mode = 'inject', now = Date.now()) {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.accessCount += 1;
    if (mode === 'search') rec.searchedCount += 1;
    else rec.injectedCount += 1;
    rec.lastAccessed = now;
    this.flush();
    return true;
  }

  count({ includeDeleted = false } = {}) {
    let n = 0;
    for (const r of this.records.values()) if (includeDeleted || r.deletedAt == null) n++;
    return n;
  }

  stats() {
    const live = [...this.records.values()].filter((r) => r.deletedAt == null);
    const tally = (key) => {
      const m = new Map();
      for (const r of live) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
      return [...m.entries()].map(([k, c]) => ({ [key]: k, c }));
    };
    const times = live.map((r) => r.createdAt).sort((a, b) => a - b);
    return {
      total: live.length,
      deleted: this.records.size - live.length,
      byKind: tally('kind'),
      byImportance: tally('importance'),
      oldest: times.length ? toIso(times[0]) : null,
      newest: times.length ? toIso(times[times.length - 1]) : null,
      neverUsed: live.filter((r) => r.accessCount === 0).length,
    };
  }

  getMeta(k) { return this.meta.get(k) ?? null; }
  setMeta(k, v) { this.meta.set(k, String(v)); this.flush(); }

  /** JSON 后端用 "a|b" 字符串做键（a<b 规范化，与 SQLite 后端一致） */
  recordCooccur(ids, now = Date.now()) {
    const list = Array.from(new Set((ids || []).filter(Boolean))).sort();
    if (list.length < 2) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = list[i] + '|' + list[j];
        const cur = this.cooccur.get(key);
        this.cooccur.set(key, { count: (cur ? cur.count : 0) + 1, lastAt: now });
        n++;
      }
    }
    this.flush();
    return n;
  }

  cooccurPairs({ minCount = 1, limit = 5000 } = {}) {
    const out = [];
    for (const [key, v] of this.cooccur) {
      if (v.count < minCount) continue;
      const [a, b] = key.split('|');
      out.push({ a, b, count: v.count });
    }
    out.sort((x, y) => y.count - x.count);
    return out.slice(0, limit);
  }

  /** 清孤儿共现（JSON 后端没有 updates 表，那一项恒为 0） */
  pruneOrphans() {
    let removed = 0;
    for (const key of [...this.cooccur.keys()]) {
      const [a, b] = key.split('|');
      if (!this.records.has(a) || !this.records.has(b)) {
        this.cooccur.delete(key);
        removed++;
      }
    }
    let vecRemoved = 0;
    for (const id of [...this.vectors.keys()]) {
      if (!this.records.has(id)) {
        this.vectors.delete(id);
        vecRemoved++;
      }
    }
    if (removed || vecRemoved) this.flush();
    return { cooccur: removed, updates: 0, vectors: vecRemoved };
  }

  /* ── 向量（可选 embedding） ── */

  putVector(id, { model, vec }) {
    if (!id || !vec || !vec.length) return false;
    this.vectors.set(id, { model: String(model || ''), dim: vec.length, vec: encodeVec(vec), at: Date.now() });
    this.flush();
    return true;
  }

  getVector(id) {
    const row = this.vectors.get(id);
    return row ? decodeVec(row.vec) : null;
  }

  getVectors(ids) {
    const out = new Map();
    for (const id of Array.isArray(ids) ? ids : []) {
      const v = this.getVector(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  vectorStats() {
    const live = [...this.records.values()].filter((r) => r.deletedAt == null);
    const withVec = live.filter((r) => this.vectors.has(r.id)).length;
    const models = new Map();
    for (const v of this.vectors.values()) models.set(v.model, (models.get(v.model) || 0) + 1);
    return {
      total: live.length,
      withVector: withVec,
      models: [...models.entries()].map(([model, c]) => ({ model, c })),
    };
  }

  /** JSON 后端无法做 SQLite 级别的完整性检查 */
  integrity() {
    return 'n/a (json backend)';
  }

  /**
   * JSON 后端没有倒排索引，只能全表扫 + 计算"query token 覆盖率"。
   * 数据量到几万条会慢，这正是主力走后端 SQLite 的原因。
   */
  candidates({ queryTokens = [], limit = 50, filters = {} }) {
    const qset = Array.from(new Set(queryTokens));
    if (qset.length === 0) return [];
    const out = [];
    for (const rec of this.records.values()) {
      if (rec.deletedAt != null) continue;
      if (filters.project && rec.project !== filters.project) continue;
      if (filters.kind && rec.kind !== filters.kind) continue;
      if (filters.tag && !rec.tags.includes(filters.tag)) continue;
      const hay = new Set([
        ...toIndexText(rec.content).split(' '),
        ...toIndexText(rec.topic).split(' '),
        ...toIndexText(rec.tags.join(' ')).split(' '),
      ]);
      let matched = 0;
      for (const t of qset) if (hay.has(t)) matched++;
      if (matched > 0) out.push({ record: rec, rawScore: matched / qset.length });
    }
    out.sort((a, b) => b.rawScore - a.rawScore);
    return out.slice(0, limit);
  }

  close() { this.flush(); }
}

// ---------------------------------------------------------------- 入口

/**
 * 打开存储。
 * @param {object} opts
 * @param {string} [opts.file]   数据文件路径（.db 或 .json）
 * @param {string} [opts.home]   DSH_HOME，未给 file 时用默认位置
 * @param {'auto'|'sqlite'|'json'} [opts.backend='auto']
 */
export function openStore({ file, home, backend = 'auto' } = {}) {
  const base = home || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');

  let chosen = backend;
  if (chosen === 'auto') chosen = sqliteAvailable() ? 'sqlite' : 'json';

  if (chosen === 'sqlite' && !sqliteAvailable()) {
    throw new Error('node:sqlite 在当前运行时不可用（需要 Node >= 22.5）；请改用 backend="json"');
  }

  if (chosen === 'sqlite') {
    const target = file || path.join(base, 'dsh-local-memory.db');
    return new SqliteBackend(target);
  }

  const target = file || path.join(base, 'dsh-local-memory.v2.json');
  return new JsonBackend(target);
}
