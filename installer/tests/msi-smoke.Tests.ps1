<#
.SYNOPSIS
  Pester E2E smoke for the AD Dashboard Agent MSI installer.

.DESCRIPTION
  Drives a real `msiexec /i` install + verify + `msiexec /x` uninstall
  round-trip against the built artifact at `$MsiPath` (default: the path
  produced by `installer/build-msi.ps1` - `bin/x64/Release/zh-CN/addashboard-
  agent-x64-1.0.0.0.msi`).

  What it covers (seven It blocks):
    1. silent install with CENTERURL / AGENTTOKEN / AGENTTYPE / INSTALLDIR
    2. expected files land under INSTALLDIR (agent.js, node/, nssm/, scripts/)
    3. node_modules\axios landed — proves the deferred CA's `npm install
       --omit=dev` ran successfully on the target (npm failure rolls the
       install back via the CA throwing, so this assertion is effectively
       the same as checking the install step succeeded, but it pins down
       *which* mechanism built node_modules — not some pre-existing copy)
    4. NSSM service ADReplicationAgent registered and Running
    5. appsettings.json has the keys the deferred CA wrote
    6. sc.exe qfailure shows NSSM recovery config (reset= 60 actions= restart/...)
    7. appsettings.json persistence semantics: stays on disk after uninstall
       (per R2 + Task 7 finding - file is owned by the CA, not the File table,
       so MSI's RemoveFiles does NOT delete it; cleanup is manual)

  Host safety:
    - BeforeAll resolves the MSI path and detects non-admin hosts. Each It
      block then re-checks $script:SkipReason and calls
      `Set-ItResult -Skipped -Because ...` if the host cannot run a real
      install (missing MSI, not admin). The skip pattern matches the
      existing repo convention in scripts/tests/plugin-system.Tests.ps1.
    - A real install failure (msiexec exit non-zero, missing file,
      service not running) is asserted with `Should -Be` and will fail
      loudly; we never silently swallow a real failure.

  PowerShell 5.1 + pwsh 7+ compatible: no null-coalescing (??), no ternary
  (? :), no 3-arg Join-Path. Standard `if` / `Join-Path -Path a -ChildPath b`.

  Pester 5/6 syntax (BeforeAll / It / Should -Be). Tested against Pester 6.0.0
  on the dev box.

  Not run on this dev box:
    - This host is not admin (IsInRole(Administrator) = False), so destructive
      install/uninstall is unsafe; BeforeAll sets $script:SkipReason and
      every It block skips with that reason.
    - The same script runs unmodified on a Windows Server 2022 / Win 10/11
      VM with admin privilege; the build artifact at $MsiPath is portable.

.NOTES
  Corrections from the original brief (`task-9-brief.md`):

  C1 - appsettings.json ownership. R2 (current branch accepts uninstall
       deleting config) plus Task 7's finding (appsettings.json is GENERATED
       by the deferred ConfigureAgentAction, NOT staged from the File
       table - see Files.wxs header + ConfigureAgentAction.cs lines 8-13)
       means MSI's RemoveFiles does NOT delete appsettings.json on uninstall.
       The brief's `'preserves appsettings.json after uninstall (NeverOverwrite)'`
       test is therefore WRONG on this branch - the file persists
       incidentally, NOT because of a NeverOverwrite file-table attribute.
       This test asserts the actual semantics: appsettings.json is present
       after uninstall. A future "uninstall also deletes appsettings.json"
       behaviour belongs in RollbackAgentAction/RemoveAgentService (out of
       scope for this task).

  C2 - INSTALLDIR command-line override. WixUI_InstallDir wixlib binds
       INSTALLDIR to WIXUI_INSTALLDIR via a Type=51 SetProperty CA that
       fires in CostFinalize. Passing `INSTALLDIR=C:\foo` directly on the
       msiexec command line also works (INSTALLDIR is a Public Property
       declared in the linker output and survives into the deferred CA's
       CustomActionData). For belt-and-suspenders, this test passes BOTH
       `INSTALLDIR=...` and `WIXUI_INSTALLDIR=...` so a future wixlib
       change cannot silently re-route the path.

  C3 - no `ServiceAccount` / `SERVICECCOUNT` anywhere (R1 still applies).
       The service runs as LocalSystem via NSSM's `nssm install` default.

  C4 - defensive host gating. The brief's pattern of throwing on a
       missing MSI is preserved as the static fallback: if the MSI is
       missing AND the caller passed `-StaticAnalysisOnly`, we skip; if
       the MSI is missing without that flag, BeforeAll throws so CI
       surfaces the missing artifact loudly.

  C5 - defensive cleanup. Pre-existing service / install dir from a prior
       run are stopped + removed before the test starts, with try/catch
       around the remove so a half-broken prior run does not fail this one.

  C6 - PowerShell 5.1 compatibility (no `??`, no ternary, no 3-arg Join-Path).

  C7 - Pester 6 It-block scope. Pester 6 runs each It block in its own
       ScriptScope (Pester.ScriptScope.ps1). Top-level helper functions
       defined at file scope are NOT visible inside It blocks. The skip
       guard is therefore inlined as `if ($script:SkipReason)
       { Set-ItResult -Skipped -Because $script:SkipReason; return }` at
       the top of every It block, matching the existing repo convention
       in scripts/tests/plugin-system.Tests.ps1.
#>

[CmdletBinding()]
param(
  [string]$MsiPath = (Join-Path -Path $PSScriptRoot -ChildPath '..\agent-installer\bin\x64\Release\zh-CN\addashboard-agent-x64-1.0.0.0.msi'),
  [string]$InstallDir = (Join-Path -Path $env:TEMP -ChildPath 'msi-agent-test'),
  [string]$CenterUrl = 'http://test-center:8081',
  [string]$AgentToken = 'test-token-1234567890abcdef',
  [string]$AgentType = 'ad',
  [string]$LogPath = (Join-Path -Path $env:TEMP -ChildPath 'msi-smoke.log'),
  [string]$ServiceName = 'ADReplicationAgent',
  [switch]$StaticAnalysisOnly
)

BeforeAll {
  $script:MsiPath = $MsiPath
  $script:InstallDir = $InstallDir
  $script:CenterUrl = $CenterUrl
  $script:AgentToken = $AgentToken
  $script:AgentType = $AgentType
  $script:LogPath = $LogPath
  $script:ServiceName = $ServiceName
  $script:StaticAnalysisOnly = [bool]$StaticAnalysisOnly
  $script:SkipReason = $null

  # Resolve the MSI path. Pester does not always chdir before BeforeAll
  # runs, so resolve relative to $PSScriptRoot manually. Fall back through
  # the candidate list (zh-CN language folder is what the current csproj
  # emits; bare bin/Release covers a future cleanup).
  if (-not (Test-Path -LiteralPath $script:MsiPath)) {
    $candidates = @(
      (Join-Path -Path $PSScriptRoot -ChildPath '..\agent-installer\bin\x64\Release\zh-CN\addashboard-agent-x64-1.0.0.0.msi'),
      (Join-Path -Path $PSScriptRoot -ChildPath '..\agent-installer\bin\x64\Release\addashboard-agent-x64-1.0.0.0.msi'),
      (Join-Path -Path $PSScriptRoot -ChildPath '..\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.0.msi')
    )
    foreach ($cand in $candidates) {
      if (Test-Path -LiteralPath $cand) {
        $script:MsiPath = $cand
        break
      }
    }
  }

  if (-not (Test-Path -LiteralPath $script:MsiPath)) {
    if ($script:StaticAnalysisOnly) {
      $script:SkipReason = "MSI artifact not found at '$script:MsiPath' and -StaticAnalysisOnly is set; skipping."
    }
    else {
      throw "MSI artifact not found at '$script:MsiPath'. Build first: pwsh ./installer/build-msi.ps1"
    }
  }
  elseif (-not $script:StaticAnalysisOnly) {
    # Admin check. MSI install + nssm service registration require admin.
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $id
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
      $script:SkipReason = 'Not running as Administrator; msiexec /i cannot register the NSSM service on this host. Re-run on an admin-elevated Windows VM.'
    }
  }

  if ($script:SkipReason) {
    Write-Warning "msi-smoke.Tests.ps1: $script:SkipReason"
  }
  else {
    # Defensive pre-cleanup: a prior run may have left the service + install
    # dir behind. Stop + uninstall + remove - each step wrapped in try/catch
    # so a half-broken prior state does not poison this run.
    if (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue) {
      try {
        sc.exe stop $script:ServiceName | Out-Null
        Start-Sleep -Seconds 2
      } catch { }
      try { sc.exe delete $script:ServiceName | Out-Null } catch { }
    }
    if (Test-Path -LiteralPath $script:InstallDir) {
      try { Remove-Item -LiteralPath $script:InstallDir -Recurse -Force } catch { }
    }
  }
}

Describe 'MSI Agent Installer smoke' {
  It 'installs MSI silently with CENTERURL / AGENTTOKEN / AGENTTYPE / INSTALLDIR' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $quotedMsi  = '"' + $script:MsiPath + '"'
    $quotedLog  = '"' + $script:LogPath + '"'
    $quotedDir  = '"' + $script:InstallDir + '"'
    $argList = @(
      '/i', $quotedMsi,
      '/qn', '/l*v', $quotedLog,
      'INSTALLDIR', $quotedDir,
      'WIXUI_INSTALLDIR', $quotedDir,
      'CENTERURL', $script:CenterUrl,
      'AGENTTOKEN', $script:AgentToken,
      'AGENTTYPE', $script:AgentType
    )
    $p = Start-Process -FilePath msiexec -ArgumentList $argList -Wait -PassThru -NoNewWindow
    $p.ExitCode | Should -Be 0
  }

  It 'creates expected files in INSTALLDIR' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    Join-Path -Path $script:InstallDir -ChildPath 'agent.js'                                 | Should -Exist
    Join-Path -Path $script:InstallDir -ChildPath 'package.json'                            | Should -Exist
    Join-Path -Path $script:InstallDir -ChildPath 'node\node.exe'                            | Should -Exist
    Join-Path -Path $script:InstallDir -ChildPath 'nssm\nssm.exe'                            | Should -Exist
    Join-Path -Path $script:InstallDir -ChildPath 'appsettings.json'                         | Should -Exist
    Join-Path -Path $script:InstallDir -ChildPath 'scripts\collect-replication.ps1'          | Should -Exist
    Join-Path -Path $script:InstallDir -ChildPath 'scripts\collect-discovery.ps1'            | Should -Exist
  }

  It 'constructs node_modules\axios via deferred CA npm install' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    # 2026-08-23: MSI no longer pre-bundles node_modules in Files.wxs.
    # ConfigureAgentAction.RunNpmInstall runs `npm install --omit=dev`
    # after file copy, populating INSTALLDIR/node_modules. We pin a single
    # dep (axios) to confirm real install progress — npm's exit code can be
    # 0 even when it skips work, so the post-check in RunNpmInstall asserts
    # this exact file landed.
    Join-Path -Path $script:InstallDir -ChildPath 'node_modules\axios\package.json' | Should -Exist
  }

  It 'registers NSSM service ADReplicationAgent as Running' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $svc = Get-Service -Name $script:ServiceName -ErrorAction Stop
    $svc.Status | Should -Be 'Running'
  }

  It 'writes appsettings.json with correct keys' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $cfgPath = Join-Path -Path $script:InstallDir -ChildPath 'appsettings.json'
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    $cfg.centerUrl                  | Should -Be $script:CenterUrl
    $cfg.agentToken                 | Should -Be $script:AgentToken
    $cfg.agentType                  | Should -Be $script:AgentType
    $cfg.pollingIntervalMinutes     | Should -Be 15
    $cfg.heartbeatIntervalSeconds   | Should -Be 5
    $cfg.psScriptPath               | Should -BeLike '*\scripts\collect-replication.ps1'
    $cfg.psDiscoveryScriptPath      | Should -BeLike '*\scripts\collect-discovery.ps1'

    $expectedLogDir = Join-Path -Path $script:InstallDir -ChildPath '..\Logs'
    # Resolve to absolute so the qc output strings line up on cross-drive
    # cases (InstallDir = D:\foo\Agent → expectedLogDir = D:\foo\Logs).
    $expectedLogDir = [System.IO.Path]::GetFullPath($expectedLogDir)

    $qcOut = sc.exe qc $script:ServiceName | Out-String
    # NSSM's AppStdout = <LogDir>\ADReplicationAgent-stdout.log via SetNssmParameters.
    $qcOut | Should -Match ([regex]::Escape($expectedLogDir))
  }

  It 'sets NSSM recovery via sc.exe qfailure' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $out = sc.exe qfailure $script:ServiceName | Out-String
    # Windows-level recovery (ConfigureAgentAction.cs:196): reset= 60 actions= restart/5000/restart/10000/restart/30000
    $out | Should -Match 'reset=\s+60'
    $out | Should -Match 'restart'
  }

  It 'uninstalls cleanly and removes the service' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $quotedMsi = '"' + $script:MsiPath + '"'
    $quotedLog = '"' + $script:LogPath + '"'
    $p = Start-Process -FilePath msiexec -ArgumentList @('/x', $quotedMsi, '/qn', '/l*v', $quotedLog) -Wait -PassThru -NoNewWindow
    $p.ExitCode | Should -Be 0
    # Give the SCM a moment to process the delete before we ask for state.
    Start-Sleep -Seconds 2
    Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
  }

  # R2 / Task 7: appsettings.json is GENERATED by the deferred
  # ConfigureAgentAction (CA/ConfigureAgentAction.cs::WriteAppsettingsJson)
  # and is NOT in the MSI File table (Files.wxs header rationale). MSI's
  # built-in RemoveFiles therefore does NOT delete it on uninstall - the
  # file persists on disk. This test asserts that observed behaviour and
  # documents the install-vs-CA ownership semantics in the test name + a
  # single inline comment so a future maintainer does not mistake
  # the word preserved for NeverOverwrite-protected.
  It 'leaves appsettings.json behind after uninstall (CA-owned, NOT NeverOverwrite)' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $cfgPath = Join-Path -Path $script:InstallDir -ChildPath 'appsettings.json'
    $cfgPath | Should -Exist
    # The file content is the install-time snapshot (CENTERURL / AGENTTOKEN
    # / AGENTTYPE) - confirms the uninstall did not silently rewrite it.
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    $cfg.centerUrl | Should -Be $script:CenterUrl

    # Manual cleanup so a re-run starts clean. try/catch so a denied ACL
    # (Windows file lock) does not fail the test after the assertions pass.
    try { Remove-Item -LiteralPath $script:InstallDir -Recurse -Force } catch { }
  }
}