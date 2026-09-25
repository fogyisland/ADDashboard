# Custom Port Healthcheck — Design Spec

**Date**: 2026-07-19
**Status**: Draft (pending user approval of written spec)

## Goal

Allow an admin to configure a global list of TCP ports (e.g. RPC 135, AD Kerberos 50001/50002/50003) that every agent should probe against `127.0.0.1` on a recurring cycle. Surface the latest per-port status (ok / latency) in the Agents dashboard and persist it in the center database.

## Scope

**In scope (full stack)**:
1. Agent probes a configured list of `host:port` pairs in parallel each healthcheck cycle, returns per-port `{ port, ok, latencyMs }` alongside existing `adModule / domain / center` checks.
2. Center accepts the new payload, persists the latest per-port results.
3. Frontend Agents view shows per-port status + latency inline.
4. Frontend gets a structured Ports admin view (CRUD) with a typed table.

**Out of scope (deferred to a later iteration)**:
- Alerting on port failure (the existing replication-latency alert pattern could be extended later)
- Per-agent port lists (we ship global only)
- External-host probing (we probe `127.0.0.1` only)
- Protocol-level probes (e.g. LDAP bind / RPC ping) — TCP-connect is sufficient
- A "test connection" admin button in the UI (admin can `Test-NetConnection` from a DC manually for now)

## Architecture

Five components, one-way data flow:

```
 ┌──────────┐    GET /api/agent/ports        ┌──────────┐
 │  Agent   │ ─────────────────────────────▶ │  Center  │
 │ (each DC)│ ◀───────────────────────────── │          │
 │          │   [{port, label}, ...]         │          │
 │          │                                │          │
 │          │   POST /api/agent/heartbeat    │          │
 │          │   { ..., ports: [...] }        │          │
 └──────────┘ ─────────────────────────────▶ └──────────┘
                                                │
                                                ▼
                                          ┌──────────┐
                                          │  MySQL/  │
                                          │  MSSQL   │
                                          └──────────┘
                                                ▲
                                          ┌──────────┐
                                          │ Frontend │
                                          └──────────┘
```

| Component | Responsibility |
|---|---|
| `agent/src/healthcheck.js` | Orchestrates TCP probes in parallel via `Promise.all` with per-port 2s timeout, returns `{ ok, checks, ports: [{port, ok, latencyMs}] }` |
| `agent/src/port-config-fetcher.js` (new) | `fetchPortList(centerUrl, agentToken)` → `GET /api/agent/ports`, caches last result, called by healthcheck at start of each cycle. Returns `[]` on any error |
| `center/src/services/ports.js` (new) | Thin wrapper around `db.sql.ports.*` (mirrors `sites.js`) |
| `center/src/services/port-status.js` (new) | `upsert(agentId, [{port, ok, latencyMs}])` — bulk upsert into `ad_agent_port_status` |
| `center/src/routes/agent.js` (extend) | `GET /ports`; `POST /heartbeat` now reads optional `req.body.ports` |
| `center/src/routes/admin.js` (extend) | `GET/POST/PUT/DELETE /api/admin/ports[/:id]` (mirrors `sites-catalog` route shape) |
| `center/src/routes/dashboard.js` (extend) | `GET /api/dashboard/agents` INNER JOINs `system_ports` + latest `ad_agent_port_status`, response gains `portStatuses: [{port, label, ok, latencyMs, lastCheckedAt}]` per agent. Stale rows with no matching `system_ports` row are hidden (not returned). |
| `frontend/src/views/admin/PortsView.vue` (new) | CRUD table mirroring `SitesCatalogView.vue` |
| `frontend/src/components/AgentStatusTable.vue` (extend) | Renders per-port badge per agent row: green (`ok=true,latency<100`), amber (`100-500`), red (`ok=false`/`latency>500`) |

## Storage

### `system_ports` (new)

```sql
-- MySQL
CREATE TABLE system_ports (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  port       INT NOT NULL,
  label      VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_system_ports_port (port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MSSQL (db/schema/mssql equivalent; no extra dialect-specific table here)
CREATE TABLE system_ports (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  port       INT NOT NULL,
  label      NVARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT uk_system_ports_port UNIQUE (port)
);
```

### `ad_agent_port_status` (new)

