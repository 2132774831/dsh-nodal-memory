/**
 * 五个模型工具。全部走 core/ 的存储与检索，不碰宿主 API——
 * 这样这些工具的逻辑可以在没有宿主的情况下单测（见 test/host.test.mjs）。
 *
 * 与 v1 的关键差别：
 *   - memory_save 支持 kind / importance：**模型写的时候顺手填**，不需要额外调 LLM 去"提取结构"。
 *     这是本架构省掉整层 LLM 写入成本的地方。
 *   - memory_forget 是**软删**（可恢复），回复里明确说清楚，避免模型以为删干净了。
 *   - memory_review 额外报 kind=unknown 的数量——迁移来的老数据需要补标。
 */

import { search as coreSearch } from '../core/search.js';
import { formatRelative, toMs } from '../core/time.js';
import { ENUMS } from '../core/schema.js';
import { inferKindFromContent } from '../core/classify.js';

const MAX_REVIEW_ROWS = 10;

/** 纯文本内容块，DSH 工具输出格式 */
function textBlock(text) {
  return [{ type: 'text', text: String(text == null ? '' : text) }];
}

/** 组装 DSH 工具定义。execute 内兜异常：失败也返回可读文本，不炸整轮。 */
function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => textBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    },
    execute: async (args, exec) => {
      try {
        return await spec.run(args && typeof args === 'object' ? args : {}, exec || {});
      } catch (err) {
        return `[记忆库调用失败] ${String((err && err.message) || err)}`;
      }
    },
    isConcurrencySafe: spec.concurrencySafe || (() => true),
  };
}

/**
 * 一条记忆渲染成给模型看的一行。
 * maxChars 控制正文截断长度：列表页是"概览"，截短；搜索结果要能读细节，放宽。
 * 不截断的话，list 20 条长记忆能吃掉上万 token，纯属浪费。
 */
function renderRecord(rec, index, { now = Date.now(), maxChars = 200 } = {}) {
  const rel = formatRelative(rec.createdAt, now);
  const meta = [];
  if (rec.project) meta.push(rec.project);
  if (rec.kind && rec.kind !== 'unknown') meta.push(rec.kind);
  if (rec.importance && rec.importance !== 'important') meta.push(rec.importance);
  const tags = rec.tags && rec.tags.length ? ` [${rec.tags.join(', ')}]` : '';
  let body = rec.content.replace(/\s+/g, ' ').trim();
  if (body.length > maxChars) body = body.slice(0, maxChars) + '…';
  return `${index}. [${rel.label}]${meta.length ? ' (' + meta.join(' | ') + ')' : ''} ${body}${tags}  —— id=${rec.id}`;
}

function fmtDate(ms) {
  const n = toMs(ms);
  if (n == null) return '未知';
  const d = new Date(n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ── schema ──────────────────────────────────────────────────────────────── */

const SAVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      description: '要记住的内容。写成能独立读懂的一句话，包含「为什么」，不要只写「做了什么」。',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '可选标签，如 ["topic:auth"]、["pref"]、["pitfall"]。检索时可按标签过滤。',
    },
    kind: {
      type: 'string',
      enum: ENUMS.kind,
      description:
        '记忆类别：work=工程结论/踩坑，emotion=情绪闲聊，preference=用户偏好与约定，unknown=说不清。'
        + '你写的时候顺手填，比事后用模型去猜准得多。',
    },
    importance: {
      type: 'string',
      enum: ENUMS.importance,
      description: '重要度：key=丢了会出事，important=有用（默认），casual=随口一提，transient=很快就会过期。',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: '自然语言查询。中文按二字组合匹配，查得具体一些更容易命中。' },
    tags: { type: 'array', items: { type: 'string' }, description: '只在这些标签的记忆里找（任一命中即可）。' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回几条，默认 10。' },
    project: { type: 'string', description: '只看某个项目的记忆，如 "default-workspace"。' },
  },
};

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回几条，默认 20。' },
    tag: { type: 'string', description: '只看带这个标签的记忆。' },
  },
};

const FORGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', description: '要删除的记忆 id（从 memory_list / memory_search 结果里拿）。' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    staleDays: { type: 'integer', minimum: 1, maximum: 3650, description: '多久没更新算「陈旧」，默认 180 天。' },
    neverUsedDays: { type: 'integer', minimum: 1, maximum: 3650, description: '创建多久仍是 0 命中算「从没用上」，默认 30 天。' },
  },
};

