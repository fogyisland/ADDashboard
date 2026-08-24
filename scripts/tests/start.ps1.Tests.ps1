BeforeAll {
  $scriptPath = "$PSScriptRoot/../start.ps1"
  $content     = Get-Content -LiteralPath $scriptPath -Raw
}

Describe 'start.ps1' {
  It 'is parseable PowerShell' {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'declares the unified-entry parameters' {
    # -InstallPath: agent install root (C:\addashboard\Agent\) — same convention
    #              as install-agent.ps1 + Register-ADDashboardAgent.ps1.
    # -ComputerName: optional; auto-defaults to $env:COMPUTERNAME for local
    #                interactive first-time install. Operators pass it for
    #                remote / batch upgrades.
    # -CenterUrl + -AgentToken: optional; prompted via Read-Host when missing
    #                during a first-time install. The script stays automation-
    #                friendly for WinRM / scheduled jobs by accepting them
    #                on the command line.
    # -AgentType: 'ad' (default) | 'non-ad' — T16 discriminator.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $paramBlock = $ast.ParamBlock
    $paramBlock | Should -Not -BeNullOrEmpty
    $paramNames = $paramBlock.Parameters.Name.VariablePath.UserPath
    $paramNames | Should -Contain 'InstallPath'
    $paramNames | Should -Contain 'ComputerName'
    $paramNames | Should -Contain 'CenterUrl'
    $paramNames | Should -Contain 'AgentToken'
    $paramNames | Should -Contain 'AgentType'
  }

  It 'resolves InstallPath from $PSScriptRoot (no [CmdletBinding()] default that would be evaluated in child scope)' {
    # Bug fixed 2026-08-16: [CmdletBinding()] default param values evaluate in
    # parameter binding scope (child of script scope); automatic variables like
    # $PSScriptRoot are only set in script scope → empty in defaults → Join-Path
    # '..' fails with empty Path. Guard: (a) InstallPath param has NO default
    # value, (b) body resolves the default in script scope via an if-guard.
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
    $installPathParam = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallPath' }
    $installPathParam.DefaultValue | Should -BeNullOrEmpty `
      '[CmdletBinding()] default param values evaluate in child scope where $PSScriptRoot is empty; default must be resolved in the body.'
    $content | Should -Match 'if\s*\(\s*-not\s+\$InstallPath\s*\)' `
      'body must guard with `if (-not $InstallPath)` to resolve the default in script scope.'
    $content | Should -Match 'Join-Path.*[Aa]gent' `
      'body must Join-Path to the Agent/agent subdirectory (script-relative install root).'
    $content | Should -Not -Match 'C:\\addashboard\\Agent' `
      'script must not hardcode C:\addashboard\Agent — must be script-relative.'
  }

  It 'defaults InstallPath to the lowercase agent/ dir on green-pkg layout (in-place install)' {
    # 2026-08-24 (round 5): The previous default of $PSScriptRoot/Agent/ (capital A)
    # case-collided with $PSScriptRoot/agent/ on Windows and resolved
    # $InstallPath/node to a non-existent agent/node path. The bundled Node
    # is at $PSScriptRoot/node (sibling of agent/), NOT inside agent/. The
    # fix is to make InstallPath = $greenPkgAgent directly: agent.js +
    # appsettings.json + src/ + scripts/ + package.json all live inside
    # agent/, so AppDirectory = $InstallPath and AppParameters = 'agent.js'
    # resolve correctly. NSSM's node path comes from the bundled
    # $PSScriptRoot/node — start.ps1 / install-agent.ps1 redirect $nodeDst
    # to $bundledSrc when src==dst so PATH prepend + npm.cmd work.
    $content | Should -Match '\$InstallPath\s*=\s*\$greenPkgAgent' `
      'green-pkg default must assign InstallPath = $greenPkgAgent (lowercase), not $PSScriptRoot/Agent/.'
    # Single quotes to prevent $PSScriptRoot interpolation. The legacy form
    # is the literal `$InstallPath = Join-Path $PSScriptRoot 'Agent'`
    # (capital A, no parent resolution). Dev-tree default uses
    # `Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent'`
    # which is a different shape — that pattern must remain allowed.
    $content | Should -Not -Match 'InstallPath\s*=\s*Join-Path\s+\$PSScriptRoot\s+''Agent''' `
      'green-pkg default must NOT use the legacy `$InstallPath = Join-Path $PSScriptRoot ''Agent''` form (capital A, case-collision trap).'
  }

  It 'redirects $nodeDst to $bundledSrc when src==dst (in-place green-pkg install)' {
    # 2026-08-24 (round 5): When InstallPath IS agent/ (in-place install),
    # $InstallPath/node resolves to agent/node — a non-existent path. The
    # bundled Node is at $PSScriptRoot/node (sibling), so $nodeDst must
    # point at the bundled dir for PATH prepend + npm.cmd invocation to
    # work. The script must compute $nodeDst conditionally on $srcEqDst,
    # not unconditionally from $InstallPath.
    $content | Should -Match '\$nodeDst\s*=\s*if\s*\(\s*\$srcEqDst\s*\)\s*\{\s*\$bundledGreenNodeDir\s*\}\s*else\s*\{\s*Join-Path\s+\$InstallPath\s+''node''' `
      'hot-update must compute $nodeDst as `if ($srcEqDst) { $bundledGreenNodeDir } else { Join-Path $InstallPath node }`.'
  }

  It 'auto-detects install state via Get-Service ADReplicationAgent' {
    # The script's whole point is to do "install if missing, update if present"
    # automatically. The detection must be the canonical service-registered
    # check (not file-presence at $InstallPath) because file presence is
    # ambiguous after a partial install.
    $content | Should -Match 'Get-Service\s+-Name\s+\$ServiceName' `
      'script must probe service registration via Get-Service -Name $ServiceName (canonical detection).'
    $content | Should -Match "'ADReplicationAgent'" `
      'service name must match the MSI / green-package contract — ADReplicationAgent.'
  }

  It 'prompts for CenterUrl + AgentToken interactively on first-time install' {
    # User-facing requirement (2026-08-23): when the script detects no service
    # is registered AND the operator didn't pass -CenterUrl/-AgentToken, it
    # prompts in the PowerShell terminal so a single `.\start.ps1`
    # works without parameter bookkeeping.
    #
    # Token MUST be -AsSecureString so it doesn't echo on screen. Conversion
    # back to plain text is required because Register-ADDashboardAgent.ps1
    # writes appsettings.json in plain text (same boundary applies whether
    # the token came from Read-Host or from a script parameter).
    $content | Should -Match 'Read-Host\s+\x27Enter CenterUrl' `
      'first-time install must prompt for CenterUrl via Read-Host when -CenterUrl not passed.'
    $content | Should -Match 'Read-Host\s+-AsSecureString\s+\x27Enter AgentToken' `
      'first-time install must prompt for AgentToken via Read-Host -AsSecureString (no echo).'
    $content | Should -Match 'SecureStringToBSTR' `
      'SecureString must be converted back to plain text at the script boundary (appsettings.json stores it as plain text).'
    $content | Should -Match 'ZeroFreeBSTR' `
      'BSTR must be zero-freed to avoid leaving the token in process memory longer than needed.'
  }

  It 'delegates first-time install to install-agent.ps1 (no duplication)' {
    # The script's value is dispatching to the right existing flow. First-time
    # install goes through install-agent.ps1 → Register-ADDashboardAgent.ps1
    # (single registration entry point). We do NOT inline the SCM-facing
    # logic here.
    $content | Should -Match 'install-agent\.ps1' `
      'first-time path must invoke install-agent.ps1 (delegates the SCM-facing work).'
    # The script DOES mention `appsettings.json` in the Copy-Item -Exclude list
    # (preserve the live token during hot-update), so we can't assert "no
    # mention". We assert no WRITE pattern (ConvertTo-Json | Set-Content) and
    # no Register-ADDashboardAgent.ps1 import — those would mean the script
    # is duplicating SCM logic instead of delegating.
    $content | Should -Not -Match 'ConvertTo-Json\s*\|\s*Set-Content' `
      'start.ps1 must NOT write appsettings.json via ConvertTo-Json | Set-Content — that lives in Register-ADDashboardAgent.ps1.'
    # 2026-08-24 (round 5): the new comments reference Register-ADDashboardAgent.ps1
    # in passing (e.g., "NSSM's AppDirectory + AppParameters='agent.js' contract
    # (Register-ADDashboardAgent.ps1:184-185)..."). The legacy assertion
    # `Should -Not -Match 'Register-ADDashboardAgent\.ps1'` would falsely
    # match those comments. Restrict to executable references: invocation
    # forms (`& Register-…`, `.\Register-…`, `Invoke-… -FilePath Register-…`).
    # Doc-comment mentions are still allowed.
    $content | Should -Not -Match '(?m)^(?!\s*#).*&\s+.*Register-ADDashboardAgent' `
      'start.ps1 must NOT call Register-ADDashboardAgent.ps1 via `&` — install-agent.ps1 owns that delegation.'
    $content | Should -Not -Match '(?m)^(?!\s*#).*Register-ADDashboardAgent\.ps1' `
      'start.ps1 must NOT reference Register-ADDashboardAgent.ps1 outside comments — install-agent.ps1 owns that delegation.'
  }

  It 'always restarts on hot update (no hash-skip)' {
    # Per 2026-08-23 design: hot-update path unconditionally stop → copy →
    # npm install → start. Hash-skip was considered and rejected (stale lockfile
    # risk on partial installs outweighs the npm-install savings; operators
    # who run start.ps1 expect something to actually update).
    $content | Should -Match 'Stop-Service\s+-Name\s+\$ServiceName' `
      'hot-update must stop the service via Stop-Service (not via NSSM stop).'
    # 2026-08-23 (round 4): npm invoked by absolute path (`& $npmCmd install ...`)
    # for ABI safety — bare `npm install` on PATH was unreliable. Match the
    # flag combo via regex so the path-invocation form is what's asserted.
    # 2026-08-24 (round 5): also exclude doc-comment lines so the regex
    # doesn't match the explanatory comment block above the install.
    $content | Should -Match '(?m)^(?!\s*#).*\$npmCmd\s+install\s+--omit=dev\s+--no-audit\s+--no-fund' `
      'hot-update must always run npm install --omit=dev (no hash-skip gate).'
    $content | Should -Match 'Start-Service\s+-Name\s+\$ServiceName' `
      'hot-update must start the service via Start-Service.'
  }

  It 'pre-flights Node.js before delegating (bundled → installed → PATH, fail fast if none)' {
    # 2026-08-23: green package now bundles Node.js 20 LTS at <green>/node/
    # (see installer/build-green-package.ps1 step 4 — was a target-machine
    # pre-req before, now bundled for air-gapped parity with MSI). The
    # resolution order is: bundled green-package node → already-installed node
    # → PATH fallback → throw. Pre-flight runs BEFORE the CenterUrl/AgentToken
    # prompts so the operator doesn't type creds only to discover Node is
    # missing.
    $content | Should -Match 'bundledGreenNode' `
      'start.ps1 must probe <green>/node/node.exe first (green-package bundled Node).'
    $content | Should -Match 'bundledInstalledNode' `
      'start.ps1 must probe <InstallPath>/node/node.exe second (already-installed node from prior install).'
    $content | Should -Match 'Get-Command\s+node\.exe' `
      'start.ps1 must fall back to PATH-resolved node.exe when no bundled node exists.'
    $content | Should -Match 'node\.exe not found' `
      'start.ps1 must throw a friendlier error than the raw CommandNotFoundException if no Node is found anywhere.'
    # Order: Node check must appear BEFORE Read-Host CenterUrl + Read-Host -AsSecureString.
    $nodeIdx   = $content.IndexOf('bundledGreenNode')
    $centerIdx = $content.IndexOf("Read-Host 'Enter CenterUrl")
    $tokenIdx  = $content.IndexOf("Read-Host -AsSecureString 'Enter AgentToken'")
    $nodeIdx   | Should -BeGreaterOrEqual 0
    $centerIdx | Should -BeGreaterOrEqual 0
    $tokenIdx  | Should -BeGreaterOrEqual 0
    $nodeIdx   | Should -BeLessThan $centerIdx `
      'Node pre-flight must run BEFORE CenterUrl prompt — fail fast.'
    $nodeIdx   | Should -BeLessThan $tokenIdx `
      'Node pre-flight must run BEFORE AgentToken prompt — fail fast.'
  }

  It 'refreshes bundled Node.js during hot-update (mirrors <green>/node/ → <InstallPath>/node/)' {
    # 2026-08-23: green package bumps the bundled Node 20 patch between
    # releases. Hot-update must mirror the green-package node dir to the
    # install path so the running node tracks the bundle's pinned version.
    # robocopy /MIR is idempotent on identical bytes.
    $content | Should -Match 'refreshing bundled Node\.js' `
      'hot-update must refresh bundled Node.js to track green-package version bumps.'
    # Variable name was $bundledGreenNode in early iterations, renamed to
    # $bundledGreenNodeDir to disambiguate from the pre-flight's file-suffixed
    # $bundledGreenNode. Match either — test shouldn't lock cosmetic naming.
    $content | Should -Match 'robocopy\s+\$bundledGreenNode\w*\s+\$nodeDst\s+/MIR' `
      'hot-update Node refresh must use robocopy /MIR for idempotent mirror copy.'
  }

  It 'prepends <InstallPath>/node/ to PATH before npm install (ABI parity with NSSM)' {
    # 2026-08-23 fix: without this, npm install resolves against PATH's
    # Node (could be a different version, or absent on air-gapped targets).
    # NSSM launches <InstallPath>/node/node.exe; if node_modules was rebuilt
    # against PATH's Node, native deps (better-sqlite3) crash at load time.
    $content | Should -Match '\$env:PATH\s*=\s*\$nodeDst\s*\+\s*\[IO\.Path\]::PathSeparator' `
      'hot-update must prepend <InstallPath>/node/ to $env:PATH before npm install (avoids ABI drift).'
    # Order: $env:PATH prepend must appear AFTER robocopy refresh (need $nodeDst to exist) but BEFORE npm install.
    # 2026-08-23 (round 4): npm invocation switched to `& $npmCmd install ...`
    # (absolute path) — match that form, not bare `npm install`.
    $prependIdx = $content.IndexOf('$env:PATH = $nodeDst')
    $npmIdx     = $content.IndexOf('$npmCmd install')
    $prependIdx | Should -BeGreaterOrEqual 0
    $npmIdx     | Should -BeGreaterOrEqual 0
    $prependIdx | Should -BeLessThan $npmIdx `
      'PATH prepend must run BEFORE npm install — otherwise npm uses PATH node, not bundled node.'
  }

  It 'excludes Logs/ from the hot-update copy (avoids overwriting open install.log)' {
    # 2026-08-23: same fix as install-agent.ps1 — Logger opens
    # <InstallPath>/Logs/install.log for write, so Copy-Item must NOT try
    # to overwrite it from a source agent/Logs/ leftover. Logs/ is
    # runtime state that the running agent regenerates; excluding it from
    # the source copy is also defensive against stale local-run artifacts.
    # Copy-Item spans 2 lines via line-continuation backtick, so the regex
    # uses a non-greedy match across whitespace rather than requiring a
    # single line.
    $content | Should -Match 'Copy-Item[\s\S]{0,200}agentSrc[\s\S]{0,200}-Exclude[\s\S]{0,80}\x27Logs\x27' `
      'hot-update Copy-Item -Exclude MUST include Logs/ — otherwise the open install.log gets overwritten.'
  }

  It 'skips code copy when source and install path resolve to the same directory (Windows case-collision)' {
    # 2026-08-23: Mirrors install-agent.ps1 fix. Hot-update hits the same
    # case-collision trap when the operator's green-package root has
    # "agent" + "Agent" siblings that Windows case-insensitive FS folds
    # into one dir. Resolve-Path + OrdinalIgnoreCase detect it; Copy-Item
    # is gated behind an if/else.
    $content | Should -Match 'Resolve-Path\s+-LiteralPath\s+\$agentSrc' `
      'start.ps1 hot-update must Resolve-Path $agentSrc to detect case-collision.'
    $content | Should -Match 'OrdinalIgnoreCase' `
      'case-collision check must use OrdinalIgnoreCase (Windows FS is case-insensitive).'
    $content | Should -Match 'skipping code copy' `
      'when src==dst, hot-update must log a skip message.'
  }

  It 'also gates the single-file collect-replication.ps1 copy behind the case-collision check' {
    # 2026-08-23 (round 2): the recursive Copy-Item is gated, but the
    # single-file Copy-Item for collect-replication.ps1 must ALSO be
    # gated — otherwise hot-update hits the same self-overwrite error on
    # the very next Copy-Item. Match: the single-file Copy-Item lives
    # inside the else branch ($srcEqDst false).
    $content | Should -Match 'src==dst.*skipping collect-replication' `
      'single-file Copy-Item must log a skip when src==dst.'
  }

  It 'also gates the bundled Node refresh behind the case-collision check' {
    # 2026-08-23 (round 3): robocopy /MIR with identical src and dst is
    # undefined behavior (typically exit code 1 with "Extra files detected"),
    # and on some Windows builds it can hang or fail noisily. Skip the Node
    # refresh entirely when src==dst — the bundled node is already at
    # <InstallPath>/node/ via the case-collision, no copy needed.
    $content | Should -Match 'src==dst.*skipping Node refresh|skipping Node refresh' `
      'Node refresh must be skipped when src==dst (robocopy with identical src/dst is undefined).'
  }

  It 'invokes npm.cmd by absolute path in hot-update (not bare `npm` on PATH)' {
    # 2026-08-23 (round 4): real install on KDLWXOFADSRV1 hit "npm not
    # recognized" even when $nodeDst was prepended to PATH. PowerShell's
    # PATH resolution missed the bundled npm.cmd. Robust fix: invoke
    # `& $nodeDst/npm.cmd ...` to bypass PowerShell's command lookup.
    # Mirrors install-agent.ps1's identical fix.
    $content | Should -Match '\$npmCmd\s*=\s*Join-Path\s+\$nodeDst\s+''npm\.cmd''' `
      'start.ps1 must compute $npmCmd from $nodeDst (absolute path) instead of relying on PATH-resolved `npm`.'
    $content | Should -Match 'Test-Path\s+-LiteralPath\s+\$npmCmd' `
      'start.ps1 must Test-Path -LiteralPath $npmCmd before invoking.'
    # Exclude comment lines (start with optional whitespace + #).
    $content | Should -Not -Match '(?m)^(?!\s*#)\s*\bnpm\s+install' `
      'start.ps1 must NOT call bare `npm install` (must use `& $npmCmd install`). Comments are allowed.'
  }

  It 'logs thrown errors to install.log via a trap that calls Write-Err2 then re-throws' {
    # 2026-08-24: Without a trap, throws only reach the console + NSSM's
    # stderr capture — NOT install.log. Operators investigating "started
    # then stopped" had to cross-reference two logs to find the root
    # cause. Fix: install a `trap { Write-Err2 ... ; continue }` right
    # after Import-Module Logger.psm1, BEFORE any code that can throw.
    # `continue` re-throws so the script still exits with the error
    # (preserves $LASTEXITCODE for callers); the trap handler leaves a
    # breadcrumb in install.log first.
    $content | Should -Match 'trap\s*\{' `
      'start.ps1 must install a trap handler so thrown errors reach install.log.'
    $content | Should -Match 'Write-Err2' `
      'trap must call Write-Err2 (the ERROR-level Write-Log wrapper in Logger.psm1; the `2` suffix disambiguates from the built-in Write-Error cmdlet).'
    $content | Should -Match 'continue' `
      'trap must `continue` after logging so the error still propagates (preserves $LASTEXITCODE for callers).'
    # The trap must come AFTER Import-Module (Write-Err2 is module-scoped,
    # resolves only after Logger.psm1 loads). And BEFORE the InstallPath
    # default-resolution throw — early throws must still get logged so a
    # broken bundle isn't silent. Match the throw statement's unique
    # trailing phrase ("Tried '...' (green-package layout)") to avoid
    # matching the explanatory comment that mentions "agent/ source not
    # found" too.
    $importIdx      = $content.IndexOf('Import-Module')
    $trapIdx        = $content.IndexOf('trap {')
    $installPathIdx = $content.IndexOf("if (-not `$InstallPath) {")
    $throwIdx       = $content.IndexOf('green-package layout)')
    $importIdx      | Should -BeGreaterOrEqual 0
    $trapIdx        | Should -BeGreaterOrEqual 0
    $installPathIdx | Should -BeGreaterOrEqual 0
    $throwIdx       | Should -BeGreaterOrEqual 0
    $trapIdx        | Should -BeGreaterThan $importIdx `
      'trap must be installed AFTER Import-Module (Write-Err2 is module-scoped).'
    $trapIdx        | Should -BeLessThan $installPathIdx `
      'trap must be installed BEFORE InstallPath resolution so early throws are caught.'
    $trapIdx        | Should -BeLessThan $throwIdx `
      'trap must precede the "agent/ source not found" throw so the breadcrumb lands in install.log.'
  }

  It 'sets LogDir BEFORE InstallPath is resolved (with $PSScriptRoot fallback)' {
    # 2026-08-24: with the trap installed early, LogDir must also be set
    # early so the trap's Write-Err2 call has a writable target. When
    # $InstallPath is not passed (first-time install path), fall back to
    # $PSScriptRoot\Logs\ — writable on both green-pkg (sibling of
    # start.ps1) and dev-tree (repo root) layouts. After InstallPath is
    # resolved, the script re-sets LogDir to <InstallPath>\Logs\ (canonical).
    $content | Should -Match '\$initialLogDir\s*=\s*if\s*\(\s*\$InstallPath\s*\)' `
      'start.ps1 must compute $initialLogDir conditionally on whether $InstallPath is passed.'
    $content | Should -Match 'Join-Path\s+\$PSScriptRoot\s+''Logs''' `
      'fallback LogDir must be $PSScriptRoot\Logs\ (sibling of start.ps1).'
    # Two Set-LogDir calls: early (initialLogDir) + canonical (after InstallPath).
    # Both required so early throws AND late throws land in the right place.
    $content | Should -Match 'Set-LogDir\s+\$initialLogDir' `
      'must call Set-LogDir $initialLogDir BEFORE InstallPath resolution.'
    $content | Should -Match 'Set-LogDir\s+\$Script:LogDir' `
      'must re-call Set-LogDir with canonical <InstallPath>\Logs\ after InstallPath is resolved.'
  }
}