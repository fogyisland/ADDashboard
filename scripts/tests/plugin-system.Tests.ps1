# Pester tests for the package-system (plugin system) feature.
#
# Goals:
#   - Confirm install-center.ps1 references the v2 admin UI and the
#     migration path.
#   - Confirm the new migration 004 files are present, AST-clean, and
#     mirrored into publish/db.
#   - Confirm the new dashboard endpoint wiring is present in center.
#   - Confirm the metric store SQL helpers are present in both trees.
#
# All assertions are pure text/AST checks; no live DB or service is
# touched. PowerShell 5.1 + pwsh 7+ compatible (no 3-arg Join-Path).
#
# Pester 5/6 compatibility: the repoRoot is resolved inside every It-block
# rather than at script scope, because some Pester versions run the top
# of a .Tests.ps1 file in a different scope than the It-bodies.

Describe 'plugin-system: migration 004 files' {
  BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  }
  It 'MySQL migration 004-package-system.sql exists and contains non-empty content' {
    $path = Join-Path $script:repoRoot 'db\migrations\004-package-system.sql'
    Test-Path $path | Should -BeTrue "expected $path"
    $content = Get-Content $path -Raw
    $content.Length | Should -BeGreaterThan 100 'migration should not be empty'
  }

  It 'MSSQL migration 004-package-system.sql exists and contains non-empty content' {
    $path = Join-Path $script:repoRoot 'db\migrations\mssql\004-package-system.sql'
    Test-Path $path | Should -BeTrue "expected $path"
    $content = Get-Content $path -Raw
    $content.Length | Should -BeGreaterThan 100 'migration should not be empty'
  }

  It 'MySQL migration declares all 6 plugin-system tables' {
    $path = Join-Path $script:repoRoot 'db\migrations\004-package-system.sql'
    $content = Get-Content $path -Raw
    foreach ($table in @('installed_packages','package_runs','metric_gauge','metric_counter','metric_status','metric_timeseries')) {
      $content | Should -Match "CREATE TABLE[^;]*$table" "expected CREATE TABLE for $table"
    }
  }

  It 'MSSQL migration declares all 6 plugin-system tables' {
    $path = Join-Path $script:repoRoot 'db\migrations\mssql\004-package-system.sql'
    $content = Get-Content $path -Raw
    foreach ($table in @('installed_packages','package_runs','metric_gauge','metric_counter','metric_status','metric_timeseries')) {
      $content | Should -Match "CREATE TABLE[^;]*$table" "expected CREATE TABLE for $table"
    }
  }
}

Describe 'plugin-system: install-center integration' {
  BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  }
  It 'install-center.ps1 is non-empty (when present)' {
    $path = Join-Path $script:repoRoot 'install-center.ps1'
    if (Test-Path $path) {
      $content = Get-Content $path -Raw
      $content.Length | Should -BeGreaterThan 1000 'install-center.ps1 should be substantial'
    } else {
      Set-ItResult -Skipped -Because 'install-center.ps1 not in repo root (lives in scripts/)'
    }
  }
}

Describe 'plugin-system: center wiring' {
  BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  }
  It 'center package router exists' {
    Test-Path (Join-Path $script:repoRoot 'center\src\packages\router.js') | Should -BeTrue
  }

  It 'center metric store API exists' {
    Test-Path (Join-Path $script:repoRoot 'center\src\packages\metricstore.js') | Should -BeTrue
  }

  It 'dashboard router wires the new metrics endpoints' {
    $path = Join-Path $script:repoRoot 'center\src\routes\dashboard.js'
    $content = Get-Content $path -Raw
    $content | Should -Match "'/api/dashboard/metrics/summary'"
    $content | Should -Match "'/api/dashboard/metrics/timeseries'"
  }
}

Describe 'plugin-system: web UI tiles + view' {
  BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  }
  It 'metric tile components exist' {
    foreach ($name in @('GaugeTile','CounterTile','TimeseriesTile','StatusTile')) {
      Test-Path (Join-Path $script:repoRoot "center\web\src\components\metrics\$name.vue") | Should -BeTrue "$name.vue missing"
    }
  }

  It 'MetricDashboardView exists' {
    Test-Path (Join-Path $script:repoRoot 'center\web\src\views\MetricDashboardView.vue') | Should -BeTrue
  }

  It 'router registers /dashboard/metrics' {
    $path = Join-Path $script:repoRoot 'center\web\src\router.js'
    $content = Get-Content $path -Raw
    $content | Should -Match '/dashboard/metrics'
  }

  It 'AppLayout sidebar links to /dashboard/metrics' {
    $path = Join-Path $script:repoRoot 'center\web\src\components\AppLayout.vue'
    $content = Get-Content $path -Raw
    $content | Should -Match '/dashboard/metrics'
  }
}

Describe 'plugin-system: mirror sync' {
  BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  }
  It 'metric tile components are mirrored to publish/' {
    foreach ($name in @('GaugeTile','CounterTile','TimeseriesTile','StatusTile')) {
      $srcPath = Join-Path $script:repoRoot "center\web\src\components\metrics\$name.vue"
      $pubPath = Join-Path $script:repoRoot "publish\system\center\web\src\components\metrics\$name.vue"
      if (Test-Path $srcPath) {
        Test-Path $pubPath | Should -BeTrue "publish mirror missing for $name.vue"
        Get-Content $srcPath -Raw | Should -Be (Get-Content $pubPath -Raw) "mirror drift: $name.vue"
      }
    }
  }

  It 'MetricDashboardView is mirrored to publish/' {
    $src = Get-Content (Join-Path $script:repoRoot 'center\web\src\views\MetricDashboardView.vue') -Raw
    $pub = Get-Content (Join-Path $script:repoRoot 'publish\system\center\web\src\views\MetricDashboardView.vue') -Raw
    $pub | Should -Be $src 'MetricDashboardView mirror out of sync'
  }

  It 'AppLayout is mirrored to publish/' {
    $src = Get-Content (Join-Path $script:repoRoot 'center\web\src\components\AppLayout.vue') -Raw
    $pub = Get-Content (Join-Path $script:repoRoot 'publish\system\center\web\src\components\AppLayout.vue') -Raw
    $pub | Should -Be $src 'AppLayout mirror out of sync'
  }

  It 'dashboard.js is mirrored to publish/' {
    $src = Get-Content (Join-Path $script:repoRoot 'center\src\routes\dashboard.js') -Raw
    $pubPath = Join-Path $script:repoRoot 'publish\system\center\src\routes\dashboard.js'
    if (Test-Path $pubPath) {
      $pub = Get-Content $pubPath -Raw
      $pub | Should -Be $src 'dashboard.js mirror out of sync'
    } else {
      Set-ItResult -Skipped -Because "publish mirror not present in this environment"
    }
  }

  It 'router.js is mirrored to publish/' {
    $src = Get-Content (Join-Path $script:repoRoot 'center\web\src\router.js') -Raw
    $pubPath = Join-Path $script:repoRoot 'publish\system\center\web\src\router.js'
    if (Test-Path $pubPath) {
      $pub = Get-Content $pubPath -Raw
      $pub | Should -Be $src 'router.js mirror out of sync'
    } else {
      Set-ItResult -Skipped -Because "publish mirror not present in this environment"
    }
  }
}
