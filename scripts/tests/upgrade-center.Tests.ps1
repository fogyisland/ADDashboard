Describe 'upgrade-center (architecture-extension script)' {
  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
      throw "Parse errors ($($errors.Count)):`n$($errors | Out-String)"
    }
    $errors.Count | Should -Be 0
  }

  It 'declares mandatory -WebAdminPassword parameter (HTTP auth needs it)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1') -Raw
    $content | Should -Match '\[Parameter\(Mandatory\)\]\s*\[string\]\$WebAdminPassword' `
      'upgrade-center.ps1 must require -WebAdminPassword — migration apply needs auth, and prompting at runtime is safer than storing credentials. WebAdminPassword is the web admin login credential (bcrypt in sys_users), distinct from the DB password in appsettings.json.'
  }

  It 'rejects running against an uninitialized install (needsInit check)' {
    # Critical safety guard: running upgrade-center.ps1 against a fresh
    # install (needsInit=true) would silently no-op or fail loudly on first
    # migration apply. Must surface a clear error pointing to install-center.ps1.
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1') -Raw
    $content | Should -Match 'needsInit' `
      'upgrade-center.ps1 must check /api/init/status for needsInit before applying migrations.'
    $content | Should -Match 'install-center\.ps1' `
      'needsInit=true error must point the operator to install-center.ps1, not just say "DB missing".'
  }

  It 'does not copy appsettings.json (operator-owned config)' {
    # appsettings.json contains DB credentials + jwtSecret + agent_token.
    # Overwriting it during upgrade would clobber the running config.
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1') -Raw
    $copyLine = ($content -split "`n" | Where-Object { $_ -match 'Copy-Item\s+-Path\s+\(Join-Path\s+\$srcDir' }) | Select-Object -First 1
    $copyLine | Should -Not -BeNullOrEmpty 'upgrade must have a Copy-Item for code replacement'
    $copyLine | Should -Match 'appsettings\.json' `
      'Copy-Item -Exclude MUST include appsettings.json — overwriting it would clobber DB credentials + jwtSecret.'
  }

  It 'excludes tests and node_modules from code copy (prod only)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1') -Raw
    $content | Should -Match "Copy-Item.*-Exclude\s+'node_modules','tests','appsettings.json'" `
      'upgrade must -Exclude node_modules (re-installed hash-checked) + tests (not for prod) + appsettings.json.'
  }
}

Describe 'upgrade-center shipped-dist handling' {
  BeforeAll {
    $script:upgradePath = Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1'
    $script:publishPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'upgrade-center.ps1'
    $script:srcContent = Get-Content $script:upgradePath -Raw
  }

  It 'refreshes dist from shipped bundle FIRST (stale-UI trap)' {
    $shippedIdx = $script:srcContent.IndexOf('$shippedDist = Join-Path $projectRoot')
    $refreshIdx = $script:srcContent.IndexOf('refreshing dist from shipped bundle')
    $shippedIdx | Should -BeGreaterThan -1 'upgrade must reference shipped dist'
    $refreshIdx  | Should -BeGreaterThan -1 'upgrade must log "refreshing dist from shipped bundle"'
    $shippedIdx | Should -BeLessThan $refreshIdx 'shipped-dist resolution must come BEFORE the refresh step.'
  }

  It 'falls back to vite build only when shipped dist absent AND install dist absent' {
    $script:srcContent | Should -Match 'elseif\s*\(\s*-not\s+\(Test-Path\s+\(Join-Path\s+\$distPath\s+''index\.html''\)\)\s*\)' `
      'upgrade build fallback must be guarded by elseif (-not (Test-Path $distPath/index.html)).'
  }

  It 'does not rebuild when shipped dist absent but install dist present' {
    # If we have an existing install dist, don't touch it just because the
    # shipped dist is absent (legacy bundle that doesn't ship dist). Rebuilding
    # would clobber a working install.
    $script:srcContent | Should -Match 'install dist already present; leaving alone' `
      'upgrade must log + skip when shipped dist absent but install dist present.'
  }
}