```sql
-- MySQL
CREATE TABLE ad_agent_port_status (
  agent_id        VARCHAR(64) NOT NULL,
  port            INT NOT NULL,
  ok              TINYINT(1) NOT NULL,
  latency_ms      INT NULL,
  last_checked_at DATETIME(3) NOT NULL,
  PRIMARY KEY (agent_id, port)
  -- intentionally NO FK to ad_agent_heartbeat: probe results are a separate
  -- fact from heartbeats and must survive retention purges of old heartbeats.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MSSQL
CREATE TABLE ad_agent_port_status (
  agent_id        VARCHAR(64) NOT NULL,
  port            INT NOT NULL,
  ok              BIT NOT NULL,
  latency_ms      INT NULL,
  last_checked_at DATETIME2(3) NOT NULL,
  CONSTRAINT pk_aps PRIMARY KEY (agent_id, port)
  -- intentionally NO FK to ad_agent_heartbeat (see MySQL note above)
);
```

### Migration

`db/migrations/003-port-healthcheck.sql` (new) — applies both tables. Idempotent (`CREATE TABLE IF NOT EXISTS`). No data backfill. The corresponding MSSQL version goes under `db/migrations/mssql/003-port-healthcheck.sql`.

## Endpoints

### Agent-side

| Method | Path                | Auth         | Returns |
|--------|---------------------|--------------|---------|
| GET    | `/api/agent/ports`  | agent token  | `[{port, label, sortOrder}]` ordered by `sortOrder, port`. Empty array if no ports configured |

### Admin-side (mirror `/sites-catalog` route shape)

| Method | Path                       | Auth         | Body / Behavior |
|--------|----------------------------|--------------|-----------------|
| GET    | `/api/admin/ports`         | `admin:users` | List all rows (camelCased) |
| POST   | `/api/admin/ports`         | `admin:users` | `{port, label, sortOrder?}` → 201 `{id}`. Validate `port ∈ [1, 65535]`, non-empty `label`. 409 on duplicate port |
| PUT    | `/api/admin/ports/:id`     | `admin:users` | Partial body. 404 if id missing |
| DELETE | `/api/admin/ports/:id`     | `admin:users` | 200. Stale `ad_agent_port_status` rows for that port are simply hidden via INNER JOIN — no explicit cascade needed |

### Dashboard-side

`GET /api/dashboard/agents` — unchanged request; response adds:
```json
{
  "agents": [
    {
      "agentId": "...",
      "lastHeartbeatAt": "...",
      "...": "...",
      "portStatuses": [
        { "port": 135, "label": "RPC", "ok": true, "latencyMs": 3, "lastCheckedAt": "..." },
        { "port": 50001, "label": "AD Kerberos", "ok": false, "latencyMs": 2000, "lastCheckedAt": "..." }
      ]
    }
  ]
}
```

INNER JOIN: rows in `ad_agent_port_status` whose port no longer exists in `system_ports` are filtered out (stale rows hidden — confirmed in design Q6).

## Heartbeat payload contract

`POST /api/agent/heartbeat` body adds an optional field:

```json
{
  "agentId": "dc01.contoso.com",
  "agentVersion": "0.1.0",
  "ports": [
    { "port": 135,   "ok": true,  "latencyMs": 3 },
    { "port": 50001, "ok": false, "latencyMs": 2000 }
  ]
}
```

- `ports` is optional. Pre-feature agents and agents with empty port list omit it entirely.
- `latencyMs` may be `null` (timeout case).
- Server response on success: `{ok: true, accepted: N, rejected: M}` — `rejected` counts invalid rows (bad type / out-of-range port) that were skipped.
- A row with `port` not in `system_ports` is also rejected (defense against admin-removed ports lingering on agents).

### Backward compatibility
- Old agents (no `ports` field) keep working — center ignores the field if absent.
- Existing test mocks for `findByUsername`, heartbeat, etc. keep passing unchanged.

## Error handling

| Layer | Failure mode | Behavior |
|---|---|---|
| `tcpProbe` | connect throws / 2s timeout | Catch, return `{port, ok:false, latencyMs:2000}`. Never let one bad port kill the whole cycle |
| `fetchPortList` | center unreachable / 5xx / 401 / malformed JSON | Log warn, return `[]`. Cycle runs with no probes |
| Heartbeat parse | `req.body.ports` not an array | 400 (treated as malformed, not partial) |
| Heartbeat parse | one row has invalid port / missing field | Skip row, increment `rejected` counter, accept the rest |
| Heartbeat parse | `port` not in `system_ports` | Skip row (defense) |
| Heartbeat upsert | DB error mid-upsert | Return 500, agent retries next cycle |
| Admin CRUD | `port` not in 1..65535 | 400 `{error: 'invalid port'}` |
| Admin CRUD | duplicate port | 409 `{error: 'port already exists'}` |
| Admin CRUD | empty `label` | 400 |
| Admin CRUD | DB error | 500 with logger.error |
| Admin DELETE | port in `ad_agent_port_status` | No action — those rows are simply hidden via INNER JOIN |

