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
