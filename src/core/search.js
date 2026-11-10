/**
 * 检索：把"能不能搜到"和"该不该排前面"分开算。
 *
 * 打分公式（每个因子都能单独调，别把魔法数字埋进深处）：
 *
 *   score = relevance × importanceFactor × decay × usageBoost
 *
 *   relevance        0~1，检索相关度。SQLite 后端 = 0.5×bm25归一 + 0.5×token覆盖率；
 *                    JSON 后端 = token 覆盖率。两者语义对齐，上层不用关心走了哪个后端。
 *   importanceFactor 0.6 ~ 1.0，key(1.0) / important(0.8) / casual(0.5) / transient(0.25)。
 *                    注意下限是 0.6 而不是 0：重要性只调节排序，不该让一条记忆彻底消失。
 *   decay            按类型的半衰期衰减（见 time.js）。陈旧的工作记忆仍然可搜到，只是往后排。
 *   usageBoost       1 + 0.15·ln(1+accessCount)。对数压制，防止一条高频记忆永久霸榜。
 *
 * 为什么不用"向量相似度×(...)"那套：
 *   本机没有 embedding 端点时那套直接成 NaN。这里的公式在**没有任何外部依赖**时
 *   就已经能工作，将来接上 embedding 只是把 relevance 那一项换成混合分，其余不动。
 */

import { toFtsQuery, tokens, toIndexText } from './text.js';
import { decayFactor, formatRelative, freshness } from './time.js';
import { IMPORTANCE_WEIGHT } from './schema.js';
import { cosine } from './embed.js';

const DEFAULT_MIN_COVERAGE = 0.5;

/**
 * 软遗忘：**永不删除**，只让它越来越靠后。
 *
 * 为什么不物理删：删记忆是不可逆的，误判一次就永远找不回来。
 * 而且"没用过"不等于"没用"——有些结论一年才用一次，删了就再也想不起来。
 *
 * 规则（只对"低价值类"生效）：
 *   - 只看 importance 是 casual/transient 的，或者 kind 是 emotion 的
 *     （key/important 永远不降——那是用户确认过要长期保留的）
 *   - 计的是"最后一次被用到"到现在的空闲天数，不是创建时间：
 *     一条老记忆只要经常被检索到，就不该被压
 *   - 超过 forgetAfterDays 后线性加重，最低压到 0.4 倍，**不会归零**
 */
/**
 * 计算"这条记忆有多新鲜"用的时钟 —— 也就是半衰期从哪天开始算。
 *
 * ⚠ **看的是"最后一次被用到/更新"，不是创建时间。**
 *
 * 为什么：主人 2026-11-10 指出的设计错误 —— 半衰期原本按 createdAt 算，
 * 结果"天天被检索到的老记忆"照样掉分（365 天的 work 记忆 decay=0.5，
 * 而昨天刚写、一次没用过的还是 1.0），等于"没用过的新记忆压过天天在用的老记忆"。
 * 现在的语义才是对的：**没人用了才衰减**，一直用就一直新鲜。
 *
 * 三个时间取最大：
 *   lastAccessed —— 被检索/注入过
 *   updatedAt    —— 追加过进展（信息本身变新了）
 *   createdAt    —— 兜底
 */
function activityAt(record) {
  return Math.max(
    record.lastAccessed || 0,
    record.updatedAt || 0,
    record.createdAt || 0,
  ) || null;
}

function neglectFactor(record, now, { softForget, forgetAfterDays }) {
  if (!softForget) return 1;
  const lowValue = record.importance === 'casual'
    || record.importance === 'transient'
    || record.kind === 'emotion';
  if (!lowValue) return 1;

  const lastUse = record.lastAccessed ?? record.createdAt;
  if (!lastUse) return 1;
  const idleDays = (now - lastUse) / 86400000;
  if (idleDays <= forgetAfterDays) return 1;

  // 超期多久：刚过线 0 → 再过一倍 1
  const over = Math.min(1, (idleDays - forgetAfterDays) / Math.max(1, forgetAfterDays));
  return 1 - 0.6 * over;   // 0.4 ~ 1
}

