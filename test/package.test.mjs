/**
 * 包结构与分层守卫（发布前的地基检查）。
 *
 * 为什么需要：这个插件是 **link 安装**（profile 里是指向工作区的符号链接），
 * 所以 package.json 的 `main` 一改就等于"装机"。正因为如此，入口声明必须由测试看住：
 *   - 现在 main 指向 v1（活着的那版），v2 通过 ./v2 子路径暴露，互不干扰
 *   - 哪天切换发布，只改 main/exports，这里的断言会立刻告诉我还缺什么
 *
 * 分层守卫更重要：src/core 必须零宿主依赖，否则"将来做成独立软件"这条退路就断了。
 * 这种违规只有靠机械扫描才拦得住——人写代码时很容易手滑 import 一个宿主模块。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const abs = (p) => path.resolve(ROOT, p);
const exists = (p) => fs.existsSync(abs(p));

/**
 * 这个包有两种合理布局，断言要跟着变：
 *   - 工作区（开发中）：main 指向 v1（lib/index.js），v2 通过 ./v2 子路径暴露
 *   - 发布版（发出去的）：main 直接指向 v2（src/host/index.js）
 * 判据就是 main 在哪。
 */
const IS_V2_MAIN = /src\/host\/index\.js$/.test(pkg.main);
const V2_CLIENT = IS_V2_MAIN ? pkg.exports['./client'] : pkg.exports['./v2/client'];
const V2_CORE = IS_V2_MAIN ? pkg.exports['./core'] : pkg.exports['./v2/core'];

/* ── 入口声明 ─────────────────────────────────────────────────────────────── */

test('main 指向存在的文件，并且导出 apply（这是当前活着的 v1）', async () => {
  assert.ok(exists(pkg.main), `main 指向的文件不存在：${pkg.main}`);
  const mod = await import(new URL('../' + pkg.main, import.meta.url));
  assert.equal(typeof mod.apply, 'function', 'v1 入口应导出 apply');
});

