@echo off
setlocal
rem Thin wrapper around build-msi.ps1 so cmd-only hosts have a single entry
rem point. The PowerShell script owns staging + dotnet build + MSI copy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-msi.ps1"
if errorlevel 1 ( exit /b 1 )
endlocal