/**
 * 图扩展召回（可选，默认关）。
 *
 * ⚠ v2 重写：**共现边退出扩展路径**。
 *
 * 为什么砍掉共现：它的数据源是"这两条被同一次检索/注入一起用到过"——
 * 测的不是记忆间的相关性，而是**检索系统的历史行为**。拿它做扩展 → 被一起注入
 * → 下次更容易被一起注入，是标准的 rich-get-richer；而且每轮 top5 注入会在
 * 5 条之间形成完全子图，几十轮后边就饱和了（实测 109 条记忆已有 372 条边）。
 * 共现边保留下来只做可视化和分析，**不参与召回**。
 *
 * 现在只用**外生信号**（不依赖检索行为，天然免疫反馈回路）：
 *
 *   1. 同会话   —— 同一次对话产生的记忆（真实事件，最强）
 *   2. 时间推断 —— 老数据没有会话 id，按时间窗口推断（弱，必须降权并标注）
 *   3. 同类事   —— 共享标签 + 稀有词 IDF overlap（跨项目也能连）
 *
 * 三条硬限制（防止上下文被噪声淹没）：
 *   - 命中已经够多（默认 ≥3 条）就不扩展
 *   - 总预算 600 字（不是按条数：4 条长记忆能顶 8 条短的）
 *   - 补进来的相关性必须 ≥ 最高命中的 0.6
 */
import { tokenSet } from './text.js';

export const GRAPH_EXPAND = {
  maxAdded: 4,              // 最多补 4 条
  maxChars: 1200,           // 总字数预算（600 太紧：单条长记忆就有 600+ 字，会被整条挡掉）
  whenFewerThan: 3,         // 命中不足 3 条才扩展
  minRelRatio: 0.6,         // 补进来的分数不得低于最高命中的 60%
  weight: 0.35,             // 基础折扣
  inferredWeight: 0.6,      // 时间推断事件再打折
  kindredWeight: 0.7,       // 同类事再打折
  /** 稀有词 IDF overlap 下限。实测 109 条语料：≥0.05 命中 27 对（0.46%），
   *  而 token 余弦 max 只有 0.333 —— 所以余弦 0.35 是空转，这个值是量出来的 */
  kindredOverlap: 0.05,
  /** 老数据推断事件的窗口。实测间隔 p50=23min、15min 窗口最大组 7 条（30min 会出 12 条组） */
  inferredWindowMs: 15 * 60 * 1000,
};

/** 粗算一条记忆的"字数量"（中文按字、英文按词，够用） */
function sizeOf(rec) {
  return String(rec.content || '').length;
}

/**
 * 计算"稀有词 overlap"：只算两边都有的、且出现次数 ≤3 的词（罕见词才是身份标识），
 * 用 IDF 加权后除以较短一侧的总权重。
 * 为什么不用余弦：余弦对长度敏感（长记忆被稀释、短记忆虚高），
 * 而 |交集|/min 对长度鲁棒，且天然偏袒"共享稀有词"。
 */
function rareOverlap(setA, setB, df, total) {
  if (!setA.size || !setB.size) return 0;
  const idf = (w) => Math.log(1 + total / Math.max(1, df.get(w) || 1));
  let shared = 0;
  for (const w of setA) {
    if (setB.has(w) && (df.get(w) || 0) <= 3) shared += idf(w);
  }
  if (!shared) return 0;
  let wa = 0; for (const w of setA) wa += idf(w);
  let wb = 0; for (const w of setB) wb += idf(w);
  const minW = Math.min(wa, wb);
  return minW > 0 ? shared / minW : 0;
}

/**
 * @param {object} store
 * @param {Array}  results  search() 的结果（按分数降序）
 * @param {object} [opts]
 * @returns {Array} 可能变长的结果
 */
