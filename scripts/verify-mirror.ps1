# verify-mirror.ps1 — compare source files to their publish/ mirrors.
#
# Convention: every non-test source file under center/, agent/, frontend/, and
# db/migrations/ is mirrored byte-identical into publish/ (see project memory
# feedback_full_chain_cleanup.md). Test files are NOT mirrored — that's the
# runtime-only bundle convention (publish/ is what users run on
# C:\addashboard, not what we develop in).
#
# This script walks a fixed list of source↔mirror pairs and emits PASS/FAIL
# per pair. Exit code 0 means all pairs match; 1 means drift.
#
# Usage:
#   pwsh -File scripts\verify-mirror.ps1
#
# Compatible with PowerShell 5.1+ (no ternary `? :`, no 3-arg Join-Path, no
# -AsHashtable, no null-coalescing `??`). See feedback_powershell_51.md.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

# Each pair: source (relative to repo root) ↔ publish/ mirror (relative to repo root).
# Order: backend modules first, then SQL/migration, then frontend.
$comparisons = @(
  # Backend — package system v2 (Tasks 1, 3, 4, 5, 6, 7, 8, 10)
  @{ left = 'center/src/packages/ddl-sandbox.js';            right = 'publish/center/src/packages/ddl-sandbox.js' }
  @{ left = 'center/src/packages/ddl-apply.js';              right = 'publish/center/src/packages/ddl-apply.js' }
  @{ left = 'center/src/packages/orphan-router.js';          right = 'publish/center/src/packages/orphan-router.js' }
  @{ left = 'center/src/db/sql/orphan-schemas.js';           right = 'publish/center/src/db/sql/orphan-schemas.js' }
  @{ left = 'center/src/db/sql.js';                          right = 'publish/center/src/db/sql.js' }
  @{ left = 'center/src/packages/manifest.js';               right = 'publish/center/src/packages/manifest.js' }
  @{ left = 'center/src/packages/installer.js';              right = 'publish/center/src/packages/installer.js' }
  @{ left = 'center/src/packages/metricstore.js';            right = 'publish/center/src/packages/metricstore.js' }
  @{ left = 'center/src/packages/router.js';                 right = 'publish/center/src/packages/router.js' }
  @{ left = 'center/src/packages/errors.js';                 right = 'publish/center/src/packages/errors.js' }
  @{ left = 'center/src/packages/registry-index.schema.json'; right = 'publish/center/src/packages/registry-index.schema.json' }
  @{ left = 'center/src/packages/registry.js';               right = 'publish/center/src/packages/registry.js' }
  @{ left = 'center/server.js';                              right = 'publish/center/server.js' }
  # Non-AD server management — Tasks 11 (alert loop + email loop + alert SQL)
  @{ left = 'center/src/services/alert-engine.js';           right = 'publish/center/src/services/alert-engine.js' }
  @{ left = 'center/src/services/email.js';                  right = 'publish/center/src/services/email.js' }
  @{ left = 'center/src/db/sql/alert-events.js';             right = 'publish/center/src/db/sql/alert-events.js' }
  @{ left = 'center/src/db/sql/alert-outbox.js';             right = 'publish/center/src/db/sql/alert-outbox.js' }
  @{ left = 'center/src/db/sql/alert-metrics.js';            right = 'publish/center/src/db/sql/alert-metrics.js' }
  # Non-AD server management — Tasks 11 fix round 1 (F1: add listEnabledForHostWithState SQL block)
  @{ left = 'center/src/db/sql/alert-rules.js';              right = 'publish/center/src/db/sql/alert-rules.js' }
  # Migrations — Task 2
  @{ left = 'db/migrations/013-orphan-schemas.sql';          right = 'publish/db/migrations/013-orphan-schemas.sql' }
  @{ left = 'db/migrations/mssql/013-orphan-schemas.sql';    right = 'publish/db/migrations/mssql/013-orphan-schemas.sql' }
  # Frontend — Tasks 11, 12
  @{ left = 'frontend/src/components/PackageDdlPreviewModal.vue';   right = 'publish/frontend/src/components/PackageDdlPreviewModal.vue' }
  @{ left = 'frontend/src/components/UninstallSchemaConfirmModal.vue'; right = 'publish/frontend/src/components/UninstallSchemaConfirmModal.vue' }
  @{ left = 'frontend/src/views/admin/OrphanSchemasView.vue'; right = 'publish/frontend/src/views/admin/OrphanSchemasView.vue' }
  @{ left = 'frontend/src/views/admin/PackageEditView.vue';  right = 'publish/frontend/src/views/admin/PackageEditView.vue' }
  @{ left = 'frontend/src/api/admin.js';                     right = 'publish/frontend/src/api/admin.js' }
  @{ left = 'frontend/src/router.js';                        right = 'publish/frontend/src/router.js' }
  # Note: Task 12 modified AdminLayout.vue (not AppLayout.vue as the global
  # plan file claims). Confirmed via `git show --stat 37d1ef7`.
  @{ left = 'frontend/src/components/AdminLayout.vue';       right = 'publish/frontend/src/components/AdminLayout.vue' }
)

$fail = $false
$pass = 0
$missing = 0
$drift = 0

function Pair-Line($n, $ok, $detail) {
  $line = "{0,-86} {1}" -f $n, $(if ($ok) { 'PASS' } else { "FAIL $detail" })
  Write-Host $line
  if (-not $ok) { $script:fail = $true }
}

foreach ($c in $comparisons) {
  $leftAbs = Join-Path $projectRoot $c.left
  $rightAbs = Join-Path $projectRoot $c.right

  if (-not (Test-Path -LiteralPath $leftAbs)) {
    Pair-Line $c.left $false 'source missing'
    $missing++
    continue
  }
  if (-not (Test-Path -LiteralPath $rightAbs)) {
    Pair-Line $c.left $false 'mirror missing'
    $missing++
    continue
  }

  # Compute SHA-256 of both files and compare. Byte-identical check ignores
  # CRLF/LF drift (we don't normalize line endings — if source has CRLF and
  # mirror has LF that's a real drift the implementer should fix at copy
  # time, not a false-positive).
  $leftHash = (Get-FileHash -Algorithm SHA256 -Path $leftAbs).Hash
  $rightHash = (Get-FileHash -Algorithm SHA256 -Path $rightAbs).Hash

  if ($leftHash -eq $rightHash) {
    Pair-Line $c.left $true ''
    $pass++
  } else {
    Pair-Line $c.left $false "hash mismatch ($leftHash vs $rightHash)"
    $drift++
  }
}

Write-Host ''
Write-Host ("summary: {0} pass, {1} drift, {2} missing" -f $pass, $drift, $missing)
if ($fail) {
  Write-Host 'MIRROR VERIFY FAILED' -ForegroundColor Red
  exit 1
} else {
  Write-Host 'MIRROR VERIFY PASSED' -ForegroundColor Green
  exit 0
}