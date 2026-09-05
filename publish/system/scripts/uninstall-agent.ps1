[CmdletBinding()]
param(
  [string]$InstallPath,
  [switch]$RemoveData
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
#
# Two supported layouts (mirror of start.ps1:88-104 + install-agent.ps1):
#   GREEN PACKAGE: $PSScriptRoot\agent\  (script at <green>/agentInstall/,
#                                         agent/ is a sibling — flat layout).
#                     Uninstall path mirrors install: the green package's
#                     install path IS the current directory's agent/ subdir,
#                     so uninstall targets the same dir without prompting.
#   DEV TREE:      $PSScriptRoot\..\Agent\ (script at <repo>/scripts/,
#                                          parent is repo root).
#
# Without this green-pkg-first check, the legacy default always resolves to
# <PSScriptRoot>\..\Agent = C:\Agent on a green-pkg run → Set-LogDir fails →
# Logger.psm1:21 Add-Content can't write to C:\Agent\Logs\install.log.
if (-not $InstallPath) {
  $greenPkgAgent = Join-Path $PSScriptRoot 'agent'
  $devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
  if (Test-Path $greenPkgAgent) {
    $InstallPath = $greenPkgAgent
  } elseif (Test-Path $devTreeAgent) {
    $InstallPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent'
  } else {
    throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout). Verify the bundle layout."
  }
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

# Detect Windows case-collision between InstallPath and the green-package's
# agent/ source dir. On Windows the default install path <root>/Agent and the
# source <root>/agent resolve to the same physical directory; if we proceed
# with Remove-Item here we'd nuke the green package (including install-agent.ps1,
# agent.js, package.json, etc.). Refuse the directory removal in that case —
# the service has already been unregistered above, so the operator's intent
# (stop the agent) is satisfied. The green package remains on disk for
# re-install or troubleshooting.
$greenPkgAgent = Join-Path $PSScriptRoot 'agent'
$devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
$candidateSrc  = $null
if (Test-Path $greenPkgAgent) { $candidateSrc = $greenPkgAgent }
elseif (Test-Path $devTreeAgent) { $candidateSrc = $devTreeAgent }
$resolvedInstall = (Resolve-Path -LiteralPath $InstallPath -ErrorAction SilentlyContinue).ProviderPath
$resolvedSrc     = if ($candidateSrc) { (Resolve-Path -LiteralPath $candidateSrc -ErrorAction SilentlyContinue).ProviderPath } else { $null }
if ($resolvedInstall -and $resolvedSrc -and [string]::Equals($resolvedInstall, $resolvedSrc, [StringComparison]::OrdinalIgnoreCase)) {
  Write-Step "install path equals source path ($resolvedInstall); leaving green package on disk (service already unregistered)"
} elseif (Test-Path $InstallPath) {
  Remove-Item -Path $InstallPath -Recurse -Force
  # -RemoveData was a no-op alias for $InstallPath removal in the old layout.
  # Kept for caller compatibility — InstallPath (which contains queue.db and
  # logs) is already gone above.
}
Write-Ok "done"