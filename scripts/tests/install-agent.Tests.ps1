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

  It 'always runs npm install --omit=dev (not conditional on shipped node_modules)' {
    # 2026-08-23: User reported the published green package contained build files
    # but no node_modules. The canonical install path now always runs npm install
    # on the target machine — even though the green package ships node_modules as
    # a baseline — to guarantee production-only deps resolved against the target's
    # Node version. Guard: an unconditional `npm install --omit=dev` exists, AND
    # the prior conditional gate `if (-not (Test-Path node_modules))` is gone.
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'npm\s+install\s+--omit=dev' `
      'install-agent.ps1 must run `npm install --omit=dev` to construct node_modules on the target.'
    $content | Should -Not -Match 'if\s*\(\s*-not\s+\(Test-Path\s+\(Join-Path\s+\$InstallPath\s+''node_modules''\)\)\)\s*\{[^}]*npm\s+install' `
      'the conditional `if (-not (Test-Path node_modules)) { npm install }` gate must NOT exist — npm install is unconditional now.'
  }

  It 'probes bundled Node.js first (green-package layout, no PATH pre-req)' {
    # 2026-08-23: green package now bundles Node 20 LTS at <green>/node/.
    # install-agent.ps1 must probe the bundled node first so air-gapped
    # targets don't fail on a missing PATH entry. Resolution order:
    #   1. <green>/node/node.exe — bundled (green-package layout)
    #   2. <InstallPath>/node/node.exe — already-copied by a prior install
    #   3. node.exe on PATH — operator-installed fallback (legacy, pre-bundling)
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'bundledGreenNode' `
      'install-agent.ps1 must probe <green>/node/node.exe first (green-package bundled Node).'
    $content | Should -Match 'bundledInstalledNode' `
      'install-agent.ps1 must probe <InstallPath>/node/node.exe second (already-installed node).'
    $content | Should -Match 'Get-Command\s+node\.exe' `
      'install-agent.ps1 must fall back to PATH-resolved node.exe when no bundled node exists.'
  }

  It 'copies bundled Node.js to <InstallPath>\node\ during install (NSSM launches from there)' {
    # 2026-08-23: install-agent.ps1 must mirror <green>/node/ → <InstallPath>/node/
    # so NSSM can launch <InstallPath>\node\node.exe agent.js with no PATH
    # dependency on the target. robocopy /MIR is idempotent.
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'robocopy\s+\$bundledSrc\s+\$nodeDst\s+/MIR' `
      'install-agent.ps1 must mirror bundled <green>/node/ → <InstallPath>/node/ via robocopy /MIR.'
    # After copying, the NSSM-registered NodePath must point at the install-path copy,
    # not the source-tree one (else the running service would break if the source
    # tree is moved or deleted after install).
    $content | Should -Match '\$node\s*=\s*Join-Path\s+\$nodeDst\s+''node\.exe''' `
      'after copying bundled Node, $node must be updated to point at <InstallPath>/node/node.exe for NSSM.'
  }
}
