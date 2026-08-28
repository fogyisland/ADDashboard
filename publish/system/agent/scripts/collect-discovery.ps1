[CmdletBinding()]
param(
  [switch]$ForTesting
)

# 2026-08-24 round-9: PS 5.1 [Console]::OutputEncoding defaults to the
# system OEM codepage (CN = GBK/936). [Console]::Out/Error.WriteLine
# serializes non-ASCII (e.g., Chinese AD error text) using that encoding,
# producing GBK bytes on stdout. The agent child reads stdout as UTF-8
# by default, so Chinese characters become U+FFFD + isolated surrogate
# pairs (the mojibake pattern KDLWXOFADSRV1 was emitting). Set UTF-8
# explicitly so [Console]::Out/Error write UTF-8 bytes that Node decodes
# correctly. $OutputEncoding covers pipeline redirection for defense in
# depth. Same trap fires in collect-replication.ps1 — fixed there too.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding           = [System.Text.UTF8Encoding]::new($false)

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
