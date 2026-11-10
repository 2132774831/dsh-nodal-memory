/**
 * 打绿色版压缩包：解压即用，双击「安装.cmd」建快捷方式、可选把插件装进 DSH。
 *
 * 为什么是绿色版而不是 exe 安装器：
 *   - 无签名 exe 每次安装都会弹 SmartScreen"未知发布者"，比 zip 更吓人
 *   - zip 里的东西全是明文，用户想审查就审查（本项目就该这样）
 *
 * 产物：dist/dsh-local-memory-v<版本>-win-x64.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'dsh-local-memory';
const VERSION = '2.7.4';                 // 发行版用 v2 的入口（工作区那份仍指向 v1，等主人点头）
const STAGE = path.join(DIST, NAME);
const ZIP = path.join(DIST, `${NAME}-v${VERSION}-win-x64.zip`);

function log(...a) { console.log(...a); }
function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function cp(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

rm(DIST);
fs.mkdirSync(STAGE, { recursive: true });

/* ── 1. 拷代码 ── */
const ITEMS = [
  ['app/server.mjs', 'app/server.mjs'],
  ['app/instance.mjs', 'app/instance.mjs'],
  ['app/ui', 'app/ui'],
  ['src/core', 'src/core'],
  ['src/host', 'src/host'],
  ['src/client', 'src/client'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
];
for (const [from, to] of ITEMS) {
  const src = path.join(ROOT, from);
  if (!fs.existsSync(src)) throw new Error('缺少文件：' + from);
  cp(src, path.join(STAGE, to));
}
// 发行版里的启动器必须是纯 ASCII 文件名：安装脚本本身只能是 ASCII（cmd 对 UTF-8 中文不友好），
// 里面没法引用中文路径。仓库里那份中文名的留给本地双击用。
fs.copyFileSync(path.join(ROOT, '启动记忆软件.cmd'), path.join(STAGE, 'start.cmd'));
// 调试用的控制台版启动器：正常入口是无窗口的 LocalMemory.exe，这个只在排错时用。
fs.mkdirSync(path.join(STAGE, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'debug-console.cmd'), path.join(STAGE, 'scripts', 'debug-console.cmd'));
log('  已拷贝 ' + ITEMS.length + ' 项（备用启动器发布为 start.cmd + debug-console.cmd）');

/* ── 1b. 编译无窗口启动器 LocalMemory.exe ──
 * 为什么必须编译：快捷方式如果指向 start.cmd，运行时会留下一个黑窗口，
 * 而那个窗口就是服务本体——用户一关，服务就死了（实测反馈）。
 * 编译成 GUI 程序后用 CreateNoWindow 拉起 node，全程不出现控制台。 */
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
if (!csc) throw new Error('找不到 .NET 编译器 csc.exe，无法生成 LocalMemory.exe');
execFileSync(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/out:' + path.join(STAGE, 'LocalMemory.exe'),
  '/r:System.Windows.Forms.dll',
  path.join(ROOT, 'scripts', 'make-launcher.cs'),
], { stdio: 'inherit' });
log('  LocalMemory.exe 已编译（无窗口启动器）');

/* ── 2. 改写 package.json：发行版入口指向 v2 ── */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
pkg.version = VERSION;
pkg.main = './src/host/index.js';
pkg.exports = {
  '.': './src/host/index.js',
  './client': './src/client/index.js',
  './core': './src/core/index.js',
  './package.json': './package.json',
};
pkg.files = ['src', 'app', 'cordis.patch.yml', 'README.md', 'LICENSE'];
pkg.description = 'DeepSeek Harness 纯本地长期记忆：跨对话、跨项目，数据只存本机。默认不联网、不需要 API key；语义检索和关系图可选。附带独立界面（关系图 / 直觉 / 设置），插件只做数据接口和跳转。';
delete pkg.scripts;              // 发行包里不给开发脚本
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
log('  package.json 已改写（main → src/host/index.js，版本 ' + VERSION + '）');

/* ── 2b. 客户端 bundle 必须和宿主入口**同级** ──
 * 事故：v2.1.0 把宿主入口放到 src/host/index.js、客户端留在 src/client/index.js，
 * 结果同学机器上启动时 "web boot: 1 entry did not activate - dsh-local-memory: loading"，
 * 一个客户端插件没起来就拖死整个页面（DSH 的 boot 检查只认 active）。
 * 观察：所有能正常启动的插件，客户端文件都和宿主入口同级（index.js + client.js）。
 * 所以发行包里在 src/host/ 下也放一份 client.js，两条路径都指向它。 */
const clientSrc = path.join(STAGE, 'src', 'client', 'index.js');
const clientSibling = path.join(STAGE, 'src', 'host', 'client.js');
if (!fs.existsSync(clientSrc)) throw new Error('缺少客户端 bundle：src/client/index.js');
fs.copyFileSync(clientSrc, clientSibling);
pkg.exports['./client'] = './src/host/client.js';
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
log('  客户端 bundle 已放到与宿主入口同级的 src/host/client.js');

