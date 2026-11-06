# collect.ps1 — ad_os_baseline v1.0.7 (R158.56c / 2026-10-08)
# R158.56c (2026-10-08) — wire field rename 1.0.6 (no manifest bump).
# R158.50.7j ship 把 R158.30 时代的 `cpu_brand` / `network_info` 改名为
# `cpu` / `ips` 并加 `motherboard`, 但 centre 端 1.0.6 manifest 没跟 → 5h+
# 全 fleet metricstore.ingest.failed "unknown keys: motherboard,ips,cpu".
# 1.0.7 = 同 1.0.6 PS1 + centre 1.0.7 manifest 把 3 个 key 加到 metricSchema
# + 1.0.7 migration 加 3 个 JSON 列. R157.4 seeder 自动检测 version mismatch
# 触发 upsert, 不需要手动运维.
#
# 继承:
#   1.0.6 (R158.50.7j) — Get-WinEvent -FilterXml -ErrorAction SilentlyContinue
#                         + 3 case 分支 (idle / null / catch)
#   1.0.5 (R158.52)    — $ErrorActionPreference=Continue + $lastErrorMessage
#   1.0.4 (R158.30)    — Win32_BaseBoard / Win32_Processor / Win32_NetworkAdapter
#                         重构 wire 字段命名
#   1.0.3 (R147)       — hardware-identity (bios / cpu_brand / disks)

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception messages /
# DC names survives the PS→agent→centre pipeline without transcoding through
# the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# R158.52 — accumulated error string surfaced to centre as `payload.error`
$lastErrorMessage = $null

# ---------- CPU sample ---------------------------------------------------------------
try {
  $cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "cpu_sample: $($_.Exception.Message)" }
}

# ---------- OS + memory + disk ------------------------------------------------------
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

$diskFree = $null
$diskTotal = $null
$cUsedPct  = $null
$disks = @()
try {
  # R158.56c (2026-10-08) — restore per-drive disks[] 数组 (R158.30 时代
  # 格式: {letter, free_bytes, total_bytes, model, bus_type}). 1.0.5 精简
  # 误只输出 model+bus_type, 前端 DcCard 分区列表空了.
  $logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop)
  $physDisks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
  $firstDiskModel = if ($physDisks.Count -gt 0) { [string]($physDisks[0].FriendlyName) } else { $null }
  $firstDiskBus   = if ($physDisks.Count -gt 0) { [string]($physDisks[0].BusType) }       else { $null }
  foreach ($d in $logicalDisks) {
    $isC = $d.DeviceID -eq 'C:'
    $m = if ($isC) { $firstDiskModel } else { $null }
    $b = if ($isC) { $firstDiskBus }   else { $null }
    $disks += @{
      letter      = [string]$d.DeviceID
      free_bytes  = [int64]$d.FreeSpace
      total_bytes = [int64]$d.Size
      model       = $m
      bus_type    = $b
    }
    if ($isC) {
      $diskFree  = [int64]$d.FreeSpace
      $diskTotal = [int64]$d.Size
      if ($diskTotal -gt 0) {
        $cUsedPct = [math]::Round((1 - ([double]$diskFree / [double]$diskTotal)) * 100, 2)
      }
    }
  }
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "disk_query: $($_.Exception.Message)" }
}

# ---------- v4 (R158.30) hardware-identity fields ------------------------------------
$bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
$mobo = Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue
$cpu  = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$sys  = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$mem  = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue

$netCfg = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction SilentlyContinue)
$ips = @()
foreach ($n in $netCfg) {
  if ($n.IPAddress) {
    foreach ($ip in $n.IPAddress) {
      if ($ip -match '^\d+\.\d+\.\d+\.\d+$') { $ips += [string]$ip }
    }
  }
}

$memMods = @()
try {
  $mods = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)
  foreach ($m in $mods) {
    $cap = if ($m.Capacity) { [int64]$m.Capacity } else { 0 }
    # R158.56c (2026-10-08) — nullify empty strings. PS5.1 Win32_PhysicalMemory
    # 在某些 VM (440BX 参考板) 上 Manufacturer/PartNumber/Speed 返 $null,
    # 1.0.7 之前的 [string]$null = "" 写进 JSON 是空串, 前端显示 "blank".
    # 改用 explicit null 替换, 区分 "字段没值" vs "字段真为空字符串".
    $manu  = if ($m.Manufacturer) { [string]$m.Manufacturer } else { $null }
    $partN = if ($m.PartNumber)    { [string]$m.PartNumber    } else { $null }
    $spd   = if ($m.Speed)         { [int]$m.Speed            } else { $null }
    $memMods += @{ manufacturer = $manu; part_number = $partN; speed_mhz = $spd; capacity_bytes = $cap }
  }
} catch {}

# ---------- Services -----------------------------------------------------------------
$svcAllow = 'Spooler','WinRM','W32Time','DNS','LanmanServer','LanmanWorkstation','Wecsvc'
$svcMap = @{}
foreach ($n in $svcAllow) { try { $svcMap[$n] = (Get-Service -Name $n -ErrorAction SilentlyContinue).Status.ToString() } catch {} }

