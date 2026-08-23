<#
.SYNOPSIS
  Pester tests for Register-ADDashboardAgent.ps1.

.DESCRIPTION
  Static-analysis + AST coverage for the single SCM-facing entry point that
  install-agent.ps1 + uninstall-agent.ps1 both delegate to. The script is
  self-contained (no .psm1 imports), takes -InstallPath/-CenterUrl/-
  AgentToken/-AgentType, and dispatches on -Action (Register|Unregister).

  These tests run WITHOUT admin (no real NSSM/SCM calls) so they work on the
  dev box and in CI. Runtime / behavior coverage lives in msi-smoke.Tests.ps1
  (the install end-to-end test).

  PowerShell 5.1 + pwsh 7+ compatible: no null-coalescing (??), no ternary
  (? :), no 3-arg Join-Path.

.NOTES
  Design points:

  R1 - Self-contained: Register-ADDashboardAgent.ps1 must NOT import
       common/Logger.psm1 / NSSM.psm1 / Service.psm1. The point of the
       script is to be a single grep target; module deps would re-create
       the prior duplication.

  R2 - Replaces the missing Set-ServiceRecovery: install-agent.ps1 used
       to skip this (it called Install-NssmService but never Set-ServiceRecovery),
       so green-package installs lacked the sc.exe failure recovery that
       the MSI's ConfigureAgentAction.SetServiceRecovery always set. The
       consolidation closes that gap; the test pins the sc.exe + NSSM AppExit
       calls so a future "refactor" can't quietly drop them.

  R3 - Symmetric Register/Unregister: same script handles both. Unregister
       ignores CenterUrl/AgentToken (they're empty when uninstall-agent.ps1
       invokes it); Register requires them. The test guards the validation
       branch.
#>

[CmdletBinding()]
param()

BeforeAll {
  # Resolve $ScriptPath inside BeforeAll where $PSScriptRoot points at the
  # test file (default param values run before $PSScriptRoot is set, so we
  # cannot rely on it for path resolution at parameter binding time).
  $script:Path = Join-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '..\..\scripts') -ChildPath 'Register-ADDashboardAgent.ps1'
  if (-not (Test-Path -LiteralPath $script:Path)) {
    throw "Register-ADDashboardAgent.ps1 not found at '$script:Path'."
  }
  $script:Content = Get-Content -LiteralPath $script:Path -Raw
  $script:Tokens = $null
  $script:Errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($script:Path, [ref]$script:Tokens, [ref]$script:Errors)

  $script:installPath = Join-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '..\..\scripts') -ChildPath 'install-agent.ps1'
  $script:installContent = Get-Content -LiteralPath $script:installPath -Raw

  $script:uninstallPath = Join-Path -Path (Join-Path -Path $PSScriptRoot -ChildPath '..\..\scripts') -ChildPath 'uninstall-agent.ps1'
  $script:uninstallContent = Get-Content -LiteralPath $script:uninstallPath -Raw
}

