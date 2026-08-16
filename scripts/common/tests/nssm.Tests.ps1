BeforeAll {
  Import-Module "$PSScriptRoot/../Logger.psm1" -Force
  Import-Module "$PSScriptRoot/../NSSM.psm1" -Force
}

Describe 'Set-NssmPath / Get-NssmPath' {
  It 'returns the explicitly set path when Test-Path returns true' {
    Mock -ModuleName NSSM -CommandName Test-Path -MockWith { $true } -ParameterFilter { $Path -eq 'C:\fake\nssm.exe' }
    Set-NssmPath 'C:\fake\nssm.exe'
    $result = Get-NssmPath
    $result | Should -Be 'C:\fake\nssm.exe'
  }

  It 'falls back to candidate paths when Set-NssmPath not called and a candidate exists' {
    # Reset module-level state. Use InModuleScope to set $Script:NssmPath to $null.
    InModuleScope NSSM { $Script:NssmPath = $null }
    Mock -ModuleName NSSM -CommandName Test-Path -MockWith {
      param($Path)
      if ($Path -eq 'C:\Tools\nssm-2.24\win64\nssm.exe') { return $true }
      return $false
    }
    $result = Get-NssmPath
    $result | Should -Be 'C:\Tools\nssm-2.24\win64\nssm.exe'
  }
}

Describe 'Install-NssmService (refresh on existing)' {
  BeforeEach {
    # Capture every Invoke-Nssm call into $script:Calls. Each entry is a string
    # of joined args so Should -Contain assertions read naturally.
    $script:Calls = @()
    Mock -ModuleName NSSM -CommandName Get-NssmPath -MockWith { 'C:\fake\nssm.exe' }
    Mock -ModuleName NSSM -CommandName Invoke-Nssm -MockWith {
      param([string[]]$Arguments)
      $script:Calls +=, ($Arguments -join ' ')
    }
  }

  It 'refreshes NSSM parameters when the service already exists (does NOT call nssm install)' {
    # Regression: real-world bug. Old code did `if (Get-Service ...) { return }`,
    # so re-running install-center against an already-installed service silently
    # skipped every nssm set call. New code skips only the `install` step.
    Mock -ModuleName NSSM -CommandName Get-Service -MockWith { [pscustomobject]@{ Name = 'ADDashboardCenter'; Status = 'Stopped' } }
    Install-NssmService -Name 'ADDashboardCenter' -Application 'C:\node\node.exe' `
      -AppDirectory 'D:\dashboard\center' -AppParameters 'server.js' `
      -DisplayName 'AD Replication Dashboard Center' -Description 'desc' `
      -Start SERVICE_AUTO_START

    # `install` must NOT be in the call list — would error "service already exists".
    ($script:Calls | Where-Object { $_ -match '^(install|set)\s' }) | Should -Not -Contain 'install ADDashboardCenter C:\node\node.exe'

    # Every parameter Set-NssmParameters writes must be present.
    $script:Calls | Should -Contain 'set ADDashboardCenter AppDirectory D:\dashboard\center'
    $script:Calls | Should -Contain 'set ADDashboardCenter AppParameters server.js'
    $script:Calls | Should -Contain 'set ADDashboardCenter DisplayName AD Replication Dashboard Center'
    $script:Calls | Should -Contain 'set ADDashboardCenter Description desc'
    $script:Calls | Should -Contain 'set ADDashboardCenter Start SERVICE_AUTO_START'
    $script:Calls | Should -Contain 'set ADDashboardCenter AppRotateBytes 10485760'
    $script:Calls | Should -Contain 'set ADDashboardCenter AppEnvironmentExtra NODE_ENV=production'
  }

  It 'calls nssm install then refreshes parameters on first install (service absent)' {
    Mock -ModuleName NSSM -CommandName Get-Service -MockWith { $null }
    Install-NssmService -Name 'ADDashboardCenter' -Application 'C:\node\node.exe' `
      -AppDirectory 'D:\dashboard\center' -AppParameters 'server.js' `
      -Start SERVICE_AUTO_START

    # First call must be `install <Name> <Application>`.
    $script:Calls[0] | Should -Be 'install ADDashboardCenter C:\node\node.exe'
    # And parameters still applied.
    $script:Calls | Should -Contain 'set ADDashboardCenter AppDirectory D:\dashboard\center'
    $script:Calls | Should -Contain 'set ADDashboardCenter Start SERVICE_AUTO_START'
  }
}

Describe 'Install-NssmService mirror sync (publish/system/scripts/common/NSSM.psm1)' {
  # Defence against the recurring "fix one, forget the other" failure mode.
  It 'publish mirror contains the same Install-NssmService body' {
    $canon = Get-Content "$PSScriptRoot/../NSSM.psm1" -Raw
    $pub   = Get-Content "$PSScriptRoot/../../../publish/system/scripts/common/NSSM.psm1" -Raw
    # The bug class was "Get-Service → return early". Mirror must contain the
    # fix shape: capture $existed AND call Set-NssmParameters outside the if.
    $canon | Should -Match '\$existed\s*=\s*Get-Service'
    $pub   | Should -Match '\$existed\s*=\s*Get-Service'
    # And the old "skipping install" silent return path must be gone from both.
    $canon | Should -Not -Match 'Service \$Name already installed; skipping install'
    $pub   | Should -Not -Match 'Service \$Name already installed; skipping install'
  }
}
