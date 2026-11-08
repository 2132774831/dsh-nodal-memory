/**
 * HTTP 路由：设置页 / 关系图页面用。
 *
 * 契约（与 v1 一致的部分）：
 *   - 前缀统一挂在 `/dsh-local-memory` 下，用 ctx.webServer.register({kind:'prefix', ...})
 *   - **每个请求先过信任栅栏**：`ctx.get('connection').requestRejection(req)`。
 *     不过这一关的话，用户随手打开的任何网页都能 fetch 到本机接口读写记忆库。
 *
 * 与 v1 的差别：
 *   - 路径改成 REST 风格（/memories/:id），删除是软删，另给 /restore 和 /purge 两个显式动作
 *   - 新增 /graph：直接吐出关系图的点和边（前端只负责画，不负责算）
 *   - 新增 /review：体检报告
 */

import { readConfig, writeConfig, DEFAULTS, NS, configFile } from './config.js';
import { buildGraph } from '../core/graph.js';
import { search } from '../core/search.js';
import { runMaintenance, maintenanceInfo } from '../core/maintenance.js';
import { findConflicts, reviewCandidates } from '../core/insight.js';
import { inferKindFromContent, classifyBatch } from '../core/classify.js';
import { getEmbedder, backfillVectors, queryVectorFor } from './embedding.js';
import { reviewStore } from './tools.js';

