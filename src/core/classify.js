/**
 * 类别推断：把一条记忆粗分成 工作 / 偏好 / 情感（或未分类）。
 *
 * 为什么需要它：kind 不是装饰字段，它决定**半衰期**——工作 365 天、偏好 730 天、
 * 情感 60 天。如果全都落在 unknown，那"情感忘得快、偏好记得久"这套设计就是空转。
 *
 * 为什么只用规则、不用模型：
 *   1. 这是每次写入都要跑的路径，不能有网络依赖；
 *   2. 误判代价很低（补标页随时能改），所以"猜个大概"比"什么都不猜"强；
 *   3. 规则可以被看懂和被修正，模型不能。
 *
 * 设计上的保守：**证据不足就不猜**（返回 unknown），宁缺勿滥。
 * 只有出现明确信号才下结论，避免把所有技术记忆都塞进 work。
 */

/** 情绪词：出现这些说明这条多半在说"感觉" */
const EMOTION_WORDS = [
  '心情', '情绪', '开心', '高兴', '爽', '舒服', '喜欢', '感动', '心疼', '满足', '放心',
  '烦', '烦人', '烦死', '郁闷', '难受', '难过', '委屈', '生气', '火大', '恼火',
  '害怕', '担心', '焦虑', '紧张', '压力', '累', '疲惫', '崩溃', '绝望', '失望',
  '讨厌', '受不了', '无语', '离谱', '牛逼', '厉害', '佩服',
];

/**
 * 偏好词：只留**语义明确**的。
 * 教训：一开始把"必须/禁止/要求/希望/最好/尽量"也算进来，结果一条技术记忆
 * 因为正文里有"必须"就被归成偏好。这些词在工程笔记里太常见，不能当偏好信号。
 */
const PREFERENCE_WORDS = [
  '偏好', '喜欢用', '更喜欢', '宁愿', '宁可', '习惯用', '平时都', '以后都',
  '不喜欢', '接受不了', '别用', '别再用', '统一用', '一律',
];

/** 工作词：出现这些说明这条在说"干活的事" */
const WORK_WORDS = [
  '项目', '代码', '文件', '目录', '路径', '部署', '配置', '接口', '路由', '字段',
  '提交', '版本', '端口', '命令', '依赖', '插件', '测试', '修复', '脚本', '构建',
  '数据库', '日志', '报错', '异常', '函数', '参数', 'schema', 'api', 'bug',
  '安装', '升级', '文档', '仓库', '分支', 'commit', 'release',
  // 英文技术词：中文技术文档里这些词几乎不会被别的场景用到
  'sqlite', 'sql', 'wal', 'pragma', 'node', 'npm', 'pnpm', 'git', 'json',
  'http', 'request', 'response', 'html', 'css', 'python', 'shell', 'powershell',
  'docker', 'linux', 'windows', 'mac',
  // 中文技术名词（"内存/线程/并发"这类在日常对话里几乎不出现）
  '内存', '线程', '并发', '缓存', '索引', '编译', '打包', '服务器', '客户端',
  '模块', '框架', '前端', '后端', '组件', '渲染', '进程',
];

/** 第一人称：判断"这是不是在说我自己的感受/偏好" */
const FIRST_PERSON = ['我', '主人', '咱', '自己'];

/** 时间性词：情绪多半带时间锚点（"今天很烦"），而偏好是长期状态 */
const TIME_WORDS = ['今天', '刚才', '现在', '这会儿', '最近', '这两天', '刚刚'];

function hits(text, words) {
  const out = [];
  for (const w of words) if (text.includes(w)) out.push(w);
  return out;
}

/**
 * 推断一条记忆的类别。
 * @param {string} content 正文
 * @param {object} [opts]
 * @param {string[]} [opts.tags]
 * @returns {{kind: 'work'|'preference'|'emotion'|'unknown', why: string}}
 */
export function inferKindFromContent(content, opts = {}) {
  // 统一转小写再匹配：英文技术词（WAL/pragma/Node）大小写混用很常见
  const text = String(content || '').toLowerCase();
  const tags = Array.isArray(opts.tags) ? opts.tags.map(String) : [];

  // 显式标签优先：人工打了标签就以标签为准
  if (tags.includes('pref') || tags.some((t) => t.startsWith('pref:'))) {
    return { kind: 'preference', why: '标签表明是偏好' };
  }
  if (tags.includes('emotion') || tags.includes('mood')) {
    return { kind: 'emotion', why: '标签表明是情绪' };
  }

  const emo = hits(text, EMOTION_WORDS);
  const pref = hits(text, PREFERENCE_WORDS);
  const work = hits(text, WORK_WORDS);
  const fp = hits(text, FIRST_PERSON);
  const time = hits(text, TIME_WORDS);

  // 情感：要有情绪词，而且要么带时间锚点（"今天很烦"），要么是第一人称感受
  // 单靠一个情绪词不够——"这个 bug 很烦人"也是工作记录。
  if (emo.length && (time.length || (fp.length && emo.length >= 2))) {
    return { kind: 'emotion', why: `情绪词 ${emo.slice(0, 3).join('、')}${time.length ? ' + 时间词 ' + time.slice(0, 2).join('、') : ''}` };
  }

  // 偏好：偏好词 + 第一人称，或两个以上偏好词
  if (pref.length && (fp.length || pref.length >= 2)) {
    return { kind: 'preference', why: `偏好词 ${pref.slice(0, 3).join('、')}` };
  }

  // 工作：技术词够多才判，避免"改了个文件"这种顺带提到就被划成工作
  if (work.length >= 2) {
    return { kind: 'work', why: `技术词 ${work.slice(0, 3).join('、')}` };
  }

  return { kind: 'unknown', why: '证据不足，留给人工' };
}

/** 给补标页用：批量推断（不落库，返回建议） */
export function classifyBatch(records) {
  return (Array.isArray(records) ? records : []).map((r) => {
    const res = inferKindFromContent(r.content, { tags: r.tags });
    return { id: r.id, content: r.content, from: r.kind || 'unknown', to: res.kind, why: res.why };
  });
}
