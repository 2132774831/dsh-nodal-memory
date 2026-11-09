@echo off
rem ============================================================
rem  Local Memory (standalone) launcher
rem  NOTE: this file MUST stay pure ASCII with CRLF line endings.
rem  cmd.exe mis-parses LF-only batch files, and non-ASCII text
rem  gets mangled under the OEM codepage.
rem ============================================================
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"

if not defined NODE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\node\node.exe" set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\node\node.exe"

if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE goto :nonode

set "SEEDARG="
if exist "%USERPROFILE%\.dsh\dsh-local-memory.json" set "SEEDARG=--seed"

echo.
echo   Starting local-memory app...
echo.

"%NODE%" app\server.mjs --open %SEEDARG% %*

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Install Node.js 18+ or add it to PATH, then run this again.
echo.
pause
exit /b 1
