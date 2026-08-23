@echo off
rem start.bat — operator-facing entry for the AD Dashboard Agent green package.
rem
rem Thin wrapper around upgrade-agent.ps1. The PowerShell script owns the
rem actual install / hot-update dispatch logic (Read-Host prompts for
rem CenterUrl + AgentToken on first-time install, service detection, file
rem copy + npm install + restart on hot update).
rem
rem Why a .bat wrapper at all:
rem   - Operator types `start.bat` instead of the long PowerShell invocation
rem     with -NoProfile -ExecutionPolicy Bypass -File.
rem   - No extension-association or execution-policy friction on the target
rem     machine (PS 5.1 on Windows Server often defaults to Restricted).
rem   - Tab-completion works the same way as `npm start` / `start.bat`
rem     operators are already used to.
rem
rem %~dp0 resolves the directory containing this .bat, so the wrapper works
rem regardless of the current working directory when invoked. %* forwards
rem all arguments unchanged to the PowerShell script — operators can still
rem pass `-ComputerName`, `-CenterUrl`, `-AgentToken`, etc.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upgrade-agent.ps1" %*
exit /b %ERRORLEVEL%