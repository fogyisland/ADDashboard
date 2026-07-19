Describe 'install-center (slimmed)' {
  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      throw "Parse errors ($($errors.Count)):`n$($errors | Out-String)"
    }
    $errors.Count | Should -Be 0
  }

  It 'does not accept DB-side params' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Not -Match '\-DbDialect'
    $content | Should -Not -Match '\-DbHost'
  }

  It 'mentions /init wizard' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match '/init'
  }
}

Describe 'install-center -InPlace switch' {
  It 'accepts -InPlace switch' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match '\[switch\]\$InPlace'
  }

  It 'overrides InstallPath when -InPlace is set' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    # When InPlace is set, InstallPath must resolve to <projectRoot>\center, not C:\addashboard\Center.
    # Match the branch: if -not $InPlace use param default; else override.
    $content | Should -Match 'if\s*\(\s*\$InPlace\s*\)\s*\{'
    $content | Should -Match '\$projectRoot.{0,5}''center'''
  }

  It 'still copies files when -InPlace is NOT set (regression guard)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    # Copy-Item must still exist (production install path unchanged).
    $content | Should -Match 'Copy-Item'
  }
}

Describe 'install-center service recovery' {
  It 'calls Set-ServiceRecovery helper (single source of truth)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match 'Set-ServiceRecovery\s+-Name\s+''ADDashboardCenter'''
  }

  It 'Set-ServiceRecovery helper in Service.psm1 sets NSSM AppExit Default Restart and AppRestartDelay=2000' {
    $serviceContent = Get-Content (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1') -Raw
    # NSSM 2.24 `AppExit` requires the sub-parameter form `<exit_code|Default> <action>` —
    # "Default Restart" means restart the service on ANY exit code. Bare `AppExit Restart`
    # is rejected with "Parameter \"AppExit\" requires a subparameter!".
    $serviceContent | Should -Match 'AppExit\s+Default\s+Restart'
    $serviceContent | Should -Match 'AppRestartDelay\s+2000'
  }

  It 'Set-ServiceRecovery helper uses AppExit sub-parameter form "Default Restart" (NSSM 2.24 contract)' {
    # Regression guard: this is the THIRD real-world NSSM bug caught by external
    # install runs (after `AppExitAction` invalid param and `Start 2` enum code).
    # In every prior case the existing regex-based Pester assertion matched the
    # wrong substring. The bare `AppExit Restart` form was never actually invoked
    # against a live nssm.exe. Now we explicitly REQUIRE the sub-parameter form
    # and FORBID the bare form, plus assert mirror sync.
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $serviceContent = Get-Content $servicePath -Raw
    # Required: the corrected sub-parameter form must be present.
    $serviceContent | Should -Match 'AppExit\s+Default\s+Restart' `
      'Service.psm1 must call `nssm set Name AppExit Default Restart` (sub-parameter form required by NSSM 2.24).'
    # Forbidden: bare form must NOT appear as a pipe+Out-Null pattern.
    $serviceContent | Should -Not -Match 'AppExit\s+Restart\s*\|\s*Out-Null' `
      'Service.psm1 must NOT call bare `nssm set Name AppExit Restart` — NSSM 2.24 rejects this with "AppExit requires a subparameter!".'
    # Mirror sync.
    $publishPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\scripts\common') 'Service.psm1'
    $publishContent = Get-Content $publishPath -Raw
    $publishContent | Should -Match 'AppExit\s+Default\s+Restart' `
      'publish/scripts/common/Service.psm1 mirror out of sync — must contain "AppExit Default Restart".'
  }

  It 'Set-ServiceRecovery helper in Service.psm1 configures Windows Service Recovery via sc.exe failure' {
    $serviceContent = Get-Content (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1') -Raw
    $serviceContent | Should -Match 'sc\.exe\s+failure\s+\$Name'
    $serviceContent | Should -Match 'reset=\s*60'
    $serviceContent | Should -Match 'restart/5000/restart/10000/restart/30000'
    # Mirror sync: publish/scripts/common/Service.psm1 must contain the same strings.
    $publishServiceContent = Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\scripts\common') 'Service.psm1') -Raw
    $publishServiceContent | Should -Match 'sc\.exe\s+failure\s+\$Name'
    $publishServiceContent | Should -Match 'reset=\s*60'
    $publishServiceContent | Should -Match 'restart/5000/restart/10000/restart/30000'
  }

  It 'Install-NssmService passes NSSM Start enum name (not the numeric 2)' {
    # NSSM rejects `nssm set X Start 2` with "Invalid startup type '2'. Valid types are: SERVICE_AUTO_START, ...".
    # Guard: every call site must pass the enum NAME; the helper's default must also be the enum name.
    $helperPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'NSSM.psm1'
    $helperContent = Get-Content $helperPath -Raw
    $helperContent | Should -Match '\[ValidateSet\(.SERVICE_AUTO_START.,.SERVICE_DELAYED_AUTO_START.,.SERVICE_DEMAND_START.,.SERVICE_DISABLED.\)\]'
    $helperContent | Should -Match '\[string\]\$Start\s*=\s*.SERVICE_AUTO_START.'
    $helperContent | Should -Not -Match '\[int\]\$Start\s*=\s*2'

    foreach ($script in @('install-center.ps1','install-agent.ps1')) {
      $scriptPath = Join-Path (Join-Path $PSScriptRoot '..') $script
      $content = Get-Content $scriptPath -Raw
      $content | Should -Not -Match '\-Start\s+2\b'  "Numeric -Start 2 in $script fails NSSM; use -Start SERVICE_AUTO_START."
      $content | Should -Match '\-Start\s+SERVICE_AUTO_START'  "$script must pass the enum name."

      # Mirror sync
      $publishScript = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\scripts') $script
      $pub = Get-Content $publishScript -Raw
      $pub | Should -Match '\-Start\s+SERVICE_AUTO_START'  "publish/$script mirror out of sync."
    }
  }

  It 'NSSM.psm1 owns its $Script:LogDir (modules cannot read caller script-scope variables)' {
    # Module functions resolve $Script:LogDir in their OWN module scope, not
    # the caller's script scope. The previous layout had install-center.ps1
    # setting $Script:LogDir in its own scope and NSSM.psm1 reading it from
    # inside Set-NssmParameters — which silently returned $null and crashed
    # later as a Join-Path '-Path' binding error. Guard: NSSM.psm1 must
    # own the state via Set-NssmLogDir, and every install script must call it.
    $nssmPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'NSSM.psm1'
    $nssmContent = Get-Content $nssmPath -Raw
    $nssmContent | Should -Match '\$Script:LogDir\s*=.*addashboard.*Logs' `
      'NSSM.psm1 must seed its own $Script:LogDir at module load.'
    $nssmContent | Should -Match 'function Set-NssmLogDir' `
      'NSSM.psm1 must export a Set-NssmLogDir setter for callers to push updates.'
    $nssmContent | Should -Not -Match 'requires Logger.psm1' `
      'Drop the old "requires Logger first" comment block — the indirection
      through Logger.psm1 `$Script:` was the root cause of the binding error.'

    foreach ($script in @('install-center.ps1','install-agent.ps1')) {
      $scriptPath = Join-Path (Join-Path $PSScriptRoot '..') $script
      $content = Get-Content $scriptPath -Raw
      $content | Should -Match 'Set-NssmLogDir' `
        "$script must call Set-NssmLogDir to push the log dir into NSSM module scope."

      # Mirror sync
      $publishScript = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\scripts') $script
      $pub = Get-Content $publishScript -Raw
      $pub | Should -Match 'Set-NssmLogDir'  "publish/$script mirror out of sync."
    }
  }

  It 'center server.js catches uncaughtException and unhandledRejection with fatal log + exit(1)' {
    # Without these traps, NSSM-restarted services that crash in <1500 ms
    # produce no stderr trace because pino's default async buffer drains
    # after process.exit(). These handlers + the sync destination together
    # guarantee any fatal exit lands a line on stderr before exit.
    foreach ($tree in @('center','publish\center')) {
      $serverPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') $tree) 'server.js'
      $content = Get-Content $serverPath -Raw
      $content | Should -Match "process\.on\('uncaughtException'" `
        "$tree/server.js must register an uncaughtException trap."
      $content | Should -Match "process\.on\('unhandledRejection'" `
        "$tree/server.js must register an unhandledRejection trap."
      $content | Should -Match 'process\.exit\(1\)' `
        "$tree/server.js fatal traps must terminate with exit 1."
    }
    # Logger must use a sync destination. We can't read the runtime
    # destination object directly, so we assert the literal is present.
    foreach ($tree in @('center','publish\center','agent','publish\agent')) {
      $loggerPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') $tree) 'src\logger.js'
      $content = Get-Content $loggerPath -Raw
      $content | Should -Match 'pino\.destination\(' `
        "$tree/src/logger.js should use pino.destination(...)."
      $content | Should -Match 'sync:\s*true' `
        "$tree/src/logger.js must opt in to sync writes."
    }
  }
}
