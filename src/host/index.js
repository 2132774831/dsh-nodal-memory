/**
 * dsh-local-memory v2 — Host 半侧（薄插件）。
 *
 * 这一层**只做三件事**：把 core 的能力接到宿主上、读配置、兜异常。
 * 任何"记忆系统本身的逻辑"都不该写在这里——那样将来做独立软件时就得复制一份。
 *
 * 用到的宿主能力（都是 v1 验证过确定存在的）：
 *   ctx.tools.register(def)          注册工具
 *   ctx.systemPrompt.section(spec)   常驻提示词
 *   ctx.on('agent/pre-step', fn)     每轮自动回忆
 *   ctx.effect(fn)                   卸载清理
 *   ctx.get('sessions')              （软获取）拿会话 cwd
 */

import fs from 'node:fs';
import path from 'node:path';

import { openStore, sqliteAvailable, migrateFromV1, runMaintenance } from '../core/index.js';
import { readConfig, writeConfig, defaultDbFile, defaultJsonFile, dshHome, NS } from './config.js';
import { buildTools } from './tools.js';
import { buildBrief } from './prompt.js';
import { createRecallHandler } from './recall.js';
import { detectProject } from './project.js';
import { registerRoutes } from './routes.js';
import { queryVectorFor, ensureVector } from './embedding.js';

/**
 * 解析要用的库路径与后端。
 * 'auto' 时：有 node:sqlite 走 .db，没有走 .json。
 */
function resolveTarget(cfg) {
  const hasSqlite = sqliteAvailable();
  const backend = cfg.backend === 'auto' ? (hasSqlite ? 'sqlite' : 'json') : cfg.backend;
  const file = backend === 'sqlite' ? defaultDbFile() : defaultJsonFile();
  return { backend, file };
}

/**
 * 首次使用时把 v1 的 JSON 库迁过来。
 *
 * 安全性：只读 v1 文件，只写 v2 新文件。迁移器本身幂等，且这里用 meta 标记
 * 保证只自动跑一次——即使 v2 库后来被清空，也不会因为"库是空的"而重复导入。
 */
function autoMigrate(store) {
  try {
    if (store.getMeta('migrated_from_v1')) return null;
    if (store.count({ includeDeleted: true }) > 0) return null;

    const v1File = path.join(dshHome(), 'dsh-local-memory.json');
    if (!fs.existsSync(v1File)) return null;

    const data = JSON.parse(fs.readFileSync(v1File, 'utf8'));
    const report = migrateFromV1(store, data);
    store.setMeta('migrated_from_v1', JSON.stringify({
      at: Date.now(),
      total: report.total,
      inserted: report.inserted,
      skipped: report.skipped,
      invalid: report.invalid,
    }));
    return report;
  } catch (err) {
    // 迁移失败不能挡住插件启动：退回"空库可用"状态，把原因挂到 meta 里备查
    try {
      store.setMeta('migrate_error', String((err && err.message) || err));
    } catch { /* 忽略 */ }
    return null;
  }
}

