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

  It 'excludes Logs/ from the source copy (avoids overwriting open install.log)' {
    # 2026-08-23: Logger.psm1 opens <InstallPath>/Logs/install.log for write
    # before install-agent.ps1 runs. If the source agent/ directory also
    # contains a Logs/installer.log or similar from a previous local run,
    # Copy-Item -Force would try to overwrite the open file and fail with
    # "Cannot use item to overwrite itself". Excluding Logs/ keeps the
    # install.log intact and lets the agent create its own runtime logs
    # after install.
    $content = Get-Content $scriptPath -Raw
    $copyLine = ($content -split "`n" | Where-Object { $_ -match 'Copy-Item.*AgentSrc.*\*.*-Destination.*\$InstallPath' }) | Select-Object -First 1
    $copyLine | Should -Not -BeNullOrEmpty 'install-agent.ps1 must have a Copy-Item for source → install path.'
    $copyLine | Should -Match "'Logs'" `
      'Copy-Item -Exclude MUST include Logs/ — otherwise the open install.log gets overwritten and Copy-Item throws.'
  }

  It 'skips code copy when source and install path resolve to the same directory (Windows case-collision)' {
    # 2026-08-23: Green package layout places source at <root>/agent and
    # default install at <root>/Agent. On Windows case-insensitive FS,
    # those collapse to the same directory and Copy-Item refuses to
    # overwrite files with themselves — even with -Exclude Logs, the next
    # file in the enumeration (e.g. scripts/collect-discovery.ps1) hits
    # the same error. Detect the collision by comparing Resolve-Path
    # outputs and skip the copy entirely. npm install + service
    # registration still run.
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'Resolve-Path\s+-LiteralPath\s+\$AgentSrc' `
      'install-agent.ps1 must Resolve-Path $AgentSrc to detect case-collision.'
    $content | Should -Match 'OrdinalIgnoreCase' `
      'case-collision check must use OrdinalIgnoreCase (Windows FS is case-insensitive).'
    $content | Should -Match 'skipping code copy' `
      'when src==dst, install-agent.ps1 must log a skip message (operator needs to see why no copy happened).'
    $content | Should -Match '\$srcEqDst\s*=\s*\$resolvedSrc\s*-and\s*\$resolvedDst\s*-and' `
      'guard pattern: store collision boolean in $srcEqDst — both Copy-Item branches gate on it.'
  }

  It 'gates BOTH Copy-Item calls behind the case-collision check' {
    # 2026-08-23 (round 2): the recursive Copy-Item (logs/ scripts/*) is
    # gated, but the single-file Copy-Item for collect-replication.ps1 must
    # ALSO be gated — otherwise it tries to copy the file onto itself when
    # src==dst and throws the same error on the very next line.
    $content = Get-Content $scriptPath -Raw
    # Both Copy-Item statements must live inside the if/else where the
    # else-branch is `$srcEqDst`. The simplest invariant: there is NO
    # `Copy-Item` line at the script's top-level after the case-collision
    # if-block. Concretely, find the case-collision check and assert the
    # next non-comment PowerShell statement is a Copy-Item (the else branch).
    $collisionIdx = $content.IndexOf('[StringComparison]::OrdinalIgnoreCase')
    $collisionIdx | Should -BeGreaterOrEqual 0
    $postCollision = $content.Substring($collisionIdx)
    $postCollision | Should -Match 'else\s*\{' `
      'case-collision must have an else branch with Copy-Item.'
    $postCollision | Should -Match 'Copy-Item.*PsScriptSrc|Copy-Item.*collect-replication\.ps1' `
      'single-file Copy-Item for collect-replication.ps1 must be inside the else branch.'
  }

  It 'also gates the Node refresh branch behind the case-collision check (no self-wipe)' {
    # 2026-08-23 (round 3): even with both Copy-Item calls gated, the Node
    # refresh branch had a `Remove-Item $nodeDst -Recurse -Force` that, in
    # the case-collision case (src==dst), would wipe the bundled <green>/node/
    # BEFORE robocopy could mirror it. Result: $node gets reset to a now-
    # missing node.exe and the install breaks at NSSM launch. Gate the Node
    # refresh on $srcEqDst as well.
    $content = Get-Content $scriptPath -Raw
    $content | Should -Match 'src==dst.*skipping Node refresh|skipping Node refresh' `
      'Node refresh must be skipped when src==dst (otherwise Remove-Item wipes the bundled node).'
    # Specifically: Remove-Item $nodeDst must live inside an elseif branch
    # gated by `Test-Path $bundledSrc` — NOT at the top level. If the top-
    # level form returns, the case-collision gate is bypassed.
    $content | Should -Not -Match '(?ms)^if\s*\(\s*Test-Path\s+\$bundledSrc\s*\)\s*\{[\s\S]{0,80}Remove-Item\s+\$nodeDst' `
      'Remove-Item $nodeDst must NOT be the first statement of a bare `if (Test-Path $bundledSrc)` block — that runs even when src==dst.'
  }

  It 'invokes npm.cmd by absolute path (not bare `npm` on PATH)' {
    # 2026-08-23 (round 4): Real install run on KDLWXOFADSRV1 hit
    # "npm: not recognized" even though the bundled <green>/node/npm.cmd was
    # prepended to PATH. PowerShell's PATH resolution for `npm` missed the
    # .cmd file in some way (likely PATHEXT + PowerShell session state
    # interaction). The robust fix: invoke `& $nodeDst/npm.cmd ...`
    # directly, bypassing PowerShell's command lookup entirely. npm.cmd
    # internally resolves node.exe via %~dp0 (same dir), so ABI parity with
    # NSSM's registered node.exe is guaranteed without depending on PATH.
    $content = Get-Content $scriptPath -Raw
    # The script must build $npmCmd = "$nodeDst/npm.cmd" and Test-Path it.
    $content | Should -Match '\$npmCmd\s*=\s*Join-Path\s+\$nodeDst\s+''npm\.cmd''' `
      'script must compute $npmCmd from $nodeDst (absolute path) instead of relying on PATH-resolved `npm`.'
    $content | Should -Match 'Test-Path\s+-LiteralPath\s+\$npmCmd' `
      'script must Test-Path -LiteralPath $npmCmd before invoking (fail loud if the bundled Node install is incomplete).'
    # Bare `npm install` must NOT exist as an executable call (must be
    # `& $npmCmd install`). Exclude comment lines (start with optional
    # whitespace + #) so doc comments mentioning "npm install" don't trip.
    # Multiline mode for line-start anchors.
    $content | Should -Not -Match '(?m)^(?!\s*#)\s*\bnpm\s+install' `
      'script must NOT call bare `npm install` (must use `& $npmCmd install`). Comments are allowed.'
  }
}
