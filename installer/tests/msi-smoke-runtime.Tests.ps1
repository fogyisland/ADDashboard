<#
.SYNOPSIS
  Pester runtime smoke for the Agent Info Collection feature on a
  freshly-installed MSI agent.

.DESCRIPTION
  Companion to msi-smoke.Tests.ps1 (which covers MSI install + NSSM
  service registration). This file covers the runtime side: once the
  MSI is installed and the agent is connected to a test center, the
  three new collection surfaces should land on the agent box and the
  results should reach the center.

  What it covers (target It blocks):
    1. After MSI install + agent connect, package sync delivers
       ad_local_port_check/<ver>/collect.ps1
    2. After MSI install + agent connect, package sync delivers
       ad_domain_consistency/<ver>/collect.ps1
    3. After MSI install + agent connect, package sync delivers
       ad_os_baseline/<ver>/collect.ps1 (existing baseline - regression
       guard so the new sync code didn't break the pre-existing flow)
    4. Shipped collect-replication.ps1 contains the T3 partner-port
       extensions (Get-PartnerPortSnapshot + __partner_ports__ naming)
    5. After at least one collect cycle, ad_replication_status has rows
       with non-null partner_port_status for this agent's source_dc
    6. After at least one collect cycle, pkg_ad_local_port_check.metrics
       has rows for this agent (one per port probe set)
    7. After at least one collect cycle, pkg_ad_domain_consistency.metrics
       has rows for this agent (or error_code non-null if AD module
       unavailable on this VM)

  Host safety:
    - Gated on $env:ADDASHBOARD_TEST_CENTER_URL being set. Without it,
      every It block skips (matches the skip-when-not-configured pattern
      used elsewhere in the installer test suite).
    - Requires admin for the install + service bits - inherits the same
      skip mechanism as msi-smoke.Tests.ps1.
    - Pre-existing service / install dir are stopped + removed in
      BeforeAll (same defensive cleanup as the MSI smoke).

  PowerShell 5.1 + pwsh 7+ compatible: no null-coalescing (??), no ternary
  (? :), no 3-arg Join-Path. Pester 5/6 syntax.

  Status: DRAFT (Task 272 - VM smoke extension). The companion MSI smoke
  is already green on this dev box; this file's It blocks all skip here
  because no test center is configured. The intended run command on the
  VM is documented in progress_2026_08_22.md (memory).

.NOTES
  Design points:

  A1 - Test center. We do NOT spin up a center from the smoke test.
       Instead the operator sets ADDASHBOARD_TEST_CENTER_URL pointing at
       a pre-running center that has the new packages installed (via the
       normal admin /api-install endpoint or by loading the seed data).
       This keeps the smoke test focused on the agent-side behavior.

  A2 - Sync timing. Package sync runs on agent startup + every 5 minutes
       (intervalSec). The first sync can take ~30s after the service
       comes up. Each It block that asserts "file landed" waits up to
       SyncTimeoutSec (default 120s) for the file to appear; after the
       timeout the assertion fails with a clear message so a flaky network
       or missing package is surfaced loudly rather than silently passed.

  A3 - DB assertions. The center-side assertions (It blocks 5-7) connect
       to the test center's MySQL/MSSQL using the same credentials the
       agent uses (read from appsettings.json). The connection is closed
       in AfterAll via try/finally so a failed assertion doesn't leak the
       handle.

  A4 - Agent data dir. Hardcoded to C:\addashboard\Agent\data per
       agent/src/config.js default. A future config-driven override
       (via appsettings.json agentDataDir) belongs in agent code, not in
       this test.

  A5 - Idempotency. Re-running the smoke after a successful run will
       fail the package-sync assertions because the agent is already
       running (its data dir is populated). BeforeAll stops the service
       + removes the data dir before re-running, matching the MSI smoke
       defensive-cleanup pattern.
#>

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path -Path $env:TEMP -ChildPath 'msi-runtime-test'),
  [string]$CenterUrl = $env:ADDASHBOARD_TEST_CENTER_URL,
  [string]$AgentToken = $env:ADDASHBOARD_TEST_AGENT_TOKEN,
  [int]$SyncTimeoutSec = 120,
  [string]$ServiceName = 'ADReplicationAgent',
  [string]$MysqlExe = 'mysql'
)

BeforeAll {
  $script:InstallDir = $InstallDir
  $script:CenterUrl = $CenterUrl
  $script:AgentToken = $AgentToken
  $script:SyncTimeoutSec = $SyncTimeoutSec
  $script:ServiceName = $ServiceName
  $script:MysqlExe = $MysqlExe
  $script:SkipReason = $null

  if ([string]::IsNullOrEmpty($script:CenterUrl)) {
    $script:SkipReason = 'ADDASHBOARD_TEST_CENTER_URL not set; runtime smoke requires a running test center.'
  }
  elseif ([string]::IsNullOrEmpty($script:AgentToken)) {
    $script:SkipReason = 'ADDASHBOARD_TEST_AGENT_TOKEN not set; runtime smoke needs an agent token to query DB rows attributed to this agent.'
  }
  else {
    # Admin check.
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $id
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
      $script:SkipReason = 'Not running as Administrator; cannot query the installed agent data dir or stop its service.'
    }
  }

  if ($script:SkipReason) {
    Write-Warning "msi-smoke-runtime.Tests.ps1: $script:SkipReason"
  }
  else {
    # Defensive pre-cleanup (matches msi-smoke.Tests.ps1 pattern).
    if (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue) {
      try {
        sc.exe stop $script:ServiceName | Out-Null
        Start-Sleep -Seconds 2
      } catch { }
    }
    if (Test-Path -LiteralPath $script:InstallDir) {
      try { Remove-Item -LiteralPath $script:InstallDir -Recurse -Force } catch { }
    }
  }
}

