Describe 'build-green-package.ps1' {
  BeforeAll {
    $script:buildPath = Join-Path (Join-Path $PSScriptRoot '..') 'build-green-package.ps1'
    $script:content   = Get-Content $script:buildPath -Raw
    $script:readmePath = Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md'
  }

  It 'has AST-clean syntax' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:buildPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'stages agent source (with robocopy + tests/node_modules exclusion)' {
    # Mirrors build-msi.ps1 staging logic — PS 5.1's Copy-Item -Exclude doesn't
    # apply to nested directories under -Recurse, so robocopy /XD is mandatory
    # to drop `tests/` and `node_modules/`.
    $script:content | Should -Match 'robocopy.*agent.*/XD.*node_modules.*tests' `
      'agent staging must exclude node_modules + tests via robocopy /XD.'
  }

  It 'stages scripts/ (install + uninstall + common)' {
    $script:content | Should -Match 'install-agent\.ps1' `
      'green package must bundle scripts/install-agent.ps1.'
    $script:content | Should -Match 'uninstall-agent\.ps1' `
      'green package must bundle scripts/uninstall-agent.ps1.'
    $script:content | Should -Match 'common' `
      'green package must bundle scripts/common/ (Logger/NSSM/Service/Ensure-Nssm).'
  }

  It 'stages nssm.exe at <green>/nssm/nssm.exe' {
    # NSSM.psm1::Get-NssmPath searches <root>/nssm/ (NSSM.psm1:30-37) — placing
    # nssm at <green>/nssm/ is the cheapest matching layout. install-agent.ps1
    # dot-sources common/Ensure-Nssm.ps1 which would download NSSM if missing,
    # but staging it avoids the network call on first install.
    $script:content | Should -Match "nssm\.exe" `
      'build-green-package.ps1 must stage nssm.exe (used by NSSM.psm1).'
  }

  It 'pre-installs node_modules with npm install --omit=dev' {
    # install-agent.ps1 has a guard at line 73-75:
    #   if (-not (Test-Path node_modules)) { npm install --omit=dev }
    # Pre-installing node_modules in the bundle makes first-run install skip
    # the network step on the target machine — operators don't need npm access
    # from production.
    $script:content | Should -Match 'npm\s+install\s+--omit=dev' `
      'green package must pre-install node_modules with npm install --omit=dev.'
  }

  It 'uses root monorepo lockfile (not agent/package-lock.json)' {
    # Per build-msi.ps1:88-94 review: per-workspace lockfiles drift from the
    # root and ship versions the test suite never runs against. Same rationale
    # applies here.
    $script:content | Should -Match "package-lock\.json" `
      'build-green-package.ps1 must reference the root package-lock.json.'
    $script:content | Should -Match 'root' `
      'the package-lock.json reference must be the root monorepo lockfile (rootLockSrc / $root).'
  }

  It 'outputs publish/installer/agentInstall/ + .zip' {
    $script:content | Should -Match 'agentInstall' `
      'final output must be named agentInstall (folder + zip).'
  }

  It 'has -SkipNpmInstall switch for fast iteration' {
    # When iterating on agent source, re-running npm install for every
    # build-green-package.ps1 invocation wastes minutes. The switch lets
    # the operator copy the previous green package in (the bundle still
    # contains the source, just no fresh node_modules).
    $script:content | Should -Match '\[switch\]\$SkipNpmInstall' `
      'build-green-package.ps1 must declare [switch]$SkipNpmInstall for fast iteration.'
  }

  It 'excludes queue.db* (runtime SQLite WAL files, never ship)' {
    # Local agent runs leave queue.db + queue.db-shm + queue.db-wal under
    # agent/. These are runtime state — never release artifacts. Picked up
    # by a manual grep test (not a built-output check) so this guard works
    # even when the green package has not been rebuilt recently.
    $script:content | Should -Match 'queue\.db\*' `
      'agent staging must exclude queue.db* — runtime SQLite WAL files from local agent runs.'
  }
}

Describe 'green package README (operator guide)' {
  It 'exists at installer/README-green-install.md (bundled with the package)' {
    Test-Path (Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md') | Should -BeTrue `
      'installer/README-green-install.md must exist — it is the operator-facing guide bundled INSIDE the green package.'
  }

  It 'documents Node.js 20 LTS pre-req' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md') -Raw
    $content | Should -Match 'Node\.js' `
      'green README must document the Node.js pre-req (green package does NOT bundle Node, unlike MSI).'
    $content | Should -Match '20' `
      'green README must specify Node.js 20 LTS as the version.'
  }

  It 'documents install + uninstall commands' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md') -Raw
    $content | Should -Match 'install-agent\.ps1' `
      'green README must include the install-agent.ps1 invocation.'
    $content | Should -Match 'uninstall-agent\.ps1' `
      'green README must include the uninstall-agent.ps1 invocation.'
  }

  It 'documents the install path difference vs MSI' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md') -Raw
    $content | Should -Match 'MSI' `
      'green README must compare MSI vs green-package paths so operators can pick the right one.'
  }
}

Describe 'installer README covers both paths' {
  It 'parent installer/README.md documents both MSI and green package paths' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README.md') -Raw
    $content | Should -Match 'MSI' `
      'installer/README.md must reference the MSI path.'
    $content | Should -Match 'green' `
      'installer/README.md must reference the green-package path.'
    $content | Should -Match 'build-green-package\.ps1' `
      'installer/README.md must reference build-green-package.ps1 build command.'
  }

  It 'parent README drops the "唯一对外交付的产物" claim (green package is also shipped)' {
    # build-msi.ps1 used to claim publish/installer/ADDashboardAgent.msi was
    # the ONLY deliverable. After 2026-08-23 green package landed, that's
    # false — MSI is one of two first-class install paths. Drift guard.
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README.md') -Raw
    $content | Should -Not -Match '唯一对外交付的产物' `
      'installer/README.md must not claim MSI is the only deliverable now that green package exists.'
  }
}

Describe 'green package wired into publish.zip' {
  It 'build-publish-zip.ps1 excludes publish/installer/staging-agentInstall/' {
    # build-green-package.ps1's staging dir is `publish/installer/staging-agentInstall/`,
    # moved to `agentInstall/` at end of build. If a build was interrupted
    # mid-copy, staging-agentInstall would persist; publish.zip should exclude
    # it (defense in depth, same as MSI's staging exclusion).
    $buildZipPath = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'scripts\build-publish-zip.ps1'
    $content = Get-Content $buildZipPath -Raw
    $content | Should -Match "staging-agentInstall" `
      'scripts/build-publish-zip.ps1 must exclude publish/installer/staging-agentInstall/ so an interrupted build does not ship stale staging.'
  }
}
