# Port Config UI + Center Self-Probe

**Date:** 2026-08-08
**Status:** Design (post-brainstorming, awaiting user review)
**Origin:** `progress_2026_08_07_heartbeat.md` — 8-task heartbeat/report multi-port plan shipped; user asked follow-up questions Q1 (port config UI) + Q2 (port health detection of "open but dead"); user chose to combine into one plan.

---

## Goal

Two related admin capabilities for the AD Dashboard Center's three listening ports (web `listenPort`, heartbeat `heartbeat_port`, report `report_port`):

1. **Q1 — Edit all three ports from the admin UI** (instead of editing `appsettings.json` directly). `heartbeat_port`/`report_port` already in DB; `listenPort` moves from file to DB. Port change UX shows a "待重启" badge when center needs a restart to pick up the new value.
2. **Q2 — Detect "port open but service dead"** by self-probing all three ports every second from inside the center process, persisting status/latency/last-up to a new `probe_state` table, and surfacing the result in the existing `HeartbeatReportMonitorView` admin page.

Both ship in one branch. Together they make the admin see "is the center actually serving?" at a glance.

---

## Decisions (frozen, from brainstorming 2026-08-08)

| # | Decision | Choice |
|---|---|---|
| D1 | `listenPort` storage | **Move to `system_config` table** (DB). `appsettings.json` keeps it as first-boot fallback only. |
| D2 | Probe result storage | **New `probe_state` table** (3 rows, port_role primary key). |
| D3 | `/healthz` scope | **Mount on all three apps** (webApp, heartbeatApp, reportApp). |
| D4 | Probe cadence | **1 Hz probe + write each tick** (no batching). |
| D5 | `probe_state` schema | `port_role` PK + `status`, `latency_ms`, `last_probe_at`, `last_up_at`, `consecutive_failures`. |
| D6 | Healthz DB check | **Keep as-is** (already hits DB; reports service+DB health together). |
| D7 | Probe API endpoint | **`GET /api/admin/heartbeat-report/probe`** (same router as existing heartbeat-report admin endpoints). |
| D8 | Restart detection | **`version_hash` pair**: `center_listen_port_pending_version` (DB-write on UI save) vs `center_listen_port_started_version` (DB-write on center start). Mismatch → "待重启". |
| D9 | `listenPort` first-boot | **Seed from `appsettings.json` into DB** on first center start (when DB row absent). |
| D10 | "待重启" UX | **Inline badge** on the `listenPort` row in ConfigView. |
| D11 | Probe startup state | **Three-state color** — yellow "unknown" until first probe completes. |

---

## Non-Goals (explicitly out of scope)

- **No agent-side probe.** Q2 is center-only.
- **No cluster / multi-center probe.** Single-instance assumption.
- **No historical probe graphs.** `last_up_at` is a single snapshot; no time-series.
- **No "一键重启 center" button.** Restart UX is informational; user restarts manually (deployment script / NSSM).
- **No HTTPS probe.** Self-probe uses `http://localhost:<port>/healthz`. TLS termination is nginx's job (per `progress_2026_08_05_evening.md`).
- **No historical audit of every tick.** Audit only on status transition (healthy↔degraded), not on every probe.
- **No `system_state` table.** Use `probe_state` (new) + `system_config` (existing KV).

---

## Architecture

### Components (new files)

```
center/src/services/probe.js                  ← 1 Hz probe loop, reads/writes probe_state
center/src/db/migrations/012-probe-state.sql  ← both dialects (MySQL + MSSQL)
center/src/db/sql.js                         ← + db.sql.probeState.upsertRow (helper)
```

### Components (modified)

```
center/src/config.js               ← read listenPort from DB (system_config), fallback appsettings, first-boot seed
center/server.js                   ← startProbeLoop() in normal bootstrap; stopProbeLoop() in shutdown handler
                                       mount healthzRouter on heartbeatApp and reportApp too
center/src/routes/healthz.js       ← no change (already mounted by createApp); just mount on 2 more apps
center/src/routes/heartbeat-report.js ← + GET /probe handler
center/src/services/heartbeat-report.js ← + listProbeStatus()
frontend/src/views/admin/ConfigView.vue     ← labels/descriptions/numericFields for listenPort, heartbeat_port, report_port
                                              + inline "待重启" badge on listenPort row
frontend/src/views/admin/HeartbeatReportMonitorView.vue
                                       ← + top summary panel "中心端口" (3 rows, 3-state color)
frontend/src/api/heartbeatReport.js       ← + getProbeStatus()
frontend/src/components/ConfigFieldRow.vue ← no change (already supports type=number)
```

### Data flow

