# SECURITY: this script uses Invoke-Command; -ComputerName values must be trusted and reachable over WinRM.
# AgentToken is sent in cleartext over the WinRM channel — use HTTPS WinRM or pre-shared credentials in production.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string[]]$ComputerName,
  [Parameter(Mandatory)][string]$CenterUrl,
  [Parameter(Mandatory)][string]$AgentToken,
  [string]$InstallPath = 'C:\addashboard\Agent',
  # Internal-use parameters for remote-install forwarding. When the script runs
  # in a remote session, $PSScriptRoot is null; we pre-resolve and pass these
  # explicitly so the scriptblock always knows where to copy from.
  [string]$AgentSrc,
  [string]$PsScriptSrc
)

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# Ensure NSSM is available locally (no-op when remote — only used on the orchestrator)
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

if (-not $AgentSrc) { $AgentSrc = Join-Path $projectRoot 'agent' }
if (-not $PsScriptSrc) { $PsScriptSrc = Join-Path $AgentSrc 'scripts\collect-replication.ps1' }
$psScriptDstDir = Join-Path $InstallPath 'scripts'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$Script:LogDir = 'C:\addashboard\Logs'

function Install-LocalAgent {
  Write-Step "installing local agent to $InstallPath"
  @($InstallPath, $psScriptDstDir, 'C:\addashboard\Logs', 'C:\addashboard\Agent') | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
  }
  Copy-Item -Path (Join-Path $AgentSrc '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
  if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
    Push-Location $InstallPath; try { npm install --omit=dev } finally { Pop-Location }
  }
  Copy-Item -Path $PsScriptSrc -Destination $psScriptDstDir -Force

  $cfg = @{
    centerUrl = $CenterUrl
    agentId = $env:COMPUTERNAME
    agentToken = $AgentToken
    logLevel = 'info'
    pollingIntervalMinutes = 15
    queueDbPath = 'C:\addashboard\Agent\queue.db'
    psScriptPath = "$InstallPath\scripts\collect-replication.ps1"
    healthCheckIntervalMs = 600000
  }
  $cfg | ConvertTo-Json | Set-Content -Path (Join-Path $InstallPath 'appsettings.json') -Encoding UTF8

  Install-NssmService -Name 'ADReplicationAgent' `
    -Application $node `
    -AppDirectory $InstallPath `
    -AppParameters 'agent.js' `
    -DependOnService @('DNS Client','Netlogon') `
    -DisplayName "AD Replication Agent (on $env:COMPUTERNAME)" `
    -Description 'AD Replication collection agent' `
    -Start 2
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
      Invoke-Command -Session $sess -ScriptBlock $block -ArgumentList @(@($cn), $CenterUrl, $AgentToken, $InstallPath, $AgentSrc, $PsScriptSrc) -ErrorAction Stop
    } finally { Remove-PSSession $sess }
  }
}
