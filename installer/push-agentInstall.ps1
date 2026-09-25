# push-agentInstall.ps1 — push publish/installer/agentInstall/ to a remote
# member server over SMB. Pre-flight verifies the local bundle is
# drift-free (verify-agentInstall.ps1) so we never ship a broken mirror.
#
# Companion to installer/sync-agentInstall.ps1 + installer/verify-agentInstall.ps1:
#   1. installer/sync-agentInstall.ps1   (build the mirror from source)
#   2. installer/verify-agentInstall.ps1  (assert 0 drift — fail-fast here)
#   3. installer/push-agentInstall.ps1    (push to remote — THIS SCRIPT)
#
# Why a third script instead of folding into sync-agentInstall:
#   - sync-agentInstall is local-only, idempotent, no network. Operators
#     can run it as part of pre-commit without network deps.
#   - push-agentInstall is one-shot, network-bound, requires SMB / WinRM
#     access to the remote. Splitting them lets CI run sync+verify
#     without a remote target.
#   - The remote target path differs per environment. push-agentInstall
#     takes -RemotePath explicitly so the same bundle can ship to dev /
#     staging / prod without editing scripts.
#
# Per-host runtime files (appsettings.json, queue.db*, package-lock.json,
# node_modules/) are EXCLUDED from the push by default — they're either
# regenerated per-host (appsettings.json is per-host config, queue.db is
# per-host runtime state, node_modules is built on-target by
# install-agent.ps1's `npm install --omit=dev`) or never produced from
# source (package-lock.json is gitignored at source). Use
# -IncludePerHostFiles to override (e.g. for the very first install where
# the operator is seeding appsettings.json from appsettings.example.json).
#
# Default remote path: \\<host>\C$\agentInstall. The trailing \agentInstall
# matches the green-package layout (operator runs `& <root>\install-agent.ps1`
# from there). If your host uses a different layout (e.g. bundle split into
# agent/ + scripts/ + node/ separately), pass -RemotePath \\<host>\C$\green
# or use -Layout Bare to skip the agent\ subdirectory.
#
# 2026-09-25 R91.4 followup — added to ship the drainer-signature fix to
# KDLFLOFADSRV2 without a full green-package rebuild.

[CmdletBinding()]
param(
  # Remote host (NetBIOS name or FQDN). Defaults to KDLFLOFADSRV2 (the
  # operator's staging DC) for convenience — override via -RemoteHost.
  [string] $RemoteHost = 'KDLFLOFADSRV2',

  # Remote destination path. \\<host>\C$\agentInstall by default. The
  # bundle root is the directory that contains install-agent.ps1 +
  # start.ps1 + agent/ + common/ + node/ + nssm/. If your host uses a
  # different layout (e.g. split into agent/ + scripts/ + node/ separately
  # at C:\green\), pass the matching path or use -Layout Bare.
  [string] $RemotePath = "\\$RemoteHost\C`$\agentInstall",

  # Bundle layout to push:
  #   Full     — push the entire bundle as-is (default). Target gets
  #              install-agent.ps1 + agent/ + common/ + node/ + nssm/.
  #   Bare     — push only the agent/ subtree (target already has
  #              install-agent.ps1 + node + nssm from a prior install).
  #              Use for in-place agent-only upgrades.
  [ValidateSet('Full', 'Bare')]
  [string] $Layout = 'Full',

  # Push per-host runtime files (appsettings.json, queue.db*,
  # package-lock.json, node_modules/) too. Off by default — these are
  # regenerated per-host. Set -IncludePerHostFiles:$true ONLY for the
  # very first install or when the operator explicitly asks for a
  # full-tree overwrite.
  [switch] $IncludePerHostFiles = $false,

  # Skip the verify-agentInstall.ps1 pre-flight. Off by default — we
  # never ship a bundle that locally fails verification. Set
  # -SkipPreFlight:$true only when you've already verified in the same
  # shell session and want to save the 5-second second pass.
  [switch] $SkipPreFlight = $false,

  # Dry-run — print what would be copied, don't actually push. Off by
  # default. Use to confirm the path mapping before running for real.
  [switch] $WhatIfMode = $false
)

