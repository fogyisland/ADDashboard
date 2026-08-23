[CmdletBinding()]
param(
  [string]$InstallPath,
  [switch]$RemoveData
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent')
}

# ============================================================================
# Uninstall AD Dashboard Agent.
#
# 2026-08-23 split: this script now ONLY removes the install directory; the
# SCM-facing steps (Stop service + nssm remove) live in
# Register-ADDashboardAgent.ps1 -Action Unregister — the same single entry
# point that install-agent.ps1 invokes with -Action Register. This eliminates
# the prior split where uninstall-agent.ps1 directly imported common/Service.psm1
# while install-agent.ps1 went through a different code path; both now share
# the same NSSM/Service recovery sequence.
# ============================================================================

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force

# Push LogDir into Logger.psm1's module-scoped $Script:LogDir.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-LogDir $Script:LogDir

Write-Step "uninstalling agent on $env:COMPUTERNAME"
& (Join-Path $PSScriptRoot 'Register-ADDashboardAgent.ps1') `
    -InstallPath $InstallPath `
    -CenterUrl   '' `
    -AgentToken  '' `
    -AgentType   'ad' `
    -Action      Unregister `
    -SkipStart
# CenterUrl / AgentToken are unused by -Action Unregister; the placeholder
# values satisfy Register-ADDashboardAgent.ps1's [Parameter(Mandatory)] on
# both. -SkipStart is irrelevant for Unregister but kept symmetric with
# install-agent.ps1's call shape.
if ($LASTEXITCODE -ne 0) { Write-Err2 "Register Unregister failed: $LASTEXITCODE" }

if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force }
# -RemoveData was a no-op alias for $InstallPath removal in the old layout.
# Kept for caller compatibility — InstallPath (which contains queue.db and
# logs) is already gone above.
Write-Ok "done"