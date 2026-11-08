/**
 * 记忆关系图：给可视化层算"点"和"边"。
 *
 * 核心判断：**边不能靠"语义相似度"**。纯本地算不出可靠语义，硬算出来就是一团噪声。
 * 这里只用四种**确定性**关系，每种都能向用户解释清楚"为什么连这条线"：
 *
 *   1. 共现（最强）  两条记忆在同一次检索/注入里同时出现 → 它们在话题上真的挨着。
 *                    这是使用痕迹，云端方案拿不到，我们也只在有历史时才有。
 *   2. 共享标签      idf 加权：越冷门的标签，绑得越紧（"pitfall" 满库都是，说明不了什么；
 *                    只有两条记忆都带 "topic:voice-mode" 才是强关联）。
 *   3. 同项目        弱连接，主要用于把同一次工作产出的记忆聚成团。
 *   4. 时间相邻      最弱，只连"时间上最近的那一条"，纯粹为了布局时不要散成飞地。
 *
 * 另一个重点是**别画成毛线球**：
 *   - 出现在超过 30% 记忆上的标签直接不画边（否则一个 "topic:dsh-plugin" 就能连出蜘蛛网）
 *   - 总边数有上限，按权重从高到低保留
 *   - 输出 degree / isolated，让界面能把孤岛单独拎出来
 */

const DEFAULT_MAX_EDGES = 4000;
const DEFAULT_DOMINANT_RATIO = 0.3;
const DEFAULT_TIME_WINDOW_DAYS = 7;
/**
 * 语义连线的默认值，是**量出来的**不是拍的：
 * 真实 75 条记忆（qwen 1024 维）两两相似度 min 0.13 / p50 0.34 / p90 0.46 / p99 0.60 / max 0.82。
 * 常见的 0.8 阈值在这批数据上只能连出 0-2 条，等于没有。
 * 0.60 能连出 26 条（每点 0.7 条）——是"补充信息"，不会压垮原有的 284 条关系边。
 */
const DEFAULT_SEMANTIC_THRESHOLD = 0.6;
const DEFAULT_SEMANTIC_TOPK = 3;
/** 语义是 O(n²) 点积，点数太多会卡；超过就不算（并在 stats 里说明） */
const DEFAULT_SEMANTIC_MAX_NODES = 600;
/**
 * 一个"分组"最多几个成员还值得两两连线。
 * 组内成员越多，"它们相关"这句话的信息量越小——59 条记忆同属一个项目，
 * 两两相连就是 1711 条边，画出来是一团黑，等于什么也没说。
 * 所以超过这个数就整组不连（真实数据上 default-workspace 有 59 条，正是这种情况）。
 */
const DEFAULT_MAX_GROUP_SIZE = 12;

const KIND_PRIORITY = { cooccur: 4, tag: 3, semantic: 2, project: 1, time: 0 };

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * @param {object[]} records  记忆记录（已排除已删除）
 * @param {object} [opts]
 * @param {{a:string,b:string,count:number}[]} [opts.cooccur] 共现对
 * @param {number} [opts.now]
 * @param {number} [opts.maxEdges]
 * @param {number} [opts.dominantTagRatio] 一个标签命中超过这个比例的节点就不画它的边
 * @param {number} [opts.timeWindowDays]
 * @param {number} [opts.labelChars]
 */
