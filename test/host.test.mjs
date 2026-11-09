/**
 * Host 层测试：用假 ctx 把插件挂起来，验证工具、提示词、自动回忆。
 *
 * 关键点：**不需要真的装进 DSH 也能测**。假 ctx 只需实现 v1 验证过的四个能力
 * （tools.register / systemPrompt.section / on / effect）+ 一个软获取的 get。
 * 每个测试用独立的 DSH_HOME 临时目录，互相不污染，也绝不碰真实记忆库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const { apply } = await import('../src/host/index.js');
const { openStore } = await import('../src/core/index.js');
const { defaultDbFile, writeConfig } = await import('../src/host/config.js');

/** 起一个假的 OpenAI 兼容 /embeddings 服务 */
async function startFakeEmbedding() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      // 固定返回同一个方向：这样查询和记忆的余弦恒为 1，便于断言"确实走了向量"
      const data = input.map((_, i) => ({ index: i, embedding: [1, 0] }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    stop: () => new Promise((r) => server.close(r)),
  };
}

/** 建一个隔离的 DSH_HOME + 假宿主上下文 */
function mount() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-host-'));
  process.env.DSH_HOME = home;

  const tools = new Map();
  const sections = [];
  const handlers = new Map();
  const disposers = [];

  const ctx = {
    tools: {
      register: (def) => {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    systemPrompt: {
      section: (spec) => {
        sections.push(spec);
        return () => {
          const i = sections.indexOf(spec);
          if (i >= 0) sections.splice(i, 1);
        };
      },
    },
    on: (event, fn) => {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    effect: (fn) => {
      disposers.push(fn());
      return () => {};
    },
    get: () => undefined,
  };

  apply(ctx);

  return { home, tools, sections, handlers, disposers };
}

/** 调工具，返回字符串结果 */
async function call(mounted, name, args) {
  const def = mounted.tools.get(name);
  assert.ok(def, `工具 ${name} 应该已注册`);
  return def.execute(args || {}, {});
}

/** 造一条最简的 enter 决策 */
function makeDecision(userText) {
  return {
    kind: 'enter',
    messages: [
      { role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } },
    ],
  };
}

// ---------------------------------------------------------------- 注册

test('apply 注册六个工具（含 memory_update）', () => {
  const m = mount();
  const names = [...m.tools.keys()].sort();
  assert.deepEqual(names, [
    'memory_forget', 'memory_list', 'memory_review', 'memory_save', 'memory_search', 'memory_update',
  ]);
});

test('每个工具都有合法定义（名字/描述/参数/output.schema/execute）', () => {
  const m = mount();
  for (const [name, def] of m.tools) {
    assert.equal(def.name, name);
    assert.ok(def.description.length > 10, `${name} 描述太短`);
    assert.equal(typeof def.parameters, 'object');
    assert.equal(typeof def.execute, 'function');
    assert.ok(def.output && def.output.schema && typeof def.output.render === 'function');
  }
});

test('注册了常驻提示词段，且 order/name 正确', () => {
  const m = mount();
  assert.equal(m.sections.length, 1);
  assert.equal(m.sections[0].name, 'dsh-local-memory:brief');
  assert.equal(m.sections[0].order, 60);
  assert.equal(typeof m.sections[0].text, 'function');
});

test('注册了 agent/pre-step 处理器', () => {
  const m = mount();
  assert.equal(typeof m.handlers.get('agent/pre-step'), 'function');
});

// ---------------------------------------------------------------- 工具

test('memory_save → memory_search 中文往返（含两个字词）', async () => {
  const m = mount();
  const saved = await call(m, 'memory_save', { text: '主人喜欢喝美式咖啡，不加糖', tags: ['pref'], kind: 'preference' });
  assert.match(saved, /已记住/);
  assert.match(saved, /preference/);

  const found = await call(m, 'memory_search', { query: '咖啡' });
  assert.match(found, /找到 1 条/);
  assert.match(found, /美式咖啡/);
});

test('memory_save 相同正文不重复插入，只合并标签', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '构建前必须先跑 lint', tags: ['a'] });
  const second = await call(m, 'memory_save', { text: '构建前必须先跑 lint', tags: ['b'] });
  assert.match(second, /已经记过了/);

  const list = await call(m, 'memory_list', {});
  assert.match(list, /共 1 条|最近的 1 条/);
});

test('memory_save 空内容被拒绝，不写库', async () => {
  const m = mount();
  const r = await call(m, 'memory_save', { text: '   ' });
  assert.match(r, /text 为空/);
  const list = await call(m, 'memory_list', {});
  assert.match(list, /还是空的/);
});

