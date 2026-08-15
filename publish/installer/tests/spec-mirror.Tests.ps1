<#
.SYNOPSIS
  Spec-mirror drift test: ensures the C# CA's NSSM parameters match the PS1
  installer's NSSM parameters. Both install paths (MSI deferred custom action
  and scripts/install-agent.ps1) must converge on identical service
  configuration.

.DESCRIPTION
  Two sources of truth for the same NSSM service config:

    1. installer/agent-installer/CA/ConfigureAgentAction.cs
       SetNssmParameters() -> RunNssmSet(nssm, "Key", value)
    2. scripts/common/NSSM.psm1  Set-NssmParameters()
       scripts/common/Service.psm1 Set-ServiceRecovery()
       -> Invoke-Nssm @('set', $Name, 'Key', value)

  This test regex-extracts the parameter KEY from each call site and asserts
  the C# key set is a SUPERSET of the PS1 key set. Rationale: the MSI is the
  newer path; it may legitimately set extra keys the PS1 installer does not.
  It must never set FEWER, because a service installed by MSI would then be
  configured more weakly than one installed by the script.

  This is a static-source-analysis test. It does not touch the registry, run
  nssm.exe, or require admin - it runs anywhere, including CI.

.NOTES
  Deviations from task-10-brief.md, and why:

  D1 - FILENAME. The brief says `installer/tests/spec-mirror-tests.ps1`.
       Renamed to `spec-mirror.Tests.ps1` so Pester 5/6 default discovery
       (`*.Tests.ps1`) finds it, matching the existing repo convention
       (installer/tests/msi-smoke.Tests.ps1, scripts/tests/*.Tests.ps1).
       A bare `-tests.ps1` suffix is invisible to `Invoke-Pester -Path <dir>`.

  D2 - DROPPED the brief's `Where-Object { $_ -ne 'AppEnvironmentExtra' }`
       filter on the C# key set. The brief's inline comment claims "PS1
       doesn't set this either" - that is STALE. NSSM.psm1:96 does set
       AppEnvironmentExtra (NODE_ENV=production), and Task 4 added the
       matching RunNssmSet call at ConfigureAgentAction.cs:181. Keeping the
       filter would strip the key from the C# side only, leaving it present
       on the PS1 side, and the test would report a FALSE drift
       ("missing in CA: AppEnvironmentExtra") on a branch where both sides
       agree. Verified empirically: without the filter both sets are the
       same 12 keys and missingInCa is empty; with the filter the test fails.
       No exclusion list is needed at all, so none is kept - an empty
       allow-list is the strongest form of this assertion.

  D3 - ADDED a second It block asserting both extracted key sets are
       non-empty. Regex-based source scraping has one dominant failure mode:
       a refactor renames `RunNssmSet` or reformats the call site, the regex
       matches nothing, `$missingInCa` is trivially empty, and the test
       passes forever while asserting nothing. The guard turns that silent
       no-op into a loud failure. It does not widen the drift check's scope.

  D4 - ADDED comment stripping before key extraction. Found while performing
       the brief's Step 3 red-green check: the brief tells you to verify the
       test by COMMENTING OUT a RunNssmSet call, but with a raw-text regex
       that does not fail - `// RunNssmSet(nssm, "AppRotateFiles", "1");`
       still matches, so the test reported parity for a call that no longer
       runs. That is a false-green in the exact scenario the brief uses as
       its proof of life, and a realistic rot path (disable a line while
       debugging, forget to restore). Both sources are now run through a
       comment stripper whose regex alternation matches string literals
       first and keeps them verbatim, so a `//` inside a URL literal or a
       `#` inside a PowerShell string is not mistaken for a comment.
       After the fix the Step 3 check goes red as intended.

  R1 (pre-authorized) - no ServiceAccount / SERVICECCOUNT key on either
       side. The C# CA deliberately sets no ObjectName (LocalSystem is
       nssm install's default, matching install-agent.ps1). This test must
       not introduce one.

  C7 (parked for whole-branch review) - REGEX SCOPE. Both regexes are
       intentionally limited to the SIMPLE call form, per the brief:
         C# side : RunNssmSet(nssm, "Key", ...)   -- excludes RunNssmSetMulti
         PS1 side: Invoke-Nssm @('set', $Name, 'Key', ...)  -- array form only
       Consequence: the AppExit / AppRestartDelay pair set by
       ConfigureAgentAction.SetServiceRecovery (RunNssmSetMulti, lines
       192-193) and by Service.psm1 Set-ServiceRecovery (direct invocation
       `& $nssm set $Name AppExit Default Restart`, lines 41 + 43) are NOT
       covered by this parity check. Both sides currently DO set them
       identically - see the source comments cross-referencing each other -
       so there is no live drift today, but the test would not catch it if
       one side dropped them. Widening the two regexes to also match
       `RunNssmSetMulti(` and `& $nssm set $Name Key` is a deliberate
       follow-up decision, flagged to the whole-branch reviewer rather than
       taken unilaterally here.

  PowerShell 5.1 + pwsh 7+ compatible: no null-coalescing (??), no ternary
  (? :), no 3-arg Join-Path. Tested against Pester 6.0.0 on the dev box.

  ASCII-only inside regex strings and messages (an em-dash in a regex
  literal trips the Windows PowerShell 5.1 parser on re-read).
#>

[CmdletBinding()]
param()

BeforeAll {
  $repoRoot = Resolve-Path (Join-Path -Path $PSScriptRoot -ChildPath '..\..')
  $caSource  = Join-Path -Path $repoRoot -ChildPath 'installer\agent-installer\CA\ConfigureAgentAction.cs'
  $psModule  = Join-Path -Path $repoRoot -ChildPath 'scripts\common\NSSM.psm1'
  $svcModule = Join-Path -Path $repoRoot -ChildPath 'scripts\common\Service.psm1'

  foreach ($src in @($caSource, $psModule, $svcModule)) {
    if (-not (Test-Path -LiteralPath $src)) {
      throw "spec-mirror source not found: $src"
    }
  }

  $script:CaSource  = $caSource
  $script:PsModule  = $psModule
  $script:SvcModule = $svcModule

  # D4: strip comments before extracting keys. Without this, a call site that
  # someone COMMENTED OUT still matches the extraction regex and the test
  # reports parity that no longer exists at runtime. That is the single most
  # likely way this drift check silently rots (temporarily disable a line
  # while debugging, forget to restore), so it must be handled.
  #
  # The alternation matches STRING LITERALS FIRST and the evaluator returns
  # them verbatim; only comment matches are replaced with empty. This is the
  # standard scanner-ordering trick and is what protects a `//` inside a URL
  # string literal (or a `#` inside a PowerShell string) from being treated
  # as the start of a comment.
  $keepStringsDropComments = [System.Text.RegularExpressions.MatchEvaluator]{
    param($m)
    $c = $m.Value[0]
    if ($c -eq '"' -or $c -eq "'" -or $c -eq '@') { return $m.Value }
    return ''
  }

  # C# side: every RunNssmSet(nssm, "Key", ...) call. `RunNssmSet\(` will not
  # match `RunNssmSetMulti(` because the literal `(` must follow immediately
  # (see note C7 above for why Multi is out of scope).
  # Comment forms stripped: @"verbatim" / "regular" strings kept, /* block */
  # and // line comments dropped.
  $caContent = Get-Content -LiteralPath $caSource -Raw
  $caContent = [regex]::Replace($caContent, '@"(?:[^"]|"")*"|"(?:\\.|[^"\\])*"|/\*[\s\S]*?\*/|//[^\r\n]*', $keepStringsDropComments)
  $script:CaKeys = @(
    [regex]::Matches($caContent, 'RunNssmSet\(\s*nssm\s*,\s*"([^"]+)"') |
      ForEach-Object { $_.Groups[1].Value } |
      Sort-Object -Unique
  )

  # PS1 side: every Invoke-Nssm @('set', $Name, 'Key', ...) call across both
  # modules (concatenated so one regex pass covers them).
  # Comment forms stripped: <# block #> and # line comments dropped, single-
  # and double-quoted strings kept (the keys themselves live in 'quotes').
  $psContent = (Get-Content -LiteralPath $psModule -Raw) + "`n" + (Get-Content -LiteralPath $svcModule -Raw)
  $psContent = [regex]::Replace($psContent, "<#[\s\S]*?#>|'[^'\r\n]*'|`"[^`"\r\n]*`"|#[^\r\n]*", $keepStringsDropComments)
  $script:PsKeys = @(
    [regex]::Matches($psContent, "Invoke-Nssm\s+@\('set',\s*\`$\w+\s*,\s*'([^']+)'") |
      ForEach-Object { $_.Groups[1].Value } |
      Sort-Object -Unique
  )

  Write-Verbose ("CA keys ({0}): {1}"  -f $script:CaKeys.Count, ($script:CaKeys -join ', '))
  Write-Verbose ("PS1 keys ({0}): {1}" -f $script:PsKeys.Count, ($script:PsKeys -join ', '))
}

Describe 'NSSM spec mirror between MSI CA and install-agent.ps1' {

  # D3: guard against the regexes silently matching nothing. Without this,
  # renaming RunNssmSet would make the drift test below pass vacuously.
  It 'extracts a non-empty NSSM key set from both sources' {
    $script:CaKeys.Count | Should -BeGreaterThan 0 -Because "the RunNssmSet(nssm, ...) regex found no calls in $script:CaSource - either the helper was renamed/reformatted or the file moved. Fix the regex, do not delete this test."
    $script:PsKeys.Count | Should -BeGreaterThan 0 -Because "the Invoke-Nssm @('set', ...) regex found no calls in $script:PsModule + $script:SvcModule - either the call form changed or the modules moved. Fix the regex, do not delete this test."
  }

  It 'C# CA nssm set keys are a superset of PS1 nssm set keys' {
    # PS1 may have keys C# doesn't, but C# must include all PS1 keys.
    $missingInCa = @($script:PsKeys | Where-Object { $script:CaKeys -notcontains $_ })
    $missingInCa | Should -BeNullOrEmpty -Because "ConfigureAgentAction.SetNssmParameters must set every NSSM parameter that Set-NssmParameters (scripts/common/NSSM.psm1) sets, or an MSI-installed service is configured more weakly than a script-installed one. Missing in CA: $($missingInCa -join ', '). Fix: add the matching RunNssmSet(nssm, 'Key', value) call to ConfigureAgentAction.cs."
  }
}
