/**
 * 独立版记忆软件 · 界面（原生 DOM，零依赖，无构建）
 *
 * 关系图布局从 ./core/graph-layout.js 以 ESM 引入（相对路径：插件和独立软件两种挂载都能用）——和单元测试用的是同一份代码。
 * 数据全部走本机 HTTP 接口（/dsh-local-memory/*），没有别的通道。
 */

import {
  createLayout, stepLayout, isSettled, bounds,
  kindColor, edgeStyle, KIND_COLORS, EDGE_STYLES,
} from './core/graph-layout.js';

const API = '/dsh-local-memory';

const KIND_LABELS = { work: '工作', preference: '偏好', emotion: '情感', unknown: '未分类' };
const IMPORTANCE_LABELS = { key: '关键', important: '重要', casual: '随口', transient: '易过期' };
const KIND_CHOICES = ['work', 'preference', 'emotion'];
const IMPORTANCE_CHOICES = ['key', 'important', 'casual', 'transient'];

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
let cleanup = null;
/** 关系图渲染模式，写进 URL（#graph/cards），刷新后保持不变 */
let graphMode = 'dots';

/* ── 小工具 ── */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 去掉 markdown 语法符号，只留文字（记忆是要读的事实，不是要排版的文章） */
function inlineText(input) {
  return String(input == null ? '' : input)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

function compact(input, max) {
  const text = inlineText(input);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function ageLabel(ms) {
  const days = (Date.now() - ms) / 86400000;
  if (days < 1) return '今天';
  if (days < 2) return '昨天';
  if (days < 7) return Math.floor(days) + ' 天前';
  if (days < 30) return Math.floor(days / 7) + ' 周前';
  if (days < 180) return Math.floor(days / 30) + ' 个月前';
  const d = new Date(ms);
  return d.getFullYear() + ' 年 ' + String(d.getMonth() + 1).padStart(2, '0') + ' 月';
}

/**
 * 每条记忆一个**稳定的身份色相**（由 id 哈希得出，不随运行变化）。
 *
 * 为什么要这个：卡片一多，所有连线都是同一种蓝，肉眼根本分不清"这根线从哪张卡出来"。
 * 用身份色给线上色（两端渐变）之后，看线色就知道它连的是哪张卡。
 */
function idHue(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 服务连不上时顶部挂一条醒目提示；一旦有请求成功就收起来 */
function setOffline(offline) {
  const bar = document.getElementById('offlineBar');
  if (bar) bar.hidden = !offline;
}

async function api(path, init) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: init && init.body ? { 'Content-Type': 'application/json' } : {},
      ...init,
    });
  } catch {
    // fetch 抛错只有一种原因：连不上。这条信息对使用者最有用——去那个命令行窗口看看服务还在不在。
    setOffline(true);
    throw new Error('连不上本地服务（服务似乎已停止，请检查命令行窗口）');
  }
  setOffline(false);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

let toastTimer = 0;
function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.className = 'toast' + (isError ? ' err' : '');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 5000 : 2200);
}

/* ── 顶栏信息 ── */

