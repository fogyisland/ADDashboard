# Heartbeat "Report Now" Button — Design

> Operator-triggered immediate data report from a specific agent, surfaced as a button on each row of the heartbeat monitor view.

**Status:** approved 2026-08-24 · round-12 of the 2026-08-24 installer-fixes sequence

## Goal

Add a "回报" button on the right side of each agent row in the heartbeat monitor view (心跳表). When the operator clicks it, the corresponding agent runs its full data-report cycle immediately instead of waiting for its next scheduled cycle. If the agent is offline at click time, the request persists in the center; when the agent reconnects, it picks up the pending request and reports.

## Architecture

Reuse the existing **agent → center heartbeat channel** as a one-bit command surface (today the response body only carries token-delivery fields). This avoids opening a new long-lived push channel (WebSocket / SSE) and keeps the agent-side state machine simple.

```
[Operator clicks 回报 on row N]
   │
   ▼
POST /api/admin/agents/:agentId/request-report     (admin auth: admin:users)
   │
   ▼
UPDATE ad_agent_heartbeat
   SET report_requested_at = NOW()
 WHERE agent_id = :agentId                       -- idempotent
   │
   ▼
[Operator refresh / 5s poll] → 心跳表 row N: reportRequested = true (button shows 已请求回报, disabled)
   │
   ▼
[Agent sends its next heartbeat]
   │
   ▼
POST /api/agent/heartbeat   (existing endpoint, body unchanged)
   │
   ▼
[Center] reads report_requested_at
   │
   ▼
Responds: { ok: true, accepted, rejected, ..., reportRequested: <bool> }
   │
   ▼
[Agent] send() callback sees r.data.reportRequested === true
       → scheduler._tick()       (existing scheduler entry point; idempotent)
       │
       ▼
       collect-replication.ps1 runs → ad_replication_status rows inserted
       pending package reports sent → metrics ingested
       heartbeat updated with lastReportAt / lastReportStatus
       │
       ▼
[Agent] next heartbeat POST body adds report_requested_at: null
   │
   ▼
[Center] UPSERT honors null → clears report_requested_at
       │
       ▼
[Operator refresh / 5s poll] → row N: reportRequested = false (button restored)
```

### Why piggyback on heartbeat response (not a new channel)

- Heartbeat already runs every few seconds per agent — sub-5s reaction time is good enough for an operator-triggered command.
- Heartbeat response is already parsed by the agent (`requestJson()` in `reporter.js`); one new boolean field is a minimal surface area.
- No new long-lived socket means no new failure modes (proxy / firewall / NAT / auth refresh).
- If the agent is offline, the click is persisted in DB and delivered on next heartbeat — same guarantee a push channel would give, with less infrastructure.

### Why `scheduler._tick()` (not a custom report-only path)

- `_tick()` already runs `collect + send + heartbeat update` exactly like the natural schedule. Reusing it means the operator-triggered report is byte-identical to a scheduled one — operators see the same data they would have seen N minutes later.
- It's already idempotent: if a scheduled tick is in flight when the click happens, the operator-triggered tick queues behind it via the same `queue` (no double-run).
- It already updates the heartbeat with `lastReportAt / lastReportStatus` — same feedback loop the operator already watches.

## Data Model

### DB column

New column on `ad_agent_heartbeat`:

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `report_requested_at` | `DATETIME` (MySQL) / `DATETIME2` (MSSQL) | YES | NULL | Timestamp the operator clicked. Cleared by agent after successful report. |

UNIQUE constraint and existing PK stay untouched — single row per agent.

### State semantics

| `report_requested_at` | meaning |
|---|---|
| `NULL` | no pending request; button enabled, label "回报" |
| non-NULL, fresh (now − value < 24h) | pending request not yet consumed; button disabled, label "已请求回报" |
| non-NULL, stale (>24h) | stale request — likely agent has been offline too long. Button enabled; label "回报(待清理)". Center clears the flag on next click. |