**Probe loop (steady state)**

```
[tick @ 1 Hz, started in normal-mode bootstrap]
  for each port_role in {web, heartbeat, report}:
    t0 = now
    try:
      res = await fetch(`http://localhost:${getPort(port_role)}/healthz`, { signal: AbortSignal.timeout(2000) })
      latencyMs = now() - t0
      if res.ok (status 200): newStatus = 'healthy'
      else: newStatus = 'degraded'
    catch (timeout / ECONNREFUSED / non-2xx):
      newStatus = 'degraded'; latencyMs = null

    prev = SELECT status, last_probe_at FROM probe_state WHERE port_role = ?
    update row:
      status = newStatus
      latency_ms = latencyMs
      last_probe_at = now()
      consecutive_failures = (newStatus == 'healthy') ? 0 : (prev.consecutive_failures + 1)
      last_up_at = (newStatus == 'healthy') ? now() : prev.last_up_at

    if prev.status != newStatus:
      writeAudit({ action: 'probe_state_changed',
                   target: 'probe_state',
                   payload: { port_role, prev, next } })
```

**Restart detection flow**

```
[Center startup, normal-mode bootstrap, after config load]
  if system_config has no 'listenPort' key:
    seed system_config.listenPort = appsettings.listenPort
    (one-time; subsequent boots find the key)

  if system_config has no 'center_listen_port_started_version':
    startedVersion = null
  else:
    startedVersion = system_config.center_listen_port_started_version

  set system_config.center_listen_port_started_version = sha256(now-ISO + listenPort)

[ConfigView mounted, after loading config]
  pendingVersion = system_config.center_listen_port_pending_version
  startedVersion = system_config.center_listen_port_started_version
  if pendingVersion !== startedVersion AND pendingVersion != null:
    showBadge("待重启" on listenPort row)

[ConfigView save handler, after PUT listenPort to DB]
  set system_config.center_listen_port_pending_version = sha256(now-ISO + newListenPort)
  refetch → badge appears (UI-driven, no center involvement)
