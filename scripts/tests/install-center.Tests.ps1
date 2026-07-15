Describe 'install-center (slimmed)' {
  It 'has AST-clean syntax' {
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\..\install-center.ps1", [ref]$null, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      $details = ($errors | ForEach-Object { "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)" }) -join "`n"
      throw "Parse errors:`n$details"
    }
    $errors.Count | Should -Be 0
  }

  It 'does not accept DB-side params' {
    $content = Get-Content "$PSScriptRoot\..\install-center.ps1" -Raw
    $content | Should -Not -Match '\-DbDialect'
    $content | Should -Not -Match '\-DbHost'
  }

  It 'mentions /init wizard' {
    $content = Get-Content "$PSScriptRoot\..\install-center.ps1" -Raw
    $content | Should -Match '/init'
  }
}
