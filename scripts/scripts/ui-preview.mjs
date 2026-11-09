#!/usr/bin/env node
/**
 * 界面离线预览：把**真组件**渲染成可截图的 HTML。
 *
 * 为什么需要它：插件没装进宿主，真界面点不到。但界面长什么样必须能看见——
 * 否则"设计对不对"只能靠想象。
 *
 * 做法：
 *   - 不重画 HTML，而是用一份最小渲染器（mini-react）跑 src/client/index.js 里同一份组件代码
 *   - 数据是真实记忆库里抽出来的（临时 DSH_HOME 迁移，绝不碰真库）
 *   - 样式直接取 bundle 里的 CSS 常量
 *
 * 诚实的局限：
 *   - 渲染器不是 React 本体（只实现了 useState/useRef/useCallback/useEffect 的一次性执行）
 *   - 因此没有交互：点击、拖拽、canvas 动画都看不到真实效果
 *   - 关系图用的是同一套布局算法算出来的 SVG 快照（真界面是 canvas + 可拖拽）
 *
 * 用法：node scripts/ui-preview.mjs [--out 目录]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ── 取真组件与真样式 ── */
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
globalThis.document = undefined;
await import('../src/client/index.js');
const reactStub = {
  createElement: () => null,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};
const client = captured.factory((n) => (n === 'react' ? reactStub : (() => { throw new Error('unexpected ' + n); })()));
const { CSS, components } = client.__internals;

/* ── 真实数据（临时 DSH_HOME） ── */
const v1 = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'dsh-local-memory.json');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ui-'));
if (fs.existsSync(v1)) fs.copyFileSync(v1, path.join(home, 'dsh-local-memory.json'));
process.env.DSH_HOME = home;

const { openStore, migrateFromV1 } = await import('../src/core/index.js');
const { defaultDbFile } = await import('../src/host/config.js');
const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
if (fs.existsSync(path.join(home, 'dsh-local-memory.json'))) {
  migrateFromV1(store, JSON.parse(fs.readFileSync(path.join(home, 'dsh-local-memory.json'), 'utf8')));
}
const all = store.list({ limit: 200 });
const unknown = all.filter((r) => r.kind === 'unknown');
const stats = store.stats();
store.close();

/* ── mini-react：只为"把静态界面渲染出来"服务 ── */
const MINI_REACT = `
const HOOKS = new Map();
let key = null, cursor = 0, queue = [], scheduled = false, rootEl = null, rootType = null;

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2).flat(Infinity);
  return { type: type, props: Object.assign({}, props || {}, { children: children }) };
}
function slot() {
  if (!HOOKS.has(key)) HOOKS.set(key, []);
  return HOOKS.get(key);
}
function useState(init) {
  const arr = slot(); const i = cursor++;
  if (!(i in arr)) arr[i] = typeof init === 'function' ? init() : init;
  const set = (v) => { arr[i] = typeof v === 'function' ? v(arr[i]) : v; schedule(); };
  return [arr[i], set];
}
function useRef(v) { const arr = slot(); const i = cursor++; if (!(i in arr)) arr[i] = { current: v }; return arr[i]; }
function useCallback(fn) { const arr = slot(); const i = cursor++; if (!(i in arr)) arr[i] = fn; return arr[i]; }
function useEffect(fn) { const arr = slot(); const i = cursor++; if (!(i in arr)) { arr[i] = 1; queue.push(fn); } }

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return document.createTextNode('');
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
  if (Array.isArray(node)) {
    const frag = document.createDocumentFragment();
    node.forEach((n) => frag.appendChild(render(n)));
    return frag;
  }
  if (typeof node.type === 'function') {
    const prevKey = key, prevCursor = cursor;
    key = node.type; cursor = 0;
    const out = node.type(node.props);
    key = prevKey; cursor = prevCursor;
    return render(out);
  }
  const el = document.createElement(node.type);
  const props = node.props || {};
  for (const k in props) {
    if (k === 'children') continue;
    const v = props[k];
    if (v === undefined || v === null) continue;
    if (k === 'className') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'key' || k.startsWith('on')) continue;
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, String(v));
  }
  const kids = props.children || [];
  kids.forEach((c) => el.appendChild(render(c)));
  return el;
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; paint(); });
}
function paint() {
  const prevKey = key, prevCursor = cursor;
  key = rootType; cursor = 0;
  const vdom = rootType({});
  key = prevKey; cursor = prevCursor;
  rootEl.innerHTML = '';
  rootEl.appendChild(render(vdom));
  const q = queue; queue = [];
  q.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
}
function mount(type, el) { rootEl = el; rootType = type; paint(); }

const React = { createElement: h, useState, useEffect, useRef, useCallback };
`;

/* ── 页面骨架 ── */
const TABS = [
  { key: 'graph', label: '关系图' },
  { key: 'list', label: '记忆列表' },
  { key: 'classify', label: '补标' },
];

function tabStrip(active) {
  return '<div class="__lm2_tabs">' + TABS.map((t) => (
    '<button class="__lm2_tab' + (t.key === active ? ' __lm2_tab--on' : '') + '">' + t.label + '</button>'
  )).join('') + '</div>';
}

