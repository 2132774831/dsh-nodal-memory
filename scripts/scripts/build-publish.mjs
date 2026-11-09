/**
 * 构建发布包（tarball）。
 *
 * 为什么不直接 `npm pack`：
 *   工作区的 package.json 主入口仍是 v1（lib/index.js），v2 通过 exports['./v2'] 暴露。
 *   发布包必须把 v2 变成正式入口，否则用户装到的还是 v1。
 *
 * 这个脚本做三件事：
 *   1. 从 git 导出 v2 分支的已提交内容（自动排除 app/data、node_modules 等未跟踪物）
 *   2. 删掉 v1 的 lib/ 和开发用的 test/（"发布不带原代码"）
 *   3. 重写 package.json 成发布版（入口指向 src/host/index.js）
 *
 * 用法：node scripts/build-publish.mjs [--out <目录>]
 * 产物：<目录>/dsh-local-memory.tgz
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArgIdx = process.argv.indexOf('--out');
const OUT_DIR = outArgIdx > 0 ? path.resolve(process.argv[outArgIdx + 1]) : path.join(ROOT, 'dist');

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-publish-'));

function sh(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'buffer' });
}

try {
  console.log('1. 从 git 导出 v2 分支…');
  const zipPath = path.join(staging, 'src.zip');
  sh('git', ['archive', '--format=zip', '-o', zipPath, 'v2']);
  const tree = path.join(staging, 'tree');
  fs.mkdirSync(tree, { recursive: true });
  // 用 Node 自带的解压能力避免依赖 tar
  const { execFileSync: ex } = await import('node:child_process');
  if (process.platform === 'win32') {
    ex('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${tree}' -Force`]);
  } else {
    ex('unzip', ['-q', zipPath, '-d', tree]);
  }

  console.log('2. 删掉 v1 代码与开发资源…');
  for (const p of ['lib', 'test']) {
    const full = path.join(tree, p);
    if (fs.existsSync(full)) { fs.rmSync(full, { recursive: true, force: true }); console.log('   删除 ' + p + '/'); }
  }

  console.log('3. 重写 package.json 为发布版…');
  const pkgPath = path.join(tree, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = '2.0.0';
  pkg.main = './src/host/index.js';
  pkg.exports = {
    '.': './src/host/index.js',
    './core': './src/core/index.js',
    './client': './src/client/index.js',
    './package.json': './package.json',
  };
  pkg.files = ['src', 'app/server.mjs', 'app/ui', 'docs', 'scripts', 'cordis.patch.yml',
    'README.md', 'INSTALL.md', 'CHANGELOG.md', 'LICENSE'];
  pkg.scripts = { app: 'node app/server.mjs --open', 'verify:install': 'node scripts/verify-install.mjs' };
  pkg.engines = { node: '>=22.5.0' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log('4. 打 tarball…');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Windows 上 Node 不允许直接 spawn .cmd/.bat（会 EINVAL）。
  // 用 cmd.exe 包一层，而不是 shell:true —— 后者会带一条 DeprecationWarning。
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --silent'], { cwd: tree, stdio: 'inherit' });
  } else {
    execFileSync('npm', ['pack', '--silent'], { cwd: tree, stdio: 'inherit' });
  }
  const produced = fs.readdirSync(tree).find((f) => f.endsWith('.tgz'));
  if (!produced) throw new Error('npm pack 没有产出 tgz');

  // 统一成不带版本号的名字（latest/download 链接才不会 404）
  const target = path.join(OUT_DIR, 'dsh-local-memory.tgz');
  fs.copyFileSync(path.join(tree, produced), target);

  const size = (fs.statSync(target).size / 1024).toFixed(1);
  console.log(`\n✔ 产物: ${target}  (${size} KB)`);
  console.log('  资产名不带版本号，release 的 latest/download 链接长期有效');
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
