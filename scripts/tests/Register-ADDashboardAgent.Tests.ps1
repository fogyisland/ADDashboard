BeforeAll {
  $scriptPath = "$PSScriptRoot/../Register-ADDashboardAgent.ps1"
  $content     = Get-Content -LiteralPath $scriptPath -Raw
}

Describe 'Register-ADDashboardAgent.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'writes appsettings.json WITHOUT a UTF-8 BOM (round 8)' {
    # 2026-08-24 round-8: PowerShell 5.1 `Set-Content -Encoding UTF8`
    # writes a UTF-8 BOM (EF BB BF) as the first 3 bytes. Node's
    # JSON.parse rejects those bytes with `SyntaxError: Unexpected
    # token ''` and the agent crashes on startup — operator opened
    # install.log, saw `[STEP]` for node pre-flight, no further lines.
    #
    # The previous form `$cfg | ConvertTo-Json | Set-Content ... -Encoding
    # UTF8` must NOT appear in executable code anymore. The fix is
    # `[IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))`.
    # This test guards the fix at the source — both that the BOM-
    # producing form is gone and that the no-BOM UTF8Encoding call is in.
    $content | Should -Not -Match '(?m)^(?!\s*#).*ConvertTo-Json\s*\|\s*Set-Content' `
      'Write-AppsettingsJson must NOT use `ConvertTo-Json | Set-Content -Encoding UTF8` (writes BOM; crashes Node JSON.parse).'

    $content | Should -Match '\[System\.IO\.File\]::WriteAllText' `
      'Write-AppsettingsJson must use [IO.File]::WriteAllText to avoid piping through Set-Content.'
    $content | Should -Match '\[System\.Text\.UTF8Encoding\]::new\(\$false\)' `
      '[Text.UTF8Encoding]::new($false) = no-BOM encoder (constructor argument is bool $emitBOM).'
  }

  It 'survives a script-level BOM (sanity: no BOM written to disk by the install flow)' {
    # End-to-end-style smoke: extract Write-AppsettingsJson via the AST,
    # define it in the current scope (so its dynamic-variable references
    # resolve to the test's $InstallPath / $CenterUrl / etc.), invoke it,
    # read the produced appsettings.json bytes, and verify the first byte
    # is '{' (0x7B) — NOT the UTF-8 BOM (EF BB BF). Guards against
    # future regressions where someone re-adds a `ConvertTo-Json |
    # Set-Content -Encoding UTF8` pipeline for a new field without
    # noticing the BOM side-effect.
    $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("reg-bom-test-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    try {
      # Pull ALL function definitions out of the script via the AST.
      # Write-AppsettingsJson calls helper functions (Write-ROk / Write-RLog)
      # also defined in the script, so we need to define ALL of them in
      # the test scope, not just Write-AppsettingsJson. We dot-source the
      # text of each FunctionDefinitionAst — this brings the function
      # symbols into the current scope without triggering the script's
      # [CmdletBinding()] param block (which requires -InstallPath etc.)
      # or installing NSSM.
      $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
      $fnAsts = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
      $fnAsts.Count | Should -BeGreaterThan 0 'the script must declare at least one function (otherwise Write-AppsettingsJson is missing).'
      foreach ($fn in $fnAsts) {
        . ([scriptblock]::Create($fn.Extent.Text))
      }

      # Write-AppsettingsJson (and its Write-ROk / Write-RLog helpers)
      # resolve $InstallPath / $CenterUrl / $AgentToken / $AgentType /
      # $LogFile via PowerShell dynamic-variable resolution (caller scope).
      # Set those names directly so the functions see them.
      $InstallPath      = $tmpDir
      $CenterUrl        = 'http://center.test:8080'
      $AgentToken       = 'fake-token-xyz'
      $env:COMPUTERNAME = 'BOMTEST'
      $AgentType        = 'ad'
      # Write-RLog uses $LogFile for Add-Content. Set it here so the
      # helper doesn't try to write to a path that doesn't exist.
      $LogDir  = $tmpDir
      $LogFile = Join-Path $LogDir 'register.log'

      Write-AppsettingsJson
      $jsonPath = Join-Path $InstallPath 'appsettings.json'
      Test-Path -LiteralPath $jsonPath | Should -BeTrue 'Write-AppsettingsJson must have produced appsettings.json'

      # Read raw bytes — first 3 bytes must NOT be the UTF-8 BOM (EF BB BF).
      $bytes = [System.IO.File]::ReadAllBytes($jsonPath)
      if ($bytes.Length -lt 3) {
        throw "appsettings.json too short ($($bytes.Length) bytes) to inspect"
      }
      $isBom = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
      $isBom | Should -BeFalse `
        "appsettings.json must NOT start with UTF-8 BOM (EF BB BF); got first bytes = 0x$('{0:X2}' -f $bytes[0]),0x$('{0:X2}' -f $bytes[1]),0x$('{0:X2}' -f $bytes[2])"

      # First byte (with no BOM present) must be '{' (0x7B) — Node JSON.parse
      # contract: token must start with `{` or `[`.
      $firstJsonByte = if ($isBom) { $bytes[3] } else { $bytes[0] }
      ($firstJsonByte -eq 0x7B) | Should -BeTrue `
        "appsettings.json must start with '{' (0x7B) for Node JSON.parse; got 0x$('{0:X2}' -f $firstJsonByte)."

      # Round-trip through PowerShell's ConvertFrom-Json (same JSON contract
      # Node uses — they share ECMAScript grammar).
      $text = [System.IO.File]::ReadAllText($jsonPath)
      $parsed = $text | ConvertFrom-Json
      $parsed.centerUrl  | Should -Be 'http://center.test:8080'
      $parsed.agentId    | Should -Be 'BOMTEST'
      $parsed.agentToken | Should -Be 'fake-token-xyz'
      $parsed.agentType  | Should -Be 'ad'
    } finally {
      if (Test-Path $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
    }
  }
}