The 24h TTL is a heuristic to keep the UI from being permanently disabled by an old unconsumed request. It is enforced only on the UI side; the center does not auto-clear stale flags (an operator may want to know "yes, this agent has been offline since Tuesday").

## Endpoints

### `POST /api/admin/agents/:agentId/request-report`

- **Auth:** `requireAuth + requirePerm('admin:users')` (same gate as `GET /api/admin/heartbeat-report/agents`)
- **Body:** none
- **Response 200:** `{ ok: true, agentId, requestedAt: <ISO8601>, alreadyPending: <bool> }`
- **Response 404:** agent_id not found in `ad_agent_heartbeat` (only known agents can be triggered; admin must install agent first)
- **Audit:** `request_agent_report` action; details include `{ agentId, requestedAt, alreadyPending }`

### `POST /api/agent/heartbeat` (modified)

- Existing body; **response body adds** `reportRequested: boolean` field
- Existing body adds optional field `report_requested_at: null` — when present and null, UPSERT clears the column. When absent, UPSERT preserves existing column value (default behavior). This makes the clear flow explicit without breaking older agents (they just omit the field, and the flag persists — see Compatibility).

### `GET /api/admin/heartbeat-report/agents` (modified)

- Response row shape adds `reportRequestedAt: string | null`
- Frontend derives `reportRequested = !!reportRequestedAt && now − reportRequestedAt < 24h`

## SQL Changes

`center/src/db/sql.js`:

### `heartbeat.requestReport(agentId, requestedAtIso)`

Single-statement UPSERT that:
- INSERTs a row if `agent_id` doesn't exist (created by the agent's first heartbeat anyway; this is a defensive fallback so an admin can trigger before any heartbeat has been received — same shape as `heartbeat.upsert`).
- Otherwise sets `report_requested_at = ?`.

Returns `{ rowsAffected, alreadyPending }`. `alreadyPending` is true if `report_requested_at` was already non-NULL on entry.

### `heartbeat.upsert` (modified)

- INSERT column list adds `report_requested_at` (only on initial INSERT, never on UPDATE — only operator can set this).
- UPDATE clause conditionally sets `report_requested_at` to the new value if the body field is present (else leaves existing column untouched). Specifically:
  - `report_requested_at = COALESCE(?, report_requested_at)` in MySQL — passing `null` preserves the existing column.
  - MSSQL equivalent using `ISNULL(@p, report_requested_at)` or a `CASE WHEN @p IS NULL THEN report_requested_at ELSE @p END` expression to preserve the column when the agent doesn't include the field.
- This way: agent that doesn't know about the flag can keep POSTing without disturbing the column.

### `heartbeat.agentsList` and `heartbeat.dcsList` (modified)

- Add `report_requested_at` to the SELECT list.

### MSSQL branch (`sql.js` lines 469-494)

- Mirror the MySQL changes exactly. Both dialects must return `report_requested_at` and the UPSERT must work the same way.

## Agent-Side Changes

### `agent/agent.js` — `startHeartbeat.send` callback

```javascript
let pendingReportRequestClear = false;     // closure-captured by payload() and send()

startHeartbeat({
  intervalMs: ...,
  payload: () => {
    const p = { ...existing fields... };
    if (pendingReportRequestClear) {
      // Tell the center to clear report_requested_at. We send this exactly
      // once after a successful _tick(); older agents (without this code
      // path) simply omit the field, leaving the flag in place — that's
      // safe, the operator can re-click and the next round-12 agent will
      // honor the request.
      p.report_requested_at = null;
      pendingReportRequestClear = false;
    }
    return p;
  },
  send: async (p) => {
    const r = await postHeartbeat({...});
    await applyAgentTokenDelivery({ result: r, config, configPath, logger });

    // 2026-08-24 round-12: operator-triggered immediate report.
    // Center sets report_requested_at on the row when admin clicks 回报;
    // we get the boolean back in the response and trigger one full scheduler
    // cycle. _tick is idempotent and uses the same queue, so an in-flight
    // scheduled tick is honored first.
    if (r && r.data && r.data.reportRequested === true) {
      try {
        await scheduler._tick();
        // Only on success: arm the next heartbeat to clear the flag.
        // If _tick threw (collect failed, send failed), we don't clear —
        // the next heartbeat will see reportRequested=true again and retry.
        pendingReportRequestClear = true;
      } catch (e) {
        logger.warn({ err: e.message }, 'scheduler._tick() after reportRequested failed; flag stays set');
      }
    }
  }
});
```