export function buildGraph(records, opts = {}) {
  const {
    cooccur = [],
    vectors = null,
    now = Date.now(),
    maxEdges = DEFAULT_MAX_EDGES,
    dominantTagRatio = DEFAULT_DOMINANT_RATIO,
    timeWindowDays = DEFAULT_TIME_WINDOW_DAYS,
    maxGroupSize = DEFAULT_MAX_GROUP_SIZE,
    semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD,
    semanticTopK = DEFAULT_SEMANTIC_TOPK,
    semanticMaxNodes = DEFAULT_SEMANTIC_MAX_NODES,
    includeProject = true,
    includeTime = true,
    labelChars = 60,
  } = opts;

  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  const n = list.length;
  const index = new Map();
  list.forEach((rec, i) => index.set(rec.id, i));

  const nodes = list.map((rec) => ({
    id: rec.id,
    label: truncate(rec.content, labelChars),
    kind: rec.kind || 'unknown',
    importance: rec.importance || 'important',
    project: rec.project || '',
    tags: Array.isArray(rec.tags) ? rec.tags : [],
    createdAt: rec.createdAt,
    ageDays: Math.max(0, Math.floor((now - rec.createdAt) / 86400000)),
    accessCount: rec.accessCount || 0,
    degree: 0,
    isolated: true,
  }));

  // ── 标签频次：用来算 idf，也用来识别"太泛滥所以不画"的标签
  const tagFreq = new Map();
  for (const rec of list) {
    for (const tag of rec.tags || []) tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1);
  }
  const dominantThreshold = Math.max(2, Math.ceil(n * dominantTagRatio));
  const dominantTags = [...tagFreq.entries()]
    .filter(([, c]) => c > dominantThreshold)
    .map(([t]) => t)
    .sort();

  /** 边去重：同一对节点只保留一条，权重取最大，但把"为什么连"都记下来 */
  const edgeMap = new Map();
  /** 因为"组太大所以没连"的分组，给 UI 一个解释，免得用户以为漏画了 */
  const oversizedGroups = [];
  const pairKey = (i, j) => (i < j ? i + ':' + j : j + ':' + i);

  function addEdge(i, j, kind, weight, detail) {
    if (i === j || i == null || j == null) return;
    const key = pairKey(i, j);
    const cur = edgeMap.get(key);
    if (!cur) {
      edgeMap.set(key, { a: Math.min(i, j), b: Math.max(i, j), kind, weight, kinds: [kind], detail: detail ? [detail] : [] });
      return;
    }
    if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
    if (detail && !cur.detail.includes(detail)) cur.detail.push(detail);
    // 主类型按优先级定，权重取两者较大值（一条边只画一次，但要能解释全部理由）
    if (KIND_PRIORITY[kind] > KIND_PRIORITY[cur.kind]) cur.kind = kind;
    cur.weight = Math.max(cur.weight, weight);
  }

  // ── 1. 共现
  for (const pair of cooccur) {
    const i = index.get(pair.a);
    const j = index.get(pair.b);
    if (i == null || j == null) continue; // 其中一条被删了
    const count = Math.max(1, pair.count || 1);
    addEdge(i, j, 'cooccur', 1 + Math.log1p(count), `共同命中 ${count} 次`);
  }

  // ── 1.5 语义相似（需要向量，没有就整段跳过）
  // 每条只保留最强的 topK 条：否则一个"泛主题"记忆会和几十条都连上，又是一坨毛线球。
  let semanticSkipped = null;
  /** 联想用：每个 id 最像的几条（阈值比连线低，因为这里只是"提示你可能相关"） */
  const neighbors = {};
  if (vectors && semanticThreshold > 0) {
    if (n > semanticMaxNodes) {
      semanticSkipped = `点数 ${n} 超过上限 ${semanticMaxNodes}，跳过语义连线`;
    } else {
      const vecOf = (id) => (vectors instanceof Map ? vectors.get(id) : vectors[id]);
      const have = [];
      for (let i = 0; i < n; i++) {
        const v = vecOf(list[i].id);
        if (v && v.length) have.push(i);
      }
      const best = new Map();
      const assoc = new Map();          // i -> [{j,s}]，用于"联想"
      const ASSOC_FLOOR = 0.5;          // 比连线阈值低一档：低于这个就别提示了，没意义
      const ASSOC_TOP = 5;
      for (let x = 0; x < have.length; x++) {
        const i = have[x];
        const a = vecOf(list[i].id);
        for (let y = x + 1; y < have.length; y++) {
          const j = have[y];
          const b = vecOf(list[j].id);
          if (a.length !== b.length) continue; // 换过模型导致的维度不一致：不硬算
          let s = 0;
          for (let k = 0; k < a.length; k++) s += a[k] * b[k];
          if (s >= ASSOC_FLOOR) {
            if (!assoc.has(i)) assoc.set(i, []);
            if (!assoc.has(j)) assoc.set(j, []);
            assoc.get(i).push({ j, s });
            assoc.get(j).push({ j: i, s });
          }
          if (s < semanticThreshold) continue;
          if (!best.has(i)) best.set(i, []);
          if (!best.has(j)) best.set(j, []);
          best.get(i).push({ j, s });
          best.get(j).push({ j: i, s });
        }
      }
      // 联想表：每点最像的 ASSOC_TOP 条，带 id 和相似度（前端点击时用来做"浮出最像的"）
      for (const [i, cand] of assoc) {
        cand.sort((p, q) => q.s - p.s);
        neighbors[list[i].id] = cand.slice(0, ASSOC_TOP).map(({ j, s }) => ({
          id: list[j].id,
          sim: Number(s.toFixed(3)),
        }));
      }

      const kept = new Set();
      for (const [i, cand] of best) {
        cand.sort((p, q) => q.s - p.s);
        for (const { j, s } of cand.slice(0, semanticTopK)) {
          const key = i < j ? i + ':' + j : j + ':' + i;
          if (kept.has(key)) continue;
          kept.add(key);
          addEdge(i, j, 'semantic', s, '语义 ' + s.toFixed(2));
        }
      }
    }
  }

  // ── 2. 共享标签（idf 加权；泛滥标签和超大分组都不连）
  const byTag = new Map();
  for (let i = 0; i < n; i++) {
    for (const tag of list[i].tags || []) {
      if (dominantTags.includes(tag)) continue;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(i);
    }
  }
  for (const [tag, members] of byTag) {
    if (members.length > maxGroupSize) {
      oversizedGroups.push({ type: 'tag', name: tag, size: members.length });
      continue;
    }
    if (members.length < 2) continue;
    const freq = tagFreq.get(tag) || members.length;
    const weight = Math.log(1 + n / freq); // n=70、freq=2 → ≈3.6；freq=20 → ≈1.5
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) addEdge(members[x], members[y], 'tag', weight, tag);
    }
  }

  // ── 3. 同项目（同样是"组太大就不连"：59 条同一个项目连起来毫无信息量）
  // 注意：同项目是很弱的关系（只说明"同一摊事"），默认可以关掉让图更清爽。
  const byProject = new Map();
  if (includeProject) {
    for (let i = 0; i < n; i++) {
      const p = list[i].project;
      if (!p) continue;
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p).push(i);
    }
    for (const [project, members] of byProject) {
      if (members.length > maxGroupSize) {
        oversizedGroups.push({ type: 'project', name: project, size: members.length });
        continue;
      }
      if (members.length < 2) continue;
      for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) addEdge(members[x], members[y], 'project', 0.4, project);
      }
    }
  }

  // ── 4. 时间相邻：只连"时间上最近的一条"，避免 O(n²) 糊成一团
  // 这条关系几乎不承载信息（只是让布局别散成飞地），所以也可以关掉。
  if (includeTime) {
    const order = list.map((rec, i) => ({ i, t: rec.createdAt })).sort((a, b) => a.t - b.t);
    for (let k = 1; k < order.length; k++) {
      const prev = order[k - 1];
      const cur = order[k];
      const days = (cur.t - prev.t) / 86400000;
      if (days > timeWindowDays) continue;
      const weight = 0.15 * (1 - Math.min(1, days / timeWindowDays));
      addEdge(prev.i, cur.i, 'time', Math.max(0.05, weight), '创建时间相邻');
    }
  }

  // ── 收口：按权重排序、截断、算度数
  const edges = [...edgeMap.values()]
    .sort((x, y) => y.weight - x.weight)
    .slice(0, maxEdges)
    .map((e) => ({
      source: nodes[e.a].id,
      target: nodes[e.b].id,
      kind: e.kind,
      kinds: e.kinds,
      weight: Number(e.weight.toFixed(3)),
      detail: e.detail,
    }));

  // 度数分两种：
  //   degree      = 全部边（含 time），给布局力导向用
  //   linkDegree  = 只算"有语义"的边（标签/项目/共现），**孤岛判定只看这个**
  // 为什么必须分开：时间相邻会把所有创建时间接近的记忆串成一条链，
  // 如果孤岛按总度数算，就永远不会出现孤岛——而用户要看的恰恰是"没人理"的那些记忆。
  const degree = new Map();
  const linkDegree = new Map();
  for (const e of edges) {
    for (const id of [e.source, e.target]) {
      degree.set(id, (degree.get(id) || 0) + 1);
      if (e.kind !== 'time') linkDegree.set(id, (linkDegree.get(id) || 0) + 1);
    }
  }
  for (const node of nodes) {
    node.degree = degree.get(node.id) || 0;
    node.linkDegree = linkDegree.get(node.id) || 0;
    node.isolated = node.linkDegree === 0;
  }

  const byKind = new Map();
  for (const e of edges) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);

  return {
    nodes,
    edges,
    /** 联想表：id → [{id, sim}]。前端点击某条记忆时用它浮出"最像的几条" */
    neighbors,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      isolated: nodes.filter((x) => x.isolated).length,
      dominantTags,
      oversizedGroups,
      edgeKinds: Object.fromEntries(byKind),
      semanticSkipped,
      truncatedEdges: Math.max(0, edgeMap.size - edges.length),
    },
  };
}
