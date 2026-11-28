/**
 * 本地小模型：完全离线的事件连线。
 *
 * 为什么叫"小模型"而不是"关键词匹配"：
 *   这里做的是 TF-IDF 向量化 + 余弦相似度 + 互为最近邻约束，
 *   是一套真实的（很小的）文本表示模型，只是权重来自本地语料统计。
 *   全程在本机算，不发任何网络请求。
 *
 * 与 lexical 模式的区别：
 *   lexical 只看"稀有词有没有重合"（集合重叠）；
 *   这里把每条记忆变成稀疏向量，按夹角算相似度，长短文本更公平，
 *   再用"互为前 K 名"的约束，避免一个热门节点把所有人连成毛线球。
 */

/** 中文按二字、英文按单词切；标点全部丢掉 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  // 中文连续片段 → 二元组（单字段落保留单字）
  for (const run of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = run[0];
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/**
 * @param {Array<{id:string, content?:string, tags?:string[]}>} records
 * @param {{threshold?:number, topK?:number, maxPairs?:number}} opts
 * @returns {Array<{a:string, b:string, score:number}>}
 */
export function localLinkPairs(records, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.20;
  const topK = Math.max(1, Math.min(5, Number(opts.topK) || 2));
  const maxPairs = Math.max(1, Math.min(5000, Number(opts.maxPairs) || 400));

  const rows = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.id && String(r.content || '').trim().length >= 8);
  const n = rows.length;
  if (n < 2) return [];

  // 文档词频
  const docs = rows.map((r) => {
    const toks = tokenize(String(r.content || '') + ' ' + (Array.isArray(r.tags) ? r.tags.join(' ') : ''));
    const tf = new Map();
    for (const w of toks) tf.set(w, (tf.get(w) || 0) + 1);
    return tf;
  });

  // 文档频率 → IDF
  const df = new Map();
  for (const tf of docs) for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const idf = new Map();
  for (const [w, d] of df) idf.set(w, Math.log((n + 1) / (d + 1)) + 1);

  // TF-IDF 向量（L2 归一化）
  const vecs = docs.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const weight = (1 + Math.log(c)) * (idf.get(w) || 1);
      if (weight <= 0) continue;
      v.set(w, weight);
      norm += weight * weight;
    }
    const len = Math.sqrt(norm) || 1;
    for (const [w, weight] of v) v.set(w, weight / len);
    return v;
  });

  const cosine = (va, vb) => {
    // 迭代较小的那个
    const [small, big] = va.size <= vb.size ? [va, vb] : [vb, va];
    let dot = 0;
    for (const [w, x] of small) {
      const y = big.get(w);
      if (y) dot += x * y;
    }
    return dot;
  };

  // 每个节点的前 K 名
  const top = new Array(n);
  for (let i = 0; i < n; i++) {
    const sims = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const s = cosine(vecs[i], vecs[j]);
      if (s >= threshold) sims.push([j, s]);
    }
    sims.sort((x, y) => y[1] - x[1]);
    top[i] = sims.slice(0, topK);
  }

  // 互为前 K 名才连，避免单向"蹭热点"
  const seen = new Set();
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (const [j, s] of top[i]) {
      const back = top[j].some(([k2]) => k2 === i);
      if (!back) continue;
      const a = rows[i].id;
      const b = rows[j].id;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b, score: Math.round(s * 1000) / 1000 });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs.slice(0, maxPairs);
}
