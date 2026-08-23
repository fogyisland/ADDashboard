BeforeAll {
  $scriptPath = "$PSScriptRoot/../upgrade-agent.ps1"
  $content     = Get-Content -LiteralPath $scriptPath -Raw
}

Describe 'upgrade-agent.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'declares the unified-entry parameters' {
    # -InstallPath: agent install root (C:\addashboard\Agent\) — same convention
    #              as install-agent.ps1 + Register-ADDashboardAgent.ps1.
    # -ComputerName: optional; auto-defaults to $env:COMPUTERNAME for local
    #                interactive first-time install. Operators pass it for
    #                remote / batch upgrades.
    # -CenterUrl + -AgentToken: optional; prompted via Read-Host when missing
    #                during a first-time install. The script stays automation-
    #                friendly for WinRM / scheduled jobs by accepting them
    #                on the command line.
    # -AgentType: 'ad' (default) | 'non-ad' — T16 discriminator.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $paramBlock = $ast.ParamBlock
    $paramBlock | Should -Not -BeNullOrEmpty
    $paramNames = $paramBlock.Parameters.Name.VariablePath.UserPath
    $paramNames | Should -Contain 'InstallPath'
    $paramNames | Should -Contain 'ComputerName'
    $paramNames | Should -Contain 'CenterUrl'
    $paramNames | Should -Contain 'AgentToken'
    $paramNames | Should -Contain 'AgentType'
  }

  It 'resolves InstallPath from $PSScriptRoot (no [CmdletBinding()] default that would be evaluated in child scope)' {
    # Bug fixed 2026-08-16: [CmdletBinding()] default param values evaluate in
    # parameter binding scope (child of script scope); automatic variables like
    # $PSScriptRoot are only set in script scope → empty in defaults → Join-Path
    # '..' fails with empty Path. Guard: (a) InstallPath param has NO default
    # value, (b) body resolves the default in script scope via an if-guard.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $installPathParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallPath' }
    $installPathParam.DefaultValue | Should -BeNullOrEmpty `
      '[CmdletBinding()] default param values evaluate in child scope where $PSScriptRoot is empty; default must be resolved in the body.'
    $content | Should -Match 'if\s*\(\s*-not\s+\$InstallPath\s*\)' `
      'body must guard with `if (-not $InstallPath)` to resolve the default in script scope.'
    $content | Should -Match 'Join-Path.*Agent' `
      'body must Join-Path to the Agent subdirectory (script-relative install root).'
    $content | Should -Not -Match 'C:\\addashboard\\Agent' `
      'script must not hardcode C:\addashboard\Agent — must be script-relative.'
  }

  It 'auto-detects install state via Get-Service ADReplicationAgent' {
    # The script's whole point is to do "install if missing, update if present"
    # automatically. The detection must be the canonical service-registered
    # check (not file-presence at $InstallPath) because file presence is
    # ambiguous after a partial install.
    $content | Should -Match 'Get-Service\s+-Name\s+\$ServiceName' `
      'script must probe service registration via Get-Service -Name $ServiceName (canonical detection).'
    $content | Should -Match "'ADReplicationAgent'" `
      'service name must match the MSI / green-package contract — ADReplicationAgent.'
  }

  It 'prompts for CenterUrl + AgentToken interactively on first-time install' {
    # User-facing requirement (2026-08-23): when the script detects no service
    # is registered AND the operator didn't pass -CenterUrl/-AgentToken, it
    # prompts in the PowerShell terminal so a single `.\upgrade-agent.ps1`
    # works without parameter bookkeeping.
    #
    # Token MUST be -AsSecureString so it doesn't echo on screen. Conversion
    # back to plain text is required because Register-ADDashboardAgent.ps1
    # writes appsettings.json in plain text (same boundary applies whether
    # the token came from Read-Host or from a script parameter).
    $content | Should -Match 'Read-Host\s+\x27Enter CenterUrl' `
      'first-time install must prompt for CenterUrl via Read-Host when -CenterUrl not passed.'
    $content | Should -Match 'Read-Host\s+-AsSecureString\s+\x27Enter AgentToken' `
      'first-time install must prompt for AgentToken via Read-Host -AsSecureString (no echo).'
    $content | Should -Match 'SecureStringToBSTR' `
      'SecureString must be converted back to plain text at the script boundary (appsettings.json stores it as plain text).'
    $content | Should -Match 'ZeroFreeBSTR' `
      'BSTR must be zero-freed to avoid leaving the token in process memory longer than needed.'
  }

  It 'delegates first-time install to install-agent.ps1 (no duplication)' {
    # The script's value is dispatching to the right existing flow. First-time
    # install goes through install-agent.ps1 → Register-ADDashboardAgent.ps1
    # (single registration entry point). We do NOT inline the SCM-facing
    # logic here.
    $content | Should -Match 'install-agent\.ps1' `
      'first-time path must invoke install-agent.ps1 (delegates the SCM-facing work).'
    # The script DOES mention `appsettings.json` in the Copy-Item -Exclude list
    # (preserve the live token during hot-update), so we can't assert "no
    # mention". We assert no WRITE pattern (ConvertTo-Json | Set-Content) and
    # no Register-ADDashboardAgent.ps1 import — those would mean the script
    # is duplicating SCM logic instead of delegating.
    $content | Should -Not -Match 'ConvertTo-Json\s*\|\s*Set-Content' `
      'upgrade-agent.ps1 must NOT write appsettings.json via ConvertTo-Json | Set-Content — that lives in Register-ADDashboardAgent.ps1.'
    $content | Should -Not -Match 'Register-ADDashboardAgent\.ps1' `
      'upgrade-agent.ps1 must NOT invoke Register-ADDashboardAgent.ps1 directly — install-agent.ps1 owns that delegation. Two-hop dispatch keeps the contract clean.'
  }

  It 'always restarts on hot update (no hash-skip)' {
    # Per 2026-08-23 design: hot-update path unconditionally stop → copy →
    # npm install → start. Hash-skip was considered and rejected (stale lockfile
    # risk on partial installs outweighs the npm-install savings; operators
    # who run upgrade-agent expect something to actually update).
    $content | Should -Match 'Stop-Service\s+-Name\s+\$ServiceName' `
      'hot-update must stop the service via Stop-Service (not via NSSM stop).'
    $content | Should -Match 'npm install --omit=dev --no-audit --no-fund' `
      'hot-update must always run npm install --omit=dev (no hash-skip gate).'
    $content | Should -Match 'Start-Service\s+-Name\s+\$ServiceName' `
      'hot-update must start the service via Start-Service.'
  }
}