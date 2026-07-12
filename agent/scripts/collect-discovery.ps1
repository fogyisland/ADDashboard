[CmdletBinding()]
param(
  [switch]$ForTesting
)

$ErrorActionPreference = 'Stop'

function Get-LocalDcSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw "ActiveDirectory module not available"
  }
  Import-Module ActiveDirectory -ErrorAction Stop

  $dc = Get-ADDomainController -Identity $ComputerName -ErrorAction Stop
  if (-not $dc) { throw "DC not found: $ComputerName" }

  $whenCreatedIso = $null
  if ($dc.whenCreated) {
    try {
      $whenCreatedIso = ([DateTime]$dc.whenCreated).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    } catch {
      $whenCreatedIso = $null
    }
  }

  return [PSCustomObject]@{
    Name                   = [string]$dc.Name
    SiteHint               = [string]$dc.Site
    OsVersion              = [string]$dc.OperatingSystem
    WhenCreated            = $whenCreatedIso
    IsPdc                  = [bool]$dc.IsPDC
    IsGc                   = [bool]$dc.IsGlobalCatalog
    IsRidMaster            = [bool]$dc.RIDMasterRole
    IsSchemaMaster         = [bool]$dc.SchemaMasterRole
    IsDomainNamingMaster   = [bool]$dc.DomainNamingMasterRole
    IsInfrastructureMaster = [bool]$dc.InfrastructureRole
  }
}

if (-not $ForTesting) {
  try {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
  }
}
