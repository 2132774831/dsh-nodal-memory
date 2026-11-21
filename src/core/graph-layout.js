/**
 * 力导向布局（纯算法，无 DOM、无宿主依赖）。
 *
 * 这个文件是**浏览器可直接 import 的 ESM**：独立软件的界面通过 <script type="module">
 * 直接引它，和单元测试用的是同一份代码。不生成构建产物、不打包。
 *
 * 注意：DSH 插件那边（src/client/index.js）里还有一份等价副本——因为 ModuleLoader
 * 的 factory 只能 require，不能 import。两份的一致性由 test/client.test.mjs 里的
 * 等价性测试守着（同一输入必须产生逐点相同的输出）。
 *
 * 几个必须防死的坑（都是这类动画的经典死法）：
 *   - 初始位置全在原点 → 第一步斥力算出 0 距离 → 除以接近 0 的数 → 坐标变 NaN → 整张图消失
 *   - 不给速度上限 → 一次异常大的力就能把点甩到几万像素外
 *   - 不收敛就停 → rAF 空转烧 CPU 一整夜
 */

/**
 * 建一个布局状态。初始位置沿圆周铺开（并带轻微半径抖动，避免完美对称卡住）。
 */
export function createLayout(nodes, edges, opts = {}) {
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
 * 推进一帧：斥力 O(n²) + 弹簧 + 向心力 + 阻尼 + 限速。
 */
export function stepLayout(L, opts = {}) {
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

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      let dx = px[j] - px[i];
      let dy = py[j] - py[i];
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-4) {
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

  for (let i = 0; i < count; i++) {
    vx[i] = (vx[i] - px[i] * gravity) * damping;
    vy[i] = (vy[i] - py[i] * gravity) * damping;

    const speed = Math.hypot(vx[i], vy[i]);
    if (speed > maxSpeed) {
      vx[i] = (vx[i] / speed) * maxSpeed;
      vy[i] = (vy[i] / speed) * maxSpeed;
    }

    px[i] += vx[i];
    py[i] += vy[i];

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

export function isSettled(L) {
  return L.alpha <= 0.021;
}

/** 世界坐标包围盒（「适应窗口」用） */
export function bounds(L) {
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

/** 视觉编码：点的颜色（按类别）。与界面保持一致，避免两处各写一套。 */
export const KIND_COLORS = {
  work: '#4a90d9',
  preference: '#d9a04a',
  emotion: '#d95a8a',
  unknown: '#8a8f98',
};

/** 视觉编码：边的样式。共现最粗最亮，时间相邻最淡。语义用紫色点线（和"推断出的关系"相配）。 */
export const EDGE_STYLES = {
  cooccur: { color: 'rgba(255,170,60,0.95)', width: 2.4, dash: null, label: '共现' },
  tag: { color: 'rgba(90,160,255,0.55)', width: 1.4, dash: null, label: '共享标签' },
  semantic: { color: 'rgba(186,140,255,0.6)', width: 1.0, dash: [2, 4], label: '语义相近' },
  project: { color: 'rgba(120,200,160,0.40)', width: 1.1, dash: null, label: '同项目' },
  time: { color: 'rgba(160,160,170,0.20)', width: 0.9, dash: [3, 4], label: '时间相邻' },
  session: { color: 'rgba(236,130,210,0.85)', width: 1.5, dash: null, label: '同一次对话' },
  kindred: { color: 'rgba(90,220,235,0.6)', width: 1.1, dash: [6, 3], label: '同类事' },
  event: { color: 'rgba(120,255,200,0.95)', width: 2.0, dash: null, label: 'AI 认定同一件事' },
};

/** 浅色主题的节点颜色：白底上要比深色版深一档才看得清 */
export const KIND_COLORS_LIGHT = {
  work: '#3b7fc4',
  preference: '#c08428',
  emotion: '#c34a72',
  unknown: '#8a8f98',
};

/** 浅色主题的边：白底上要加深、降低透明度 */
export const EDGE_STYLES_LIGHT = {
  cooccur: { color: 'rgba(214,120,20,0.80)', width: 2.2, dash: null, label: '共现' },
  tag: { color: 'rgba(60,110,200,0.50)', width: 1.3, dash: null, label: '共享标签' },
  semantic: { color: 'rgba(140,90,200,0.55)', width: 1.0, dash: [2, 4], label: '语义相近' },
  project: { color: 'rgba(70,150,110,0.40)', width: 1.0, dash: null, label: '同项目' },
  time: { color: 'rgba(120,125,135,0.30)', width: 0.9, dash: [3, 4], label: '时间相邻' },
  session: { color: 'rgba(200,70,170,0.70)', width: 1.4, dash: null, label: '同一次对话' },
  kindred: { color: 'rgba(30,150,165,0.55)', width: 1.1, dash: [6, 3], label: '同类事' },
  event: { color: 'rgba(16,170,120,0.90)', width: 2.0, dash: null, label: 'AI 认定同一件事' },
};

/** 画布上的其余颜色（标签描边、节点环、卡片底色），按主题取 */
export const THEME_UI = {
  dark: { labelStroke: 'rgba(20,22,26,0.9)', labelFill: 'rgba(215,218,224,0.95)', ring: 'rgba(255,255,255,0.9)', cardBg: '#1b1e24', cardText: '#d7dae0', cardMeta: 'rgba(150,156,166,0.95)', cardTitle: '#ffffff' },
  light: { labelStroke: 'rgba(255,255,255,0.95)', labelFill: 'rgba(30,34,40,0.95)', ring: 'rgba(255,255,255,0.95)', cardBg: '#ffffff', cardText: '#23282a', cardMeta: '#5a626e', cardTitle: '#ffffff' },
  warm: { labelStroke: 'rgba(250,248,242,0.95)', labelFill: 'rgba(40,36,28,0.95)', ring: 'rgba(250,248,242,0.95)', cardBg: '#ffffff', cardText: '#23282a', cardMeta: '#55605a', cardTitle: '#ffffff' },
};

/** 按主题拿节点色表 / 边表 */
export const THEME_KIND = { dark: KIND_COLORS, light: KIND_COLORS_LIGHT, warm: KIND_COLORS_LIGHT };
export const THEME_EDGE = { dark: EDGE_STYLES, light: EDGE_STYLES_LIGHT, warm: EDGE_STYLES_LIGHT };

export function kindColor(kind, theme = 'dark') {
  const table = THEME_KIND[theme] || KIND_COLORS;
  return table[kind] || table.unknown;
}

export function edgeStyle(kind, theme = 'dark') {
  const table = THEME_EDGE[theme] || EDGE_STYLES;
  return table[kind] || table.time;
}
