/**
 * 插件配置：读写 $DSH_HOME 下的一个 JSON 文件。
 *
 * 路径全部**惰性求值**（不在模块加载时算死）——测试要能把 DSH_HOME 指到临时目录，
 * 模块级常量会让"改了环境变量却不生效"这种坑重现。
 *
 * 配置文件名带 `.v2`，刻意与 v1 的 `dsh-local-memory-config.json` 分开：
 * 两个版本的键含义不完全一致（v1 的 storeFile 指向 JSON，v2 指向 .db），
 * 共用一份配置会在回滚时互相污染。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NS = 'dsh-local-memory';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function configFile() {
  return path.join(dshHome(), 'dsh-local-memory.v2-config.json');
}

/** 默认 SQLite 库路径 */
export function defaultDbFile() {
  return path.join(dshHome(), 'dsh-local-memory.db');
}

/** JSON 兜底库路径（Node < 22.5 时用） */
export function defaultJsonFile() {
  return path.join(dshHome(), 'dsh-local-memory.v2.json');
}

export const DEFAULTS = {
  enabled: true,

  // 'auto' = 有 node:sqlite 就用 sqlite，否则 json
  backend: 'auto',

  // 自动回忆
  autoRecall: true,
  autoRecallMaxItems: 5,
  autoRecallMinChars: 8,

  // 写入行为
  autoTagProject: true,
  maxTextLength: 4000,

  // 体检提醒
  reviewIntervalDays: 30,
  lastReviewAt: 0,

  // 惰性维护：超过这么多天才在"用到库"的时候顺手做一次垃圾回收
  maintenanceIntervalDays: 7,

  // 呈现
  injectBrief: true,

  // v2 新增：可选 embedding（默认关闭，失败自动降级到 BM25）
  embedding: {
    enabled: false,
    baseUrl: '',
    model: '',
    // 两种提供 key 的方式，任选其一：
    //   apiKeyEnv —— 环境变量名（推荐，key 不落盘）
    //   apiKey    —— 直接填（桌面软件的便利选择；存在本机配置文件里，界面不回显）
    apiKeyEnv: 'DSH_EMBEDDING_API_KEY',
    apiKey: '',
  },

  /**
   * 功能开关。原则：**锦上添花的东西都做成可关，且默认保守**。
   * 用户不需要"我觉得好所以强塞给你"，而需要"我不想要就一键关掉"。
   */
  features: {
    // 图上真实有用的
    semanticEdges: true,     // 语义相近边（用已有向量，不额外花钱）
    conflictMarks: true,     // 疑似冲突标黄
    // 弱关系
    projectEdges: false,     // 同项目边（59 条同项目曾造成 1711 条边的毛线球）—— 噪声，默认关
    // 时间相邻边虽然"没信息量"，但它是唯一把记忆按时间串开、不让布局塌成一团的力。
    // 实测关掉后中间挤成一坨、文字互相压住，所以默认开着。
    timeEdges: true,
    // 直觉页
    dueReview: true,         // 「该想起的」
    conflictScan: true,      // 「疑似冲突」
    // 写入时按内容粗分 工作/偏好/情感。kind 决定半衰期，全落在 unknown 就失去了意义。
    // 误判可以随时在补标页改，所以默认开。
    autoKind: true,
    /**
     * 软遗忘：长期没用过的低价值记忆**只降权、不删除**。
     * 关掉 = 排序完全不看"闲置多久"。
     * 对应数字是 forgetAfterDays（见上）。
     */
    softForget: true,
  },
  /** 闲置多少天后开始给低价值记忆降权（只影响排序，永不删数据） */
  forgetAfterDays: 180,

  /**
   * 各类记忆的衰减半衰期（天）。这是整套设计里最该让用户自己调的旋钮：
   * 有人希望"情绪一百年都不忘"，也有人希望"上个月的心情就别再提了"。
   * 默认值来自 core/time.js 的 HALF_LIFE_DAYS，改这里只影响检索排序，不改数据。
   */
  halfLifeDays: {
    work: 365,
    preference: 730,
    emotion: 60,
    unknown: 365,
  },
  /** 冲突检测灵敏度：strict 严（少而准）/ normal 标准 / loose 松（多而杂） */
  conflictSensitivity: 'normal',

  /**
   * 隐私。
   *
   * maskPII 默认**开**：记忆库是明文文件，而且一旦开语义检索，正文还会发到外部
   * embedding 端点。用户把 key/手机号粘进对话里是常事，不脱敏等于长期留隐患。
   * 关掉是给"我就是要存完整原文"的人留的口子——代价自负。
   */
  privacy: {
    maskPII: true,
  },
};