export function apply(ctx) {
  const disposers = [];

  let store = null;
  let storeKey = null;

  /**
   * 惰性维护：到点才跑。
   *
   * 不用 setInterval —— 宿主随时会退出/休眠，定时器要么白跑要么漂移；
   * 这里改成"每次用到库的时候看一眼上次维护时间"，超期才做。
   * 检查本身只是一次 meta 读取，开销可以忽略。
   *
   * 维护只做绝对安全的事（清孤儿行、记统计快照），**绝不自动删记忆或改状态**。
   */
  function maybeMaintain(target) {
    try {
      const cfg = readConfig();
      const intervalDays = Number(cfg.maintenanceIntervalDays) || 7;
      return runMaintenance(target, { intervalDays });
    } catch {
      // 维护失败绝不影响正常读写
      return null;
    }
  }

  /** 取（必要时重建）store。配置里换了后端/路径就换库。 */
  function getStore() {
    const cfg = readConfig();
    const { backend, file } = resolveTarget(cfg);
    const key = backend + ':' + file;
    if (!store || storeKey !== key) {
      try {
        if (store) store.close();
      } catch { /* 旧库关不掉不影响新库 */ }
      store = openStore({ file, backend });
      storeKey = key;
      autoMigrate(store);
      maybeMaintain(store);
    }
    return store;
  }

  /** 工具执行上下文 → {cwd, project} */
  function getCwd(exec) {
    const agent = exec && exec.agent;
    let cwd = null;
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(agent && agent.id) : undefined;
      const fromHeader = session && session.header && session.header.cwd;
      if (typeof fromHeader === 'string' && fromHeader.trim()) cwd = fromHeader;
    } catch { /* 拿不到就退回下面的兜底 */ }

    if (!cwd) {
      for (const candidate of [agent && agent.cwd, exec && exec.cwd]) {
        if (typeof candidate === 'string' && candidate.trim()) { cwd = candidate; break; }
      }
    }
    if (!cwd) cwd = process.cwd();

    const cfg = readConfig();
    const project = cfg.autoTagProject ? detectProject(cwd).name : '';
    return { cwd, project };
  }

  /* ── 1. 工具 ──────────────────────────────────────────────────────────── */

  const tools = buildTools({
    getStore,
    getConfig: readConfig,
    getCwd,
    onReviewed: () => {
      writeConfig({ lastReviewAt: Date.now() });
    },
    // 写入后顺手看一眼该不该维护（检查很便宜，真正干活才花时间）
    onWrite: () => {
      try {
        maybeMaintain(getStore());
      } catch { /* 忽略 */ }
    },
    // 可选 embedding：没配就是 null，配了失败也返回 null（调用方降级到纯关键词）
    embedQuery: queryVectorFor,
    ensureVector,
  });

  for (const definition of tools) {
    try {
      disposers.push(ctx.tools.register(definition));
    } catch {
      // 工具重名等情况下不该拖垮整个插件：其余工具照常可用
    }
  }

  /* ── 2. 常驻提示词 ─────────────────────────────────────────────────────── */

  try {
    disposers.push(ctx.systemPrompt.section({
      name: `${NS}:brief`,
      order: 60,
      text: () => {
        try {
          const cfg = readConfig();
          if (!cfg.enabled || cfg.injectBrief === false) return '';

          let count = 0;
          let noKind = 0;
          try {
            const stats = getStore().stats();
            count = stats.total;
            const row = (stats.byKind || []).find((k) => k.kind === 'unknown');
            noKind = row ? row.c : 0;
          } catch {
            count = 0;
          }

          const interval = Number(cfg.reviewIntervalDays) || 0;
          const lastReviewAt = Number(cfg.lastReviewAt) || 0;
          const DAY = 86400000;
          const daysSince = lastReviewAt ? Math.floor((Date.now() - lastReviewAt) / DAY) : null;
          const overdue = interval > 0 && (lastReviewAt === 0 || daysSince >= interval);

          return buildBrief({
            config: cfg,
            count,
            noKind,
            review: { overdue, lastReviewAt, daysSince, interval },
          });
        } catch {
          return '';
        }
      },
    }));
  } catch {
    // 提示词注册失败不影响工具可用
  }

  /* ── 3. 每轮自动回忆 ───────────────────────────────────────────────────── */

  try {
    const handler = createRecallHandler({ getStore, getConfig: readConfig });
    disposers.push(ctx.on('agent/pre-step', handler));
  } catch {
    // 事件不可用时退化为"只有工具、没有自动回忆"
  }

  /* ── 4. HTTP 路由（设置页 / 关系图） ──────────────────────────────────── */

  try {
    registerRoutes(ctx, { getStore, disposers });
  } catch {
    // 没有 webServer（headless / CLI 场景）时插件照常工作，只是没有设置页
  }

  /* ── 5. 卸载清理 ───────────────────────────────────────────────────────── */

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch { /* 逐个清理，互不影响 */ }
    }
    disposers.length = 0;
    try {
      if (store) store.close();
    } catch { /* 忽略 */ }
    store = null;
    storeKey = null;
  });
}

export { NS };
