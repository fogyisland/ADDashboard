# collect.ps1 - ad_local_port_check v1
# Probes the local machine's ports [135, 445, 50001, 50002, 50003] via
# TcpClient.ConnectAsync with a hard 1.5s per-probe timeout and a stopwatch.
# Loopback (127.0.0.1) is used instead of $env:COMPUTERNAME so the probe
# doesn't depend on DNS resolution. Each port result is a JSON shape
#   { "reachable": <bool>, "latencyMs": <number|null>, "error": <string|null> }
# Always emits ALL five port columns so strict metricstore validation
# (PKG_METRIC_KEY_UNKNOWN) never fires on a partial subset.
# Server clock stamps `ts` on the center side; this script omits it.
$ErrorActionPreference = 'Continue'

$ports = @(135, 445, 50001, 50002, 50003)
$target = '127.0.0.1'
$probeTimeoutMs = 1500

function Probe-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connectTask = $client.ConnectAsync($target, $port)
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    # Wait(1500) returns $true if the task completed within the timeout;
    # returns $false if it timed out. We still need to surface the
    # exception (if any) via try/catch around the await itself.
    $completed = $connectTask.Wait($probeTimeoutMs)
    $stopwatch.Stop()
    if ($completed -and $client.Connected) {
      return @{ reachable = $true; latencyMs = [int]$stopwatch.ElapsedMilliseconds; error = $null }
    }
    # Wait() timed out without throwing — surface as a timeout result and
    # clean up the pending task by closing the client (which cancels the
    # async operation).
    return @{ reachable = $false; latencyMs = $null; error = 'timeout' }
  } catch {
    $msg = $_.Exception.Message
    return @{ reachable = $false; latencyMs = $null; error = $msg }
  } finally {
    try { $client.Close() } catch {}
  }
}

$metrics = @{ agent_id = $env:COMPUTERNAME }
foreach ($p in $ports) {
  $key = "port_$p"
  $metrics[$key] = Probe-Port $p
}

$payload = @{ metrics = $metrics }
$payload | ConvertTo-Json -Compress -Depth 4