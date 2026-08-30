# kcc-hub-spoke-analyzer.Tests.ps1 — covers scripts/kcc-hub-spoke-analyzer.ps1 (R68)
#
# R68: large AD environment (40 DC / 20 sites) requires Hub-Spoke layered
# replication. This analyzer reads the current AD topology (sites / site
# links / subnets) and outputs a markdown report with:
#   1. Current topology summary
#   2. Per-site-link cost recommendation table
#   3. Hub-Spoke compliance report (flags Spoke↔Spoke violations)
#
# These tests verify the script is parseable, has the right parameters,
# declares the right structure, and runs cleanly under -WhatIf without
# needing the ActiveDirectory module installed.

BeforeAll {
  $scriptPath = "$PSScriptRoot/../kcc-hub-spoke-analyzer.ps1"
  $content     = Get-Content -LiteralPath $scriptPath -Raw
}

Describe 'kcc-hub-spoke-analyzer.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'declares [CmdletBinding()] with the right parameters' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $ast.ParamBlock | Should -Not -BeNullOrEmpty
    $paramNames = $ast.ParamBlock.Parameters.Name.VariablePath.UserPath
    $paramNames | Should -Contain 'OutputPath'
    $paramNames | Should -Contain 'HubSites'
    $paramNames | Should -Contain 'SpokeToSpokeCost'
    $paramNames | Should -Contain 'SpokeToHubCost'
    $paramNames | Should -Contain 'CrossRegionHubCost'
    $paramNames | Should -Contain 'SameRegionHubCost'
    $paramNames | Should -Contain 'WhatIf'
  }

  It 'is read-only (does not call any AD mutator cmdlets)' {
    # The analyzer must NOT modify AD. Banned cmdlets: Set-AD*, New-AD*,
    # Remove-AD*, Disable-AD*, Enable-AD*, Move-AD*, Rename-AD*. We only
    # check for explicit Set-/New-/Remove-/Disable-/Enable-/Move-/Rename-AD
    # starts; Get-AD* is fine.
    $banned = 'Set-AD|New-AD|Remove-AD|Disable-AD|Enable-AD|Move-AD|Rename-AD'
    $content | Should -Not -Match $banned `
      'analyzer must be read-only — mutator cmdlets (Set-AD*, New-AD*, etc.) are not allowed'
  }

  It 'queries the three required AD cmdlets' {
    $content | Should -Match 'Get-ADReplicationSite'        'must enumerate sites'
    $content | Should -Match 'Get-ADReplicationSiteLink'    'must enumerate site links'
    $content | Should -Match 'Get-ADReplicationSubnet'      'must enumerate subnets (for coverage report)'
  }

  It 'has the link-type classifier function' {
    $content | Should -Match 'function Get-LinkType'
    $content | Should -Match "'hub-hub'"
    $content | Should -Match "'spoke-hub'"
    $content | Should -Match "'spoke-spoke'"
  }

  It 'has the recommended-cost function with all 4 cost knobs' {
    $content | Should -Match 'function Get-RecommendedCost'
    $content | Should -Match 'SpokeToSpokeCost'
    $content | Should -Match 'SpokeToHubCost'
    $content | Should -Match 'CrossRegionHubCost'
    $content | Should -Match 'SameRegionHubCost'
  }

  It 'outputs a markdown report (not JSON or XML)' {
    # The report uses | markdown table syntax — must contain the column-header rows
    $content | Should -Match '## 1\. 当前拓扑摘要'
    $content | Should -Match '## 2\. Site-link cost 推荐'
    $content | Should -Match '## 3\. Hub-Spoke 合规报告'
    $content | Should -Match '## 4\. KCC 行为清单'
  }

  It 'flags spoke-spoke violations explicitly' {
    $content | Should -Match '违规'
    $content | Should -Match 'spoke-spoke'
  }

  It 'guards the ActiveDirectory import behind -WhatIf' {
    # Without -WhatIf, the script throws if ActiveDirectory isn't installed.
    # This is the desired behavior — but the import line itself should be
    # inside a WhatIf-guarded block so dry-run still works.
    $content | Should -Match "Import-Module ActiveDirectory"
    $content | Should -Match 'if \(-not \$WhatIf\)'
  }

  It 'runs cleanly under -WhatIf without needing ActiveDirectory module' {
    # The -WhatIf branch must not import the ActiveDirectory module. Smoke
    # test: invoke the script with -WhatIf and check $LASTEXITCODE + the
    # captured stdout/stderr for the "module not installed" error message.
    # Write-Host output goes to the host (not the output stream), so we
    # use *> redirection to a temp file to capture everything.
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
      # Tail the output file to avoid pulling 800+ char previews into the test
      # result on success — we only care about the error path here.
      & $scriptPath -WhatIf *> $tmp 2>&1
      $exitCode = $LASTEXITCODE
      $captured = Get-Content -LiteralPath $tmp -Raw

      $captured | Should -Not -Match 'ActiveDirectory PowerShell 模块未安装' `
        '-WhatIf must not require the ActiveDirectory module'
      # Exit code 0 = success; non-zero from a WhatIf run would indicate a
      # script bug (the user didn't ask it to do anything that could fail).
      # We allow exit code 0 only — any other code is a test failure.
      $exitCode | Should -Be 0 `
        "script should exit 0 under -WhatIf; got $exitCode. Output: $captured"
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }

  It 'defaults the report path to logs/hub-spoke-report-<ts>.md' {
    # The OutputPath default uses Get-Date -Format. Confirm the format string
    # is present + the file path lands under logs/.
    $content | Should -Match "OutputPath\s*="
    $content | Should -Match "Get-Date -Format 'yyyyMMdd"
    $content | Should -Match 'hub-spoke-report-'
    $content | Should -Match 'logs'
  }
}
