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

if ($script:fail) { Write-Host "`nSMOKE TEST FAILED" -ForegroundColor Red; exit 1 } else { Write-Host "`nSMOKE TEST PASSED" -ForegroundColor Green }
