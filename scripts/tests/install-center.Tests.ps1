Describe 'install-center (slimmed)' {
  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      throw "Parse errors ($($errors.Count)):`n$($errors | Out-String)"
    }
    $errors.Count | Should -Be 0
  }

  It 'does not accept DB-side params' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Not -Match '\-DbDialect'
    $content | Should -Not -Match '\-DbHost'
  }

  It 'mentions /init wizard' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match '/init'
  }
}

Describe 'install-center -InPlace switch' {
  It 'accepts -InPlace switch' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match '\[switch\]\$InPlace'
  }

  It 'overrides InstallPath when -InPlace is set' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    # When InPlace is set, InstallPath must resolve to <projectRoot>\center (script-relative).
    # Match the branch: if -not $InPlace use param default; else override.
    $content | Should -Match 'if\s*\(\s*\$InPlace\s*\)\s*\{'
    $content | Should -Match '\$projectRoot.{0,5}''center'''
  }

  It 'still copies files when -InPlace is NOT set (regression guard)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    # Copy-Item must still exist (production install path unchanged).
    $content | Should -Match 'Copy-Item'
  }
}

Describe 'install-center web UI build dependencies (fresh publish bundle)' {
  # Bug fixed 2026-08-16: in-place branch ran `npm run build` from center/web/
  # but fresh publish bundle has no center/node_modules → `vite build` failed
  # with "'vite' is not recognized as an internal or external command".
  # Non-in-place branch had the same gap (relied on root node_modules existing;
  # fresh publish bundle doesn't have one). Guard: both branches must check
  # node_modules and install before running the build.
  # 2026-08-22 update (center+frontend workspace merge): install guard now
  # installs <InstallPath>/node_modules (via Ensure-CenterNodeModules) instead
  # of frontend/node_modules (which no longer exists), and the build invocation
  # became `npm run build:web --workspace=center`. Strings and regex updated
  # accordingly.
  BeforeAll {
    $script:installCenterPath = Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'
    $script:publishInstallCenterPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'install-center.ps1'
    $script:srcContent = Get-Content $script:installCenterPath -Raw
    $script:pubContent = Get-Content $script:publishInstallCenterPath -Raw
  }

  It 'in-place branch installs center/node_modules before npm run build:web' {
    # `npm run build:web --workspace=center` runs `vite build`, which needs
    # the vite binary. Fresh publish bundle has no center/node_modules, so
    # the install must happen before the build is attempted. The actual
    # check is inside Ensure-CenterNodeModules against $InstallPath/node_modules.
    $script:srcContent | Should -Match 'installing center node_modules' `
      'in-place branch must log "installing center node_modules" when missing (via Ensure-CenterNodeModules).'
    # The install guard must appear BEFORE the actual build invocation in the
    # in-place branch. Match the command line specifically (`try { npm run
    # build:web --workspace=center }`) so the comments above the call don't
    # false-match.
    $buildIdx = $script:srcContent.IndexOf('try { npm run build:web --workspace=center }')
    $installIdx = $script:srcContent.IndexOf('installing center node_modules')
    $buildIdx | Should -BeGreaterThan -1 'in-place build command line must exist'
    $installIdx | Should -BeGreaterThan -1 'center install guard must exist'
    $installIdx | Should -BeLessThan $buildIdx `
      'center install guard must appear BEFORE `npm run build:web --workspace=center` so vite is available.'
  }

  It 'non-in-place branch installs root node_modules before npm run build:web --workspace=center' {
    # `npm run build:web --workspace=center` from root uses workspaces
    # hoisting. Fresh publish bundle has no <publish-root>/node_modules, so
    # the install must happen before the build is attempted.
    $script:srcContent | Should -Match 'installing root workspaces' `
      'non-in-place branch must log "installing root workspaces" when missing.'
    # The install guard must appear BEFORE the actual build invocation.
    # Match the command line specifically.
    $buildIdx = $script:srcContent.IndexOf('try { npm run build:web --workspace=center }')
    $installIdx = $script:srcContent.IndexOf('installing root workspaces')
    $buildIdx | Should -BeGreaterThan -1 'non-in-place build command line must exist'
    $installIdx | Should -BeGreaterThan -1 'root install guard must exist'
    $installIdx | Should -BeLessThan $buildIdx `
      'root install guard must appear BEFORE `npm run build:web --workspace=center` so vite is hoisted.'
    # Guard checks the correct directory (root node_modules, not center/web).
    $script:srcContent | Should -Match 'Test-Path\s+\(Join-Path\s+\$projectRoot\s+''node_modules''\)' `
      'install guard must check <publish-root>/node_modules for the root install.'
  }

  It 'mirror sync: both install guards present in publish/system/scripts/install-center.ps1' {
    $script:pubContent | Should -Match 'installing center node_modules' `
      'publish mirror missing in-place install guard — must match scripts/ source.'
    $script:pubContent | Should -Match 'installing root workspaces' `
      'publish mirror missing non-in-place install guard — must match scripts/ source.'
  }
}

Describe 'install-center service recovery' {
  It 'calls Set-ServiceRecovery helper (single source of truth)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match 'Set-ServiceRecovery\s+-Name\s+''ADDashboardCenter'''
  }

  It 'Set-ServiceRecovery helper in Service.psm1 sets NSSM AppExit Default Restart and AppRestartDelay=2000' {
    $serviceContent = Get-Content (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1') -Raw
    # NSSM 2.24 `AppExit` requires the sub-parameter form `<exit_code|Default> <action>` —
    # "Default Restart" means restart the service on ANY exit code. Bare `AppExit Restart`
    # is rejected with "Parameter \"AppExit\" requires a subparameter!".
    $serviceContent | Should -Match 'AppExit\s+Default\s+Restart'
    $serviceContent | Should -Match 'AppRestartDelay\s+2000'
  }

  It 'Set-ServiceRecovery helper uses AppExit sub-parameter form "Default Restart" (NSSM 2.24 contract)' {
    # Regression guard: this is the THIRD real-world NSSM bug caught by external
    # install runs (after `AppExitAction` invalid param and `Start 2` enum code).
    # In every prior case the existing regex-based Pester assertion matched the
    # wrong substring. The bare `AppExit Restart` form was never actually invoked
    # against a live nssm.exe. Now we explicitly REQUIRE the sub-parameter form
    # and FORBID the bare form, plus assert mirror sync.
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $serviceContent = Get-Content $servicePath -Raw
    # Required: the corrected sub-parameter form must be present.
    $serviceContent | Should -Match 'AppExit\s+Default\s+Restart' `
      'Service.psm1 must call `nssm set Name AppExit Default Restart` (sub-parameter form required by NSSM 2.24).'
    # Forbidden: bare form must NOT appear as a pipe+Out-Null pattern.
    $serviceContent | Should -Not -Match 'AppExit\s+Restart\s*\|\s*Out-Null' `
      'Service.psm1 must NOT call bare `nssm set Name AppExit Restart` — NSSM 2.24 rejects this with "AppExit requires a subparameter!".'
    # Mirror sync.
    $publishPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts\common') 'Service.psm1'
    $publishContent = Get-Content $publishPath -Raw
    $publishContent | Should -Match 'AppExit\s+Default\s+Restart' `
      'publish/system/scripts/common/Service.psm1 mirror out of sync — must contain "AppExit Default Restart".'
  }

  It 'Set-ServiceRecovery helper in Service.psm1 configures Windows Service Recovery via sc.exe failure' {
    $serviceContent = Get-Content (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1') -Raw
    $serviceContent | Should -Match 'sc\.exe\s+failure\s+\$Name'
    $serviceContent | Should -Match 'reset=\s*60'
    $serviceContent | Should -Match 'restart/5000/restart/10000/restart/30000'
    # Mirror sync: publish/system/scripts/common/Service.psm1 must contain the same strings.
    $publishServiceContent = Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts\common') 'Service.psm1') -Raw
    $publishServiceContent | Should -Match 'sc\.exe\s+failure\s+\$Name'
    $publishServiceContent | Should -Match 'reset=\s*60'
    $publishServiceContent | Should -Match 'restart/5000/restart/10000/restart/30000'
  }

  It 'Install-NssmService passes NSSM Start enum name (not the numeric 2)' {
    # NSSM rejects `nssm set X Start 2` with "Invalid startup type '2'. Valid types are: SERVICE_AUTO_START, ...".
    # Guard: every call site must pass the enum NAME; the helper's default must also be the enum name.
    $helperPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'NSSM.psm1'
    $helperContent = Get-Content $helperPath -Raw
    $helperContent | Should -Match '\[ValidateSet\(.SERVICE_AUTO_START.,.SERVICE_DELAYED_AUTO_START.,.SERVICE_DEMAND_START.,.SERVICE_DISABLED.\)\]'
    $helperContent | Should -Match '\[string\]\$Start\s*=\s*.SERVICE_AUTO_START.'
    $helperContent | Should -Not -Match '\[int\]\$Start\s*=\s*2'

    foreach ($script in @('install-center.ps1','Register-ADDashboardAgent.ps1')) {
      $scriptPath = Join-Path (Join-Path $PSScriptRoot '..') $script
      $content = Get-Content $scriptPath -Raw
      $content | Should -Not -Match '\-Start\s+2\b'  "Numeric -Start 2 in $script fails NSSM; use -Start SERVICE_AUTO_START."
      $content | Should -Match 'SERVICE_AUTO_START'  "$script must pass the enum name (or its hardcoded literal in Invoke-Nssm)."

      # Mirror sync
      $publishScript = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') $script
      $pub = Get-Content $publishScript -Raw
      $pub | Should -Match 'SERVICE_AUTO_START'  "publish/system/$script mirror out of sync."
    }
  }

  It 'NSSM.psm1 Get-NssmPath includes the green-package candidate (no needless download when nssm is bundled)' {
    # 2026-08-23: install-agent.ps1 calls Ensure-Nssm.ps1 before delegating
    # to Register-ADDashboardAgent.ps1. Ensure-Nssm.ps1 first calls
    # NSSM.psm1::Get-NssmPath and falls through to download only if no
    # candidate matches. The green package bundles nssm at
    # <green>/agentInstall/nssm/nssm.exe — NSSM.psm1 (located at
    # <green>/agentInstall/common/NSSM.psm1) must search one level up for it,
    # otherwise the bundled nssm is invisible and a needless network call
    # fires (and breaks air-gapped installs that legitimately bundle nssm).
    #
    # Pattern matches the literal substring `'..\nssm'` that appears in the
    # candidate `(Join-Path (Join-Path $PSScriptRoot '..\nssm') 'nssm.exe')`.
    # Use a here-string to avoid PS single-quote / backslash escape hell.
    $pattern = @'
'\.\.\\nssm'
'@

    $nssmPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'NSSM.psm1'
    $nssmContent = Get-Content $nssmPath -Raw
    $nssmContent | Should -Match $pattern `
      'NSSM.psm1::Get-NssmPath must include <$PSScriptRoot>\..\nssm\nssm.exe so the green package bundled nssm is found (no needless download).'

    # Mirror sync: publish/system/scripts/common/NSSM.psm1 must match.
    $publishNssmPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts\common') 'NSSM.psm1'
    if (Test-Path $publishNssmPath) {
      $pub = Get-Content $publishNssmPath -Raw
      $pub | Should -Match $pattern `
        'publish/system/scripts/common/NSSM.psm1 mirror out of sync with NSSM.psm1 green-package candidate.'
    }
  }

  It 'NSSM.psm1 owns its $Script:LogDir (modules cannot read caller script-scope variables)' {
    # Module functions resolve $Script:LogDir in their OWN module scope, not
    # the caller's script scope. The previous layout had install-center.ps1
    # setting $Script:LogDir in its own scope and NSSM.psm1 reading it from
    # inside Set-NssmParameters — which silently returned $null and crashed
    # later as a Join-Path '-Path' binding error. Guard: NSSM.psm1 must
    # own the state via Set-NssmLogDir, and every NSSM.psm1-consuming
    # script must call it.
    # 2026-08-23: install-agent.ps1 + uninstall-agent.ps1 delegate to
    # Register-ADDashboardAgent.ps1 (self-contained, no NSSM.psm1 import),
    # so they no longer need Set-NssmLogDir. upgrade-center.ps1 is the
    # center symmetry entry point and still uses NSSM.psm1.
    $nssmPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'NSSM.psm1'
    $nssmContent = Get-Content $nssmPath -Raw
    $nssmContent | Should -Match '\$Script:LogDir\s*=.*Split-Path.*''Logs''' `
      'NSSM.psm1 must seed its own $Script:LogDir at module load (script-relative default).'
    $nssmContent | Should -Match 'function Set-NssmLogDir' `
      'NSSM.psm1 must export a Set-NssmLogDir setter for callers to push updates.'
    $nssmContent | Should -Not -Match 'requires Logger.psm1' `
      'Drop the old "requires Logger first" comment block — the indirection
      through Logger.psm1 `$Script:` was the root cause of the binding error.'

    foreach ($script in @('install-center.ps1','upgrade-center.ps1')) {
      $scriptPath = Join-Path (Join-Path $PSScriptRoot '..') $script
      $content = Get-Content $scriptPath -Raw
      $content | Should -Match 'Set-NssmLogDir' `
        "$script must call Set-NssmLogDir to push the log dir into NSSM module scope."

      # Mirror sync
      $publishScript = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') $script
      $pub = Get-Content $publishScript -Raw
      $pub | Should -Match 'Set-NssmLogDir'  "publish/system/$script mirror out of sync."
    }
  }

  It 'center server.js catches uncaughtException and unhandledRejection with fatal log + exit(1)' {
    # Without these traps, NSSM-restarted services that crash in <1500 ms
    # produce no stderr trace because pino's default async buffer drains
    # after process.exit(). These handlers + the sync destination together
    # guarantee any fatal exit lands a line on stderr before exit.
    foreach ($tree in @('center','publish\system\center')) {
      $serverPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') $tree) 'server.js'
      $content = Get-Content $serverPath -Raw
      $content | Should -Match "process\.on\('uncaughtException'" `
        "$tree/server.js must register an uncaughtException trap."
      $content | Should -Match "process\.on\('unhandledRejection'" `
        "$tree/server.js must register an unhandledRejection trap."
      $content | Should -Match 'process\.exit\(1\)' `
        "$tree/server.js fatal traps must terminate with exit 1."
    }
    # Logger must use a sync destination. We can't read the runtime
    # destination object directly, so we assert the literal is present.
    foreach ($tree in @('center','publish\system\center','agent','publish\system\agent')) {
      $loggerPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') $tree) 'src\logger.js'
      $content = Get-Content $loggerPath -Raw
      $content | Should -Match 'pino\.destination\(' `
        "$tree/src/logger.js should use pino.destination(...)."
      $content | Should -Match 'sync:\s*true' `
        "$tree/src/logger.js must opt in to sync writes."
    }
  }
}

Describe 'install-center Start-ServiceSafe diagnostics (Start-Service Win32 surfacing)' {
  # Regression guard for the 6th silent failure (2026-08-16). User reported:
  #   Start-Service : Cannot start service "AD Replication Dashboard Center (ADDashboardCenter)".
  # at Service.psm1:41. The exception was propagated raw with no Win32 code
  # surfaced, no stderr log hint, and no diagnostic dump of NSSM AppDirectory/
  # Application. Operators couldn't tell whether the failure was a missing dir,
  # missing exe, bad PATH, or something else. The fix adds pre-flight diagnostics
  # + try/catch surfacing of NativeErrorCode. This test locks in that contract.
  It 'Start-ServiceSafe is defined in Service.psm1 (source tree)' {
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    Test-Path $servicePath | Should -BeTrue
  }

  It 'Start-ServiceSafe wraps Start-Service in try/catch and surfaces InnerException' {
    # AST-scope the check to the Start-ServiceSafe function body to avoid
    # matching unrelated catch blocks. The Iron Law: any helper that calls
    # a cmdlet which can throw ServiceCommandException MUST catch and surface
    # the actual Win32 code — raw re-throw hides the real cause.
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($servicePath, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-ServiceSafe' }, $true)
    $fn.Count | Should -BeGreaterThan 0 'Start-ServiceSafe must be defined in Service.psm1'
    $body = $fn[0].Extent.Text

    # Must contain a try-block wrapping Start-Service AND a catch block.
    $body | Should -Match 'try\s*\{[^}]*Start-Service' `
      'Start-ServiceSafe must wrap Start-Service in try { ... } to catch ServiceCommandException.'
    $body | Should -Match 'catch\s*\{' `
      'Start-ServiceSafe must have a catch block on the Start-Service call.'

    # Must surface InnerException.Message (PowerShell wraps the real cause).
    $body | Should -Match 'InnerException\.Message' `
      'Start-ServiceSafe catch block must read $_.Exception.InnerException.Message — Start-Service wraps the real Win32 error in InnerException.'

    # Must surface NativeErrorCode (the actual Win32 error code that Start-Service swallows).
    $body | Should -Match 'NativeErrorCode' `
      'Start-ServiceSafe catch block must read NativeErrorCode — the actual Win32 error code is the only thing that distinguishes ERROR_PATH_NOT_FOUND (3) from ERROR_FILE_NOT_FOUND (2) from ERROR_SERVICE_ALREADY_RUNNING (1056).'
  }

  It 'Start-ServiceSafe pre-flight dumps NSSM AppDirectory / Application / AppStderr' {
    # Without the pre-flight dump, the operator sees only "Start-Service failed"
    # and has no idea whether NSSM was configured wrong. The diag dump is what
    # makes the failure self-explanatory.
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($servicePath, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-ServiceSafe' }, $true)
    $body = $fn[0].Extent.Text

    # Must query NSSM for AppDirectory / Application / AppStderr before trying to start.
    $body | Should -Match 'nssm\s+get\s+\$Name\s+AppDirectory' `
      'Start-ServiceSafe must query `nssm get $Name AppDirectory` for diagnostics.'
    $body | Should -Match 'nssm\s+get\s+\$Name\s+Application' `
      'Start-ServiceSafe must query `nssm get $Name Application` for diagnostics.'
    $body | Should -Match 'nssm\s+get\s+\$Name\s+AppStderr' `
      'Start-ServiceSafe must query `nssm get $Name AppStderr` so it can tell the operator where to look for the real root cause.'

    # Must Test-Path the AppDirectory + Application before attempting Start-Service.
    # Accept either `Test-Path $appDir` or `Test-Path -LiteralPath $appDir` — the
    # latter is preferred to defeat wildcard expansion in paths with [] chars.
    $body | Should -Match 'Test-Path[^\n]*\$appDir' `
      'Start-ServiceSafe must Test-Path AppDirectory — a missing dir is the #1 cause of NSSM launch failure.'
    $body | Should -Match 'Test-Path[^\n]*\$appBin' `
      'Start-ServiceSafe must Test-Path Application — a missing exe is the #2 cause.'
  }

  It 'Start-ServiceSafe uses Write-Host (NOT Logger exports) — module helper contract' {
    # Same lesson as Wait-ForHttpOk (see feedback_powershell_module_write_info.md):
    # common/*.psm1 helpers must not call Write-Info etc. because Logger may
    # not be in scope, and a CommandNotFoundException thrown inside the
    # helper's try/catch will be silently swallowed.
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($servicePath, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-ServiceSafe' }, $true)
    $body = $fn[0].Extent.Text
    $body | Should -Not -Match '(?m)^\s*Write-(Info|Step|Ok|Err2)\s' `
      'Start-ServiceSafe must not call Logger exports (Write-Info etc.) — common/*.psm1 helpers must use Write-Host. See feedback_powershell_module_write_info.md.'
  }

  It 'Start-ServiceSafe diagnostics are mirrored to publish/system/scripts/common/Service.psm1' {
    # Mirror sync guard — install-center.ps1 + install scripts run from
    # publish/system/scripts/ in production. Without mirror sync the
    # improved diagnostics are useless to the user.
    $publishPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts\common') 'Service.psm1'
    $sourcePath  = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $sourceContent  = Get-Content $sourcePath  -Raw
    $publishContent = Get-Content $publishPath -Raw
    # Source and publish must be byte-identical for this file.
    ($sourceContent -eq $publishContent) | Should -BeTrue `
      'publish/system/scripts/common/Service.psm1 must be byte-identical to scripts/common/Service.psm1 — the mirror is what production runs.'

    $ast = [System.Management.Automation.Language.Parser]::ParseFile($publishPath, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-ServiceSafe' }, $true)
    $fn.Count | Should -BeGreaterThan 0 'Start-ServiceSafe must be defined in publish/system/scripts/common/Service.psm1 too.'
    $body = $fn[0].Extent.Text
    $body | Should -Match 'NativeErrorCode' `
      'publish/system mirror Start-ServiceSafe must also surface NativeErrorCode.'
  }

  It 'Start-ServiceSafe trims nssm get output before Test-Path (CR/LF illegal char guard)' {
    # Regression guard for the 7th silent failure (2026-08-16). The 890a899
    # round of diagnostics added `nssm get $Name AppDirectory` to capture the
    # current AppDirectory, but nssm.exe writes the value + CR/LF to stdout.
    # PowerShell `&` captures that as a string ending in `\r\n`. Test-Path then
    # throws "illegal character in path" (ItemExistsArgumentError) on the un-trimmed
    # path, propagating the exception raw and aborting the install. Without
    # this trim, every install where Start-Service is attempted crashes in
    # the diagnostics code that was supposed to surface the actual error.
    $servicePath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($servicePath, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-ServiceSafe' }, $true)
    $body = $fn[0].Extent.Text

    # Every nssm get capture must be followed by .Trim(). Use Select-Object
    # -First 1 to handle the rare case nssm prints more than one line.
    # `[\s\S]*?` matches any char (including newline) non-greedily — single-
    # quote-friendly regex syntax (no PowerShell escapes to worry about).
    $body | Should -Match 'nssm\s+get\s+\$Name\s+AppDirectory[\s\S]*?\.Trim\(\)' `
      'Start-ServiceSafe must .Trim() the AppDirectory capture — nssm get appends CR/LF that breaks Test-Path.'
    $body | Should -Match 'nssm\s+get\s+\$Name\s+Application[\s\S]*?\.Trim\(\)' `
      'Start-ServiceSafe must .Trim() the Application capture.'
    $body | Should -Match 'nssm\s+get\s+\$Name\s+AppParameters[\s\S]*?\.Trim\(\)' `
      'Start-ServiceSafe must .Trim() the AppParameters capture.'
    $body | Should -Match 'nssm\s+get\s+\$Name\s+AppStderr[\s\S]*?\.Trim\(\)' `
      'Start-ServiceSafe must .Trim() the AppStderr capture.'

    # Test-Path on these values must be wrapped in try/catch — if it throws
    # (e.g. truly illegal char in a configured path), we still want the diag
    # dump to print so the operator can see what nssm actually has.
    # Match each side separately (try/catch around Test-Path can't use [^}]
    # because nested if/else braces break the simple regex).
    $body | Should -Match 'try\s*\{[\s\S]*?Test-Path[\s\S]*?\}\s*catch' `
      'Start-ServiceSafe must wrap Test-Path in try/catch so a bad path does not kill the diag dump.'

    # Live reproduction guard: actually call `& cmd | Select-Object -First 1` to
    # confirm that `.Trim()` is safe on the value PowerShell captures. If
    # someone refactors away from `Select-Object -First 1`, this still works as
    # long as the final scalar has .Trim() called on it.
    $sample = (& cmd.exe /c 'echo D:\Temp' 2>$null | Select-Object -First 1).Trim()
    $sample | Should -Be 'D:\Temp' '`.Trim()` after `Select-Object -First 1` must strip the trailing CR/LF.'
  }
}

Describe 'install-center -InPlace uses shipped dist (avoids stale-dist trap)' {
  # Bug fixed 2026-08-22: old -InPlace branch only rebuilt dist when
  # $InstallPath\dist\index.html was missing. Re-installing on an existing
  # install path kept the old dist even after a UI change in the bundle —
  # so the cloud server shipped stale UI (e.g. the 2026-08-22 agent token
  # redesign 复制令牌/生成新令牌 never made it to deployed instances).
  # Fix: prefer copying the bundle's shipped dist over rebuilding.
  BeforeAll {
    $script:installCenterPath = Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'
    $script:publishInstallCenterPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'install-center.ps1'
    $script:srcContent = Get-Content $script:installCenterPath -Raw
    $script:pubContent = Get-Content $script:publishInstallCenterPath -Raw
  }

  It '-InPlace branch checks for shipped dist FIRST (before deciding to build)' {
    # The shipped-dist Test-Path must appear in the -InPlace branch before
    # the `npm run build:web --workspace=center` invocation, so we never rebuild
    # when the bundle already ships a dist. The build command now appears in
    # BOTH branches (the merge unified them), so we search AFTER the $shippedDist
    # assignment (which is unique to the in-place branch) to find the in-place
    # build invocation specifically.
    $shippedIdx = $script:srcContent.IndexOf('$shippedDist = Join-Path $projectRoot')
    $buildIdx   = $script:srcContent.IndexOf('try { npm run build:web --workspace=center }', $shippedIdx)
    $shippedIdx | Should -BeGreaterThan -1 '-InPlace branch must reference a shipped dist path'
    $buildIdx   | Should -BeGreaterThan -1 '-InPlace build command must still exist (fallback path)'
    $shippedIdx | Should -BeLessThan $buildIdx `
      'shipped-dist check must come BEFORE the build invocation in the -InPlace branch — else we rebuild even when the bundle ships a fresh dist.'
  }

  It '-InPlace branch copies from shipped dist when shippedDist/index.html exists' {
    # Use AST extraction so we only check the -InPlace branch (the else block
    # at the bottom of the script). The branch must contain a Copy-Item from
    # $shippedDist and a step log "using shipped web UI dist" (renamed from
    # "using shipped frontend dist" after the center+frontend workspace merge).
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:installCenterPath, [ref]$null, [ref]$null)
    # Find the if (-not $InPlace) ... else block by scanning for the line.
    $scriptText = $script:srcContent
    $inPlaceIdx = $scriptText.IndexOf('} else {')
    $inPlaceIdx | Should -BeGreaterThan -1 'if/else branch must exist'
    $inPlaceBranch = $scriptText.Substring($inPlaceIdx)

    $inPlaceBranch | Should -Match "Test-Path\s+\(Join-Path\s+\`$shippedDist\s+'index\.html'\)" `
      '-InPlace branch must Test-Path $shippedDist/index.html.'
    $inPlaceBranch | Should -Match "using shipped web UI dist" `
      '-InPlace branch must log a step when using the shipped dist.'
    $inPlaceBranch | Should -Match "Copy-Item\s+-Path\s+\(Join-Path\s+\`$shippedDist\s+'\*'\)" `
      '-InPlace branch must Copy-Item from $shippedDist/* to $distPath.'
  }

  It '-InPlace branch falls back to build ONLY when shipped dist absent AND install dist absent' {
    # The fallback `npm run build:web --workspace=center` must be inside an
    # elseif whose condition is
    # `-not (Test-Path (Join-Path $distPath ''index.html''))`. This way:
    #   - shipped dist present → copy (preferred)
    #   - shipped dist absent + install dist present → leave alone (no rebuild, no regression)
    #   - shipped dist absent + install dist absent → rebuild
    $scriptText = $script:srcContent
    $inPlaceIdx = $scriptText.IndexOf('} else {')
    $inPlaceBranch = $scriptText.Substring($inPlaceIdx)
    # Match the elseif clause with negated Test-Path on the install dist.
    $inPlaceBranch | Should -Match 'elseif\s*\(\s*-not\s+\(Test-Path\s+\(Join-Path\s+\$distPath\s+''index\.html''\)\)\s*\)' `
      '-InPlace branch build fallback must be guarded by `elseif (-not (Test-Path $distPath/index.html))`.'
  }

  It 'mirror sync: -InPlace shipped-dist logic present in publish/system/scripts/install-center.ps1' {
    $script:pubContent | Should -Match '\$shippedDist = Join-Path \$projectRoot' `
      'publish mirror -InPlace branch missing shipped-dist resolution — must match scripts/ source.'
    $script:pubContent | Should -Match 'using shipped web UI dist' `
      'publish mirror -InPlace branch missing "using shipped web UI dist" log.'
  }
}

Describe 'install-center NSSM AppStderr override (round-12 pino-roll coexistence)' {
  # Round-12 observability: the center process owns its own daily-rotated log
  # via pino-roll at <InstallPath>/logs/center.<date>.<n>.log. NSSM also writes
  # the same file handle if AppStderr points at it (or any path under /logs/) —
  # both writers append + rename the rotated file, which races on the
  # same-second rename and produces truncated tails / EBADF. install-center.ps1
  # must disable NSSM stderr capture so pino-roll is the sole writer. Without
  # this override the daily rotation silently corrupts the rotated file on
  # every install.
  BeforeAll {
    $script:installCenterPath = Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'
    $script:publishInstallCenterPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'install-center.ps1'
    $script:srcContent = Get-Content $script:installCenterPath -Raw
    $script:pubContent = Get-Content $script:publishInstallCenterPath -Raw
  }

  It 'overrides NSSM AppStderr to empty string (disable stderr capture)' {
    # NSSM treats AppStderr="" as "no stderr redirection" — NSSM will not open
    # any file for the service's stderr. The actual call is
    #   Invoke-Nssm @('set', 'ADDashboardCenter', 'AppStderr', '')
    # — comma + optional whitespace + `''` (two adjacent single quotes = empty
    # string in PS) is the exact form we pin. Use a here-string to avoid PS
    # single-quote / backslash escape hell.
    $pattern = @'
'AppStderr'.*,\s*''
'@
    $script:srcContent | Should -Match $pattern `
      'install-center.ps1 must call nssm set ADDashboardCenter AppStderr '''' after Install-NssmService so pino-roll is the sole writer of the rotated log.'
  }

  It 'AppStderr override appears AFTER Install-NssmService (NSSM params order)' {
    # Install-NssmService sets AppStderr=<LogDir>/ADDashboardCenter-stderr.log
    # via Set-NssmParameters. The override must come AFTER that call so the
    # empty-string value wins — NSSM applies the most recent value.
    $installIdx = $script:srcContent.IndexOf('Install-NssmService -Name ''ADDashboardCenter''')
    $overrideIdx = $script:srcContent.IndexOf("'AppStderr', ''")
    $installIdx | Should -BeGreaterThan -1 'Install-NssmService call must exist'
    $overrideIdx | Should -BeGreaterThan -1 'AppStderr override must exist'
    $overrideIdx | Should -BeGreaterThan $installIdx `
      'AppStderr override must come AFTER Install-NssmService — NSSM applies the most recent value, so the empty-string override wins over the default -stderr.log.'
  }

  It 'AppStderr override appears BEFORE Set-ServiceRecovery (Start-Service order)' {
    # The override should land before the service actually starts, so the first
    # Start-Service after install honors the empty AppStderr (no file open on
    # boot, no race with pino-roll's first rotation). Set-ServiceRecovery
    # configures recovery options only — Start-ServiceSafe (next line) is what
    # actually starts. The override sits between Install-NssmService and
    # Set-ServiceRecovery so it lands before Start-ServiceSafe.
    $overrideIdx  = $script:srcContent.IndexOf("'AppStderr', ''")
    $recoveryIdx  = $script:srcContent.IndexOf("Set-ServiceRecovery -Name 'ADDashboardCenter'")
    $overrideIdx | Should -BeGreaterThan -1 'AppStderr override must exist'
    $recoveryIdx | Should -BeGreaterThan -1 'Set-ServiceRecovery call must exist'
    $overrideIdx | Should -BeLessThan $recoveryIdx `
      'AppStderr override must come BEFORE Set-ServiceRecovery / Start-ServiceSafe so the first service start honors the empty AppStderr.'
  }

  It 'mirror sync: publish/system/scripts/install-center.ps1 has the AppStderr override' {
    $pattern = @'
'AppStderr'.*,\s*''
'@
    $script:pubContent | Should -Match $pattern `
      'publish mirror missing AppStderr override — production install will set AppStderr=-stderr.log and race pino-roll.'
  }
}

Describe 'install-center Ensure-CenterNodeModules (idempotent reinstall)' {
  # Regression guard for the "only install if node_modules missing" bug. The
  # old guard skipped npm install when node_modules already existed, leaving
  # users on stale deps after a package.json bump (e.g. bcrypt→bcryptjs).
  # Ensure-CenterNodeModules must hash package.json+package-lock.json and
  # reinstall whenever the hash changes.
  BeforeAll {
    $script:installCenterPath = Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'
    $script:publishInstallCenterPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'install-center.ps1'
    $script:srcContent = Get-Content $script:installCenterPath -Raw
    $script:pubContent = Get-Content $script:publishInstallCenterPath -Raw
  }

  It 'defines the Ensure-CenterNodeModules function' {
    $script:srcContent | Should -Match 'function Ensure-CenterNodeModules'
  }

  It 'takes mandatory -InstallPath and -SrcDir string parameters' {
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:installCenterPath, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Ensure-CenterNodeModules' }, $true)
    $fn | Should -Not -BeNullOrEmpty 'Ensure-CenterNodeModules function must be defined'
    $params = $fn[0].Body.ParamBlock.Parameters
    ($params | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallPath' }) | Should -Not -BeNullOrEmpty
    ($params | Where-Object { $_.Name.VariablePath.UserPath -eq 'SrcDir' }) | Should -Not -BeNullOrEmpty
    # Confirm the Mandatory attribute text appears immediately above InstallPath in source.
    $script:srcContent | Should -Match '\[Parameter\(Mandatory\)\]\s*\[string\]\$InstallPath'
    $script:srcContent | Should -Match '\[Parameter\(Mandatory\)\]\s*\[string\]\$SrcDir'
  }

  It 'computes SHA256 hash of package.json + package-lock.json' {
    $script:srcContent | Should -Match 'Get-FileHash\s+-Algorithm\s+SHA256'
    $script:srcContent | Should -Match 'package\.json'
    $script:srcContent | Should -Match 'package-lock\.json'
  }

  It 'compares against stored .install-hash in InstallPath' {
    # The function reads .install-hash via Get-Content and references both files explicitly.
    $script:srcContent | Should -Match '\.install-hash'
    $script:srcContent | Should -Match 'Get-Content\s+-Path\s+\$hashFile'
  }

  It 'triggers reinstall when new hash differs from stored hash' {
    $script:srcContent | Should -Match '\$newHash\s+-ne\s+\$oldHash'
  }

  It 'writes the new .install-hash after a successful install' {
    $script:srcContent | Should -Match 'Set-Content\s+-Path\s+\$hashFile'
  }

  It 'deletes node_modules before reinstalling when deps change' {
    $script:srcContent | Should -Match 'Remove-Item\s+-Path\s+\(Join-Path\s+\$InstallPath\s+''node_modules''\)\s+-Recurse\s+-Force'
  }

  It 'is called from both install branches (replacing the old "if not node_modules" guard)' {
    $script:srcContent | Should -Match 'Ensure-CenterNodeModules\s+-InstallPath\s+\$InstallPath\s+-SrcDir\s+\$srcDir'
    # Regression guard: the old broken guard must be gone.
    $script:srcContent | Should -Not -Match "if\s*\(\s*-not\s+\(Test-Path\s+\(Join-Path\s+\$InstallPath\s+'node_modules'\)\)\)"
  }

  It 'mirror sync: function block identical in publish/system/scripts/install-center.ps1' {
    $extractBlock = {
      param($content)
      $start = $content.IndexOf("function Ensure-CenterNodeModules")
      if ($start -lt 0) { return '' }
      $rest = $content.Substring($start)
      $lines = $rest.Split("`n")
      $endLine = -1
      for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($i -gt 0 -and $lines[$i] -match '^\}') { $endLine = $i; break }
      }
      return ($lines[0..$endLine] -join "`n")
    }
    $srcBlock = & $extractBlock $script:srcContent
    $pubBlock = & $extractBlock $script:pubContent
    $pubBlock | Should -Be $srcBlock 'publish/system/scripts/install-center.ps1 mirror must match scripts/install-center.ps1 exactly.'
  }

  It 'defines $srcDir at script scope BEFORE the if (-not $InPlace) branch (regression guard)' {
    # Bug fixed 2026-08-05: Ensure-CenterNodeModules was called in both branches
    # but $srcDir was only assigned inside the non-InPlace branch. With -InPlace,
    # $srcDir was empty and Ensure-CenterNodeModules's mandatory -SrcDir param
    # threw ParameterArgumentValidationErrorEmptyStringNotAllowed, breaking
    # the green-bundle start.bat path. Guard: $srcDir must be defined at the
    # script scope before the if (-not $InPlace) block.
    $srcDirIdx = $script:srcContent.IndexOf('$srcDir = Join-Path $projectRoot ''center''')
    $ifIdx = $script:srcContent.IndexOf('if (-not $InPlace)')
    $srcDirIdx | Should -BeGreaterThan -1 '$srcDir assignment must exist'
    $ifIdx | Should -BeGreaterThan -1 'if (-not $InPlace) branch must exist'
    $srcDirIdx | Should -BeLessThan $ifIdx '$srcDir must be defined BEFORE the if (-not $InPlace) branch so both install paths see it.'
  }
}

