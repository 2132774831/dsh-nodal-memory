/**
 * 用应用里填的 key 自动整理事件连线（B 模式）。
 *
 * 设计原则：
 *   1. **失败绝不影响主流程** —— 调用方只当它是个可选的后台活；
 *   2. **只在明确选择 ai-key 时才跑** —— 默认是字词相似，不花钱；
 *   3. **写进去的是"模型给的理由"** —— 图上能悬停看到，出错了也好排查；
 *   4. **不覆盖字词相似的结果** —— source='ai-key'，和 'ai'（DSH 整理）分开存。
 */

const MAX_MEMORIES = 60;

/** 从配置里拼出 chat completions 的地址：和 embedding 用同一个 baseUrl */
function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  // 已经是 /v1 结尾（OpenAI 兼容）就直接拼 /chat/completions
  return base + '/chat/completions';
}

/**
 * @param {object} opts
 * @param {object} opts.store           记忆库
 * @param {object} opts.embedding       配置里的 embedding 段（含 baseUrl / apiKey / apiKeyEnv）
 * @param {string} opts.model           要用的对话模型名
 * @param {Function} [opts.fetchImpl]   注入的 fetch（测试用）
 * @param {Function} [opts.log]         日志
 * @returns {Promise<{ok:boolean, written?:number, error?:string, skipped?:string}>}
 */
export async function runAutoEventLink({ store, embedding, model, fetchImpl, log = () => {} } = {}) {
  const cfg = embedding || {};
  const key = process.env[cfg.apiKeyEnv || ''] || cfg.apiKey || '';
  const endpoint = chatEndpoint(cfg.baseUrl);
  if (!endpoint) return { ok: false, skipped: '没配 baseUrl' };
  if (!key) return { ok: false, skipped: '没配 apiKey' };
  if (!model) return { ok: false, skipped: '没配整理模型' };
  if (!store || typeof store.list !== 'function') return { ok: false, skipped: '没有记忆库' };

  const rows = store.list({ limit: MAX_MEMORIES });
  if (rows.length < 2) return { ok: false, skipped: '记忆太少，不用整理' };

  const lines = rows.map((r) => `- id=${r.id} | ${r.kind} | ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 80)}`);
  const prompt = [
    '下面是一批记忆条目。请找出其中**确实属于同一件事**的配对（同一次排障、同一个项目的同一阶段、同一个问题的前后两次）。',
    '只输出 JSON 数组，不要解释，格式：[[\"idA\",\"idB\",\"一句话理由\"], ...]。',
    '判断要保守：只是"主题相近"不要连；没有把握就不要连。没有配对就输出 []。',
    '',
    ...lines,
  ].join('\n');

  const body = {
    model,
    messages: [
      { role: 'system', content: '你是一个严谨的记忆整理助手，只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    // 推理型模型会把额度花在思考上，太小会导致 content 为空（只回 reasoning_content）
    max_tokens: 2000,
  };

  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(300000) : undefined;
    res = await f(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return { ok: false, error: '请求失败：' + (e && e.message ? e.message : String(e)) };
  }
  if (!res || !res.ok) {
    return { ok: false, error: '接口返回 ' + (res ? res.status : '?') };
  }

  let data;
  try { data = await res.json(); } catch { return { ok: false, error: '返回不是 JSON' }; }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '') : '';
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) {
    const hasReasoning = !!(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.reasoning_content);
    return {
      ok: false,
      error: hasReasoning
        ? '模型只回了思考过程、正文是空的（推理型模型常见）。换个非推理模型，或把 max_tokens 调大'
        : '模型没给出 JSON 数组',
    };
  }

  let pairs;
  try { pairs = JSON.parse(m[0]); } catch { return { ok: false, error: 'JSON 解析失败' }; }
  if (!Array.isArray(pairs)) return { ok: false, error: '不是数组' };

  let written = 0;
  for (const p of pairs.slice(0, 200)) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const a = String(p[0] || '').trim();
    const b = String(p[1] || '').trim();
    const reason = String(p[2] || '').slice(0, 200);
    if (!a || !b || a === b) continue;
    if (!store.get(a) || !store.get(b)) continue;
    if (store.putEventLink(a, b, { reason, source: 'ai-key' })) written += 1;
  }
  log('[auto-link] 写入 ' + written + ' 条（模型 ' + model + '）');
  return { ok: true, written };
}

/** 距离上次整理够不够久（天） */
export function isAutoLinkDue(lastRunAt, intervalDays, now = Date.now()) {
  const days = Number(intervalDays) || 0;
  if (days <= 0) return false;
  if (!lastRunAt) return true;
  return (now - lastRunAt) >= days * 86400000;
}
