# verify-agentInstall.ps1 — assert publish/installer/agentInstall/agent/
# is byte-identical to source agent/.
#
# Companion to installer/sync-agentInstall.ps1: after every sync, run
# this and the only acceptable outcome is 0 drift. If drift is non-zero,
# either (a) source agent/ was edited without re-running sync-agentInstall
# or (b) someone hand-edited publish/installer/agentInstall/. Both must
# fail CI / pre-commit — the agent green package ships to customer machines
# and a drift from source means real customers get a build that no longer
# matches what the dev tree tested.
#
# Excludes (must match sync-agentInstall.ps1's exclusion list exactly):
#   - tests/             (source never includes them; mirror must not either)
#   - appsettings.json   (per-host runtime config, dev-Box specific)
#   - package-lock.json  (npm resolves fresh on the target)
#   - queue.db*          (runtime SQLite WAL from local agent runs)
#   - node_modules/      (DEPLOYED FROM DEV BOX, not byte-equal with source:
#                         agent/node_modules is gitignored at the source tree,
#                         and the mirror's node_modules is built once on the dev
#                         box then shipped pre-built — see sync-agentInstall.ps1
#                         step 1.5 / R91.x). Hash-comparing these is meaningless
#                         because the source's node_modules may not exist at all
#                         or may be partial from an earlier dev session; the
#                         canonical tree lives only at <green>/agent/node_modules.
#
# Companion tools (start.ps1, install-agent.ps1, Register-*.ps1,
# uninstall-agent.ps1, common/*, README-green-install.md) live at
# publish/installer/agentInstall/ root and come from scripts/ +
# installer/ — they're verified by file-level existence checks below,
# not a full hash compare (the source-side scripts/ files are tracked
# elsewhere; this script just asserts the green-bundle FILES are present
# and not stale).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $root 'publish\installer\agentInstall\agent'
$bundleDst = Join-Path $root 'publish\installer\agentInstall'

$pass = 0
$drift = 0
$missing = 0
$fail = $false

function Pair-Line($n, $ok, $detail) {
  $status = if ($ok) { 'PASS' } else { "FAIL $detail" }
  $line = "{0,-86} {1}" -f $n, $status
  if ($ok) {
    Write-Host $line
  } else {
    Write-Host $line -ForegroundColor Red
    $script:fail = $true
  }
}

# Sanity: source and destination must both exist.
if (-not (Test-Path $agentSrc)) {
  Pair-Line 'source agent/' $false "missing: $agentSrc"
  exit 1
}
if (-not (Test-Path $agentDst)) {
  Pair-Line 'mirror publish/installer/agentInstall/agent/' $false "missing: $agentDst (run installer/sync-agentInstall.ps1)"
  exit 1
}

# Excludes applied to BOTH source scan and destination scan (must match
# sync-agentInstall.ps1's exclusion list — if they diverge, the verify
# either reports phantom drift or misses real drift).
$excludeDirs = @('tests', 'node_modules')
$excludeFiles = @('appsettings.json', 'package-lock.json')  # + 'queue.db*' glob below

# Build source rel-path set with excludes applied.
$srcRelSet = @{}
Get-ChildItem -LiteralPath $agentSrc -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = $_.FullName.Substring($agentSrc.Length).TrimStart('\', '/').Replace('\', '/')
  $skip = $false
  foreach ($xd in $excludeDirs) {
    if ($rel -match ("(?:^|/){0}/" -f [regex]::Escape($xd))) { $skip = $true; break }
  }
  if (-not $skip) {
    foreach ($xf in $excludeFiles) {
      if ($rel -eq $xf -or $rel.EndsWith("/$xf")) { $skip = $true; break }
    }
  }
  if (-not $skip -and $rel -notmatch '^queue\.db') {
    $srcRelSet[$rel] = $_.FullName
  }
}

# Build destination rel-path set with same excludes.
$dstRelSet = @{}
Get-ChildItem -LiteralPath $agentDst -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = $_.FullName.Substring($agentDst.Length).TrimStart('\', '/').Replace('\', '/')
  $skip = $false
  foreach ($xd in $excludeDirs) {
    if ($rel -match ("(?:^|/){0}/" -f [regex]::Escape($xd))) { $skip = $true; break }
  }
  if (-not $skip) {
    foreach ($xf in $excludeFiles) {
      if ($rel -eq $xf -or $rel.EndsWith("/$xf")) { $skip = $true; break }
    }
  }
  if (-not $skip -and $rel -notmatch '^queue\.db') {
    $dstRelSet[$rel] = $_.FullName
  }
}

