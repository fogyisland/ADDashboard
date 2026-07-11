BeforeAll {
  $scriptPath = "$PSScriptRoot/../uninstall-agent.ps1"
}

Describe 'uninstall-agent.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'declares InstallPath and RemoveData parameters' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $paramBlock = $ast.ParamBlock
    $paramBlock | Should -Not -BeNullOrEmpty
    $paramNames = $paramBlock.Parameters.Name.VariablePath.UserPath
    $paramNames | Should -Contain 'InstallPath'
    $paramNames | Should -Contain 'RemoveData'
  }

  It 'has a default for InstallPath of C:\Program Files\ADDashboard\Agent' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $installPathParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallPath' }
    $defaultValue = $installPathParam.DefaultValue.Extent.Text
    $defaultValue | Should -Match 'C:\\Program Files\\ADDashboard\\Agent'
  }
}
