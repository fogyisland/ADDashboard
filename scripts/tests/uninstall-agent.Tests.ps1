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

  It 'refuses to delete install dir when it equals the green-package source dir (Windows case-collision)' {
    # 2026-08-23: Green package layout places source at <root>/agent and
    # default install at <root>/Agent. On Windows case-insensitive FS,
    # those collapse to one directory. A bare Remove-Item -Recurse -Force
    # on the install path would nuke the green package (including the
    # uninstall script itself — operator couldn't re-uninstall). Detect
    # the collision before deleting and skip the removal, leaving the
    # package on disk. The service was already unregistered above, so the
    # operator's intent (stop the agent) is satisfied.
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'Resolve-Path\s+-LiteralPath\s+\$InstallPath' `
      'uninstall-agent.ps1 must Resolve-Path $InstallPath to detect case-collision.'
    $content | Should -Match 'OrdinalIgnoreCase' `
      'case-collision check must use OrdinalIgnoreCase (Windows FS is case-insensitive).'
    $content | Should -Match 'leaving green package on disk' `
      'when src==dst, uninstall must log that it is leaving the package (operator needs to see why no rm happened).'
    # Remove-Item must live inside the elseif (case-collision gate) branch,
    # not at the top level. The regex looks for the elseif branch immediately
    # preceding the Remove-Item line — if it does, the deletion is gated.
    $content | Should -Match 'elseif\s*\(\s*Test-Path\s+\$InstallPath\s*\)\s*\{[\s\S]{0,80}Remove-Item\s+-Path\s+\$InstallPath\s+-Recurse\s+-Force' `
      'Remove-Item on $InstallPath must be inside an elseif branch gated by Test-Path (case-collision takes the if-branch).'
  }
}