export const ROUTE_BASE = '/' + NS;
const MAX_BODY = 512 * 1024;

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function sendText(res, type, text, filename) {
  const body = Buffer.from(text, 'utf8');
  const headers = {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  res.writeHead(200, headers);
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve('');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function parseInt_(value, fallback, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 导出成 Markdown：给人看、给别的 Agent 读、也是跨电脑迁移的通用格式 */
function toMarkdown(records, config) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const lines = [
    '# 本地记忆导出（dsh-local-memory）',
    '',
    `- 导出时间：${stamp}`,
    `- 条数：${records.length}`,
    `- 后端：${config.backend}`,
    '',
  ];
  for (const rec of records) {
    const d = new Date(rec.createdAt);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    lines.push(`## ${rec.id} · ${date}`);
    const meta = [];
    if (rec.project) meta.push(`项目 ${rec.project}`);
    if (rec.kind && rec.kind !== 'unknown') meta.push(`类别 ${rec.kind}`);
    if (rec.importance) meta.push(`重要度 ${rec.importance}`);
    if (rec.tags.length) meta.push(`标签 ${rec.tags.join(', ')}`);
    if (meta.length) lines.push('', meta.join(' · '));
    lines.push('', rec.content, '');
  }
  return lines.join('\n');
}

/**
 * 对外返回配置时**必须脱敏**：直接填的 apiKey 绝不能回显给浏览器，
 * 只回一个 hasStoredKey 让界面能显示"已配置"。
 */
function maskConfig(cfg) {
  const embed = { ...(cfg.embedding || {}) };
  const hasStoredKey = Boolean(embed.apiKey);
  if (hasStoredKey) embed.apiKey = '';
  embed.hasStoredKey = hasStoredKey;
  return { ...cfg, embedding: embed };
}

/** 当前 embedding 状态（给设置页显示"配没配、算了多少条向量"） */
function describeEmbedding(store) {
  try {
    const embedder = getEmbedder();
    return {
      enabled: embedder.enabled,
      model: embedder.model || null,
      baseUrl: embedder.baseUrl || null,
      apiKeyEnv: embedder.apiKeyEnv || null,
      hasKey: embedder.hasKey(),
      vectors: typeof store.vectorStats === 'function' ? store.vectorStats() : null,
    };
  } catch {
    return { enabled: false, vectors: null };
  }
}

/**
 * @param {object} ctx 宿主上下文
 * @param {object} deps { getStore, disposers }
 */
export function registerRoutes(ctx, deps) {  const { getStore, disposers } = deps;
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') return;

  /** 浏览器信任栅栏。过不去就 403 直接结束，别往下走。 */
  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection;
      if (!conn || typeof conn.requestRejection !== 'function') return false;
      const code = conn.requestRejection(req);
      if (code === undefined || code === null || code === false) return false;
      res.statusCode = typeof code === 'number' ? code : 403;
      res.end();
      return true;
    } catch {
      return false;
    }
  }

  async function handler(req, res) {
    if (rejected(req, res)) return;

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return;
    }

    const sub = url.pathname.slice(ROUTE_BASE.length) || '/';
    const parts = sub.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    const method = (req.method || 'GET').toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());

    try {
      const store = getStore();
      const config = readConfig();

      /* GET /state —— 概览：配置 + 统计 */
      if (parts.length === 0 || (parts.length === 1 && parts[0] === 'state')) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return sendJson(res, 200, {
          ok: true,
          config: maskConfig(config),
          defaults: DEFAULTS,
          stats: store.stats(),
          backend: store.backend,
          maintenance: maintenanceInfo(store),
          embedding: describeEmbedding(store),
          paths: { db: store.file || null, config: configFile() },
        });
      }

      /* POST /embedding/test —— 验证用户填的端点是否可用（不写任何数据） */
      if (parts.length === 2 && parts[0] === 'embedding' && parts[1] === 'test') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        const embedder = getEmbedder();
        if (!embedder.enabled) {
          return sendJson(res, 200, {
            ok: false,
            enabled: false,
            error: 'embedding 未启用（需要同时填 baseUrl 与 model）',
          });
        }
        const started = Date.now();
        const r = await embedder.embedOne('这是一条用于验证端点的测试文本');
        return sendJson(res, 200, {
          ok: r.ok === true,
          enabled: true,
          model: embedder.model,
          baseUrl: embedder.baseUrl,
          apiKeyEnv: embedder.apiKeyEnv,
          hasKey: embedder.hasKey(),
          dim: r.ok ? r.vector.length : null,
          ms: Date.now() - started,
          error: r.ok ? null : r.error,
        });
      }

      /* POST /embedding/backfill —— 给历史记忆补向量（一次一小批） */
      if (parts.length === 2 && parts[0] === 'embedding' && parts[1] === 'backfill') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        const limit = parseInt_(query.limit, 20, 1, 200);
        const result = await backfillVectors(store, { limit });
        return sendJson(res, 200, { ok: result.ok, result, vectors: store.vectorStats() });
      }

      /* POST /maintenance —— 手动跑一次维护（清理孤儿行 + 记统计快照） */
      if (parts.length === 1 && parts[0] === 'maintenance') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        const result = runMaintenance(store, { force: true });
        return sendJson(res, 200, { ok: true, result, info: maintenanceInfo(store) });
      }

      /* GET /memories —— 列表 / 检索 */
      if (parts.length === 1 && parts[0] === 'memories' && method === 'GET') {
        const limit = parseInt_(query.limit, 50, 1, 500);
        const offset = parseInt_(query.offset, 0, 0, 1e6);
        const includeDeleted = query.includeDeleted === '1' || query.includeDeleted === 'true';

        if (query.q) {
          const filters = {};
          if (query.project) filters.project = query.project;
          if (query.kind) filters.kind = query.kind;
          if (query.tag) filters.tag = query.tag;
          // 配了 embedding 就用查询向量（拿不到就退回纯关键词）——
          // 之前这里没传，导致网页搜索其实是纯关键词，语义层等于白开
          const queryVector = await queryVectorFor(query.q);
          const hits = search(store, query.q, { limit, filters, queryVector });
          return sendJson(res, 200, {
            ok: true,
            total: store.count(),
            matched: hits.length,
            memories: hits.map((h) => ({ ...h.record, score: Number(h.score.toFixed(4)), why: h.why })),
          });
        }

        const memories = store.list({
          limit,
          offset,
          project: query.project,
          kind: query.kind,
          tag: query.tag,
          includeDeleted,
        });
        return sendJson(res, 200, { ok: true, total: store.count(), memories });
      }

      /* POST /memories —— 新增 */
      if (parts.length === 1 && parts[0] === 'memories' && method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
        const content = String(body.content ?? body.text ?? '').trim();
        if (!content) return sendJson(res, 400, { ok: false, error: 'content 不能为空' });
        // 没给类别（或给了 unknown）时按内容粗分。kind 决定半衰期，
        // 全都落在 unknown 的话"情感忘得快/偏好记得久"就是空转。
        let kind = body.kind;
        let kindWhy = null;
        if ((!kind || kind === 'unknown') && readConfig().features?.autoKind !== false) {
          const guess = inferKindFromContent(content, { tags: body.tags });
          if (guess.kind !== 'unknown') { kind = guess.kind; kindWhy = guess.why; }
        }
        // 精确查重：和 memory_save 保持一致（同一句再存一次只合并标签，不新增一条）。
        // 网页端之前不查重，导致"同一条写两遍"在库里出现两份。
        const existing = store.list({ limit: 100000 }).find((r) => r.content === content);
        if (existing) {
          const mergedTags = Array.from(new Set([...(existing.tags || []), ...(Array.isArray(body.tags) ? body.tags : [])]));
          store.put({ ...existing, tags: mergedTags, updatedAt: Date.now() });
          return sendJson(res, 200, {
            ok: true, id: existing.id, created: false,
            memory: store.get(existing.id), note: '内容已存在，已合并标签',
          });
        }
        const out = store.put({
          content,
          tags: body.tags,
          kind,
          importance: body.importance,
          project: body.project,
          topic: body.topic,
          source: 'ui',
        });
        return sendJson(res, 200, { ok: true, id: out.id, created: out.created, kindWhy, memory: out.record });
      }

      /* /memories/:id —— 更新 / 软删；/memories/:id/restore|purge —— 恢复 / 彻底删 */
      if (parts[0] === 'memories' && parts.length >= 2) {
        const id = parts[1];

        if (parts.length === 3) {
          const action = parts[2];
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          const existing = store.get(id);
          if (!existing) return sendJson(res, 404, { ok: false, error: 'not found' });
          if (action === 'restore') {
            store.restore(id);
            return sendJson(res, 200, { ok: true, memory: store.get(id) });
          }
          if (action === 'purge') {
            store.purge(id);
            return sendJson(res, 200, { ok: true, purged: true });
          }
          return sendJson(res, 404, { ok: false, error: 'unknown action' });
        }

        if (method === 'DELETE') {
          const ok = store.remove(id);
          return sendJson(res, ok ? 200 : 404, { ok, id, softDeleted: ok });
        }

        if (method === 'POST') {
          const existing = store.get(id);
          if (!existing) return sendJson(res, 404, { ok: false, error: 'not found' });
          const raw = await readBody(req);
          let body;
          try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }

          const next = { ...existing };
          if (body.content !== undefined) next.content = String(body.content).trim();
          if (body.tags !== undefined) next.tags = body.tags;
          if (body.kind !== undefined) next.kind = body.kind;
          if (body.importance !== undefined) next.importance = body.importance;
          if (body.project !== undefined) next.project = String(body.project);
          if (body.topic !== undefined) next.topic = String(body.topic);
          if (body.status !== undefined) next.status = body.status;
          if (body.pinned !== undefined) next.pinned = body.pinned ? 1 : 0;
          next.updatedAt = Date.now();
          if (!next.content) return sendJson(res, 400, { ok: false, error: 'content 不能为空' });

          store.put(next);
          return sendJson(res, 200, { ok: true, memory: store.get(id) });
        }

        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }

      /* GET /graph —— 关系图数据（点 + 边，已在服务端算好） */
      if (parts.length === 1 && parts[0] === 'graph' && method === 'GET') {
        const records = store.list({
          limit: parseInt_(query.limit, 2000, 1, 20000),
          project: query.project,
          kind: query.kind,
        });
        let cooccur = [];
        if (typeof store.cooccurPairs === 'function') {
          cooccur = store.cooccurPairs({ minCount: parseInt_(query.minCooccur, 1, 1, 100), limit: 20000 });
        }
        // 有向量就带上去做语义连线；没有就整段跳过（不影响其它关系）
        const cfg = readConfig();
        const feat = cfg.features || {};
        let vectors = null;
        if (feat.semanticEdges !== false && query.semantic !== '0' && typeof store.getVectors === 'function') {
          const ids = records.map((r) => r.id);
          const have = store.getVectors(ids);
          if (have && have.size > 0) vectors = have;
        }
        const graph = buildGraph(records, {
          cooccur,
          vectors,
          maxEdges: parseInt_(query.maxEdges, 4000, 10, 50000),
          timeWindowDays: parseInt_(query.timeWindowDays, 7, 1, 365),
          maxGroupSize: parseInt_(query.maxGroupSize, 12, 2, 500),
          semanticThreshold: Number.isFinite(Number(query.sim)) ? Number(query.sim) : undefined,
          semanticTopK: parseInt_(query.topK, 3, 1, 10),
          includeProject: feat.projectEdges === true,
          includeTime: feat.timeEdges === true,
          labelChars: parseInt_(query.labelChars, 60, 10, 400),
        });
        return sendJson(res, 200, { ok: true, ...graph, features: feat });
      }

      /* POST /classify/auto —— 给存量未分类记忆按内容补标（先 dryRun 预览，再执行） */
      if (parts.length === 2 && parts[0] === 'classify' && parts[1] === 'auto' && method === 'POST') {
        // readBody 返回的是**字符串**，必须自己 parse —— 直接当对象用会让 dryRun 永远为 true
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        const dryRun = body.dryRun !== false;   // 默认只预览，必须显式 dryRun:false 才写
        const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(5000, Number(body.limit))) : 5000;
        const unknown = store.list({ limit }).filter((r) => (r.kind || 'unknown') === 'unknown');
        const suggestions = classifyBatch(unknown);
        const byTo = {};
        for (const s of suggestions) byTo[s.to] = (byTo[s.to] || 0) + 1;

        if (dryRun) {
          return sendJson(res, 200, {
            ok: true, dryRun: true, scanned: unknown.length, byTo,
            samples: suggestions.filter((s) => s.to !== 'unknown').slice(0, 10),
          });
        }

        let updated = 0;
        for (const s of suggestions) {
          if (s.to === 'unknown') continue;
          store.put({ ...store.get(s.id), kind: s.to });
          updated++;
        }
        store.setMeta?.('lastAutoClassifyAt', Date.now());
        return sendJson(res, 200, { ok: true, dryRun: false, scanned: unknown.length, updated, byTo });
      }

      /* GET /insight —— 直觉：疑似冲突 + 该想起的（只读，只给候选） */
      if (parts.length === 1 && parts[0] === 'insight' && method === 'GET') {
        const cfg = readConfig();
        const feat = cfg.features || {};
        const all = store.list({ limit: parseInt_(query.limit, 2000, 1, 20000) });

        if (feat.conflictScan === false && feat.dueReview === false) {
          return sendJson(res, 200, { ok: true, conflicts: [], dueReview: [], disabled: true });
        }

        const ids = all.map((r) => r.id);
        let vectors = null;
        if (typeof store.getVectors === 'function') {
          const have = store.getVectors(ids);
          if (have && have.size > 0) vectors = have;
        }

        // 灵敏度三档。默认 normal 是"少而准"那一档：宁可漏，也不要一次给 50 条噪声
        const sens = {
          strict: { minOverlap: 0.26, minSemantic: 0.78 },
          normal: { minOverlap: 0.20, minSemantic: 0.72 },
          loose: { minOverlap: 0.14, minSemantic: 0.64 },
        }[cfg.conflictSensitivity || 'normal'] || { minOverlap: 0.2, minSemantic: 0.72 };

        const conflicts = feat.conflictScan === false
          ? { pairs: [], skipped: '已关闭' }
          : findConflicts(all, {
            vectors,
            limit: parseInt_(query.maxConflicts, 30, 1, 100),
            minOverlap: Number.isFinite(Number(query.minOverlap)) ? Number(query.minOverlap) : sens.minOverlap,
            minSemantic: Number.isFinite(Number(query.minSemantic)) ? Number(query.minSemantic) : sens.minSemantic,
          });
        const dueReview = feat.dueReview === false ? [] : reviewCandidates(all, {
          limit: parseInt_(query.reviewLimit, 8, 1, 50),
          minDays: parseInt_(query.minDays, 14, 0, 3650),
        });
        return sendJson(res, 200, {
          ok: true,
          conflicts: conflicts.pairs,
          conflictNote: conflicts.skipped || null,
          dueReview,
          sensitivity: cfg.conflictSensitivity || 'normal',
        });
      }

      /* GET /review —— 体检报告（只读） */      if (parts.length === 1 && parts[0] === 'review' && method === 'GET') {
        const report = reviewStore(store, {
          staleDays: parseInt_(query.staleDays, 180, 1, 3650),
          neverUsedDays: parseInt_(query.neverUsedDays, 30, 1, 3650),
        });
        return sendJson(res, 200, { ok: true, report });
      }

      /* POST /config —— 改配置（局部更新） */
      if (parts.length === 1 && parts[0] === 'config' && method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
        const next = writeConfig(body);
        return sendJson(res, 200, { ok: true, config: maskConfig(next) });
      }

      /* GET /export —— 导出 Markdown */
      if (parts.length === 1 && parts[0] === 'export' && method === 'GET') {
        let records = store.list({ limit: 100000 });
        if (query.q) {
          records = search(store, query.q, { limit: 100000 }).map((h) => h.record);
        } else if (query.tag) {
          records = store.list({ limit: 100000, tag: query.tag });
        }
        const md = toMarkdown(records, config);
        return sendText(res, 'text/markdown', md, 'dsh-local-memory.md');
      }

      return sendJson(res, 404, { ok: false, error: 'unknown route', path: sub });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler,
  }));
}
