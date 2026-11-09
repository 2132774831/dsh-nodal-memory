/**
 * 直觉层：矛盾粗筛 + 复习候选。
 *
 * 两个共同前提：
 *   1. **只给候选，绝不自动改数据**。矛盾要人来裁决，误判代价太大。
 *   2. **每条结论都要能解释**（带上为什么被挑出来），否则就是黑箱。
 *
 * 矛盾识别为什么这么难，以及这里为什么这么做：
 *   真正的"语义矛盾"需要理解事实，本机做不到可靠判断。所以只找**有痕迹的矛盾**：
 *   两条记忆说得是同一件事（词重叠高/共享标签/向量相近），**但关键处不一样**——
 *   要么出现了互斥词（是/不是、启用/禁用），要么关键值不同（3.11 vs 3.14、C:\a vs D:\b）。
 *   这样挑出来的多数是真冲突，少数是"换了说法"，都值得人扫一眼。
 */

import { tokenSet } from './text.js';
import { cosine } from './embed.js';

/**
 * 互斥词对：一条说左、另一条说右，就值得怀疑。
 *
 * ⚠ 这里**不能用单字或高频词**（"是/不是"、"有/没有"、"可以/不能"）。
 * 实测拿"是/不是"去判，中文里"是"字满地都是，几乎每一对都会命中，
 * 挑出 50 对全是噪声。只保留语义明确、出现频率低的成对词。
 */
const SWITCH_PAIRS = [
  ['需要', '不需要'], ['支持', '不支持'], ['启用', '禁用'],
  ['开启', '关闭'], ['保留', '删除'], ['加上', '去掉'],
  ['使用', '不使用'], ['成功', '失败'], ['可用', '不可用'],
  ['上行', '下行'], ['推荐', '不推荐'], ['必须', '禁止'],
];

/**
 * 抽出"关键值"：版本号、路径、端口、**数字+单位** —— 同一主题下这些不同，八成是状态变了。
 *
 * 「数字+单位」是后补的：一开始只认版本号和 Windows 路径，结果"超时 30 秒"和
 * "超时 45 秒"这种最常见的冲突完全抓不到（demo 数据实测 0 对）。
 * 中文技术文档里大量参数是"30 秒 / 5 分钟 / 80% / 512MB"这种形态，必须覆盖。
 */
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(毫秒|秒|分钟|小时|天|周|个月|次|条|个|人|份|台|层|行|GB|MB|KB|TB|ms|px|%|℃)/gi;

function keyValues(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/\d+\.\d+(?:\.\d+)*/g)) out.add('v:' + m[0]);
  for (const m of s.matchAll(/[A-Za-z]:\\[^\s，。；、）)]+/g)) out.add('p:' + m[0].toLowerCase());
  for (const m of s.matchAll(/端口\s*[:：]?\s*(\d{2,5})/g)) out.add('port:' + m[1]);
  // 数字+单位：把单位统一成小写，'30 秒' 与 '30秒' 视为同一个值
  for (const m of s.matchAll(UNIT_RE)) {
    out.add('n:' + m[1] + m[2].toLowerCase());
  }
  return out;
}

/** 一条里有左词、另一条里有右词（或反过来），算一次互斥命中 */
function switchHits(a, b) {
  const hits = [];
  for (const [left, right] of SWITCH_PAIRS) {
    const aL = a.includes(left); const aR = a.includes(right);
    const bL = b.includes(left); const bR = b.includes(right);
    if ((aL && bR && !aR) || (aR && bL && !aL)) hits.push(left + ' / ' + right);
  }
  return hits;
}

/**
 * 正文相似度用**token 余弦**，不用 Jaccard。
 *
 * 实测教训：这批记忆每条动辄几百字，Jaccard 会被长度摊薄——全库最大才 0.168，
 * 用 0.28 当阈值等于永远不命中。token 余弦对长度不那么敏感，同一件事的两条
 * 能到 0.20~0.29（全库 p99 = 0.162，max = 0.287），可区分度正好。
 */
function tokenCosine(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / Math.sqrt(setA.size * setB.size);
}

/**
 * 找疑似冲突的记忆对。
 * @param {object[]} records
 * @param {object} [opts]
 * @param {number} [opts.minOverlap=0.18]  正文词重叠下限（同一件事）
 * @param {number} [opts.minSemantic=0.55] 向量相似度下限（有向量时的"同一件事"判据）
 * @param {Map|object} [opts.vectors]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.maxNodes=800] O(n²)，太多就跳过
 */
