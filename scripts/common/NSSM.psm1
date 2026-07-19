# Module-scoped state — function calls DO NOT cross modules to read $Script: in
# the caller's scope, so each module that wants shared state owns its own
# $Script: variable plus an explicit setter. See Set-NssmLogDir / Set-NssmPath.
$Script:NssmPath = $null
$Script:LogDir = 'C:\addashboard\Logs'
if (-not (Test-Path $Script:LogDir)) {
  New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
}

function Set-NssmPath {
  param([string]$Path)
  $Script:NssmPath = $Path
}

function Set-NssmLogDir {
  param([string]$Path)
  if ($Path) {
    $Script:LogDir = $Path
    if (-not (Test-Path $Script:LogDir)) {
      New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
    }
  }
}

function Get-NssmPath {
  if ($Script:NssmPath -and (Test-Path $Script:NssmPath)) { return $Script:NssmPath }
  $candidates = @(
    (Join-Path (Join-Path $PSScriptRoot '..\..\publish\nssm') 'nssm.exe'),
    (Join-Path (Join-Path $PSScriptRoot '..\..\nssm') 'nssm.exe'),
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe',
    (Join-Path $PSScriptRoot '..\..\tools\nssm.exe')
  )
  foreach ($p in $candidates) { if (Test-Path $p) { $Script:NssmPath = $p; return $p } }
  throw "nssm.exe not found. Ensure publish/nssm/nssm.exe exists in the repo, or run scripts/common/Ensure-Nssm.ps1 to download it."
}

function Invoke-Nssm {
  param([string[]]$Arguments)
  $nssm = Get-NssmPath
  & $nssm @Arguments
  if ($LASTEXITCODE -ne 0) { throw "nssm $($Arguments -join ' ') failed: $LASTEXITCODE" }
}

function Install-NssmService {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][string]$AppParameters,
    [string[]]$DependOnService = @(),
    [string]$DisplayName = $Name,
    [string]$Description = '',
    [ValidateSet('SERVICE_AUTO_START','SERVICE_DELAYED_AUTO_START','SERVICE_DEMAND_START','SERVICE_DISABLED')]
    [string]$Start = 'SERVICE_AUTO_START'
  )
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    Write-Warn2 "Service $Name already installed; skipping install"
    return
  }
  Invoke-Nssm @('install', $Name, $Application)
  Set-NssmParameters -Name $Name -AppDirectory $AppDirectory -AppParameters $AppParameters `
    -DependOnService $DependOnService -DisplayName $DisplayName -Description $Description -Start $Start
}

function Set-NssmParameters {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][string]$AppParameters,
    [string[]]$DependOnService = @(),
    [string]$DisplayName = $Name,
    [string]$Description = '',
    [ValidateSet('SERVICE_AUTO_START','SERVICE_DELAYED_AUTO_START','SERVICE_DEMAND_START','SERVICE_DISABLED')]
    [string]$Start = 'SERVICE_AUTO_START'
  )
  Invoke-Nssm @('set', $Name, 'AppDirectory', $AppDirectory)
  Invoke-Nssm @('set', $Name, 'AppParameters', $AppParameters)
  Invoke-Nssm @('set', $Name, 'DisplayName', $DisplayName)
  if ($Description) { Invoke-Nssm @('set', $Name, 'Description', $Description) }
  Invoke-Nssm @('set', $Name, 'Start', $Start)
  Invoke-Nssm @('set', $Name, 'AppStdout', (Join-Path $Script:LogDir "$Name-stdout.log"))
  Invoke-Nssm @('set', $Name, 'AppStderr', (Join-Path $Script:LogDir "$Name-stderr.log"))
  Invoke-Nssm @('set', $Name, 'AppRotateFiles', '1')
  Invoke-Nssm @('set', $Name, 'AppRotateOnline', '1')
  Invoke-Nssm @('set', $Name, 'AppRotateBytes', '10485760')
  if ($DependOnService.Count -gt 0) {
    Invoke-Nssm @('set', $Name, 'DependOnService', ($DependOnService -join ','))
  }
  Invoke-Nssm @('set', $Name, 'AppEnvironmentExtra', 'NODE_ENV=production')
}