`pendingReportRequestClear` is a module-scope closure variable in `agent.js`. `payload()` reads + resets it; `send()` arms it. After one successful `_tick()` → exactly one subsequent heartbeat carries `report_requested_at: null` to the center, which clears the column. If the agent restarts between the click and the clear heartbeat, the in-DB flag is still there and the operator-triggered logic runs again on next start — no harm.

### Compatibility with older agents

- Older agents ignore `reportRequested` in the response → flag stays set → operator sees "已请求回报" indefinitely → click 回报 again is idempotent (no harm).
- The 24h stale-window UI affordance + the operator being able to re-click covers this gracefully.
- Older agents also omit `report_requested_at` from POST body → center's UPSERT preserves the column (per the `COALESCE`/`CASE` semantics in the SQL section). Flag never auto-clears on older fleets; operator upgrade eventually makes them current.

## Frontend Changes

### `center/web/src/views/admin/HeartbeatReportMonitorView.vue` — heartbeat table only

- Add a new column header "操作" (rightmost).
- Each row: button labeled "回报" (enabled) / "已请求回报" (disabled with spinner-style cursor) / "回报(待清理)" (enabled, when >24h stale).
- Click handler:
  - Confirm modal: "立即向 {agentId} 触发数据回报?" — short, no scary copy.
  - On confirm → `await heartbeatReportApi.requestReport(agentId)` → success toast "已请求 {agentId} 回报"。
  - On 404 → error toast "agent {agentId} 不存在,请先安装 agent"。
  - On other error → generic error toast.
- Tooltip on disabled button when **flag is pending**: "已请求回报 {since-ago};等待 agent 下一次心跳。"
- Tooltip on disabled button when **agent is stale** (offline): "agent 离线;无法回报"。Operator cannot click in this state — the request would not deliver until the agent reconnects, so we block the action rather than queueing a request that sits invisible.
  - The "persist on reconnect" guarantee applies to the **race**: agent is online at click time, click writes flag, then agent goes offline before next heartbeat. Flag stays in DB; agent picks it up when it reconnects. Operator did nothing wrong — we honor the click.
- Loading state: while POST in flight, button shows "请求中…" and is disabled.

### `center/web/src/api/heartbeatReport.js`

```javascript
export async function requestReport(agentId) {
  const r = await request.post(`/api/admin/agents/${encodeURIComponent(agentId)}/request-report`);
  return r.data;
}
```

### Polling

Heartbeat view already polls every 5s (`refreshIntervalSeconds`). After a click, the row state transitions are visible in ≤5s: enabled → "已请求回报" disabled → enabled (after agent picks up, runs tick, clears flag).

## Audit Logging

`center/src/audit-classifier.js` — add new action:

```javascript
'request_agent_report': {
  category: 'agent_control',
  label: '请求 Agent 立即回报',
  severity: 'info'
}
```

Logged via `WriteAudit` from the route handler with `targetType: 'agent'`, `targetId: agentId`, `details: { requestedAt, alreadyPending }`.

## Migration

`db/migrations/018-report-requested.sql` (MySQL):

```sql
ALTER TABLE ad_agent_heartbeat
  ADD COLUMN report_requested_at DATETIME NULL AFTER agent_token_version;
```