const BOOL_KEYS = ['enabled', 'autoRecall', 'autoTagProject', 'injectBrief'];
const RANGES = {
  autoRecallMaxItems: [1, 20],
  autoRecallMinChars: [0, 500],
  reviewIntervalDays: [0, 3650],
  maintenanceIntervalDays: [1, 365],
  forgetAfterDays: [30, 3650],
  maxTextLength: [100, 20000],
};

/**
 * 归一化配置。非法值回退到默认值，**不抛错**——
 * 一份写坏的配置不该让整个插件的工具全部不可用。
 */
export function normalizeConfig(input) {
  const out = {
    ...DEFAULTS,
    embedding: { ...DEFAULTS.embedding },
    features: { ...DEFAULTS.features },
    privacy: { ...DEFAULTS.privacy },
    halfLifeDays: { ...DEFAULTS.halfLifeDays },
  };
  const src = input && typeof input === 'object' ? input : {};

  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in src) || src[key] === undefined || src[key] === null) continue;
    const value = src[key];

    if (key === 'embedding') {
      const e = value && typeof value === 'object' ? value : {};
      out.embedding = {
        enabled: e.enabled === true,
        baseUrl: String(e.baseUrl ?? '').slice(0, 512).trim(),
        model: String(e.model ?? '').slice(0, 128).trim(),
        apiKeyEnv: String(e.apiKeyEnv ?? DEFAULTS.embedding.apiKeyEnv).slice(0, 128).trim(),
        apiKey: String(e.apiKey ?? '').slice(0, 256).trim(),
      };
      continue;
    }

    if (key === 'features') {
      const f = value && typeof value === 'object' ? value : {};
      const feat = {};
      // 只认布尔；没给的沿用默认（默认本身就是保守的）
      for (const [fk, def] of Object.entries(DEFAULTS.features)) {
        feat[fk] = typeof f[fk] === 'boolean' ? f[fk] : def;
      }
      out.features = feat;
      continue;
    }

    if (key === 'privacy') {
      const p = value && typeof value === 'object' ? value : {};
      // 注意：这里**不是** `p.maskPII === true`。
      // 隐私开关默认开，配置里写坏/没写都必须落到"开"，只有显式 false 才关。
      out.privacy = { maskPII: p.maskPII !== false };
      continue;
    }

    if (key === 'halfLifeDays') {
      const h = value && typeof value === 'object' ? value : {};
      const merged = { ...DEFAULTS.halfLifeDays };
      for (const k of Object.keys(DEFAULTS.halfLifeDays)) {
        const n = Number(h[k]);
        // 半衰期是除数，写坏（0/负数/NaN）会让整类记忆瞬间消失，所以一律夹到合法区间
        if (Number.isFinite(n)) merged[k] = Math.min(3650, Math.max(7, Math.round(n)));
      }
      out.halfLifeDays = merged;
      continue;
    }

    if (key === 'conflictSensitivity') {
      const v = String(value || '');
      out.conflictSensitivity = ['strict', 'normal', 'loose'].includes(v) ? v : DEFAULTS.conflictSensitivity;
      continue;
    }

    if (BOOL_KEYS.includes(key)) {
      out[key] = value === true || value === 'true' || value === 1 || value === '1';
    } else if (RANGES[key]) {
      const [lo, hi] = RANGES[key];
      const n = Number(value);
      out[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : DEFAULTS[key];
    } else if (key === 'backend') {
      out.backend = value === 'sqlite' || value === 'json' ? value : 'auto';
    } else if (typeof DEFAULTS[key] === 'number') {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : DEFAULTS[key];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    // 走 normalizeConfig 而不是直接 {...DEFAULTS}：
    // 后者会把 features/privacy 这两个**对象字段共享引用**出去，
    // 谁改了 cfg.features 就等于改了全局默认值（下面的会话全跟着变）。
    return normalizeConfig({});
  }
}

/** 原子写：temp + rename，写一半崩了也不会留下半截配置 */
export function writeConfig(patch) {
  const current = readConfig();
  const next = normalizeConfig({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
    embedding: { ...current.embedding, ...(patch?.embedding ?? {}) },
  });
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}
