@echo off
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%\installer\agent-installer"
dotnet build -c Release -p:Platform=x64
if errorlevel 1 ( popd & exit /b 1 )
popd
endlocal