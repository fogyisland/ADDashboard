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

  It 'stages PS1 files + common at agentInstall/ root (not under scripts/)' {
    # 2026-08-23 layout: operator expects `& C:\green\agentInstall\install-agent.ps1`
    # (no scripts/ prefix). The three PS1 files form the install surface;
    # common/ stays a sibling so $PSScriptRoot\common\… resolves correctly.
    $script:content | Should -Match 'install-agent\.ps1' `
      'green package must bundle install-agent.ps1.'
    $script:content | Should -Match 'uninstall-agent\.ps1' `
      'green package must bundle uninstall-agent.ps1.'
    # 2026-08-23 split: install + uninstall now delegate the SCM-facing steps
    # (appsettings.json + NSSM + sc.exe failure recovery + Start/Stop service)
    # to a single Register-ADDashboardAgent.ps1 script. The build MUST stage
    # it alongside install/uninstall or -SkipStart on the target machine has
    # nothing to invoke.
    $script:content | Should -Match 'Register-ADDashboardAgent\.ps1' `
      'green package must bundle Register-ADDashboardAgent.ps1 (single registration entry point shared by install/uninstall).'
    $script:content | Should -Match 'common' `
      'green package must bundle common/ (Logger/NSSM/Service/Ensure-Nssm).'
  }

  It 'does NOT create an agentInstall/scripts/ subdirectory (PS1 files at root)' {
    # Regression guard: the 2026-08-23 flatten moved install/uninstall/
    # Register from agentInstall/scripts/ to agentInstall/. The build script
    # must NOT mkdir '<staging>/scripts' anymore — that was the line that
    # produced the wrong layout the first time around.
    $script:content | Should -Not -Match "Join-Path\s+\$staging\s+'scripts'" `
      "build must not create <staging>/scripts/ subdir — PS1 files live at agentInstall/ root."
    $script:content | Should -Not -Match '\$scriptsDst\s*=\s*Join-Path\s+\$staging\s+\\?\x27scripts\\?\x27' `
      "build must not assign `$scriptsDst = Join-Path `$staging 'scripts' — same flatten rule."
  }

  It 'stages upgrade-agent.ps1 (unified install/update entry)' {
    # 2026-08-23: upgrade-agent.ps1 is the recommended operator entry point —
    # auto-detects install vs hot-update. The green package must bundle it at
    # <green>/ root alongside install-agent.ps1 / uninstall-agent.ps1 /
    # Register-ADDashboardAgent.ps1. Without it, operators on air-gapped
    # targets can't run the single unified entry.
    $script:content | Should -Match 'upgrade-agent\.ps1' `
      'build must stage upgrade-agent.ps1 (unified install/update entry, center-symmetry contract).'
  }

  It 'stages start.bat (operator-facing wrapper, no PowerShell execution-policy friction)' {
    # 2026-08-23: start.bat is the recommended operator-facing entry —
    # a thin .bat wrapper that calls upgrade-agent.ps1 with -ExecutionPolicy
    # Bypass. Without it, operators have to remember the long PowerShell
    # invocation. The build must bundle it at <green>/ root.
    $script:content | Should -Match 'start\.bat' `
      'build must stage start.bat (operator-facing entry that hides PS execution-policy friction).'
  }

  It 'stages nssm.exe at <green>/nssm/nssm.exe' {
    # NSSM.psm1::Get-NssmPath searches <root>/nssm/ (NSSM.psm1:30-37) — placing
    # nssm at <green>/nssm/ is the cheapest matching layout. install-agent.ps1
    # dot-sources common/Ensure-Nssm.ps1 which would download NSSM if missing,
    # but staging it avoids the network call on first install.
    $script:content | Should -Match "nssm\.exe" `
      'build-green-package.ps1 must stage nssm.exe (used by NSSM.psm1).'
  }

  It 'does NOT pre-install node_modules (install-agent.ps1 handles it on target)' {
    # 2026-08-23: green package now ships WITHOUT node_modules. install-agent.ps1
    # unconditionally runs `npm install --omit=dev` on the target machine.
    # Rationale: ~50 MB double-source-of-truth + platform-ABI drift risk +
    # lockfile drift from the monorepo root. Target's npm is the single
    # resolver. Guard: NO actual `npm install` invocation exists in this
    # script (the comment block above mentions it; we match the specific
    # invocation signature with the production-only + no-audit + no-fund
    # flags that only existed in the live code, not comments).
    $script:content | Should -Not -Match 'npm\s+install\s+--omit=dev\s+--no-audit\s+--no-fund' `
      'green package build must NOT run `npm install --omit=dev --no-audit --no-fund` — target machine handles dep construction.'
    $script:content | Should -Not -Match '\[switch\]\$SkipNpmInstall' `
      '-SkipNpmInstall switch is gone (no npm install to skip).'
  }

  It 'does NOT stage agent/package-lock.json (target machine resolves fresh)' {
    # Same rationale as above. Robocopy /XF "package-lock.json" already drops it;
    # this test guards against a future change accidentally copying the root
    # monorepo lockfile (which has workspaces refs that don't apply to a
    # standalone install).
    $script:content | Should -Match 'package-lock\.json' `
      'package-lock.json reference must exist in robocopy /XF exclusion.'
    $script:content | Should -Not -Match "Copy-Item.*root.*lockfile" `
      'build-green-package.ps1 must NOT copy the root monorepo lockfile into the green package — agent/ is a standalone install target.'
  }

  It 'outputs publish/installer/agentInstall/ + .zip' {
    $script:content | Should -Match 'agentInstall' `
      'final output must be named agentInstall (folder + zip).'
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

  It 'documents install + uninstall commands at agentInstall/ root (no scripts/ prefix)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md') -Raw
    $content | Should -Match 'install-agent\.ps1' `
      'green README must include the install-agent.ps1 invocation.'
    $content | Should -Match 'uninstall-agent\.ps1' `
      'green README must include the uninstall-agent.ps1 invocation.'
    # 2026-08-23 flatten: operator runs `& C:\green\agentInstall\install-agent.ps1`,
    # NOT `& C:\green\agentInstall\scripts\install-agent.ps1`. The README
    # docstring must reflect the new layout or operators on the target machine
    # will fail with "file not found".
    $content | Should -Not -Match 'agentInstall\\scripts\\install-agent\.ps1' `
      'green README must NOT reference the old agentInstall\scripts\install-agent.ps1 path — flatten landed 2026-08-23.'
    $content | Should -Not -Match 'agentInstall\\scripts\\uninstall-agent\.ps1' `
      'green README must NOT reference the old agentInstall\scripts\uninstall-agent.ps1 path — flatten landed 2026-08-23.'
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