async function refreshMeta() {
  try {
    const s = await api('/state');
    const kinds = (s.stats.byKind || []).map((k) => (KIND_LABELS[k.kind] || k.kind) + ' ' + k.c).join(' · ');
    document.getElementById('appMeta').textContent =
      `${s.stats.total} 条 · ${s.backend} · ${kinds || '空库'}`
      + (s.maintenance && s.maintenance.lastAgoDays != null ? ` · 维护 ${s.maintenance.lastAgoDays} 天前` : '');
  } catch (err) {
    document.getElementById('appMeta').textContent = '读取失败：' + err.message;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 关系图
 * ══════════════════════════════════════════════════════════════════════ */

function renderGraph() {
  view.innerHTML = `
    <div class="bar">
      <input type="search" id="gFilter" placeholder="高亮包含…（正文或标签）" style="width:200px" maxlength="100" />
      <button class="btn" id="gMode" title="在「圆点图」和「工作流卡片图」之间切换">视图：圆点</button>
      <button class="btn btn--on" id="gSem" title="语义连线需要 embedding；关掉就不再为图查询花向量调用">语义：开</button>
      <button class="btn" id="gIsolated">孤岛视图：关</button>
      <button class="btn" id="gReload">刷新</button>
      <button class="btn" id="gReheat">重新布局</button>
      <button class="btn" id="gFit">适应窗口</button>
      <span class="stat" id="gStats">读取中…</span>
    </div>
    <div class="graphWrap">
      <div class="canvasBox" id="gBox">
        <canvas id="canvas"></canvas>
        <div class="legend" id="gLegend"></div>
      </div>
      <div class="side" id="gSide"></div>
    </div>`;

  const canvas = document.getElementById('canvas');
  const box = document.getElementById('gBox');
  const side = document.getElementById('gSide');
  const statsEl = document.getElementById('gStats');
  const filterEl = document.getElementById('gFilter');
  const isolatedBtn = document.getElementById('gIsolated');

  const ctx = canvas.getContext('2d');

  let nodes = [];
  let edges = [];
  let layout = null;
  let viewport = { scale: 1, x: 0, y: 0 };
  let selected = null;
  let hover = -1;
  let drag = null;
  let raf = 0;
  let stopped = false;
  let settledTold = false;
  /** 只有"画面确实变了"才重绘。布局收敛后还每帧重画，就是在空转烧 CPU */
  let needsDraw = true;
  /** 每个节点的邻居顺序表：用来给"同一个边上的多条线"分配不同的出线位置，避免全挤在中心一点 */
  let neighborIndex = new Map();
  let isolatedOnly = false;
  let filter = '';
  let mode = graphMode;       // 'dots' 圆点图 | 'cards' 工作流卡片图
  let semanticOn = true;      // 语义连线开关（关掉就不带向量，省查询）
  /** 疑似冲突的记忆 id：关系图上要给它们加黄圈 */
  let conflictIds = new Set();
  /** 联想表：id → [{id, sim}]，点/悬停某条时浮出"最像的几条" */
  let assocMap = new Map();
  /** 已有边的键集合（"a|b"），避免联想线和正式边在同一对上重复画 */
  let edgeKeys = new Set();

  /* 图例：两种视图的读法不一样，图例也跟着换 */
  const legendEl = document.getElementById('gLegend');
  function renderLegend() {
    if (!legendEl) return;
    const kindDots = Object.keys(KIND_COLORS).map((k) => (
      `<span><i class="dot" style="background:${KIND_COLORS[k]}"></i>${KIND_LABELS[k] || k}</span>`
    )).join('');
    if (mode === 'cards') {
      const lineKinds = Object.keys(EDGE_STYLES).map((k) => {
        const st = EDGE_STYLES[k];
        const bg = st.dash
          ? 'repeating-linear-gradient(90deg,#8a8f98 0 3px,transparent 3px 6px)'
          : st.color;
        return `<span><i class="line" style="background:${bg};height:${Math.max(1, st.width)}px"></i>${st.label}</span>`;
      }).join('');
      legendEl.innerHTML = `<span style="opacity:.8">标题栏＝类别</span>` + kindDots
        + `<span style="opacity:.45">｜</span>`
        + `<span style="opacity:.8">线＝关系类型</span>` + lineKinds
        + `<span style="opacity:.45">｜</span><span style="opacity:.8">指着卡片才亮它的线（线色＝对端身份色）</span>`
        + `<span style="opacity:.45">｜</span><span><i class="dot" style="background:#f0c43c"></i>疑似冲突</span>`;
      return;
    }
    legendEl.innerHTML = Object.keys(EDGE_STYLES).map((k) => {
      const st = EDGE_STYLES[k];
      return `<span><i class="line" style="background:${st.color};height:${Math.max(1, st.width)}px"></i>${st.label}</span>`;
    }).join('') + kindDots
      + `<span style="opacity:.45">｜</span><span><i class="dot" style="background:#f0c43c"></i>疑似冲突</span>`;
  }
  renderLegend();

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth || 640;
    const h = box.clientHeight || 480;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }

  async function load(retry = true) {
    statsEl.textContent = '读取中…';
    try {
      const data = await api('/graph' + (semanticOn ? '' : '?semantic=0'));
      const feat = data.features || {};
      // 开关状态以配置为准（重启后保持），别让界面和实际配置说两套话
      if (typeof feat.semanticEdges === 'boolean' && feat.semanticEdges !== semanticOn) {
        semanticOn = feat.semanticEdges;
        const b = document.getElementById('gSem');
        if (b) {
          b.textContent = semanticOn ? '语义：开' : '语义：关';
          b.classList.toggle('btn--on', semanticOn);
        }
      }
      // 顺手拿一份直觉结果，把"疑似冲突"的记忆在图上标黄（关掉了就不去取）
      try {
        if (feat.conflictMarks === false) {
          conflictIds = new Set();
        } else {
          const ins = await api('/insight');
          conflictIds = new Set();
          for (const p of ins.conflicts || []) {
            conflictIds.add(p.a.id);
            conflictIds.add(p.b.id);
          }
        }
      } catch { conflictIds = new Set(); }
      nodes = data.nodes || [];
      edges = data.edges || [];
      assocMap = new Map(Object.entries(data.neighbors || {}));
      edgeKeys = new Set();
      for (const e of edges) {
        edgeKeys.add(e.source + '|' + e.target);
        edgeKeys.add(e.target + '|' + e.source);
      }
      if (isolatedOnly) {
        const keep = new Set(nodes.filter((n) => n.isolated).map((n) => n.id));
        nodes = nodes.filter((n) => keep.has(n.id));
        edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
      }
      // 预计算：身份色相 + 邻居顺序表（每帧都算太浪费，而且颜色必须稳定）
      for (const n of nodes) n.hue = idHue(n.id);
      neighborIndex = new Map();
      for (const e of edges) {
        if (!neighborIndex.has(e.source)) neighborIndex.set(e.source, new Map());
        if (!neighborIndex.has(e.target)) neighborIndex.set(e.target, new Map());
        const ms = neighborIndex.get(e.source);
        if (!ms.has(e.target)) ms.set(e.target, ms.size);
        const mt = neighborIndex.get(e.target);
        if (!mt.has(e.source)) mt.set(e.source, mt.size);
      }

      layout = createLayout(nodes, edges);
      layout.nodes = nodes;
      layout.edges = edges;
      viewport = { scale: 1, x: 0, y: 0 };
      settledTold = false;
      selected = null;
      renderSide();
      statsEl.textContent = `点 ${nodes.length} · 边 ${edges.length} · 孤岛 ${data.stats ? data.stats.isolated : 0}`;
      resize();
      // 载入后先「适应窗口」：否则整张图偏在左下角，右上大片空白，第一眼像是坏的
      fitView();
    } catch (err) {
      // 自动重试一次：偶发的瞬时失败（比如服务刚被切换页签打断）不该让用户看到红字
      if (retry) {
        await new Promise((r) => setTimeout(r, 800));
        return load(false);
      }
      statsEl.textContent = '';
      toast('读取关系图失败：' + err.message, true);
    }
  }

  function toScreen(wx, wy) {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    return [(wx + viewport.x) * viewport.scale + w / 2, (wy + viewport.y) * viewport.scale + h / 2];
  }

  /* ── 两种渲染模式 ── */

  const CARD_W = 196;
  const CARD_H = 96;
  const CARD_HEAD = 24;

  function cardRect(i) {
    return { x: layout.px[i] - CARD_W / 2, y: layout.py[i] - CARD_H / 2, w: CARD_W, h: CARD_H };
  }

  /**
   * 卡片是"盒子"不是"点"：力导向只保证圆点之间不撞，卡片会大片重叠。
   * 这里做一层矩形分离（AABB），沿重叠较小的那根轴把两个盒子推开。
   * @returns {boolean} 是否发生了推动（据此决定要不要重绘）
   */
  function separateCards(L) {
    // 间距给得比卡片本身大不少：挨太近时连线的起止点会糊在一起，完全分不清
    const gapX = CARD_W + 58;
    const gapY = CARD_H + 46;
    let moved = false;
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < L.count; i++) {
        for (let j = i + 1; j < L.count; j++) {
          const dx = L.px[j] - L.px[i];
          const dy = L.py[j] - L.py[i];
          const ox = gapX - Math.abs(dx);
          const oy = gapY - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const push = (ox / 2 + 0.6) * (dx >= 0 ? 1 : -1);
            L.px[i] -= push;
            L.px[j] += push;
          } else {
            const push = (oy / 2 + 0.6) * (dy >= 0 ? 1 : -1);
            L.py[i] -= push;
            L.py[j] += push;
          }
          moved = true;
        }
      }
    }
    return moved;
  }

  /** 从矩形的哪个边连出去：看目标在哪个方向，取更接近的那个边 */
  function anchorOn(rect, tx, ty) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? { x: rect.x + rect.w, y: cy } : { x: rect.x, y: cy };
    }
    return dy >= 0 ? { x: cx, y: rect.y + rect.h } : { x: cx, y: rect.y };
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function clipText(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
    return out + '…';
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    if (!layout || layout.count === 0) return;
    if (mode === 'cards') drawCards();
    else drawDots();
  }

  /**
   * 当前焦点的节点序号：悬停优先，其次选中
   */
  function focusIndex() {
    if (!layout) return -1;
    if (hover >= 0) return hover;
    if (selected) {
      const i = layout.ids.get(selected.id);
      return i === undefined ? -1 : i;
    }
    return -1;
  }

  /**
   * 联想只在**选中**（点一下）时出现，悬停时不画。
   * 理由：悬停是"扫一眼有哪些关系"，再叠一堆联想线就糊了；
   * 点一下才表示"我想看看这条和什么有关"，这时联想才有价值。
   */
  function assocFocusIndex() {
    if (!layout || !selected) return -1;
    const i = layout.ids.get(selected.id);
    return i === undefined ? -1 : i;
  }

  /**
   * 联想目标：焦点那条记忆"最像的几条"里，**还没有正式连线的**那些。
   * 已有边的不重复画——它们已经被画出来了，再画一条只是噪声。
   */
  function assocTargets(fi) {
    if (fi < 0 || !assocMap.size) return [];
    const node = layout.nodes[fi];
    const list = assocMap.get(node.id) || [];
    const out = [];
    for (const a of list) {
      const ti = layout.ids.get(a.id);
      if (ti === undefined || ti === fi) continue;
      if (edgeKeys.has(node.id + '|' + a.id)) continue;
      out.push({ i: ti, sim: a.sim });
    }
    return out;
  }

  /**
   * 画"联想"虚线：紫色点线，粗细随相似度。
   * posOf(i, toward) 返回"从 i 朝 toward 方向"的出线点——圆点用圆心，卡片用边框锚点。
   */
  function drawAssocLines(fi, posOf) {
    const targets = assocTargets(fi);
    if (!targets.length) return;
    for (const t of targets) {
      const from = posOf(fi, t.i);
      const to = posOf(t.i, fi);
      ctx.save();
      ctx.strokeStyle = `rgba(206,160,255,${0.35 + 0.5 * Math.min(1, Math.max(0, t.sim))})`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([1, 5]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 圆点视图：看整体结构（谁扎堆、谁孤立）最快 */
  function drawDots() {
    for (const e of layout.edges) {
      const a = layout.ids.get(e.source);
      const b = layout.ids.get(e.target);
      if (a === undefined || b === undefined) continue;
      const st = edgeStyle(e.kind);
      const [x1, y1] = toScreen(layout.px[a], layout.py[a]);
      const [x2, y2] = toScreen(layout.px[b], layout.py[b]);
      ctx.save();
      ctx.strokeStyle = st.color;
      ctx.lineWidth = Math.max(0.6, st.width * Math.min(1.6, viewport.scale));
      if (st.dash) ctx.setLineDash(st.dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }

    // 联想：点中某条时，把它"最像、但还没有正式连线"的浮出来（悬停不画，否则糊）
    drawAssocLines(assocFocusIndex(), (i) => {
      const [x, y] = toScreen(layout.px[i], layout.py[i]);
      return { x, y };
    });

    const needle = filter.trim().toLowerCase();
    for (let i = 0; i < layout.count; i++) {
      const node = layout.nodes[i];
      const [x, y] = toScreen(layout.px[i], layout.py[i]);
      const r = Math.max(3.5, Math.min(11, 4 + Math.log1p(node.degree || 0) * 1.8)) * viewport.scale;      const dim = needle && !(
        String(node.label).toLowerCase().includes(needle)
        || (node.tags || []).some((t) => String(t).toLowerCase().includes(needle))
      );
      ctx.save();
      ctx.globalAlpha = dim ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = kindColor(node.kind);
      ctx.fill();
      if (node.isolated) {
        ctx.strokeStyle = 'rgba(217,83,79,.85)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
      } else if (conflictIds.has(node.id)) {
        // 疑似冲突：黄圈实线（和孤岛的红虚线区分开）
        ctx.strokeStyle = 'rgba(240,196,60,.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (hover === i) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();

      // 标签只在"确实连得多"且放得够大时才画：否则一堆文字互相压住，比不画还糟
      if (viewport.scale >= 1.25 && !dim && (node.linkDegree || 0) >= 6) {
        ctx.save();
        ctx.font = '10px ui-monospace, Consolas, monospace';
        const label = node.label.length > 14 ? node.label.slice(0, 14) + '…' : node.label;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(20,22,26,0.9)';
        ctx.strokeText(label, x + r + 3, y + 3);
        ctx.fillStyle = 'rgba(215,218,224,0.95)';
        ctx.fillText(label, x + r + 3, y + 3);
        ctx.restore();
      }
    }

    // 联想目标加一圈紫点，表明"最像它、但没有正式连线"
    const af = assocFocusIndex();
    if (af >= 0) {
      for (const t of assocTargets(af)) {
        const [tx, ty] = toScreen(layout.px[t.i], layout.py[t.i]);
        ctx.save();
        ctx.strokeStyle = 'rgba(206,160,255,0.95)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(tx, ty, Math.max(6, 7 * viewport.scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /** 工作流视图：卡片式节点 + 贝塞尔连线（像 ComfyUI 那种） */
  function drawCards() {
    const needle = filter.trim().toLowerCase();
    const scale = viewport.scale;

    // 焦点：悬停/选中时只亮它和它的邻居，其余压暗。密集区靠这个才看得清连线归属
    const focusId = hover >= 0 ? layout.nodes[hover].id : (selected ? selected.id : null);
    const focusSet = new Set();
    if (focusId) {
      focusSet.add(focusId);
      const m = neighborIndex.get(focusId);
      if (m) for (const k of m.keys()) focusSet.add(k);
      // 联想到的也算"相关"：不然它们会被一起压暗，等于看不见
      for (const a of assocMap.get(focusId) || []) focusSet.add(a.id);
    }

    // 联想目标（只在"点选"时算，悬停不算）：给它们加紫边
    const assocIdx = assocFocusIndex();
    const assocSet = new Set();
    if (assocIdx >= 0) {
      for (const t of assocTargets(assocIdx)) assocSet.add(layout.nodes[t.i].id);
    }

    // 先画连线（压在卡片下面）
    for (const e of layout.edges) {
      const a = layout.ids.get(e.source);
      const b = layout.ids.get(e.target);
      if (a === undefined || b === undefined) continue;

      const na = layout.nodes[a];
      const nb = layout.nodes[b];
      const ra = cardRect(a);
      const rb = cardRect(b);
      const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
      const cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
      const p1 = anchorOn(ra, cb.x, cb.y);
      const p2 = anchorOn(rb, ca.x, ca.y);

      // 同一个边上的多条线错开位置，否则全挤在边中点，看着就是一团
      const si = (neighborIndex.get(e.source) || new Map()).get(e.target) || 0;
      const ti = (neighborIndex.get(e.target) || new Map()).get(e.source) || 0;
      if (p1.y === ca.y) p1.y += ((si % 7) - 3) * 9;
      else p1.x += ((si % 7) - 3) * 11;
      if (p2.y === cb.y) p2.y += ((ti % 7) - 3) * 9;
      else p2.x += ((ti % 7) - 3) * 11;

      const [sx1, sy1] = toScreen(p1.x, p1.y);
      const [sx2, sy2] = toScreen(p2.x, p2.y);

      const dx = sx2 - sx1;
      const dy = sy2 - sy1;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const k = Math.max(30, Math.min(180, Math.hypot(dx, dy) * 0.45 * scale));
      const sxDir = dx >= 0 ? 1 : -1;
      const syDir = dy >= 0 ? 1 : -1;

      // 线色策略：
      //   常态 —— 用关系类型的颜色（统一、压暗），让整体读起来是一张柔和的网，不是彩虹面条
      //   焦点 —— 只有悬停/选中的那条卡片的连线亮起来，并用**对端的身份色**着色，
      //          这样"这根线通向谁"一眼可辨；其余线几乎隐去
      const inFocus = !focusId || (focusSet.has(e.source) && focusSet.has(e.target));
      let stroke;
      if (focusId && inFocus) {
        const grad = ctx.createLinearGradient(sx1, sy1, sx2, sy2);
        grad.addColorStop(0, `hsla(${na.hue}, 72%, 66%, 1)`);
        grad.addColorStop(1, `hsla(${nb.hue}, 72%, 66%, 1)`);
        stroke = grad;
      } else {
        stroke = edgeStyle(e.kind).color;
      }

      const st = edgeStyle(e.kind);
      ctx.save();
      ctx.globalAlpha = focusId ? (inFocus ? 1 : 0.04) : 0.32;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.7, st.width * Math.min(1.5, scale)) * (focusId && inFocus ? 1.6 : 1);
      if (st.dash) ctx.setLineDash(st.dash);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      if (horizontal) {
        ctx.bezierCurveTo(sx1 + sxDir * k, sy1, sx2 - sxDir * k, sy2, sx2, sy2);
      } else {
        ctx.bezierCurveTo(sx1, sy1 + syDir * k, sx2, sy2 - syDir * k, sx2, sy2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 联想线：从卡片边框出去，指到"最像但没连"的那几条
    drawAssocLines(assocFocusIndex(), (i, toward) => {
      const ri = cardRect(i);
      const rj = cardRect(toward);
      const p = anchorOn(ri, rj.x + rj.w / 2, rj.y + rj.h / 2);
      const [x, y] = toScreen(p.x, p.y);
      return { x, y };
    });

    // 再画卡片
    for (let i = 0; i < layout.count; i++) {
      const node = layout.nodes[i];
      const rect = cardRect(i);
      const [x, y] = toScreen(rect.x, rect.y);
      const w = CARD_W * scale;
      const h = CARD_H * scale;
      if (w < 24) continue; // 缩得太小就别画了，画出来也是黑块

      const dim = needle && !(
        String(node.label).toLowerCase().includes(needle)
        || (node.tags || []).some((t) => String(t).toLowerCase().includes(needle))
      );
      const accent = kindColor(node.kind);
      const headH = Math.min(CARD_HEAD * scale, h * 0.4);
      const inFocus = !focusId || focusSet.has(node.id);
      const isActive = hover === i || (selected && selected.id === node.id);
      const baseAlpha = dim ? 0.18 : 1;
      const focusAlpha = focusId ? (inFocus ? 1 : 0.12) : 1;

      ctx.save();
      ctx.globalAlpha = baseAlpha * focusAlpha;

      // 卡体
      roundRect(x, y, w, h, 6 * scale);
      ctx.fillStyle = '#1b1e24';
      ctx.fill();

      // 标题栏（按**类别**着色，表示"这是什么"）
      roundRect(x, y, w, headH, 6 * scale);
      ctx.fillStyle = accent;
      ctx.globalAlpha = baseAlpha * focusAlpha * 0.9;
      ctx.fill();
      ctx.globalAlpha = baseAlpha * focusAlpha;

      // 左侧身份色条（按**记忆 id** 着色，表示"这是哪一条"，和它发出的线同色）
      ctx.fillStyle = `hsla(${node.hue}, 72%, 64%, 0.98)`;
      ctx.fillRect(x, y + headH, Math.max(1.5, 3.5 * scale), h - headH);

      // 边框
      roundRect(x, y, w, h, 6 * scale);
      const conflicting = conflictIds.has(node.id);
      const isAssoc = assocSet.has(node.id);
      ctx.strokeStyle = isActive
        ? 'rgba(255,255,255,0.92)'
        : conflicting
          ? 'rgba(240,196,60,0.95)'
          : isAssoc
            ? 'rgba(206,160,255,0.95)'
            : (focusId && inFocus ? `hsla(${node.hue}, 72%, 64%, 0.8)` : 'rgba(150,155,165,0.32)');
      ctx.lineWidth = isActive ? 1.8 : ((conflicting || isAssoc) ? 1.8 : 1);
      ctx.stroke();

      // 疑似冲突角标（左下角黄色小三角）
      if (conflicting) {
        ctx.fillStyle = 'rgba(240,196,60,0.95)';
        ctx.beginPath();
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + 9 * scale, y + h);
        ctx.lineTo(x, y + h - 9 * scale);
        ctx.closePath();
        ctx.fill();
      }

      // 孤岛角标
      if (node.isolated) {
        ctx.fillStyle = 'rgba(217,83,79,0.95)';
        ctx.beginPath();
        ctx.arc(x + w - 7 * scale, y + 7 * scale, Math.max(1.5, 3 * scale), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      // 文字：缩得太小时不画，免得糊成一团
      if (scale < 0.45) continue;

      ctx.save();
      ctx.globalAlpha = (dim ? 0.25 : 1) * focusAlpha;

      // 标题
      ctx.fillStyle = 'rgba(12,14,17,0.92)';
      ctx.font = `600 ${Math.round(Math.max(8, 11 * scale))}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      const titleY = y + headH / 2;
      ctx.fillText(clipText(node.label, w - 14 * scale), x + 7 * scale, titleY);

      // 字段行
      const rowFont = `${Math.round(Math.max(7, 10 * scale))}px system-ui, sans-serif`;
      ctx.font = rowFont;
      ctx.textBaseline = 'top';
      const rows = [
        ['项目', node.project || '—'],
        ['类别', KIND_LABELS[node.kind] || node.kind],
        ['时间', ageLabel(node.createdAt)],
        ['连接', String(node.linkDegree || 0) + (node.isolated ? ' · 孤岛' : '')],
      ];
      const rowH = Math.max(9, 17 * scale);
      let ry = y + headH + 5 * scale;
      for (const [label, value] of rows) {
        if (ry + rowH > y + h) break;
        ctx.fillStyle = 'rgba(140,146,156,0.95)';
        ctx.fillText(label, x + 7 * scale, ry);
        ctx.fillStyle = 'rgba(214,218,224,0.95)';
        ctx.fillText(clipText(value, w - 52 * scale), x + 44 * scale, ry);
        ry += rowH;
      }
      ctx.restore();
    }
  }

  function tick() {
    if (stopped) return;
    const dragging = drag && drag.nodeIndex >= 0;
    if (layout && (!isSettled(layout) || dragging)) {
      // 卡片比圆点大一大截，同样的力会把卡片糊在一起，所以卡片模式用更松的力参数
      stepLayout(layout, mode === 'cards'
        ? { repulsion: 22000, springLength: 460, gravity: 0.0022 }
        : {});
      needsDraw = true;
      if (!dragging && isSettled(layout) && !settledTold) {
        settledTold = true;
        statsEl.textContent += ` · 已收敛（${layout.iterations} 步）`;
        // 收敛后位置还会被分离/力推着微调，此时再适应一次窗口，否则边缘卡片会被切掉
        fitView();
      }
    }
    // 卡片模式：即使力已收敛也要继续压重叠，否则一收敛就停在"还压着"的状态
    if (layout && mode === 'cards' && separateCards(layout)) needsDraw = true;
    // 收敛且没交互时不再重绘：rAF 空转会让风扇一直转
    if (needsDraw) {
      draw();
      needsDraw = false;
    }
    raf = requestAnimationFrame(tick);
  }

  function hitTest(clientX, clientY) {
    if (!layout) return -1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // 卡片模式：点在矩形里就算命中（从后往前找，保证后画的在上层）
    if (mode === 'cards') {
      const wx = (clientX - rect.left - w / 2) / viewport.scale - viewport.x;
      const wy = (clientY - rect.top - h / 2) / viewport.scale - viewport.y;
      for (let i = layout.count - 1; i >= 0; i--) {
        const r = cardRect(i);
        if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return i;
      }
      return -1;
    }

    let best = -1;
    let bestD = 14 * 14;
    for (let i = 0; i < layout.count; i++) {
      const x = (layout.px[i] + viewport.x) * viewport.scale + w / 2;
      const y = (layout.py[i] + viewport.y) * viewport.scale + h / 2;
      const dx = x - (clientX - rect.left);
      const dy = y - (clientY - rect.top);
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  }

  /* ── 右键详情弹层 ── */

  let popupEl = null;

  /**
   * 详情缓存。
   *
   * 为什么需要：关系图上的 node.label 是**画布用的截断文本**（太长会糊成一团），
   * 直接拿它当详情正文会显示不全。所以点开时再按 id 拉一次全文。
   * 缓存起来避免同一个节点反复请求。
   */
  const detailCache = new Map();
  function fetchDetail(id) {
    if (!detailCache.has(id)) {
      detailCache.set(id, api('/memories/' + encodeURIComponent(id)).catch(() => null));
    }
    return detailCache.get(id);
  }

  /** 把全文 + 后续进展补进已经渲染好的容器里 */
  function patchDetail(container, detail, bodySelector = '.nodemenu__body') {
    if (!detail || !detail.memory) return;
    const body = container.querySelector(bodySelector);
    if (body) body.textContent = inlineText(detail.memory.content || '');
    const ups = detail.updates || [];
    if (ups.length && body) {
      const last = ups[ups.length - 1];
      const line = document.createElement('div');
      line.className = 'hint';
      line.style.marginTop = '8px';
      line.textContent = `↳ 后续进展（共 ${ups.length} 条）：${last.text}`;
      body.after(line);
    }
  }

  function closePopup() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
  }

  function showPopup(node, clientX, clientY) {
    closePopup();
    const el = document.createElement('div');
    el.className = 'nodemenu';
    const tags = (node.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    el.innerHTML = `
      <div class="nodemenu__head">
        <span class="tag" style="background:${kindColor(node.kind)}33;border-color:${kindColor(node.kind)}">${esc(KIND_LABELS[node.kind] || node.kind)}</span>
        <span class="hint">${esc(ageLabel(node.createdAt))}</span>
        ${node.isolated ? '<span class="tag tag--warn">孤岛</span>' : ''}
        <button class="nodemenu__x" title="关闭">✕</button>
      </div>
      <div class="meta">
        ${node.project ? `<span class="tag">${esc(node.project)}</span>` : ''}
        ${node.importance && node.importance !== 'important' ? `<span class="tag">${esc(IMPORTANCE_LABELS[node.importance] || node.importance)}</span>` : ''}
        <span>连接 ${node.linkDegree || 0}</span>
      </div>
      ${tags ? `<div class="meta">${tags}</div>` : ''}
      <div class="nodemenu__body">${esc(inlineText(node.label || ''))}</div>
      <div class="nodemenu__foot">
        <span class="mono">${esc(node.id)}</span>
        <button class="btn" data-copy>复制正文</button>
      </div>`;

    document.body.appendChild(el);
    // 贴着鼠标放，但不许溢出窗口
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX + 10, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(clientY + 10, window.innerHeight - r.height - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';

    el.querySelector('.nodemenu__x').onclick = closePopup;
    el.querySelector('[data-copy]').onclick = async () => {
      // 复制的一定是**全文**，不是画布上的截断标签
      const d = await fetchDetail(node.id);
      const text = (d && d.memory && d.memory.content) || inlineText(node.label || '');
      try {
        await navigator.clipboard.writeText(text);
        toast(d && d.memory ? '已复制全文' : '已复制（只有截断文本）');
      } catch {
        toast('复制失败（浏览器不允许）', true);
      }
    };

    // 标签是截断的，先把全文补上再显示
    fetchDetail(node.id).then((d) => patchDetail(el, d));

    popupEl = el;
  }

  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (!layout) return;
    const idx = hitTest(ev.clientX, ev.clientY);
    if (idx < 0) { closePopup(); return; }
    selected = layout.nodes[idx];
    renderSide();
    showPopup(layout.nodes[idx], ev.clientX, ev.clientY);
  });

  // 点别处（含画布）就收起弹层
  const onDocPointerDown = (ev) => {
    if (popupEl && !popupEl.contains(ev.target)) closePopup();
  };
  const onKeyDown = (ev) => { if (ev.key === 'Escape') closePopup(); };
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onKeyDown);

  function renderSide() {
    if (!selected) {
      side.innerHTML = `<h3>怎么读这张图</h3>
        <div class="hint" style="line-height:1.9">
          点：一条记忆，颜色＝类别，大小＝连接数。<br />
          边：共现（被一起用过）、共享标签、同项目、创建时间相邻；<br />
          配了 embedding 还会有<b>语义相近</b>（紫色点线，按向量相似度连）。<br /><br />
          红圈虚线＝孤岛：没有任何语义关系，通常意味着「写了但没人用」。<br /><br />
          <b>左键</b>点节点看详情，<b>右键</b>弹窗看全文。<br />
          「视图」按钮可在圆点图 / 工作流卡片图之间切换。<br />
          滚轮缩放，拖空白处平移，拖节点可手动摆位置。
        </div>`;
      return;
    }
    const meta = [
      selected.project ? `<span class="tag">${esc(selected.project)}</span>` : '',
      `<span class="tag">${esc(KIND_LABELS[selected.kind] || selected.kind)}</span>`,
      selected.importance && selected.importance !== 'important'
        ? `<span class="tag">${esc(IMPORTANCE_LABELS[selected.importance] || selected.importance)}</span>` : '',
      `<span>${ageLabel(selected.createdAt)}</span>`,
      `<span>连接 ${selected.linkDegree || 0}</span>`,
      selected.isolated ? '<span class="tag tag--warn">孤岛</span>' : '',
    ].join('');
    const tags = (selected.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    side.innerHTML = `
      <h3>记忆详情</h3>
      <div class="meta">${meta}</div>
      ${tags ? `<div class="meta" style="margin:6px 0">${tags}</div>` : ''}
      <div class="body">${esc(inlineText(selected.label || ''))}</div>
      <div class="mono" style="margin-top:8px">${esc(selected.id)}</div>
      <div class="bar" style="margin-top:10px"><button class="btn" id="gClose">关闭</button></div>`;
    const close = document.getElementById('gClose');
    if (close) close.onclick = () => { selected = null; renderSide(); };
    // 侧栏里先把截断标签显示出来（立刻有反馈），再补全文
    fetchDetail(selected.id).then((d) => {
      if (!selected || d === null) return;
      patchDetail(side, d, '.body');
    });
  }

  function fitView() {
    if (!layout || layout.count === 0) return;
    const b = bounds(layout);
    const w = box.clientWidth || 640;
    const h = box.clientHeight || 480;
    // 卡片模式的包围盒要把卡片自身的宽高算进去，否则边缘卡片会被切掉一半
    const padX = mode === 'cards' ? CARD_W : 0;
    const padY = mode === 'cards' ? CARD_H : 0;
    const spanX = Math.max(1, b.maxX - b.minX + padX);
    const spanY = Math.max(1, b.maxY - b.minY + padY);
    const scale = Math.min((w - 80) / spanX, (h - 80) / spanY);
    // 卡片模式不硬缩到"全部可见"：75 张卡片挤进一屏会小到看不清字。
    // 保底 0.55 倍保证文字可读，装不下的部分靠拖拽/滚轮看——这本来也是工作流图的用法。
    const minScale = mode === 'cards' ? 0.55 : 0.15;
    viewport.scale = Math.max(minScale, Math.min(3, scale));
    viewport.x = -(b.minX + b.maxX) / 2;
    viewport.y = -(b.minY + b.maxY) / 2;
    needsDraw = true;
  }

  /* 交互 */
  canvas.addEventListener('pointerdown', (ev) => {
    const idx = hitTest(ev.clientX, ev.clientY);
    if (idx >= 0) {
      drag = { nodeIndex: idx, startX: ev.clientX, startY: ev.clientY };
      if (layout) layout.alpha = Math.max(layout.alpha, 0.6);
      selected = layout.nodes[idx];
      renderSide();
    } else {
      drag = { nodeIndex: -1, startX: ev.clientX, startY: ev.clientY, origin: { ...viewport } };
    }
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const next = hitTest(ev.clientX, ev.clientY);
      if (next !== hover) { hover = next; needsDraw = true; }
      return;
    }
    needsDraw = true;
    if (!layout) return;
    if (drag.nodeIndex >= 0) {
      const rect = canvas.getBoundingClientRect();
      layout.px[drag.nodeIndex] = (ev.clientX - rect.left - rect.width / 2) / viewport.scale - viewport.x;
      layout.py[drag.nodeIndex] = (ev.clientY - rect.top - rect.height / 2) / viewport.scale - viewport.y;
      layout.vx[drag.nodeIndex] = 0;
      layout.vy[drag.nodeIndex] = 0;
    } else {
      viewport.x = drag.origin.x + (ev.clientX - drag.startX) / viewport.scale;
      viewport.y = drag.origin.y + (ev.clientY - drag.startY) / viewport.scale;
    }
  });

  const endDrag = () => { drag = null; canvas.classList.remove('dragging'); needsDraw = true; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointerleave', () => { hover = -1; endDrag(); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    viewport.scale = Math.max(0.15, Math.min(6, viewport.scale * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
    needsDraw = true;
  }, { passive: false });

  filterEl.addEventListener('input', () => { filter = filterEl.value; needsDraw = true; });

  isolatedBtn.addEventListener('click', () => {
    isolatedOnly = !isolatedOnly;
    isolatedBtn.textContent = isolatedOnly ? '孤岛视图：开' : '孤岛视图：关';
    isolatedBtn.classList.toggle('btn--on', isolatedOnly);
    load();
  });

  const modeBtn = document.getElementById('gMode');
  modeBtn.textContent = mode === 'dots' ? '视图：圆点' : '视图：工作流';
  modeBtn.classList.toggle('btn--on', mode === 'cards');
  modeBtn.addEventListener('click', () => {
    mode = mode === 'dots' ? 'cards' : 'dots';
    graphMode = mode;
    location.hash = 'graph/' + mode;
    modeBtn.textContent = mode === 'dots' ? '视图：圆点' : '视图：工作流';
    modeBtn.classList.toggle('btn--on', mode === 'cards');
    closePopup();
    // 卡片比圆点大得多：切过去重新热一下布局，再适应窗口，不然会挤成一坨
    if (layout) layout.alpha = 1;
    settledTold = false;
    renderLegend();
    setTimeout(() => { fitView(); }, 80);
  });

  const semBtn = document.getElementById('gSem');
  semBtn.addEventListener('click', async () => {
    semanticOn = !semanticOn;
    semBtn.textContent = semanticOn ? '语义：开' : '语义：关';
    semBtn.classList.toggle('btn--on', semanticOn);
    // 持久化：这是在设置页之外也能改的开关，改完要能记住
    try {
      await api('/config', { method: 'POST', body: JSON.stringify({ features: { semanticEdges: semanticOn } }) });
    } catch { /* 存不上也不挡当前这次显示 */ }
    load();
  });

  document.getElementById('gReload').addEventListener('click', load);
  document.getElementById('gReheat').addEventListener('click', () => {
    if (layout) layout.alpha = 1;
    settledTold = false;
  });
  document.getElementById('gFit').addEventListener('click', fitView);

  const onResize = () => { resize(); };
  window.addEventListener('resize', onResize);

  resize();
  load();
  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    closePopup();
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 记忆列表
 * ══════════════════════════════════════════════════════════════════════ */

function renderList() {
  view.innerHTML = `
    <div class="bar">
      <input type="search" id="lQuery" placeholder="搜索记忆（中文二字也会命中）" style="width:260px" maxlength="200" />
      <button class="btn" id="lSearch">搜索</button>
      <button class="btn" id="lAll">显示全部</button>
      <button class="btn" id="lDeleted">含已删：关</button>
      <button class="btn btn--primary" id="lAdd">新增</button>
      <span class="stat" id="lStat"></span>
    </div>
    <div class="bar" id="lKindBar">
      <span class="stat">类别：</span>
      <button class="btn btn--on" data-kind="">全部</button>
      <button class="btn" data-kind="work">工作</button>
      <button class="btn" data-kind="emotion">情感</button>
      <button class="btn" data-kind="preference">偏好</button>
      <button class="btn" data-kind="unknown">未分类</button>
    </div>
    <div id="lAddBox"></div>
    <div class="scroll" id="lList"></div>`;

  const listEl = document.getElementById('lList');
  const statEl = document.getElementById('lStat');
  const queryEl = document.getElementById('lQuery');
  const deletedBtn = document.getElementById('lDeleted');
  const addBox = document.getElementById('lAddBox');

  let showDeleted = false;
  let editing = null;
  // 类别筛选：情感轨要有地方看，否则记了也等于没记
  let kindFilter = '';

  async function load(q) {
    statEl.textContent = '读取中…';
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (q) params.set('q', q);
      if (kindFilter) params.set('kind', kindFilter);
      if (showDeleted) params.set('includeDeleted', '1');
      const data = await api('/memories?' + params.toString());
      statEl.textContent = `共 ${data.total} 条` + (q ? ` · 命中 ${data.memories.length}` : '');
      render(data.memories || []);
    } catch (err) {
      statEl.textContent = '';
      toast('读取失败：' + err.message, true);
    }
  }

  function render(rows) {
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty">没有记忆。</div>';
      return;
    }
    listEl.innerHTML = rows.map((rec) => {
      const meta = [
        rec.project ? `<span class="tag">${esc(rec.project)}</span>` : '',
        rec.kind !== 'unknown' ? `<span class="tag">${esc(KIND_LABELS[rec.kind])}</span>` : '',
        rec.importance !== 'important' ? `<span class="tag">${esc(IMPORTANCE_LABELS[rec.importance] || rec.importance)}</span>` : '',
        `<span>${ageLabel(rec.createdAt)}</span>`,
        rec.accessCount ? `<span>用过 ${rec.accessCount} 次</span>` : '',
        rec.deletedAt ? '<span class="tag tag--warn">已删除</span>' : '',
      ].join('');
      const tags = (rec.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      const editingThis = editing === rec.id;
      return `<div class="item" data-id="${esc(rec.id)}">
        <div class="itemHead"><div class="meta">${meta}</div><span class="mono">${esc(rec.id)}</span></div>
        ${editingThis
          ? `<textarea data-edit="${esc(rec.id)}" rows="5" style="width:100%;margin-top:6px">${esc(rec.content)}</textarea>
             <div class="itemActions">
               <button class="btn btn--primary" data-act="save">保存</button>
               <button class="btn" data-act="cancel">取消</button>
             </div>`
          : `<div class="body">${esc(compact(rec.content, 160))}</div>
             ${rec.updatesCount ? `<div class="meta" style="margin-top:4px">↳ 有 ${rec.updatesCount} 条后续进展</div>` : ''}
             ${tags ? `<div class="meta" style="margin-top:4px">${tags}</div>` : ''}
             <div class="itemActions">
               ${rec.deletedAt
                 ? '<button class="btn" data-act="restore">恢复</button><button class="btn btn--danger" data-act="purge">彻底删除</button>'
                 : '<button class="btn" data-act="progress">追加进展</button><button class="btn" data-act="edit">编辑</button><button class="btn btn--danger" data-act="delete">删除</button>'}
             </div>`}
      </div>`;
    }).join('');
  }

  listEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const item = btn.closest('.item');
    const id = item && item.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;

    if (act === 'edit') { editing = id; load(queryEl.value); return; }
    if (act === 'cancel') { editing = null; load(queryEl.value); return; }
    // 追加进展：原记忆不改，只往后加一行"后来怎么样了"
    if (act === 'progress') {
      const text = prompt('这条记忆后来怎么样了？（不会覆盖原文，会追加在后面）');
      if (text == null) return;
      if (!text.trim()) { toast('内容为空，没保存', true); return; }
      try {
        await api('/memories/' + encodeURIComponent(id) + '/updates', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        toast('已追加进展');
        await load(queryEl.value);
      } catch (err) { toast('追加失败：' + err.message, true); }
      return;
    }
    if (act === 'save') {
      const ta = item.querySelector('textarea[data-edit]');
      try {
        await api('/memories/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ content: ta.value }) });
        editing = null;
        toast('已保存');
        await load(queryEl.value);
        await refreshMeta();
      } catch (err) { toast('保存失败：' + err.message, true); }
      return;
    }

    try {
      if (act === 'delete') await api('/memories/' + encodeURIComponent(id), { method: 'DELETE' });
      else if (act === 'purge') await api('/memories/' + encodeURIComponent(id) + '/purge', { method: 'POST' });
      else if (act === 'restore') await api('/memories/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
      toast({ delete: '已删除（可恢复）', purge: '已彻底删除', restore: '已恢复' }[act] || '完成');
      await load(queryEl.value);
      await refreshMeta();
    } catch (err) { toast('操作失败：' + err.message, true); }
  });

  document.getElementById('lSearch').addEventListener('click', () => load(queryEl.value));
  document.getElementById('lKindBar').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-kind]');
    if (!btn) return;
    kindFilter = btn.dataset.kind || '';
    for (const b of document.querySelectorAll('#lKindBar button[data-kind]')) {
      b.classList.toggle('btn--on', (b.dataset.kind || '') === kindFilter);
    }
    load(queryEl.value);
  });
  queryEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') load(queryEl.value); });
  document.getElementById('lAll').addEventListener('click', () => { queryEl.value = ''; load(''); });
  deletedBtn.addEventListener('click', () => {
    showDeleted = !showDeleted;
    deletedBtn.textContent = showDeleted ? '含已删：开' : '含已删：关';
    deletedBtn.classList.toggle('btn--on', showDeleted);
    load(queryEl.value);
  });

  document.getElementById('lAdd').addEventListener('click', () => {
    if (addBox.innerHTML) { addBox.innerHTML = ''; return; }
    addBox.innerHTML = `
      <div class="item" style="margin-top:8px">
        <textarea id="aText" rows="3" placeholder="要记住什么？写成能独立读懂的一句话，带上「为什么」" style="width:100%"></textarea>
        <div class="bar" style="margin-top:6px">
          <input type="text" id="aTags" placeholder="标签，逗号分隔" style="width:200px" />
          <select id="aKind">
            <option value="unknown">未分类</option>
            <option value="work">工作</option>
            <option value="preference">偏好</option>
            <option value="emotion">情感</option>
          </select>
          <select id="aImp">
            <option value="important">重要</option>
            <option value="key">关键</option>
            <option value="casual">随口</option>
            <option value="transient">易过期</option>
          </select>
          <button class="btn btn--primary" id="aSave">保存</button>
        </div>
      </div>`;
    document.getElementById('aSave').addEventListener('click', async () => {
      const content = document.getElementById('aText').value.trim();
      if (!content) { toast('内容不能为空', true); return; }
      const tags = document.getElementById('aTags').value.split(/[,，\s]+/).filter(Boolean);
      try {
        await api('/memories', {
          method: 'POST',
          body: JSON.stringify({
            content,
            tags,
            kind: document.getElementById('aKind').value,
            importance: document.getElementById('aImp').value,
          }),
        });
        addBox.innerHTML = '';
        toast('已记住');
        await load(queryEl.value);
        await refreshMeta();
      } catch (err) { toast('保存失败：' + err.message, true); }
    });
  });

  load('');
  return () => {};
}

/* ══════════════════════════════════════════════════════════════════════
 * 补标
 * ══════════════════════════════════════════════════════════════════════ */

function renderClassify() {
  view.innerHTML = `
    <div class="bar">
      <span class="stat" id="cStat">读取中…</span>
      <button class="btn" id="cAll">只看未分类：开</button>
      <button class="btn" id="cAuto" title="按内容把未分类的粗分成 工作/偏好/情感，先预览再执行">自动分类</button>
      <button class="btn" id="cConsolidate" title="把同一件事反复出现的几条合成一条高阶结论（原文保留，先预览）">归纳候选</button>
      <button class="btn" id="cReload">刷新</button>
    </div>
    <div class="hint">逐条读正文再归位。分类只影响<b>半衰期</b>（工作 365 天 / 偏好 730 天 / 情感 60 天）和图的着色，写错了随时改，不丢记忆。</div>
    <div id="cAutoBox"></div>
    <div id="cConsBox"></div>
    <div class="scroll" id="cList"></div>`;

  const listEl = document.getElementById('cList');
  const statEl = document.getElementById('cStat');
  const allBtn = document.getElementById('cAll');
  const autoBox = document.getElementById('cAutoBox');
  let showAll = false;
  const expanded = new Set();

  async function load() {
    statEl.textContent = '读取中…';
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (!showAll) params.set('kind', 'unknown');
      const [data, state] = await Promise.all([api('/memories?' + params.toString()), api('/state')]);
      const unknown = (state.stats.byKind || []).find((k) => k.kind === 'unknown');
      statEl.textContent = showAll ? `全部 ${state.stats.total} 条` : `还有 ${unknown ? unknown.c : 0} 条未分类`;
      render(data.memories || []);
    } catch (err) {
      statEl.textContent = '';
      toast('读取失败：' + err.message, true);
    }
  }

  function render(rows) {
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty">没有未分类的记忆了 🎉</div>';
      return;
    }
    listEl.innerHTML = rows.map((rec) => {
      const kindBtns = KIND_CHOICES.map((k) => (
        `<button class="btn${rec.kind === k ? ' btn--on' : ''}" data-kind="${k}">${KIND_LABELS[k]}</button>`
      )).join('');
      const impBtns = IMPORTANCE_CHOICES.map((i) => (
        `<button class="btn${rec.importance === i ? ' btn--on' : ''}" data-imp="${i}">${IMPORTANCE_LABELS[i]}</button>`
      )).join('');
      const full = inlineText(rec.content);
      const isOpen = expanded.has(rec.id);
      return `<div class="item" data-id="${esc(rec.id)}">
        <div class="meta">
          ${rec.project ? `<span class="tag">${esc(rec.project)}</span>` : ''}
          <span>${ageLabel(rec.createdAt)}</span>
          <span class="mono">${esc(rec.id)}</span>
        </div>
        <div class="body">${esc(isOpen ? full : compact(rec.content, 220))}</div>
        ${full.length > 220 ? `<button class="btn" data-act="expand">${isOpen ? '收起' : '展开全文'}</button>` : ''}
        <div class="row"><span class="label">类别</span>${kindBtns}
          <button class="btn${rec.kind === 'unknown' ? ' btn--on' : ''}" data-kind="unknown">未分类</button></div>
        <div class="row"><span class="label">重要度</span>${impBtns}</div>
        <div class="row"><span class="label">标签</span>
          <input type="text" data-tags value="${esc((rec.tags || []).join(', '))}" style="flex:1 1 200px" />
          <button class="btn" data-act="saveTags">保存标签</button>
        </div>
      </div>`;
    }).join('');
  }

  async function patch(id, body) {
    try {
      await api('/memories/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify(body) });
      if (!showAll && body.kind && body.kind !== 'unknown') toast('已归类');
      await load();
      await refreshMeta();
    } catch (err) { toast('保存失败：' + err.message, true); }
  }

  listEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-kind], button[data-imp], button[data-act]');
    if (!btn) return;
    const item = btn.closest('.item');
    const id = item && item.dataset.id;
    if (!id) return;
    if (btn.dataset.kind) { patch(id, { kind: btn.dataset.kind }); return; }
    if (btn.dataset.imp) { patch(id, { importance: btn.dataset.imp }); return; }
    if (btn.dataset.act === 'expand') {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      load();
      return;
    }
    if (btn.dataset.act === 'saveTags') {
      const input = item.querySelector('input[data-tags]');
      const tags = input.value.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
      patch(id, { tags });
    }
  });

  allBtn.addEventListener('click', () => {
    showAll = !showAll;
    allBtn.textContent = showAll ? '只看未分类：关' : '只看未分类：开';
    allBtn.classList.toggle('btn--on', showAll);
    load();
  });
  document.getElementById('cReload').addEventListener('click', load);

  /**
   * 自动分类：**先预览再执行**。
   * 分类会改半衰期（一条工作记忆被误判成情感，60 天就衰减掉了），所以不能一键静默改完。
   */
  document.getElementById('cConsolidate').addEventListener('click', async () => {
    const box = document.getElementById('cConsBox');
    box.innerHTML = '<div class="hint">正在找同一件事的多条记录…</div>';
    try {
      const data = await api('/consolidate');
      if (!data.groups.length) {
        box.innerHTML = '<div class="hint">没有找到需要归纳的组（同一件事至少出现 3 次才会入选）。</div>';
        return;
      }
      box.innerHTML = `
        <div class="item">
          <div class="itemHead">
            <strong>归纳候选（${data.groups.length} 组）</strong>
            <span class="hint">原文一条都不会删；整合后碎片退出自动回忆，但还能搜到</span>
          </div>
          ${data.groups.slice(0, 20).map((g) => `
            <div class="item" style="margin-top:8px">
              <div class="meta">
                <span class="tag">${esc(g.by === 'similar' ? '同一件事' : '同一话题')}</span>
                <span class="tag">${esc(g.tag)}</span>
                <span class="tag">${g.size} 条</span>
                ${g.spanDays ? `<span class="tag">跨度 ${g.spanDays} 天</span>` : ''}
              </div>
              <div class="body" style="margin-top:6px">${esc(g.suggestedContent)}</div>
              <div class="itemActions">
                <button class="btn btn--primary" data-cons="${esc(g.id)}">应用这组</button>
              </div>
            </div>`).join('')}
        </div>`;

      for (const btn of box.querySelectorAll('[data-cons]')) {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-cons');
          btn.disabled = true;
          try {
            const r = await api('/consolidate', { method: 'POST', body: JSON.stringify({ dryRun: false, id }) });
            toast(`已归纳：影响 ${r.affected} 条原文`);
            box.innerHTML = '';
            await load();
            await refreshMeta();
          } catch (err) {
            btn.disabled = false;
            toast('归纳失败：' + err.message, true);
          }
        });
      }
    } catch (err) {
      box.innerHTML = `<div class="err">读取失败：${esc(err.message)}</div>`;
    }
  });

  document.getElementById('cAuto').addEventListener('click', async () => {
    autoBox.innerHTML = '<div class="hint">分析中…</div>';
    try {
      const preview = await api('/classify/auto', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
      if (!preview.scanned) {
        autoBox.innerHTML = '<div class="hint">没有未分类的记忆，不用补。</div>';
        return;
      }
      const byTo = preview.byTo || {};
      const fmt = Object.keys(byTo).map((k) => `${KIND_LABELS[k] || k} ${byTo[k]}`).join(' · ');
      const samples = (preview.samples || []).map((s) => `
        <div class="hint" style="margin:3px 0">
          <span class="tag">${esc(KIND_LABELS[s.to] || s.to)}</span>
          ${esc(compact(s.content, 70))}
          <span style="opacity:.7">（${esc(s.why)}）</span>
        </div>`).join('');
      autoBox.innerHTML = `
        <div class="item" style="margin-top:8px">
          <div class="meta">
            扫描 ${preview.scanned} 条未分类，可推断出：${esc(fmt)}
          </div>
          <div style="margin-top:6px">${samples}</div>
          <div class="hint" style="margin-top:6px">推断不出的会保持未分类，留给你手动处理。</div>
          <div class="bar" style="margin-top:8px">
            <button class="btn btn--primary" id="cAutoDo">应用到 ${preview.scanned - (byTo.unknown || 0)} 条</button>
            <button class="btn" id="cAutoCancel">取消</button>
          </div>
        </div>`;
      document.getElementById('cAutoCancel').onclick = () => { autoBox.innerHTML = ''; };
      document.getElementById('cAutoDo').onclick = async () => {
        try {
          const r = await api('/classify/auto', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
          toast(`已自动分类 ${r.updated} 条`);
          autoBox.innerHTML = '';
          await load();
          await refreshMeta();
        } catch (err) { toast('失败：' + err.message, true); }
      };
    } catch (err) {
      autoBox.innerHTML = `<div class="err">分析失败：${esc(err.message)}</div>`;
    }
  });

  load();
  return () => {};
}

/* ══════════════════════════════════════════════════════════════════════
 * 直觉：该想起的 + 疑似冲突
 * ══════════════════════════════════════════════════════════════════════ */

function renderInsight() {
  view.innerHTML = `
    <div class="scroll">
      <div class="item">
        <div class="itemHead">
          <strong>该想起的</strong>
          <span class="hint">重要、放了很久、几乎没被用过的那几条</span>
          <button class="btn" id="iReload" style="margin-left:auto">刷新</button>
        </div>
        <div class="hint" style="margin-top:6px">
          按「重要度 × 搁了多久 ÷ 用过几次」排。经常被用到的不会出现在这里——它们没被遗忘风险。
        </div>
        <div id="iReview" style="margin-top:8px">读取中…</div>
      </div>

      <div class="item">
        <div class="itemHead">
          <strong>疑似冲突</strong>
          <span class="hint">说同一件事、但关键处不一样的两条</span>
          <select id="iSens" style="margin-left:auto;flex:0 0 auto">
            <option value="strict">严格</option>
            <option value="normal">标准</option>
            <option value="loose">宽松</option>
          </select>
        </div>
        <div class="hint" style="margin-top:6px">
          只看痕迹，不懂语义：两条说的是同一件事（正文高度重合或语义很近），
          而且<b>出现了互斥表述</b>（需要/不需要、成功/失败…）或<b>关键值不同</b>（版本号、路径）。
          <b>这里只列候选，不会改你任何数据</b>——到底哪个对，你自己判断。
          <br />「严格」少而准，「宽松」会多挑一些（噪声也更多）。
        </div>
        <div id="iConflicts" style="margin-top:8px">读取中…</div>
      </div>
    </div>`;

  const reviewEl = document.getElementById('iReview');
  const conflictEl = document.getElementById('iConflicts');

  function renderReview(rows) {
    if (!rows.length) {
      reviewEl.innerHTML = '<div class="empty">暂时没有需要复习的。写了不到 14 天的、经常被用到的都不会列在这里。</div>';
      return;
    }
    reviewEl.innerHTML = rows.map((r) => `
      <div class="item" style="margin-bottom:8px">
        <div class="itemHead">
          <div class="meta">
            <span class="tag tag--warn">${esc(r.why)}</span>
            ${r.kind && r.kind !== 'unknown' ? `<span class="tag">${esc(KIND_LABELS[r.kind] || r.kind)}</span>` : ''}
            ${r.project ? `<span class="tag">${esc(r.project)}</span>` : ''}
          </div>
          <span class="mono">${esc(r.id)}</span>
        </div>
        <details style="margin-top:6px">
          <summary class="body" style="cursor:pointer">${esc(compact(r.content, 110))}</summary>
          <div class="body" style="margin-top:6px;white-space:pre-wrap">${esc(r.content)}</div>
        </details>
      </div>`).join('');
  }

  function renderConflicts(pairs) {
    if (!pairs.length) {
      conflictEl.innerHTML = '<div class="empty">没找到疑似冲突。这通常是好事——说明记忆之间没有互相打架的结论。</div>';
      return;
    }
    conflictEl.innerHTML = pairs.map((p, idx) => `
      <div class="item" style="margin-bottom:10px">
        <div class="itemHead">
          <div class="meta">
            <span class="tag tag--warn">第 ${idx + 1} 对 · 强度 ${p.score}</span>
            ${p.reasons.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}
          </div>
        </div>
        <div class="pairGrid" style="margin-top:8px">
          <div>
            <div class="meta"><span class="tag">A · ${esc(ageLabel(p.a.createdAt))}</span><span class="mono">${esc(p.a.id)}</span></div>
            <div class="body" style="margin-top:4px;white-space:pre-wrap">${esc(compact(p.a.content, 260))}</div>
          </div>
          <div>
            <div class="meta"><span class="tag">B · ${esc(ageLabel(p.b.createdAt))}</span><span class="mono">${esc(p.b.id)}</span></div>
            <div class="body" style="margin-top:4px;white-space:pre-wrap">${esc(compact(p.b.content, 260))}</div>
          </div>
        </div>
      </div>`).join('');
  }

  async function load() {
    reviewEl.textContent = '读取中…';
    conflictEl.textContent = '读取中…';
    try {
      const r = await api('/insight');
      if (r.disabled) {
        reviewEl.innerHTML = '<div class="empty">「该想起的」和「疑似冲突」都在设置里关掉了。</div>';
        conflictEl.innerHTML = '';
        return;
      }
      if (r.sensitivity) document.getElementById('iSens').value = r.sensitivity;
      renderReview(r.dueReview || []);
      renderConflicts(r.conflicts || []);
      if (r.conflictNote) {
        conflictEl.insertAdjacentHTML('afterbegin', `<div class="hint">${esc(r.conflictNote)}</div>`);
      }
    } catch (err) {
      reviewEl.textContent = '读取失败：' + err.message;
      conflictEl.textContent = '';
    }
  }

  document.getElementById('iReload').addEventListener('click', load);
  document.getElementById('iSens').addEventListener('change', async (ev) => {
    try {
      await api('/config', { method: 'POST', body: JSON.stringify({ conflictSensitivity: ev.target.value }) });
      toast('灵敏度：' + ev.target.selectedOptions[0].textContent);
      await load();
    } catch (err) { toast('保存失败：' + err.message, true); }
  });
  load();
  return () => {};
}

/* ══════════════════════════════════════════════════════════════════════
 * 设置
 * ══════════════════════════════════════════════════════════════════════ */

function renderSettings() {
  view.innerHTML = `
    <div class="scroll" id="sScroll">
      <div class="item">
        <div class="itemHead"><strong>概况</strong></div>
        <div class="meta" id="sOverview">读取中…</div>
      </div>

      <div class="item">
        <div class="itemHead">
          <strong>语义检索（embedding，可选）</strong>
          <span class="hint" id="sEmbState"></span>
        </div>
        <div class="hint" style="margin:6px 0">
          开启后会调用外部向量服务。填 OpenAI 兼容的 <code>/embeddings</code> 端点即可
          （硅基流动、智谱、Jina、OpenAI 都兼容）。<b>DeepSeek 没有 embedding 接口</b>，它的 key 用在这里没用。
          不填/失败时自动退回关键词检索，不影响使用。
        </div>
        <div class="row"><span class="label">启用</span>
          <input type="checkbox" id="eEnabled" />
          <span class="hint">勾上并保存后生效</span>
        </div>
        <div class="row"><span class="label">端点</span>
          <input type="text" id="eBase" placeholder="https://api.siliconflow.cn/v1" style="flex:0 1 420px" />
        </div>
        <div class="row"><span class="label">模型</span>
          <input type="text" id="eModel" placeholder="BAAI/bge-m3" style="flex:0 1 240px" />
        </div>
        <div class="row"><span class="label">密钥</span>
          <input type="password" id="eKey" placeholder="留空=不修改" style="flex:0 1 420px" />
          <span class="hint" id="eKeyHint"></span>
        </div>
        <div class="row">
          <button class="btn btn--primary" id="eSave">保存</button>
          <button class="btn" id="eTest">测试连接</button>
          <button class="btn" id="eBackfill">给历史记忆补向量</button>
          <span class="hint" id="eResult"></span>
        </div>
        <div class="hint" id="eCoverage" style="margin-top:6px"></div>
      </div>

      <div class="item">
        <div class="itemHead">
          <strong>功能开关</strong>
          <span class="hint">只影响显示，不会删任何数据；关掉的东西随时能开回来</span>
        </div>
        <div id="fList" style="margin-top:8px"></div>
        <div class="row" style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
          <span class="label">冲突灵敏度</span>
          <select id="fSens" style="flex:0 1 160px">
            <option value="strict">严格（少而准）</option>
            <option value="normal">标准</option>
            <option value="loose">宽松（多而杂）</option>
          </select>
          <span class="hint" id="fSensHint">嫌「疑似冲突」太少就调宽松，嫌吵就调严格</span>
          <button class="btn" id="fReset" style="margin-left:auto">恢复默认</button>
        </div>
      </div>

      <div class="item">
        <div class="itemHead">
          <strong>衰减速度（半衰期）</strong>
          <span class="hint">数字＝多少天后"相关度"掉一半。只影响排序，永不删数据</span>
        </div>
        <div class="hint" style="margin:6px 0">
          想让某类记忆留得更久就调大，想让它快点沉下去就调小。范围 7 ~ 3650 天。
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:8px">
          <label class="row" style="gap:6px">
            <span class="label">工作</span>
            <input class="input" type="number" id="hlWork" min="7" max="3650" step="1" style="width:90px" />
            <span class="hint">天</span>
          </label>
          <label class="row" style="gap:6px">
            <span class="label">偏好</span>
            <input class="input" type="number" id="hlPreference" min="7" max="3650" step="1" style="width:90px" />
            <span class="hint">天</span>
          </label>
          <label class="row" style="gap:6px">
            <span class="label">情感</span>
            <input class="input" type="number" id="hlEmotion" min="7" max="3650" step="1" style="width:90px" />
            <span class="hint">天</span>
          </label>
          <label class="row" style="gap:6px">
            <span class="label">未分类</span>
            <input class="input" type="number" id="hlUnknown" min="7" max="3650" step="1" style="width:90px" />
            <span class="hint">天</span>
          </label>
        </div>
        <div class="row" style="margin-top:10px">
          <span class="hint" id="hlHint"></span>
          <button class="btn btn--primary" id="hlSave" style="margin-left:auto">保存衰减设置</button>
        </div>
      </div>

      <div class="item">
        <div class="itemHead"><strong>维护</strong><span class="hint" id="mInfo"></span></div>
        <div class="hint" style="margin:6px 0">
          维护只做安全的事：清掉指向已删除记忆的孤儿关系、记一份统计快照。
          <b>不会自动删任何记忆</b>。
        </div>
        <div class="row"><span class="label">间隔</span>
          <input type="number" id="mDays" min="1" max="365" style="width:90px" />
          <span class="hint">天（超过这个间隔，下次用到库时自动跑一次）</span>
        </div>
        <div class="row">
          <button class="btn" id="mSave">保存间隔</button>
          <button class="btn" id="mRun">立即维护一次</button>
          <span class="hint" id="mResult"></span>
        </div>
      </div>

      <div class="item">
        <div class="itemHead"><strong>数据</strong></div>
        <div class="meta" id="sPaths"></div>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="sExport">导出 Markdown</button>
          <span class="hint">导出的文件可以用任何编辑器打开，也能带到别的电脑</span>
        </div>
      </div>
    </div>`;

  const $ = (id) => document.getElementById(id);

  /** 衰减速度保存：四个数字一起提交，后端会夹到 7~3650 */
  $('hlSave').addEventListener('click', async () => {
    const read = (id, fallback) => {
      const n = Number($(id).value);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
    };
    try {
      await api('/config', {
        method: 'POST',
        body: JSON.stringify({
          halfLifeDays: {
            work: read('hlWork', 365),
            preference: read('hlPreference', 730),
            emotion: read('hlEmotion', 60),
            unknown: read('hlUnknown', 365),
          },
        }),
      });
      toast('衰减设置已保存');
      await refreshMeta();
    } catch (err) { toast('保存失败：' + err.message, true); }
  });

  /**
   * 功能开关清单。文案里写清"关了会失去什么"，因为开关本身不该需要猜。
   * 顺序按"最有用的在前"排。
   */
  const FEATURES = [
    ['semanticEdges', '语义连线', '图上按向量相似度连紫色点线。用已有向量，不额外花钱'],
    ['conflictMarks', '疑似冲突标黄', '关系图上把疑似冲突的记忆标黄圈'],
    ['conflictScan', '疑似冲突扫描', '直觉页列出"说同一件事但关键处不一样"的两条'],
    ['dueReview', '该想起的', '直觉页列出重要、搁得久、几乎没用过的记忆'],
    ['projectEdges', '同项目边（弱）', '只说明"同一摊事"。59 条同项目曾连出 1711 条边的毛线球，默认关'],
    ['timeEdges', '时间相邻边', '本身信息量很低，但它是把记忆按时间串开的力——关掉后布局会塌成一团'],
    ['softForget', '软遗忘（降权不删）', '长期没用过的低价值记忆会往后排，但一条都不会删；关掉＝纯按相关度和时间排'],
    ['autoKind', '写入时自动分类', '按内容粗分工作/偏好/情感，决定衰减速度；误判可以到补标页改'],
  ];

  function renderFeatures(feat) {
    $('fList').innerHTML = FEATURES.map(([key, label, desc]) => `
      <div class="row" style="align-items:flex-start">
        <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" data-feat="${key}" ${feat[key] ? 'checked' : ''} style="margin-top:3px" />
          <span>
            <b>${esc(label)}</b>
            <span class="hint" style="display:block">${esc(desc)}</span>
          </span>
        </label>
      </div>`).join('');

    for (const el of $('fList').querySelectorAll('[data-feat]')) {
      el.addEventListener('change', async () => {
        const key = el.getAttribute('data-feat');
        try {
          await api('/config', { method: 'POST', body: JSON.stringify({ features: { [key]: el.checked } }) });
          toast((el.checked ? '已开启：' : '已关闭：') + (FEATURES.find((f) => f[0] === key)[1]));
          await refreshMeta();
        } catch (err) {
          el.checked = !el.checked;   // 存不上就回滚勾选，别让人以为生效了
          toast('保存失败：' + err.message, true);
        }
      });
    }
  }

  function fillState(s) {
    const kinds = (s.stats.byKind || []).map((k) => (KIND_LABELS[k.kind] || k.kind) + ' ' + k.c).join(' · ');
    $('sOverview').innerHTML = [
      `<span class="tag">${s.stats.total} 条记忆</span>`,
      `<span class="tag">${esc(s.backend)}</span>`,
      `<span>未用过 ${s.stats.neverUsed} 条</span>`,
      `<span>${esc(kinds)}</span>`,
      s.maintenance && s.maintenance.lastAt
        ? `<span>上次维护 ${s.maintenance.lastAgoDays} 天前</span>` : '<span>还没维护过</span>',
    ].join('');

    const e = s.config.embedding || {};
    $('eEnabled').checked = e.enabled === true;
    $('eBase').value = e.baseUrl || '';
    $('eModel').value = e.model || '';
    $('eKey').value = '';
    const stored = Boolean(e.hasStoredKey);
    $('eKey').placeholder = stored ? '已配置（留空=不修改）' : '粘贴密钥，或留空用环境变量';
    $('eKeyHint').textContent = stored ? '已保存' : (s.embedding && s.embedding.hasKey ? '来自环境变量' : '未配置');

    const emb = s.embedding || {};
    $('sEmbState').textContent = emb.enabled ? `已启用 · ${emb.model || ''}` : '未启用（走关键词检索）';
    const v = emb.vectors || { total: 0, withVector: 0, models: [] };
    $('eCoverage').textContent = `向量覆盖：${v.withVector} / ${v.total} 条`
      + (v.models && v.models.length ? `　模型：${v.models.map((m) => m.model + '(' + m.c + ')').join('、')}` : '');

    $('mDays').value = String(s.config.maintenanceIntervalDays || 7);
    renderFeatures(s.config.features || {});
    // 衰减速度：把当前值填进输入框
    const hl = s.config.halfLifeDays || {};
    $('hlWork').value = String(hl.work ?? 365);
    $('hlPreference').value = String(hl.preference ?? 730);
    $('hlEmotion').value = String(hl.emotion ?? 60);
    $('hlUnknown').value = String(hl.unknown ?? 365);
    $('hlHint').textContent = `情感 ${hl.emotion ?? 60} 天半衰 ＝ 两个月后相关度剩一半；改完只影响排序`;
    $('fSens').value = s.config.conflictSensitivity || 'normal';
    $('mInfo').textContent = s.maintenance && s.maintenance.lastAt
      ? `上次 ${new Date(s.maintenance.lastAt).toLocaleString()}`
      : '还没跑过';

    $('sPaths').innerHTML = [
      `<span class="mono">库：${esc((s.paths && s.paths.db) || '—')}</span>`,
      `<span class="mono">配置：${esc((s.paths && s.paths.config) || '—')}</span>`,
    ].join('');
  }

  async function load() {
    try {
      const s = await api('/state');
      fillState(s);
    } catch (err) {
      $('sOverview').textContent = '读取失败：' + err.message;
    }
  }

  $('eSave').addEventListener('click', async () => {
    const embedding = {
      enabled: $('eEnabled').checked,
      baseUrl: $('eBase').value.trim(),
      model: $('eModel').value.trim(),
    };
    const key = $('eKey').value.trim();
    if (key) embedding.apiKey = key;           // 留空就不覆盖已有 key
    try {
      await api('/config', { method: 'POST', body: JSON.stringify({ embedding }) });
      toast('已保存');
      await load();
      await refreshMeta();
    } catch (err) { toast('保存失败：' + err.message, true); }
  });

  $('eTest').addEventListener('click', async () => {
    $('eResult').textContent = '测试中…';
    try {
      const r = await api('/embedding/test', { method: 'POST' });
      $('eResult').textContent = r.ok
        ? `连接成功：维度 ${r.dim}，耗时 ${r.ms}ms`
        : `失败：${r.error || '未知原因'}`;
      $('eResult').style.color = r.ok ? '' : '#f0a6a4';
    } catch (err) {
      $('eResult').textContent = '失败：' + err.message;
      $('eResult').style.color = '#f0a6a4';
    }
    await load();
  });

  $('eBackfill').addEventListener('click', async () => {
    $('eResult').textContent = '补向量中…（一次补 20 条，可重复点）';
    try {
      const r = await api('/embedding/backfill', { method: 'POST' });
      $('eResult').textContent = r.ok
        ? `本次补了 ${r.result.filled} 条，还剩 ${r.result.remaining} 条`
        : `失败：${r.result.error || '未知原因'}`;
    } catch (err) { $('eResult').textContent = '失败：' + err.message; }
    await load();
  });

  $('fSens').addEventListener('change', async () => {
    try {
      await api('/config', { method: 'POST', body: JSON.stringify({ conflictSensitivity: $('fSens').value }) });
      toast('灵敏度已保存');
    } catch (err) { toast('保存失败：' + err.message, true); }
  });

  $('fReset').addEventListener('click', async () => {
    try {
      const def = await api('/state?defaults=1');
      await api('/config', { method: 'POST', body: JSON.stringify({ features: def.defaults.features }) });
      toast('已恢复默认');
      await load();
    } catch (err) { toast('恢复失败：' + err.message, true); }
  });

  $('mSave').addEventListener('click', async () => {
    try {
      await api('/config', { method: 'POST', body: JSON.stringify({ maintenanceIntervalDays: Number($('mDays').value) }) });
      toast('已保存');
      await load();
    } catch (err) { toast('保存失败：' + err.message, true); }
  });

  $('mRun').addEventListener('click', async () => {
    $('mResult').textContent = '执行中…';
    try {
      const r = await api('/maintenance', { method: 'POST' });
      const o = r.result.orphans || {};
      $('mResult').textContent = `完成：清理孤儿共现 ${o.cooccur || 0} 条、更新 ${o.updates || 0} 条、向量 ${o.vectors || 0} 条`;
      await load();
      await refreshMeta();
    } catch (err) { $('mResult').textContent = '失败：' + err.message; }
  });

  $('sExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = API + '/export';
    a.download = 'dsh-local-memory.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  load();
  return () => {};
}

/* ══════════════════════════════════════════════════════════════════════
 * 外壳
 * ══════════════════════════════════════════════════════════════════════ */

const TABS = { graph: renderGraph, list: renderList, classify: renderClassify, insight: renderInsight, settings: renderSettings };

function switchTab(name) {
  if (cleanup) { try { cleanup(); } catch { /* 忽略 */ } cleanup = null; }
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('tab--on', b.dataset.tab === name));
  cleanup = TABS[name]() || null;
  location.hash = name;
}

document.getElementById('tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});

// hash 形如 #graph/cards：第一个是页签，第二个是关系图的渲染模式
const hashParts = (location.hash || '#graph').slice(1).split('/');
const initialTab = TABS[hashParts[0]] ? hashParts[0] : 'graph';
if (hashParts[1] === 'cards' || hashParts[1] === 'dots') graphMode = hashParts[1];
switchTab(initialTab);
refreshMeta();
setInterval(refreshMeta, 20000);
