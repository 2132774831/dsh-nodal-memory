#!/usr/bin/env node
/**
 * 独立版记忆软件（不依赖 DeepSeek Harness）。
 *
 * 做法很省事也很稳：插件那套「宿主层」本来就是纯 Node 代码——它只要求 ctx 提供
 * tools / systemPrompt / on / effect / webServer 这几样东西。这里用**假宿主**满足它，
 * 于是同一份 API、同一套校验、同一套自动迁移逻辑，一行不用改就能在独立进程里跑。
 *
 * 关键安全点：启动时先把 `DSH_HOME` 指到本软件自己的数据目录，
 * 所以**永远不会读写 ~/.dsh 里的真实记忆库**。
 *
 * 用法：
 *   node app/server.mjs [--port 7787] [--data <目录>] [--seed <v1.json>] [--host 127.0.0.1]
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, '..');

function parseArgs(argv) {
  const out = { port: 7787, host: '127.0.0.1', data: path.join(APP_DIR, 'data'), seed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data') out.data = path.resolve(argv[++i]);
    else if (a === '--seed') {
      // `--seed` 后面没跟值（或跟了另一个参数）时用默认路径：
      // 从批处理里传带空格的绝对路径要套两层引号，很容易传坏，这里用哨兵避开。
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out.seed = 'default';
      else out.seed = path.resolve(argv[++i]);
    }
    else if (a === '--open') out.open = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 只允许读取指定根目录下的文件，杜绝 ../ 穿越 */
function safeJoin(rootDir, relPath) {
  const target = path.resolve(rootDir, '.' + path.sep + relPath);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (target !== rootDir && !target.startsWith(rootWithSep)) return null;
  return target;
}

/**
 * 起服务。导出出来是为了让测试能拿到 http://127.0.0.1:<随机端口> 真打一遍。
 */
export async function startServer(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  const dataDir = opts.data;

  // ── 关键：先把数据目录钉死，再加载宿主层（它读 DSH_HOME 决定库路径）
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DSH_HOME = dataDir;

  // ── 可选：把 v1 的 JSON 库塞进来（首次启动会自动迁移成 SQLite）
  // 种子导入是**尽力而为**：失败了只提示，不能因此让软件起不来。
  let seedPath = opts.seed;
  if (seedPath === 'default') seedPath = path.join(os.homedir(), '.dsh', 'dsh-local-memory.json');
  const v1Target = path.join(dataDir, 'dsh-local-memory.json');
  let seeded = false;
  let seedNote = null;
  if (seedPath && !fs.existsSync(v1Target)) {
    try {
      if (!fs.existsSync(seedPath)) {
        seedNote = '没找到要导入的旧库，跳过：' + seedPath;
      } else if (fs.statSync(seedPath).isDirectory()) {
        seedNote = '种子路径是个目录，跳过：' + seedPath;
      } else {
        fs.copyFileSync(seedPath, v1Target);
        seeded = true;
      }
    } catch (err) {
      seedNote = '导入旧库失败（不影响启动）：' + String((err && err.message) || err);
    }
  }

  // ── 用假宿主把插件层挂起来，捕获它的 HTTP 处理器
  const { apply } = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'index.js')).href);

  let apiHandler = null;
  /** 收集插件注册的清理函数：退出时要真的关掉数据库连接，否则 .db-wal 会一直开着 */
  const disposers = [];
  const fakeCtx = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    // 独立软件没有浏览器的同源/跨站问题：只监听 127.0.0.1，本机才能访问
    get: () => undefined,
    webServer: { register: (spec) => { apiHandler = spec.handler; return () => {}; } },
  };
  apply(fakeCtx);
  if (!apiHandler) throw new Error('宿主层没有注册 HTTP 路由，无法启动');

  const UI_DIR = path.join(APP_DIR, 'ui');
  const CORE_DIR = path.join(ROOT, 'src', 'core');

  const server = http.createServer((req, res) => {
    // ⚠ 这两个监听器看着没用，其实是保命的：
    // 浏览器切页签/刷新会取消未完成的请求，服务器再往这个 socket 写就会发 EPIPE。
    // socket 的 'error' 事件没人接 → Node 当未捕获异常 → **整个进程直接退出**。
    // 表现就是"用着用着页面全变读取失败"，而命令行窗口里一行日志都没有。
    req.on('error', () => {});
    res.on('error', () => {});

    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500');
      } catch { /* socket 已经没了，忽略 */ }
    });
  });

  // 协议层解析失败（畸形请求）同样只应该断开这条连接
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 忽略 */ }
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // 1) API
    if (pathname === '/dsh-local-memory' || pathname.startsWith('/dsh-local-memory/')) {
      return apiHandler(req, res);
    }

    // 2) 内核算法（浏览器直接 import，用于关系图布局）
    if (pathname.startsWith('/core/')) {
      const file = safeJoin(CORE_DIR, pathname.slice('/core/'.length));
      return serveFile(res, file, { allowOnly: ['.js', '.mjs'] });
    }

    // 3) 界面静态文件
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(UI_DIR, 'index.html'));
    }
    const uiFile = safeJoin(UI_DIR, pathname.slice(1));
    if (uiFile && fs.existsSync(uiFile) && fs.statSync(uiFile).isFile()) {
      return serveFile(res, uiFile);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }

  const port = await listen(server, opts.port, opts.host);
  const url = `http://${opts.host}:${port}`;

  return {
    url,
    port,
    dataDir,
    seeded,
    server,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      // 关掉监听之后再释放插件资源（数据库连接）。顺序反了会有请求打到已关闭的库上。
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 逐个清理，互不影响 */ }
      }
      disposers.length = 0;
    },
  };
}

