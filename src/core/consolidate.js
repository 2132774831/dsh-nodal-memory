/**
 * 记忆整合（consolidation）：把"同一件事反复出现"的多条碎片，合成一条更高阶的结论。
 *
 * 为什么不靠"频次涨权重"：碎片各涨各的，最后是 10 条"今天吃了牛肉面"挤满检索结果，
 * token 白烧、还看不出重点。整合成一条"用户很喜欢吃牛肉面（近一个月提了 10 次）"，
 * 既省位置、又直接是结论，而且**原始碎片不删**（留作证据，随时能翻）。
 *
 * 纯本地规则，不调模型：
 *   - 分组信号：**共享低频标签**（高频标签人人都带，说明不了什么）+ 同一类别
 *   - 组内 ≥ minGroupSize 条才值得整合
 *   - 归纳正文用模板拼要点，不编造内容
 *
 * 安全原则（和删除相关的都不自动做）：
 *   - 只生成新记录，**不删除任何原文**
 *   - 被整合的碎片 status 改成 consolidated：退出"自动召回"，但 memory_search 仍可命中
 *   - 默认 dryRun，只预览；确认后才落库
 */

const DAY = 86400000;

import { tokenSet } from './text.js';

/** 一个标签出现在超过这个比例的记忆上，就算"高频标签"，不用它分组 */
const DOMINANT_RATIO = 0.12;
/**
 * 但"比例高"还要配上"绝对数量多"才算高频。
 * 否则库里只有 3 条、其中 3 条都带同一个标签时，比例是 100%，
 * 会把唯一有意义的标签也剔掉——小库直接永远整合不出东西（踩过）。
 */
const DOMINANT_MIN_COUNT = 5;

/**
 * 内容聚类：两条记忆的 token 余弦超过这个值，且**共享 token 够多**，才算"在说同一件事"。
 *
 * 0.40 是量出来的：同一个意思的三种说法（"今天中午吃了牛肉面/中午又去吃了牛肉面/
 * 晚上想起来中午吃的牛肉面真不错"）两两余弦是 0.447/0.447/0.267。
 * 门槛设 0.5 会一个都抓不到；设 0.4 能连上，但短句很容易因为"我们/今天/可以"
 * 这类通用词误并，所以再加一道"共享 token ≥ 3"的闸门。
 */
const DEFAULT_SIMILARITY = 0.4;
const DEFAULT_MIN_SHARED = 3;
/** 参与 O(n²) 比较的上限，超过就只做标签分组（别让一次预览把界面卡死） */
const MAX_SIMILARITY_NODES = 1500;

function normalize(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 集合余弦 + 共享个数 */
function setStats(a, b) {
  if (!a.size || !b.size) return { cos: 0, shared: 0 };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return { cos: shared / Math.sqrt(a.size * b.size), shared };
}

/** 并查集 */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  return { find, union };
}

/**
 * **内容相似聚类**：找"同一个意思反复出现"的那批。
 *
 * 这是"吃牛肉面说了 10 次"真正对应的信号——按标签分组只能分出"话题桶"，
 * 而用户要的是"同一件事的不同说法"聚在一起。
 */
export function findSimilarityGroups(records, opts = {}) {
  const {
    threshold = DEFAULT_SIMILARITY,
    minShared = DEFAULT_MIN_SHARED,
    minGroupSize = 3,
    now = Date.now(),
  } = opts;
  const list = (records || []).filter((r) => r && r.deletedAt == null && r.status !== 'consolidated');
  if (list.length < minGroupSize || list.length > MAX_SIMILARITY_NODES) return [];

  const sets = list.map((r) => tokenSet(normalize(r.content) + ' ' + normalize((r.tags || []).join(' '))));
  const uf = makeUnionFind(list.length);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const { cos, shared } = setStats(sets[i], sets[j]);
      if (cos >= threshold && shared >= minShared) uf.union(i, j);
    }
  }

  const buckets = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = uf.find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(list[i]);
  }

  const out = [];
  for (const members of buckets.values()) {
    if (members.length < minGroupSize) continue;
    members.sort((a, b) => a.createdAt - b.createdAt);
    const times = members.map((m) => m.createdAt);
    const spanDays = Math.round((times[times.length - 1] - times[0]) / DAY);

    // 组内出现最多的标签，拿来当主题名
    const tagCount = new Map();
    for (const m of members) for (const t of m.tags || []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const topTag = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '相近主题';

    // 组内最多的类别
    const kindCount = new Map();
    for (const m of members) kindCount.set(m.kind || 'unknown', (kindCount.get(m.kind || 'unknown') ?? 0) + 1);
    const kind = [...kindCount.entries()].sort((a, b) => b[1] - a[1])[0][0];

    out.push({
      id: 'similar@' + members.map((m) => m.id).sort().join(','),
      by: 'similar',
      tag: topTag,
      kind,
      size: members.length,
      spanDays,
      memberIds: members.map((m) => m.id),
      suggestedContent: buildSummary(topTag, kind, members, spanDays, '同一件事'),
      suggestedImportance: 'key',
      suggestedTags: [topTag, 'consolidated'],
      suggestedKind: kind === 'emotion' ? 'preference' : (kind === 'unknown' ? 'work' : kind),
      createdAt: now,
    });
  }
  return out;
}

/** 每条记忆能当"主题信号"的标签 */
function signalTags(record, dominant) {
  return (record.tags || [])
    .map(String)
    .filter((t) => t && !dominant.has(t))
    // 话题标签本身就是"分组"用的，最合适
    .sort();
}

/**
 * 找出可以整合的候选组。
 *
 * @param {object[]} records 未删除的记忆
 * @param {object} [opts]
 * @param {number} [opts.minGroupSize=3]
 * @param {number} [opts.now]
 * @returns {{groups: object[]}}
 */
