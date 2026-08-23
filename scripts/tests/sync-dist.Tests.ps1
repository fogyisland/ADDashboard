Describe 'sync-dist.ps1' {
  BeforeAll {
    $script:syncPath = Join-Path (Join-Path $PSScriptRoot '..') 'sync-dist.ps1'
    $script:srcDist  = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'center/dist'
    $script:dstDist  = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish/system/center') 'dist'
  }

  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:syncPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'throws when source dist is missing' {
    # Negative test: ensure the script surfaces a clear error rather than
    # silently creating an empty mirror if `npm run build:web` was skipped.
    # The 2026-08-22 morning 500-error root cause was a forgotten dist
    # sync — this test pins the loud-failure behavior so a future refactor
    # cannot quietly regress to silent no-op.
    #
    # Use a fresh temp project root: copy the script to <tmp>/scripts/ and
    # run it. The script computes $projectRoot = $PSScriptRoot/.., so when
    # it runs from <tmp>/scripts/, it looks for <tmp>/center/dist which
    # we deliberately do not create. A throw with the expected message
    # surfaces as a non-zero exit code from the powershell.exe subprocess
    # (PowerShell `&` does not propagate child exceptions; we check
    # $LASTEXITCODE instead of Should -Throw).
    $tmpRoot = Join-Path $env:TEMP ("sync-dist-test-{0}" -f [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $tmpScripts = Join-Path $tmpRoot 'scripts'
    $null = New-Item -ItemType Directory -Path $tmpScripts -Force
    $tmpScript = Join-Path $tmpScripts 'sync-dist.ps1'
    Copy-Item $script:syncPath $tmpScript
    try {
      $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmpScript 2>&1
      $LASTEXITCODE | Should -Not -Be 0 'sync-dist.ps1 must fail when source dist is missing'
      ($output -join "`n") | Should -Match 'source dist missing' `
        'sync-dist.ps1 must surface a clear error message when center/dist is missing.'
    } finally {
      Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It 'is idempotent (running twice with same source produces no error)' {
    # Smoke test against the real source — sync-dist is dot-sourced from
    # build-publish-zip.ps1 every time it runs, so it MUST be safe to
    # call repeatedly without state issues.
    if (-not (Test-Path $script:srcDist)) {
      Set-ItResult -Skipped -Because 'center/dist not present; run npm run build:web first'
      return
    }
    { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:syncPath } | Should -Not -Throw
    { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:syncPath } | Should -Not -Throw
  }

  It 'is dot-sourced from build-publish-zip.ps1 (build→sync→zip is unbreakable)' {
    # Guard against a future refactor that drops the sync-dist call from
    # build-publish-zip. Without this lock, publish.zip can ship a stale
    # dist again.
    $buildZipPath = Join-Path (Join-Path $PSScriptRoot '..') 'build-publish-zip.ps1'
    $content = Get-Content $buildZipPath -Raw
    $content | Should -Match 'sync-dist\.ps1' `
      'build-publish-zip.ps1 must dot-source sync-dist.ps1 so the build→sync→zip chain is unbreakable.'
  }
}
