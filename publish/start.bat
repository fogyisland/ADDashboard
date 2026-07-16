@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo [green] Node.js not found in PATH. Install Node.js 18+ from https://nodejs.org/
  exit /b 1
)
node "%~dp0start.js" %*
endlocal