export function findConsolidationGroups(records, opts = {}) {
  const {
    minGroupSize = 3,
    now = Date.now(),
    /**
     * 是否也把"同一标签"的组算进来。**默认 false**：
     * 实测真实库会分出「topic:memory-plugin 7 条」这种话题桶，
     * 但那是 7 条**不同的事实**，并成一段会丢精度——那不是用户要的"同一件事反复出现"。
     * 留着开关是为了将来做"话题摘要"这类别的功能。
     */
    includeTagGroups = false,
  } = opts;
  const list = (records || []).filter((r) => r && r.deletedAt == null && r.status !== 'consolidated');

  // 高频标签先剔掉：它们不区分主题
  const tagCount = new Map();
  for (const r of list) for (const t of r.tags || []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const dominant = new Set();
  for (const [t, c] of tagCount) {
    if (c >= DOMINANT_MIN_COUNT && list.length && c / list.length > DOMINANT_RATIO) dominant.add(t);
  }

  const buckets = new Map();
  for (const r of list) {
    for (const t of signalTags(r, dominant)) {
      // 同一标签下再按类别分桶：同样是「deploy」，work 和 emotion 不该并
      const key = t + '\u0000' + (r.kind || 'unknown');
      if (!buckets.has(key)) buckets.set(key, { tag: t, kind: r.kind || 'unknown', members: [] });
      buckets.get(key).members.push(r);
    }
  }

  const groups = [];
  if (includeTagGroups) {
    for (const g of buckets.values()) {
    if (g.members.length < minGroupSize) continue;
    g.members.sort((a, b) => a.createdAt - b.createdAt);
    const times = g.members.map((m) => m.createdAt);
    const spanDays = Math.round((times[times.length - 1] - times[0]) / DAY);

    groups.push({
      id: g.tag + '@' + g.kind,
      tag: g.tag,
      kind: g.kind,
      size: g.members.length,
      spanDays,
      memberIds: g.members.map((m) => m.id),
      // 归纳正文：模板拼接，不编造。只取每条的头一句，避免整段搬进来
      suggestedContent: buildSummary(g.tag, g.kind, g.members, spanDays),
      // "提高权重"就落在这里：整合出来的这条给最高重要度
      suggestedImportance: 'key',
      suggestedTags: [g.tag, 'consolidated'],
      suggestedKind: g.kind === 'emotion' ? 'preference' : (g.kind === 'unknown' ? 'work' : g.kind),
      createdAt: now,
    });
    }
  }

  // 组越大越值得先看
  groups.sort((a, b) => b.size - a.size);

  /**
   * 再把"内容相似"的组并进来。
   * 两条路互补：标签分组抓"同一话题"，相似分组抓"同一件事的不同说法"。
   * 同一批成员被两边都抓到时就只留一份（相似组更贴题，优先）。
   */
  const similar = findSimilarityGroups(list, { minGroupSize, now });
  const seenMembers = new Set(similar.map((g) => g.memberIds[0]));
  for (const g of similar) {
    g.by = 'similar';
    groups.unshift(g);          // 相似组更贴近"同一件事"，排前面
    seenMembers.add(g.memberIds[0]);
  }
  const deduped = [];
  const used = new Set();
  for (const g of groups) {
    if (used.has(g.memberIds[0])) continue;
    used.add(g.memberIds[0]);
    deduped.push(g);
  }
  deduped.sort((a, b) => (b.by === 'similar' ? 1 : 0) - (a.by === 'similar' ? 1 : 0) || b.size - a.size);
  return { groups: deduped };
}

/** 用模板拼一句人话，不调模型、不编造 */
function buildSummary(tag, kind, members, spanDays, what = '') {
  const heads = members
    .slice(-3)
    .map((m) => normalize(m.content).replace(/[。；;]+$/, '').slice(0, 60))
    .filter(Boolean);
  const kindLabel = { work: '工作', emotion: '情绪', preference: '偏好', unknown: '杂项' }[kind] || '杂项';
  const span = spanDays > 0 ? `，跨度约 ${spanDays} 天` : '';
  const subject = what ? `「${tag}」相关的${what}` : `「${tag}」的${kindLabel}记录`;
  return `${subject}共 ${members.length} 条${span}。`
    + (heads.length ? `最近几次的要点：${heads.join('；')}。` : '')
    + `（由记忆整合生成，原始 ${members.length} 条仍保留可查）`;
}

/**
 * 落库：生成归纳记录 + 把成员标成 consolidated。
 *
 * @param {object} store
 * @param {object} group  findConsolidationGroups 产出的某一组
 * @param {object} [opts]
 * @param {string} [opts.content] 允许调用方改写归纳正文
 * @returns {{ok:boolean, id?:string, affected?:number, error?:string}}
 */
export function applyConsolidation(store, group, opts = {}) {
  if (!group || !Array.isArray(group.memberIds) || !group.memberIds.length) {
    return { ok: false, error: '组数据不完整' };
  }
  const content = normalize(opts.content || group.suggestedContent);
  if (!content) return { ok: false, error: '归纳正文为空' };

  const created = store.put({
    content,
    kind: group.suggestedKind || 'work',
    importance: group.suggestedImportance || 'key',
    tags: group.suggestedTags || ['consolidated'],
    source: 'consolidated',
    origin: 'consolidate',
  });

  let affected = 0;
  for (const id of group.memberIds) {
    const rec = store.get(id);
    if (!rec) continue;
    // 只改状态和归属，正文一个字不动
    store.put({ ...rec, parentId: created.id, status: 'consolidated' });
    affected++;
  }
  return { ok: true, id: created.id, affected };
}
