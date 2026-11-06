# collect.ps1 - ad_eventlog_collector v1.0.5 (R158.52, 2026-10-08)
#
# v1.0.5 changes vs v1.0.4 (R158.52, 2026-10-08):
#   - Operator directive "零或空 / 都修复, 避免数据出现错误":
#     track $droppedCount when the 1000-row limit is reached. Pre-fix the
#     limit silently dropped rows and the centre's summary count was wrong
#     (operator wants totals, not page-limit). $droppedCount is now
#     surfaced as `dropped_count` on each per-channel summary row so the
#     centre can flag "real activity was X+Y" instead of just "X".
#   - All 16 PS1 collectors received R158.52 hardening; this file is the
#     one with a wire-shape change (new `dropped_count` summary column),
#     so it is the only eventlog_collector that warrants a version bump.
#     Other 15 collectors absorbed their fault-tolerance changes in-place
#     (per-record try/catch, error_code bit, null→0 coerce) without adding
#     new columns.
#
# v1.0.2 changes vs v1.0.1 (R158.23, 2026-10-02):
#   - Security Event ID 4625/4776 row severity normalised to 'info' → 'error'.
#     Windows reports 4625/4776 at Level=0 (Information) on every DC we tested,
#     so the prior switch ($level = eventinfo | eventwarn | eventerr) mapped
#     every audit-failure row to severity='info', making them invisible to
#     drill-down filters that match severity='warning'/'error'. 4625 IS a
#     security failure (failed logon) — classify it as 'error' so the
#     drill-down panel's severity filter, the cell group tooltip, and the
#     audit-failure count stay in lockstep.
#
#   - Mock-fallback path (AuditData.SECURITY mock failure): both rows now
#     carry audit_failure=1 when AuditData.AUDIT_FAILURE_IDS=1, and the
#     mock summary counter no longer drops audit_failure_count to 0. This
#     closes the gap where a fully-RSAT-failed DC reported audit-failure
#     rows in the events table but reported 0 in the summary row, making
#     the countCell total read 0 even though ad_eventlog_events had real rows.
#
# v1.0.1 changes vs v1.0.0 (R154):
#   - Scan window shrunk from 25h to 2h (operator directive 2026-09-29
#     "，2"). 2h is the
#     retention window the front-end assumes (SINCE_HOURS=2).
#   - New 'Security' channel with audit-failure filter: pulls Event ID
#     4625 (Failed Logon) and 4776 (NTLM credential validation failure)
#     only. Both event rows AND the summary row carry the new
#     `audit_failure` / `audit_failure_count` flag so the EventlogView
#     "" column shows a separate count for actual audit failures
#     (not just generic Security warning/error).
#
# Output wire shape is a strict superset of v1.0.0:
#   { metrics: { agent_id, dc_name, collected_at,
#                events:     [ { channel, severity, event_id, record_id,
#                                 message, ts, audit_failure }, ... ],
#                summaries:  [ { channel, warning_count, error_count,
#                                 audit_failure_count, collected_at }, ... ] } }
#
# `audit_failure` on each event row is 1 when the record_id is one of the
# two filtered IDs (4625, 4776), 0 otherwise. `audit_failure_count` on
# each summary row counts how many of the (filtered) rows in this 2h
# scan matched. The Security summary's `warning_count`/`error_count`
# reflect only the 4625/4776 events too — we filter on Event ID, not
# Level, so the bucket is homogeneous.

$ErrorActionPreference = 'Continue'

# R136 encoding fix (unchanged): PS 5.1 default [Console]::OutputEncoding
# is the system ANSI codepage (CP936/GB18030 on CN Windows). Setting it
# to UTF8 makes ConvertTo-Json emit the original .NET bytes verbatim so
# the centre's NVARCHAR column sees the correct UTF-16 code points.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime()

