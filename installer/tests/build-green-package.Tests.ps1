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

  It 'stages start.ps1 (unified install/update + operator-facing entry)' {
    # 2026-08-23: start.ps1 is the operator-facing entry that auto-detects
    # install vs hot-update. The green package must bundle it at <green>/
    # root alongside install-agent.ps1 / uninstall-agent.ps1 /
    # Register-ADDashboardAgent.ps1. Without it, operators on air-gapped
    # targets can't run the single unified entry. The .bat wrapper was
    # removed in 2026-08-23 because CMD → powershell.exe hop could break
    # Read-Host console attachment (operator-side freeze on first install).
    $script:content | Should -Match 'start\.ps1' `
      'build must stage start.ps1 (unified install/update + operator-facing entry).'
    $script:content | Should -Not -Match 'start\.bat' `
      'build must NOT stage start.bat anymore — operator entry is start.ps1.'
  }

  It 'agentInstall/start.ps1 is the AGENT unified entry (not the center entry)' {
    # 2026-08-25 regression guard: c7964e4 + earlier center-side commits
    # overwrote publish/installer/agentInstall/start.ps1 with the center-side
    # start.ps1 (because both files share the basename). The center script
    # probes Get-Service ADDashboardCenter and calls install-center.ps1;
    # running that on a DC trying to install the agent fails with
    # `install-center.ps1 not found` because the agent bundle has no
    # scripts/ subdir. The agent start.ps1 must reference ADReplicationAgent
    # (the agent service name) and install-agent.ps1 (the agent installer).
    $stagedStart = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish/installer/agentInstall/start.ps1'
    Test-Path $stagedStart | Should -BeTrue `
      'agentInstall/start.ps1 must exist (staged by build).'
    $stagedContent = Get-Content -LiteralPath $stagedStart -Raw
    $stagedContent | Should -Match 'ADReplicationAgent' `
      'agentInstall/start.ps1 must reference the agent service (ADReplicationAgent), not ADDashboardCenter — the center start.ps1 was mistakenly synced here.'
    $stagedContent | Should -Match 'install-agent\.ps1' `
      'agentInstall/start.ps1 must reference the agent installer (install-agent.ps1).'
    $stagedContent | Should -Not -Match 'ADDashboardCenter' `
      'agentInstall/start.ps1 must NOT reference ADDashboardCenter — that is the center service name and means the center start.ps1 leaked into the agent bundle.'

    # Source parity guard: the staged file must be byte-identical to
    # scripts/start.ps1. Any future edit to scripts/start.ps1 must also
    # update the bundle (run build-green-package.ps1) — drift here means
    # operators get the wrong version.
    $srcStart = Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'scripts/start.ps1'
    Test-Path $srcStart | Should -BeTrue `
      'scripts/start.ps1 (the agent unified entry) must exist.'
    $srcHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcStart).Hash
    $stagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedStart).Hash
    $stagedHash | Should -Be $srcHash `
      "agentInstall/start.ps1 must be byte-identical to scripts/start.ps1 (staged=$stagedHash src=$srcHash). Re-run installer/build-green-package.ps1 to refresh."
  }

  It 'stages nssm.exe at <green>/nssm/nssm.exe' {
    # NSSM.psm1::Get-NssmPath searches <root>/nssm/ (NSSM.psm1:30-37) — placing
    # nssm at <green>/nssm/ is the cheapest matching layout. install-agent.ps1
    # dot-sources common/Ensure-Nssm.ps1 which would download NSSM if missing,
    # but staging it avoids the network call on first install.
    $script:content | Should -Match "nssm\.exe" `
      'build-green-package.ps1 must stage nssm.exe (used by NSSM.psm1).'
  }

  It 'stages bundled Node.js 20 LTS at <green>/node/ (no target-machine pre-req)' {
    # 2026-08-23: green package now bundles Node 20 LTS so air-gapped targets
    # don't need a separate Node install (matches MSI behavior, removes
    # operator-side "Node not found" freeze). Source = publish/system/node/
    # (downloaded by Ensure-Node.ps1, gitignored as 85 MB binary). install-
    # agent.ps1 then copies this to <InstallPath>\node\ at install time.
    $script:content | Should -Match 'publish\\system\\node' `
      'Node source must be publish/system/node/ (single source of truth, downloaded by Ensure-Node.ps1).'
    $script:content | Should -Match "Ensure-Node\.ps1" `
      'Node staging must auto-bootstrap via Ensure-Node.ps1 when publish/system/node/node.exe is missing — operators should not have to run it manually before the build.'
    $script:content | Should -Match 'robocopy.*\$nodeSrc.*\$nodeDst.*/MIR' `
      'Node staging must use robocopy /MIR (preserves directory layout, mirrors npm.cmd / node_modules/).'
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

  It 'documents bundled Node.js 20 LTS (no target-machine Node pre-req)' {
    # 2026-08-23: green package now bundles Node.js 20 LTS at <green>/node/,
    # so air-gapped targets don't need a separate Node install (matches MSI
    # behavior). The pre-req table must NOT list Node.js — bundling makes
    # the operator-side install zero-friction.
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'README-green-install.md') -Raw
    $content | Should -Match 'Node\.js' `
      'green README must mention Node.js (now bundled, not a pre-req).'
    $content | Should -Match '20' `
      'green README must specify Node.js 20 LTS as the bundled version.'
    $content | Should -Match '自带|内嵌' `
      'green README must state Node is bundled/embedded (not a pre-req).'
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