export function findConflicts(records, opts = {}) {
  const {
    // 「说的是同一件事」的**强**判据：宁可少挑，也不要一次给 50 条让人自己筛。
    // 0.20 是从真实数据量出来的（见上面 tokenCosine 的注释）
    minOverlap = 0.2,
    minSemantic = 0.72,
    vectors = null,
    limit = 20,
    maxNodes = 800,
    now = Date.now(),
  } = opts;

  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (list.length > maxNodes) {
    return { pairs: [], skipped: `条数 ${list.length} 超过上限 ${maxNodes}` };
  }

  const tok = list.map((r) => tokenSet(r.content));
  const kv = list.map((r) => keyValues(r.content));
  const vecOf = (id) => (vectors ? (vectors instanceof Map ? vectors.get(id) : vectors[id]) : null);

  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      const sharedTags = (a.tags || []).filter((t) => (b.tags || []).includes(t));
      const sameProject = a.project && a.project === b.project;

      const va = vecOf(a.id);
      const vb = vecOf(b.id);
      const sim = va && vb && va.length === vb.length ? cosine(va, vb) : null;

      const overlap = tokenCosine(tok[i], tok[j]);
      // 「说的是同一件事」——要求**很强的主题吻合**，否则后面任何证据都不可信
      // （两条都在聊版本号，不代表它们在说同一件事）
      const sameTopic = overlap >= minOverlap
        || (sim !== null && sim >= minSemantic);
      if (!sameTopic) continue;

      const hits = switchHits(a.content, b.content);
      const diffValues = [...kv[i]].filter((x) => !kv[j].has(x)).concat([...kv[j]].filter((x) => !kv[i].has(x)));
      // 关键值不同：必须两边都写了值，而且正文本身高度重合——
      // 否则"剪映 11.1"和"Python 3.14"也会被判成冲突（它们各说各的，没有矛盾）
      const valueConflict = kv[i].size > 0 && kv[j].size > 0
        && diffValues.length > 0 && overlap >= minOverlap;

      if (hits.length === 0 && !valueConflict) continue;

      const reasons = [];
      if (hits.length) reasons.push('互斥表述：' + hits.slice(0, 3).join('、'));
      if (valueConflict) reasons.push('关键值不同：' + diffValues.slice(0, 4).join('、'));
      if (sharedTags.length) reasons.push('共享标签：' + sharedTags.slice(0, 3).join('、'));
      if (sameProject) reasons.push('同项目：' + a.project);
      if (sim !== null) reasons.push('语义相似度 ' + sim.toFixed(2));

      // 打分：只说同一件事不够，要有"不一样"的痕迹才值得人看
      const score = 0.45 * overlap
        + 0.25 * (sim === null ? 0 : Math.max(0, sim))
        + 0.20 * (hits.length ? 1 : 0)
        + 0.10 * (valueConflict ? 1 : 0);

      pairs.push({
        a: { id: a.id, content: a.content, createdAt: a.createdAt, project: a.project, tags: a.tags || [] },
        b: { id: b.id, content: b.content, createdAt: b.createdAt, project: b.project, tags: b.tags || [] },
        score: Number(score.toFixed(3)),
        overlap: Number(overlap.toFixed(3)),
        semantic: sim === null ? null : Number(sim.toFixed(3)),
        reasons,
        switchHits: hits,
        diffValues,
      });
    }
  }

  pairs.sort((x, y) => y.score - x.score);
  return { pairs: pairs.slice(0, limit), skipped: null };
}

/**
 * 「该想起的」：重要 + 已经放了很久 + 几乎没被用过。
 *
 * 为什么不是"最新"也不是"最常被用"：那两个维度已经在列表和检索里了。
 * 这里要的是**正被遗忘、但值得记住的**那种记忆——
 * 用 imphasis × log(天数) / log(使用次数) 排序，老的、重要的、没人碰的排前面。
 */
export function reviewCandidates(records, opts = {}) {
  const { limit = 8, now = Date.now(), minDays = 14, maxAccess = 5 } = opts;
  const weight = { key: 1.4, important: 1, casual: 0.55, transient: 0.3 };

  const rows = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.deletedAt) continue;
    const days = Math.max(0, (now - r.createdAt) / 86400000);
    if (days < minDays) continue;           // 刚写的不用"复习"
    // 经常被用到的说明一直在脑子里，不属于"有遗忘风险"——不该占这个清单的位置
    if ((r.accessCount || 0) >= maxAccess) continue;
    const imp = weight[r.importance] ?? 1;
    const score = (imp * Math.log1p(days)) / Math.log1p(1 + (r.accessCount || 0));
    rows.push({ record: r, score, days: Math.floor(days), accessCount: r.accessCount || 0 });
  }

  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit).map((row) => ({
    id: row.record.id,
    content: row.record.content,
    importance: row.record.importance,
    kind: row.record.kind,
    project: row.record.project,
    createdAt: row.record.createdAt,
    days: row.days,
    accessCount: row.accessCount,
    score: Number(row.score.toFixed(3)),
    why: row.accessCount === 0
      ? `写了 ${row.days} 天，一次都没被用过`
      : `写了 ${row.days} 天，只被用过 ${row.accessCount} 次`,
  }));
}
