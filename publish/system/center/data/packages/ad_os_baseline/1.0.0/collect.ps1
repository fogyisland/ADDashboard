# collect.ps1 — ad_os_baseline v1
# Captures CPU, memory, disk, services, event log snapshot.
# Emits: {"metrics": {...}} per v2 contract.
$ErrorActionPreference = 'SilentlyContinue'

$cpuSample = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue
$os        = Get-CimInstance Win32_OperatingSystem
$memPct    = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 2)

$disks = foreach ($d in Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3') {
  @{ letter = $d.DeviceID; free_bytes = $d.FreeSpace; total_bytes = $d.Size }
}
$diskFree = ($disks | ForEach-Object { @{ $_.letter = $_.free_bytes } } | ConvertTo-Json -Compress)
$diskTotal = ($disks | ForEach-Object { @{ $_.letter = $_.total_bytes } } | ConvertTo-Json -Compress)

$svcAllow = 'Spooler','WinRM','W32Time','DNS','LanmanServer','LanmanWorkstation','Wecsvc'
$svcMap = @{}
foreach ($n in $svcAllow) { try { $svcMap[$n] = (Get-Service -Name $n -ErrorAction SilentlyContinue).Status.ToString() } catch {} }

$events = Get-WinEvent -FilterHashtable @{LogName='System','Application'; StartTime=(Get-Date).AddMinutes(-5); Level=2,3} -MaxEvents 20 -ErrorAction SilentlyContinue |
  Select-Object LogName, Id, LevelDisplayName, Message |
  ForEach-Object { @{ log = $_.LogName; id = $_.Id; level = $_.LevelDisplayName; msg = ($_.Message -replace "`r`n"," ") -replace '\s+',' ' } }

$payload = @{
  metrics = @{
    cpu_pct    = [double]$cpuSample
    memory_pct = [double]$memPct
    disk_free  = if ($diskFree)  { [string]$diskFree }  else { '{}' }
    disk_total = if ($diskTotal) { [string]$diskTotal } else { '{}' }
    services   = (ConvertTo-Json $svcMap -Compress)
    events     = (ConvertTo-Json @($events) -Compress)
  }
}
$payload | ConvertTo-Json -Compress -Depth 8