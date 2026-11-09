/**
 * 前端测试：注册契约 + 瘦身后的结构。
 *
 * 关系图的布局数学已经从插件里删掉了（只保留在独立应用/core 里），
 * 所以这里不再测 createLayout/stepLayout —— 那些由 core/graph-layout.js
 * 的测试覆盖。这里只保证三件事：
 *   1) bundle 的注册契约没变（id / settings.section / order / label）
 *   2) 不再把关系图画布塞回插件（防止有人又抄一份，导致两边漂移）
 *   3) "打开完整界面"走的是宿主的 /open，而不是自己拼 localhost 端口
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ── 伪造 ModuleLoader 与 react，把 bundle 跑起来 ── */
let captured = null;
const noop = () => {};
const reactStub = {
  createElement: () => null,
  useState: (init) => [typeof init === 'function' ? init() : init, noop],
  useEffect: noop,
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { captured = spec; },
  },
};
globalThis.document = undefined;

await import('../src/client/index.js');

assert.ok(captured, 'bundle 应该调用 window.__ModuleLoader__.load');
const bundle = captured.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error('unexpected require: ' + name);
});

const { KIND_COLORS, CSS, OPEN_PATH, components } = bundle.__internals;

/* ── 注册契约 ── */

test('bundle 的 id 必须等于 loader entry 名（否则 ModuleLoader 会报错）', () => {
  assert.equal(captured.id, 'dsh-local-memory');
});

test('factory 返回带 apply 与 __internals 的模块', () => {
  assert.equal(typeof bundle.apply, 'function');
  assert.equal(typeof bundle.__internals, 'object');
});

test('apply 注册 settings.section，id/order/label 正确', () => {
  const calls = [];
  const ctx = {
    slots: {
      inject: (name, fn) => { calls.push(name); fn(); },
      register: (spec, render) => { calls.push(spec); return () => {}; },
    },
  };
  bundle.apply(ctx);

  assert.ok(calls.includes('settings.section'));
  const spec = calls.find((c) => c && c.name === 'settings.section');
  assert.ok(spec, '应注册 settings.section');
  assert.equal(spec.id, 'local-memory');
  assert.equal(spec.order, 28);
  assert.equal(spec.label, '本地记忆');
});

test('apply 能在没有 document 的环境里跑（服务端渲染/测试）', () => {
  const ctx = {
    slots: { inject: (n, fn) => fn(), register: () => () => {} },
  };
  assert.doesNotThrow(() => bundle.apply(ctx));
});

test('apply 内部出错也绝不往外抛（否则一个客户端插件能把整个 DSH 拖成白屏）', () => {
  // 真实事故：v2.1.0 的浏览器半侧没起来，DSH 前端 boot 只认 active，
  // 结果整个页面不启动。客户端出错的代价必须是"这个页面没了"，不能是"应用开不了"。
  const boom = {
    slots: {
      inject: () => { throw new Error('模拟宿主槽位异常'); },
      register: () => { throw new Error('不该走到这里'); },
    },
  };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => bundle.apply(boom));
  } finally {
    console.error = origError;
  }
});

/* ── 瘦身后的结构 ── */

test('只暴露三个组件：外壳 + 列表 + 补标（关系图已经搬去独立应用）', () => {
  assert.deepEqual(Object.keys(components).sort(), ['ClassifyTab', 'ListTab', 'Panel']);
  assert.equal(components.GraphTab, undefined, '插件里不许再有第二个关系图实现');
});

test('"打开完整界面"走宿主 /open（由宿主负责拉起独立应用并 302）', () => {
  assert.equal(OPEN_PATH, '/dsh-local-memory/open');
});

test('不再带关系图的画布样式（防止悄悄搬回来）', () => {
  for (const cls of ['canvas', 'graphWrap', 'legend', 'legendItem']) {
    assert.ok(!CSS.includes('__lm2_' + cls), '这段 CSS 应该已经删掉了：__lm2_' + cls);
  }
});

test('类别配色还在（列表里的类别小圆点要用）', () => {
  for (const kind of ['work', 'preference', 'emotion', 'unknown']) {
    assert.ok(KIND_COLORS[kind], '缺类别颜色：' + kind);
  }
});

test('插件不再内置布局算法（core 里只留一份）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8');
  for (const fn of ['createLayout', 'stepLayout', 'isSettled']) {
    assert.ok(!src.includes('function ' + fn), '插件里不该再有 ' + fn + ' 的副本');
  }
});
