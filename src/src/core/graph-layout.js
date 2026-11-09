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
};

export function kindColor(kind) {
  return KIND_COLORS[kind] || KIND_COLORS.unknown;
}

export function edgeStyle(kind) {
  return EDGE_STYLES[kind] || EDGE_STYLES.time;
}
