/**
 * dsh-local-memory v2 — 浏览器半侧（设置页「本地记忆」）
 *
 * 手写 ModuleLoader bundle，**无需构建步骤**：注册 id 必须等于 loader entry 名。
 *
 * 两个页签：
 *   1) 关系图 —— 手写 canvas 力导向布局（不引任何图库），看记忆怎么扎堆、哪些是孤岛
 *   2) 列表   —— 搜索 / 新增 / 编辑 / 删除 / 恢复
 *
 * 所有数据来自 Host 半侧的 HTTP 接口（/dsh-local-memory/*），前端不自己算关系——
 * 边是服务端算好的（见 src/core/graph.js 里的四类确定性关系与防毛线球防线）。
 *
 * 布局算法是纯函数、无 DOM 依赖，并且通过 exports.__internals 暴露给单元测试
 * （见 test/client.test.mjs）——动画最容易出的 bug 是"坐标变 NaN 后整张图消失"，
 * 那种 bug 只能在数学层面抓。
 */

window.__ModuleLoader__.load({
  id: 'dsh-local-memory',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useRef, useCallback } = react;

    const API = '/dsh-local-memory';

    /* ════════════════════════════════════════════════════════════════════════
     * 一、纯函数部分（可测）
     * ════════════════════════════════════════════════════════════════════════ */

    /** 记忆类别 → 颜色。unknown 用中性灰，避免历史数据抢视觉焦点。 */
    const KIND_COLORS = {
      work: '#4a90d9',
      preference: '#d9a04a',
      emotion: '#d95a8a',
      unknown: '#8a8f98',
    };

    const KIND_LABELS = {
      work: '工作',
      preference: '偏好',
      emotion: '情感',
      unknown: '未分类',
    };

    /** 边的视觉编码：共现最粗最亮，时间相邻最淡 */
    const EDGE_STYLES = {
      cooccur: { color: 'rgba(255,170,60,0.95)', width: 2.4, dash: null, label: '共现' },
      tag: { color: 'rgba(90,160,255,0.55)', width: 1.4, dash: null, label: '共享标签' },
      semantic: { color: 'rgba(186,140,255,0.6)', width: 1.0, dash: [2, 4], label: '语义相近' },
      project: { color: 'rgba(120,200,160,0.40)', width: 1.1, dash: null, label: '同项目' },
      time: { color: 'rgba(160,160,170,0.20)', width: 0.9, dash: [3, 4], label: '时间相邻' },
    };

    function kindColor(kind) {
      return KIND_COLORS[kind] || KIND_COLORS.unknown;
    }

    function edgeStyle(kind) {
      return EDGE_STYLES[kind] || EDGE_STYLES.time;
    }

    /**
     * 建一个力导向布局状态。
     *
     * 初始位置沿圆周铺开：如果全部从原点出发，斥力在第一步会算出 0 距离，
     * 除以接近 0 的数会瞬间把坐标炸成 NaN/Infinity，整张图直接消失。
     * 哪怕加成半径，也比事后加一堆 isFinite 判断干净。
     */
    function createLayout(nodes, edges, opts = {}) {
      const count = nodes.length;
      const radius = opts.radius || Math.max(120, Math.sqrt(count) * 40);

      const ids = new Map();
      nodes.forEach((node, i) => ids.set(node.id, i));

      const px = new Float64Array(count);
      const py = new Float64Array(count);
      const vx = new Float64Array(count);
      const vy = new Float64Array(count);

      for (let i = 0; i < count; i++) {
        const angle = (i / Math.max(1, count)) * Math.PI * 2;
        // 轻微的半径抖动，避免完美对称导致力平衡卡住
        const r = radius * (0.75 + ((i * 37) % 100) / 400);
        px[i] = Math.cos(angle) * r;
        py[i] = Math.sin(angle) * r;
      }

      const links = [];
      for (const edge of edges) {
        const a = ids.get(edge.source);
        const b = ids.get(edge.target);
        if (a === undefined || b === undefined || a === b) continue;
        links.push({ a, b, weight: Math.max(0.05, Number(edge.weight) || 1), kind: edge.kind });
      }

      return { count, ids, px, py, vx, vy, links, alpha: 1, iterations: 0 };
    }

    /**
     * 推进一帧。参数刻意都写在外面，方便测试直接给定固定输入。
     *
     * 力：
     *   - 斥力 O(n²)：强度与权重无关，只跟距离有关（近处软化，避免奇点）
     *   - 弹簧：每条边把两点拉向 restLength，权重越大越硬
     *   - 向心力：所有点被轻轻拉向原点，防止整图漂走
     *   - 阻尼 + 速度上限：保证数值稳定，不会越算越大
     */
    function stepLayout(L, opts = {}) {
      const {
        repulsion = 900,
        springLength = 70,
        stiffness = 0.02,
        gravity = 0.004,
        damping = 0.82,
        maxSpeed = 30,
        alphaDecay = 0.985,
        minAlpha = 0.02,
      } = opts;

      const { count, px, py, vx, vy, links } = L;
      if (count === 0) return L;

      // 斥力
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          let dx = px[j] - px[i];
          let dy = py[j] - py[i];
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-4) {
            // 完全重合：给一个确定的微小偏移，而不是让 1/0 变成 Infinity
            dx = 0.01 * (i + 1);
            dy = 0.01 * (j + 1);
            d2 = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(d2);
          const force = repulsion / (d2 + 50);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          vx[i] -= fx;
          vy[i] -= fy;
          vx[j] += fx;
          vy[j] += fy;
        }
      }

      // 弹簧
      for (const link of links) {
        const dx = px[link.b] - px[link.a];
        const dy = py[link.b] - py[link.a];
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-4;
        const k = stiffness * Math.min(3, link.weight);
        const delta = dist - springLength;
        const fx = (dx / dist) * delta * k;
        const fy = (dy / dist) * delta * k;
        vx[link.a] += fx;
        vy[link.a] += fy;
        vx[link.b] -= fx;
        vy[link.b] -= fy;
      }

      // 向心力 + 积分
      for (let i = 0; i < count; i++) {
        vx[i] = (vx[i] - px[i] * gravity) * damping;
        vy[i] = (vy[i] - py[i] * gravity) * damping;

        // 限速：没有这个，一次异常大的力就会把点甩到几万像素外
        const speed = Math.hypot(vx[i], vy[i]);
        if (speed > maxSpeed) {
          vx[i] = (vx[i] / speed) * maxSpeed;
          vy[i] = (vy[i] / speed) * maxSpeed;
        }

        px[i] += vx[i];
        py[i] += vy[i];

        // 兜底：理论上到不了这里，但真到了也不能让整张图变 NaN
        if (!Number.isFinite(px[i]) || !Number.isFinite(py[i])) {
          const angle = (i / Math.max(1, count)) * Math.PI * 2;
          px[i] = Math.cos(angle) * 100;
          py[i] = Math.sin(angle) * 100;
          vx[i] = 0;
          vy[i] = 0;
        }
      }

      L.alpha = Math.max(minAlpha, L.alpha * alphaDecay);
      L.iterations += 1;
      return L;
    }

    /** 布局是否已经收敛（收敛后停 rAF，省电） */
    function isSettled(L) {
      return L.alpha <= 0.021;
    }

    /** 世界坐标包围盒，用于「适应窗口」 */
    function bounds(L) {
      if (L.count === 0) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (let i = 0; i < L.count; i++) {
        if (L.px[i] < minX) minX = L.px[i];
        if (L.py[i] < minY) minY = L.py[i];
        if (L.px[i] > maxX) maxX = L.px[i];
        if (L.py[i] > maxY) maxY = L.py[i];
      }
      return { minX, minY, maxX, maxY };
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 二、样式
     * ════════════════════════════════════════════════════════════════════════ */

    const CSS = `
      .__lm2_root { display:flex; flex-direction:column; gap:12px; font-size:13px; }
      .__lm2_tabs { display:flex; gap:4px; border-bottom:1px solid rgba(128,128,128,.25); }
      .__lm2_tab { padding:6px 14px; cursor:pointer; border:none; background:none;
        color:inherit; opacity:.65; border-bottom:2px solid transparent; font-size:13px; }
      .__lm2_tab:hover { opacity:.9; }
      .__lm2_tab--on { opacity:1; border-bottom-color:#4a90d9; font-weight:600; }
      .__lm2_bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .__lm2_btn { padding:4px 10px; border-radius:5px; cursor:pointer; font-size:12px;
        border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.10); color:inherit; }
      .__lm2_btn:hover { background:rgba(128,128,128,.20); }
      .__lm2_btn:disabled { opacity:.45; cursor:default; }
      .__lm2_btn--on { border-color:#4a90d9; background:rgba(74,144,217,.18); }
      .__lm2_input { padding:4px 8px; border-radius:5px; font-size:12px; color:inherit;
        border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08); }
      .__lm2_hint { opacity:.6; font-size:12px; }
      .__lm2_err { color:#d9534f; font-size:12px; }
      .__lm2_graphWrap { position:relative; display:flex; gap:10px; }
      .__lm2_canvasBox { position:relative; flex:1 1 auto; min-height:480px;
        border:1px solid rgba(128,128,128,.22); border-radius:8px; overflow:hidden;
        background:rgba(128,128,128,.04); }
      .__lm2_canvas { display:block; width:100%; height:100%; cursor:grab; }
      .__lm2_canvas--dragging { cursor:grabbing; }
      .__lm2_legend { position:absolute; left:10px; bottom:10px; display:flex; gap:10px;
        font-size:11px; opacity:.75; pointer-events:none; flex-wrap:wrap; max-width:80%; }
      .__lm2_legendItem { display:flex; align-items:center; gap:4px; }
      .__lm2_swatch { width:14px; height:2px; display:inline-block; }
      .__lm2_dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
      .__lm2_side { width:300px; flex:0 0 300px; overflow:auto; max-height:520px;
        border:1px solid rgba(128,128,128,.22); border-radius:8px; padding:10px; }
      .__lm2_sideTitle { font-weight:600; margin-bottom:6px; }
      .__lm2_meta { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; font-size:11px; opacity:.8; }
      .__lm2_tag { padding:1px 6px; border-radius:9px; background:rgba(128,128,128,.18); }
      .__lm2_body { white-space:pre-wrap; line-height:1.55; font-size:12px; }
      .__lm2_list { display:flex; flex-direction:column; gap:8px; }
      .__lm2_item { border:1px solid rgba(128,128,128,.22); border-radius:8px; padding:8px 10px; }
      .__lm2_itemHead { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      .__lm2_mono { font-family:ui-monospace,Consolas,monospace; font-size:11px; opacity:.55; }
      .__lm2_stat { font-size:12px; opacity:.75; }
    `;

    let styleInjected = false;
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="dsh-local-memory"]')) {
        styleInjected = true;
        return;
      }
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin', 'dsh-local-memory');
      tag.textContent = CSS;
      document.head.appendChild(tag);
      styleInjected = true;
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 三、工具
     * ════════════════════════════════════════════════════════════════════════ */

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
     * 轻量行内渲染：记忆正文里常带 markdown（`**重点**`、`\`code\``、`[文字](链接)`），
     * 原样显示会满屏星号。这里只做"去掉语法符号、保留文字"，不做完整 markdown——
     * 记忆是要读的事实，不是要排版的文章。
     */
    function inlineText(input) {
      return String(input == null ? '' : input)
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .trim();
    }

    /**
     * 截断。**在 JS 里截，不靠 CSS 高度裁**：
     * CSS 裁剪依赖行高和容器高度，换个字体/缩放就裁得不对；
     * 字符串截断在任何渲染器里都确定生效。
     */
    function compact(input, max) {
      const text = inlineText(input);
      return text.length > max ? text.slice(0, max) + '…' : text;
    }

    async function jsonFetch(url, init) {
      const res = await fetch(url, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      return data;
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 四、关系图页签
     * ════════════════════════════════════════════════════════════════════════ */

    function GraphTab() {
      const [graph, setGraph] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(false);
      const [filter, setFilter] = useState('');
      const [isolatedOnly, setIsolatedOnly] = useState(false);
      const [selected, setSelected] = useState(null);
      const [stats, setStats] = useState('');

      const canvasRef = useRef(null);
      const boxRef = useRef(null);
      const viewRef = useRef({ scale: 1, x: 0, y: 0 });
      const layoutRef = useRef(null);
      const rafRef = useRef(0);
      const hoverRef = useRef(-1);
      const dragRef = useRef(null);
      const settledToldRef = useRef(false);

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const data = await jsonFetch(API + '/graph');
          // 只保留当前视图里要画的点
          let nodes = data.nodes || [];
          const edges = data.edges || [];
          if (isolatedOnly) {
            const keep = new Set(nodes.filter((n) => n.isolated).map((n) => n.id));
            nodes = nodes.filter((n) => keep.has(n.id));
          }
          const ids = new Set(nodes.map((n) => n.id));
          const keptEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));

          const layout = createLayout(nodes, keptEdges);
          layoutRef.current = layout;
          layoutRef.current.nodes = nodes;
          layoutRef.current.edges = keptEdges;
          viewRef.current = { scale: 1, x: 0, y: 0 };
          settledToldRef.current = false;
          setGraph({ nodes, edges: keptEdges, stats: data.stats || {} });
          setStats('');
          setSelected(null);
        } catch (e) {
          setError('读取关系图失败：' + String((e && e.message) || e));
        } finally {
          setLoading(false);
        }
      }, [isolatedOnly]);

      useEffect(() => { load(); }, [load]);

      /* ── 主渲染循环：收敛后自动停，交互时再启动 ── */
      useEffect(() => {
        const canvas = canvasRef.current;
        const box = boxRef.current;
        if (!canvas || !box) return undefined;

        let stopped = false;

        const resize = () => {
          const dpr = window.devicePixelRatio || 1;
          const w = box.clientWidth || 640;
          const hh = box.clientHeight || 480;
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(hh * dpr);
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();

        const observer = typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(resize)
          : null;
        if (observer) observer.observe(box);

        const draw = () => {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const w = canvas.width / (window.devicePixelRatio || 1);
          const hh = canvas.height / (window.devicePixelRatio || 1);

          ctx.clearRect(0, 0, w, hh);

          const L = layoutRef.current;
          if (!L || L.count === 0) return;

          const view = viewRef.current;
          const toScreen = (wx, wy) => [
            (wx + view.x) * view.scale + w / 2,
            (wy + view.y) * view.scale + hh / 2,
          ];

          // 边
          for (const e of L.edges) {
            const a = L.ids.get(e.source);
            const b = L.ids.get(e.target);
            if (a === undefined || b === undefined) continue;
            const style = edgeStyle(e.kind);
            const [x1, y1] = toScreen(L.px[a], L.py[a]);
            const [x2, y2] = toScreen(L.px[b], L.py[b]);
            ctx.save();
            ctx.strokeStyle = style.color;
            ctx.lineWidth = Math.max(0.6, style.width * Math.min(1.6, view.scale));
            if (style.dash) ctx.setLineDash(style.dash);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.restore();
          }

          // 点
          const needle = filter.trim().toLowerCase();
          for (let i = 0; i < L.count; i++) {
            const node = L.nodes[i];
            const [x, y] = toScreen(L.px[i], L.py[i]);
            const r = Math.max(3.5, Math.min(11, 4 + Math.log1p(node.degree || 0) * 1.8)) * view.scale;
            const dim = needle && !(
              node.label.toLowerCase().includes(needle)
              || (node.tags || []).some((t) => String(t).toLowerCase().includes(needle))
            );
            ctx.save();
            ctx.globalAlpha = dim ? 0.15 : 1;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = kindColor(node.kind);
            ctx.fill();
            if (node.isolated) {
              // 孤岛描一圈虚边，一眼能看出来
              ctx.strokeStyle = 'rgba(217,83,79,.85)';
              ctx.lineWidth = 1.4;
              ctx.setLineDash([2, 2]);
              ctx.stroke();
            } else if (hoverRef.current === i) {
              ctx.strokeStyle = '#fff';
              ctx.lineWidth = 1.5;
              ctx.stroke();
            }
            ctx.restore();

            // 缩放到一定程度才显示文字，否则一团字；只标"连接较多"的点
            if (view.scale >= 1.15 && !dim && (node.linkDegree || 0) >= 3) {
              ctx.save();
              ctx.font = '10px ui-monospace,Consolas,monospace';
              const label = node.label.length > 14 ? node.label.slice(0, 14) + '…' : node.label;
              // 先描一圈深色底衬再填字：亮色文字压在密集连线上时没有底衬根本读不清
              ctx.lineWidth = 3;
              ctx.strokeStyle = 'rgba(20,22,26,0.9)';
              ctx.strokeText(label, x + r + 3, y + 3);
              ctx.fillStyle = 'rgba(215,218,224,0.95)';
              ctx.fillText(label, x + r + 3, y + 3);
              ctx.restore();
            }
          }
        };

        const tick = () => {
          if (stopped) return;
          const L = layoutRef.current;
          const dragging = dragRef.current && dragRef.current.nodeIndex >= 0;
          if (L && (!isSettled(L) || dragging)) {
            stepLayout(L);
            // 只在"刚收敛"的那一刻 setState 一次。
            // 如果每帧都 setStats，就会每帧触发重渲染 —— 一个自造的渲染死循环。
            if (!dragging && isSettled(L) && !settledToldRef.current) {
              settledToldRef.current = true;
              setStats(`已收敛（${L.iterations} 步）`);
            }
          }
          draw();
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);

        return () => {
          stopped = true;
          cancelAnimationFrame(rafRef.current);
          if (observer) observer.disconnect();
        };
      }, [graph, filter]);

      /* ── 命中测试：屏幕坐标 → 节点下标 ── */
      const hitTest = useCallback((clientX, clientY) => {
        const canvas = canvasRef.current;
        const L = layoutRef.current;
        if (!canvas || !L) return -1;
        const rect = canvas.getBoundingClientRect();
        const view = viewRef.current;
        const w = rect.width;
        const hh = rect.height;
        let best = -1;
        let bestD = 14 * 14;
        for (let i = 0; i < L.count; i++) {
          const x = (L.px[i] + view.x) * view.scale + w / 2;
          const y = (L.py[i] + view.y) * view.scale + hh / 2;
          const dx = x - (clientX - rect.left);
          const dy = y - (clientY - rect.top);
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD) { bestD = d2; best = i; }
        }
        return best;
      }, []);

      const onPointerDown = (ev) => {
        const idx = hitTest(ev.clientX, ev.clientY);
        if (idx >= 0) {
          dragRef.current = { nodeIndex: idx, startX: ev.clientX, startY: ev.clientY };
          const L = layoutRef.current;
          L.alpha = Math.max(L.alpha, 0.6); // 拖拽时重新加热，让邻居跟着动
          const node = L.nodes[idx];
          setSelected(node);
        } else {
          dragRef.current = { nodeIndex: -1, startX: ev.clientX, startY: ev.clientY, origin: { ...viewRef.current } };
        }
        ev.currentTarget.classList.add('__lm2_canvas--dragging');
      };

      const onPointerMove = (ev) => {
        const drag = dragRef.current;
        const L = layoutRef.current;
        if (!drag) {
          hoverRef.current = hitTest(ev.clientX, ev.clientY);
          return;
        }
        if (drag.nodeIndex >= 0) {
          // 屏幕坐标 → 世界坐标：先减画布中心，再换算回未缩放/未平移的坐标
          const view = viewRef.current;
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();
          L.px[drag.nodeIndex] = (ev.clientX - rect.left - rect.width / 2) / view.scale - view.x;
          L.py[drag.nodeIndex] = (ev.clientY - rect.top - rect.height / 2) / view.scale - view.y;
          L.vx[drag.nodeIndex] = 0;
          L.vy[drag.nodeIndex] = 0;
        } else {
          const view = viewRef.current;
          view.x = drag.origin.x + (ev.clientX - drag.startX) / view.scale;
          view.y = drag.origin.y + (ev.clientY - drag.startY) / view.scale;
        }
      };

      const endDrag = (ev) => {
        dragRef.current = null;
        if (ev && ev.currentTarget) ev.currentTarget.classList.remove('__lm2_canvas--dragging');
      };

      const onWheel = (ev) => {
        ev.preventDefault();
        const view = viewRef.current;
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        view.scale = Math.max(0.15, Math.min(6, view.scale * factor));
      };

      const fitView = () => {
        const L = layoutRef.current;
        const box = boxRef.current;
        if (!L || !box || L.count === 0) return;
        const b = bounds(L);
        const w = box.clientWidth || 640;
        const hh = box.clientHeight || 480;
        const scale = Math.min(
          (w - 80) / Math.max(1, b.maxX - b.minX),
          (hh - 80) / Math.max(1, b.maxY - b.minY),
        );
        viewRef.current.scale = Math.max(0.15, Math.min(3, scale));
        viewRef.current.x = -(b.minX + b.maxX) / 2;
        viewRef.current.y = -(b.minY + b.maxY) / 2;
      };

      const reheat = () => {
        const L = layoutRef.current;
        if (!L) return;
        L.alpha = 1;
        settledToldRef.current = false;
        setStats('');
      };

      return h('div', null,
        h('div', { className: '__lm2_bar', style: { marginBottom: '8px' } },
          h('input', {
            className: '__lm2_input',
            placeholder: '高亮包含…（正文或标签）',
            value: filter,
            onChange: (e) => setFilter(e.target.value),
            style: { width: '220px' },
          }),
          h('button', {
            className: '__lm2_btn' + (isolatedOnly ? ' __lm2_btn--on' : ''),
            onClick: () => setIsolatedOnly((v) => !v),
            title: '只看孤岛：没有任何语义关联（共享标签/同项目/共现）的记忆',
          }, isolatedOnly ? '孤岛视图：开' : '孤岛视图：关'),
          h('button', { className: '__lm2_btn', onClick: load, disabled: loading }, loading ? '读取中…' : '刷新'),
          h('button', { className: '__lm2_btn', onClick: reheat }, '重新布局'),
          h('button', { className: '__lm2_btn', onClick: fitView }, '适应窗口'),
          graph
            ? h('span', { className: '__lm2_stat' },
              `点 ${graph.nodes.length} · 边 ${graph.edges.length} · 孤岛 ${graph.stats.isolated || 0}`)
            : null,
          stats ? h('span', { className: '__lm2_hint' }, stats) : null,
          error ? h('span', { className: '__lm2_err' }, error) : null,
        ),
        h('div', { className: '__lm2_graphWrap' },
          h('div', { className: '__lm2_canvasBox', ref: boxRef },
            h('canvas', {
              className: '__lm2_canvas',
              ref: canvasRef,
              onPointerDown,
              onPointerMove,
              onPointerUp: endDrag,
              onPointerLeave: (ev) => { hoverRef.current = -1; endDrag(ev); },
              onWheel,
            }),
            h('div', { className: '__lm2_legend' },
              Object.keys(EDGE_STYLES).map((k) => h('span', { className: '__lm2_legendItem', key: k },
                h('span', {
                  className: '__lm2_swatch',
                  style: { background: EDGE_STYLES[k].color, height: Math.max(1, EDGE_STYLES[k].width) + 'px' },
                }),
                EDGE_STYLES[k].label,
              )),
              Object.keys(KIND_COLORS).map((k) => h('span', { className: '__lm2_legendItem', key: 'k' + k },
                h('span', { className: '__lm2_dot', style: { background: KIND_COLORS[k] } }),
                KIND_LABELS[k],
              )),
            ),
          ),
          selected
            ? h('div', { className: '__lm2_side' },
              h('div', { className: '__lm2_sideTitle' }, '记忆详情'),
              h('div', { className: '__lm2_meta' },
                selected.project ? h('span', { className: '__lm2_tag' }, selected.project) : null,
                h('span', { className: '__lm2_tag' }, KIND_LABELS[selected.kind] || selected.kind),
                h('span', null, ageLabel(selected.createdAt)),
                h('span', null, '连接 ' + (selected.linkDegree || 0)),
                selected.isolated ? h('span', { className: '__lm2_tag', style: { background: 'rgba(217,83,79,.25)' } }, '孤岛') : null,
              ),
              (selected.tags || []).length
                ? h('div', { className: '__lm2_meta' },
                  selected.tags.map((t) => h('span', { className: '__lm2_tag', key: t }, t)))
                : null,
              h('div', { className: '__lm2_body' }, selected.label || ''),
              h('div', { className: '__lm2_mono', style: { marginTop: '8px' } }, selected.id),
              h('div', { className: '__lm2_bar', style: { marginTop: '10px' } },
                h('button', { className: '__lm2_btn', onClick: () => setSelected(null) }, '关闭'),
              ),
            )
            : h('div', { className: '__lm2_side' },
              h('div', { className: '__lm2_sideTitle' }, '怎么读这张图'),
              h('div', { className: '__lm2_hint' },
                '点：一条记忆，颜色＝类别，大小＝连接数。', h('br'),
                '边：只画确定性关系——共现（被一起用过）、共享标签、同项目、创建时间相邻。', h('br'),
                h('br'),
                '红圈虚线：孤岛，没有任何语义关系，通常意味着"写了但没人用"。', h('br'),
                h('br'),
                '滚轮缩放，拖空白处平移，拖节点可以手动摆位置。',
              ),
            ),
        ),
      );
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 五、列表页签
     * ════════════════════════════════════════════════════════════════════════ */

    function ListTab() {
      const [rows, setRows] = useState([]);
      const [total, setTotal] = useState(0);
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState('');
      const [showDeleted, setShowDeleted] = useState(false);

      const load = useCallback(async (q) => {
        setBusy(true);
        setError('');
        try {
          const params = new URLSearchParams({ limit: '60' });
          if (q) params.set('q', q);
          if (showDeleted) params.set('includeDeleted', '1');
          const data = await jsonFetch(API + '/memories?' + params.toString());
          setRows(data.memories || []);
          setTotal(data.total || 0);
        } catch (e) {
          setError('读取失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [showDeleted]);

      useEffect(() => { load(''); }, [load]);

      const save = async (id) => {
        setBusy(true);
        try {
          await jsonFetch(API + '/memories/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: draft }),
          });
          setEditing(null);
          await load(query);
        } catch (e) {
          setError('保存失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const act = async (id, action) => {
        setBusy(true);
        try {
          if (action === 'delete') {
            await jsonFetch(API + '/memories/' + encodeURIComponent(id), { method: 'DELETE' });
          } else {
            await jsonFetch(API + '/memories/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
          }
          await load(query);
        } catch (e) {
          setError('操作失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: '__lm2_root' },
        h('div', { className: '__lm2_bar' },
          h('input', {
            className: '__lm2_input',
            placeholder: '搜索记忆（中文二字也会命中）',
            value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') load(query); },
            style: { width: '260px' },
          }),
          h('button', { className: '__lm2_btn', onClick: () => load(query), disabled: busy }, '搜索'),
          h('button', { className: '__lm2_btn', onClick: () => { setQuery(''); load(''); }, disabled: busy }, '显示全部'),
          h('button', {
            className: '__lm2_btn' + (showDeleted ? ' __lm2_btn--on' : ''),
            onClick: () => setShowDeleted((v) => !v),
          }, showDeleted ? '含已删：开' : '含已删：关'),
          h('span', { className: '__lm2_stat' }, `共 ${total} 条`),
          error ? h('span', { className: '__lm2_err' }, error) : null,
        ),
        h('div', { className: '__lm2_list' },
          rows.length === 0
            ? h('div', { className: '__lm2_hint' }, busy ? '读取中…' : '没有匹配的记忆。')
            : rows.map((rec) => h('div', { className: '__lm2_item', key: rec.id },
              h('div', { className: '__lm2_itemHead' },
                h('div', { className: '__lm2_meta' },
                  rec.project ? h('span', { className: '__lm2_tag' }, rec.project) : null,
                  rec.kind !== 'unknown' ? h('span', { className: '__lm2_tag' }, KIND_LABELS[rec.kind] || rec.kind) : null,
                  h('span', null, ageLabel(rec.createdAt)),
                  rec.accessCount ? h('span', null, '用过 ' + rec.accessCount + ' 次') : null,
                  rec.deletedAt ? h('span', { className: '__lm2_tag', style: { background: 'rgba(217,83,79,.25)' } }, '已删除') : null,
                ),
                h('span', { className: '__lm2_mono' }, rec.id),
              ),
              editing === rec.id
                ? h('div', null,
                  h('textarea', {
                    className: '__lm2_input',
                    value: draft,
                    rows: 4,
                    style: { width: '100%', marginTop: '6px' },
                    onChange: (e) => setDraft(e.target.value),
                  }),
                  h('div', { className: '__lm2_bar', style: { marginTop: '6px' } },
                    h('button', { className: '__lm2_btn', onClick: () => save(rec.id), disabled: busy }, '保存'),
                    h('button', { className: '__lm2_btn', onClick: () => setEditing(null) }, '取消'),
                  ),
                )
                : h('div', { className: '__lm2_body' }, compact(rec.content, 160)),
              (rec.tags || []).length
                ? h('div', { className: '__lm2_meta' }, rec.tags.map((t) => h('span', { className: '__lm2_tag', key: t }, t)))
                : null,
              h('div', { className: '__lm2_bar', style: { marginTop: '6px' } },
                rec.deletedAt
                  ? h('button', { className: '__lm2_btn', onClick: () => act(rec.id, 'restore'), disabled: busy }, '恢复')
                  : h('button', {
                    className: '__lm2_btn',
                    onClick: () => { setEditing(rec.id); setDraft(rec.content); },
                    disabled: busy,
                  }, '编辑'),
                rec.deletedAt
                  ? h('button', { className: '__lm2_btn', onClick: () => act(rec.id, 'purge'), disabled: busy }, '彻底删除')
                  : h('button', { className: '__lm2_btn', onClick: () => act(rec.id, 'delete'), disabled: busy }, '删除'),
              ),
            )),
        ),
      );
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 六、补标页签
     * ════════════════════════════════════════════════════════════════════════ */

    const KIND_CHOICES = [
      { value: 'work', label: '工作' },
      { value: 'preference', label: '偏好' },
      { value: 'emotion', label: '情感' },
    ];

    const IMPORTANCE_CHOICES = [
      { value: 'key', label: '关键' },
      { value: 'important', label: '重要' },
      { value: 'casual', label: '随口' },
      { value: 'transient', label: '易过期' },
    ];

    /**
     * 补标：把 v1 迁移过来、没有分类的记忆逐条归位。
     *
     * 为什么不做"批量全选"：分类这件事必须逐条读正文才能判断，批量操作只会制造
     * 一堆看起来整齐其实错分的标签，比不分类更糟。所以这里一次只推进一条。
     */
    function ClassifyTab() {
      const [rows, setRows] = useState([]);
      const [unknownTotal, setUnknownTotal] = useState(0);
      const [showAll, setShowAll] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [tagDraft, setTagDraft] = useState({});
      const [notice, setNotice] = useState('');
      const [expanded, setExpanded] = useState({});

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const params = new URLSearchParams({ limit: '60' });
          if (!showAll) params.set('kind', 'unknown');
          const [list, state] = await Promise.all([
            jsonFetch(API + '/memories?' + params.toString()),
            jsonFetch(API + '/state'),
          ]);
          setRows(list.memories || []);
          const row = (state.stats && state.stats.byKind || []).find((k) => k.kind === 'unknown');
          setUnknownTotal(row ? row.c : 0);
        } catch (e) {
          setError('读取失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [showAll]);

      useEffect(() => { load(); }, [load]);

      const patch = useCallback(async (id, body) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          await jsonFetch(API + '/memories/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (!showAll && body.kind && body.kind !== 'unknown') {
            // 分好类就不在这条队列里了
            setRows((rs) => rs.filter((r) => r.id !== id));
            setUnknownTotal((n) => Math.max(0, n - 1));
            setNotice('已归类');
          } else {
            setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...body } : r)));
          }
        } catch (e) {
          setError('保存失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [showAll]);

      const saveTags = (rec) => {
        const raw = tagDraft[rec.id];
        if (raw === undefined) return;
        const tags = String(raw).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
        patch(rec.id, { tags });
        setTagDraft((d) => { const next = { ...d }; delete next[rec.id]; return next; });
      };

      return h('div', { className: '__lm2_root' },
        h('div', { className: '__lm2_bar' },
          h('span', { className: '__lm2_stat' },
            showAll ? '全部记忆' : `还有 ${unknownTotal} 条未分类`),
          h('button', {
            className: '__lm2_btn' + (showAll ? ' __lm2_btn--on' : ''),
            onClick: () => setShowAll((v) => !v),
          }, showAll ? '只看未分类：关' : '只看未分类：开'),
          h('button', { className: '__lm2_btn', onClick: load, disabled: busy }, busy ? '处理中…' : '刷新'),
          notice ? h('span', { className: '__lm2_hint' }, notice) : null,
          error ? h('span', { className: '__lm2_err' }, error) : null,
        ),
        h('div', { className: '__lm2_hint', style: { marginBottom: '6px' } },
          '逐条读正文再归位。分类只影响检索排序与图的着色，写错了随时改，不丢记忆。'),
        rows.length === 0
          ? h('div', { className: '__lm2_hint' }, busy ? '读取中…' : (showAll ? '没有记忆。' : '没有未分类的记忆了 🎉'))
          : h('div', { className: '__lm2_list' },
            rows.map((rec) => h('div', { className: '__lm2_item', key: rec.id },
              h('div', { className: '__lm2_meta' },
                rec.project ? h('span', { className: '__lm2_tag' }, rec.project) : null,
                rec.kind !== 'unknown' ? h('span', { className: '__lm2_tag' }, KIND_LABELS[rec.kind] || rec.kind) : null,
                h('span', null, ageLabel(rec.createdAt)),
                h('span', { className: '__lm2_mono' }, rec.id),
              ),
              // 正文默认截到 220 字：补标只需要"够判断类别"的信息，
              // 全展开会让一屏只放得下 3 条，67 条要翻二十多屏
              h('div', { className: '__lm2_body', style: { margin: '6px 0' } },
                expanded[rec.id] ? inlineText(rec.content) : compact(rec.content, 220)),
              inlineText(rec.content).length > 220
                ? h('button', {
                  className: '__lm2_btn',
                  style: { marginBottom: '4px' },
                  onClick: () => setExpanded((e) => ({ ...e, [rec.id]: !e[rec.id] })),
                }, expanded[rec.id] ? '收起' : '展开全文')
                : null,

              // 类别
              h('div', { className: '__lm2_bar' },
                h('span', { className: '__lm2_hint', style: { minWidth: '52px' } }, '类别'),
                KIND_CHOICES.map((c) => h('button', {
                  key: c.value,
                  className: '__lm2_btn' + (rec.kind === c.value ? ' __lm2_btn--on' : ''),
                  disabled: busy,
                  onClick: () => patch(rec.id, { kind: c.value }),
                }, c.label)),
                h('button', {
                  className: '__lm2_btn' + (rec.kind === 'unknown' ? ' __lm2_btn--on' : ''),
                  disabled: busy,
                  onClick: () => patch(rec.id, { kind: 'unknown' }),
                }, '未分类'),
              ),

              // 重要度
              h('div', { className: '__lm2_bar' },
                h('span', { className: '__lm2_hint', style: { minWidth: '52px' } }, '重要度'),
                IMPORTANCE_CHOICES.map((c) => h('button', {
                  key: c.value,
                  className: '__lm2_btn' + (rec.importance === c.value ? ' __lm2_btn--on' : ''),
                  disabled: busy,
                  onClick: () => patch(rec.id, { importance: c.value }),
                }, c.label)),
              ),

              // 标签
              h('div', { className: '__lm2_bar' },
                h('span', { className: '__lm2_hint', style: { minWidth: '52px' } }, '标签'),
                h('input', {
                  className: '__lm2_input',
                  style: { flex: '1 1 200px' },
                  placeholder: '逗号或空格分隔',
                  value: tagDraft[rec.id] !== undefined
                    ? tagDraft[rec.id]
                    : (rec.tags || []).join(', '),
                  onChange: (e) => setTagDraft((d) => ({ ...d, [rec.id]: e.target.value })),
                  onKeyDown: (e) => { if (e.key === 'Enter') saveTags(rec); },
                }),
                h('button', {
                  className: '__lm2_btn',
                  disabled: busy || tagDraft[rec.id] === undefined,
                  onClick: () => saveTags(rec),
                }, '保存标签'),
              ),
            )),
          ),
      );
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 七、外壳
     * ════════════════════════════════════════════════════════════════════════ */

    function Panel() {
      const [tab, setTab] = useState('graph');
      // 样式在 apply() 里注入一次即可。这里故意不调 ensureStyle()：
      // 渲染期间做 DOM 副作用是反模式，而且每次重渲染都查一遍 DOM 也没必要。
      return h('div', { className: '__lm2_root' },
        h('div', { className: '__lm2_tabs' },
          h('button', {
            className: '__lm2_tab' + (tab === 'graph' ? ' __lm2_tab--on' : ''),
            onClick: () => setTab('graph'),
          }, '关系图'),
          h('button', {
            className: '__lm2_tab' + (tab === 'list' ? ' __lm2_tab--on' : ''),
            onClick: () => setTab('list'),
          }, '记忆列表'),
          h('button', {
            className: '__lm2_tab' + (tab === 'classify' ? ' __lm2_tab--on' : ''),
            onClick: () => setTab('classify'),
          }, '补标'),
        ),
        tab === 'graph' ? h(GraphTab) : (tab === 'list' ? h(ListTab) : h(ClassifyTab)),
      );
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'local-memory', order: 28, label: '本地记忆' },
        () => h(Panel),
      ));
    }

    exports.apply = apply;

    /** 只给单元测试与离线预览用：布局数学没有 DOM 依赖，必须能在 node 里直接测 */
    exports.__internals = {
      createLayout,
      stepLayout,
      isSettled,
      bounds,
      kindColor,
      edgeStyle,
      KIND_COLORS,
      EDGE_STYLES,
      CSS,
      // 组件本身也给出去：离线预览用它渲染真组件，而不是照着重画一遍
      components: { Panel, GraphTab, ListTab, ClassifyTab },
    };

    return module.exports;
  },
});