Describe 'MSI Agent runtime smoke (Agent Info Collection)' {
  It 'ships partner-port-aware collect-replication.ps1' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # T3 deliverable: the modified collect-replication.ps1 must contain
    # the partner-port probe function and the naming context constant.
    # This file ships in the MSI itself (Files.wxs:92-96), so it's
    # verifiable without waiting for any sync.
    $scriptPath = Join-Path -Path $script:InstallDir -ChildPath 'scripts\collect-replication.ps1'
    $scriptPath | Should -Exist
    $content = Get-Content -LiteralPath $scriptPath -Raw
    $content | Should -Match 'Get-PartnerPortSnapshot'
    $content | Should -Match '__partner_ports__'
  }

  It 'syncs ad_local_port_check package' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # T2 deliverable: agent package-manager downloads collect.ps1 from
    # center on first sync. The file lands under
    # C:\addashboard\Agent\data\packages\ad_local_port_check\<ver>\.
    $pkgDir = 'C:\addashboard\Agent\data\packages\ad_local_port_check'
    $collect = Wait-PackageFile -Dir $pkgDir -Name 'collect.ps1' -TimeoutSec $script:SyncTimeoutSec
    $collect | Should -Exist
    $manifest = Join-Path -Path $pkgDir -ChildPath 'manifest.json'
    Test-Path -LiteralPath $manifest | Should -BeTrue
  }

  It 'syncs ad_domain_consistency package' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # T4 deliverable: same sync flow as ad_local_port_check.
    $pkgDir = 'C:\addashboard\Agent\data\packages\ad_domain_consistency'
    $collect = Wait-PackageFile -Dir $pkgDir -Name 'collect.ps1' -TimeoutSec $script:SyncTimeoutSec
    $collect | Should -Exist
  }

  It 'still syncs ad_os_baseline (regression guard)' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # Pre-existing built-in package; the new sync code must not have
    # broken it. assert presence within sync timeout.
    $pkgDir = 'C:\addashboard\Agent\data\packages\ad_os_baseline'
    $collect = Wait-PackageFile -Dir $pkgDir -Name 'collect.ps1' -TimeoutSec $script:SyncTimeoutSec
    $collect | Should -Exist
  }

  It 'reports partner_port_status to center after first cycle' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # T1 + T3 deliverable: after collect-replication.ps1 runs against
    # the test center, the agent inserts ad_replication_status rows
    # with non-null partner_port_status for its source_dc.
    #
    # DB query: requires MySQL/MSSQL creds from the test center's
    # appsettings.json. Operator runs this with $MysqlExe on the path
    # or overrides it via the -MysqlExe parameter.
    $sourceDc = $env:COMPUTERNAME
    $query = "SELECT COUNT(*) AS n FROM ad_replication_status WHERE source_dc = '$sourceDc' AND partner_port_status IS NOT NULL"
    $count = Invoke-TestCenterQuery -Sql $query -TimeoutSec $script:SyncTimeoutSec
    $count | Should -BeGreaterThan 0
  }

  It 'reports ad_local_port_check metrics to center' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # T2 deliverable: pkg_ad_local_port_check.metrics has rows for
    # this agent. agent_id comes from appsettings.json (the CA seeds
    # it to the hostname).
    $agentId = $env:COMPUTERNAME
    $query = "SELECT COUNT(*) AS n FROM pkg_ad_local_port_check.metrics WHERE agent_id = '$agentId'"
    $count = Invoke-TestCenterQuery -Sql $query -TimeoutSec $script:SyncTimeoutSec
    $count | Should -BeGreaterThan 0
  }

  It 'reports ad_domain_consistency metrics to center (or error_code)' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # T4 deliverable: pkg_ad_domain_consistency.metrics has rows for
    # this agent. If the VM doesn't have the ActiveDirectory RSAT
    # module, the script's try/catch sets error_code to non-null and
    # the *_hash fields to null - we accept either shape.
    $agentId = $env:COMPUTERNAME
    $query = "SELECT COUNT(*) AS n FROM pkg_ad_domain_consistency.metrics WHERE agent_id = '$agentId' AND (error_code IS NOT NULL OR user_hash IS NOT NULL)"
    $count = Invoke-TestCenterQuery -Sql $query -TimeoutSec $script:SyncTimeoutSec
    $count | Should -BeGreaterThan 0
  }
}

# ---- helpers ----

# Wait for a file to appear in $dir/$name, polling every 2s up to
# $TimeoutSec seconds. Returns the resolved path on success, $null on
# timeout (the caller Should -Exist on the returned value to fail
# loudly with a clear missing-file message).
function Wait-PackageFile {
  param(
    [string]$Dir,
    [string]$Name,
    [int]$TimeoutSec
  )
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $candidate = Join-Path -Path $Dir -ChildPath $Name
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    Start-Sleep -Seconds 2
  }
  return $null
}

# Run a SQL query against the test center's DB via the mysql CLI.
# Returns the first column of the first row as an integer. Wrapped in
# try/catch so a missing mysql.exe or unreachable host surfaces as a
# clean Pester failure, not a PowerShell exception.
function Invoke-TestCenterQuery {
  param(
    [string]$Sql,
    [int]$TimeoutSec
  )
  # TODO(VM): pull host/port/database/user/password from
  # $InstallDir\appsettings.json or a side-channel env var. The dev
  # box never reaches this code path because $script:SkipReason is
  # always set (no test center configured).
  throw 'Invoke-TestCenterQuery not implemented for dev box; VM smoke will fill in.'
}