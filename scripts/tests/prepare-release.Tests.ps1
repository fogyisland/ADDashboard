Describe 'prepare-release.ps1' {
  BeforeAll {
    $script:preparePath = Join-Path (Join-Path $PSScriptRoot '..') 'prepare-release.ps1'
    $script:projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
  }

  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:preparePath, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      throw "Parse errors ($($errors.Count)):`n$($errors | Out-String)"
    }
    $errors.Count | Should -Be 0
  }

  It 'invokes the four sync scripts in the correct order' {
    # Order matters: source-mirror must run before dist (so any new files
    # referenced by dist exist in the mirror), then scripts-mirror, then
    # verify (last so it sees the final state). Verify against content of
    # the script — silent reorder is the failure mode this guards against.
    $content = Get-Content $script:preparePath -Raw
    $srcIdx  = $content.IndexOf('sync-source-mirror.ps1')
    $distIdx = $content.IndexOf('sync-dist.ps1')
    $scrIdx  = $content.IndexOf('sync-scripts-mirror.ps1')
    $verIdx  = $content.IndexOf('verify-mirror.ps1')
    $srcIdx  | Should -BeGreaterThan -1 'sync-source-mirror.ps1 must be referenced'
    $distIdx | Should -BeGreaterThan -1 'sync-dist.ps1 must be referenced'
    $scrIdx  | Should -BeGreaterThan -1 'sync-scripts-mirror.ps1 must be referenced'
    $verIdx  | Should -BeGreaterThan -1 'verify-mirror.ps1 must be referenced'
    $srcIdx  | Should -BeLessThan $distIdx 'source-mirror must run before dist'
    $distIdx | Should -BeLessThan $scrIdx  'dist must run before scripts-mirror'
    $scrIdx  | Should -BeLessThan $verIdx  'scripts-mirror must run before verify'
  }

  It 'does NOT commit, push, or restart NSSM (release prep stages only)' {
    # prepare-release is the "stage and exit" gate. If it ever grows
    # `git commit` / `git push` / `nssm restart`, that's a contract change
    # and must be reviewed (operator policy: NSSM restart is always manual).
    $content = Get-Content $script:preparePath -Raw
    $content | Should -Not -Match 'git\s+commit'
    $content | Should -Not -Match 'git\s+push'
    $content | Should -Not -Match 'nssm\s+restart'
  }

  It 'supports -SkipBuildCheck for debugging' {
    $content = Get-Content $script:preparePath -Raw
    $content | Should -Match '\[switch\]\$SkipBuildCheck'
  }

  It 'exits non-zero on pre-flight failure' {
    # Pre-flight status check that surfaces a stale dist via a non-zero
    # exit code. Verify the contract by reading the exit-code block.
    $content = Get-Content $script:preparePath -Raw
    $content | Should -Match 'exit\s+2' 'pre-flight failure must exit 2'
    $content | Should -Match 'exit\s+1' 'sync-step failure must exit 1'
    $content | Should -Match 'exit\s+0' 'all-pass must exit 0'
  }
}

Describe 'sync-scripts-mirror.ps1 (R88 — no-wipe)' {
  BeforeAll {
    $script:syncScriptsPath = Join-Path (Join-Path $PSScriptRoot '..') 'sync-scripts-mirror.ps1'
  }

  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:syncScriptsPath, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      throw "Parse errors ($($errors.Count)):`n$($errors | Out-String)"
    }
    $errors.Count | Should -Be 0
  }

  It 'does not contain a wipe loop (R88 fix: stop destroying git-tracked dev-only helpers)' {
    # Pre-R88 had:
    #   foreach ($existing in Get-ChildItem ...) {
    #     Remove-Item -LiteralPath $existing.FullName -Force
    #   }
    # That wiped the entire publish/system/scripts/ directory and made every
    # git-tracked dev-only file (build-publish-zip.ps1, kill-server.ps1,
    # verify-mirror.ps1, …) briefly "deleted" between sync and the next
    # `git checkout`. R88 keeps them in place.
    $content = Get-Content $script:syncScriptsPath -Raw
    $content | Should -Not -Match 'Remove-Item\s+-LiteralPath\s+\$existing'
  }

  It 'still syncs the production allow-list into the mirror' {
    # Regression guard: dropping the wipe must NOT also drop the sync.
    $content = Get-Content $script:syncScriptsPath -Raw
    $content | Should -Match 'Copy-Item.*-LiteralPath.*-Destination'
    $content | Should -Match "'install-agent\.ps1'"
    $content | Should -Match "'install-center\.ps1'"
    $content | Should -Match "'fix-build-env\.ps1'"   # R87.1 entry
  }

  It 'still uses robocopy /MIR for scripts/common/ (tests excluded)' {
    $content = Get-Content $script:syncScriptsPath -Raw
    $content | Should -Match "robocopy"
    $content | Should -Match "'/MIR'"
    $content | Should -Match "'/XD', 'tests'"
    $content | Should -Match "'/XF', '\*\.Tests\.ps1'"
  }
}