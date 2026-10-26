# upgrade-agent-to-0.1.1.ps1 — bump agent bundle 0.1.0 → 0.1.1 in-place.
#
# Operator directive 2026-10-02:
#   "现在可以将 d 盘这个 agentinstall 设置为0.1.1"
#   i.e. C:\agentInstall\agent\ (KDLDLOFADSRV1 真机, operator 9/27 复制
#   出来的 bundle) 重新打包标记 0.1.1.
#
# 跟中心仓 D:\dashboard\agent\ 的关系:
#   中心仓现在是 0.1.1 (build-manifest.json + agent.js:44 VERSION).
#   真机 C:\agentInstall\agent\ 还是 0.1.0 — 此脚本用来把它覆盖到 0.1.1
#   让两边一致. agent 服务重启后会读 VERSION 常量 + Get-AgentManifest
#   boot fingerprint 报 0.1.1.
#
# Run on target (KDLDLOFADSRV1):
#   powershell -ExecutionPolicy Bypass -File upgrade-agent-to-0.1.1.ps1
#
# 步骤:
#   1. Stop service "DashboardAgent" (service name per KDLFLOFADSRV1 R158.9 template;
#      如果 KDLDLOFADSRV1 service 名字不同, 改 line 30)
#   2. Copy-Item 覆盖 0.1.0 → 0.1.1 (preserve appsettings.json — 它包含
#      operator 已经配的 agentToken / centerUrl / heartbeat / 数据采集目录)
#   3. Start service
#   4. 等 60s heartbeat 后, /api/dashboard/agents 列表中 KDLDLOFADSRV1
#      boot_fingerprint 应该报 "version=0.1.1"
#
# Pre-check (dry-run): set $env:DRY_RUN = '1' before invoking.
#
# ⚠️ 不覆盖 appsettings.json — 那是 operator 现场配置, 包含 agentToken.
# ⚠️ 不覆盖 data\ — 包 cache, agent 会自己 syncFromCenter.
# ⚠️ 不覆盖 logs\ — 现场历史日志.
#
# 反向 roll-back (0.1.1 → 0.1.0):
#   git checkout 0.1.0 -- agent.js build-manifest.json   (在中心仓)
#   重跑本脚本 (会从中心仓 0.1.0 覆盖回 KDLDLOFADSRV1)

param(
    [string]$ServiceName = 'DashboardAgent',
    [string]$InstallDir  = 'C:\agentInstall\agent',
    [string]$SourceDir   = 'D:\dashboard\agent',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $InstallDir)) {
    Write-Error "FAIL: install dir $InstallDir 不存在"
    exit 1
}
if (-not (Test-Path $SourceDir)) {
    Write-Error "FAIL: source dir $SourceDir 不存在"
    exit 1
}

$srcManifest = Get-Content (Join-Path $SourceDir 'build-manifest.json') -Raw | ConvertFrom-Json
Write-Host "source version : $($srcManifest.version)"
Write-Host "source buildTm : $($srcManifest.buildTime)"
Write-Host "install dir    : $InstallDir"

$dstManifestPath = Join-Path $InstallDir 'build-manifest.json'
$dstManifest = $null
if (Test-Path $dstManifestPath) {
    $dstManifest = Get-Content $dstManifestPath -Raw | ConvertFrom-Json
    Write-Host "target version : $($dstManifest.version)"
} else {
    Write-Host "target version : (no manifest — fresh install)"
}

if ($dstManifest -and $dstManifest.version -eq $srcManifest.version) {
    Write-Host "✓ already at $($srcManifest.version) — no-op"
    exit 0
}

# Files to copy (white-list; never touch appsettings.json / data / logs)
$filesToCopy = @(
    'agent.js',
    'build-manifest.json'
)
foreach ($f in $filesToCopy) {
    $src = Join-Path $SourceDir $f
    $dst = Join-Path $InstallDir $f
    if (-not (Test-Path $src)) {
        Write-Error "FAIL: source file $src missing"
        exit 1
    }
    if ($DryRun) {
        Write-Host "[DRY] would copy $src → $dst"
    } else {
        Copy-Item -Path $src -Destination $dst -Force
        Write-Host "  copied $f"
    }
}

# Service control (skip in DryRun)
if ($DryRun) {
    Write-Host "[DRY] would stop / start service: $ServiceName"
    exit 0
}

Write-Host "stopping service $ServiceName ..."
Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "starting service $ServiceName ..."
Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# Verify service state
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "✓ service $ServiceName running"
} else {
    Write-Warning "service $ServiceName status: $($svc.Status)"
}

# Re-read manifest to confirm
$newManifest = Get-Content $dstManifestPath -Raw | ConvertFrom-Json
Write-Host "✓ target version now: $($newManifest.version) (buildTm $($newManifest.buildTime))"
Write-Host ""
Write-Host "NEXT STEPS:"
Write-Host "  1. 等 ≤60s heartbeat 后, 查看 KDLDLOFADSRV1 boot_fingerprint 应为 0.1.1"
Write-Host "  2. /api/dashboard/agents 列表中该 agent 的 version 字段应已更新"
Write-Host "  3. UI 验证: 包运行监控 (/packages-runs) banner sha 应仍 OK (代码无改动)"
