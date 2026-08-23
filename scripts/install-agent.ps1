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
  # Agent (Member)" and persists agentType to agent-config.json so the
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
# ============================================================================

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# Ensure NSSM is available locally (no-op when remote — only used on the orchestrator)
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# Set log directory inside the NSSM/Logger modules' own $Script: scope — module
# functions can't see the caller's $Script:LogDir, so we have to push the
# value across explicitly via the modules' setters. Co-located under the
# install dir so uninstall/upgrade scripts find it without an extra path arg.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-NssmLogDir $Script:LogDir
Set-LogDir $Script:LogDir

if (-not $AgentSrc) { $AgentSrc = Join-Path $projectRoot 'agent' }
if (-not $PsScriptSrc) { $PsScriptSrc = Join-Path $AgentSrc 'scripts\collect-replication.ps1' }
$psScriptDstDir = Join-Path $InstallPath 'scripts'
$node = (Get-Command node.exe -ErrorAction Stop).Source

function Install-LocalAgent {
  Write-Step "installing local agent to $InstallPath (agentType=$AgentType)"
  @($InstallPath, $psScriptDstDir, $Script:LogDir) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
  }
  Copy-Item -Path (Join-Path $AgentSrc '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
  Copy-Item -Path $PsScriptSrc -Destination $psScriptDstDir -Force

  # Always run `npm install --omit=dev` on the target machine to construct
  # node_modules. The green package ships node_modules as a baseline (for
  # air-gapped targets where the install might be inspected before npm runs),
  # but the canonical install path is always npm install — it produces a
  # production-only dependency tree regardless of what the source contains.
  # Operators reading the install log should see this step explicitly so they
  # know where the runtime deps come from.
  Push-Location $InstallPath
  try {
    Write-Step "constructing node_modules via npm install --omit=dev"
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }

  $cfg = @{
    centerUrl = $CenterUrl
    agentId = $env:COMPUTERNAME
    agentToken = $AgentToken
    logLevel = 'info'
    pollingIntervalMinutes = 15
    queueDbPath = (Join-Path $InstallPath 'queue.db')
    psScriptPath = "$InstallPath\scripts\collect-replication.ps1"
    healthCheckIntervalMs = 600000
    # T16: persist agentType so the running process picks it up on next
    # start. The agent's loadConfig defaults to 'ad', so omitting the
    # field in an old config keeps the legacy flow.
    agentType = $AgentType
  }
  $cfg | ConvertTo-Json | Set-Content -Path (Join-Path $InstallPath 'appsettings.json') -Encoding UTF8

  # T16: DisplayName differs by agent type. 'ad' keeps the legacy string
  # (operators may have alerts / dashboards keyed off it); 'non-ad' gets
  # the new "Member" label so the distinction is visible in services.msc.
  if ($AgentType -eq 'non-ad') { $displayName = 'AD Dashboard Agent (Member)' }
  else { $displayName = "AD Replication Agent (on $env:COMPUTERNAME)" }

  # T16: Description differs by agent type. AD agents collect replication
  # status for DCs; non-AD agents are member-server monitors that fetch
  # per-host packages and heartbeat to the member-servers.touchLastSeen path.
  if ($AgentType -eq 'non-ad') {
    $description = 'AD Dashboard member-server monitor (self-register + heartbeat + package fetch)'
  }
  else {
    $description = 'AD Replication collection agent'
  }

  Install-NssmService -Name 'ADReplicationAgent' `
    -Application $node `
    -AppDirectory $InstallPath `
    -AppParameters 'agent.js' `
    -DependOnService @('DNS Client','Netlogon') `
    -DisplayName $displayName `
    -Description $description `
    -Start SERVICE_AUTO_START
  if (Start-ServiceSafe -Name 'ADReplicationAgent' -WaitSeconds 20) { Write-Ok "agent started on $env:COMPUTERNAME" }
  else { Write-Err2 "agent failed to start on $env:COMPUTERNAME" }
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
