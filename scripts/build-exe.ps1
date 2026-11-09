# Build a single-file Windows installer EXE for dsh-local-memory.
#
# Approach: stage the program -> zip it -> compile a tiny C# self-extractor
# (make-installer.cs) that embeds the zip as a resource. The .NET Framework
# compiler ships with Windows, so this needs no downloads.
#
# Output: dist\dsh-local-memory-setup-<version>.exe
#
# Keep this file ASCII-only (Windows PowerShell 5.1 without a BOM will misread
# non-ASCII text in .ps1 files).

param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$Version = '2.4.4'
)

$ErrorActionPreference = 'Stop'
function Fail($msg) { Write-Host "[ERROR] $msg"; exit 1 }

$srcApp = Join-Path $Root 'dist\dsh-local-memory'
if (-not (Test-Path (Join-Path $srcApp 'start.cmd'))) {
    Fail "dist payload not found: $srcApp (run build-dist.mjs first)"
}

$csc = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { Fail '.NET Framework compiler (csc.exe) not found' }

$work = Join-Path $env:TEMP 'lm-exe-build'
$stage = Join-Path $work 'stage'
$payload = Join-Path $stage 'payload'

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $payload -Force | Out-Null

# --------------------------------------------------------------------------
# 1. stage program files
# --------------------------------------------------------------------------
Write-Host '[1/5] staging payload...'
$copied = 0
Get-ChildItem $srcApp -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($srcApp.Length + 1)
    if ($rel -match '[^\x00-\x7F]') {
        Write-Host ('        skipped (non-ASCII name): ' + $rel)
        return
    }
    $dest = Join-Path $payload $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item $_.FullName $dest -Force
    $copied++
}
Write-Host ('        ' + $copied + ' files')

# --------------------------------------------------------------------------
# 2. installer body  (ASCII + CRLF: cmd.exe mangles anything else)
# --------------------------------------------------------------------------
Write-Host '[2/5] writing setup.cmd...'
$setup = @'
@echo off
setlocal enabledelayedexpansion
title Local Memory - Setup

echo(
echo   Local Memory: standalone memory app
echo   ==========================================
echo(

set "DEST=%LOCALAPPDATA%\dsh-local-memory-app"

rem /S = silent: no questions, no pause. Used by automated installs/tests.
set "SILENT="
if /i "%~1"=="/S" set "SILENT=1"

echo   [1/3] copying program files...
if not exist "%DEST%" mkdir "%DEST%" 2>nul
xcopy "%~dp0payload\*" "%DEST%\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo   [ERROR] could not copy files to %DEST%
  echo           Try running this installer again from Explorer.
  pause
  exit /b 1
)
echo         installed to: %DEST%

echo   [2/3] creating desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\scripts\make-shortcut.ps1" -Root "%DEST%"
if errorlevel 1 (
  echo   [WARN] shortcut was not created - you can still run start.cmd in:
  echo          %DEST%
) else (
  echo         shortcut created on your desktop
)

echo   [3/3] DeepSeek Harness plugin (optional)
if defined SILENT (
  echo         silent mode - plugin install skipped.
  goto :done
)
set "DSHCMD="
if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSHCMD=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if not defined DSHCMD (
  echo         DeepSeek Harness not found - skipped.
  goto :done
)

set /p ANS=        Also install the memory plugin into DeepSeek Harness? [y/N] 
if /i not "%ANS%"=="y" (
  echo         Skipped. The standalone app works on its own.
  goto :done
)

rem Install from the stable copy, never from the temp extraction dir:
rem "dsh plugin add <dir>" records a link: dependency, so pointing it at a
rem temp folder would break DSH as soon as that folder is cleaned up.
set "PLUGDIR=%USERPROFILE%\.dsh\plugins\dsh-local-memory"
if not exist "%PLUGDIR%" mkdir "%PLUGDIR%" 2>nul
xcopy "%DEST%\*" "%PLUGDIR%\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo   [ERROR] could not copy plugin files to %PLUGDIR%
  goto :done
)
call "%DSHCMD%" plugin --profile desktop add "%PLUGDIR%"
if errorlevel 1 (
  echo   [WARN] plugin install failed. Common causes:
  echo          - DeepSeek Harness is running and holds a lock
  echo            =^> quit Harness completely, then run this installer again
  echo          - restricted terminal; run it by double-clicking instead
  echo         The standalone app is still installed and usable.
  goto :done
)
echo         plugin installed.
echo(
echo   IMPORTANT: quit DeepSeek Harness completely and start it again.
echo              Plugins are assembled at startup; a running Harness will
echo              not pick up the new package until restarted.

:done
echo(
echo   Done.
echo   Program : %DEST%
echo   Data    : %USERPROFILE%\.dsh\dsh-local-memory.db
echo   Your memories are never deleted by an uninstall.
echo(
if not defined SILENT pause
if defined SILENT exit /b 0
'@
$setupPath = Join-Path $stage 'setup.cmd'
$setupLines = $setup -split "`r?`n"
[System.IO.File]::WriteAllText($setupPath, ($setupLines -join "`r`n"), [System.Text.Encoding]::ASCII)

# --------------------------------------------------------------------------
# 3. zip the stage
# --------------------------------------------------------------------------
Write-Host '[3/5] compressing payload...'
$zipPath = Join-Path $work 'payload.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
# Compress only the *contents* so paths inside the zip stay relative.
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipSize = (Get-Item $zipPath).Length
Write-Host ('        payload.zip: ' + [math]::Round($zipSize / 1KB, 1) + ' KB')

# --------------------------------------------------------------------------
# 4. compile the self-extractor
# --------------------------------------------------------------------------
Write-Host '[4/5] compiling installer EXE...'
$cs = Join-Path $Root 'scripts\make-installer.cs'
$exeOut = Join-Path $work 'setup.exe'
if (-not (Test-Path $cs)) { Fail "stub source not found: $cs" }
if (Test-Path $exeOut) { Remove-Item $exeOut -Force }

$args = @(
    '/nologo',
    '/target:exe',
    '/optimize+',
    ('/out:' + $exeOut),
    ('/resource:' + $zipPath + ',payload.zip'),
    '/r:System.IO.Compression.FileSystem.dll',
    '/r:System.IO.Compression.dll',
    '/r:System.Windows.Forms.dll',
    $cs
)
$proc = Start-Process -FilePath $csc -ArgumentList $args -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -ne 0 -or -not (Test-Path $exeOut)) {
    Fail ('csc failed with exit code ' + $proc.ExitCode)
}

# --------------------------------------------------------------------------
# 5. publish
# --------------------------------------------------------------------------
Write-Host '[5/5] verifying...'
$final = Join-Path $Root ('dist\dsh-local-memory-setup-{0}.exe' -f $Version)
if (Test-Path $final) { Remove-Item $final -Force }
Copy-Item $exeOut $final -Force

$exe = Get-Item $final
Write-Host ('        OK  ' + $exe.FullName)
Write-Host ('        size: ' + [math]::Round($exe.Length / 1MB, 2) + ' MB')
Write-Host ('        files inside: ' + $copied)