test('默认导出 "." 与 main 一致（避免两处声明打架）', () => {
  assert.equal(pkg.exports['.'].replace(/^\.\//, ''), pkg.main.replace(/^\.\//, ''));
});

test('v2 入口存在且导出 apply（工作区走 ./v2，发布版就是 main）', async () => {
  const entry = IS_V2_MAIN ? pkg.main : pkg.exports['./v2'];
  assert.ok(entry, IS_V2_MAIN ? 'main 应指向 v2' : '应有 ./v2 导出');
  assert.ok(exists(entry), 'v2 入口指向的文件不存在：' + entry);
  const mod = await import(new URL('../' + entry.replace(/^\.\//, ''), import.meta.url));
  assert.equal(typeof mod.apply, 'function', 'v2 入口应导出 apply');
  if (!IS_V2_MAIN) assert.equal(pkg.exports['./v2'], './src/host/index.js');
});

test('v2 内核与前端也有子路径，且文件真实存在', () => {
  assert.ok(exists(V2_CORE), 'v2 内核子路径不存在：' + V2_CORE);
  assert.ok(exists(V2_CLIENT), 'v2 前端子路径不存在：' + V2_CLIENT);
});

test('前端入口是 ModuleLoader bundle，注册 id 必须等于包名', () => {
  const src = fs.readFileSync(abs(V2_CLIENT), 'utf8');
  assert.match(src, /__ModuleLoader__\.load\(/, '必须是 ModuleLoader bundle');
  const idMatch = src.match(/__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/);
  assert.ok(idMatch, '应能解析出注册 id');
  assert.equal(idMatch[1], pkg.name, `loader id(${idMatch[1]}) 必须等于包名(${pkg.name})，否则 ModuleLoader 会报错`);
});

/* ── 装配声明 ─────────────────────────────────────────────────────────────── */

test('dsh.bundle.patch 指向的装配文件存在，且 insert 的 id 与包名一致', () => {
  const patch = pkg.dsh?.bundle?.patch;
  assert.ok(patch, '必须声明 dsh.bundle.patch，否则市场不认为可安装');
  assert.ok(exists(patch), `装配文件不存在：${patch}`);
  const text = fs.readFileSync(abs(patch), 'utf8');
  assert.match(text, /insert:/);
  assert.match(text, new RegExp('id:\\s*' + pkg.name));
  assert.match(text, new RegExp('name:\\s*' + pkg.name));
});

test('dsh.client 声明了 web 平台与设置页注入', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0);
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
});

test('files 必须包含 src（否则发包时源码被漏掉，装上就是坏的）', () => {
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes('src'), 'files 缺少 src');
  // 工作区布局下 v1 还是活着的入口，必须一起发；切成 v2 主入口后 lib 只是历史备份
  if (!IS_V2_MAIN) assert.ok(pkg.files.includes('lib'), 'files 缺少 lib（切换前 v1 仍是活着的入口）');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  for (const entry of pkg.files) {
    if (!entry.includes('.')) assert.ok(exists(entry), `files 里列的目录不存在：${entry}`);
  }
});

/* ── 分层守卫 ─────────────────────────────────────────────────────────────── */

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const coreFiles = listFiles(path.join(ROOT, 'src', 'core'));

test('src/core 下确实有文件（避免守卫空转）', () => {
  assert.ok(coreFiles.length >= 6, `core 文件数异常：${coreFiles.length}`);
});

test('分层守卫：src/core 不允许 import 宿主/前端/插件框架', () => {
  const forbidden = [
    /from\s+['"][^'"]*\/host\//,   // 宿主层
    /from\s+['"][^'"]*\/client\//, // 前端
    /from\s+['"]cordis['"]/,       // 插件框架
    /from\s+['"]@deepseek-ai\//,   // 官方包
    /from\s+['"]dsh-/,
  ];
  for (const file of coreFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const rule of forbidden) {
      assert.ok(
        !rule.test(src),
        `分层被破坏：${path.relative(ROOT, file)} 匹配了禁止规则 ${rule}`,
      );
    }
  }
});

test('分层守卫：src/core 不依赖第三方包（只用 node: 内置模块）', () => {
  for (const file of coreFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      const ok = spec.startsWith('node:')
        || spec.startsWith('./')
        || spec.startsWith('../');
      assert.ok(ok, `${path.relative(ROOT, file)} 依赖了外部包 "${spec}"，破坏零依赖承诺`);
    }
  }
});

test('所有 src 内的相对 import 都能解析到真实文件（防手滑写错路径）', () => {
  const problems = [];
  for (const file of listFiles(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) problems.push(`${path.relative(ROOT, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(problems, [], '存在无法解析的相对 import：' + problems.join(', '));
});

test('v1 与 v2 的配置文件名互不冲突（回滚时不互相污染）', () => {
  const v2 = fs.readFileSync(path.join(ROOT, 'src', 'host', 'config.js'), 'utf8');
  const v2Name = v2.match(/dsh-local-memory\.v2-config\.json/);
  assert.ok(v2Name, 'v2 配置名应能被识别');

  // 只有工作区布局还带着 v1；v2 独立仓库里没有 lib/，这条就没意义
  const v1Path = path.join(ROOT, 'lib', 'index.js');
  if (!fs.existsSync(v1Path)) return;
  const v1 = fs.readFileSync(v1Path, 'utf8');
  const v1Name = v1.match(/dsh-local-memory-config\.json/);
  assert.ok(v1Name, 'v1 配置名应能被识别');
  assert.notEqual('dsh-local-memory-config.json', 'dsh-local-memory.v2-config.json');
});

/* ── 插件入口契约 ──
 * 这两个导出少一个，宿主会"加载成功但什么都不工作"：
 *   name   —— 插件标识
 *   inject —— Cordis 只允许访问声明过的服务，漏了会抛
 *             `cannot get property "webServer" without inject`
 * 而且这个错会被 apply 外层的 try/catch 吞掉，表现是"装上了但没工具、没路由"。
 * 2026-11-09 真实踩过：v2 重构时漏掉 inject，插件静默失效。 */
test('宿主入口必须导出 name 和 inject（漏了会静默失效）', async () => {
  const host = await import('../src/host/index.js');
  assert.equal(typeof host.name, 'string');
  assert.equal(host.name, 'dsh-local-memory');
  assert.ok(Array.isArray(host.inject), 'inject 必须是数组');
  for (const svc of ['tools', 'systemPrompt', 'webServer']) {
    assert.ok(host.inject.includes(svc), 'inject 必须包含 ' + svc);
  }
  assert.equal(typeof host.apply, 'function');
});