# SECURITY: this script uses Invoke-Command; -ComputerName values must be trusted and reachable over WinRM.
# AgentToken is sent in cleartext over the WinRM channel — use HTTPS WinRM or pre-shared credentials in production.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string[]]$ComputerName,
  [Parameter(Mandatory)][string]$CenterUrl,
  [Parameter(Mandatory)][string]$AgentToken,
  # T16: agent type discriminator. 'ad' (default) installs the legacy DC
  # collector with DisplayName "AD Replication Agent (on <host>)"; 'non-ad'
  # installs the member-server runtime with DisplayName "AD Dashboard
  # Agent (Member)" and persists agentType to appsettings.json so the
  # running process picks it up on next start. Backward compatible: callers
  # who omit the param keep the pre-T16 behavior.
  [ValidateSet('ad','non-ad')]
  [string]$AgentType = 'ad',
  [string]$InstallPath,
  # Internal-use parameters for remote-install forwarding. When the script runs
  # in a remote session, $PSScriptRoot is null; we pre-resolve and pass these
  # explicitly so the scriptblock always knows where to copy from.
  [string]$AgentSrc,
  [string]$PsScriptSrc
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent')
}

# ============================================================================
# Local / WinRM remote install for AD Dashboard Agent. As of v2.1+, this is
# the SECONDARY install path; the primary path is the WiX MSI installer
# (addashboard-agent-x64-<version>.msi). Operators who can double-click an
# MSI (or run `msiexec /i ... /qn CENTERURL=... AGENTTOKEN=... AGENTTYPE=...`)
# should prefer the MSI path — see docs/operations/deployment.md §Agent MSI
# Install. This script remains for:
#   - WinRM-based remote install to multiple machines from a management box
#   - Air-gapped environments where pulling the MSI binary is undesirable
# Both paths produce the same service name (ADReplicationAgent) and the same
# NSSM configuration, so you can switch between them freely.
#
# 2026-08-23 split: this script now ONLY does file copy + `npm install`; the
# SCM-facing steps (appsettings.json write + NSSM install + NSSM parameters +
# sc.exe failure recovery + Start-Service) live in
# Register-ADDashboardAgent.ps1 — the single entry point shared with
# uninstall-agent.ps1 and (future) the MSI's ConfigureAgentAction. This
# eliminates the pre-split duplication where the green package was missing
# the Set-ServiceRecovery call that the MSI always made, and gives the MSI
# path a future option to delegate to PS1 without a second copy of the logic.
# ============================================================================

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
# Logger.psm1 supplies Write-Step / Write-Ok used in this script's file-copy
# + npm-install phase. The SCM-facing steps (appsettings.json + NSSM + sc.exe
# failure) live in Register-ADDashboardAgent.ps1 which has its own inline
# logger so the two scripts are independently self-contained.
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
# Ensure NSSM is available locally (no-op when remote — only used on the orchestrator).
# Common\NSSM.psm1 ships nssm.exe alongside agentInstall/ via build-green-package.ps1.
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# Push LogDir into Logger.psm1's module-scoped $Script:LogDir (Write-Step /
# Write-Ok etc. can't see the caller's variable directly).
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-LogDir $Script:LogDir

if (-not $AgentSrc) { $AgentSrc = Join-Path $projectRoot 'agent' }
if (-not $PsScriptSrc) { $PsScriptSrc = Join-Path $AgentSrc 'scripts\collect-replication.ps1' }
$psScriptDstDir = Join-Path $InstallPath 'scripts'
$node = (Get-Command node.exe -ErrorAction Stop).Source

function Install-LocalAgent {
  Write-Step "installing local agent to $InstallPath (agentType=$AgentType)"
  @($InstallPath, $psScriptDstDir, (Join-Path $InstallPath 'Logs')) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
  }
  Copy-Item -Path (Join-Path $AgentSrc '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
  Copy-Item -Path $PsScriptSrc -Destination $psScriptDstDir -Force

  # Always run `npm install --omit=dev` on the target machine to construct
  # node_modules. The canonical install path is always npm install — it
  # produces a production-only dependency tree regardless of what the source
  # contains. Operators reading the install log should see this step explicitly
  # so they know where the runtime deps come from.
  Push-Location $InstallPath
  try {
    Write-Step "constructing node_modules via npm install --omit=dev"
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }

  # Delegate the SCM-facing steps to Register-ADDashboardAgent.ps1:
  #   - write appsettings.json (URL / token / agentType)
  #   - NSSM install + 12 parameter set
  #   - service recovery (NSSM AppExit + sc.exe failure)
  #   - Start-Service via NSSM-managed SCM
  # This is the same code path the MSI's ConfigureAgentAction calls (via its
  # own CA; the CA file is not refactored to call this PS1 yet — see project
  # backlog). The green package no longer diverges from the MSI on service
  # recovery because both go through the same logic.
  & (Join-Path $PSScriptRoot 'Register-ADDashboardAgent.ps1') `
      -InstallPath $InstallPath `
      -CenterUrl   $CenterUrl `
      -AgentToken  $AgentToken `
      -AgentType   $AgentType `
      -NodePath    $node
  if ($LASTEXITCODE -ne 0) { throw "Register-ADDashboardAgent.ps1 failed: $LASTEXITCODE" }

  Write-Ok "agent installed on $env:COMPUTERNAME"
}

foreach ($cn in $ComputerName) {
  if ($cn -eq $env:COMPUTERNAME -or $cn -eq 'localhost' -or $cn -eq '.') {
    Install-LocalAgent
  } else {
    Write-Step "remote install on $cn"
    $sess = New-PSSession -ComputerName $cn -ErrorAction Stop
    try {
      $block = [scriptblock]::Create((Get-Content -Raw (Join-Path $PSScriptRoot 'install-agent.ps1')))
      # Pass pre-resolved source paths so the remote scriptblock does not depend
      # on its own $PSScriptRoot (which is null inside Invoke-Command -ScriptBlock).
      Invoke-Command -Session $sess -ScriptBlock $block -ArgumentList @(@($cn), $CenterUrl, $AgentToken, $AgentType, $InstallPath, $AgentSrc, $PsScriptSrc) -ErrorAction Stop
    } finally { Remove-PSSession $sess }
  }
}