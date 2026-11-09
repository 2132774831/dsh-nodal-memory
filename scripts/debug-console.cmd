@echo off
rem ============================================================
rem  Troubleshooting launcher: runs the server IN THIS CONSOLE
rem  so you can read its log. Closing this window stops the
rem  server - that is expected here.
rem
rem  Normal users should use the desktop shortcut or start.cmd,
rem  which start the server with no console window.
rem ============================================================
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\node\node.exe" set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\node\node.exe"
if not defined NODE goto :nonode

set "SEEDARG="
if exist "%USERPROFILE%\.dsh\dsh-local-memory.json" set "SEEDARG=--seed"

"%NODE%" app\server.mjs --open %SEEDARG% %*
echo.
echo   Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo   [ERROR] Node.js not found.
pause
exit /b 1