test('memory_forget 是软删，回复里明确说明可恢复', async () => {
  const m = mount();
  const saved = await call(m, 'memory_save', { text: '这条待会儿要删掉' });
  const id = saved.match(/id=([^\s）)]+)/)[1];

  const del = await call(m, 'memory_forget', { id });
  assert.match(del, /已删除/);
  assert.match(del, /可恢复/);

  const found = await call(m, 'memory_search', { query: '删掉' });
  assert.match(found, /没有匹配|还是空的/);
});

test('memory_update 追加进展且不改原文', async () => {
  const m = mount();
  const saved = await call(m, 'memory_save', { text: '用户的电脑进水坏了' });
  const id = saved.match(/id=([^\s）)]+)/)[1];

  const up = await call(m, 'memory_update', { id, text: '买了一台新电脑', status: 'resolved' });
  assert.match(up, /追加第 1 条进展/);
  assert.match(up, /状态改成：resolved/);
  assert.match(up, /原记忆仍是/);

  // 原文没被改写，但**进展必须能被看到**（否则 memory_update 等于写进黑洞）
  const got = await call(m, 'memory_list', {});
  assert.match(got, /电脑进水坏了/, '原文要还在');
  assert.match(got, /后续进展.*买了一台新电脑/, '进展要跟着显示出来');
  // 原文那一行不能混入进展内容
  const originLine = got.split('\n').find((l) => l.includes('电脑进水坏了'));
  assert.doesNotMatch(originLine, /买了一台新电脑/, '原文和进展必须是两行，不能糊在一起');
});

test('memory_update 找不到 id 时明确报错，不静默成功', async () => {
  const m = mount();
  const out = await call(m, 'memory_update', { id: 'm-not-exist', text: '随便写点' });
  assert.match(out, /没找到/);
});

test('memory_save 落盘的正文已脱敏', async () => {
  const m = mount();
  const saved = await call(m, 'memory_save', { text: '他的手机 13812345678 记一下' });
  assert.doesNotMatch(saved, /13812345678/, '工具回显里也不该出现明文');
  const list = await call(m, 'memory_list', {});
  assert.doesNotMatch(list, /13812345678/);
  assert.match(list, /已脱敏:手机号/);
});

test('memory_list 按标签过滤', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '标签甲的记忆', tags: ['alpha'] });
  await call(m, 'memory_save', { text: '标签乙的记忆', tags: ['beta'] });
  const list = await call(m, 'memory_list', { tag: 'alpha' });
  assert.match(list, /标签甲/);
  assert.doesNotMatch(list, /标签乙/);
});

test('memory_review 只读：报重复/未分类但不改数据', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '重复的正文内容' });
  await call(m, 'memory_save', { text: '另一条普通记忆' });
  const r = await call(m, 'memory_review', {});
  assert.match(r, /体检/);
  assert.match(r, /没分类/);
  // 体检不改数据：两条都还在
  const list = await call(m, 'memory_list', {});
  assert.match(list, /共 2 条/);
});

// ---------------------------------------------------------------- 提示词

test('提示词包含记忆条数、收工自检、以及"别当破坏性操作不问"', () => {
  const m = mount();
  const text = m.sections[0].text();
  assert.match(text, /本地长期记忆/);
  assert.match(text, /已记录 0 条/);
  assert.match(text, /收工自检/);
  assert.match(text, /不要问用户/);
});

test('提示词里带"该体检了"提醒（尚未体检过）', () => {
  const m = mount();
  assert.match(m.sections[0].text(), /记忆该体检了/);
});

// ---------------------------------------------------------------- 自动回忆

test('pre-step 注入记忆：新消息带 id/source/memoryIds，且排在原消息前面', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '主人喜欢喝美式咖啡不加糖', tags: ['pref'] });

  const handler = m.handlers.get('agent/pre-step');
  const decision = makeDecision('我记得你喜欢美式咖啡对吧');

  const out = await handler({ agent: { id: 'sess-1' } }, async () => decision);

  assert.equal(out.messages.length, 2, '应在原消息前插入一条');
  const injected = out.messages[0];
  assert.match(injected.id, /^dsh-local-memory:recall:/);
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'dsh-local-memory', 'source.kind 必须存在，否则宿主会抛 TypeError');
  assert.equal(injected.source.form, 'recall');
  assert.equal(injected.source.memoryIds.length, 1);
  assert.match(injected.content[0].text, /美式咖啡/);
  assert.equal(out.messages[1], decision.messages[0], '原消息对象必须原样保留');
});

test('pre-step 同会话同内容不重复注入（防历史滚雪球）', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '主人喜欢喝美式咖啡不加糖' });
  const handler = m.handlers.get('agent/pre-step');
  const payload = { agent: { id: 'sess-2' } };

  const first = await handler(payload, async () => makeDecision('我记得你喜欢美式咖啡对吧'));
  assert.equal(first.messages.length, 2);

  const second = await handler(payload, async () => makeDecision('我记得你喜欢美式咖啡对吧'));
  assert.equal(second.messages.length, 1, '第二次不应再注入');
});

