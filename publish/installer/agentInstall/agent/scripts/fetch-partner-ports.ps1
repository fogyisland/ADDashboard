[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AgentId
)

# 2026-08-28 round-57 (R57-F): fetch the configured partner-port list from
# the centre's /api/agent/partner-ports endpoint. Returns a hashtable
# @{ ports = @(int[]) } so Get-PartnerPortConfig can consume it directly.
#
# The endpoint mirrors system_ports (the same table the operator edits
# via the admin UI). Without this script, real agents always probe the
# default port set (135, 445, 389, 636, 3268, 88, 50001, 50002, 50003)
# regardless of what the operator configured.
#
# The file-scoped helpers (Resolve-AppsettingsPath, Read-AgentConfig,
# ConvertTo-PartnerPortList, Invoke-PartnerPortsRequest) live in
# fetch-partner-ports-helpers.ps1. Splitting them out lets the Pester
# test suite dot-source the helpers and unit-test the conversion logic
# without spinning up a real HTTP server.
#
# Failure mode (network error, 401, malformed JSON, missing appsettings):
# returns @{ ports = $null } which the caller recognises and falls back
# to the default port set. We never throw out of this script — the
# partner-port probe loop must remain best-effort.

$ErrorActionPreference = 'Stop'

# Dot-source the shared helpers. PSScriptRoot points at agent/scripts/
# in both the production layout and the green-package layout, so a
# relative dot-source resolves correctly.
. "$PSScriptRoot/fetch-partner-ports-helpers.ps1"

$cfgPath = Resolve-AppsettingsPath -ScriptRoot $PSScriptRoot
if ($null -eq $cfgPath) {
  return @{ ports = $null }
}

try {
  $cfg = Read-AgentConfig -Path $cfgPath
} catch {
  Write-Warning "fetch-partner-ports: failed to read appsettings.json at '$cfgPath': $($_.Exception.Message)"
  return @{ ports = $null }
}

$centerUrl = [string]$cfg.centerUrl
$agentToken = [string]$cfg.agentToken
if ([string]::IsNullOrEmpty($centerUrl) -or [string]::IsNullOrEmpty($agentToken)) {
  return @{ ports = $null }
}

$responseBody = $null
try {
  $responseBody = Invoke-PartnerPortsRequest -CenterUrl $centerUrl -AgentToken $agentToken
} catch {
  Write-Warning "fetch-partner-ports: GET $centerUrl/api/agent/partner-ports failed: $($_.Exception.Message)"
  return @{ ports = $null }
}

$ports = ConvertTo-PartnerPortList -ResponseBody $responseBody
if ($ports.Count -eq 0) {
  return @{ ports = $null }
}
return @{ ports = $ports }
