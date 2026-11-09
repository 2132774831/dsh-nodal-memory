/**
 * 把"独立应用"接进插件：需要时把它拉起来，然后让浏览器跳过去。
 *
 * 为什么插件只做这一件事（不在插件里重画界面）：
 *   关系图/卡片视图/直觉/设置这些重交互只维护一份，放在独立应用里。
 *   插件这边只留"数据接口 + 一个跳转"，加功能时不用改两处。
 *
 * 关键取舍：
 *   - 用 `process.execPath` 拉起，并设 ELECTRON_RUN_AS_NODE=1 —— 在 DSH 里它就是
 *     Harness.exe 自带的那套 Node（24.x，有 node:sqlite），**用户不需要装 Node**。
 *   - `--parent-pid` 传自己：DSH 退出后应用会进入倒计时并自己收掉，不留孤儿进程。
 *   - 拉起失败不抛错：工具照常能用（记忆是进程内直接读写的），只是界面打不开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appHome, defaultDataDir, findLive } from '../../app/instance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 独立应用的服务入口（仓库根目录下的 app/server.mjs） */
export const APP_SERVER_PATH = path.resolve(HERE, '..', '..', 'app', 'server.mjs');

export function appServerAvailable() {
  try { return fs.existsSync(APP_SERVER_PATH); } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保独立应用在跑，返回它的地址。
 *
 * @returns {Promise<{ok: true, url: string, port: number, reused: boolean} | {ok: false, error: string}>}
 */
export async function ensureAppRunning({
  timeoutMs = 15000,
  pollMs = 200,
  idleMin = 10,
  log = () => {},
} = {}) {
  const home = appHome();

  // 1) 已经有一个活着的实例（用户手动开过，或者别的会话拉过）——直接复用
  const live = await findLive(home);
  if (live) return { ok: true, url: live.url, port: live.port, reused: true };

  if (!appServerAvailable()) {
    return { ok: false, error: '没有找到独立应用（app/server.mjs 不存在）' };
  }

  // 2) 拉起一个。--port 0 让系统分配，避免和别的东西抢 7787
  const args = [
    APP_SERVER_PATH,
    '--port', '0',
    '--host', '127.0.0.1',
    '--state', home,
    '--data', defaultDataDir(),
    '--parent-pid', String(process.pid),
    '--idle-min', String(idleMin),
  ];

  let child;
  try {
    child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: '拉不起来：' + (err && err.message ? err.message : String(err)) };
  }
  child.on('error', (err) => log('拉起独立应用失败：' + (err && err.message ? err.message : err)));
  child.unref();

  // 3) 等它把状态文件写出来（同时 probe 端口，双保险）
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = await findLive(home, { timeoutMs: 1000 });
    if (st) return { ok: true, url: st.url, port: st.port, reused: false };
    // 子进程已经死了就别傻等
    if (child.exitCode !== null && child.exitCode !== undefined && child.exitCode !== 0) {
      return { ok: false, error: '独立应用启动后立刻退出（code=' + child.exitCode + '）' };
    }
  }
  return { ok: false, error: '启动超时（' + timeoutMs + 'ms 内没等到服务就绪）' };
}
