BeforeAll {
  $scriptPath = "$PSScriptRoot/../install-center.ps1"
}

Describe 'install-center.ps1' {
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
    $paramNames | Should -Contain 'InstallPath'
    $paramNames | Should -Contain 'MySqlHost'
    $paramNames | Should -Contain 'MySqlPort'
    $paramNames | Should -Contain 'MySqlDatabase'
    $paramNames | Should -Contain 'MySqlUser'
    $paramNames | Should -Contain 'MySqlPassword'
    $paramNames | Should -Contain 'ListenPort'
    $paramNames | Should -Contain 'AgentToken'
    $paramNames | Should -Contain 'JwtSecret'
  }

  It 'has a default for InstallPath of C:\Program Files\ADDashboard\Center' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $installPathParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallPath' }
    $defaultValue = $installPathParam.DefaultValue.Extent.Text
    $defaultValue | Should -Match 'C:\\Program Files\\ADDashboard\\Center'
  }

  It 'has a default for MySqlPort of 3306' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $portParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'MySqlPort' }
    $defaultValue = $portParam.DefaultValue.Extent.Text
    $defaultValue | Should -Match '3306'
  }
}
