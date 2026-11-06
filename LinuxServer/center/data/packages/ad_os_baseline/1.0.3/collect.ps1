# collect.ps1 — ad_os_baseline v3 (R147)
# Captures CPU/memory/disk snapshot PLUS hardware-identity (BIOS / CPU brand /
# total memory bytes) and a per-drive physical-disk list (DriveType=3 only —
# local fixed disks, skips CD/network/RAM/virtual). C: drive used percentage
# is computed from the new `disks` array so the front-end can show
# per-drive usage + colour the C: row without depending on disk_free/total
# hashtable pairing.
#
# Emits: {"metrics": {...}} per v2 contract — metricSchema columns are
# auto-discovered by centre/ingestRunV2 (no explicit install wiring needed).

$ErrorActionPreference = 'SilentlyContinue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception messages /
# DC names survives the PS→agent→centre pipeline without transcoding through
# the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- CPU sample + memory percentage (1.0.2 baseline, unchanged) ----
$cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue
$os        = Get-CimInstance Win32_OperatingSystem
$memPct    = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 2)

# ---------- R147 hardware identity -----------------------------------------------------
# BIOS (Manufacturer / Name / SMBIOSBIOSVersion / ReleaseDate)
$bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
if ($bios) {
  $biosInfo = @{
    manufacturer = [string]$bios.Manufacturer
    name         = [string]$bios.Name
    version      = [string]$bios.SMBIOSBIOSVersion
    release_date = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null }
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

# ---------- Physical disks (DriveType=3 — local fixed disks only) -----------------
# R142 hashtable-keyed disk_free / disk_total preserved so the existing
# parseDiskPair + worst-case disk threshold logic keeps working untouched.
$disks = foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') {
  @{ letter = $d.DeviceID; free_bytes = $d.FreeSpace; total_bytes = $d.Size }
}
# Per-drive array JSON for the new `disks` column (front-end disk list + C:
# row colouring).
$disksArrJson = if ($disks) {
  [string](@($disks) | ConvertTo-Json -Compress -AsArray)
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

# C: drive used percentage — derived from $disks above (front-end uses this
# to colour the C: row in the per-drive list). Null when C: is absent or
# total_bytes is 0 (e.g. unusual iSCSI / dynamic disks).
$cDisk = @($disks) | Where-Object { $_.letter -eq 'C:' } | Select-Object -First 1
$cUsedPct = if ($cDisk -and $cDisk.total_bytes -gt 0) {
  [math]::Round((1 - ([double]$cDisk.free_bytes / [double]$cDisk.total_bytes)) * 100, 2)
} else { $null }

# ---------- Services + recent events (1.0.2 baseline, unchanged) ------------------
$svcAllow = 'Spooler','WinRM','W32Time','DNS','LanmanServer','LanmanWorkstation','Wecsvc'
$svcMap = @{}
foreach ($n in $svcAllow) { try { $svcMap[$n] = (Get-Service -Name $n -ErrorAction SilentlyContinue).Status.ToString() } catch {} }

$events = Get-WinEvent -FilterHashtable @{LogName='System','Application'; StartTime=(Get-Date).AddMinutes(-5); Level=2,3} -MaxEvents 20 -ErrorAction SilentlyContinue |
  Select-Object LogName, Id, LevelDisplayName, Message |
  ForEach-Object { @{ log = $_.LogName; id = $_.Id; level = $_.LevelDisplayName; msg = ($_.Message -replace "`r`n"," ") -replace '\s+',' ' } }

# ---------- Payload ------------------------------------------------------------------
$payload = @{
  metrics = @{
    # 1.0.2 originals
    cpu_pct    = [double]$cpuSample
    memory_pct = [double]$memPct
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
  }
}
$payload | ConvertTo-Json -Compress -Depth 8