/**
 * 覆盖率阈值随查询长度自适应。
 * 短查询（≤4 token）要求一半命中，长句放宽——因为没人会把一整句话复述进记忆里，
 * 长句查询如果用同样的阈值会全军覆没。
 */
function resolveMinCoverage(tokenCount, explicit) {
  if (explicit != null) return explicit;
  if (tokenCount <= 4) return DEFAULT_MIN_COVERAGE;
  if (tokenCount <= 10) return 0.4;
  return 0.3;
}

/** 计算一条记忆对 query 的 token 覆盖率，用于相关度与硬阈值 */
function coverage(record, queryTokens) {
  const qset = Array.from(new Set(queryTokens));
  if (qset.length === 0) return { ratio: 0, matched: 0, total: 0 };
  const hay = new Set([
    ...toIndexText(record.content).split(' '),
    ...toIndexText(record.topic).split(' '),
    ...toIndexText(record.tags.join(' ')).split(' '),
  ].filter(Boolean));
  let hit = 0;
  for (const t of qset) if (hay.has(t)) hit++;
  return { ratio: hit / qset.length, matched: hit, total: qset.length };
}

/**
 * 检索记忆。
 * @param {object} store  openStore() 返回的存储
 * @param {string} query  用户/模型输入的查询
 * @param {object} [opts]
 * @param {number} [opts.limit=10]          返回条数
 * @param {number} [opts.candidateLimit=80] 粗排候选数（再精排）
 * @param {number} [opts.minScore=0.12]     低于此分直接丢弃，避免用噪声污染上下文
 * @param {number} [opts.minCoverage]       token 覆盖率下限。**不传=按查询长度自适应**
 *                                          （≤4 token 要 50%，≤10 要 40%，更长要 30%）。
 *                                          这里千万不要给写死默认值，否则自适应分支永远走不到。
 * @param {boolean} [opts.includeStale=true] 是否包含超过 180 天的记忆（包含则附时效警告）
 * @param {object} [opts.filters]           {project, kind, tag}
 * @param {number} [opts.now]               当前时间（测试注入用）
 */
