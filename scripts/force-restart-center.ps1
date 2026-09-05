#requires -RunAsAdministrator
# 2026-09-05 R78 — Force-restart the NSSM-managed ADDashboardCenter service
# so it picks up the current server.js + appsettings.json + dist (R73-R81).
#
# Operator reported that normal `nssm restart` / `Stop-Service` / `Stop-Process -Force`
# all return "拒绝访问" because the live PID 38600 was spawned from a SYSTEM-owned
# NSSM session and the user shell is not elevated. Run this script in an
# elevated PowerShell (right-click → Run as administrator) to force the swap.

$ErrorActionPreference = 'Stop'

$svc = 'ADDashboardCenter'

Write-Host "[restart-center] current process info:" -ForegroundColor Cyan
$pid38600 = Get-Process -Id 38600 -ErrorAction SilentlyContinue
if ($pid38600) {
    Write-Host "  PID 38600: StartTime=$($pid38600.StartTime)"
    Write-Host "  (Started 8月23日 — stale, must be killed)"
} else {
    Write-Host "  PID 38600 not found — service may already be running fresh"
}

# 1. Stop the service (this is what was failing under unelevated PowerShell)
Write-Host "[restart-center] Stop-Service $svc -Force" -ForegroundColor Yellow
Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2. Belt-and-suspenders: kill the orphaned PID 38600 if it survived Stop-Service
$orphan = Get-Process -Id 38600 -ErrorAction SilentlyContinue
if ($orphan) {
    Write-Host "[restart-center] kill orphan PID 38600" -ForegroundColor Yellow
    Stop-Process -Id 38600 -Force
    Start-Sleep -Seconds 1
}

# 3. Start the service — NSSM will re-spawn node from publish/system/center/server.js
Write-Host "[restart-center] Start-Service $svc" -ForegroundColor Yellow
Start-Service -Name $svc
Start-Sleep -Seconds 3

# 4. Verify
Write-Host "[restart-center] verify:" -ForegroundColor Cyan
Get-Service $svc | Select-Object Name,Status,StartType | Format-Table -AutoSize
Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue |
    Select-Object LocalPort, OwningProcess, State | Format-Table -AutoSize

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/healthz' -TimeoutSec 5
Write-Host "[restart-center] healthz: $health" -ForegroundColor Green

# 5. Show the new startedVersion (compare against the old stale one)
$log = Get-ChildItem -Path 'D:\ToolDevelop\ADDashboard\center\Logs\ADDashboardCenter-stderr.log' |
    Select-Object -First 1
$started = Select-String -Path $log.FullName -Pattern 'startedVersion' |
    Select-Object -Last 1
Write-Host "[restart-center] latest startedVersion: $($started.Line)" -ForegroundColor Green
Write-Host "[restart-center] expected NOT to be 293973afe98b55aa (the stale Aug 23 version)" -ForegroundColor Gray
