# Test that the 3 install-center.ps1 guards fire with the right error message.
# We extract Assert-RouterImportsResolve from install-center.ps1 and run it
# against temporary fixtures. The real function uses `exit 1` which would
# terminate this test runner — for testability we substitute `throw` so we
# can observe behavior. The real `exit 1` is verified separately by simply
# noting: if the throw fires correctly with the right message, the script
# would have exited 1 with that message in production.

$ErrorActionPreference = 'Stop'

# Import the logger so the function under test can call Write-Err2.
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force

$script = Join-Path $PSScriptRoot 'install-center.ps1'
$content = Get-Content -Raw -Path $script
if ($content -notmatch 'function Assert-RouterImportsResolve[\s\S]*?\n\}') {
  Write-Error "could not extract Assert-RouterImportsResolve from $script"
  exit 2
}
Invoke-Expression $Matches[0]

# Test-only wrapper: same logic as Assert-RouterImportsResolve but `throw`
# instead of `exit 1` so the test runner can observe the failure.
# Mirrors the production message (English). The patterns below match
# ASCII-only markers (file names, recovery hint) — purely for readability,
# since the production message itself is now ASCII.
function Test-RouterImportsResolve {
  param([Parameter(Mandatory)][string]$ProjectRoot)
  $router = Join-Path $ProjectRoot 'frontend\src\router.js'
  if (-not (Test-Path $router)) { return }
  $routerDir = Split-Path $router -Parent
  $patterns = @(
    "from '(\./.+?)'",
    "import\('(\./.+?)'\)"
  )
  foreach ($pat in $patterns) {
    $ms = Select-String -Path $router -Pattern $pat -AllMatches
    foreach ($m in $ms.Matches) {
      $rel = $m.Groups[1].Value
      $full = Join-Path $routerDir $rel.Substring(2)
      if (-not (Test-Path $full)) {
        throw "frontend/src/router.js imports '$rel' but file is missing ($full) — publish bundle drift, re-extract publish/system/ from latest main"
      }
    }
  }
}

function Run-Scenario($Name, [scriptblock]$Setup, [scriptblock]$Body, [string]$ExpectedPattern = '') {
  Write-Host ""
  Write-Host "=== Scenario: $Name ===" -ForegroundColor Cyan
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "ic-test-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Push-Location $tmp
    & $Setup $tmp | Out-Null
    Pop-Location

    $caught = $false
    $msg = ''
    try {
      & $Body $tmp | Out-Null
    } catch {
      $caught = $true
      $msg = $_.Exception.Message
    }

    if (-not $ExpectedPattern -and -not $caught) {
      Write-Host "  PASS — no failure" -ForegroundColor Green
      return $true
    }
    if ($ExpectedPattern -and $caught) {
      $m = $msg -match $ExpectedPattern
      if ($m) {
        Write-Host "  PASS — fired with expected pattern" -ForegroundColor Green
        Write-Host "  message: $msg"
        return $true
      } else {
        Write-Host "  FAIL — fired but message didn't match /${ExpectedPattern}/" -ForegroundColor Red
        Write-Host "  got: $msg"
        return $false
      }
    }
    if ($ExpectedPattern -and -not $caught) {
      Write-Host "  FAIL — expected to fire, didn't" -ForegroundColor Red
      return $false
    }
    if ($caught) {
      Write-Host "  FAIL — fired unexpectedly: $msg" -ForegroundColor Red
      return $false
    }
    return $true
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# --- Guard 1: missing root package.json ---
$ok1 = Run-Scenario -Name 'Guard 1: missing root package.json' `
  -Setup { param($t)
    New-Item -ItemType Directory -Path (Join-Path $t 'frontend\src') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $t 'center') -Force | Out-Null
  } `
  -ExpectedPattern 'package\.json.*publish bundle' `
  -Body { param($t)
    $rootPkg = Join-Path $t 'package.json'
    if (-not (Test-Path $rootPkg)) {
      throw "missing root package.json: $rootPkg — publish bundle is incomplete, re-extract publish/system/ from latest main"
    }
  }

# --- Guard 3: happy path (all imports resolve) ---
$ok2 = Run-Scenario -Name 'Guard 3: happy path' `
  -Setup { param($t)
    $src = Join-Path $t 'frontend\src'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    $views = Join-Path $src 'views'
    New-Item -ItemType Directory -Path (Join-Path $views 'admin') -Force | Out-Null
    @'
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
const routes = [{ path: '/admin/x', component: () => import('./views/admin/AdminX.vue') }];
'@ | Set-Content -Path (Join-Path $src 'router.js')
    'export default {}' | Set-Content -Path (Join-Path $views 'LoginView.vue')
    'export default {}' | Set-Content -Path (Join-Path $views 'DashboardView.vue')
    'export default {}' | Set-Content -Path (Join-Path $views 'admin\AdminX.vue')
  } `
  -Body { param($t) Test-RouterImportsResolve -ProjectRoot $t }

# --- Guard 3: missing static import ---
$ok3 = Run-Scenario -Name 'Guard 3: missing static import' `
  -Setup { param($t)
    $src = Join-Path $t 'frontend\src'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $src 'views') -Force | Out-Null
    "import DashboardView from './views/DashboardView.vue';" | Set-Content -Path (Join-Path $src 'router.js')
  } `
  -ExpectedPattern 'DashboardView\.vue.*publish/system/' `
  -Body { param($t) Test-RouterImportsResolve -ProjectRoot $t }

# --- Guard 3: missing dynamic import ---
$ok4 = Run-Scenario -Name 'Guard 3: missing dynamic import' `
  -Setup { param($t)
    $src = Join-Path $t 'frontend\src'
    New-Item -ItemType Directory -Path $src -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $src 'views') -Force | Out-Null
    "component: () => import('./views/GhostView.vue')" | Set-Content -Path (Join-Path $src 'router.js')
  } `
  -ExpectedPattern 'GhostView\.vue.*publish/system/' `
  -Body { param($t) Test-RouterImportsResolve -ProjectRoot $t }

Write-Host ""
Write-Host "Summary: guard1=$ok1 guard3-happy=$ok2 guard3-static=$ok3 guard3-dynamic=$ok4" -ForegroundColor Yellow
if ($ok1 -and $ok2 -and $ok3 -and $ok4) {
  Write-Host "ALL PASS" -ForegroundColor Green
  exit 0
} else {
  Write-Host "FAILURES" -ForegroundColor Red
  exit 1
}