Describe 'Register-ADDashboardAgent.ps1' {
  It 'has AST-clean syntax (PS 5.1 + pwsh 7+ parse)' {
    $script:Errors.Count | Should -Be 0
  }

  It 'declares the four install-time parameters with the correct constraints' {
    # -InstallPath, -CenterUrl, -AgentToken: required by the install flow.
    # -AgentType: validated against 'ad' / 'non-ad' so non-ad agents get the
    # right DisplayName/Description.
    $script:Content | Should -Match '\[Parameter\(Mandatory\)\]\[string\]\$InstallPath' `
      '-InstallPath must be [Parameter(Mandatory)] so callers cannot accidentally omit it.'
    $script:Content | Should -Match '\[string\]\$CenterUrl' `
      '-CenterUrl must be present (validated inside the Register branch, see R3).'
    $script:Content | Should -Match '\[string\]\$AgentToken' `
      '-AgentToken must be present (validated inside the Register branch).'
    # NOTE: no space between ',' and 'non-ad' — PowerShell literal is 'ad','non-ad'.
    $script:Content | Should -Match '\[ValidateSet\(.ad.,.non-ad.\)\]' `
      '-AgentType must ValidateSet ad | non-ad; agents using a typo would otherwise write bad appsettings.json.'
  }

  It 'dispatches Register / Unregister via switch ($Action)' {
    # Single-quoted regex: `\$` and `\)` stay literal. Double-quoted `"..."` strips the backslash
    # from `\$` AND then sees the following identifier as a variable reference, dropping it.
    $script:Content | Should -Match 'switch \(\$Action\)' `
      'single switch dispatcher is the documented entry shape.'
    $script:Content | Should -Match "'Register'" `
      'Register branch must exist.'
    $script:Content | Should -Match "'Unregister'" `
      'Unregister branch must exist (used by uninstall-agent.ps1).'
  }

  It 'validates CenterUrl + AgentToken inside the Register branch (R3)' {
    # PowerShell cannot make a parameter Mandatory only when -Action is
    # Register; we validate inside the branch instead. The IsNullOrWhiteSpace
    # calls + throw keep the contract tight for callers who pass empty
    # strings (e.g. uninstall-agent.ps1 -Action Unregister with CenterUrl='').
    $script:Content | Should -Match 'IsNullOrWhiteSpace\(\$CenterUrl\)' `
      'Register branch must validate CenterUrl is non-empty before writing appsettings.json.'
    $script:Content | Should -Match 'IsNullOrWhiteSpace\(\$AgentToken\)' `
      'Register branch must validate AgentToken is non-empty before writing appsettings.json.'
  }

  It 'writes appsettings.json with the keys the agent process expects' {
    # agent/src/config.js loadConfig reads these keys. A regression here
    # would silently break the agent at runtime.
    foreach ($key in @('centerUrl','agentId','agentToken','logLevel',
                       'pollingIntervalMinutes','heartbeatIntervalSeconds',
                       'discoveryIntervalHours','queueDbPath','psScriptPath',
                       'psDiscoveryScriptPath','healthCheckIntervalMs','agentType')) {
      $script:Content | Should -Match ([regex]::Escape($key)) `
        "appsettings.json must include key '$key' that agent/src/config.js loadConfig reads."
    }
    # agentId is derived from $env:COMPUTERNAME, never the caller-supplied
    # value — operators can't impersonate another host by passing agentId.
    # NOTE: SINGLE quotes around the regex — double quotes would interpolate
    # $env:COMPUTERNAME to the actual hostname and the test would silently
    # match the wrong thing.
    $script:Content | Should -Match 'agentId\s*=\s*\$env:COMPUTERNAME' `
      'appsettings.json agentId must be derived from $env:COMPUTERNAME (hostname of the install target).'
  }

  It 'sets the 12 NSSM parameters that the agent service needs' {
    # Mirrors what MSI's ConfigureAgentAction.SetNssmParameters + the green
    # package's Install-NssmService used to do. A future "simplification"
    # that drops one would silently break logging / rotation / dependencies.
    $expected = @(
      'AppDirectory',
      'AppParameters',
      'DisplayName',
      'Description',
      'Start',
      'DependOnService',
      'AppStdout',
      'AppStderr',
      'AppRotateFiles',
      'AppRotateOnline',
      'AppRotateBytes',
      'AppEnvironmentExtra'
    )
    foreach ($p in $expected) {
      $script:Content | Should -Match ([regex]::Escape("'$p'")) `
        "nssm set ... $p ... must be present (was in the prior MSI + green package paths)."
    }
    # NODE_ENV=production is the agent's only required env var.
    $script:Content | Should -Match 'NODE_ENV=production' `
      'NODE_ENV=production must be passed via AppEnvironmentExtra to match install-agent.ps1 pre-split behavior.'
    # DependOnService must include DNS Client + Netlogon (pre-req for AD).
    $script:Content | Should -Match 'DNS Client,Netlogon' `
      'DependOnService must include DNS Client + Netlogon (AD pre-reqs; matches MSI path).'
  }

  It 'sets service recovery (NSSM AppExit + sc.exe failure) — R2 critical fix' {
    # The green package used to SKIP this step; install-agent.ps1 called
    # Install-NssmService but never Set-ServiceRecovery. The MSI's
    # ConfigureAgentAction.SetServiceRecovery always set it. The
    # consolidation closes that gap.
    $script:Content | Should -Match "'AppExit'" `
      "NSSM AppExit must be set ('Default Restart' on NSSM 2.24 — bare 'AppExit Restart' is rejected)."
    $script:Content | Should -Match "'Default'" `
      "NSSM AppExit must use the sub-parameter form 'Default Restart'."
    $script:Content | Should -Match "'AppRestartDelay'" `
      'NSSM AppRestartDelay (2000ms) must be set to match the pre-split green package + MSI behavior.'
    $script:Content | Should -Match 'sc\.exe' `
      'sc.exe failure command must be present (Windows-level recovery).'
    $script:Content | Should -Match 'reset=' `
      "sc.exe failure syntax 'reset= 60' requires a SPACE after '='; missing space would silently break recovery."
    $script:Content | Should -Match 'restart/5000/restart/10000/restart/30000' `
      'sc.exe failure actions must use the 5s/10s/30s restart escalation matching MSI.'
  }

  It 'starts the service after Register, with retry loop (Start-ServiceRegistration)' {
    $script:Content | Should -Match 'Start-Service -Name \$ServiceName' `
      'Register branch must call Start-Service to bring the agent online.'
    $script:Content | Should -Match 'Start-ServiceRegistration' `
      'Register branch must invoke the Start-ServiceRegistration helper (Start + 20s retry loop).'
  }

  It 'unregisters via nssm remove (Stop + nssm remove confirm)' {
    # File invokes `& $NssmPath remove $ServiceName confirm`. Match the
    # pattern with $NssmPath as the launcher (NOT the bare word "nssm",
    # which would also match a comment that mentions nssm).
    $script:Content | Should -Match '\$NssmPath remove \$ServiceName confirm' `
      "Unregister branch must run 'nssm remove <svc> confirm' to drop the service registration."
  }

  It 'is self-contained (no .psm1 imports — R1)' {
    # Import-Module lines would re-introduce the prior duplication where
    # install-agent.ps1 + uninstall-agent.ps1 imported different modules
    # of the same name. If a future change needs a helper, inline it instead.
    $script:Content | Should -Not -Match 'Import-Module' `
      'Register-ADDashboardAgent.ps1 must NOT Import-Module anything (single-grep-target contract).'
    $script:Content | Should -Not -Match 'common\\Logger\.psm1' `
      'Must not import common/Logger.psm1 (inline the Write-* helpers).'
    $script:Content | Should -Not -Match 'common\\NSSM\.psm1' `
      'Must not import common/NSSM.psm1 (inline the nssm resolution + invoke).'
    $script:Content | Should -Not -Match 'common\\Service\.psm1' `
      'Must not import common/Service.psm1 (inline Start-/Stop-Service helpers).'
  }

  It 'resolves nssm.exe from the canonical paths (INSTALLDIR\nssm + green-package $PSScriptRoot\nssm + publish\system\nssm)' {
    # Three layout candidates the script must enumerate in its $candidates list:
    #   1. $InstallPath\nssm\nssm.exe — MSI install layout (ConfigureAgentAction.cs
    #      ships nssm alongside the agent at <InstallDir>\nssm\).
    #   2. $PSScriptRoot\nssm\nssm.exe — GREEN PACKAGE layout (build-green-package.ps1
    #      stages nssm at <green>/nssm/, with Register-… at <green>/Register-…).
    #   3. $PSScriptRoot\..\publish\system\nssm\nssm.exe — DEV TREE (running from
    #      <project>/scripts/Register-… during local debugging).
    #
    # PowerShell single-quoted string: `\\` is two literal backslashes. Regex
    # `\\` matches one literal backslash. So `'nssm\\nssm\.exe'` becomes the
    # regex `nssm\\nssm\.exe` which matches the file's literal `nssm\nssm.exe`
    # (Join-Path joins the prefix with the candidate literal, so the source
    # carries only one separator — the script doesn't inline three `nssm`
    # segments).
    $script:Content | Should -Match 'nssm\\nssm\.exe' `
      'Must search $InstallPath\nssm\nssm.exe first (MSI install layout).'
    $script:Content | Should -Match 'publish\\system\\nssm' `
      'Must also search publish\system\nssm\nssm.exe as a dev-tree fallback.'
    # Green-package candidate: Register-… at <green>/ + nssm at <green>/nssm/.
    # The candidate literal is `(Join-Path $PSScriptRoot 'nssm\nssm.exe')` —
    # the file's literal text is `$PSScriptRoot 'nssm\nssm.exe'` (one backslash).
    $script:Content | Should -Match '\$PSScriptRoot\s+\x27nssm\\nssm\.exe\x27' `
      'Must also search $PSScriptRoot\nssm\nssm.exe (green-package layout where Register-… is at <green>/ root).'
  }

  It 'resolves Node.js from INSTALLDIR\node + green-package $PSScriptRoot\node + PATH (R4)' {
    # 2026-08-23: green package bundles Node 20 LTS at <green>/node/. After
    # install-agent.ps1 copies it to <InstallPath>\node\, Register-… must
    # resolve the install-path copy first so the running service launches
    # from the install path (no dependency on the source tree staying put).
    # Falls back to <green>/node/node.exe if called from the green package
    # before install (rare but possible in manual Register-only flows), then
    # to PATH as the legacy pre-bundling fallback.
    #
    # Single-quoted regex matches one literal backslash per `\\` in the
    # pattern (Pester regex matches PowerShell string escapes 1:1 here).
    $script:Content | Should -Match 'node\\node\.exe' `
      'Must search <InstallPath>\node\node.exe first (post-install bundled Node).'
    $script:Content | Should -Match '\$PSScriptRoot\s+\x27node\\node\.exe\x27' `
      'Must also search <green>/node/node.exe (green-package pre-install layout).'
    $script:Content | Should -Match 'Get-Command\s+node\.exe' `
      'Must fall back to PATH-resolved node.exe (legacy operator-installed case).'
  }

  It 'agentType-specific DisplayName / Description (T16 contract)' {
    # 'ad' (default) keeps the legacy 'AD Replication Agent (on <host>)' string
    # so operators with alerts / dashboards keyed on it don't break.
    # 'non-ad' gets the 'Member' label visible in services.msc.
    # File uses PowerShell double-quote interpolation: "AD Replication Agent (on $env:COMPUTERNAME)"
    # not single-quote concatenation. The regex below matches the interpolation form.
    $script:Content | Should -Match 'AD Replication Agent \(on \$env:COMPUTERNAME' `
      "ad DisplayName must be 'AD Replication Agent (on <host>)' (legacy contract)."
    $script:Content | Should -Match "'AD Dashboard Agent \(Member\)'" `
      "non-ad DisplayName must be 'AD Dashboard Agent (Member)' (T16 distinction)."
    $script:Content | Should -Match "'AD Dashboard member-server monitor" `
      "non-ad Description must reference member-server monitor role."
  }
}

