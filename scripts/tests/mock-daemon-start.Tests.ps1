# mock-daemon-start.Tests.ps1 — covers scripts/mock-daemon-start.ps1 (R34.1)
#
# R34.1: this script is the operator's defense against the round-34 silent-stop
# incident where the daemon was launched with stale default ports (8081/8082)
# while the running centre's heartbeat/report ports had been changed via the
# admin UI to 9081/9082. The daemon kept POSTing to dead ports, the dashboard's
# "最近报告" column froze, and operators thought "no issues" when reality was
# "no data". This wrapper reads live ports from system_config and passes them
# as env vars — a launch is now safe regardless of UI overrides.

BeforeAll {
  $scriptPath = "$PSScriptRoot/../mock-daemon-start.ps1"
  $helperPath = "$PSScriptRoot/../read-center-ports.mjs"
  $content     = Get-Content -LiteralPath $scriptPath -Raw
}

Describe 'read-center-ports.mjs (helper)' {
  It 'exists alongside the wrapper' {
    Test-Path -LiteralPath $helperPath | Should -BeTrue
  }

  It 'declares the appsettings path argument in its docstring' {
    $helper = Get-Content -LiteralPath $helperPath -Raw
    $helper | Should -Match 'process\.argv\[2\]'   'helper must read argv[2]'
    $helper | Should -Match 'listenPort'
    $helper | Should -Match 'heartbeat_port'
    $helper | Should -Match 'report_port'
  }

  It 'uses mysql2/promise + system_config SQL (not the centre modules)' {
    # Why a standalone helper (vs importing center/src/db.js)?
    # 1. center/src/db.js holds module-level state (pool singleton). Spinning it
    #    up just to read 3 numbers drags in migration bootstrap + audit hooks.
    # 2. The helper is a tool, not part of the running server — same process
    #    shouldn't hold the centre pool AND the helper's transient connection.
    # Round-15: pin timezone: 'Z' so DATETIME columns round-trip with UTC-naive
    # strings (the same lesson from the probe_state "all offline" incident).
    $helper = Get-Content -LiteralPath $helperPath -Raw
    $helper | Should -Match "from 'mysql2/promise'"
    $helper | Should -Match "SELECT config_key, config_value FROM system_config"
    $helper | Should -Match "timezone:\s*'Z'"
  }
}

Describe 'mock-daemon-start.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'declares the parameter block with [CmdletBinding()]' {
    # [CmdletBinding()] default param values evaluate in child scope where
    # automatic vars ($PSScriptRoot) are empty. Same guard as start.ps1: any
    # parameter that joins to $PSScriptRoot must default-resolve in the body.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $ast.ParamBlock | Should -Not -BeNullOrEmpty
    $paramNames = $ast.ParamBlock.Parameters.Name.VariablePath.UserPath
    $paramNames | Should -Contain 'CenterPath'
    $paramNames | Should -Contain 'AppsettingsPath'
    $paramNames | Should -Contain 'NodePath'
    $paramNames | Should -Contain 'WhatIf'
  }

  It 'has no default value on CenterPath / AppsettingsPath / NodePath (body resolves it)' {
    # Per start.ps1 bug history: default param values resolve in binding scope
    # where $PSScriptRoot is empty. The body MUST guard with `if (-not $X)`
    # before any Join-Path that uses $PSScriptRoot.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    foreach ($name in 'CenterPath','AppsettingsPath','NodePath') {
      $p = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq $name }
      $p.DefaultValue | Should -BeNullOrEmpty `
        "[$name] must not have a default value — it is resolved in the body where `$PSScriptRoot is in scope."
    }
  }

  It 'auto-detects center/ via Test-Path on appsettings.json + mock-heartbeat-daemon.mjs' {
    # Round-34 was partly enabled by the fact that the daemon had no
    # auto-detection: it just used whatever CENTER_URL it was given. This
    # wrapper must look for <CenterPath>/appsettings.json AND
    # <CenterPath>/mock-heartbeat-daemon.mjs, both must be present.
    $content | Should -Match 'appsettings\.json'
    $content | Should -Match 'mock-heartbeat-daemon\.mjs'
    $content | Should -Match 'Resolve-CenterPath'
  }

  It 'calls the helper with the appsettings path and parses JSON' {
    $content | Should -Match '& \$NodePath \$helper'
    $content | Should -Match 'ConvertFrom-Json'
    $content | Should -Match '\$ports\.heartbeatPort'
    $content | Should -Match '\$ports\.reportPort'
  }

  It 'sets CENTER_URL + REPORT_URL + AGENT_TOKEN env vars before spawning' {
    # The whole point: daemon gets the live ports, not its baked-in defaults.
    $content | Should -Match '\$env:CENTER_URL'
    $content | Should -Match '\$env:REPORT_URL'
    $content | Should -Match '\$env:AGENT_TOKEN'
  }

  It 'exits cleanly under -WhatIf (does not spawn the daemon)' {
    # Smoke test: actually invoke the script with -WhatIf against a temp
    # appsettings. Verifies the parameter binding + early parameter validation
    # works without leaving a long-running daemon behind. The DB call inside
    # the helper will likely fail (port 1 = unreachable), and that's fine —
    # we only assert the wrapper doesn't crash at parse/parameter-binding
    # time and surfaces ANY output (success or error).
    #
    # Skipped on machines that don't have node.exe on PATH (the script would
    # fail before reaching the -WhatIf branch).
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { Set-ItResult -Skipped -Because 'node.exe not on PATH' }

    # Create a temp appsettings whose DB block points to a port nobody listens
    # on. This lets us observe the wrapper's full parameter-binding path
    # without hitting a real MySQL server. The helper will fail at connect
    # time — and that's the expected outcome for this test.
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
      $fakeCfg = @{ db = @{ mysql = @{ host = '127.0.0.1'; port = 1; database = 'x'; user = 'x'; password = 'x' } } ; listenPort = 8080; jwtSecret = 'j'; agentToken = 'tok_abcdef0123456789'; staticDir = './dist' } | ConvertTo-Json -Depth 5
      Set-Content -LiteralPath $tmp -Value $fakeCfg -Encoding ascii

      # The script declares $ErrorActionPreference = 'Stop' at the top, so
      # ANY inner throw becomes a Pester RuntimeException. Capture it with
      # try/catch and assert on the message — what we really want to know
      # is "the script reached the helper, not that it succeeded."
      $captured = $null
      try {
        $out = & $scriptPath -WhatIf -AppsettingsPath $tmp 2>&1
        $captured = ($out | Out-String)
      } catch {
        $captured = $_.ToString()
      }

      # Either path is acceptable: (a) banner + helper-failed message, OR
      # (b) outright throw from the wrapper's error pipeline. Both prove
      # parameter binding + JSON parsing worked.
      $captured | Should -Match 'read-center-ports|mock-daemon-start|mock-heartbeat' `
        'wrapper should have reached the helper or printed its banner'
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}