Describe 'upgrade-center -RebuildFrontend (stale-UI trap exit hatch)' {
  BeforeAll {
    $script:upgradePath = Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1'
    $script:srcContent = Get-Content $script:upgradePath -Raw
  }

  It 'declares [switch]$RebuildFrontend in the param block' {
    # Mirror of scripts/update-center.ps1 -RebuildFrontend — the unified
    # publish/system/update.{ps1,bat} entry always passes it through to
    # upgrade-center.ps1 to guarantee local-source = server-dist.
    $script:srcContent | Should -Match '\[switch\]\$RebuildFrontend' `
      'upgrade-center.ps1 must declare [switch]$RebuildFrontend.'
  }

  It 'runs npm run build:frontend when -RebuildFrontend is set' {
    $script:srcContent | Should -Match 'npm run build:frontend' `
      'upgrade-center.ps1 must invoke npm run build:frontend in the RebuildFrontend branch.'
  }

  It 'prefers local frontend\dist (Copy-Item from $localDist in RebuildFrontend branch)' {
    # The semantic invariant: when -RebuildFrontend is set, the Copy-Item
    # that lands dist into $distPath must read from a path tied to the
    # local build (frontend\dist), not the shippedDist variable. We assert
    # by checking that `$localDist '*'` is used as the Copy-Item -Path
    # source in the file (separate from `$shippedDist '*'`).
    # Single-quoted regex: PowerShell preserves `\$` literally, .NET regex
    # interprets `\$` as literal `$`. So `\s+'\*'` matches `\s+'*'` (whitespace
    # then single-quoted asterisk). Single `$localDist` not `$$localDist`.
    $script:srcContent | Should -Match '\$localDist\s+''\*''' `
      'upgrade-center.ps1 must Copy-Item from a $localDist-suffixed path in the RebuildFrontend branch (proof local build, not shipped bundle, gets copied to dist).'
    $script:srcContent | Should -Match '\$shippedDist\s+''\*''' `
      'upgrade-center.ps1 must still Copy-Item from $shippedDist in the shipped-dist branch (regression — the shipped-dist code path is unchanged).'
  }

  It 'checks if ($RebuildFrontend) BEFORE the shipped-dist elseif (priority order)' {
    # Regression guard: if a future refactor moves the shipped branch above
    # the RebuildFrontend branch, -RebuildFrontend silently no-ops (stale UI).
    $rebuildIdx   = $script:srcContent.IndexOf('if ($RebuildFrontend)')
    $shippedIdx   = $script:srcContent.IndexOf('Test-Path (Join-Path $shippedDist')
    $rebuildIdx   | Should -BeGreaterThan -1 'RebuildFrontend branch must exist.'
    $shippedIdx   | Should -BeGreaterThan -1 'shipped-dist branch must still exist.'
    $rebuildIdx   | Should -BeLessThan $shippedIdx `
      'RebuildFrontend branch MUST come BEFORE shipped-dist elseif — otherwise -RebuildFrontend silently falls through to the shipped copy.'
  }
}

Describe 'upgrade-center Ensure-NodeModules (idempotent reinstall)' {
  BeforeAll {
    $script:upgradePath = Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1'
    $script:publishPath = Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'upgrade-center.ps1'
    $script:srcContent = Get-Content $script:upgradePath -Raw
  }

  It 'defines Ensure-NodeModules (sibling of install-center.ps1 Ensure-CenterNodeModules)' {
    $script:srcContent | Should -Match 'function Ensure-NodeModules' `
      'upgrade-center.ps1 must own its own Ensure-NodeModules — install-center.ps1 Ensure-CenterNodeModules is local, not exportable.'
  }

  It 'hashes package.json + package-lock.json after code copy' {
    $script:srcContent | Should -Match 'Get-FileHash\s+-Algorithm\s+SHA256' `
      'Ensure-NodeModules must hash-check (same approach as install-center).'
    $script:srcContent | Should -Match 'package\.json'
    $script:srcContent | Should -Match 'package-lock\.json'
  }

  It 'writes .install-hash after a successful install' {
    $script:srcContent | Should -Match 'Set-Content\s+-Path\s+\$hashFile' `
      'Ensure-NodeModules must write .install-hash so subsequent runs are no-op.'
  }
}

