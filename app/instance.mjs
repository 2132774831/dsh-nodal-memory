/**
 * 单实例锁与实例状态文件。
 *
 * 为什么需要：服务的入口有**两个**——插件启动 DSH 时拉起、用户双击桌面快捷方式。
 * 两者必须落到同一个实例，否则会有两个进程写同一个 SQLite（WAL 能扛，但状态会乱）。
 *
 * 机制：启动时先看状态文件里记的进程还活着、端口还响应，就复用；否则自己抢占并写回。
 * 状态文件同时是"服务在哪里"的唯一真相——插件和快捷方式都读它，不猜端口。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** DSH 的家目录。数据就放这儿——v1 的记忆库本来也在这儿，插件默认也读这儿。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 服务自己的小目录（锁文件、日志）。
 *
 * ⚠ 和"数据目录"故意分开：
 *   - 数据 = $DSH_HOME 根目录（dsh-local-memory.db），插件和独立软件共用同一个文件
 *   - 状态 = $DSH_HOME/local-memory/instance.json，只是运行期信息，删了没损失
 * 这样独立软件和插件看到的是**同一份记忆**，不会出现两边各存一份。
 */
export function appHome() {
  const fromEnv = process.env.DSH_LOCAL_MEMORY_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(dshHome(), 'local-memory');
}

export function defaultDataDir() {
  return dshHome();
}

export function statePath(home = appHome()) {
  return path.join(home, 'instance.json');
}

export function readState(home = appHome()) {
  try {
    const raw = fs.readFileSync(statePath(home), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.port !== 'number' || typeof obj.pid !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免读到半个 JSON */
export function writeState(home, obj) {
  fs.mkdirSync(home, { recursive: true });
  const file = statePath(home);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function clearState(home = appHome()) {
  try { fs.unlinkSync(statePath(home)); } catch { /* 已经不在了 */ }
}

/* ─────────────────────────── 单实例锁 ───────────────────────────
 * 为什么不能只靠 instance.json 判断"有没有在跑"：
 *   端口要等 listen 之后才知道，所以状态文件只能在**启动完成之后**写。
 *   于是两个几乎同时的启动会都看到"没有状态文件"→ 都去启动 → 两个服务、两个端口。
 *   （实测：快速双击两次会起两份，第二份还会把状态文件覆盖掉。）
 *
 * 解法：在**做任何事之前**用一个原子操作抢锁文件（open 'wx' 存在即失败），
 * 谁抢到谁负责启动，另一个直接复用抢到的那份。
 */

export function lockPath(home = appHome()) {
  return path.join(home, 'instance.lock');
}

function readLock(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && Number.isInteger(obj.pid) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 抢实例锁。成功返回 { ok: true }，失败返回 { ok: false, holder }。
 *
 * 持锁进程已死（崩溃/被强杀）时允许接管，否则崩一次就再也起不来了。
 */
export function acquireInstanceLock(home = appHome()) {
  fs.mkdirSync(home, { recursive: true });
  const file = lockPath(home);
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });

  try {
    const fd = fs.openSync(file, 'wx');   // ← 原子：文件已存在就抛 EEXIST
    try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
    return { ok: true, file, tookOver: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = readLock(file);
    if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) {
      return { ok: false, holder, file };
    }
    // 持锁者已经不在了（或锁文件坏了）：接管
    try { fs.writeFileSync(file, payload, 'utf8'); } catch { /* 写不进去也先跑起来 */ }
    return { ok: true, file, tookOver: true };
  }
}

/** 释放锁；只删属于自己的那份，别把刚接管的人踢掉。 */
export function releaseInstanceLock(home = appHome()) {
  const file = lockPath(home);
  const holder = readLock(file);
  if (holder && holder.pid !== process.pid) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * 等一个**活着的**实例把状态文件写出来（拿端口用）。
 *
 * 抢锁失败的一方需要这个：对方刚抢到锁、还没 listen 完，此时读状态文件是空的，
 * 直接退出会让人以为"点了没反应"。
 */
export async function waitForState(home = appHome(), { timeoutMs = 8000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readState(home);
    if (st && isPidAlive(st.pid)) return st;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** 进程是否还活着。kill(pid, 0) 不发信号，只探活。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在，但没权限（也说明活着）
    return err && err.code === 'EPERM';
  }
}

/** 探一下某个端口上是不是我们的服务（返回 true 说明可以复用） */
export async function probe(port, { host = '127.0.0.1', timeoutMs = 1500, ns = 'dsh-local-memory' } = {}) {
  if (!Number.isInteger(port) || port <= 0) return false;
  const url = `http://${host}:${port}/${ns}/state`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 找一个**活着且可用**的已有实例。
 * 只看状态文件不够——进程可能已崩、端口可能被别人占了。
 */
export async function findLive(home = appHome(), opts = {}) {
  const st = readState(home);
  if (!st) return null;
  if (!isPidAlive(st.pid)) return null;
  if (!(await probe(st.port, opts))) return null;
  return st;
}

/**
 * 生命周期看门狗。
 *
 * 规则（主人定的）：
 *   - 有 parentPid（DSH 拉起）：parent 活着就永不退出；
 *     parent 消失后，若连续 `idleMs` 没有请求 → 退出。
 *   - 无 parentPid（用户手动双击）：没有外部父亲，同样按"连续 idleMs 无请求"退出。
 *
 * 为什么用"无请求"而不是"进程存活时间"：UI 打开时会轮询，用户在看就一直活着；
 * 关掉页面又不理它，10 分钟就自己收了。
 *
 * @returns {{ touch: () => void, stop: () => void }}
 */
export function startWatchdog({ parentPid = 0, idleMs = 10 * 60 * 1000, intervalMs = 15000, onExit, log = () => {} } = {}) {
  let lastRequestAt = Date.now();
  let parentGoneAt = 0;
  const timer = setInterval(async () => {
    try {
      const now = Date.now();
      if (parentPid > 0) {
        if (isPidAlive(parentPid)) { parentGoneAt = 0; return; }
        if (parentGoneAt === 0) { parentGoneAt = now; log('上游进程已退出，开始计时'); return; }
      }
      // idleMs <= 0 = **永不自动退出**。
      // 用户自己双击图标打开的实例不该被"闲置计时"杀掉——他会离开一会儿再回来，
      // 那时窗口还在，而不是一个"连接被拒绝"。只有插件拉起的临时实例才需要自动收
      // （那类实例带 --parent-pid，DSH 关掉后由下面那段逻辑收尾）。
      if (!(idleMs > 0)) return;
      const idleFor = now - lastRequestAt;
      if (idleFor >= idleMs) {
        log(`已闲置 ${Math.round(idleFor / 1000)} 秒，自动退出`);
        clearInterval(timer);
        await onExit?.('idle');
      }
    } catch { /* 看门狗自己不许抛 */ }
  }, intervalMs);
  timer.unref?.();
  return {
    touch: () => { lastRequestAt = Date.now(); },
    stop: () => clearInterval(timer),
  };
}
