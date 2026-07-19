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

Describe 'smoke-test.ps1 in-place + recovery probes' {
  It 'probes Test-Path on C:\addashboard\Center (in-place guard)' {
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'Test-Path'
    $content | Should -Match 'C:\\addashboard\\Center'
  }

  It 'probes nssm AppExit=Restart and AppRestartDelay=2000' {
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'nssm\s+get\s+ADDashboardCenter\s+AppExit'
    $content | Should -Match 'AppRestartDelay'
    $content | Should -Match "'Restart'"
    $content | Should -Match "'2000'"
  }

  It 'probes sc.exe qfailure ADDashboardCenter for restart + 60' {
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'sc\.exe\s+qfailure\s+ADDashboardCenter'
    # Two Step calls assert presence of 'restart' and '60' substrings in output.
    $restartMatches = [regex]::Matches($content, 'restart')
    $sixtyMatches = [regex]::Matches($content, '(?<![0-9])60(?![0-9])')
    $restartMatches.Count | Should -BeGreaterOrEqual 2
    $sixtyMatches.Count | Should -BeGreaterOrEqual 2
  }
}