export function expandByGraph(store, results, opts = {}) {
  const cfg = { ...GRAPH_EXPAND, ...opts };
  if (!Array.isArray(results) || !results.length) return results;
  if (results.length >= cfg.whenFewerThan) return results;

  const have = new Set(results.map((r) => r.record && r.record.id));
  const topScore = results[0].score || 0;
  // 相关性下限的语义：**只从"够强的命中"出发展开**。
  //   （不是约束折扣后新增项的分数——那和 weight=0.35 自相矛盾，永远加不进来）
  const floor = topScore * cfg.minRelRatio;

  // 语料级 IDF（只看最近 500 条，够估算稀有度；全库扫描太重）
  let corpus = [];
  try { corpus = store.list({ limit: 500 }) || []; } catch { corpus = []; }
  const total = Math.max(1, corpus.length);
  const df = new Map();
  const sets = new Map();
  for (const r of corpus) {
    const st = tokenSet(r.content || '');
    sets.set(r.id, st);
    for (const w of st) df.set(w, (df.get(w) || 0) + 1);
  }

  const added = [];
  let budget = cfg.maxChars;
  const label = (why) => (why === 'session' ? '同一次对话' : why === 'inferred' ? '同时间段（推断）' : '同类事');

  for (const hit of results) {
    if (added.length >= cfg.maxAdded || budget <= 0) break;
    // 弱命中不展开：它自己都排不上号，靠它拉出来的邻居只会更弱
    if ((hit.score || 0) < floor) continue;
    const rec = hit.record;
    if (!rec) continue;
    const candidates = [];

    /* 1. 同一次对话（真实事件） */
    if (rec.sessionId && typeof store.listBySession === 'function') {
      try {
        for (const r of store.listBySession(rec.sessionId, { limit: 8, excludeId: rec.id })) {
          candidates.push({ rec: r, why: 'session' });
        }
      } catch { /* 忽略 */ }
    }

    /* 2. 老数据没有会话 id：时间窗口推断，必须降权 */
    if (!rec.sessionId && typeof store.listNear === 'function') {
      try {
        for (const r of store.listNear(rec.createdAt, cfg.inferredWindowMs, { limit: 8, excludeId: rec.id })) {
          candidates.push({ rec: r, why: 'inferred' });
        }
      } catch { /* 忽略 */ }
    }

    /* 3. 同类事：只看内容重合（和关系图同一套口径）
     *
     * 早先这里要求"必须共享标签"，和图上的判定不一致：
     * 图上能连起来的同类事，搜索时带不出来，用户会觉得"明明连了线却搜不到"。
     * 现在统一成：不要求标签，只要求稀有词重合 ≥ 阈值，且不是两边都没项目。
     * 候选池用上面算 IDF 时已经取过的 corpus，不额外查库。 */
    if (typeof store.list === 'function') {
      const recSet = sets.get(rec.id) || tokenSet(rec.content || '');
      const mine = [];
      for (const r of corpus) {
        if (!r || r.id === rec.id || r.deletedAt) continue;
        // 两边都没项目 → 谈不上归属，跳过（和图一致）
        if (!rec.project && !r.project) continue;
        const ov = rareOverlap(recSet, sets.get(r.id) || tokenSet(r.content || ''), df, total);
        if (ov >= cfg.kindredOverlap) mine.push({ rec: r, why: 'kindred', ov });
      }
      // 每命中最多补 2 条，按重合度从高到低
      mine.sort((a, b) => b.ov - a.ov);
      for (const c of mine.slice(0, 2)) candidates.push(c);
    }

    for (const c of candidates) {
      if (added.length >= cfg.maxAdded || budget <= 0) break;
      const r = c.rec;
      if (!r || have.has(r.id) || r.deletedAt || r.status === 'consolidated') continue;
      const chars = sizeOf(r);
      if (chars > budget) continue;

      const factor = cfg.weight
        * (c.why === 'inferred' ? cfg.inferredWeight : 1)
        * (c.why === 'kindred' ? cfg.kindredWeight : 1);
      const score = (hit.score || 0) * factor;   // 一定低于来源命中，保证排序在它后面

      have.add(r.id);
      budget -= chars;
      added.push({
        record: r,
        score,
        why: { graphExpanded: true, via: c.why, viaId: rec.id, label: label(c.why) },
      });
    }
  }

  return results.concat(added);
}
