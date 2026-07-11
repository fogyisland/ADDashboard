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
