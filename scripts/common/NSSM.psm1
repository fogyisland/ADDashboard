# Requires Logger.psm1 to be imported first (uses Write-Warn2).
$Script:NssmPath = $null

function Set-NssmPath {
  param([string]$Path)
  $Script:NssmPath = $Path
}

function Get-NssmPath {
  if ($Script:NssmPath -and (Test-Path $Script:NssmPath)) { return $Script:NssmPath }
  $candidates = @(
    (Join-Path (Join-Path $PSScriptRoot '..\..\nssm') 'nssm.exe'),
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe',
    (Join-Path $PSScriptRoot '..\..\tools\nssm.exe')
  )
  foreach ($p in $candidates) { if (Test-Path $p) { $Script:NssmPath = $p; return $p } }
  throw "nssm.exe not found. Run scripts/common/Ensure-Nssm.ps1 first, or place in C:\Tools\nssm\win64\nssm.exe"
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
    [int]$Start = 2
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
    [int]$Start = 2
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
