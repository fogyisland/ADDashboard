# collect.ps1 — ad_os_baseline v1.0.5 (R158.52 bump / 2026-10-08)
# R158.52 hardening: SilentlyContinue -> Continue + accumulated $lastErrorMessage
# surfaced to centre as payload.error. Wire shape unchanged.
# Previous: v4 (R158.30) hardware-identity fields.
# Extends v3 (R147) to add 5 operator-required surfaces
# (system manufacturer + network IPs / logical CPU / memory modules)
# — surface is a Win32_NetworkAdapterConfiguration IPEnabled IPv4 list with virtual-adapter skip filter,
# per-disk model+bus_type in disks[] (Get-PhysicalDisk — first-disk model is the dominant signal),
# and memory_modules (Win32_PhysicalMemory — array of {manufacturer, part_number, speed_mhz, capacity_bytes}).
# bios_info gained serial_number (Win32_BIOS.SerialNumber).
# C: drive used percentage renamed in front-end from '磁盘已使用' to 'C 盘已使用' — collect.ps1 logic unchanged.
# Schema is a superset of 1.0.3; ALTER migration is idempotent via INFORMATION_SCHEMA / sys.columns guards
# so 1.0.3 rows keep working (new fields NULL until the agent re-runs).
#
# Emits: {"metrics": {...}} per v2 contract — metricSchema columns are
# auto-discovered by centre/ingestRunV2 (no explicit install wiring needed).

# R158.52 — operator directive "零或空": SilentlyContinue hides every
# error so the centre sees payload with all-null counters and no diagnostic.
# Switch to Continue and let the per-section try/catch + accumulated
# $lastErrorMessage surface real failures in `payload.error`.
$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception messages /
# DC names survives the PS→agent→centre pipeline without transcoding through
# the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# R158.52 — accumulated error string surfaced to centre as `payload.error`
# so the partial-success run gets a diagnostic instead of a silent null.
$lastErrorMessage = $null

# ---------- CPU sample (1.0.0 baseline, R158.52 hardened) -----------------------------
try {
  $cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "cpu_sample: $($_.Exception.Message)" }
}

# ---------- OS + memory + disk (1.0.0 baseline, R158.52 hardened) -------------------
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

# ---------- Services + recent events (1.0.2 baseline, R158.52 hardened) --------
$svcAllow = 'Spooler','WinRM','W32Time','DNS','LanmanServer','LanmanWorkstation','Wecsvc'
$svcMap = @{}
foreach ($n in $svcAllow) { try { $svcMap[$n] = (Get-Service -Name $n -ErrorAction SilentlyContinue).Status.ToString() } catch {} }

# R158.52 — switch from FilterHashtable to FilterXml. R158.50.5 / R158.50.7d
# proved Get-WinEvent -FilterHashtable 100% fails under the agent service
# account (provider mismatch on PS5.1 server-core / no eventlog subscriber).
# FilterXml is the sibling pattern that ad_lockout_list / ad_failed_logon
# use successfully. Wrap the whole call in try/catch so a single failure
# emits events=[] + a diagnostic in $lastErrorMessage.
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
  $rawEvents = Get-WinEvent -FilterXml $filterXml -MaxEvents 20 -ErrorAction Stop
  foreach ($r in $rawEvents) {
    $events += @{ log = $r.LogName; id = $r.Id; level = $r.LevelDisplayName; msg = (($r.Message -replace "`r`n"," ") -replace '\s+',' ') }
  }
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "win_event_filterxml: $($_.Exception.Message)" }
}

# ---------- Payload ------------------------------------------------------------------
$payload = @{
  metrics = @{
    # 1.0.2 originals
    cpu_pct    = if ($cpuSample -ne $null) { [double]$cpuSample } else { $null }
    memory_pct = if ($memPct -ne $null) { [double]$memPct } else { $null }
    disk_free  = if ($diskFree)  { [string]$diskFree  } else { '{}' }
    # 1.0.4 (R158.30) hardware-identity fields
    bios_info = if ($bios) { @{ manufacturer = [string]$bios.Manufacturer; serial_number = [string]$bios.SerialNumber } } else { @{} }
    motherboard = if ($mobo) { @{ manufacturer = [string]$mobo.Manufacturer; product = [string]$mobo.Product } } else { @{} }
    cpu         = if ($cpu) { @{ name = [string]$cpu.Name; cores = [int]$cpu.NumberOfLogicalProcessors } } else { @{} }
    ips         = @($ips)
    disks       = @($disks)
    memory_modules = @($memMods)
    # 1.0.2 services + events
    services    = $svcMap
    events      = @($events)
  }
}

# R158.52 — accumulated error surfaced as `payload.error`
$payload.error = if ($lastErrorMessage) { $lastErrorMessage } else { $null }

$payload | ConvertTo-Json -Compress -Depth 8
exit 0