# Hash-compare each source file to its mirror.
foreach ($rel in ($srcRelSet.Keys | Sort-Object)) {
  $srcFile = $srcRelSet[$rel]
  if (-not $dstRelSet.ContainsKey($rel)) {
    Pair-Line "agent/$rel" $false "missing from publish/installer/agentInstall/agent/"
    $missing++
    continue
  }
  $dstFile = $dstRelSet[$rel]
  $srcHash = (Get-FileHash -LiteralPath $srcFile -Algorithm SHA256).Hash
  $dstHash = (Get-FileHash -LiteralPath $dstFile -Algorithm SHA256).Hash
  if ($srcHash -eq $dstHash) {
    $pass++
  } else {
    Pair-Line "agent/$rel" $false "drift (src=$srcHash dst=$dstHash)"
    $drift++
  }
}

# Orphan detection: destination files with no source counterpart (excluding
# the same set we excluded from source — symmetric by construction above).
foreach ($rel in ($dstRelSet.Keys | Sort-Object)) {
  if (-not $srcRelSet.ContainsKey($rel)) {
    Pair-Line "agent/$rel" $false "orphan in publish/installer/agentInstall/agent/ (no source counterpart)"
    $missing++
  }
}

# Companion files at agentInstall/ root. Just assert presence — hash
# compare against scripts/ + installer/ is done by other verify scripts
# (sync-scripts-mirror / sync-source-mirror). The list here is the
# canonical install surface; missing one means an operator's
# `& C:\green\agentInstall\<missing>.ps1` fails.
$expectedCompanions = @(
  'install-agent.ps1',
  'uninstall-agent.ps1',
  'Register-ADDashboardAgent.ps1',
  'start.ps1',
  'README-green-install.md'
)
foreach ($f in $expectedCompanions) {
  $p = Join-Path $bundleDst $f
  if (Test-Path -LiteralPath $p) {
    $pass++
  } else {
    Pair-Line "publish/installer/agentInstall/$f" $false "missing — operator entry point"
    $missing++
  }
}

# common/ sibling — assert at least the canonical modules are present.
$commonExpected = @('Logger.psm1','NSSM.psm1','Service.psm1','Ensure-Nssm.ps1','Ensure-Node.ps1')
foreach ($f in $commonExpected) {
  $p = Join-Path $bundleDst "common\$f"
  if (Test-Path -LiteralPath $p) {
    $pass++
  } else {
    Pair-Line "publish/installer/agentInstall/common/$f" $false "missing — install script dependency"
    $missing++
  }
}

# Bundled Node.js portable — install-agent.ps1:R204-228 invokes
# `& $nodeDst/npm.cmd install --omit=dev` on the target machine. npm.cmd
# internally runs `node node_modules/npm/bin/npm-cli.js`; that file MUST
# be present. A stripped binaries-only copy (just node.exe + npm.cmd,
# no node_modules/) dies on the target machine with MODULE_NOT_FOUND
# (KDLFLOFADSRV2 install 2026-09-24). Verify the four files that
# npm.cmd's bootstrap path requires.
$nodeMustExist = @('node\node.exe', 'node\npm.cmd', 'node\node_modules\npm\bin\npm-cli.js', 'node\node_modules\npm\bin\npm-prefix.js')
foreach ($rel in $nodeMustExist) {
  $p = Join-Path $bundleDst $rel
  if (Test-Path -LiteralPath $p) {
    $pass++
  } else {
    Pair-Line "publish/installer/agentInstall/$rel" $false "missing — npm install on target will fail with MODULE_NOT_FOUND"
    $missing++
  }
}

# nssm.exe — Register-ADDashboardAgent.ps1:R82-89 candidate list searches
# `<green>/nssm/nssm.exe` second (green-package layout). KDLFLOFADSRV2
# install 2026-09-24 hit "nssm.exe not found" because R90 sync-agentInstall
# did not stage nssm into the bundle — R91.1 ships it. Verify the canonical
# nssm exe path is in place so the SCM-facing Register step doesn't bail
# during install (the operator-side fallback `$InstallPath\nssm\nssm.exe`
# would also work once install-agent copies it from `<green>/nssm/`, but
# the green-package layout only requires the green-bundle path).
$nssmBundlePath = Join-Path $bundleDst 'nssm\nssm.exe'
if (Test-Path -LiteralPath $nssmBundlePath) {
  $pass++
} else {
  Pair-Line 'publish/installer/agentInstall/nssm/nssm.exe' $false "missing — Register-ADDashboardAgent.ps1 needs it to install the ADReplicationAgent service"
  $missing++
}

Write-Host ""
Write-Host ("verify-agentInstall: {0} pass, {1} drift, {2} missing" -f $pass, $drift, $missing)
if ($fail -or $drift -gt 0 -or $missing -gt 0) {
  exit 1
}
exit 0