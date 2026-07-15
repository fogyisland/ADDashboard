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
