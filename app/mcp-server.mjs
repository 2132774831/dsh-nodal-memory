#!/usr/bin/env node
/**
 * 本地记忆 · MCP 服务器（stdio）
 *
 * 给**不用 DSH** 的 agent 用（Kun、Claude Desktop、Cline…）。
 *
 * 为什么走 stdio 而不是复用那个 HTTP 接口：
 *   1. 不用先打开图形界面，agent 自己就能连库
 *   2. 不占端口，不会出现"7787 被别的进程占用"
 *   3. 各家 MCP 客户端配一行 command+args 就能用，不需要装额外依赖
 *
 * 它直接用 src/core 里那套代码读写同一个 SQLite 库
 * （~/.dsh/dsh-local-memory.db），和插件、独立软件是**同一份数据**。
 *
 * 协议：MCP 的 stdio 传输 = 每行一个 JSON-RPC 2.0 消息。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const { openStore } = await import('file:///' + path.join(PKG_ROOT, 'src', 'core', 'index.js'));
const { search } = await import('file:///' + path.join(PKG_ROOT, 'src', 'core', 'search.js'));

const SERVER_INFO = { name: 'dsh-local-memory', version: '1.0.0' };
const PROTOCOL = '2024-11-05';

/** 库和配置的位置：优先环境变量，其次 ~/.dsh（和插件、独立软件一致） */
function dataHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
}

let store = null;
function db() {
  if (store) return store;
  store = openStore({ home: dataHome() });
  return store;
}

const TOOLS = [
  {
    name: 'memory_search',
    description: '在本地长期记忆里检索。中文按二元组匹配，搜两个字也能命中。返回相关记忆（含时间、类别、id）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词。可以是关键词或一句话。' },
        limit: { type: 'number', description: '返回条数，默认 5，最多 20。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_save',
    description: '保存一条值得长期记住的信息。用户明确要求记住、或你判断跨会话仍有用时使用。不要保存凭据和临时状态。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容，写成一句能独立读懂的话。' },
        kind: { type: 'string', enum: ['work', 'preference', 'emotion', 'unknown'], description: '类别，默认 unknown。' },
        importance: { type: 'string', enum: ['key', 'important', 'casual', 'transient'], description: '重要度，默认 important。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签。' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_list',
    description: '按时间倒序列出最近的记忆，用于回顾。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '条数，默认 20，最多 100。' } },
    },
  },
  {
    name: 'memory_update',
    description: '给一条已有记忆追加"后续进展"，原内容不改、历史保留。用于事情有了新变化。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id。' },
        text: { type: 'string', description: '这次的新进展，一句话。' },
      },
      required: ['id', 'text'],
    },
  },
];

function fmtRecord(r) {
  const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '时间未知';
  return `[${when}] (${r.kind || 'unknown'}) ${r.content}\n  id=${r.id}`;
}

function callTool(name, args = {}) {
  const s = db();
  if (name === 'memory_search') {
    const hits = search(s, String(args.query || ''), { limit: Math.min(20, Math.max(1, Number(args.limit) || 5)) });
    if (!hits.length) return { content: [{ type: 'text', text: '没有找到相关记忆。' }] };
    return { content: [{ type: 'text', text: hits.map((h) => fmtRecord(h.record)).join('\n\n') }] };
  }
  if (name === 'memory_save') {
    const rec = s.put({
      content: String(args.content || '').trim(),
      kind: args.kind || 'unknown',
      importance: args.importance || 'important',
      tags: args.tags || [],
    });
    return { content: [{ type: 'text', text: '已记住。id=' + rec.id }] };
  }
  if (name === 'memory_list') {
    const rows = s.list({ limit: Math.min(100, Math.max(1, Number(args.limit) || 20)) });
    if (!rows.length) return { content: [{ type: 'text', text: '库里还没有记忆。' }] };
    return { content: [{ type: 'text', text: rows.map(fmtRecord).join('\n\n') }] };
  }
  if (name === 'memory_update') {
    const id = String(args.id || '');
    if (!s.get(id)) return { content: [{ type: 'text', text: '没找到这条记忆：' + id }], isError: true };
    s.addUpdate(id, { text: String(args.text || '') });
    return { content: [{ type: 'text', text: '已追加进展。' }] };
  }
  return { content: [{ type: 'text', text: '未知工具：' + name }], isError: true };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    try {
      return { jsonrpc: '2.0', id, result: callTool(params?.name, params?.arguments) };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '出错：' + err.message }], isError: true } };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  // 通知类消息（没有 id）不需要回
  if (id === undefined || id === null) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

// ── stdio 主循环：一行一条 JSON ──
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const out = handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }
});
process.stdin.on('end', () => { try { store?.close(); } catch { /* ignore */ } process.exit(0); });

process.on('uncaughtException', (e) => {
  process.stderr.write('[local-memory-mcp] ' + (e && e.message) + '\n');
});
