[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:8080',
  [string]$Username = 'admin',
  [Parameter(Mandatory)][string]$Password
)
$ErrorActionPreference = 'Stop'

function Step($n, $ok, $detail='') {
  $line = "{0,-50} {1}" -f $n, $(if ($ok) { 'PASS' } else { "FAIL $detail" })
  Write-Host $line
  if (-not $ok) { $script:fail = $true }
}
$script:fail = $false

# 1. healthz
try {
  $h = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 5
  Step 'healthz' ($h.StatusCode -eq 200 -and (($h.Content | ConvertFrom-Json).status -eq 'ok')) $h.Content
} catch { Step 'healthz' $false $_.Exception.Message }

# 2. login
$token = $null
try {
  $body = @{ username = $Username; password = $Password } | ConvertTo-Json
  $r = Invoke-WebRequest -Uri "$BaseUrl/api/auth/login" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5
  $j = $r.Content | ConvertFrom-Json
  $token = $j.token
  Step 'login' ($r.StatusCode -eq 200 -and $token) $r.Content
} catch { Step 'login' $false $_.Exception.Message }

# 3. dashboard endpoints
$hdr = @{ Authorization = "Bearer $token" }
foreach ($ep in @('/api/dashboard/overview','/api/dashboard/site-matrix','/api/dashboard/topology','/api/dashboard/agents','/api/dashboard/errors')) {
  try {
    $r = Invoke-WebRequest -Uri "$BaseUrl$ep" -Headers $hdr -UseBasicParsing -TimeoutSec 10
    Step $ep ($r.StatusCode -eq 200)
  } catch { Step $ep $false $_.Exception.Message }
}

# 4. static frontend
try {
  $r = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 5
  Step 'static index' ($r.StatusCode -eq 200 -and $r.Content -match 'AD Replication Dashboard')
} catch { Step 'static index' $false $_.Exception.Message }

# 5. install-center -InPlace: C:\addashboard\Center must NOT exist (green-bundle did not copy files)
try {
  $copyMarker = 'C:\addashboard\Center'
  $exists = Test-Path -LiteralPath $copyMarker
  Step 'no C:\addashboard\Center copy (in-place)' (-not $exists) "path exists: $exists"
} catch { Step 'no C:\addashboard\Center copy (in-place)' $false $_.Exception.Message }

# 6. NSSM AppExitAction=Restart and AppRestartDelay=2000 (Set-ServiceRecovery)
try {
  $exitAction = (nssm get ADDashboardCenter AppExitAction 2>&1 | Out-String).Trim()
  $restartDelay = (nssm get ADDashboardCenter AppRestartDelay 2>&1 | Out-String).Trim()
  $okExit = ($exitAction -eq 'Restart')
  $okDelay = ($restartDelay -eq '2000')
  $detail = "AppExitAction='$exitAction' AppRestartDelay='$restartDelay'"
  Step 'nssm AppExitAction=Restart' $okExit $detail
  Step 'nssm AppRestartDelay=2000' $okDelay $detail
} catch { Step 'nssm AppExitAction/AppRestartDelay' $false $_.Exception.Message }

# 7. Windows Service Recovery: sc.exe qfailure output must contain 'restart' and '60'
try {
  $qfail = (sc.exe qfailure ADDashboardCenter 2>&1 | Out-String)
  $hasRestart = ($qfail -match 'restart')
  $has60 = ($qfail -match '60')
  $detail = ($qfail -split "`n" | Select-Object -First 6) -join ' | '
  Step 'sc qfailure contains restart' $hasRestart $detail
  Step 'sc qfailure contains 60' $has60 $detail
} catch { Step 'sc qfailure ADDashboardCenter' $false $_.Exception.Message }

if ($script:fail) { Write-Host "`nSMOKE TEST FAILED" -ForegroundColor Red; exit 1 } else { Write-Host "`nSMOKE TEST PASSED" -ForegroundColor Green }
