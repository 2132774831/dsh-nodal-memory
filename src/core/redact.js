/**
 * PII / 密钥脱敏。
 *
 * 为什么必须有：这个插件的卖点是"纯本地、隐私"。但一旦开了语义检索，
 * 记忆正文会发到外部 embedding 端点；就算不开，记忆库也是个明文文件。
 * 用户把 key、手机号、身份证号粘进对话里是常事，写进库就成了长期风险。
 *
 * 设计取舍：
 *   - **在写入时脱敏**，不在读出时脱敏。理由：明文一旦落盘就已经泄露了，
 *     读的时候再遮只是掩耳盗铃。
 *   - 替换成可读的中文占位（`[已脱敏:手机号]`），人看得懂"这里原来有东西"，
 *     又不会误伤后续检索（占位串不会命中任何脱敏规则，天然幂等）。
 *   - **宁可漏，不可错**：规则都带边界（`(?<!\d)`、`\b`），避免把版本号 `1.1.1`、
 *     时间戳、端口号、sha256 摘要这类正常内容误杀。
 *   - 不做"保留原文哈希"：写入前就脱敏，去重比对的是脱敏后的文本，
 *     一致性反而更好；留着原文哈希等于留了个可爆破的指纹。
 */

/** 规则顺序有讲究：长的（身份证 18 位）要排在短的（手机 11 位）前面 */
export const REDACT_RULES = [
  {
    type: '私钥',
    // PEM 头就够判定了，不用真的匹配整段 base64
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { type: 'API Key', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { type: 'GitHub Token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { type: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'AWS Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'Bearer Token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    // key: xxx / "password": "xxx" 这类键值对
    type: '密钥字段',
    re: /(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',;]{6,}["']?/gi,
  },
  { type: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { type: '手机号', re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g },
  { type: '邮箱', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** 键值对规则要保留字段名（"password=xxx" → "password=[已脱敏:密钥字段]"），更好读 */
function replaceValueKeepingKey(match) {
  const m = /^([^:=]+[:=]\s*["']?)/.exec(match);
  const head = m ? m[1] : '';
  return head + '[已脱敏:密钥字段]';
}

/**
 * 脱敏一段文本。
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] 关掉就原样返回（给"我就是要存完整对话"的人留口子）
 * @returns {{ text: string, hits: Array<{type:string,count:number}> }}
 */
export function maskPII(text, opts = {}) {
  const src = String(text ?? '');
  if (opts.enabled === false || !src) return { text: src, hits: [] };

  let out = src;
  const tally = new Map();

  for (const rule of REDACT_RULES) {
    // 每次都要重置 lastIndex：这些是带 /g 的共享正则
    rule.re.lastIndex = 0;
    let count = 0;
    out = out.replace(rule.re, (match) => {
      // 已经替换过的不再动（幂等）
      if (match.includes('[已脱敏')) return match;
      count++;
      if (rule.type === '密钥字段') return replaceValueKeepingKey(match);
      return '[已脱敏:' + rule.type + ']';
    });
    if (count) tally.set(rule.type, (tally.get(rule.type) ?? 0) + count);
  }

  const hits = [...tally.entries()].map(([type, count]) => ({ type, count }));
  return { text: out, hits };
}