Describe 'upgrade-center HTTP migration apply (the "扩展架构" piece)' {
  BeforeAll {
    $script:upgradePath = Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1'
    $script:srcContent = Get-Content $script:upgradePath -Raw
  }

  It 'authenticates via POST /api/auth/login and reads JWT token' {
    $script:srcContent | Should -Match '/api/auth/login' `
      'upgrade must POST credentials to /api/auth/login.'
    $script:srcContent | Should -Match 'Bearer\s+\$token' `
      'upgrade must use Bearer token for subsequent admin calls.'
  }

  It 'lists pending migrations via GET /api/admin/migrations' {
    $script:srcContent | Should -Match '/api/admin/migrations\b' `
      'upgrade must GET /api/admin/migrations to enumerate pending migrations.'
    $script:srcContent | Should -Match "status -eq 'pending'" `
      'upgrade must filter by status=pending.'
  }

  It 'applies each pending migration sequentially via POST /api/admin/migrations/:version/apply' {
    # Sequential is required: migrations may have inter-dependencies (e.g.
    # adding a column before adding an index on it). apply-up-to would be safer
    # but the API only exposes per-version apply.
    $script:srcContent | Should -Match '/api/admin/migrations/\$\(\$m\.version\)/apply' `
      'upgrade must POST to /api/admin/migrations/<version>/apply for each pending migration (subexpression form).'
    $script:srcContent | Should -Match 'foreach\s*\(\s*\$m\s+in\s+\$pending\s*\)' `
      'upgrade must iterate pending migrations in order (sequential, not parallel).'
  }

  It 'verifies 0 pending after apply loop (fail loud on partial failure)' {
    $script:srcContent | Should -Match 'still pending' `
      'upgrade must verify 0 pending after the apply loop — surface a clear error on partial failure.'
  }

  It 'tags each apply with appliedBy=upgrade-center.ps1 for audit log traceability' {
    $script:srcContent | Should -Match "appliedBy\s*=\s*'upgrade-center\.ps1'" `
      'upgrade must pass appliedBy=upgrade-center.ps1 in the apply body so the audit log shows the script (not "admin") as the actor.'
  }
}

Describe 'upgrade-center mirror parity' {
  It 'mirror sync: scripts/upgrade-center.ps1 == publish/system/scripts/upgrade-center.ps1 byte-identical' {
    $srcContent = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1') -Raw
    $pubContent = Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'upgrade-center.ps1') -Raw
    ($srcContent -eq $pubContent) | Should -BeTrue `
      'publish mirror must be byte-identical to scripts/ source — production runs from publish/system/scripts/.'
  }

  It 'mirror script preserves the install-vs-upgrade distinction (not silent install)' {
    # If the mirror dropped the upgrade-specific safety check (needsInit guard),
    # running upgrade-center.ps1 from a fresh prod install would silently apply
    # migrations against a non-existent DB. Guard: the mirror must keep the
    # needsInit branch.
    $pubContent = Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system\scripts') 'upgrade-center.ps1') -Raw
    $pubContent | Should -Match 'needsInit' `
      'publish mirror must keep the needsInit guard — otherwise a fresh install would skip the init step silently.'
    $pubContent | Should -Match '/api/admin/migrations/\$\(\$m\.version\)/apply' `
      'publish mirror must keep the per-version apply loop.'
  }
}

Describe 'upgrade-center HTTP readiness probe' {
  # Regression: same lesson as install-center.ps1 — NSSM "Running" != HTTP ready.
  # Cold cache takes 2-15s. upgrade-center must Wait-ForHttpOk /api/init/status
  # before trying to login (otherwise login races the boot and reports
  # "unreachable" on every upgrade, just like install's old single-shot probe).
  It 'uses Wait-ForHttpOk before authenticating (not single-shot Invoke-WebRequest)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'upgrade-center.ps1') -Raw
    $waitIdx   = $content.IndexOf('Wait-ForHttpOk -Url $probeUrl')
    $loginIdx  = $content.IndexOf('/api/auth/login')
    $waitIdx  | Should -BeGreaterThan -1 'upgrade must use Wait-ForHttpOk'
    $loginIdx | Should -BeGreaterThan -1 'upgrade must call /api/auth/login'
    $waitIdx  | Should -BeLessThan $loginIdx `
      'Wait-ForHttpOk must come BEFORE login — otherwise login races the boot.'
  }

  It 'Wait-ForHttpOk is in scripts/common/Service.psm1 (already shared with install-center)' {
    $serviceModule = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') 'common') 'Service.psm1'
    $svcContent = Get-Content $serviceModule -Raw
    $svcContent | Should -Match 'function Wait-ForHttpOk' `
      'Service.psm1 owns Wait-ForHttpOk — upgrade-center.ps1 imports Service.psm1 and uses it.'
  }
}