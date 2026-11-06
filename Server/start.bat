@echo off
setlocal EnableExtensions

REM AD Replication Dashboard — green-bundle entry.
REM Default: install + start ADDashboardCenter Windows service, then exit (one-shot).
REM --console / -c: run node server.js in foreground (dev mode).
REM --help / -h: show usage.

set "MODE=service"
if /I "%~1"=="--console" set "MODE=console"
if /I "%~1"=="-c"        set "MODE=console"
if /I "%~1"=="--help"    set "MODE=help"
if /I "%~1"=="-h"        set "MODE=help"

if "%MODE%"=="help" goto :help
if "%MODE%"=="console" goto :console

REM R161.27: bundled Node first (root/node/node.exe), PATH as fallback.
REM Operator directive: target machines must NOT need a separate Node install.
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

REM ---- service mode ----
where powershell >nul 2>&1
if errorlevel 1 (
  echo [start] PowerShell not found in PATH. Install PowerShell 5.1+ from https://aka.ms/powershell
  exit /b 1
)
net session >nul 2>&1
if errorlevel 1 (
  echo [start] Service install requires Administrator. Re-run this cmd as Administrator.
  exit /b 1
)
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-center.ps1" -InPlace
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:console
where node >nul 2>&1
if errorlevel 1 (
  echo [console] Node.js not found - neither the bundled node directory nor PATH has node.exe. The bundle's node directory must be complete.
  exit /b 1
)
pushd "%~dp0center"
node server.js
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:help
echo Usage: start.bat [--console^|-c ^| --help^|-h]
echo   (default)   install + start ADDashboardCenter Windows service, then exit
echo   --console   run node server.js in foreground (dev mode)
echo   --help      show this message
exit /b 0