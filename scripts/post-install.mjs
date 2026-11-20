/**
 * 安装卡片点按钮后调用的动作脚本（不需要 App 在跑）。
 *
 *   node post-install.mjs install-dsh          装进 DeepSeek Harness
 *   node post-install.mjs export-mcp <目标文件>  导出 MCP 服务器
 *   node post-install.mjs info                 打印安装目录等基本信息
 *
 * 输出一行 JSON，方便 C# 那边读结果给用户看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN_NAME = 'dsh-local-memory';

function dshHome() {
  return process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

function profileDir() {
  const root = path.join(dshHome(), 'profiles');
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    if (dirs.includes('desktop')) return path.join(root, 'desktop');
    return dirs.length ? path.join(root, dirs[0]) : null;
  } catch { return null; }
}

function done(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function installDsh() {
  const home = dshHome();
  const pluginDir = path.join(home, 'plugins', PLUGIN_NAME);
  const prof = profileDir();
  if (!prof) {
    done({ ok: false, error: '没找到 DeepSeek Harness 的配置目录（' + path.join(home, 'profiles') + '）。请先安装并打开一次 DSH。' });
    return;
  }
  const changes = [];
  try {
    // 1) 复制插件文件
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.cpSync(ROOT, pluginDir, {
      recursive: true,
      filter: (s) => !/[\\/](node_modules|\.git|dist)([\\/]|$)/.test(s),
    });
    changes.push('已复制插件到 ' + pluginDir);

    // 2) 挂进 profile（改前备份）
    const pkgFile = path.join(prof, 'package.json');
    const raw = fs.readFileSync(pkgFile, 'utf8');
    // ⚠ 别直接用 JSON.parse：PowerShell 写的 package.json 可能带 BOM，
    //   JSON.parse('\uFEFF{...}') 会直接抛 "Unexpected token"。要剥掉。
    const clean = raw.replace(/^\uFEFF/, '');
    const pkg = JSON.parse(clean);
    fs.writeFileSync(pkgFile + '.lm-bak', raw, 'utf8');

    pkg.dependencies = pkg.dependencies || {};
    const linkSpec = 'link:' + pluginDir.replace(/\\/g, '/');
    if (pkg.dependencies[PLUGIN_NAME] !== linkSpec) {
      pkg.dependencies[PLUGIN_NAME] = linkSpec;
      changes.push('已在 profile 依赖里挂上 link:');
    }
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!bundles.includes(PLUGIN_NAME)) {
      bundles.push(PLUGIN_NAME);
      pkg.dsh.profile.bundles = bundles;
      changes.push('已把 ' + PLUGIN_NAME + ' 加进 bundles');
    }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    done({ ok: true, changes, pluginDir, profile: prof, needsRestart: true });
  } catch (e) {
    done({ ok: false, error: e.message });
  }
}

function exportMcp(target) {
  try {
    const src = path.join(ROOT, 'app', 'mcp-server.mjs');
    if (!fs.existsSync(src)) { done({ ok: false, error: '安装不完整：缺少 app/mcp-server.mjs' }); return; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
    done({
      ok: true,
      path: target,
      config: { command: process.execPath, args: [target], env: {} },
      hint: '把 command/args 填进你用的 agent 的 MCP 配置里',
    });
  } catch (e) {
    done({ ok: false, error: e.message });
  }
}

const cmd = process.argv[2] || 'info';
if (cmd === 'install-dsh') installDsh();
else if (cmd === 'export-mcp') exportMcp(process.argv[3] || path.join(process.cwd(), 'dsh-local-memory-mcp.mjs'));
else done({ ok: true, root: ROOT, dshHome: dshHome(), profile: profileDir() });