function serveFile(res, file, { allowOnly } = {}) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  if (allowOnly && !allowOnly.includes(ext)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 端口被占用时自动往后试，别让用户看到 EADDRINUSE。返回**实际**监听到的端口（port=0 时由系统分配）。 */
async function listen(server, port, host, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const tryPort = port + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(tryPort, host);
      });
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : tryPort;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error('端口 ' + port + ' 起连续 ' + attempts + ' 个都被占用');
}

/** 用系统默认浏览器打开（失败就算了，不影响服务） */
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* 忽略 */ }
}

/* ── CLI 入口 ── */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`记忆软件（独立版）

  node app/server.mjs [选项]

  --port <数字>   监听端口，默认 7787（被占用会自动往后试）
  --host <地址>   监听地址，默认 127.0.0.1（只允许本机访问）
  --data <目录>   数据目录，默认 app/data
  --seed <文件>   首次启动时把这份 v1 JSON 库复制进来（会自动迁移成 SQLite）

启动后浏览器打开打印出来的地址即可。数据只存在 --data 指向的目录里。`);
    process.exit(0);
  }

  const app = await startServer(opts);
  console.log('');
  console.log('  记忆软件已启动');
  console.log('  ─────────────────────────────');
  console.log('  地址：' + app.url);
  console.log('  数据：' + app.dataDir);
  if (app.seeded) console.log('  已导入种子库（首访会自动迁移）');
  console.log('');
  console.log('  按 Ctrl+C 停止。数据只写在上面的数据目录里。');
  console.log('');

  // 常驻服务不能因为一个异步错误就整个退出：记日志，继续服务
  process.on('unhandledRejection', (err) => {
    console.error('[未处理的异步错误，已忽略]', err && err.message ? err.message : err);
  });
  process.on('uncaughtException', (err) => {
    // EPERM/EPIPE 这类来自已关闭 socket 的错误，只影响那一个请求
    const code = err && err.code;
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') return;
    console.error('[未捕获的异常，已忽略]', err && err.message ? err.message : err);
  });

  if (opts.open) openBrowser(app.url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('正在关闭…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
