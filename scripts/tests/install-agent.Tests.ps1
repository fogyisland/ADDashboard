BeforeAll {
  $scriptPath = "$PSScriptRoot/../install-agent.ps1"
}

Describe 'install-agent.ps1' {
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
    $paramNames | Should -Contain 'ComputerName'
    $paramNames | Should -Contain 'CenterUrl'
    $paramNames | Should -Contain 'AgentToken'
    $paramNames | Should -Contain 'InstallPath'
  }

  It 'resolves InstallPath from $PSScriptRoot (no [CmdletBinding()] default that would be evaluated in child scope)' {
    # Bug fixed 2026-08-16: [CmdletBinding()] default param values evaluate in parameter
    # binding scope (child of script scope); automatic variables like $PSScriptRoot are
    # only set in script scope → empty in defaults → Join-Path '..' fails with empty Path.
    # Guard: (a) InstallPath param has NO default value, (b) body resolves the default
    # in script scope via an if-guard.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $installPathParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallPath' }
    $installPathParam.DefaultValue | Should -BeNullOrEmpty `
      '[CmdletBinding()] default param values evaluate in child scope where $PSScriptRoot is empty; default must be resolved in the body.'
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'if\s*\(\s*-not\s+\$InstallPath\s*\)' `
      'body must guard with `if (-not $InstallPath)` to resolve the default in script scope.'
    $content | Should -Match 'Join-Path.*Agent' `
      'body must Join-Path to the Agent subdirectory (script-relative install root).'
    $content | Should -Not -Match 'C:\\addashboard\\Agent' `
      'script must not hardcode C:\addashboard\Agent — must be script-relative.'
  }
}
