import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, localLinkPairs } from '../src/core/local-link.js';

test('tokenize: 中文切二字、英文保留单词', () => {
  const t = tokenize('EasyEDA 引脚重复，清缓存解决');
  assert.ok(t.includes('easyeda'), '英文词保留');
  assert.ok(t.includes('引脚'), '中文二元组');
  assert.ok(t.includes('缓存'));
  assert.ok(!t.some((x) => x === '，'), '标点被丢掉');
});

test('localLinkPairs: 同一件事的两条会连起来', () => {
  const rows = [
    { id: 'a', content: 'EasyEDA 引脚重复问题：先清缓存再重新导入封装库', tags: ['pcb'] },
    { id: 'b', content: 'EasyEDA 引脚又重复了，同样清缓存后重新导入封装', tags: ['pcb'] },
    { id: 'c', content: '今天天气不错，出去走了走', tags: [] },
    { id: 'd', content: '部署端口从 8080 改成 9411，记得同步防火墙规则', tags: ['deploy'] },
  ];
  const pairs = localLinkPairs(rows);
  assert.equal(pairs.length, 1, '只应连同一件事那一对');
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ['a', 'b']);
  assert.ok(pairs[0].score > 0.2);
});

test('localLinkPairs: 内容不相关的不会被硬连', () => {
  const rows = [
    { id: 'x', content: '给打印机换了硒鼓，型号 HP 136A', tags: [] },
    { id: 'y', content: 'Kubernetes 集群的 ingress 证书到期，续了 90 天', tags: [] },
    { id: 'z', content: '晚饭吃了番茄牛腩面', tags: [] },
  ];
  assert.deepEqual(localLinkPairs(rows), []);
});

test('localLinkPairs: 太短的记录不参与', () => {
  const rows = [
    { id: 'a', content: '短' },
    { id: 'b', content: '短' },
  ];
  assert.deepEqual(localLinkPairs(rows), []);
});

test('localLinkPairs: 互为最近邻才连（单向蹭热点不连）', () => {
  const rows = [
    { id: 'hub', content: 'DSH 插件开发笔记：插件入口要 export name 和 inject，apply(ctx) 里挂工具', tags: ['dsh'] },
    { id: 'a', content: 'DSH 插件入口写法：export const name、export const inject、apply(ctx)', tags: ['dsh'] },
    { id: 'b', content: '插件入口要 export name 和 inject 这两个字段', tags: ['dsh'] },
  ];
  const pairs = localLinkPairs(rows, { topK: 1 });
  // topK=1 时 hub 只能连一个，另一个就不再互连
  assert.ok(pairs.length <= 1, 'topK=1 时最多一对');
});