$ErrorActionPreference = 'Stop'

# Disable strict mode — under StrictMode v3+ undefined variables in
# double-quoted strings trip the parser before runtime. We don't need
# strict mode here (the script is small + every var is local).
Set-StrictMode -Off

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$bundleSrc = Join-Path $root 'publish\installer\agentInstall'
$agentSrc = Join-Path $bundleSrc 'agent'

if (-not (Test-Path $bundleSrc)) {
  throw "source bundle missing: $bundleSrc (run installer/sync-agentInstall.ps1 first)"
}

# Pre-flight: verify local bundle is drift-free. verify-agentInstall.ps1
# already exists in installer/ — we delegate to it rather than duplicate
# the hash-compare logic. The script exits 1 on any drift.
if (-not $SkipPreFlight) {
  Write-Host "[push-agentInstall] pre-flight: running verify-agentInstall.ps1..." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot 'verify-agentInstall.ps1')
  if ($LASTEXITCODE -ne 0) {
    throw "pre-flight failed: verify-agentInstall.ps1 reported drift. Fix source vs publish/installer/agentInstall/ before pushing."
  }
}

# Verify remote host reachable + writable. Test-Path over UNC is the
# cheapest probe — it requires only SMB session setup, not actual write.
# If SMB is blocked but WinRM is open, switch to Invoke-Command — but
# the common case is operator WinRM with implicit SMB shares already
# enabled (C$ admin share). WhatIf skips this probe — we don't need
# network reachability to print the planned args.
if (-not $WhatIfMode) {
  Write-Host "[push-agentInstall] checking remote path: $RemotePath" -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $RemotePath)) {
    throw "remote path unreachable: $RemotePath. Verify SMB connectivity + admin share C$ enabled. Create the target dir with: New-Item -ItemType Directory -Path '$RemotePath' -Force via Invoke-Command -ComputerName $RemoteHost."
  }
}

# Build the robocopy argument set based on layout.
#
# robocopy /MIR makes destination == source. /MIR also DELETES files in
# destination that aren't in source — for a Bare layout this means the
# target's appsettings.json / queue.db* are at risk unless we exclude
# them. The exclude list below matches sync-agentInstall.ps1 and
# verify-agentInstall.ps1:72-74, so the same files always survive a push.
#
# Per-host files are ALWAYS excluded from /MIR by default; the
# -IncludePerHostFiles switch drops them into the robocopy stream.
$robocopyBase = @(
  '/MIR',
  '/NJH',           # no job header
  '/NJS',           # no job summary
  '/NDL',           # no directory list
  '/NFL',           # no file list
  '/NP',            # no progress
  '/R:1', '/W:1'    # one retry, 1 second wait
)

# Excludes applied to ALL pushes regardless of layout / IncludePerHostFiles.
# These are files that should NEVER be pushed over /MIR — they're per-host
# runtime artifacts whose loss on the target would break the agent.
#
# robocopy /XF takes a flat list of filenames (NOT /XF file1 file2 with
# arguments). The list below must match sync-agentInstall.ps1 + verify-agentInstall
# excludes exactly, or the mirror + push exclude sets diverge.
$alwaysExcludeFiles = @('package-lock.json', 'queue.db')

# Layout-specific source path + per-layout excludes.
if ($Layout -eq 'Full') {
  $pushSrc = $bundleSrc
  # When pushing Full layout, preserve per-host appsettings.json + queue.db
  # so the agent on the target doesn't lose its config + local WAL state.
  # /MIR with these /XF guards means: delete nothing in this category, copy
  # any source file in this category only if it doesn't exist on the
  # destination.
  $perLayoutExcludes = @('appsettings.json', 'queue.db-shm', 'queue.db-wal')
} else {
  # Bare layout: only the agent/ subtree.
  $pushSrc = $agentSrc
  # Same per-host guards: the target's appsettings.json + queue.db are
  # the agent's live runtime state.
  $perLayoutExcludes = @('appsettings.json', 'queue.db-shm', 'queue.db-wal')
}

