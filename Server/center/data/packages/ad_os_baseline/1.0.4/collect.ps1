# collect.ps1 — ad_os_baseline v4 (R158.30)
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

# ---------- CPU sample + memory percentage (1.0.2 baseline, R158.52 hardened) ----
# R158.52 — operator directive "零或空": if the counter outage, emit
# cpu_pct=$null (not 0) so the dashboard tile shows "—" instead of a
# false-zero. NaN guard also added for $null $os path.
$cpuSample = $null
try {
  $cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue
} catch {
  $lastErrorMessage = "cpu_sample: $($_.Exception.Message)"
}
$os = $null
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
} catch {
  if (-not $lastErrorMessage) { $lastErrorMessage = "win32_os: $($_.Exception.Message)" }
}
$memPct = $null
if ($os -and $os.TotalVisibleMemorySize -gt 0) {
  $memPct = [math]::Round((([double]($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)) / [double]$os.TotalVisibleMemorySize) * 100, 2)
}

# ---------- R147 hardware identity -----------------------------------------------------
# BIOS (Manufacturer / Name / SMBIOSBIOSVersion / ReleaseDate / SerialNumber)
$bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
if ($bios) {
  $biosInfo = @{
    manufacturer  = [string]$bios.Manufacturer
    name          = [string]$bios.Name
    version       = [string]$bios.SMBIOSBIOSVersion
    release_date  = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null }
    serial_number = [string]$bios.SerialNumber
  }
} else {
  $biosInfo = @{}
}
$biosInfoJson = [string]($biosInfo | ConvertTo-Json -Compress)

# CPU brand (first processor only — multi-socket systems report the same brand)
$cpu           = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$cpuBrand      = if ($cpu) { [string]$cpu.Name } else { $null }

# Total physical memory (Win32_ComputerSystem.TotalPhysicalMemory is UInt64 → JSON-safe int64)
$mem           = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$memTotalBytes = if ($mem) { [int64]$mem.TotalPhysicalMemory } else { $null }

# ---------- R158.30 — System manufacturer + model (server hardware identity) ------------
# Distinct from BIOS vendor (bios_info.manufacturer). Reuses the $mem instance already
# fetched above so we don't issue a second CIM round-trip.
$sysInfo = if ($mem) {
  @{ manufacturer = [string]$mem.Manufacturer; model = [string]$mem.Model }
} else { @{} }
$sysInfoJson = [string]($sysInfo | ConvertTo-Json -Compress)

# ---------- R158.30 — Network adapter IPs (physical only, IPv4 only) --------------------
# Skip virtual/disabled/tunnel adapters by NetConnectionID regex. IPAddress returns v4+v6
# strings; the dotted-quad regex keeps only IPv4. Select-Object -Unique collapses team
# interface repeats.
$netCfg = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' -ErrorAction SilentlyContinue)
# PS5.1 doesn't allow `$x = foreach ( ... ) | Select-Object` (parser: "An empty pipe element is not allowed").
# Build the result list with an inner accumulator, then dedupe with -Unique.
$netIpsBunch = @()
foreach ($a in $netCfg) {
  $nid = [string]$a.NetConnectionID
  if (-not $nid) { continue }
  if ($nid -match '^(vmware|hyper-v|veth|bluetooth|virtual|loopback|teredo|isatap|6to4|wifi|wi-fi)') { continue }
  foreach ($ip in @($a.IPAddress)) {
    if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') {
      $netIpsBunch += [string]$ip
    }
  }
}
$netIps = @($netIpsBunch | Select-Object -Unique)
$netInfoJson = [string](@{ ipv4 = @($netIps) } | ConvertTo-Json -Compress)

# ---------- R158.30 — Memory modules (Win32_PhysicalMemory) -----------------------------
# Servers with multiple sticks get an array; workstations with one stick get a single-element
# array. Capacity is UInt64 → cast to [int64] for JSON-safe int64.
$memMods = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue |
  Select-Object Manufacturer, PartNumber, Speed, Capacity)
# ConvertTo-Json -AsArray on a collection of hashtables unwraps a single-element
# collection into a bare JSON object (PS5.1 / PS5.2). Force the result through
# [System.Collections.ArrayList] which serializes as a JSON array regardless of
# element count.
$memModsArr = New-Object System.Collections.ArrayList
foreach ($m in $memMods) {
  $row = [ordered]@{
    manufacturer   = [string]$m.Manufacturer
    part_number    = [string]$m.PartNumber
    speed_mhz      = if ($m.Speed)     { [int]$m.Speed }     else { $null }
    capacity_bytes = if ($m.Capacity)  { [int64]$m.Capacity } else { $null }
  }
  [void]$memModsArr.Add((New-Object psobject -Property $row))
}
$memModsJson = if ($memModsArr.Count -gt 0) {
  [string]($memModsArr.ToArray() | ConvertTo-Json -Compress)
} else { '[]' }

