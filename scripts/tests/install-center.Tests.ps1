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

  It 'Set-ServiceRecovery helper in Service.psm1 sets NSSM AppExit=Restart and AppRestartDelay=2000' {
    $serviceContent = Get-Content (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1') -Raw
    $serviceContent | Should -Match 'AppExit\s+Restart'
    $serviceContent | Should -Match 'AppRestartDelay\s+2000'
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
}
