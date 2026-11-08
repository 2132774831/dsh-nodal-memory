#!/usr/bin/env node
/**
 * 把真实记忆库渲染成一张 SVG 关系图，方便"不装插件也能先看一眼"。
 *
 * 诚实说明：
 *   - 布局用的是 src/client/index.js 里同一套 createLayout/stepLayout（导入同一个 bundle，
 *     走 exports.__internals，不是另写一份）
 *   - 颜色/线宽取自同一组常量（KIND_COLORS / EDGE_STYLES）
 *   - 但渲染器不同：这里是 SVG，真界面是 canvas。SVG 只是给眼睛看的快照，
 *     交互（拖拽/缩放/悬停）只有真界面才有。
 *
 * 用法：node scripts/graph-preview.mjs [--out 路径]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ── 用假 ModuleLoader 把浏览器 bundle 的纯函数拿出来 ── */
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
globalThis.document = undefined;
await import('../src/client/index.js');
const reactStub = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), useCallback: (fn) => fn };
const client = captured.factory((n) => (n === 'react' ? reactStub : (() => { throw new Error('unexpected ' + n); })()));
const { createLayout, stepLayout, isSettled, bounds, kindColor, edgeStyle, KIND_COLORS, EDGE_STYLES } = client.__internals;

/* ── 在临时 DSH_HOME 里迁移真实库并算图 ── */
const v1 = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'dsh-local-memory.json');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-preview-'));
if (fs.existsSync(v1)) fs.copyFileSync(v1, path.join(home, 'dsh-local-memory.json'));
process.env.DSH_HOME = home;

const { openStore, migrateFromV1, buildGraph } = await import('../src/core/index.js');
const { defaultDbFile } = await import('../src/host/config.js');

const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
if (fs.existsSync(path.join(home, 'dsh-local-memory.json'))) {
  migrateFromV1(store, JSON.parse(fs.readFileSync(path.join(home, 'dsh-local-memory.json'), 'utf8')));
}
const records = store.list({ limit: 100000 });
const cooccur = typeof store.cooccurPairs === 'function' ? store.cooccurPairs({ minCount: 1 }) : [];
const graph = buildGraph(records, { cooccur });
store.close();

/* ── 布局收敛 ── */
const L = createLayout(graph.nodes, graph.edges);
L.nodes = graph.nodes;
L.edges = graph.edges;
let steps = 0;
while (!isSettled(L) && steps < 4000) { stepLayout(L); steps++; }

const b = bounds(L);
const pad = 70;
const vbW = Math.max(400, b.maxX - b.minX + pad * 2);
const vbH = Math.max(400, b.maxY - b.minY + pad * 2);
const ox = pad - b.minX;
const oy = pad - b.minY;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW.toFixed(0)} ${vbH.toFixed(0)}" width="${vbW.toFixed(0)}" height="${vbH.toFixed(0)}" font-family="system-ui,sans-serif">`);
parts.push(`<rect width="100%" height="100%" fill="#14161a"/>`);
parts.push(`<text x="20" y="28" fill="#e6e8eb" font-size="16" font-weight="600">本地记忆关系图</text>`);
parts.push(`<text x="20" y="48" fill="#8a8f98" font-size="12">点 ${graph.stats.nodes} · 边 ${graph.stats.edges} · 孤岛 ${graph.stats.isolated} · 布局 ${steps} 步</text>`);

// 边
for (const e of graph.edges) {
  const i = L.ids.get(e.source);
  const j = L.ids.get(e.target);
  if (i === undefined || j === undefined) continue;
  const st = edgeStyle(e.kind);
  const dash = st.dash ? ` stroke-dasharray="${st.dash.join(' ')}"` : '';
  parts.push(`<line x1="${(L.px[i] + ox).toFixed(1)}" y1="${(L.py[i] + oy).toFixed(1)}" x2="${(L.px[j] + ox).toFixed(1)}" y2="${(L.py[j] + oy).toFixed(1)}" stroke="${st.color}" stroke-width="${st.width}"${dash}/>`);
}

// 点
// 标签只给"连接最多"的前 12 个：全都标的话，密集区会糊成一团黑，
// 反而看不出结构。孤岛一个都不标——它们本来就是靠位置和红圈辨认的。
// 再加一层贪心防重叠：已经放过标签的区域不再压字。
const labelIds = new Set(
  [...graph.nodes].sort((a, b) => (b.linkDegree || 0) - (a.linkDegree || 0)).slice(0, 12).map((n) => n.id),
);
const placedLabels = [];

function labelFits(x, y, text) {
  const w = text.length * 10 + 8;
  const rect = { x, y: y - 11, w, h: 14 };
  for (const r of placedLabels) {
    if (!(rect.x + rect.w < r.x || rect.x > r.x + r.w || rect.y + rect.h < r.y || rect.y > r.y + r.h)) return false;
  }
  placedLabels.push(rect);
  return true;
}

for (let i = 0; i < L.count; i++) {
  const node = graph.nodes[i];
  const x = L.px[i] + ox;
  const y = L.py[i] + oy;
  const r = Math.max(4, Math.min(12, 4 + Math.log1p(node.degree || 0) * 1.8));
  const ring = node.isolated
    ? ` stroke="#d9534f" stroke-width="1.4" stroke-dasharray="2 2"`
    : ' stroke="none"';
  parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${kindColor(node.kind)}"${ring}/>`);
  if (labelIds.has(node.id)) {
    const text = node.label.slice(0, 14);
    if (labelFits(x + r + 4, y + 3, text)) {
      // 描边底衬：亮色文字压在密集连线之上时，没有底衬根本读不清
      parts.push(`<text x="${(x + r + 4).toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="#d7dae0" font-size="10" stroke="#14161a" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${esc(text)}</text>`);
    }
  }
}

// 图例
let lx = 20;
const ly = vbH - 20;
for (const [k, st] of Object.entries(EDGE_STYLES)) {
  parts.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 18}" y2="${ly}" stroke="${st.color}" stroke-width="${st.width}"/>`);
  parts.push(`<text x="${lx + 23}" y="${ly + 4}" fill="#9aa0a8" font-size="11">${st.label}</text>`);
  lx += 86;
}
for (const [k, color] of Object.entries(KIND_COLORS)) {
  parts.push(`<circle cx="${lx + 5}" cy="${ly}" r="5" fill="${color}"/>`);
  parts.push(`<text x="${lx + 14}" y="${ly + 4}" fill="#9aa0a8" font-size="11">${({ work: '工作', preference: '偏好', emotion: '情感', unknown: '未分类' })[k] || k}</text>`);
  lx += 66;
}
parts.push('</svg>');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.resolve('..', '_scratch', 'graph-preview.svg');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, parts.join('\n'), 'utf8');

console.log('点 / 边 / 孤岛 :', graph.stats.nodes, '/', graph.stats.edges, '/', graph.stats.isolated);
const kindTally = {};
for (const n of graph.nodes) kindTally[n.kind] = (kindTally[n.kind] || 0) + 1;
console.log('类别分布       :', JSON.stringify(kindTally));
const impTally = {};
for (const n of graph.nodes) impTally[n.importance] = (impTally[n.importance] || 0) + 1;
console.log('重要度分布     :', JSON.stringify(impTally));
console.log('布局步数       :', steps, '（alpha 收敛到', L.alpha.toFixed(4) + '）');
console.log('画布           :', vbW.toFixed(0), 'x', vbH.toFixed(0));
console.log('SVG 元素       :', parts.length - 4, '个');
console.log('输出           :', out);