/* 构建期自检：解析 exports["./client"]，必须真的存在 */
const clientExport = pkg.exports['./client'];
if (!fs.existsSync(path.join(STAGE, clientExport))) {
  throw new Error('exports["./client"] 指向不存在的文件：' + clientExport);
}
if (path.dirname(clientExport) !== path.dirname(pkg.main)) {
  throw new Error('客户端 bundle 必须和宿主入口同级：main=' + pkg.main + ' client=' + clientExport);
}
log('  自检通过：客户端与入口同级');

/* ── 3a. 独立的建快捷方式脚本 ──
 * 为什么单独一个 .ps1：直接在 .cmd 里写 `powershell -Command "....(....)"` 要跨行
 * 拼接、还要过 cmd 的括号/引号解析，非常脆；而且 PowerShell 报错时 cmd 拿到的
 * errorlevel 常常还是 0，于是"建失败却显示成功"。
 * .ps1 不走 cmd 解析，还能用 UTF-8 BOM 存中文快捷方式名。 */
const SHORTCUT_PS1 = `param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
try {
  # Prefer the GUI launcher: it starts the server with no console window.
  # start.cmd is kept as a fallback (debugging / machines where the exe is gone).
  $exe = Join-Path $Root 'LocalMemory.exe'
  $cmd = Join-Path $Root 'start.cmd'
  if (Test-Path -LiteralPath $exe) {
    $target = $exe
  } elseif (Test-Path -LiteralPath $cmd) {
    $target = $cmd
  } else {
    Write-Host "[ERROR] no launcher found in: $Root"
    exit 1
  }

  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { Write-Host '[ERROR] cannot resolve Desktop folder'; exit 1 }

  $ws = New-Object -ComObject WScript.Shell

  $lnkPath = Join-Path $desktop '本地记忆.lnk'
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $target
  $lnk.Arguments = ''
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = "$env:SystemRoot\\System32\\shell32.dll,14"
  $lnk.Description = '本地记忆 — 关系图 / 直觉 / 设置'
  $lnk.Save()

  # 第二个快捷方式：停止后台服务。只有 GUI 启动器支持 --stop。
  if ($target -eq $exe) {
    $stopPath = Join-Path $desktop '本地记忆-退出.lnk'
    $stop = $ws.CreateShortcut($stopPath)
    $stop.TargetPath = $exe
    $stop.Arguments = '--stop'
    $stop.WorkingDirectory = $Root
    $stop.IconLocation = "$env:SystemRoot\\System32\\shell32.dll,131"
    $stop.Description = '停止正在后台运行的本记忆服务'
    $stop.Save()
  }

  # 回读校验：不看返回值，只认文件真的在
  if (Test-Path -LiteralPath $lnkPath) {
    Write-Host "[OK] $lnkPath"
    exit 0
  }
  Write-Host '[ERROR] shortcut file was not created'
  exit 1
} catch {
  Write-Host ("[ERROR] " + $_.Exception.Message)
  exit 1
}
`;
fs.mkdirSync(path.join(STAGE, 'scripts'), { recursive: true });
fs.writeFileSync(
  path.join(STAGE, 'scripts', 'make-shortcut.ps1'),
  '\uFEFF' + SHORTCUT_PS1.replace(/\n/g, '\r\n'),   // BOM：PowerShell 5.1 才认得中文
  'utf8',
);
log('  scripts/make-shortcut.ps1 已生成');

