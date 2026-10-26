# common/Version.psm1 - INI parser + version.inf reader
#
# 2026-10-02 - Single source of truth for version. version.inf is at the
# project root; all scripts (start.ps1, install-agent.ps1, agent.js,
# dashboard/server.js) read from here. Earlier versions (pre-0.1.1) read
# from package.json; schema migration in start.ps1:Apply-AppsettingsSchemaMigration.
#
# Usage:
#   Import-Module common/Version.psm1 -Force
#   Get-ComponentVersion -Component 'version'      # -> '0.1.1'
#   Get-ComponentVersion -Component 'agent'        # -> '0.1.1'
#   Get-ComponentVersion -Component 'dashboard'    # -> '0.1.1'
#   Get-ReleaseMeta -Key 'updated'                 # -> '2026-10-02'
#   $info = Get-ReleaseInfo                        # hashtable
#
# INI format:
#   [meta]
#   updated = 2026-10-02
#   [components]
#   version = 0.1.1
#   agent   = 0.1.1
#
# Rules:
#   - Lines starting with ';' or '#' are comments
#   - '[section]' switches current section
#   - 'key = value' / 'key=value' / 'key =value' all accepted, whitespace trimmed
#   - Missing file/section/key returns $null (caller decides whether to error)

function Get-VersionInfPath {
  # version.inf lives at project root (sibling of start.ps1).
  # Prefer $PSScriptRoot (module dir -> ../), fallback to env var.
  if ($PSScriptRoot) {
    return (Join-Path $PSScriptRoot '..\version.inf')
  }
  if ($env:AGENT_INSTALL_ROOT) {
    return (Join-Path $env:AGENT_INSTALL_ROOT 'version.inf')
  }
  return $null
}

function Read-VersionInf {
  $path = Get-VersionInfPath
  if (-not $path -or -not (Test-Path -LiteralPath $path)) {
    return $null
  }
  $result = @{}
  $current = $null
  foreach ($line in (Get-Content -LiteralPath $path)) {
    $trimmed = $line.Trim()
    if ([string]::IsNullOrEmpty($trimmed)) { continue }
    if ($trimmed.StartsWith(';') -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed.StartsWith('[') -and $trimmed.EndsWith(']')) {
      $sectionName = $trimmed.Substring(1, $trimmed.Length - 2).Trim().ToLower()
      if (-not $result.ContainsKey($sectionName)) {
        $result[$sectionName] = @{}
      }
      $current = $result[$sectionName]
      continue
    }
    if ($null -eq $current) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $trimmed.Substring(0, $eq).Trim().ToLower()
    $val = $trimmed.Substring($eq + 1).Trim()
    $current[$key] = $val
  }
  return $result
}

function Get-ComponentVersion {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Component)
  $v = Read-VersionInf
  if ($null -eq $v) { return $null }
  if (-not $v.ContainsKey('components')) { return $null }
  $key = $Component.ToLower()
  if (-not $v.components.ContainsKey($key)) { return $null }
  return $v.components[$key]
}

function Get-ReleaseMeta {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Key)
  $v = Read-VersionInf
  if ($null -eq $v) { return $null }
  if (-not $v.ContainsKey('meta')) { return $null }
  $key = $Key.ToLower()
  if (-not $v.meta.ContainsKey($key)) { return $null }
  return $v.meta[$key]
}

function Get-ReleaseInfo {
  $v = Read-VersionInf
  if ($null -eq $v) { return $null }
  $info = @{
    version       = $v.components['version']
    agent         = $v.components['agent']
    dashboard     = $v.components['dashboard']
    updated       = if ($v.ContainsKey('meta')) { $v.meta['updated'] }       else { $null }
    releaseNotes  = if ($v.ContainsKey('meta')) { $v.meta['release-notes'] } else { $null }
    schemaVersion = if ($v.ContainsKey('meta')) { $v.meta['schema-version'] } else { $null }
  }
  return $info
}

Export-ModuleMember -Function Get-VersionInfPath, Read-VersionInf, Get-ComponentVersion, Get-ReleaseMeta, Get-ReleaseInfo
