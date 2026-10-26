# collect.ps1 - ad_dc_overview v1 (R110.A) + R158.44.7.8 computers/servers
#
# Reports users / computers / servers / groups / gpos counters for this DC.
# Output is one JSON object with shape:
#   { metrics: { agent_id, dc_name, site_id, users_count, computers_count,
#                servers_count, groups_count, gpos_count, partner_port_status,
#                collected_at } }
#
# Cadence: every 15 minutes (manifest.agent.intervalSec = 900). Independent
# of replication cycle so overview stays fresh on broken-replication DCs.
#
# site_id resolution happens at the centre side from agent_id via the
# existing ad_dcs table — agent does not carry site_id mapping. Set null here.
#
# Real-agent swap (operator directive: "代码一定要紧贴实际的agent"):
# the ActiveDirectory RSAT path below is the production wire shape; mock
# (centre/mock-snapshot.mjs) emits deterministic SHA-based counter values.
#
# R158.44.7.8 (2026-10-05) — operator directive "DC overview 显示用户、
# 电脑、服务器数量" (separator counters, 最终呈现 3 个独立 tile).
# computers_count = Get-ADComputer -Filter * (all computer accounts)
# servers_count   = Get-ADComputer -LDAPFilter '(operatingSystem=*Server*)'
# (servers 是 computers 子集, OperatingSystem 字段含 'Server' 关键字的
# member server; DC 自身也是 server 但 default 都在这台 DC 的默认 Computers
# container, 仍计入. PS -Filter 不能 wildcard on OperatingSystem, 必用
# -LDAPFilter 直接传原始 LDAP filter 字符串).

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception
# messages / DC names survives the PS→agent→centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

$usersCount     = $null
$computersCount = $null
$serversCount   = $null
$groupsCount    = $null
$gposCount      = $null
# R158.50.6 (2026-10-07) — 把 try/catch 异常 message 写到 stdout `error` 字段
$lastErrorMessage = $null

try {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw 'ActiveDirectory RSAT module not available'
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
  $usersCount     = (Get-ADUser     -Filter * -Server $server | Measure-Object).Count
  $computersCount = (Get-ADComputer -Filter * -Server $server | Measure-Object).Count
  $serversCount   = (Get-ADComputer -LDAPFilter '(operatingSystem=*Server*)' -Server $server | Measure-Object).Count
  $groupsCount    = (Get-ADGroup    -Filter * -Server $server | Measure-Object).Count
  $gposCount      = (Get-GPO        -All        -Server $server | Measure-Object).Count
} catch {
  [Console]::Error.WriteLine("ad_dc_overview counters failed: $($_.Exception.Message)")
  # R158.50.6 — 异常 message 写入 payload.error
  $lastErrorMessage = "ad_dc_overview counters failed: $($_.Exception.Message)"
}

$metrics = @{
  agent_id            = $server
  dc_name             = $server
  site_id             = $null
  users_count         = if ($null -ne $usersCount)     { [int]$usersCount }     else { $null }
  computers_count     = if ($null -ne $computersCount) { [int]$computersCount } else { $null }
  servers_count       = if ($null -ne $serversCount)   { [int]$serversCount }   else { $null }
  groups_count        = if ($null -ne $groupsCount)    { [int]$groupsCount }    else { $null }
  gpos_count          = if ($null -ne $gposCount)      { [int]$gposCount }      else { $null }
  partner_port_status = $null
  collected_at        = $collectedAt
}

# R158.50.6 — 把异常 message 写到 stdout `error` 字段, agent reporter 转 r.error
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 4
exit 0