# Channel order is fixed — the public page renders 4+1 columns in this
# order. The Security channel carries the audit-failure filter; the
# other 4 channels carry Level=2 (error) + Level=3 (warning) like before.
$CHANNELS = @(
  @{ key = 'System';      name = 'System';          auditOnly = $false },
  @{ key = 'Application'; name = 'Application';     auditOnly = $false },
  @{ key = 'ADWeb';       name = 'AD Web Services'; auditOnly = $false },
  @{ key = 'DFSR';        name = 'DFSR';            auditOnly = $false },
  @{ key = 'Security';    name = 'Security';        auditOnly = $true  }
)

# Audit-failure Event ID set — Windows Security channel events the
# operator wants to surface. 4625 is "An account failed to log on",
# 4776 is "The domain controller attempted to validate the credentials
# for an account". Both fire under failed-auth conditions; together
# they cover the operator's "" intent (single ID is too narrow;
# 4771 Kerberos preauth-failure is intentionally out of scope per
# R154 operator answer).
$AUDIT_FAILURE_IDS = @(4625, 4776)

$events    = New-Object System.Collections.Generic.List[object]
$summaries = New-Object System.Collections.Generic.List[object]
# R158.50.6 (2026-10-07) —  per-channel try/catch  message  stdout `error` 
$lastErrorMessages = New-Object System.Collections.Generic.List[string]

# R154 — scan window narrowed to 2 hours. v1.0.0 used 25h to give the
# centre-side 24h retention sweep a 1h margin; v1.0.1 keeps a 1h margin
# against the 4h retention (4h retention − 2h window = 2h margin), so
# re-running collect.ps1 always re-reads the events the retention loop
# still has on disk. Margin > 0 means the panel never briefly shows
# "0 events" mid-cycle.
$SCAN_HOURS = 2

