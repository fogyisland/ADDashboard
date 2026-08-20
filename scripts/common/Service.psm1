function Wait-ForHttpOk {
  # Poll a local URL until it returns 2xx (or any HTTP response — the server
  # binding the port is the signal we want). Service "Running" in SCM only
  # means NSSM launched the node process; Express still has to load modules
  # + bind the listening socket, which is 2-15s on cold cache. Without this
  # wait the install script's "probe health" call races the boot and prints
  # "unreachable" even though the service is fine.
  #
  # Self-contained: does NOT call Write-Info (Logger.psm1 isn't always in
  # scope at import time and a missing command throws a CommandNotFoundException
  # that the outer catch swallows — making the function silently return $false
  # even when the probe succeeded). Inline Write-Host with the same prefix
  # is fine; install-center.ps1 routes Logger output the same way.
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
        Write-Host "[INFO] http probe: $Url returned $($resp.StatusCode) on attempt $attempt"
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
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Host "[ERR] Start-ServiceSafe: service '$Name' is not registered. Run Install-NssmService first."
    return $false
  }
  if ($svc.Status -eq 'Running') { return $true }
  if ($svc.Status -eq 'StartPending') {
    # Another caller is already starting the service. Wait for it instead of issuing
    # a second Start-Service (which can fail with "service already starting").
    Write-Host "[INFO] Start-ServiceSafe: $Name is StartPending; waiting for it to reach Running"
  } else {
    # Pre-flight: dump the NSSM parameters so the failure log makes the actual cause
    # obvious. Start-Service's generic "cannot start service" wraps a useful Win32
    # error code (e.g. ERROR_PATH_NOT_FOUND = 3 when AppDirectory is missing), but
    # PowerShell's ServiceCommandException discards it. The NSSM-side stderr log
    # usually has the real reason too, but operators don't always know to check.
    $nssm = Get-NssmPath
    # nssm get writes the value + CR/LF to stdout. Select-Object -First 1 takes
    # the first line; .Trim() strips the trailing whitespace. Without this,
    # Test-Path below throws "illegal character in path" (ItemExistsArgumentError)
    # because `$appDir` ends with `\r\n` — the second silent failure in this
    # install chain caused by the FIRST round of diagnostics.
    $appDir       = (& $nssm get $Name AppDirectory   2>$null | Select-Object -First 1).Trim()
    $appBin       = (& $nssm get $Name Application    2>$null | Select-Object -First 1).Trim()
    $appArgs      = (& $nssm get $Name AppParameters  2>$null | Select-Object -First 1).Trim()
    $appStdErrLog = (& $nssm get $Name AppStderr      2>$null | Select-Object -First 1).Trim()
    # Wrap Test-Path in try/catch so a single bad path doesn't kill the diag
    # dump — best-effort. Show "(test-path failed)" if Test-Path itself throws
    # even after trim (e.g. genuinely illegal character in the configured path).
    $appDirExists = try { if ($appDir) { Test-Path -LiteralPath $appDir } else { $false } } catch { $false }
    $appBinExists = try { if ($appBin) { Test-Path -LiteralPath $appBin } else { $false } } catch { $false }
    $diag = @"
[startup-diag] $Name @ $(Get-Date -Format 'o')
  Status=$($svc.Status) StartType=$($svc.StartType)
  AppDirectory=$appDir
  Application=$appBin
  AppParameters=$appArgs
  AppStderr=$appStdErrLog
  AppDirectory exists? $(if ($appDirExists) { 'YES' } else { if ($appDir) { 'NO — NSSM will fail to launch' } else { '(test-path failed)' } })
  Application exists? $(if ($appBinExists) { 'YES' } else { if ($appBin) { 'NO — NSSM will fail to launch' } else { '(test-path failed)' } })
"@
    Write-Host $diag
    if ($Script:LogDir) {
      $diagFile = Join-Path $Script:LogDir "$Name-startup-diag.log"
      Add-Content -Path $diagFile -Value $diag -ErrorAction SilentlyContinue
    }
    try {
      Start-Service -Name $Name -ErrorAction Stop
    } catch {
      $msg = $_.Exception.InnerException.Message
      if (-not $msg) { $msg = $_.Exception.Message }
      $win32 = ''
      if ($_.Exception.InnerException -and $_.Exception.InnerException.GetType().FullName -match 'Win32Exception') {
        $win32 = " (Win32: $($_.Exception.InnerException.NativeErrorCode))"
      }
      Write-Host "[ERR] Start-Service failed for $Name : $msg$win32"
      Write-Host "[ERR] Check NSSM stderr log at: $appStdErrLog (most likely root cause lives there)"
      return $false
    }
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
