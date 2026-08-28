# 2026-08-28 round-57 (R57-F): helpers shared between fetch-partner-ports.ps1
# (production) and the Pester test suite. Splitting into a separate file lets
# tests dot-source the helpers directly and exercise ConvertTo-PartnerPortList
# + Invoke-PartnerPortsRequest without spinning up a real HTTP server.
#
# Loaded via `. "$PSScriptRoot/fetch-partner-ports-helpers.ps1"` from the
# caller. Both files live in agent/scripts/.

$ErrorActionPreference = 'Stop'

function Resolve-AppsettingsPath {
  # 2026-08-28 round-57: try a few candidate locations for appsettings.json.
  # Production layout: scripts/fetch-partner-ports.ps1 → ../appsettings.json
  # Green-package layout: agentInstall/agent/scripts/... → ../../appsettings.json
  # If neither resolves, return $null and let the caller decide.
  param([string]$ScriptRoot)
  $candidates = @(
    (Join-Path -Path $ScriptRoot -ChildPath '..\appsettings.json'),
    (Join-Path -Path $ScriptRoot -ChildPath '..\..\appsettings.json')
  )
  foreach ($c in $candidates) {
    $resolved = [System.IO.Path]::GetFullPath($c)
    if (Test-Path -LiteralPath $resolved) { return $resolved }
  }
  return $null
}

function Read-AgentConfig {
  param([string]$Path)
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  # 2026-08-24 round-8: PowerShell 5.1 Set-Content writes a UTF-8 BOM
  # (EF BB BF) when appsettings.json was last written by Node — strip it
  # defensively so ConvertFrom-Json doesn't reject the leading bytes.
  if ($raw.Length -ge 3 -and $raw[0] -eq [char]0xEF -and $raw[1] -eq [char]0xBB -and $raw[2] -eq [char]0xBF) {
    $raw = $raw.Substring(3)
  }
  return ($raw | ConvertFrom-Json)
}

function ConvertTo-PartnerPortList {
  # 2026-08-28 round-57 (R57-F): filter + coerce the centre's port
  # envelope into a clean int[]. Exported (file-scoped) for unit tests;
  # production callers get the same coercion via the script's main path.
  # Drop anything that isn't a valid TCP port so the probe loop never
  # receives a malformed value. Returns @() (empty array) when no valid
  # ports are found — the caller distinguishes "no ports" from "no
  # response" by checking length.
  param(
    [Parameter()]
    [AllowNull()]
    $ResponseBody
  )
  if ($null -eq $ResponseBody) { return ,@() }
  $raw = $ResponseBody.ports
  if ($null -eq $raw) { return ,@() }
  $ports = @()
  foreach ($entry in @($raw)) {
    $portNum = $null
    try { $portNum = [int]$entry.port } catch {}
    if ($portNum -and $portNum -ge 1 -and $portNum -le 65535) {
      $ports += $portNum
    }
  }
  return ,$ports
}

function Invoke-PartnerPortsRequest {
  # 2026-08-28 round-57 (R57-F): HTTP wrapper around the centre endpoint.
  # Pulled out so unit tests can override the function in script scope to
  # short-circuit the network round-trip (Pester's dynamic scoping doesn't
  # always let a test-scope `function Invoke-RestMethod` override win
  # against the cmdlet at script invocation time).
  param(
    [Parameter(Mandatory = $true)]
    [string]$CenterUrl,
    [Parameter(Mandatory = $true)]
    [string]$AgentToken
  )
  $baseUrl = $CenterUrl.TrimEnd('/')
  $url = "$baseUrl/api/agent/partner-ports"
  # PS 5.1 + PS 7+ both ship Invoke-RestMethod; 5s timeout matches
  # center/src/port-config-fetcher.js fetchPortList.
  return Invoke-RestMethod -Uri $url -Method Get -Headers @{ 'X-Agent-Token' = $AgentToken } -TimeoutSec 5 -ErrorAction Stop
}