/**
 * 文本处理：为「中文也能搜」服务。
 *
 * 为什么需要这个文件（实测结论，别改回去）：
 *   - SQLite FTS5 默认的 unicode61 分词器不切中文，「我喜欢吃牛肉面」会被当成**一个** token，
 *     查「牛肉面」命中 0 条。
 *   - 换 trigram 分词器能救三字词，但「北京 / 插件 / 记忆」这类**两字词命中 0**（trigram 至少 3 字符）。
 *   - 所以这里自己做二元组切分：入库时把正文切成 bigram 存进 FTS 的专用列，
 *     查询时把 query 也切成 bigram，两边才对得上。实测两字词/三字词/英文全部命中。
 *
 * 另一个选择：英文和数字**保持整词**，不做 bigram。
 * 否则查 "me" 会因为 "memory" 里含 "me" 而误命中。
 */

/** 是否为需要二元组切分的字符（汉字 + 日文假名；不含韩文谚文，其按字母表处理更合适） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/** 通用分词用：连续的字母/数字/下划线/连字符算一个词 */
const WORD_RE = /[A-Za-z0-9_\-]+/g;

/**
 * 归一化：统一 Unicode 形式、去零宽字符、压缩空白。
 * 不做大小写折叠以外的任何"清洗"——记忆是可追溯的证据，不该被改写。
 */
export function normalize(input) {
  if (input == null) return '';
  let s = String(input).normalize('NFC');
  // 零宽空格/零宽连接符会让同一个词看起来不一样，直接去掉
  s = s.replace(/[\u200b-\u200d\ufeff]/g, '');
  // 各种花式空白统一成普通空格
  s = s.replace(/[\u00a0\u3000\t\r\n]+/g, ' ');
  return s.replace(/ {2,}/g, ' ').trim();
}

/**
 * 把文本切成「段」：连续的 CJK 段，和连续的英文/数字段。
 * 标点、空白、emoji 都是段边界（它们不承载检索价值，但会把两侧的段分开）。
 * @returns {{kind:'cjk'|'word', text:string}[]}
 */
export function segments(input) {
  const s = normalize(input);
  const out = [];
  let buf = '';
  let bufKind = null;

  const flush = () => {
    if (buf) out.push({ kind: bufKind, text: buf });
    buf = '';
    bufKind = null;
  };

  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      if (bufKind !== 'cjk') flush();
      bufKind = 'cjk';
      buf += ch;
      continue;
    }
    if (/[A-Za-z0-9_\-]/.test(ch)) {
      if (bufKind !== 'word') flush();
      bufKind = 'word';
      buf += ch;
      continue;
    }
    // 标点/空白/emoji：结束当前段
    flush();
  }
  flush();
  return out;
}

/**
 * 生成用于 FTS 索引/查询的 token 列表。
 *   - CJK 段：长度 1 → 保留单字（否则"鱼"这种单字查询搜不到）；长度 >=2 → 全部相邻二元组
 *   - 英文段：整词小写（保持整词，避免 me 命中 memory）
 * @returns {string[]} 去重前的 token 序列，保持原文顺序（顺序对 phrase 查询有意义，虽然目前用 AND）
 */
export function tokens(input) {
  const out = [];
  for (const seg of segments(input)) {
    if (seg.kind === 'word') {
      out.push(seg.text.toLowerCase());
      continue;
    }
    const chars = Array.from(seg.text);
    if (chars.length === 1) {
      out.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** 索引/存储用：token 用空格拼成一列，交给 unicode61 分（它按空格切就行） */
export function toIndexText(input) {
  return tokens(input).join(' ');
}

/**
 * 查询用：把用户输入变成安全的 FTS5 MATCH 表达式。
 * 每个 token 都加双引号，杜绝 FTS5 操作符注入（NEAR/OR/星号/冒号等）。
 *
 * mode:
 *   'AND'（默认）—— 要求所有 token 都命中。精度最高，召回最差。
 *   'OR'         —— 命中任意 token 即入候选，由调用方的覆盖率阈值把关。
 *
 * 为什么两个都要：一句中文会被切成多个 bigram（"记忆插件" → 记忆/忆插/插件），
 * 用 AND 时只要原文不是逐字连续出现就 0 命中；用 OR 又会把"只沾一个字"的噪声拉进来。
 * 实际做法是 OR 取候选 + 覆盖率阈值过滤（见 search.js），两者兼得。
 *
 * @returns {string|null} null 表示没有任何可检索的 token
 */
export function toFtsQuery(input, mode = 'AND') {
  const toks = Array.from(new Set(tokens(input)));
  if (toks.length === 0) return null;
  const quoted = toks.map((t) => '"' + t.replace(/"/g, '""') + '"');
  return quoted.join(mode === 'OR' ? ' OR ' : ' AND ');
}

/**
 * JSON 兜底后端用：把一条记忆摊成 token 集合，供纯 JS 打分。
 * 因为 JSON 后端没有 FTS，只能在内存里算"命中了几个 query token"。
 */
export function tokenSet(input) {
  return new Set(tokens(input));
}

/** 是否含 CJK（决定要不要额外走 LIKE 降级） */
export function hasCJK(input) {
  return CJK_RE.test(normalize(input));
}
