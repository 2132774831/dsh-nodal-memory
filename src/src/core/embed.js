/**
 * 可选 embedding 层：接 OpenAI 兼容的 /embeddings 端点。
 *
 * 三条铁律：
 *   1. **默认关闭**，没配好就是完全不生效——不能因为"有个可选功能"就让基础检索变慢。
 *   2. **失败必须降级**。网络超时、Key 失效、返回格式不对……任何异常都只返回 ok:false，
 *      绝不抛给调用方；调用方拿不到向量就退回纯 BM25。搜索永远是可用的。
 *   3. **不绑定厂商**。DeepSeek 没有 embedding 接口，所以这里的 baseUrl / model / key
 *      全部由配置填，协议按 OpenAI 的 `/embeddings` 走（市面上绝大多数服务兼容这套）。
 *
 * 向量一律**归一化后存储**：这样余弦相似度退化成点积，检索时省一次开方，也省得
 * 以后有人忘了归一化导致打分尺度飘。
 */

import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_BATCH = 10;
const CACHE_LIMIT = 500;

/** 把任意数组归一化成单位向量；全零或非法输入返回 null */
export function normalizeVec(values) {
  if (!values || typeof values.length !== 'number' || values.length === 0) return null;
  const out = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
    sum += v * v;
  }
  if (sum <= 0) return null;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** 单位向量的余弦相似度 = 点积。维度不一致返回 0（不可比，别硬算）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** 存库用：Float32 → base64（两个后端都能安全存字符串，不必赌驱动对 BLOB 的行为） */
export function encodeVec(vec) {
  const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  return bytes.toString('base64');
}

export function decodeVec(text) {
  if (!text) return null;
  try {
    const bytes = Buffer.from(String(text), 'base64');
    if (bytes.byteLength % 4 !== 0) return null;
    // 复制一份，避免底层 ArrayBuffer 被共享/对齐出问题
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
  } catch {
    return null;
  }
}

/**
 * @param {object} cfg  { enabled, baseUrl, model, apiKeyEnv }
 * @param {object} [opts] { timeoutMs, batch, fetchImpl, cacheLimit }
 */
export function createEmbedder(cfg = {}, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    batch = DEFAULT_BATCH,
    fetchImpl = globalThis.fetch,
    cacheLimit = CACHE_LIMIT,
  } = opts;

  const enabled = cfg.enabled === true && typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() !== ''
    && typeof cfg.model === 'string' && cfg.model.trim() !== '';
  const model = String(cfg.model || '');
  const apiKeyEnv = String(cfg.apiKeyEnv || 'DSH_EMBEDDING_API_KEY');
  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  // 直接填的 key 优先，其次读环境变量。两者都没有就是无鉴权端点（本地自建模型常这样）。
  const literalKey = String(cfg.apiKey || '').trim();
  const resolveKey = () => literalKey || String(process.env[apiKeyEnv] || '').trim();

  const cache = new Map();
  const stats = { requests: 0, cacheHits: 0, failures: 0, vectors: 0, lastError: null };

  function cacheKey(text) {
    return model + ':' + createHash('sha1').update(String(text)).digest('hex');
  }

  function remember(text, vec) {
    const key = cacheKey(text);
    if (cache.size >= cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, vec);
  }

  async function callApi(texts) {
    const apiKey = resolveKey();
    const res = await fetchImpl(baseUrl + '/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(timeoutMs)
        : undefined,
    });

    if (!res.ok) {
      const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      throw new Error('HTTP ' + res.status + (body ? ' ' + String(body).slice(0, 120) : ''));
    }

    const json = await res.json();
    const data = json && Array.isArray(json.data) ? json.data : null;
    if (!data || data.length !== texts.length) {
      throw new Error('返回格式不对（data 数量不匹配）');
    }

    // 按 index 归位：有些服务返回顺序不保证
    const out = new Array(texts.length).fill(null);
    for (const item of data) {
      const idx = Number.isInteger(item.index) ? item.index : out.findIndex((v) => v === null);
      if (idx < 0 || idx >= out.length) continue;
      out[idx] = normalizeVec(item.embedding);
    }
    if (out.some((v) => v === null)) throw new Error('有向量为空或非法');
    return out;
  }

  /**
   * 批量取向量。永不抛错。
   * @returns {Promise<{ok:boolean, vectors?:Float32Array[], error?:string}>}
   */
  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (!enabled) return { ok: false, error: 'embedding 未启用' };
    if (list.length === 0) return { ok: true, vectors: [] };
    if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时没有 fetch' };

    const out = new Array(list.length).fill(null);
    const missing = [];

    for (let i = 0; i < list.length; i++) {
      const hit = cache.get(cacheKey(list[i]));
      if (hit) {
        out[i] = hit;
        stats.cacheHits++;
      } else {
        missing.push(i);
      }
    }

    try {
      // 逐批发送。**批量失败要能自适应拆小**：
      // 各家对单批条数限制不同（实测千问转发站就拒绝 32 条一批，只允许更小），
      // 写死一个具体数字迟早撞墙，干脆二分重试到单条为止。
      async function collect(slice) {
        if (slice.length === 0) return [];
        if (slice.length === 1) {
          stats.requests++;
          return await callApi([list[slice[0]]]);
        }
        try {
          stats.requests++;
          return await callApi(slice.map((i) => list[i]));
        } catch (err) {
          // 只有"批量太大"这类可恢复错误才拆；鉴权/网络错直接抛，免得白试很多次
          const msg = String((err && err.message) || '');
          if (!/batch|size|too (many|large)|length|tokens/i.test(msg)) throw err;
          const mid = Math.ceil(slice.length / 2);
          const left = await collect(slice.slice(0, mid));
          const right = await collect(slice.slice(mid));
          return left.concat(right);
        }
      }

      for (let start = 0; start < missing.length; start += batch) {
        const slice = missing.slice(start, start + batch);
        const vectors = await collect(slice);
        slice.forEach((targetIdx, k) => {
          out[targetIdx] = vectors[k];
          remember(list[targetIdx], vectors[k]);
          stats.vectors++;
        });
      }
    } catch (err) {
      stats.failures++;
      stats.lastError = String((err && err.message) || err);
      return { ok: false, error: stats.lastError };
    }

    return { ok: true, vectors: out };
  }

  async function embedOne(text) {
    const r = await embed([text]);
    if (!r.ok) return r;
    return { ok: true, vector: r.vectors[0] };
  }

  return {
    enabled,
    model,
    baseUrl,
    apiKeyEnv,
    /** key 是否有着落（不暴露 key 本身） */
    hasKey: () => Boolean(resolveKey()),
    embed,
    embedOne,
    stats: () => ({ ...stats, cacheSize: cache.size }),
    clearCache: () => cache.clear(),
  };
}

/** 配置里没填就不返回可用实例（调用方据此跳过整条路径） */
export function embedderFromConfig(cfg, opts) {
  return createEmbedder(cfg || {}, opts);
}