export function search(store, query, opts = {}) {
  const {
    limit = 10,
    candidateLimit = 80,
    minScore = 0.12,
    minCoverage,
    includeStale = true,
    filters = {},
    now = Date.now(),
    queryVector = null,
    softForget = true,
    forgetAfterDays = 180,
    halfLifeDays = null,
    // 每类权重（工作/偏好/情感/未分类各一个乘子），用户可调；不传就都是 1
    kindWeight = null,
  } = opts;

  const q = String(query ?? '').trim();
  if (!q) return [];

  // 用 OR 取候选（宁可多取），再用覆盖率阈值把关（宁可错杀）。
  // 只用 AND 会漏掉"字没挨着但语义相关"的记忆，只用 OR 会放进一堆噪声。
  const ftsQuery = toFtsQuery(q, 'OR');
  const queryTokens = tokens(q);
  const qset = Array.from(new Set(queryTokens));
  const requiredCoverage = resolveMinCoverage(qset.length, minCoverage);

  const raw = store.candidates({ ftsQuery, queryTokens, limit: candidateLimit, filters });

  // ── 纯向量召回 ──
  // 关键词检索天生有个缺口：**换了个说法就搜不到**（"咖啡"搜不到"美式"）。
  // 有查询向量时，额外扫一遍全部向量取最近的若干条，和关键词候选合池。
  // 注意这跟"语义重排"是两件事：重排只能改变已有候选的顺序，召回能捞出新东西。
  //
  // 阈值 0.35 是量出来的：真实中英文记忆对的相似度多落在 0.43~0.50（p90=0.455）。
  // 一开始写 0.5，结果"怎么注册网页接口"这种换个说法的问题一条都召不回来——
  // 门槛比 p90 还高，等于这个功能只在极端相似的场景才生效。召回要宽松，排序再收紧。
  const vectorRecall = opts.vectorRecall ?? 30;
  const vectorFloor = opts.vectorFloor ?? 0.35;
  let vecMap = null;
  const vectorHits = [];
  if (queryVector && queryVector.length && typeof store.getVectors === 'function') {
    const all = store.list({ limit: 5000 });
    vecMap = store.getVectors(all.map((r) => r.id));
    if (vecMap && vecMap.size) {
      for (const rec of all) {
        const v = vecMap.get(rec.id);
        if (!v || v.length !== queryVector.length) continue; // 换过模型导致的维度不一致：跳过
        const s = cosine(queryVector, v);
        if (s >= vectorFloor) vectorHits.push({ record: rec, sim: s });
      }
      vectorHits.sort((a, b) => b.sim - a.sim);
      vectorHits.length = Math.min(vectorHits.length, vectorRecall);
    }
  }

  if (raw.length === 0 && vectorHits.length === 0) return [];

  // bm25 的原始分数量纲不定（还可能是负的），先 min-max 归一；单条候选直接视为最高
  const scores = raw.map((r) => r.rawScore);
  const lo = scores.length ? Math.min(...scores) : 0;
  const hi = scores.length ? Math.max(...scores) : 0;
  const span = hi - lo;

  // 合并候选池：关键词命中的 + 只有向量命中的
  const kwIds = new Set(raw.map((r) => r.record.id));
  const pool = raw.map((r) => ({ record: r.record, rawScore: r.rawScore, viaVector: false, sim: null }));
  for (const vh of vectorHits) {
    if (kwIds.has(vh.record.id)) continue;
    pool.push({ record: vh.record, rawScore: null, viaVector: true, sim: vh.sim });
  }

  const results = [];
  for (const item of pool) {
    const normRank = item.viaVector ? 0 : (span > 1e-12 ? (item.rawScore - lo) / span : 1);
    const cov = coverage(item.record, queryTokens);

    // 先把语义分算出来——覆盖率闸门要看它。
    let semantic = item.sim;
    if (queryVector && queryVector.length && semantic == null) {
      const vec = vecMap && vecMap.get ? vecMap.get(item.record.id)
        : (typeof store.getVector === 'function' ? store.getVector(item.record.id) : null);
      // 维度不一致就当作没有向量（换过模型的情况），绝不硬算
      if (vec && vec.length === queryVector.length) semantic = cosine(queryVector, vec);
    }

    // 覆盖率闸门：用来挡"只因为一个字相同就被 OR 放进来的噪声"。
    // 但它会误杀真正相关的东西——实测「怎么注册网页接口」问那条 webServer.register 的记忆，
    // 只命中"注册"一个 token（覆盖率 14%），可语义相似度有 0.476，明显是在问同一件事。
    // 所以：语义足够强时不受这道闸门约束。
    const semanticBypass = Number.isFinite(opts.semanticBypass) ? opts.semanticBypass : 0.42;
    const strongSemantic = semantic != null && semantic >= semanticBypass;
    if (!item.viaVector && !strongSemantic && cov.ratio < requiredCoverage) continue;

    // 相关度：默认纯关键词；有 queryVector 时把语义分混进来
    let relevance = 0.5 * normRank + 0.5 * cov.ratio;
    if (queryVector && queryVector.length && semantic != null) {
      // 语义占大头，但关键词仍有三成：向量对"专有名词/错误码/id"这类精确匹配不敏感，
      // 把它们压到零会让搜索在技术记忆上变差。
      // 纯向量召回的条目没有关键词分，直接用相似度折成相关度。
      relevance = item.viaVector
        ? 0.85 * Math.max(0, semantic)
        : 0.30 * normRank + 0.25 * cov.ratio + 0.45 * Math.max(0, semantic);
    }

    const impFactor = 0.6 + 0.4 * (IMPORTANCE_WEIGHT[item.record.importance] ?? 0.8);
    const clock = activityAt(item.record);
    const decay = decayFactor(clock, item.record.kind, now, halfLifeDays);
    // 频次加成**不含自动注入**：注入本来就是因为检索命中，再拿它加权会形成
    // "注入 → 加分 → 更容易被注入" 的自增强回路（外部评审点出的真问题）。
    // 只认模型主动检索，自动注入按 0.3 折算，并且整体封顶 2 倍，不让它无限涨。
    const usageRaw = 1 + 0.15 * Math.log1p(
      (item.record.searchedCount || 0) + 0.3 * (item.record.injectedCount || 0),
    );
    const usage = Math.min(2, usageRaw);
    // 软遗忘只压排序，不删数据、也不把 score 归零
    const neglect = neglectFactor(item.record, now, { softForget, forgetAfterDays });
    // 衰减和软遗忘都是时间惩罚，**不能相乘**（等于对"又老又没人用"判两次刑：
    // 实测 work 类 180 天会掉到 0.28、emotion 掉到 0.05，等于变相删除）。
    // 但 neglect === 1 表示"这条不适用软遗忘"，此时只用 decay——
    // 直接写 max(decay, neglect) 会让所有记忆的 decay 都被 1 抵消掉（踩过）。
    const timeFactor = neglect < 1 ? Math.max(decay, neglect) : decay;
    // 类别权重：让用户能把"情感类"或"偏好类"单独调高/调低命中率
    const kw = kindWeight && Number(kindWeight[item.record.kind]);
    const kindFactor = (Number.isFinite(kw) && kw > 0) ? Math.min(5, Math.max(0.1, kw)) : 1;

    let score = relevance * impFactor * timeFactor * usage * kindFactor;

    // 强制命中：钉住的记忆（项目规矩、铁律）只要进了候选就排最前。
    // 乘一个大系数而不是直接置 1，是为了保留相对顺序（多条 pinned 之间还按相关度排）。
    const pinned = item.record.pinned === 1 || item.record.pinned === true;
    if (pinned) score *= 1000;

    // 钉住的不该被 minScore 拦掉

    // 精确覆盖（查询的每个 token 都命中）不该因为"旧"而彻底消失——
    // 用户拿原话去搜，就该给他，哪怕这条很老。衰减只该让它往后排（score 里已经体现）。
    const exactHit = cov.total > 0 && cov.matched === cov.total;
    if (score < minScore && !exactHit && !pinned) continue;

    const rel = formatRelative(clock, now);
    const fresh = freshness(clock, now);
    if (!includeStale && fresh.stale && !pinned) continue;

    results.push({
      record: item.record,
      score,
      why: {
        relevance: Number(relevance.toFixed(3)),
        coverage: Number(cov.ratio.toFixed(3)),
        matchedTokens: cov.matched + '/' + cov.total,
        semantic: semantic == null ? null : Number(semantic.toFixed(3)),
        // 这条是靠向量捞出来的（字面完全没重合），界面上要能区分
        viaVector: item.viaVector === true,
        importanceFactor: Number(impFactor.toFixed(3)),
        decay: Number(decay.toFixed(3)),
        usage: Number(usage.toFixed(3)),
        // <1 说明被软遗忘压过：数据还在，只是排后面了（界面可以画得淡一点）
        neglect: Number(neglect.toFixed(3)),
        forgotten: neglect < 0.999,
        ageLabel: rel.label,
        ageLevel: rel.level,
        days: Math.floor(rel.days),
        stale: fresh.stale,
        staleWarning: fresh.warning,
      },
    });
  }

  results.sort((a, b) => b.score - a.score);

  /**
   * 整合去重：如果归纳条（父）和它的碎片（子，status=consolidated）同时命中，
   * 只保留父条——否则同一件事在结果里出现两次（一条结论 + 一条原始碎片），
   * 白占位置、还让模型以为是两件事。
   *
   * 注意**不是隐藏**：碎片单独被命中时照样返回（它仍是可查的证据），
   * 只有"父也命中"时才让位。
   */
  const hitParents = new Set(results.map((r) => r.record.id));
  const deduped = results.filter((r) => !(r.record.parentId && hitParents.has(r.record.parentId)));

  return deduped.slice(0, limit);
}