/* ── 3b. 安装脚本（纯 ASCII + CRLF，cmd 才不会崩）── */
const INSTALL = `@echo off
rem ============================================================
rem  dsh-local-memory installer (green build)
rem  ASCII + CRLF only: cmd.exe mangles UTF-8 and bare LF.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo(
echo   dsh-local-memory ${VERSION}
echo   ==========================================
echo(
echo   TIP: put this folder somewhere permanent first (for example
echo        D:\\Tools\\LocalMemory). The desktop shortcut points HERE,
echo        so if you move or delete this folder the shortcut breaks.
echo(
echo   This will:
echo     1. create a desktop shortcut
echo     2. ask whether to install the DSH plugin
echo(

set "LAUNCHER=%~dp0start.cmd"
if not exist "%LAUNCHER%" (
  echo   [ERROR] launcher not found: %LAUNCHER%
  pause
  exit /b 1
)

echo   [1/2] creating desktop shortcut...
rem Strip the trailing backslash from %~dp0 before passing it on.
rem %~dp0 always ends with "\", so "%~dp0" becomes "...\folder\" inside
rem quotes - PowerShell then reads \" as an escaped quote and fails with
rem "Illegal characters in path" (the shortcut silently never gets created).
set "HERE=%~dp0"
if "%HERE:~-1%"=="\\" set "HERE=%HERE:~0,-1%"
rem NOTE: the doubled backslash is required - this is a JS template literal,
rem       so a single backslash-m would be swallowed and produce "scriptsmake-...".
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\\scripts\\make-shortcut.ps1" -Root "%HERE%"
if errorlevel 1 (
  echo   [WARN] shortcut was NOT created - see the error above.
  echo          You can still start it by double-clicking LocalMemory.exe
  echo          in this folder.
) else (
  echo   [OK] desktop shortcut created.
)

echo(
set "DSHCMD="
if exist "%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" set "DSHCMD=%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd"

if not defined DSHCMD (
  echo   [2/2] DeepSeek Harness not found - skipping plugin install.
  echo         Install DeepSeek Harness first, then run this installer again.
  rem Never print "dsh plugin add <this folder>": that creates a link: to
  rem wherever the zip was unzipped, so moving or deleting the folder later
  rem would break the plugin. The installer below copies to a stable place.
  goto :done
)

echo   [2/2] DeepSeek Harness found.
set /p ANS=        Install the memory plugin into DeepSeek Harness now? [y/N] 
if /i not "%ANS%"=="y" (
  echo         Skipped. You can install it later by running this installer again.
  goto :done
)

rem ---------------------------------------------------------------
rem  Install from a STABLE copy under .dsh\plugins, not from wherever
rem  this zip was extracted. "dsh plugin add <dir>" creates a link:
rem  dependency - if we pointed it at the Desktop folder, deleting or
rem  moving the installer afterwards would break DSH on next start.
rem ---------------------------------------------------------------
set "TARGET=%USERPROFILE%\\.dsh\\plugins\\dsh-local-memory"
echo         copying to a stable location:
echo           %TARGET%
if exist "%TARGET%\\package.json" (
  echo         [note] an older copy exists, refreshing it.
) else (
  mkdir "%TARGET%" 2>nul
)
xcopy "%~dp0*" "%TARGET%\\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo   [ERROR] failed to copy to %TARGET%
  echo           If you ran this from a restricted terminal, run it again
  echo           by double-clicking it in Explorer instead.
  goto :done
)

echo         installing (this may take a minute)...
call "%DSHCMD%" plugin --profile desktop add "%TARGET%"
if errorlevel 1 (
  echo   [WARN] install failed. Possible reasons:
  echo          - a restricted terminal/sandbox (EPERM on package.json.lock)
  echo            =^> close this window and run this installer again by
  echo               double-clicking it in Explorer
  echo          - DeepSeek Harness is running and holding a lock
  echo            =^> quit Harness completely, then run this again
  goto :done
)

echo   [OK] plugin installed.
echo(
echo   IMPORTANT: restart DeepSeek Harness now.
echo              Plugins are assembled at startup; a running Harness
echo              will NOT load the new package until you restart it.
echo(
echo   After restart: Settings - local memory.
echo(
echo   Note: lines like "Packages: -5" or peer-dependency warnings
echo         during install are normal pruning, not failures.

:done
echo(
echo   Done. Data lives in: %USERPROFILE%\\.dsh\\dsh-local-memory.db
echo   Uninstall never deletes your memories.
echo(
pause
`;
fs.writeFileSync(path.join(STAGE, '安装.cmd'), INSTALL.replace(/\n/g, '\r\n'), 'ascii');
log('  安装.cmd 已生成（ASCII + CRLF）');

/* 构建期自检：cmd 脚本最容易死在"JS 模板把反斜杠吃掉"上，写完必须回读断言。
 * 已经踩过两次：\m 变成 m（快捷方式路径错）、"\" 变成 ""（尾斜杠没去掉 → 路径非法）。 */
{
  const instPath = path.join(STAGE, '安装.cmd');
  const written = fs.readFileSync(instPath, 'ascii');
  const checks = [
    ['尾斜杠处理', 'if "%HERE:~-1%"=="\\"'],
    ['快捷方式脚本路径', '%HERE%\\scripts\\make-shortcut.ps1'],
    ['不再指向解压目录装插件', 'add "%~dp0."'],
  ];
  const [okName, okNeedle] = checks[0];
  if (!written.includes(okNeedle)) {
    throw new Error('安装.cmd 自检失败：' + okName + ' 被转义吃掉了（缺 ' + okNeedle + '）');
  }
  if (written.includes(checks[2][1])) {
    throw new Error('安装.cmd 自检失败：仍然提示把插件的 link 指向解压目录');
  }
}

/* ── 4. 打包 ── */
const ps = [
  '-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
  `if (Test-Path '${ZIP}') { Remove-Item '${ZIP}' -Force }; ` +
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${STAGE}', '${ZIP}', [System.IO.Compression.CompressionLevel]::Optimal, $true)`,
];
execFileSync('powershell.exe', ps, { stdio: 'inherit' });

const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(2);
let count = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else count++; } })(STAGE);
log('');
log('  ✔ ' + ZIP);
log('    ' + count + ' 个文件 / ' + mb + ' MB');