/* ── 体检（只读） ─────────────────────────────────────────────────────────── */

/**
 * 干体检：只读，不改任何数据。
 * 判断都基于确定性规则，不猜——"从没用过"是事实，"该不该删"由人定。
 */
export function reviewStore(store, { staleDays = 180, neverUsedDays = 30, now = Date.now() } = {}) {
  const all = store.list({ limit: 100000 });
  const DAY = 86400000;

  const byContent = new Map();
  const duplicates = [];
  for (const rec of all) {
    const key = rec.content;
    if (byContent.has(key)) {
      duplicates.push({ id: rec.id, duplicateOf: byContent.get(key).id, content: rec.content });
    } else {
      byContent.set(key, rec);
    }
  }

  const neverUsed = all.filter((r) => r.accessCount === 0 && now - r.createdAt >= neverUsedDays * DAY);
  const stale = all.filter((r) => now - (r.updatedAt || r.createdAt) >= staleDays * DAY);
  const noTags = all.filter((r) => !r.tags.length);
  const noKind = all.filter((r) => r.kind === 'unknown');

  return {
    total: all.length,
    chars: all.reduce((sum, r) => sum + r.content.length, 0),
    oldestAt: all.reduce((min, r) => (min == null || r.createdAt < min ? r.createdAt : min), null),
    duplicates,
    neverUsed,
    stale,
    noTags,
    noKind,
    needCleanup: duplicates.length > 0 || neverUsed.length > 0 || noTags.length > 0,
  };
}

/* ── 工具工厂 ─────────────────────────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {() => object} deps.getStore   取当前 store（配置变更后可能换库）
 * @param {() => object} deps.getConfig  取当前配置
 * @param {(exec:object) => string} deps.getCwd 从工具执行上下文取会话 cwd
 * @param {() => void} deps.onReviewed   体检完成后刷新 lastReviewAt
 */
