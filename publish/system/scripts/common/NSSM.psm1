# Module-scoped state — function calls DO NOT cross modules to read $Script: in
# the caller's scope, so each module that wants shared state owns its own
# $Script: variable plus an explicit setter. See Set-NssmLogDir / Set-NssmPath.
$Script:NssmPath = $null
# Default LogDir resolves relative to the script's own publish root (parent of
# scripts/common/) — install/update/uninstall callers always override this via
# Set-NssmLogDir, but the fallback matters for any ad-hoc use of the module.
$Script:LogDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Logs'
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
  # Search order — all $PSScriptRoot-relative so the same module resolves
  # nssm correctly regardless of where the script tree lives:
  #   1. <root>/publish/system/nssm/nssm.exe  — dev tree (canonical, post-Ensure-Nssm)
  #   2. <root>/nssm/nssm.exe                 — alt dev tree
  #   3. <root>/scripts/../nssm/nssm.exe      — GREEN PACKAGE (script at
  #      <green>/agentInstall/common/, nssm bundled at <green>/agentInstall/nssm/).
  #      Without this candidate, Ensure-Nssm.ps1 — invoked by install-agent.ps1
  #      before delegating to Register-ADDashboardAgent.ps1 — fails to find
  #      the bundled nssm and falls through to a network download, which is
  #      both wasteful AND breaks air-gapped installs that legitimately bundle
  #      nssm at <green>/nssm/.
  #   4. C:\Tools\nssm\win64\nssm.exe         — operator-installed copy
  #   5. C:\Tools\nssm-2.24\win64\nssm.exe     — operator-installed copy
  #   6. <root>/tools/nssm.exe                — alt
  $candidates = @(
    (Join-Path (Join-Path $PSScriptRoot '..\..\publish\system\nssm') 'nssm.exe'),
    (Join-Path (Join-Path $PSScriptRoot '..\..\nssm') 'nssm.exe'),
    (Join-Path (Join-Path $PSScriptRoot '..\nssm') 'nssm.exe'),
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe',
    (Join-Path $PSScriptRoot '..\..\tools\nssm.exe')
  )
  foreach ($p in $candidates) { if (Test-Path $p) { $Script:NssmPath = $p; return $p } }
  throw "nssm.exe not found. Ensure publish/system/nssm/nssm.exe exists in the repo, or run scripts/common/Ensure-Nssm.ps1 to download it."
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
  $existed = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($existed) {
    # Service already registered — skip `nssm install` (would error "service already
    # exists") but ALWAYS re-apply NSSM parameters. Skipping the parameter pass on
    # re-install is the root cause of multiple real-world NSSM bugs (AppExit
    # sub-parameter, AppDirectory pointing at old code, log path, rotation, etc.):
    # any installer change to those settings never reached the existing service.
    Write-Info "Service $Name already installed; refreshing NSSM parameters"
  } else {
    Invoke-Nssm @('install', $Name, $Application)
  }
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
