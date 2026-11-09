/**
 * 项目名探测：给记忆自动打上"属于哪个项目"的标签。
 *
 * 规则（与 v1 行为保持一致，避免迁移前后标签体系断裂）：
 *   1. 从 cwd 向上找 .git，找到就用该目录名
 *   2. 找不到就用 cwd 的 basename
 *   3. 到用户家目录为止（不越过家目录去找，否则整个 C 盘都会命中某个上层 .git）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DEPTH = 24;

/** 统一成连字符形式，和迁移器里的 normalizeProject 一致 */
function normalize(name) {
  return String(name ?? '').trim().replace(/_/g, '-');
}

export function detectProject(cwd) {
  const start = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd) : process.cwd();
  const home = path.resolve(os.homedir());

  let dir = start;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return { name: normalize(path.basename(dir)), dir, by: 'git' };
    }
    // 到工作区/家目录就停，别继续往上
    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { name: normalize(path.basename(start)), dir: start, by: 'basename' };
}