export function buildTools(deps) {
  const { getStore, getConfig, getCwd, onReviewed } = deps;

  /** 写入后通知（惰性维护用）。任何异常都吞掉——维护不该影响写记忆。 */
  const notifyWrite = () => {
    try {
      if (typeof deps.onWrite === 'function') deps.onWrite();
    } catch { /* 忽略 */ }
  };

  const disabled = () => '[记忆库已关闭] 请在设置页打开「启用本地记忆」。';

  return [
    defineTool({
      name: 'memory_save',
      description:
        '把一条值得长期保留的结论写进本地记忆库（只存你本机，不联网、不上传）。'
        + '适合记：用户偏好、项目约定、历史决策及其原因、踩过的坑、明确的待办。'
        + '不要记：代码里一眼能看出来的东西、临时中间状态、能从 diff 直接读到的东西。'
        + '正文完全相同的记忆不会重复新增，而是合并标签并刷新时间。',
      parameters: SAVE_SCHEMA,
      concurrencySafe: () => false,
      run: async (args, exec) => {
        const cfg = getConfig();
        if (!cfg.enabled) return disabled();
        const store = getStore();

        const content = String(args.text || '').trim();
        if (!content) return '没有传入要记住的内容（text 为空）。';
        if (content.length > cfg.maxTextLength) {
          return `内容太长（上限 ${cfg.maxTextLength} 字），请精简后再存。`;
        }

        const tags = Array.isArray(args.tags) ? args.tags : [];
        let project = '';
        if (cfg.autoTagProject) {
          try {
            project = getCwd ? (await getCwd(exec)).project : '';
          } catch {
            project = '';
          }
        }

        // 精确查重：正文一字不差才算重复。**不做模糊查重**——
        // 模糊合并会把"北京"和"上海"这种真冲突的两条并成一条，那比重复糟得多。
        const existing = store
          .list({ limit: 100000 })
          .find((r) => r.content === content);

        if (existing) {
          const mergedTags = Array.from(new Set([...(existing.tags || []), ...tags]));
          store.put({ ...existing, tags: mergedTags, updatedAt: Date.now() });
          notifyWrite();
          return `这条已经记过了（id=${existing.id}），已合并标签并刷新时间。`;
        }

        // 模型没给类别时，按内容粗分一次。kind 决定半衰期（工作/偏好记得久、情感忘得快），
        // 全落在 unknown 就等于这套差异化没生效。误判可以在补标页改。
        let kind = args.kind;
        let kindGuess = null;
        if ((!kind || kind === 'unknown') && getConfig().features?.autoKind !== false) {
          const guess = inferKindFromContent(content, { tags });
          if (guess.kind !== 'unknown') { kind = guess.kind; kindGuess = guess.why; }
        }

        const { id, record } = store.put({
          content,
          tags,
          project,
          kind,
          importance: args.importance,
          source: 'tool',
        });
        // 配了 embedding 就顺手算向量。失败静默——能不能存下记忆，
        // 不该取决于外部向量服务活着没有。
        if (typeof deps.ensureVector === 'function') {
          try { await deps.ensureVector(store, record); } catch { /* 忽略 */ }
        }
        notifyWrite();
        return `已记住（id=${id}）${record.project ? `，项目标签：${record.project}` : ''}${record.kind !== 'unknown' ? `，类别：${record.kind}` : ''}。`;
      },
    }),

    defineTool({
      name: 'memory_search',
      description:
        '在本地记忆库里检索。默认搜全部记忆（不论哪个对话、哪个项目写的）。'
        + '在动手改代码前、或用户提到「之前/上次/当时」「我们说好」这类跨会话上下文时应该先调用它。'
        + '中文按二字组合匹配，查得具体一些更容易命中。',
      parameters: SEARCH_SCHEMA,
      run: async (args) => {
        const cfg = getConfig();
        if (!cfg.enabled) return disabled();
        const store = getStore();

        const query = String(args.query || '').trim();
        if (!query) return '没有传入查询内容（query 为空）。';

        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
        const filters = {};
        if (args.project) filters.project = String(args.project);
        if (Array.isArray(args.tags) && args.tags.length === 1) filters.tag = String(args.tags[0]);

        // 配了 embedding 就先算查询向量；拿不到（没配/超时/报错）就纯关键词检索
        let queryVector = null;
        if (typeof deps.embedQuery === 'function') {
          try { queryVector = await deps.embedQuery(query); } catch { queryVector = null; }
        }

        let results = coreSearch(store, query, { limit, filters, queryVector });

        // 多标签时逐个再查一遍再合并（filters.tag 只支持单个，不为这个把存储层搞复杂）
        if (Array.isArray(args.tags) && args.tags.length > 1) {
          const seen = new Set(results.map((r) => r.record.id));
          for (const tag of args.tags) {
            for (const r of coreSearch(store, query, { limit, filters: { ...filters, tag: String(tag) }, queryVector })) {
              if (!seen.has(r.record.id)) {
                seen.add(r.record.id);
                results.push(r);
              }
            }
          }
          results.sort((a, b) => b.score - a.score);
          results = results.slice(0, limit);
        }

        const total = store.count();
        if (!results.length) {
          const hint = total === 0 ? '记忆库还是空的。' : `记忆库里共有 ${total} 条，但没有匹配「${query}」的。`;
          return `${hint} 如果这件事值得记，可以用 memory_save 写进去。`;
        }

        // 逐条记使用痕迹（store.recordAccess 是单条接口，不为这个加批量 API）
        for (const r of results) store.recordAccess(r.record.id, 'search');
        // 同一次检索命中多条 = 它们相关，记共现（供关系图用）
        if (typeof store.recordCooccur === 'function') {
          store.recordCooccur(results.map((r) => r.record.id));
        }
        const lines = [`找到 ${results.length} 条相关记忆（库里共 ${total} 条）：`, ''];
        results.forEach((r, i) => lines.push(renderRecord(r.record, i + 1, { maxChars: 400 })));
        const staleCount = results.filter((r) => r.why.stale).length;
        if (staleCount) lines.push('', `注意：其中 ${staleCount} 条距今超过半年，如与当前情况冲突请以现状为准。`);
        return lines.join('\n');
      },
    }),

    defineTool({
      name: 'memory_list',
      description: '列出本地记忆库里最近的记忆（不检索，纯按时间倒序）。用来看看都记了些什么。',
      parameters: LIST_SCHEMA,
      run: async (args) => {
        const cfg = getConfig();
        if (!cfg.enabled) return disabled();
        const store = getStore();
        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20;
        const records = store.list({ limit, tag: args.tag ? String(args.tag) : undefined });
        if (!records.length) return '记忆库还是空的。';
        const lines = [`最近的 ${records.length} 条记忆（库里共 ${store.count()} 条）：`, ''];
        records.forEach((rec, i) => lines.push(renderRecord(rec, i + 1, { maxChars: 160 })));
        return lines.join('\n');
      },
    }),

    defineTool({
      name: 'memory_forget',
      description:
        '从本地记忆库里删除一条记忆。**是软删，可恢复**，只有内容确实过时或写错时才用；不确定先问用户。',
      parameters: FORGET_SCHEMA,
      concurrencySafe: () => false,
      run: async (args) => {
        const cfg = getConfig();
        if (!cfg.enabled) return disabled();
        const id = String(args.id || '').trim();
        if (!id) return '没有传入要删除的 id。';
        const ok = getStore().remove(id);
        return ok ? `已删除 ${id}（软删，可恢复）。` : `没找到 id=${id} 的记忆（可能已经被删过了）。`;
      },
    }),

    defineTool({
      name: 'memory_review',
      description:
        '给本地记忆库做一次体检（只读，不改数据）：找出重复条目、从未被回忆过的、长期没更新的、缺标签的、没分类的。'
        + '看完可以把该删的用 memory_forget 删掉、该补标签的用 memory_save 重存。'
        + '如果系统提示说「该体检了」，或者用户问「记忆里有没有垃圾」，就用它。',
      parameters: REVIEW_SCHEMA,
      run: async (args) => {
        const cfg = getConfig();
        if (!cfg.enabled) return disabled();
        const store = getStore();
        const report = reviewStore(store, {
          staleDays: args.staleDays,
          neverUsedDays: args.neverUsedDays,
        });

        if (typeof onReviewed === 'function') onReviewed();

        if (!report.total) return '记忆库还是空的，没什么可体检的。';

        const lines = [
          `记忆库体检（共 ${report.total} 条，${report.chars} 字符${report.oldestAt ? `，最早一条 ${fmtDate(report.oldestAt)}` : ''}）`,
          '',
        ];

        const section = (title, items, render) => {
          if (!items.length) return;
          lines.push(`${title}：${items.length} 条`);
          items.slice(0, MAX_REVIEW_ROWS).forEach((item) => lines.push(`  - ${render(item)}`));
          if (items.length > MAX_REVIEW_ROWS) lines.push(`  …还有 ${items.length - MAX_REVIEW_ROWS} 条`);
          lines.push('');
        };

        section('🔁 正文重复', report.duplicates, (d) => `${d.id} 与 ${d.duplicateOf} 重复：${JSON.stringify(d.content.slice(0, 40))}`);
        section('💤 从没被回忆过', report.neverUsed, (r) => `${r.id}（0 命中，建于 ${fmtDate(r.createdAt)}）${JSON.stringify(r.content.slice(0, 40))}`);
        section('🕸 长期没更新', report.stale, (r) => `${r.id}（最后更新 ${fmtDate(r.updatedAt)}）${JSON.stringify(r.content.slice(0, 40))}`);
        section('🏷 没有标签', report.noTags, (r) => `${r.id} ${JSON.stringify(r.content.slice(0, 40))}`);
        section('❓ 没分类（kind=unknown）', report.noKind, (r) => `${r.id} ${JSON.stringify(r.content.slice(0, 40))}`);

        if (!report.needCleanup && report.noKind.length === 0) {
          lines.push('✅ 没发现明显问题：没有重复、没有从没用上的、标签和分类也齐。');
        } else {
          lines.push('建议：');
          if (report.duplicates.length) lines.push('- 先合并或删掉重复条目（保留较早的那条）');
          if (report.neverUsed.length) lines.push('- 「从没被回忆过」的，要么补更容易命中的关键词，要么删掉');
          if (report.noTags.length) lines.push('- 缺标签的补上标签，以后检索更容易命中');
          if (report.noKind.length) lines.push('- 没分类的大多是 v1 迁移来的老数据，可以按需补 kind');
          lines.push('（删除/改写属于破坏性操作，动手前先跟用户确认）');
        }
        return lines.join('\n');
      },
    }),
  ];
}