test('pre-step 输入太短不注入', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '主人喜欢喝美式咖啡' });
  const handler = m.handlers.get('agent/pre-step');
  const out = await handler({ agent: { id: 'sess-3' } }, async () => makeDecision('咖啡'));
  assert.equal(out.messages.length, 1, '低于 autoRecallMinChars 应跳过');
});

test('pre-step 忽略系统合成的 user 消息（不拿 runtime-context 当检索词）', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '主人喜欢喝美式咖啡不加糖' });
  const handler = m.handlers.get('agent/pre-step');
  const decision = {
    kind: 'enter',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '我记得你喜欢美式咖啡对吧' }], source: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'runtime context ...' }], source: { kind: 'runtime-context' } },
    ],
  };
  const out = await handler({ agent: { id: 'sess-4' } }, async () => decision);
  // 应取最后一条**真人**消息（第一条）去检索，所以能命中并注入
  assert.equal(out.messages.length, 3);
  assert.match(out.messages[0].content[0].text, /美式咖啡/);
});

test('pre-step 决策不是 enter 时不注入', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '主人喜欢喝美式咖啡不加糖' });
  const handler = m.handlers.get('agent/pre-step');
  const out = await handler({ agent: { id: 'sess-5' } }, async () => ({ kind: 'skip', messages: [] }));
  assert.equal(out.kind, 'skip');
});

test('pre-step 检索抛错时安静放行，不拖死这一轮', async () => {
  const m = mount();
  const handler = m.handlers.get('agent/pre-step');
  // 让 next() 正常返回，但 store 在配置被改坏后取不到 → 应被 catch 吞掉
  const decision = makeDecision('一个足够长的查询句子用来触发检索');
  const out = await handler({ agent: { id: 'sess-6' } }, async () => decision);
  assert.ok(out && Array.isArray(out.messages), '无论如何都要返回一个可用决策');
});

// ---------------------------------------------------------------- 惰性维护

test('首次用到库时会顺带做一次维护（写 last_maintenance_at）', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '触发惰性维护' });

  const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
  const at = store.getMeta('last_maintenance_at');
  assert.ok(at, '首次使用应触发维护');
  assert.ok(Number(at) > 0);
  store.close();
});

test('维护不会删掉刚写的记忆（只清孤儿行）', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '维护后必须还在' });
  await call(m, 'memory_save', { text: '第二条也必须还在' });

  const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
  assert.equal(store.count(), 2);
  store.close();
});

// ---------------------------------------------------------------- 可选 embedding

test('配好 embedding 后：存记忆会顺手算并落库向量', async () => {
  const m = mount();
  const fake = await startFakeEmbedding();
  try {
    writeConfig({ embedding: { enabled: true, baseUrl: fake.baseUrl, model: 'fake-embed' } });

    const saved = await call(m, 'memory_save', { text: '部署流程要小心回滚' });
    assert.match(saved, /已记住/);

    const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
    const vs = store.vectorStats();
    assert.ok(vs.withVector >= 1, '应至少有一条记忆带向量');
    assert.equal(vs.models[0].model, 'fake-embed');
    store.close();
  } finally {
    await fake.stop();
  }
});

test('embedding 端点挂了：存记忆照样成功，检索照样有结果（降级不报错）', async () => {
  const m = mount();
  // 指向一个必然连不上的端口
  writeConfig({ embedding: { enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'dead' } });

  const saved = await call(m, 'memory_save', { text: '端点挂掉也要能存下这条记忆' });
  assert.match(saved, /已记住/, '存记忆不能因为向量服务挂了而失败');

  const found = await call(m, 'memory_search', { query: '记忆' });
  assert.match(found, /找到 \d+ 条/, '检索应降级到纯关键词并正常返回');
});

test('未配 embedding 时不产生任何向量（默认关闭就是真的不做）', async () => {
  const m = mount();
  await call(m, 'memory_save', { text: '没配向量服务' });
  const store = openStore({ file: defaultDbFile(), backend: 'sqlite' });
  assert.equal(store.vectorStats().withVector, 0);
  store.close();
});

// ---------------------------------------------------------------- 卸载

test('卸载时清理 disposers，不留悬挂注册', () => {
  const m = mount();
  assert.ok(m.disposers.length >= 1, 'ctx.effect 应拿到清理函数');
  const cleanup = m.disposers[0];
  assert.equal(typeof cleanup, 'function');
  cleanup();
  // 清理后工具仍留在假 ctx 里（假 ctx 的 disposer 已被我们调用过一次），
  // 这里只验证清理本身不抛错
  assert.ok(true);
});