# ---------- Recent events (1.0.2 baseline, R158.52 hardened, R158.50.7j 3-case branch) -----
$events = @()
try {
  $startTime = (Get-Date).AddMinutes(-5).ToUniversalTime().ToString('o')
  $filterXml = @"
<QueryList>
  <Query Id="0" Path="System">
    <Select Path="System">*[System[(Level=2 or Level=3) and TimeCreated[@SystemTime&gt;='$startTime']]]</Select>
  </Query>
  <Query Id="1" Path="Application">
    <Select Path="Application">*[System[(Level=2 or Level=3) and TimeCreated[@SystemTime&gt;='$startTime']]]</Select>
  </Query>
</QueryList>
"@
  # R158.50.7j — Get-WinEvent -ErrorAction Stop -> SilentlyContinue + 3 case .
  # case 1 (0  idle): @($raw).Count -eq 0 ->  $lastErrorMessage.
  # case 3 (real fault): $null -eq $raw -> throw  catch  ->  $lastErrorMessage.
  $rawEvents = @(Get-WinEvent -FilterXml $filterXml -MaxEvents 20 -ErrorAction SilentlyContinue)
  if ($null -eq $rawEvents) {
    throw "Get-WinEvent returned `$null - provider metadata or log unreadable"
  }
  if ($rawEvents.Count -gt 0) {
    foreach ($r in $rawEvents) {
      $events += @{ log = $r.LogName; id = $r.Id; level = $r.LevelDisplayName; msg = (($r.Message -replace "`r`n"," ") -replace '\s+',' ') }
    }
  } else {
    [Console]::Error.WriteLine("[ad_os_baseline 1.0.7] no System/Application warning/error events in 5min window on $env:COMPUTERNAME - normal idle state")
  }
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "win_event_filterxml: $($_.Exception.Message)" }
}

# ---------- Payload ------------------------------------------------------------------
# R158.56c (2026-10-08) — disk_free/disk_total wire shape fix. R158.50.7j 1.0.6
# 误改成 `if ($diskFree) { [string]$diskFree } else { '{}' }` — 但 $diskFree
# 是 Win32_LogicalDisk C: 的 FreeSpace (一个 int64) → [string] 出来是 plain
# 数字 "100000000000", 不是合法 JSON → 1.0.7 metricstore ingest 撞
# ck_pkg_os_baseline_metrics_disk_free_json ISJSON CHECK constraint.
# R158.30 时代是 hashtable {"C:":..., "D:":...} ConvertTo-Json, front-end
# parseDiskPair 期待这种 shape. 改回 hashtable 形式 (单盘也保持 {"C:":...}).
# R158.56c (2026-10-08) — disk_total 同样从 $diskTotal (Win32_LogicalDisk C:.Size) 算.
$diskFreeMap  = @{}
$diskTotalMap = @{}
if ($diskFree -ne $null)  { $diskFreeMap['C:']  = [int64]$diskFree  }
if ($diskTotal -ne $null) { $diskTotalMap['C:'] = [int64]$diskTotal }
$diskFreeJson  = if ($diskFreeMap.Count  -gt 0) { ($diskFreeMap  | ConvertTo-Json -Compress) } else { '{}' }
$diskTotalJson = if ($diskTotalMap.Count -gt 0) { ($diskTotalMap | ConvertTo-Json -Compress) } else { '{}' }

$payload = @{
  metrics = @{
    # ── 1.0.0 baseline ──
    cpu_pct    = if ($cpuSample -ne $null) { [double]$cpuSample } else { $null }
    memory_pct = if ($memPct -ne $null) { [double]$memPct } else { $null }
    disk_free  = $diskFreeJson
    disk_total = $diskTotalJson
    services   = $svcMap
    events     = @($events)
    # ── 1.0.3 R147 hardware-identity ──
    bios_info       = if ($bios) { @{ manufacturer = [string]$bios.Manufacturer; serial_number = [string]$bios.SerialNumber } } else { @{} }
    # R158.56c (2026-10-08) — restore cpu_brand + mem_total_bytes. R158.50 1.0.5
    # 精简 PS1 误删了这两个, manifest 19 keys 一直保留, DB 列一直 NULL,
    # 前端 "CPU 品牌" / "内存大小" 显示 "—". 1.0.7 补回.
    cpu_brand       = if ($cpu) { [string]$cpu.Name } else { $null }
    mem_total_bytes = if ($mem -and $mem.TotalPhysicalMemory) { [int64]$mem.TotalPhysicalMemory } else { $null }
    disks           = @($disks)
    c_used_pct      = $cUsedPct
    # ── 1.0.4 R158.30 system + network ──
    # R158.56c (2026-10-08) — restore system_info + network_info. 1.0.5
    # 精简掉, manifest 19 keys 一直保留, DB 列一直 NULL.
    system_info     = if ($sys) { @{ manufacturer = [string]$sys.Manufacturer; model = [string]$sys.Model } } else { @{} }
    network_info    = @{ ipv4 = @($ips) }
    memory_modules  = @($memMods)
    # ── 1.0.7 R158.56c motherboard/cpu/ips (wire 字段名跟 1.0.5 统一) ──
    motherboard     = if ($mobo) { @{ manufacturer = [string]$mobo.Manufacturer; product = [string]$mobo.Product } } else { @{} }
    cpu             = if ($cpu)  { @{ name = [string]$cpu.Name; cores = [int]$cpu.NumberOfLogicalProcessors } } else { @{} }
    ips             = @($ips)
  }
}

$payload.error = if ($lastErrorMessage) { $lastErrorMessage } else { $null }

$payload | ConvertTo-Json -Compress -Depth 8
exit 0
