# collect.ps1 — ad_os_baseline v1.0.6 (R158.50.7j bump / 2026-10-08)
# R158.50.7j (2026-10-08) — operator  "win_event_filterxml: 
# " .  PS5.1 Get-WinEvent -FilterXml
# -ErrorAction Stop  0  EventLogQueryException zh-CN "
# " → catch → $lastErrorMessage → payload.error
# → runner partial.  ad_lockout_list 1.0.5 (R158.50.7h) / ad_eventlog_collector
# 1.0.6 (R158.50.7i)  pattern.
# fix 1.0.6: line 205 -ErrorAction Stop -> SilentlyContinue + @($rawEvents)
# array , if ($null -eq $rawEvents)  throw  catch  (case 3),
# if ($rawEvents.Count -gt 0) foreach  events , else (case 1 idle)
# stderr **** $lastErrorMessage → status=success .
# catch  case 3 (ProviderMetadata/log /access denied/ throw).
# Wire shape  (events , system/application 5min window).
#
# R158.52 hardening (1.0.5): SilentlyContinue -> Continue + accumulated
# $lastErrorMessage surfaced to centre as payload.error.
#
# Previous: v4 (R158.30) hardware-identity fields.

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
try {
  $diskFree = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop | Select-Object -First 1).FreeSpace
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

$disks = @()
try {
  $physDisks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
  foreach ($d in $physDisks) {
    $busType = if ($d.BusType) { $d.BusType.ToString() } else { 'Unknown' }
    $disks += @{ model = [string]$d.Model; bus_type = $busType }
  }
} catch {}

$memMods = @()
try {
  $mods = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)
  foreach ($m in $mods) {
    $cap = if ($m.Capacity) { [int64]$m.Capacity } else { 0 }
    $memMods += @{ manufacturer = [string]$m.Manufacturer; part_number = [string]$m.PartNumber; speed_mhz = [int]$m.Speed; capacity_bytes = $cap }
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
  #  ad_eventlog_collector 1.0.6 + ad_lockout_list 1.0.5  idiom.
  $rawEvents = @(Get-WinEvent -FilterXml $filterXml -MaxEvents 20 -ErrorAction SilentlyContinue)
  if ($null -eq $rawEvents) {
    throw "Get-WinEvent returned `$null - provider metadata or log unreadable"
  }
  if ($rawEvents.Count -gt 0) {
    foreach ($r in $rawEvents) {
      $events += @{ log = $r.LogName; id = $r.Id; level = $r.LevelDisplayName; msg = (($r.Message -replace "`r`n"," ") -replace '\s+',' ') }
    }
  } else {
    [Console]::Error.WriteLine("[ad_os_baseline 1.0.6] no System/Application warning/error events in 5min window on $env:COMPUTERNAME - normal idle state")
  }
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "win_event_filterxml: $($_.Exception.Message)" }
}

# ---------- Payload ------------------------------------------------------------------
$payload = @{
  metrics = @{
    cpu_pct    = if ($cpuSample -ne $null) { [double]$cpuSample } else { $null }
    memory_pct = if ($memPct -ne $null) { [double]$memPct } else { $null }
    disk_free  = if ($diskFree)  { [string]$diskFree  } else { '{}' }
    bios_info       = if ($bios) { @{ manufacturer = [string]$bios.Manufacturer; serial_number = [string]$bios.SerialNumber } } else { @{} }
    motherboard     = if ($mobo) { @{ manufacturer = [string]$mobo.Manufacturer; product = [string]$mobo.Product } } else { @{} }
    cpu             = if ($cpu)  { @{ name = [string]$cpu.Name; cores = [int]$cpu.NumberOfLogicalProcessors } } else { @{} }
    ips             = @($ips)
    disks           = @($disks)
    memory_modules  = @($memMods)
    services        = $svcMap
    events          = @($events)
  }
}

$payload.error = if ($lastErrorMessage) { $lastErrorMessage } else { $null }

$payload | ConvertTo-Json -Compress -Depth 8
exit 0