Describe 'install-agent.ps1 delegates to Register-ADDashboardAgent.ps1' {
  It 'invokes Register-ADDashboardAgent.ps1 with the install-time params' {
    $script:installContent | Should -Match 'Register-ADDashboardAgent\.ps1' `
      'install-agent.ps1 must delegate to Register-ADDashboardAgent.ps1.'
    $script:installContent | Should -Match '-InstallPath\s+\$InstallPath' `
      '-InstallPath must be forwarded.'
    $script:installContent | Should -Match '-CenterUrl\s+\$CenterUrl' `
      '-CenterUrl must be forwarded.'
    $script:installContent | Should -Match '-AgentToken\s+\$AgentToken' `
      '-AgentToken must be forwarded.'
    $script:installContent | Should -Match '-AgentType\s+\$AgentType' `
      '-AgentType must be forwarded.'
  }

  It 'no longer writes appsettings.json inline (consolidated into Register)' {
    # Before the split, install-agent.ps1 had a ConvertTo-Json | Set-Content
    # block building appsettings.json. After the split that logic lives in
    # Register-ADDashboardAgent.ps1; install-agent.ps1 should NOT have it.
    $script:installContent | Should -Not -Match 'ConvertTo-Json \| Set-Content -Path.*appsettings\.json' `
      'appsettings.json write must be removed from install-agent.ps1 (moved into Register-ADDashboardAgent.ps1).'
  }

  It 'no longer calls Install-NssmService directly (consolidated into Register)' {
    $script:installContent | Should -Not -Match 'Install-NssmService' `
      'Install-NssmService must be removed from install-agent.ps1 (Register-ADDashboardAgent.ps1 owns the NSSM install).'
  }

  It 'no longer calls Start-ServiceSafe directly' {
    $script:installContent | Should -Not -Match 'Start-ServiceSafe' `
      'Start-ServiceSafe must be removed from install-agent.ps1 (Register-ADDashboardAgent.ps1 starts the service).'
  }
}

Describe 'uninstall-agent.ps1 delegates to Register-ADDashboardAgent.ps1 -Action Unregister' {
  It 'invokes Register-ADDashboardAgent.ps1 with -Action Unregister' {
    $script:uninstallContent | Should -Match 'Register-ADDashboardAgent\.ps1' `
      'uninstall-agent.ps1 must delegate to Register-ADDashboardAgent.ps1.'
    $script:uninstallContent | Should -Match '-Action\s+Unregister' `
      '-Action Unregister must be passed so the script enters the Unregister branch.'
  }

  It 'no longer imports common/Service.psm1 (NSSM remove is in Register)' {
    $script:uninstallContent | Should -Not -Match 'common\\Service\.psm1' `
      'Service.psm1 was used for Remove-ServiceSafe; that logic is now in Register-ADDashboardAgent.ps1.'
  }

  It 'no longer calls Remove-ServiceSafe directly' {
    $script:uninstallContent | Should -Not -Match 'Remove-ServiceSafe' `
      'Remove-ServiceSafe must be removed from uninstall-agent.ps1 (Register-ADDashboardAgent.ps1 owns NSSM remove).'
  }
}