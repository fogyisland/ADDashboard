# LogRetention.ps1 — Agent 日志 7-day retention (R158.60.11)
#
# Single-purpose: enumerate <LogDir> and delete rotate backup files
# older than $RetentionDays days. NEVER touches the live <svc>-{stdout,stderr}.log
# (NSSM holds an open handle; deleting it breaks the service).
#
# Triggered by Windows Task Scheduler (see Register-ADDashboardAgent.ps1::Register-LogRetentionTask).
# Also runnable ad-hoc:
#   powershell -File C:\agentInstall\agent\LogRetention.ps1 -DryRun
#   powershell -File C:\agentInstall\agent\LogRetention.ps1 -LogDir <other> -RetentionDays 14
#
# PS5.1 + pwsh 7+ compatible. No `??`, no ternary, no `-AdditionalChildPath`.

[CmdletBinding()]
param(
  [string]$LogDir = 'C:\agentInstall\agent\Logs',
  [string]$ServiceName = 'memberServiceAgent',
  [int]$RetentionDays = 7,
  [switch]$DryRun  # list candidates without deleting
)

$ErrorActionPreference = 'Stop'

# ---- preflight ----
if (-not (Test-Path -LiteralPath $LogDir)) {
  Write-Host "[INFO] LogDir not found: $LogDir — nothing to do"
  exit 0
}

# NSSM 2.24 backup filename: <base>.YYYYMMDDHHMMSS.log (UTC timestamp suffix,
# 14 digits, hyphen before the digits). Live files have no suffix; missing
# the regex would risk deleting the live log NSSM holds open.
#
# Pattern requires:
#   ^<svc>-          literal service-name prefix + hyphen
#   .+               at least one extra char (NSSM uses -stdout- / -stderr-)
#   -\d{14}\.log$    14-digit timestamp suffix before the extension
$backupPattern = "^{0}-.+-\d{{14}}\.log$" -f [regex]::Escape($ServiceName)

$cutoff = (Get-Date).AddDays(-$RetentionDays)
$deleted = 0
$kept = 0
$skippedLive = 0

Get-ChildItem -LiteralPath $LogDir -File -ErrorAction SilentlyContinue | ForEach-Object {
  $f = $_
  # Use FullName + Name (not BaseName) — the regex requires the trailing
  # \.log$ anchor, and BaseName strips the extension. Without FullName the
  # regex never matches and the script silently skips every file (R158.60.11
  # first-run regression; caught by the unit test in C:\Temp\retention-test).
  $fullName = $f.FullName
  # Live files: <svc>-stdout.log / <svc>-stderr.log (no timestamp suffix).
  # Cheap check first to short-circuit on the common case.
  if ($f.Name -notmatch '-\d{14}\.log$') {
    $skippedLive++
    return
  }
  if ($f.Name -notmatch $backupPattern) {
    $skippedLive++
    return
  }
  if ($f.LastWriteTime -ge $cutoff) {
    $kept++
    return
  }
  if ($DryRun) {
    Write-Host "[DRY] would delete: $fullName (LastWriteTime=$($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')))"
  } else {
    Remove-Item -LiteralPath $fullName -Force
    Write-Host "[DEL] deleted: $fullName (LastWriteTime=$($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')))"
  }
  $deleted++
}

Write-Host "[SUMMARY] scanned=$($deleted + $kept + $skippedLive) kept=$kept deleted=$deleted skipped_live_or_unmatched=$skippedLive cutoff=$($cutoff.ToString('yyyy-MM-dd HH:mm:ss')) dryRun=$DryRun"
exit 0