# ---------- Physical disks (DriveType=3 — local fixed disks only) -----------------
# R142 hashtable-keyed disk_free / disk_total preserved so the existing
# parseDiskPair + worst-case disk threshold logic keeps working untouched.
# R158.30 — disks[] elements add model + bus_type (C: drive only — the
# dominant signal; non-C drives leave the field null).
$physDisks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
$firstDiskModel = if ($physDisks.Count -gt 0) { [string]($physDisks[0].FriendlyName) } else { $null }
$firstDiskBus   = if ($physDisks.Count -gt 0) { [string]($physDisks[0].BusType) }       else { $null }
$disks = foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') {
  $isC = $d.DeviceID -eq 'C:'
  $m = if ($isC) { $firstDiskModel } else { $null }
  $b = if ($isC) { $firstDiskBus }   else { $null }
  @{ letter = $d.DeviceID; free_bytes = $d.FreeSpace; total_bytes = $d.Size; model = $m; bus_type = $b }
}
# Per-drive array JSON for the new `disks` column (front-end disk list + C:
# row colouring). ConvertTo-Json -AsArray on a hashtable collection unwraps
# a single-drive box into a bare JSON object on PS5.1/5.2 — force through
# ArrayList so the wire format is a JSON array regardless of element count.
$disksArr = New-Object System.Collections.ArrayList
foreach ($d in $disks) {
  $row = [ordered]@{
    letter       = $d.letter
    free_bytes   = $d.free_bytes
    total_bytes  = $d.total_bytes
    model        = if ($d.letter -eq 'C:') { $firstDiskModel } else { $null }
    bus_type     = if ($d.letter -eq 'C:') { $firstDiskBus }   else { $null }
  }
  [void]$disksArr.Add((New-Object psobject -Property $row))
}
$disksArrJson = if ($disksArr.Count -gt 0) {
  [string]($disksArr.ToArray() | ConvertTo-Json -Compress)
} else { '[]' }

# R142 hashtable fix — keep emitting the {"C:":...,"D:":...} object shape
# that parseDiskPair expects. Do NOT regress to array-of-single-key-hashes
# (that was the 1.0.1 bug).
$diskFree  = @{}
$diskTotal = @{}
foreach ($d in $disks) { $diskFree[$d.letter]  = $d.free_bytes  }
foreach ($d in $disks) { $diskTotal[$d.letter] = $d.total_bytes }
$diskFree  = [string]($diskFree  | ConvertTo-Json -Compress)
$diskTotal = [string]($diskTotal | ConvertTo-Json -Compress)

# C: drive used percentage — derived from $disksArr (PSObject array) so the
# front-end can colour the C: row in the per-drive list. Null when C: is
# absent or total_bytes is 0 (e.g. unusual iSCSI / dynamic disks).
$cDisk = $disksArr | Where-Object { $_.letter -eq 'C:' } | Select-Object -First 1
$cUsedPct = if ($cDisk -and $cDisk.total_bytes -gt 0) {
  [math]::Round((1 - ([double]$cDisk.free_bytes / [double]$cDisk.total_bytes)) * 100, 2)
} else { $null }

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
    disk_total = if ($diskTotal) { [string]$diskTotal } else { '{}' }
    services   = (ConvertTo-Json $svcMap -Compress)
    events     = (ConvertTo-Json @($events) -Compress)
    # R147 additions — column order in metricSchema doesn't have to match
    # payload key order; ingestRunV2 reads Object.keys(metricSchema).
    bios_info       = $biosInfoJson
    cpu_brand       = $cpuBrand
    mem_total_bytes = $memTotalBytes
    disks           = $disksArrJson
    c_used_pct      = $cUsedPct
    # R158.30 additions — 3 new top-level JSON columns.
    system_info    = $sysInfoJson
    network_info   = $netInfoJson
    memory_modules = $memModsJson
  }
}
# R158.52 — surface $lastErrorMessage to the centre as `error` so partial
# successes (4/5 counters OK, 1 failed) are diagnosable from package_runs
# instead of silently emitting all-null metrics.
if ($lastErrorMessage) {
  $payload.error = $lastErrorMessage
}
$payload | ConvertTo-Json -Compress -Depth 8