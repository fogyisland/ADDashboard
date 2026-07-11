BeforeAll {
  $scriptPath = "$PSScriptRoot/../smoke-test.ps1"
}

Describe 'smoke-test.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'declares the expected parameters' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $paramBlock = $ast.ParamBlock
    $paramBlock | Should -Not -BeNullOrEmpty
    $paramNames = $paramBlock.Parameters.Name.VariablePath.UserPath
    $paramNames | Should -Contain 'BaseUrl'
    $paramNames | Should -Contain 'Username'
    $paramNames | Should -Contain 'Password'
  }

  It 'marks Password as Mandatory' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $passwordParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Password' }
    $hasMandatory = $passwordParam.Attributes | Where-Object { $_.Extent.Text -match 'Mandatory' }
    $hasMandatory | Should -Not -BeNullOrEmpty
  }
}