### Concurrency
- Concurrent heartbeats for the same `(agent_id, port)` resolve via `ON DUPLICATE KEY UPDATE` (MySQL) / `MERGE` (MSSQL). Last write wins.
- Agent pulls port list at cycle boundaries → worst-case staleness 10 min after admin edit. Documented, not a bug.
- Agent probe + admin DELETE race: if the probe races ahead of `DELETE`, the heartbeat's `INSERT … ON DUPLICATE KEY UPDATE` could recreate a row the admin wanted gone. Defense: server-side rejects rows whose `port` is not in `system_ports`. Net effect: race resolves safely within one cycle.

## Probe mechanics

```js
// agent/src/healthcheck.js (new helper)
async function tcpProbe(host, port, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, latencyMs) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ port, ok, latencyMs });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, Date.now() - start));
    sock.once('timeout', () => finish(false, timeoutMs));
    sock.once('error', () => finish(false, Date.now() - start));
    sock.connect(port, host);
  });
}
```

All probes in a cycle run concurrently via `Promise.all`. Wall time per cycle ≤ 2s regardless of port count.

## Testing

| Layer | File | New tests |
|---|---|---|
| Agent unit | `agent/tests/healthcheck.test.js` (new) | tcpProbe ok path; tcpProbe timeout → `{ok:false, latencyMs:2000}`; runHealthChecks returns aggregated ports; fetchPortList returns `[]` on 5xx |
| Center SQL | `center/tests/sql.test.js` (extend) | ports.create/list/update/delete parametrized mysql+mssql; portStatus.upsert bulk — second call's `(ok, latency_ms, last_checked_at)` wins on overlap |
| Center routes (admin) | `center/tests/admin.test.js` (extend) | GET/POST/PUT/DELETE /api/admin/ports* — auth, validation, dedupe |
| Center routes (agent) | `center/tests/agent-ports.test.js` (new) | GET /api/agent/ports empty + populated; POST /heartbeat with/without `ports`; heartbeat with malformed row → `accepted`/`rejected` |
| Center dashboard | `center/tests/dashboard.test.js` (extend) | GET /api/dashboard/agents includes `portStatuses`; stale rows in `ad_agent_port_status` whose port lacks a `system_ports` row are hidden |
| Migration parser | `center/tests/init/schema-applier.test.js` (extend) | Smoke test parses `003-port-healthcheck.sql` (2 CREATE TABLE statements; no DELIMITER needed). Defends against today's comment-bug class |
| Frontend | `frontend/tests/admin-ports-view.test.js` (new) | CRUD rows via modal, mirrors SitesCatalogView tests |
| Frontend | `frontend/tests/agents-view.test.js` (extend) | AgentStatusTable renders per-port badge with correct color tier; missing-port fallback shows `—` |

No new Pester tests (agent scripts unchanged).

### Coverage targets
- Center: 158 + ~12 ≈ 170 pass
- Agent: 21 + ~4 ≈ 25 pass
- Frontend: existing + ~4
- Migration parser: +1
- **Total target: ~180 pass / ~12 skip / 0 fail**

### Manual integration smoke (documented in PR)
`start.bat` → wait for center → `POST /api/admin/ports {port:135,label:"RPC"}` → restart agent → wait one healthCheckIntervalMs → verify row in `ad_agent_port_status` → verify row visible in `GET /api/dashboard/agents` for that agent.

## Decisions log (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | Full stack |
| 2 | Port scope | Global config (one list, all agents) |
| 3 | Probe behavior | 127.0.0.1 TCP connect, 2s timeout, reuse 10-min cycle |
| 4 | Storage shape | Separate `ad_agent_port_status` table |
| 5 | Config storage | Dedicated `system_ports` table + CRUD + view |
| 6 | Agent config delivery | `GET /api/agent/ports` (pull on startup + each cycle) |
| 7 | Stale rows display | Hidden (INNER JOIN with system_ports) |

## Open follow-ups (out of scope, for backlog)

- Alert on port failure (webhook / email / show banner)
- Per-agent port lists
- Protocol-level checks (LDAP bind, RPC ping)
- "Test connection" admin button
- History view of port status over time (currently only "latest" is exposed)
