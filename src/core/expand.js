/**
 * 图扩展召回（可选，默认关）。
 *
 * 思路：关键词只认"字面碰巧一样"，召回不了"说法不同但确实相关"的记忆。
 * 所以当命中太少时，沿着**共现边**把邻居补进来：
 *   这两条记忆曾经被一起注入过 → 它们大概在讲同一件事。
 *
 * 为什么限制得这么死（1 跳 / 最多 3 条 / 权重 ×0.3 / 只在命中 <3 时触发）：
 *   - 共现边本质是"被一起注入过"，拿它做召回会形成自我强化回路
 *     （被一起注入 → 更容易再一起注入 → 更容易被一起注入）
 *   - 热门节点会把一堆无关的拖进来
 *   - 只在"本来没搜到几条"时才补，避免把已经很准的结果搅浑
 *
 * 所以它是**兜底**，不是主路径。
 */

/** 默认参数（都写死理由，不做成用户可调，免得把回路放大） */
export const GRAPH_EXPAND = {
  maxAdded: 3,          // 最多补 3 条
  weight: 0.3,          // 每条按命中分的 30% 计入
  whenFewerThan: 3,     // 命中不足 3 条才扩展
  minCooccur: 2,        // 只认"至少一起出现过 2 次"的边，一次巧合不算
};

/**
 * @param {object} store      openStore 的实例
 * @param {Array}  results    search() 的结果
 * @param {object} [opts]
 * @returns {Array} 可能变长的结果数组（新增项的 why.graphExpanded = true）
 */
export function expandByGraph(store, results, opts = {}) {
  const cfg = { ...GRAPH_EXPAND, ...opts };
  if (!Array.isArray(results)) return results;
  if (results.length >= cfg.whenFewerThan) return results;
  if (typeof store.cooccurPairs !== 'function' || typeof store.get !== 'function') return results;

  let pairs = [];
  try { pairs = store.cooccurPairs({ minCount: cfg.minCooccur, limit: 5000 }) || []; } catch { return results; }
  if (!pairs.length) return results;

  // 邻接表：id -> [{ id, count }]，按次数从高到低
  const adj = new Map();
  for (const p of pairs) {
    if (!p || !p.a || !p.b) continue;
    if (!adj.has(p.a)) adj.set(p.a, []);
    if (!adj.has(p.b)) adj.set(p.b, []);
    adj.get(p.a).push({ id: p.b, count: p.count || 1 });
    adj.get(p.b).push({ id: p.a, count: p.count || 1 });
  }
  for (const list of adj.values()) list.sort((x, y) => y.count - x.count);

  const have = new Set(results.map((r) => r.record && r.record.id));
  const added = [];
  // 从分最高的命中出发，逐个取它的邻居
  for (const hit of results) {
    if (added.length >= cfg.maxAdded) break;
    const id = hit.record && hit.record.id;
    const neighbors = adj.get(id) || [];
    for (const nb of neighbors) {
      if (added.length >= cfg.maxAdded) break;
      if (have.has(nb.id)) continue;
      let rec = null;
      try { rec = store.get(nb.id); } catch { rec = null; }
      if (!rec || rec.deletedAt || rec.status === 'consolidated') continue;
      have.add(nb.id);
      added.push({
        record: rec,
        score: (hit.score || 0) * cfg.weight,
        why: { graphExpanded: true, via: id, cooccurCount: nb.count },
      });
    }
  }

  return results.concat(added);
}