Describe 'install-center HTTP readiness probe (Wait-ForHttpOk)' {
  # Regression for the silent failure chain: NSSM "Running" != HTTP ready.
  # Cold cache (modules loading, DB pool init, route mount) takes 2-15s
  # before Express binds the listening socket. A single Invoke-WebRequest
  # immediately after Start-ServiceSafe races the boot and prints
  # "init status: unreachable: unable to connect to remote server" even though the
  # service is fine. Wait-ForHttpOk polls up to 30s and is the only way
  # to make the install's success message trustworthy.
  BeforeAll {
    $script:installCenterPath = Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1'
    $script:publishInstallCenterPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'install-center.ps1'
    $script:srcContent = Get-Content $script:installCenterPath -Raw
    $script:pubContent = Get-Content $script:publishInstallCenterPath -Raw
  }

  It 'Wait-ForHttpOk helper is defined in scripts/common/Service.psm1 (source tree)' {
    $serviceModule = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $svcContent = Get-Content $serviceModule -Raw
    $svcContent | Should -Match 'function Wait-ForHttpOk' `
      'scripts/common/Service.psm1 must define Wait-ForHttpOk — install-center.ps1 imports it. Without it the install-center probe races the boot and prints "unreachable" on cold cache.'
  }

  It 'Wait-ForHttpOk helper is mirrored in publish/system/scripts/common/Service.psm1' {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $serviceModule = Join-Path $repoRoot 'publish\system\scripts\common\Service.psm1'
    $svcContent = Get-Content $serviceModule -Raw
    $svcContent | Should -Match 'function Wait-ForHttpOk' `
      'publish mirror missing Wait-ForHttpOk — runtime bundle will silently race the HTTP probe.'
  }

  It 'install-center.ps1 polls HTTP via Wait-ForHttpOk (not single-shot Invoke-WebRequest)' {
    $script:srcContent | Should -Match 'Wait-ForHttpOk\s+-Url\s+\$probeUrl' `
      'install-center.ps1 must use Wait-ForHttpOk to poll HTTP readiness. Single-shot Invoke-WebRequest after Start-ServiceSafe races the boot and prints "unreachable" even when the service is fine.'
    $script:srcContent | Should -Match '\$probeUrl\s*=\s*"http://localhost:\$ListenPort/api/init/status"' `
      'probe URL must be the actual init status endpoint with the configured port.'
  }

  It 'install-center.ps1 does NOT single-shot probe right after Start-ServiceSafe' {
    # The bug: a bare `try { Invoke-WebRequest ... } catch { unreachable ... }` immediately
    # after Start-ServiceSafe returns. With this pattern the install script always reports
    # "unreachable" on cold cache (2-15s boot) even though the service binds successfully.
    $content = $script:srcContent
    $startIdx = $content.IndexOf('Start-ServiceSafe -Name ''ADDashboardCenter''')
    $waitIdx = $content.IndexOf('Wait-ForHttpOk -Url $probeUrl')
    $startIdx | Should -BeGreaterThan -1 'Start-ServiceSafe call must exist'
    $waitIdx | Should -BeGreaterThan -1 'Wait-ForHttpOk call must exist'
    $waitIdx | Should -BeGreaterThan $startIdx 'Wait-ForHttpOk must come AFTER Start-ServiceSafe (it polls the URL the service is supposed to bind)'
  }

  It 'install-center.ps1 on Wait-ForHttpOk timeout logs a clear warning instead of failing' {
    # Important: don't fail the install if HTTP just hasn't bound yet — the
    # service is up per SCM. Log a clear warning so the operator knows to retry.
    $script:srcContent | Should -Match 'Write-Info.*did not return 2xx within 30s' `
      'timeout branch must log a clear warning, not call Write-Err2 / exit 1 — service is up, HTTP just slow.'
  }

  It 'mirror sync: publish/system/scripts/install-center.ps1 uses Wait-ForHttpOk too' {
    $script:pubContent | Should -Match 'Wait-ForHttpOk\s+-Url\s+\$probeUrl' `
      'publish mirror must use Wait-ForHttpOk — runtime bundle is what users actually run.'
    $script:pubContent | Should -Match '\$probeUrl\s*=\s*"http://localhost:\$ListenPort/api/init/status"'
  }

  It 'Wait-ForHttpOk is self-contained — works without Logger.psm1 pre-imported' {
    # Regression: a previous version called Write-Info (Logger.psm1 export).
    # When Logger isn't pre-imported, Write-Info throws CommandNotFoundException
    # which the outer try/catch swallows, making the function silently return $false
    # even when the probe succeeded. install-center.ps1 sets $ErrorActionPreference=Stop
    # and only imports Logger AFTER importing Service — so this helper must not
    # depend on Logger being in scope. Use Write-Host (always available) instead.
    # Note: Set-ServiceRecovery also uses Write-Info but Logger IS imported first
    # by install-center.ps1, so it's safe there. This test scopes to Wait-ForHttpOk only.
    $serviceModule = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $svcContent = Get-Content $serviceModule -Raw
    # Extract the Wait-ForHttpOk function block via AST.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($serviceModule, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Wait-ForHttpOk' }, $true)
    $fn | Should -Not -BeNullOrEmpty 'Wait-ForHttpOk function must exist'
    $fnText = $fn[0].Extent.Text
    $fnText | Should -Not -Match '(?m)^\s*Write-Info\s' `
      'Wait-ForHttpOk must NOT call Write-Info — it can throw CommandNotFoundException when Logger.psm1 is not pre-imported, silently making the function always return $false. Use Write-Host instead.'
  }
}

Describe 'center+frontend workspace merge layout' {
  # Regression tests for the center+frontend workspace merge (2026-08-22).
  # These assert the post-merge filesystem layout so a future refactor that
  # accidentally resurrects the old frontend/ tree (or forgets to track the
  # shipped dist) gets caught by CI. Path construction uses string
  # concatenation with `\` (not Join-Path) to keep all path separators
  # consistent and match the .ps1 convention in this test file.
  BeforeAll {
    $script:repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
  }

  It 'frontend/ directory must NOT exist' {
    Test-Path "$script:repoRoot\frontend" | Should -BeFalse `
      'frontend/ directory must be removed after the merge — its files now live at center/web/.'
  }

  It 'center/web/ must contain the merged frontend source' {
    Test-Path "$script:repoRoot\center\web\vite.config.js" | Should -BeTrue `
      'center/web/vite.config.js must exist after the merge.'
    Test-Path "$script:repoRoot\center\web\index.html" | Should -BeTrue `
      'center/web/index.html must exist after the merge.'
  }

  It 'center/web/vite.config.js must output to ../dist' {
    $viteConfig = Get-Content "$script:repoRoot\center\web\vite.config.js" -Raw
    $viteConfig | Should -Match "outDir:\s*'\.\./dist'" `
      'center/web/vite.config.js must declare outDir: "../dist" so vite writes to center/dist/.'
  }

  It 'publish/system/frontend/ must NOT exist (no shipped frontend tree)' {
    Test-Path "$script:repoRoot\publish\system\frontend" | Should -BeFalse `
      'publish/system/frontend/ must be removed after the merge — shipped dist now lives at publish/system/center/dist/.'
  }

  It 'publish/system/center/dist/index.html MUST exist (shipped dist sanity)' {
    Test-Path "$script:repoRoot\publish\system\center\dist\index.html" | Should -BeTrue `
      'publish/system/center/dist/index.html must be tracked (the shipped web bundle).'
  }
}