```

**Healthz scope**

`healthzRouter()` (existing, in `center/src/app.js`) is mounted on `webApp` today. The plan moves it into `buildServerApps` so all three apps (`webApp`, `heartbeatApp`, `reportApp`) include the same `healthz` route. The handler itself is unchanged — it still does DB healthcheck + last-heartbeat query.

---

## Schema

### `probe_state` table (migration 012, both dialects)

```sql
-- MySQL
CREATE TABLE probe_state (
  port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
  status               VARCHAR(16) NOT NULL,
  latency_ms           INT NULL,
  last_probe_at        DATETIME NULL,
  last_up_at           DATETIME NULL,
  consecutive_failures INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

```sql
-- MSSQL
CREATE TABLE probe_state (
  port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
  status               VARCHAR(16) NOT NULL,
  latency_ms           INT NULL,
  last_probe_at        DATETIME2 NULL,
  last_up_at           DATETIME2 NULL,
  consecutive_failures INT NOT NULL DEFAULT 0,
  CONSTRAINT ck_probe_role CHECK (port_role IN ('web','heartbeat','report')),
  CONSTRAINT ck_probe_status CHECK (status IN ('healthy','degraded','unknown'))
);
```

Three rows seeded by migration: `(web, unknown, NULL, NULL, NULL, 0)`, `(heartbeat, unknown, ...)`, `(report, unknown, ...)`. Status `unknown` is the starting state; first probe overwrites it.

### `system_config` table — no schema change

Reuses existing `config_key` / `config_value` / `description` / `updated_at` / `updated_by`. Three new key conventions:

| key | type | description |
|---|---|---|
| `listenPort` | number | Center web/admin UI port (was in appsettings.json) |
| `center_listen_port_pending_version` | string (sha256 hex) | Updated by ConfigView save of listenPort |
| `center_listen_port_started_version` | string (sha256 hex) | Updated by center startup |

Version hash = first 16 hex chars (8 bytes) of `sha256(<ISO timestamp>:<listenPort value>)`. Choice of sha256 vs timestamp-only is deliberate: timestamp alone collides on rapid saves; sha256 of "timestamp:port" gives a unique marker per change.

---

## Endpoints

### `GET /api/admin/heartbeat-report/probe`

Response shape (200):

```json
{
  "probes": {
    "web":       { "status": "healthy", "latencyMs": 3, "lastProbeAt": "2026-08-08T10:30:01.234Z", "lastUpAt": "...", "consecutiveFailures": 0 },
    "heartbeat": { "status": "healthy", "latencyMs": 4, "lastProbeAt": "...", "lastUpAt": "...", "consecutiveFailures": 0 },
    "report":    { "status": "healthy", "latencyMs": 5, "lastProbeAt": "...", "lastUpAt": "...", "consecutiveFailures": 0 }
  },
  "nowCenterProbeStale": false
}
```

`nowCenterProbeStale` = any `lastProbeAt` older than 30 seconds ago, OR all three rows are still in `unknown` status (boot window).

Auth: existing `[userAuth, requirePerm('admin:users')]` middleware (same as the other heartbeat-report endpoints).

### `GET /api/admin/config` (extended)

Existing response shape gains two keys:

```json
{
  "listenPort": 8080,
  "heartbeat_port": 8081,
  "report_port": 8082,
  "heartbeat_stale_seconds": 15,
  "restartRequired": {
    "listenPort": false
  },
  ...existing keys
}
```

`restartRequired.listenPort` is computed server-side from the two `system_config` version hashes: `pending_version !== started_version && pending_version != null`. Frontend reads this computed boolean only; it does not compute the hash itself. Note: `restartRequired` is **not** stored in `system_config` — only the two `*_version` strings are. The boolean is a view-layer convenience emitted by the GET handler.

---

## UI

### `ConfigView.vue` — three port rows

| key | label | description | numericField | validation |
|---|---|---|---|---|
| `listenPort` | "中心 Web 端口" | "对外 Web/管理界面端口。改完需重启 center 后生效。" | ✅ | 1–65535; reject 80, 443, 22, 3306, 1433 |
| `heartbeat_port` | "心跳端口" | "Agent 心跳接收端口。DB 改后 5 min 内 agent 自动刷新。" | ✅ | 1–65535; ≠ listenPort |
| `report_port` | "报告端口" | "Agent replication snapshot 上报端口。" | ✅ | 1–65535; ≠ listenPort, ≠ heartbeat_port |

All three go into `labels`, `descriptions`, `numericFields` (and `validations` if a new validation map is added — else validate inside the save handler).

### `ConfigView.vue` — "待重启" badge

Inline red badge right of the `listenPort` input when `restartRequired.listenPort === true`. Tooltip: "保存后值已生效，需重启 center 后生效。重启后此标记消失。" Badge does NOT appear for heartbeat_port / report_port (those take effect without restart via agent cache refresh).

### `HeartbeatReportMonitorView.vue` — "中心端口" summary panel

Position: top of the view, above the tab switcher. Three rows, fixed order: Web / 心跳 / 报告.

Each row shows: status dot, label (`Web :8080` / `心跳 :8081` / `报告 :8082`), status text (`healthy`/`degraded`/`unknown` + latency in ms), `lastProbeAt` relative time.

Three-state color mapping:

| Condition | Color | Label |
|---|---|---|
| `status == 'healthy'` AND `lastProbeAt` < 30s ago | Green | `healthy · <latencyMs>ms` |
| `status == 'unknown'` (first boot) OR `status == 'degraded'` OR `lastProbeAt` 30–60s ago | Yellow | `unknown` / `degraded · <latencyMs>ms` |
| `consecutive_failures >= 3` OR `lastProbeAt` > 60s ago OR `nowCenterProbeStale === true` (probe loop itself dead) | Red | `down · consecutiveFailures=N` |

Panel reuses the view's existing auto-refresh interval — no separate timer.

---

## Error handling

| Failure | Behavior |
|---|---|
| Probe fetch `ECONNREFUSED` | `status=degraded`, `consecutive_failures++`, `latency_ms=null`, no audit (still degraded — only flip on transition) |
| Probe fetch timeout (>2s) | Same as above |
| Probe fetch 503 (healthz returns degraded because DB slow) | `status=degraded`, `latency_ms=null` |
| `probe_state` table missing | Probe loop fails fast at startup; logs `migration 012 not applied`; center refuses to enter normal-mode bootstrap |
| Migration 012 itself fails | Standard migration runner fail-fast (existing) |
| Probe loop process crash | UI shows `nowCenterProbeStale=true` via stale `lastProbeAt` (every row older than 30s); three rows go red after 60s. Center writes one-shot audit warning if no probe write in 30s after startup (bootstrap-time watchdog). |
| `listenPort` validation rejects save | Standard ConfigView 400 (existing pattern); no DB write, no version hash bump |
| `listenPort` collides with heartbeat_port / report_port | Standard 400 from save handler |

---

## Testing

### Unit (`node:test`)

- `center/tests/services/probe.test.js`
  - 1 Hz tick: fetches each port, updates DB row
  - On status flip: writes audit exactly once
  - On consecutive failures: counter increments, resets on healthy
  - On fetch timeout: status=degraded, latency_ms=null
  - On startup with no probe_state table: throws synchronously
- `center/tests/config-listen-port.test.js`
  - Reads system_config.listenPort if present
  - Falls back to appsettings.json if absent
  - Seeds DB on first call when absent (one-time)
- `center/tests/heartbeat-report-probe.test.js`
  - GET /probe returns probes shape with all three roles
  - `nowCenterProbeStale=true` when lastProbeAt older than 30s
  - 401 without token

### Real-DB SQL (mandatory per `feedback_real_db_sql_tests.md`)

- `center/tests/sql/probe-state.test.js` — gated `TEST_MYSQL_URL` + `TEST_MSSQL_URL`. Exercises the upsert helper against both dialects.

### Integration

- `center/tests/integration/probe-loop.test.js` — spin up three local HTTP servers on random free ports returning `{status:'ok'}`; start probe loop targeting those ports; wait ≥3 ticks; read probe_state; assert `lastProbeAt` advanced and `status='healthy'` for all three.

### Frontend (vitest)

- `frontend/tests/admin-config-labels.test.js` — ConfigView has all three port labels in labels / descriptions / numericFields.
- `frontend/tests/config-restart-badge.test.js` — `restartRequired.listenPort=true` shows badge; `false` hides.
- `frontend/tests/heartbeat-report-probe-panel.test.js` — panel renders 3 rows; green/yellow/red mapping for healthy/degraded/unknown + stale; "down" label includes `consecutiveFailures` count.

### Manual smoke (documented in deployment.md)

1. `npm start` → wait 5s → `curl /api/admin/heartbeat-report/probe` → three `healthy` rows
2. ConfigView: edit `heartbeat_port=8089` → save → `curl /api/admin/config` → key updated; agent logs config refresh within 5 min
3. ConfigView: edit `listenPort=9090` → save → "待重启" badge appears; center still serves 8080; `lastProbeAt` keeps updating under 8080
4. Restart center → 9090 binds; badge disappears; probe rows now point at 9090
5. Kill one of the three app servers (e.g., heartbeatApp) → `status=degraded` within 1s; after 3 consecutive failures row goes red; restore server → flips back to healthy + `consecutive_failures=0`

---

## Migration

`center/src/db/migrations/012-probe-state.sql` (both dialects):

- MySQL: `CREATE TABLE probe_state (...)` + three INSERT seed rows.
- MSSQL: `CREATE TABLE probe_state (...)` + `CONSTRAINT ck_probe_role` + `CONSTRAINT ck_probe_status` + three INSERT seed rows.

Migration runner picks up file via existing auto-discovery. No new SQL helper needed for the create/insert (runner already executes multi-statement files).

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | 1 Hz probe audit-log spam on every tick | Audit only on status transition, not every tick. Estimated ≤ a few entries per day under normal operation. |
| R2 | Probe loop itself crashes (silent failure) | UI shows stale sentinel; bootstrap watchdog writes one-shot audit warning after 30s with no probe write. |
| R3 | `listenPort` migration breaks existing deployments | First-boot seed preserves `appsettings.json` value; existing deployments get the key auto-seeded with their current port. |
| R4 | Healthz 503 due to DB slow time causes false "port dead" | Accepted by user (D6). Documented as expected: degraded = service responding + DB slow. Operator sees DB health separately. |
| R5 | Migration 012 not yet applied → center refuses to start | Bootstrap fail-fast with explicit log message; operator must run migration first. Standard for project migrations. |
| R6 | Version hash collision on rapid saves | sha256 of "timestamp:port" — 16 hex chars give ~10⁹ distinct values; effectively zero collision risk. |

---

## Open questions for spec review

None — all 11 design decisions locked in brainstorming.

---

## Cross-references

- Origin: `progress_2026_08_07_heartbeat.md` (heartbeat/report multi-port + admin monitor shipped 2026-08-07)
- Tomorrow-prompt: `memory/project_next_session_prompt.md` (the trigger for this work)
- Today's progress: `memory/progress_2026_08_08.md` (brainstorming log)
- Related feedback memories:
  - `feedback_real_db_sql_tests.md` — migration 012 + probe_state.upsert must have real-DB tests
  - `feedback_ship_clean.md` — no drive-by cleanup bundled
  - `feedback_full_chain_cleanup.md` — `listenPort` migration must clean up appsettings.json entry as well (or document coexistence)
  - `feedback_powershell_51.md` — any install scripts must remain PS 5.1 compatible (if updated for `listenPort`)
  - `feedback_prod_build.md` — manual smoke uses `npm start`, not vite dev