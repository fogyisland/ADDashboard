function Wait-ForHttpOk {
  # Poll a local URL until it returns 2xx (or any HTTP response — the server
  # binding the port is the signal we want). Service "Running" in SCM only
  # means NSSM launched the node process; Express still has to load modules
  # + bind the listening socket, which is 2-15s on cold cache. Without this
  # wait the install script's "probe health" call races the boot and prints
  # "unreachable" even though the service is fine.
  param(
    [Parameter(Mandatory)][string]$Url,
    [int]$TimeoutSeconds = 30,
    [int]$IntervalSeconds = 1
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        Write-Info "http probe: $Url returned $($resp.StatusCode) on attempt $attempt"
        return $true
      }
    } catch {
      # Connection refused / timeout — server still booting. Keep polling.
    }
    Start-Sleep $IntervalSeconds
  }
  return $false
}

# Requires NSSM.psm1 to be imported first (uses Get-NssmPath).
function Start-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name, [int]$WaitSeconds = 15)
  if ((Get-Service -Name $Name -ErrorAction SilentlyContinue).Status -ne 'Running') {
    Start-Service -Name $Name -ErrorAction Stop
  }
  for ($i=0; $i -lt $WaitSeconds; $i++) {
    if ((Get-Service -Name $Name).Status -eq 'Running') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Stop-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name, [int]$WaitSeconds = 30)
  if ((Get-Service -Name $Name -ErrorAction SilentlyContinue).Status -eq 'Stopped') { return $true }
  Stop-Service -Name $Name -Force -ErrorAction Stop
  for ($i=0; $i -lt $WaitSeconds; $i++) {
    if ((Get-Service -Name $Name).Status -eq 'Stopped') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Remove-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name)
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    Stop-ServiceSafe -Name $Name | Out-Null
    $nssm = (Get-NssmPath)
    & $nssm remove $Name confirm | Out-Null
  }
}

function Set-ServiceRecovery {
  param([Parameter(Mandatory)][string]$Name)
  $nssm = Get-NssmPath
  # NSSM-level: restart cleanly on process.exit(0) (used by wizard finalize).
  # AppExit requires the sub-parameter form `<exit_code|Default> <action>` — NSSM
  # 2.24 rejects the bare `AppExit Restart` form with "requires a subparameter!".
  # `Default Restart` means: restart the service on ANY exit code.
  & $nssm set $Name AppExit Default Restart | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppExit Default Restart failed: $LASTEXITCODE" }
  & $nssm set $Name AppRestartDelay 2000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppRestartDelay failed: $LASTEXITCODE" }
  # Windows-level: restart on crash (OOM, segfault, kill -9).
  # Note: the syntax `reset= 60` requires a SPACE after `=`. sc.exe is picky about that.
  $scArgs = @('failure', $Name, 'reset=', '60', 'actions=', 'restart/5000/restart/10000/restart/30000')
  $p = Start-Process -FilePath 'sc.exe' -ArgumentList $scArgs -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "sc.exe failure $Name failed: exit $($p.ExitCode)" }
  Write-Info "service recovery set: NSSM AppExit=Default Restart + sc failure reset=60 actions=restart/5000/restart/10000/restart/30000"
}