function page({ title, tab, note, dataScript, mountScript, appHtml }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  html,body { margin:0; background:#14161a; color:#e6e8eb; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .frame { max-width:1080px; margin:0 auto; padding:22px 24px 30px; }
  .chrome { display:flex; gap:6px; align-items:center; margin-bottom:14px; }
  .dot { width:9px; height:9px; border-radius:50%; background:#3a3f47; }
  .route { margin-left:8px; font-size:12px; color:#8a8f98; font-family:ui-monospace,Consolas,monospace; }
  .card { background:#1b1e24; border:1px solid rgba(128,128,128,.20); border-radius:10px; padding:14px 16px; }
  .note { font-size:12px; color:#8a8f98; margin:10px 2px 0; line-height:1.7; }
  svg { width:100%; height:auto; border-radius:8px; }
  ${CSS}
</style></head>
<body><div class="frame">
  <div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    <span class="route">设置 → 本地记忆</span></div>
  <div class="card">
    ${tabStrip(tab)}
    <div id="app" style="margin-top:12px">${appHtml || ''}</div>
  </div>
  <div class="note">${note}</div>
</div>
<script>${MINI_REACT}</script>
<script>${dataScript || ''}</script>
<script>
  window.__ModuleLoader__ = { load: function (spec) { window.__captured = spec; } };
  window.require = function (n) { if (n === 'react') return React; throw new Error('no module ' + n); };
</script>
<script src="bundle.js"></script>
<script>${mountScript || ''}</script>
</body></html>`;
}

/** 把 bundle 源码里的 window.__ModuleLoader__.load 形态原样搬进页面 */
const bundleSrc = fs.readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');

const outIdx = process.argv.slice(2).indexOf('--out');
const outDir = outIdx >= 0
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : path.resolve('..', '_scratch', 'ui');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'bundle.js'), bundleSrc, 'utf8');

/** 每个页面都要的 mock fetch：把真数据当接口响应喂给组件 */
function mockScript(payload) {
  return `
const DATA = ${JSON.stringify(payload)};
window.fetch = function (url) {
  const u = String(url);
  let body = { ok: true };
  if (u.includes('/state')) body = { ok: true, stats: DATA.stats, config: {} };
  else if (u.includes('/memories')) {
    const isUnknown = u.includes('kind=unknown');
    body = { ok: true, total: DATA.total, memories: isUnknown ? DATA.unknown : DATA.recent };
  }
  return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(JSON.stringify(body)); } });
};
`;
}

const payload = {
  stats,
  total: stats.total,
  recent: all.slice(0, 6),
  unknown: unknown.slice(0, 4),
};

const mounts = {
  list: `mount(window.__captured.factory(require).__internals.components.ListTab, document.getElementById('app'));`,
  classify: `mount(window.__captured.factory(require).__internals.components.ClassifyTab, document.getElementById('app'));`,
};

const notes = {
  graph: '[关系图] 同一套布局算法算出的 SVG 快照（真界面是 canvas，可拖拽/缩放/点选）。'
    + '这里只是让"图长什么样"能看见，交互没有。',
  list: '[记忆列表] 真组件 + 真数据（最近 6 条），正文在 JS 侧截断 160 字。'
    + '渲染器是离线用的最小实现，按钮点击无效；真实交互要在宿主里跑。',
  classify: '[补标] 真组件 + 真未分类数据（4 条）。正文默认截到 220 字，可展开全文；'
    + '顶部"还有 N 条未分类"是真实统计。',
};

// ── 关系图页：SVG 快照 + 右侧说明栏（真界面里默认就显示这块）
const svgPath = path.resolve('..', '_scratch', 'graph-preview.svg');
let graphSvg = '<div class="__lm2_hint">（还没生成关系图快照，先跑 scripts/graph-preview.mjs）</div>';
if (fs.existsSync(svgPath)) {
  graphSvg = fs.readFileSync(svgPath, 'utf8').replace(/<\?xml[^>]*\?>/, '');
}

const graphHtml = `
  <div class="__lm2_bar" style="margin-bottom:8px">
    <input class="__lm2_input" style="width:220px" placeholder="高亮包含…（正文或标签）" />
    <button class="__lm2_btn">孤岛视图：关</button>
    <button class="__lm2_btn">刷新</button>
    <button class="__lm2_btn">重新布局</button>
    <button class="__lm2_btn">适应窗口</button>
    <span class="__lm2_stat">点 74 · 边 283 · 孤岛 10</span>
  </div>
  <div class="__lm2_graphWrap">
    <div class="__lm2_canvasBox" style="min-height:0">${graphSvg}</div>
    <div class="__lm2_side">
      <div class="__lm2_sideTitle">怎么读这张图</div>
      <div class="__lm2_hint">
        点：一条记忆，颜色＝类别，大小＝连接数。<br/>
        边：只画确定性关系——共现（被一起用过）、共享标签、同项目、创建时间相邻。<br/><br/>
        红圈虚线：孤岛，没有任何语义关系，通常意味着"写了但没人用"。<br/><br/>
        滚轮缩放，拖空白处平移，拖节点可以手动摆位置。
      </div>
    </div>
  </div>`;

fs.writeFileSync(path.join(outDir, 'graph.html'), page({
  title: '关系图', tab: 'graph', note: notes.graph, appHtml: graphHtml,
}), 'utf8');

for (const name of ['list', 'classify']) {
  fs.writeFileSync(path.join(outDir, name + '.html'), page({
    title: name === 'list' ? '记忆列表' : '补标',
    tab: name,
    note: notes[name],
    dataScript: mockScript(payload),
    mountScript: mounts[name],
  }), 'utf8');
}

console.log('数据：总', stats.total, '条 / 未分类', unknown.length, '条');
console.log('输出目录：', outDir);
console.log('页面：', ['graph.html', 'list.html', 'classify.html'].join(', '));;