foreach ($ch in $CHANNELS) {
  $warningCount = 0
  $errorCount   = 0
  $auditFailureCount = 0
  # R158.52 — track how many events were silently dropped because the
  # 1000-row limit was reached. Surfaced in the per-channel summary.
  $droppedCount = 0

  try {
    $startTime = (Get-Date).AddHours(-$SCAN_HOURS)

    if ($ch.auditOnly) {
      # Security channel — Event ID whitelist (4625, 4776). The Security
      # log doesn't fail Get-WinEvent on the missing "audit policy
      # enabled" case so often as you'd expect, but we still wrap the
      # call in try/catch — if it fails, the mock fallback below seeds
      # a deterministic SHA-based count so dev never shows all-zeros.
      $idList = ($AUDIT_FAILURE_IDS | ForEach-Object { "EventID=$_" }) -join " or "
      $filterXml = @"
<QueryList>
  <Query Id="0" Path="$($ch.name)">
    <Select Path="$($ch.name)">*[System[TimeCreated[@SystemTime&gt;='$($startTime.ToUniversalTime().ToString('o'))'] and ($idList)]]</Select>
  </Query>
</QueryList>
"@
    } else {
      # Original 4 channels — Level 2 (error) + Level 3 (warning).
      $filterXml = @"
<QueryList>
  <Query Id="0" Path="$($ch.name)">
    <Select Path="$($ch.name)">*[System[TimeCreated[@SystemTime&gt;='$($startTime.ToUniversalTime().ToString('o'))'] and (Level=2 or Level=3)]]</Select>
  </Query>
</QueryList>
"@
    }

    $records = Get-WinEvent -FilterXml $filterXml -ErrorAction Stop
    foreach ($r in $records) {
      $level = switch ($r.Level) {
        1 { 'error' }  # R158.23 — Critical (Level=1) now classifies as 'error' not 'info'.
                       # 4625/4776 surface as Level=0 (Information) and would otherwise
                       # fall into the `default` branch below as 'info'. We special-case
                       # audit-failure rows to 'error' so the drill-down severity filter
                       # matches the rows that *matter* (potential brute-force / credential
                       # failure indicators).
        2 { 'error' }
        3 { 'warning' }
        4 { 'info' }
        default { 'info' }
      }
      # R158.23 — Security audit-failure rows (Level=0) override to 'error'.
      # Windows classifies 4625/4776 as Information, but for the dashboard they
      # are security failures and should surface under "" severity.
      if ($ch.auditOnly -and $AUDIT_FAILURE_IDS -contains [int]$r.Id) {
        $level = 'error'
      }
      if ($level -eq 'warning') { $warningCount++ }
      elseif ($level -eq 'error') { $errorCount++ }

      # Audit-failure flag is only meaningful for the Security channel;
      # other channels always set audit_failure = 0 (matches the SQL
      # NOT NULL DEFAULT 0 shape). When channel=Security, the Event ID
      # whitelist already guarantees every record_id is in
      # AUDIT_FAILURE_IDS — so we set audit_failure = 1 unconditionally
      # here. Keeps the wire shape uniform (no nullable bool) and lets
      # the drill-down query filter on audit_failure=1 across channels
      # if we ever widen the filter.
      $isAuditFailure = 0
      if ($ch.auditOnly) {
        $isAuditFailure = 1
        $auditFailureCount++
      }

      # Limit drill-down rows to last 200 records per channel (the
      # page also enforces limit=200 in its query — R154 keeps the
      # surface small).
      # R158.52 — operator directive "零或空 / 避免数据错误": when more
      # than 1000 events match, the limit silently drops the rest and
      # the centre's summary count is wrong. Track a $totalDropped counter
      # and surface it in $summaries so the operator can see "X events
      # were dropped because the row limit was reached".
      if ($events.Count -lt 1000) {
        $message = if ($r.Message) { $r.Message } else { '' }
        if ($message.Length -gt 4000) { $message = $message.Substring(0, 4000) }
        $events.Add([pscustomobject]@{
          channel        = $ch.key
          severity       = $level
          event_id       = [int]$r.Id
          record_id      = [int64]$r.RecordId
          message        = $message
          ts             = $r.TimeCreated.ToUniversalTime().ToString('o')
          audit_failure  = [int]$isAuditFailure
        })
      } else {
        $droppedCount++
      }
    }
  } catch {
    [Console]::Error.WriteLine("ad_eventlog_collector channel $($ch.key) failed: $($_.Exception.Message)")
    # R158.50.6 —  channel  message  payload.error ( channel
    # , )
    $lastErrorMessages.Add("channel $($ch.key): $($_.Exception.Message)")
    # R158.31.2 (2026-10-02) — operator directive: "0".
    # Pre-R158.31.2 mock fallback generated deterministic SHA-based
    # fake rows (event_id=9999, message="[mock] eventlog unavailable —
    # ...") so dev never shows all-zeros panels. That polluted the
    # /eventlog page with hundreds of fake rows per DC (each agent
    # every 15min) and confused operators when filtering by event_id.
    # New policy: when Get-WinEvent fails or returns nothing, just write
    # zeros — counters stay at the previous default 0 and no row is
    # added to $events. Real rows only.
    #
    # Note: $warningCount / $errorCount / $auditFailureCount are
    # already 0 here (initialized at top of loop iteration); we only
    # need to NOT add the synthetic mock row.
  }

  $summaries.Add([pscustomobject]@{
    channel             = $ch.key
    warning_count       = [int]$warningCount
    error_count         = [int]$errorCount
    audit_failure_count = [int]$auditFailureCount
    # R158.52 — surface $droppedCount so the operator can see when the
    # 1000-row limit silently dropped events. Counts of `totalDropped > 0`
    # mean the row summary understates real activity; the centre's
    # warning banner keys off this field.
    dropped_count       = [int]$droppedCount
    collected_at        = $collectedAt.ToString('o')
  })
}

$metrics = @{
  agent_id    = $server
  dc_name     = $server
  collected_at = $collectedAt.ToString('o')
  events      = $events.ToArray()
  summaries   = $summaries.ToArray()
}

# R158.50.6 —  message  stdout `error` .  channel  '; ' 
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessages.Count -gt 0) { ($lastErrorMessages.ToArray() -join '; ') } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0