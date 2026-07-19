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
  & $nssm set $Name AppExit Restart | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppExit failed: $LASTEXITCODE" }
  & $nssm set $Name AppRestartDelay 2000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppRestartDelay failed: $LASTEXITCODE" }
  # Windows-level: restart on crash (OOM, segfault, kill -9).
  # Note: the syntax `reset= 60` requires a SPACE after `=`. sc.exe is picky about that.
  $scArgs = @('failure', $Name, 'reset=', '60', 'actions=', 'restart/5000/restart/10000/restart/30000')
  $p = Start-Process -FilePath 'sc.exe' -ArgumentList $scArgs -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "sc.exe failure $Name failed: exit $($p.ExitCode)" }
  Write-Info "service recovery set: NSSM AppExit=Restart + sc failure reset=60 actions=restart/5000/restart/10000/restart/30000"
}
