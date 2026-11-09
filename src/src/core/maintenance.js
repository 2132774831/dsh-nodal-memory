/**
 * 惰性维护：到点才跑，跑完记账。
 *
 * 为什么不用 setInterval：
 *   插件的生命周期跟着宿主走——宿主可能几小时就退、可能休眠一夜、也可能连开三天。
 *   setInterval 在这三种情况下分别是：跑了没用、根本没跑、漂移得离谱。而且定时器
 *   会在进程里留一个永不结束的句柄，卸载时忘了清就是内存泄漏。
 *   正确做法是**惰性触发**：每次"用到库"的时候看一眼上次维护时间，超期才做。
 *
 * 维护内容刻意选"只做绝对安全的事"：
 *   1. 清孤儿共现行（指向已经不存在的记忆）——纯垃圾回收，删了不可能有损失
 *   2. 清孤儿 updates 行（同上）
 *   3. 记录一份统计快照，方便事后看库怎么长的
 *
 * **绝不自动改状态、不自动删记忆**。哪怕一条记忆三年没被用过，是否删除也必须由人决定——
 * 自动遗忘一旦误判就是不可逆的数据损失，这个风险不值得换那点空间。
 */

export const DEFAULT_INTERVAL_DAYS = 7;

const META_LAST = 'last_maintenance_at';
const META_REPORT = 'last_maintenance_report';

/**
 * @param {object} store  存储实例
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.intervalDays=7]
 * @param {boolean} [opts.force] 忽略时间间隔，立刻跑
 * @returns {{ran:boolean, reason:string, dueInDays?:number, orphans?:object, stats?:object}}
 */
export function runMaintenance(store, opts = {}) {
  const {
    now = Date.now(),
    intervalDays = DEFAULT_INTERVAL_DAYS,
    force = false,
  } = opts;

  const last = Number(store.getMeta(META_LAST) || 0);
  const intervalMs = Math.max(1, intervalDays) * 86400000;
  const elapsed = now - last;

  if (!force && last > 0 && elapsed < intervalMs) {
    return {
      ran: false,
      reason: 'not-due',
      dueInDays: Math.ceil((intervalMs - elapsed) / 86400000),
    };
  }

  // 双保险：维护失败绝不能让调用方（可能是写入路径）炸掉
  let orphans = { cooccur: 0, updates: 0 };
  try {
    if (typeof store.pruneOrphans === 'function') orphans = store.pruneOrphans();
  } catch {
    orphans = { cooccur: 0, updates: 0, error: 'prune failed' };
  }

  let stats = null;
  try {
    stats = store.stats();
  } catch {
    stats = null;
  }

  let integrity = 'unknown';
  try {
    if (typeof store.integrity === 'function') integrity = store.integrity();
  } catch {
    integrity = 'check-failed';
  }

  const report = {
    at: now,
    orphans,
    integrity,
    total: stats ? stats.total : null,
    neverUsed: stats ? stats.neverUsed : null,
  };

  try {
    store.setMeta(META_LAST, String(now));
    store.setMeta(META_REPORT, JSON.stringify(report));
  } catch {
    // 记账失败不影响已经做完的清理
  }

  return { ran: true, reason: force ? 'forced' : 'due', orphans, stats, integrity };
}

/** 读上次维护记录（给 /state 与调试用） */
export function maintenanceInfo(store) {
  const last = Number(store.getMeta(META_LAST) || 0);
  let report = null;
  try {
    const raw = store.getMeta(META_REPORT);
    report = raw ? JSON.parse(raw) : null;
  } catch {
    report = null;
  }
  return {
    lastAt: last || null,
    lastAgoDays: last ? Math.floor((Date.now() - last) / 86400000) : null,
    report,
  };
}