`db/migrations/mssql/018-report-requested.sql`:

```sql
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('ad_agent_heartbeat') AND name = 'report_requested_at'
)
BEGIN
  ALTER TABLE ad_agent_heartbeat
    ADD report_requested_at DATETIME2 NULL;
END
```

Both migrations are additive (no column drops). Mirror to `publish/system/db/migrations/`.

## Tests

| Layer | Test file | Cases |
|---|---|---|
| Backend service | `center/tests/services/heartbeat-report.test.js` | `requestReport` sets flag; idempotent on second click; `alreadyPending` true on second click |
| Backend route | `center/tests/routes/heartbeat-report.test.js` (or new `agents-request-report.test.js`) | 200 happy path; 404 unknown agent; 401 no auth; 403 wrong perm; audit log written |
| Backend heartbeat handler | `center/tests/routes/agent-heartbeat.test.js` | Response includes `reportRequested: true` when flag set; `reportRequested: false` otherwise; UPSERT clears flag when body has `report_requested_at: null`; UPSERT preserves flag when body omits the field |
| Agent tick trigger | `agent/tests/heartbeat.test.js` (or new `report-now.test.js`) | Mock `scheduler._tick`; when response has `reportRequested: true`, `_tick` is called once; body of next heartbeat has `report_requested_at: null`; failed tick does not set the clear flag |
| UI | `center/web/src/views/admin/HeartbeatReportMonitorView.spec.js` (extend existing) | Button renders; enabled when no flag; disabled when flag set; click triggers `requestReport` API; success toast on 200; error toast on 404 |
| SQL real-DB | `center/tests/sql/heartbeat-report.test.js` (extend) | Seed row without flag → `requestReport` SQL sets it; UPSERT with `report_requested_at: null` clears; UPSERT without the field preserves; agentsList returns `report_requested_at` |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `_tick()` is async and may collide with the scheduled tick | `_tick()` already runs serialized against the queue (the same `queue` instance); a second concurrent `_tick` re-enters the queue and dedupes via `queue.enqueue` |
| Operator clicks 100× in 1 second | UPSERT is idempotent on `(agent_id, report_requested_at)` semantically (same column = same value on rapid succession); only one audit log per minute per agent via WriteAudit's existing dedup |
| Older agents in fleet (before round-12) | Compatibility: old agents ignore `reportRequested`; flag persists; operator can re-click. 24h UI stale window hides "stuck pending" UI |
| Failure of collect-replication.ps1 leaves flag set | Agent only sends `report_requested_at: null` after `_tick()` returns without throwing; failed tick keeps flag set → next heartbeat picks it up again and retries (bounded by `_tick`'s internal timeoutMs) |
| Heartbeat response body schema change breaks older center | New field `reportRequested` is additive — older center just doesn't add it, agent treats as undefined → no trigger |
| Stale flag (agent offline for weeks) | UI 24h threshold re-enables button. Center does not auto-delete — operator may still want to know "yes this was clicked but never delivered" |

## Done When

- `npm test` in `center/` is green (all existing 1147 + new tests pass)
- `node --test` in `agent/` is green (134 + new tests pass)
- `npm run test:web` in `center/web/` is green
- New endpoint `POST /api/admin/agents/:agentId/request-report` is reachable, idempotent, audit-logged
- Heartbeat response carries `reportRequested` field
- UI button in 心跳表 is visible, enabled/disabled correctly, tooltips match spec
- `publish/system/db/migrations/018-report-requested.sql` mirrored
- `publish/system/center/src/db/sql.js` updated

## Out of Scope

- Bulk "report all" button (one click per row only; if needed, future)
- Cancel / abort a pending request (operator just waits; 24h TTL on UI side)
- Per-package "report only this package" granularity (full tick is the contract)
- Center → agent WebSocket / SSE channel (heartbeat response piggyback is sufficient)
- Reporting the agent's progress (% complete) back to the UI during the trigger (only before/after states)
