/**
 * 宿主侧的 embedding 接线。
 *
 * 职责很小：按当前配置拿一个（缓存住的）embedder，并提供两个"永不抛错"的便捷函数。
 * 真正的协议细节在 core/embed.js 里，宿主层不重复实现。
 *
 * 为什么缓存 embedder：每次搜索都重新读配置 + 造实例没必要，而配置变了要能立刻生效，
 * 所以用「配置指纹」判断要不要重建。
 */

import { createEmbedder } from '../core/index.js';
import { readConfig } from './config.js';

let cached = null;
let cachedKey = '';

/** 按当前配置取 embedder（配置变了自动重建） */
export function getEmbedder() {
  let cfg = { enabled: false };
  try {
    cfg = readConfig().embedding || { enabled: false };
  } catch {
    cfg = { enabled: false };
  }
  const key = JSON.stringify([cfg.enabled, cfg.baseUrl, cfg.model, cfg.apiKeyEnv]);
  if (!cached || cachedKey !== key) {
    cached = createEmbedder(cfg);
    cachedKey = key;
  }
  return cached;
}

/**
 * 查询向量。任何失败都返回 null，调用方据此退回纯关键词检索。
 * 这条路径绝不能抛错：embedding 是增强，不是依赖。
 */
export async function queryVectorFor(text) {
  try {
    const embedder = getEmbedder();
    if (!embedder.enabled) return null;
    const r = await embedder.embedOne(text);
    return r.ok ? r.vector : null;
  } catch {
    return null;
  }
}

/**
 * 给一条记忆补算并存入向量（写入时顺手做）。
 * 失败静默——存记忆成功与否，不该取决于外部向量服务活着没有。
 */
export async function ensureVector(store, record) {
  try {
    const embedder = getEmbedder();
    if (!embedder.enabled) return false;
    if (!record || !record.id || !record.content) return false;
    const r = await embedder.embedOne(record.content);
    if (!r.ok) return false;
    return store.putVector(record.id, { model: embedder.model, vec: r.vector });
  } catch {
    return false;
  }
}

/**
 * 批量补向量（手动触发，给历史数据用）。
 * 一次只补一小批，避免长时间占用请求；**批量发送**而不是一条一请求
 * （75 条如果每条发一次，光是往返就几十秒）。
 * @returns {Promise<{ok:boolean, filled:number, remaining:number, error?:string}>}
 */
export async function backfillVectors(store, { limit = 20 } = {}) {
  const embedder = getEmbedder();
  if (!embedder.enabled) return { ok: false, filled: 0, remaining: 0, error: 'embedding 未启用' };

  const records = store.list({ limit: 1000 });
  const pending = records.filter((r) => !store.getVector(r.id));
  const batch = pending.slice(0, limit);
  if (batch.length === 0) return { ok: true, filled: 0, remaining: 0 };

  const result = await embedder.embed(batch.map((r) => r.content));
  if (!result.ok) {
    return { ok: false, filled: 0, remaining: pending.length, error: result.error };
  }

  let filled = 0;
  batch.forEach((rec, i) => {
    const vec = result.vectors[i];
    if (vec && store.putVector(rec.id, { model: embedder.model, vec })) filled++;
  });

  return { ok: true, filled, remaining: Math.max(0, pending.length - filled) };
}
