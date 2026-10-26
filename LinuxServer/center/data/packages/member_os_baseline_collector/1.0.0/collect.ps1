# collect.ps1 - member_os_baseline_collector v1.0.0 (R158.86, 2026-10-12)
#
# v1.0.0 (R158.86, 2026-10-12) — Member Server OS baseline (5 metrics subset).
#   · Parallel to ad_os_baseline 1.0.7 but with member-only scope: 5 fields
#     (cpu_pct / memory_pct / c_used_pct / disk_free_bytes / services_count).
#     ad_os_baseline carries 19 fields (incl AD replication + hardware identity)
#     which member-server fleet never reports.  R158.86 简化到 5 metric 跟
#     member-server 实际监控需求对齐.
#   · agent.type='non-ad', intervalSec=60 (1min cadence, 跟 ad_os_baseline 1.0.7 同)
#   · 公共表 mode (R158.78 precedent): manifest omits `database` block →
#     runner.js post-hook 直接 UPSERT 到 ad_member_os_baseline + ..._latest.
#   · 错误隔离: 每个 try/catch block 写 $lastErrorMessage, 最后 payload.error
#     字段报出来. 跟 R158.50.7j 1.0.6 3 case 模式同 precedent.
#
# Output wire shape:
#   { metrics: { agent_id, hostname, collected_at,
#                cpu_pct, memory_pct, c_used_pct, disk_free_bytes,
#                services_count },
#     error:   null | "<msg>" }

$ErrorActionPreference = 'Continue'

# R136 encoding fix
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime()
$lastErrorMessage = $null

# ---------- CPU sample ---------------------------------------------------------------
try {
  $cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue
  $cpuPct = [math]::Round([double]$cpuSample, 1)
} catch {
  $cpuPct = $null
  if (-not $lastErrorMessage) { $lastErrorMessage = "cpu_sample: $($_.Exception.Message)" }
}

# ---------- OS + memory -------------------------------------------------------------
$os = $null
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "os_query: $($_.Exception.Message)" }
}

$memPct = $null
if ($os) {
  try {
    $memPct = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1)
  } catch {
    if (-not $lastErrorMessage) { $lastErrorMessage = "mem_pct_calc: $($_.Exception.Message)" }
  }
}

# ---------- C: disk ----------------------------------------------------------------
$cUsedPct = $null
$diskFreeBytes = $null
try {
  $cDisk = @(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop)
  if ($cDisk.Count -gt 0 -and $cDisk[0].Size -gt 0) {
    $diskFreeBytes = [int64]$cDisk[0].FreeSpace
    $cUsedPct = [math]::Round((1 - ([double]$cDisk[0].FreeSpace / [double]$cDisk[0].Size)) * 100, 2)
  }
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "disk_query: $($_.Exception.Message)" }
}

# ---------- Services count (subset of ad_os_baseline svcAllow) ---------------------
$svcAllow = 'Spooler','WinRM','W32Time','DNS','LanmanServer','LanmanWorkstation','Wecsvc'
$servicesCount = 0
foreach ($n in $svcAllow) {
  try {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($s -and $s.Status) { $servicesCount++ }
  } catch {}
}

# ---------- Payload ------------------------------------------------------------------
$payload = @{
  metrics = @{
    agent_id        = $server
    hostname        = $server
    collected_at    = $collectedAt.ToString('o')
    cpu_pct         = $cpuPct
    memory_pct      = $memPct
    c_used_pct      = $cUsedPct
    disk_free_bytes = $diskFreeBytes
    services_count  = [int]$servicesCount
  }
}
$payload.error = if ($lastErrorMessage) { $lastErrorMessage } else { $null }

$payload | ConvertTo-Json -Compress -Depth 5
exit 0