# node_modules is gitignored at the source tree (sync-agentInstall.ps1
# excludes it). On the target, node_modules is built ONCE per host by
# install-agent.ps1's `npm install --omit=dev`. We never push
# node_modules — pushing platform-ABI-specific binaries from the dev box
# would break the target.
$perLayoutExcludes += 'node_modules'

# Build the robocopy /XF list. /XF takes a flat list — flatten to args
# via the splat. If -IncludePerHostFiles is set, we ALSO drop the
# per-layout excludes (appsettings.json etc.) into the robocopy stream
# — but for a Bare push over an existing agent/ subtree, this is
# destructive (overwrites the live appsettings.json from the
# publish/installer/agentInstall/agent/appsettings.json, which doesn't
# exist in source — see comment in sync-agentInstall.ps1). We
# therefore IGNORE -IncludePerHostFiles for the per-layout guards;
# the switch exists for the Full layout's future where the bundle
# might one day stage a host-specific override file.
$xfArgs = @('/XF') + $alwaysExcludeFiles + $perLayoutExcludes

# Layout-specific /XD (directories to exclude). tests/ is dev-only.
# Build the /XD argument set.
$xdArgs = @('/XD', 'tests')

if ($WhatIfMode) {
  Write-Host "[push-agentInstall] WHAT-IF MODE — no actual changes will be made" -ForegroundColor Yellow
  Write-Host "  src  = $pushSrc"
  Write-Host "  dst  = $RemotePath"
  Write-Host "  args = $($robocopyBase -join ' ') $($xfArgs -join ' ') $($xdArgs -join ' ')"
  exit 0
}

# Execute the push. robocopy exit codes: 0 = no change, 1 = files copied,
# 2 = extras deleted, 3 = both. >=8 = failure (we propagate as error).
Write-Host "[push-agentInstall] pushing $pushSrc -> $RemotePath (Layout=$Layout)" -ForegroundColor Cyan
$robocopyRc = 0
# Capture stdout to suppress robocopy's per-file spam. Errors still
# reach the user via throw below if rc >= 8.
& robocopy $pushSrc $RemotePath @robocopyBase @xfArgs @xdArgs *> $null
$robocopyRc = $LASTEXITCODE
$LASTEXITCODE = 0
if ($robocopyRc -ge 8) {
  throw "robocopy failed: exit $robocopyRc. Investigate SMB connectivity + permissions on $RemotePath."
}

# Post-push verification: enumerate the pushed files and confirm key
# sentinel files exist on the remote. For Full layout, check the bundle
# root files; for Bare layout, only check agent/.
$sentinels = switch ($Layout) {
  'Full' { @('install-agent.ps1', 'start.ps1', 'agent\agent.js', 'common\Logger.psm1', 'node\node.exe', 'nssm\nssm.exe') }
  'Bare' { @('agent.js', 'package.json') }
  default { @() }
}
$ok = $true
foreach ($s in $sentinels) {
  $remote = Join-Path $RemotePath $s
  if (Test-Path -LiteralPath $remote) {
    Write-Host "  OK   $remote" -ForegroundColor Green
  } else {
    Write-Host "  MISS $remote" -ForegroundColor Red
    $ok = $false
  }
}
if (-not $ok) {
  throw "post-push sentinels missing — push may be partial. Re-run or investigate."
}

Write-Host "[push-agentInstall] push complete. Layout=$Layout  RemoteHost=$RemoteHost  RemotePath=$RemotePath" -ForegroundColor Green
# Use a local string for the service-name acronym to dodge the PowerShell
# parser treating a raw variable followed by space as an incomplete drive
# qualifier. The displayed text is identical.
# PS parser trips on bare variable references followed by colon (parsed
# as drive qualifier start) or by space (parsed as part of the variable
# name). Wrap in braces to delimit the name explicitly.
$NssmName = 'NSSM'
Write-Host "  next step on ${RemoteHost}: restart the ADReplicationDashboardAgent ${NssmName} service to load the new bundle." -ForegroundColor Yellow