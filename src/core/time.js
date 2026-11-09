/**
 * 时间感知：让模型不再把"三周前"记成"昨天"。
 *
 * 三级粒度来自设计文档，这里只做纯计算，不依赖任何模型：
 *   - 精确感知区（<7 天）：今天/昨天/N 小时前/N 天前
 *   - 模糊感知区（7 天 ~ 180 天）：N 周前 / N 个月前
 *   - 档案归档区（>180 天）：YYYY 年 MM 月（绝对时间，避免"很久以前"这种无信息量的话）
 *
 * 为什么不直接用 ISO 时间戳喂模型：
 * 模型对 "2026-10-18T14:22:00+08:00" 没有任何直觉，对"三周前"有。
 * 两个都给才有用——标签给人看，ISO 给排序和衰减算。
 */

const DAY_MS = 86400000;

/** 各种输入统一成毫秒时间戳；无法解析返回 null */
export function toMs(when) {
  if (when == null) return null;
  if (typeof when === 'number') return Number.isFinite(when) ? when : null;
  if (when instanceof Date) return when.getTime();

  const s = String(when).trim();
  if (!s) return null;

  // 纯数字（含 SQLite 把数字绑定进 TEXT 列时产生的 "1759200000000.0"）直接当毫秒。
  // 这一条是踩出来的：不给它，Date.parse 会返回 NaN，时间戳被静默当成"现在"。
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** 毫秒 → ISO8601（本地时区偏移保留，便于人读） */
export function toIso(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 相对时间描述。
 * @returns {{label:string, level:'precise'|'fuzzy'|'archive', days:number}}
 */
export function formatRelative(when, now = Date.now()) {
  const ms = toMs(when);
  if (ms == null) return { label: '时间未知', level: 'archive', days: Infinity };

  const delta = now - ms;
  const days = delta / DAY_MS;

  // 未来时间：时钟漂移或用户手填，别显示"-3天前"这种废话
  if (days < 0) return { label: '刚刚', level: 'precise', days: 0 };

  if (days < 1) {
    const hours = Math.floor(delta / 3600000);
    if (hours < 1) return { label: '刚刚', level: 'precise', days };
    return { label: hours + ' 小时前', level: 'precise', days };
  }
  if (days < 2) return { label: '昨天', level: 'precise', days };
  if (days < 7) return { label: Math.floor(days) + ' 天前', level: 'precise', days };

  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return { label: weeks + ' 周前', level: 'fuzzy', days };
  }
  if (days < 180) {
    const months = Math.floor(days / 30);
    return { label: months + ' 个月前', level: 'fuzzy', days };
  }

  const d = new Date(ms);
  const label = d.getFullYear() + ' 年 ' + String(d.getMonth() + 1).padStart(2, '0') + ' 月';
  return { label, level: 'archive', days };
}

/** 超过这个天数就提示"记忆较旧，请谨慎参考" */
export const STALE_DAYS = 180;

/**
 * 时效性评估：存档区一律提醒，因为模型最容易在这种地方编造"最近"。
 * @returns {{stale:boolean, warning:string|null, days:number, level:string}}
 */
export function freshness(when, now = Date.now()) {
  const rel = formatRelative(when, now);
  const stale = rel.days >= STALE_DAYS;
  return {
    stale,
    warning: stale ? '这条记忆距今较久（' + rel.label + '），如与当前情况冲突请以现状为准' : null,
    days: rel.days,
    level: rel.level,
  };
}

/**
 * 时间衰减：用**半衰期**表达，比 exp(-λt) 好解释也好调。
 *   - 工作记忆（代码/配置/踩坑）沉淀价值高，衰减慢：一年半衰
 *   - 偏好/约定更持久：两年半衰
 *   - 情绪/闲聊会过期：两个月半衰
 *   - unknown（v1 迁移过来的老数据没分类）按工作记忆处理，宁可保守
 */
export const HALF_LIFE_DAYS = {
  work: 365,
  preference: 730,
  emotion: 60,
  unknown: 365,
};

/**
 * 衰减系数 ∈ (0, 1]。刚写的 = 1，过了半个半衰期 ≈ 0.707。
 *
 * @param {number|string|Date} when
 * @param {string} [kind]
 * @param {number} [now]
 * @param {object|null} [halfLifeDays] 用户覆盖的每类半衰期（{work:365,...}）。
 *        没给的类别仍用 HALF_LIFE_DAYS；**给了非法值（0/负数/非数字）也退回默认**，
 *        因为半衰期是除数，写坏一个 0 就会让整类记忆瞬间消失。
 */
export function decayFactor(when, kind = 'unknown', now = Date.now(), halfLifeDays = null) {
  const ms = toMs(when);
  if (ms == null) return 0.5; // 时间未知：中性偏保守
  const days = Math.max(0, (now - ms) / DAY_MS);
  const custom = halfLifeDays && Number(halfLifeDays[kind]);
  const halfLife = (Number.isFinite(custom) && custom > 0)
    ? custom
    : (HALF_LIFE_DAYS[kind] ?? HALF_LIFE_DAYS.unknown);
  return Math.pow(0.5, days / halfLife);
}

/**
 * 一份给人/给模型看的时间头。
 * 例：`[3 周前 · 2026-10-18]`
 */
export function stamp(when, now = Date.now()) {
  const rel = formatRelative(when, now);
  const ms = toMs(when);
  if (ms == null) return '[时间未知]';
  const d = new Date(ms);
  const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return '[' + rel.label + ' · ' + iso + ']';
}
