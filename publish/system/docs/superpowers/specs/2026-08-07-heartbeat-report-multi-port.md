# Heartbeat / Report Multi-Port + AD Server Monitor — Design Spec

> Status: **draft** (awaiting user review)

## 1. Goal

Allow the AD Dashboard **Center** service to listen on **separate ports** for
web traffic, agent heartbeats, and agent replication reports, so that
high-frequency heartbeat traffic and bursty report traffic can be isolated
by firewall / load-balancer / nginx rules. Add an **admin panel view** that
shows live heartbeat status (color-coded dot + "X seconds ago") and report
summaries for every agent / DC.

## 2. Architecture Overview

Three independent `http.Server` instances, each bound to a different port and
mounting a different Express app. The agent picks up the configured ports via
`/api/agent/config` (no agent restart required).

```
                ┌───────────────┐
                │ Agent (per DC)│
                └───────┬───────┘
                        │
                        ▼
        ┌───────────────┼───────────────────────────────┐
        ▼               ▼                               ▼
  ┌──────────┐   ┌───────────────┐              ┌──────────┐
  │ webPort  │   │ heartbeatPort │              │ reportPort│
  │  (8080)  │   │   (8081)      │              │  (8082)   │
  └────┬─────┘   └───────┬───────┘              └─────┬─────┘
       │                 │                            │
  webServer        heartbeatServer              reportServer
   (admin UI,      (POST /api/agent/        (POST /api/agent/
    auth, admin      heartbeat)               report, /discover,
    APIs)                                    /config — anything
                                              low-freq / heavy)
```

**Default ports:** `webPort=8080`, `heartbeatPort=8081`, `reportPort=8082`.

**Dedupe rule:** if `heartbeatPort == webPort` (or `reportPort == webPort`),
no separate server is started — the route is mounted on the existing web
server. Same for `heartbeatPort == reportPort`. The 3 servers collapse to
1 when all three ports match.

## 3. Configuration

Three new keys in `system_config`:

| Key                          | Type | Default | Description                                                  |
|------------------------------|------|---------|--------------------------------------------------------------|
| `heartbeat_port`             | int  | 8081    | Center's listener port for heartbeat traffic                 |
| `report_port`                | int  | 8082    | Center's listener port for report traffic                    |
| `heartbeat_stale_seconds`    | int  | 15      | Gap threshold for "stale" heartbeat (yellow/red color)       |

`listenPort` continues to serve as `web_port` (existing key, not renamed).

`ConfigView.vue` automatically shows these three new rows (label, value,
description) because it renders all `system_config` rows dynamically. No
Vue code change is required for display — only the labels/descriptions map
needs the three new entries.

`appsettings.example.json` (both `center/` and `publish/center/`) gets the
three new fields with default values and inline comments.

`getAgentConfig()` in `center/src/services/config.js` expands to:

```js
return {
  pollingIntervalMinutes, latencyThresholdMinutes,
  heartbeatIntervalSeconds, discoveryIntervalHours,
  agentToken,
  heartbeatPort: Number(all.heartbeat_port || 8081),
  reportPort: Number(all.report_port || 8082),
  heartbeatStaleSeconds: Number(all.heartbeat_stale_seconds || 15)
};
```

## 4. Center Implementation

### 4.1 `center/src/multi-port.js` (new)

```js
import { createServer } from 'node:http';

export async function startServers({ logger, roleAppPortList }) {
  // roleAppPortList: [{ role: 'web'|'heartbeat'|'report', app, port }, ...]
  // Returns: [{ srv, role, port }]
  const dedup = dedupeByPort(roleAppPortList);
  const promises = dedup.map(({ role, app, port }) =>
    new Promise((resolve, reject) => {
      const srv = createServer(app);
      srv.once('error', reject);
      srv.listen(port, () => {
        logger.info({ port, role }, `${role} server listening`);
        resolve({ srv, role, port });
      });
    })
  );
  return Promise.all(promises);
}

export async function closeAll(servers, logger) {
  await Promise.all(servers.map(({ srv, role }) =>
    new Promise((resolve) => {
      srv.close((err) => {
        if (err) logger.warn({ err: err.message, role }, 'server close error');
        resolve();
      });
    })
  ));
}

function dedupeByPort(list) {
  const seen = new Set();
  return list.filter((t) => {
    const key = `${t.port}:${t.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

### 4.2 `center/server.js` restructure

Currently a single `app.use(...)` chain. Split into three Express apps:

```js
const webApp       = createApp({ config: finalConfig, db, logger, needsInit });
const heartbeatApp = express();
heartbeatApp.use(express.json({ limit: '256kb' }));
heartbeatApp.use(agentRouter({ config: finalConfig, logger, mount: 'heartbeat' }));

const reportApp    = express();
reportApp.use(express.json({ limit: '10mb' }));
reportApp.use(agentRouter({ config: finalConfig, logger, mount: 'report' }));
```

In **init mode** (`needsInit === true`), heartbeat/report servers are NOT
started — the wizard owns the full port and only the webApp runs.

In **normal mode**, the three apps start concurrently:

```js
const servers = await startServers({
  logger,
  roleAppPortList: [
    { role: 'web',       app: webApp,       port: finalConfig.listenPort },
    { role: 'heartbeat', app: heartbeatApp, port: heartbeatPort },
    { role: 'report',    app: reportApp,    port: reportPort },
  ].filter((t) => t.port && t.port > 0)
);
```

Shutdown:

```js
const shutdown = async (sig) => {
  await closeAll(servers, logger);
  try { await closeWizardFacade(); } catch {}
  try { await close(); } catch {}
  process.exit(0);
};
```

### 4.3 `agentRouter` `mount` parameter

```js
export function agentRouter({ config, logger, mount = 'full' }) {
  const r = Router();
  const agentMw = agentToken(config.agentToken);

  if (mount === 'heartbeat' || mount === 'full') {
    r.post('/api/agent/heartbeat', agentMw, /* ... existing handler ... */);
  }
  if (mount === 'report' || mount === 'full') {
    r.post('/api/agent/report',     agentMw, /* ... */);
    r.post('/api/agent/discover',   agentMw, /* ... */);
    r.get ('/api/agent/config',            /* ... */);
  }
  if (mount === 'full') {
    r.get('/api/agent/ports',       agentMw, /* ... */);
  }
  return r;
}
```

Mount split:
- `heartbeat` mount: `/heartbeat` + `/ports` (lightweight probe-list fetch)
- `report` mount: `/report` + `/discover` + `/config` (low-freq, big payloads)
- `full` mount: all routes (legacy)

### 4.4 Body size limits

- heartbeatApp: `express.json({ limit: '256kb' })` — heartbeats are small
- reportApp: `express.json({ limit: '10mb' })` — replication snapshots have 12+ rows with long error strings

These limits prevent one slow client from holding memory.

## 5. Agent Implementation

### 5.1 `agent/src/reporter.js` URL override

```js
function baseUrl({ centerUrl, port }) {
  if (!port) return centerUrl.replace(/\/+$/, '');
  return centerUrl.replace(/:\d+$/, '').replace(/\/+$/, '') + ':' + port;
}

export function postHeartbeat({ centerUrl, agentToken, port, payload }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/heartbeat`,
    headers: { 'X-Agent-Token': agentToken },
    body: payload,
  });
}

export function postReport({ centerUrl, agentToken, port, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: {
      agentId: snapshot.AgentId ?? snapshot.agentId,
      collectedAt: snapshot.CollectedAt ?? snapshot.collectedAt,
      data: Array.isArray(snapshot.Entries) ? snapshot.Entries.map(toCamelEntry) : []
    },
  });
}
```

### 5.2 `agent/agent.js` port cache

```js
let cachedPorts = { heartbeatPort: null, reportPort: null };

async function refreshAgentPorts() {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data) {
    cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
    cachedPorts.reportPort = Number(r.data.reportPort) || null;
  }
}

await refreshAgentPorts(); // startup
// existing 5-minute refresh timer calls refreshAgentPorts() too
```

`postHeartbeat({ port: cachedPorts.heartbeatPort, ... })`
`postReport({ port: cachedPorts.reportPort, ... })`

`fetchPortList` (`/api/agent/ports`) is a different endpoint from
`/api/agent/config` — it returns port numbers the agent should probe,
not port numbers to connect to. No name collision.

### 5.3 Backward compatibility

- If `cachedPorts.heartbeatPort` is null (config missing on center), the
  agent uses `centerUrl` verbatim — same behavior as today.
- Existing agents that don't refresh ports use `config.centerUrl` — same
  behavior as today.
- `centerUrl: "http://center:8080"` and `centerUrl: "http://center"` both
  work; the regex strips `:port` only when an override `port` is given.

## 6. Admin Panel

### 6.1 New page

`frontend/src/views/admin/HeartbeatReportMonitorView.vue` mounted at
`/admin/heartbeat-report`. Added to AdminLayout sidebar under "端口健康检查"
(same operational-monitoring group).

### 6.2 Layout

```
┌─────────────────────────────────────────────────────────────┐
│ 心跳与报告监控                                            [↻]│
│                                                              │
│ [按 Agent] [按 DC]                                          │
│                                                              │
│ 心跳表                                                      │
│ ┌──────┬─────────────┬─────────┬─────────────┬──────────┐  │
│ │ 状态 │ Agent/DC 名称│ 站点    │ 最新心跳时间 │ 延迟    │  │
│ ├──────┼─────────────┼─────────┼─────────────┼──────────┤  │
│ │ 🟢  │ dc01.contoso│ Site-A  │ 2 秒前      │ 4s       │  │
│ │ 🟡  │ dc02.contoso│ Site-B  │ 32 秒前     │ 6s       │  │
│ │ 🔴  │ dc03.contoso│ Site-A  │ 5 分钟前    │ —        │  │
│ └──────┴─────────────┴─────────┴─────────────┴──────────┘  │
│                                                              │
│ 报告表                                                       │
│ ┌──────┬─────────────┬─────────┬───────────┬────────────┐  │
│ │ 状态 │ Agent/DC 名称│ 最近报告│ 错误摘要  │ 成功率    │  │
│ ├──────┼─────────────┼─────────┼───────────┼────────────┤  │
│ │ ✅  │ dc01.contoso│ 3 分钟前│ —         │ 100% (12) │  │
│ │ ⚠️  │ dc02.contoso│ 1 小时前│ 复制延迟高│ 75% (4/16)│  │
│ │ ⏸  │ dc03.contoso│ 未上传  │ —         │ —         │  │
│ └──────┴─────────────┴─────────┴───────────┴────────────┘  │
│                                                              │
│ 自动刷新: [5 秒 ▼]                                          │
└─────────────────────────────────────────────────────────────┘
```

Click a row → right-side drawer shows full report payload (last 100 lines
JSON) and recent error history.

### 6.3 Heartbeat color rules

| Condition                                                  | Color |
|------------------------------------------------------------|-------|
| `lastHeartbeatAt IS NULL`                                  | ⚪ grey ("从未上报") |
| `now - lastHeartbeatAt <= heartbeat_stale_seconds`         | 🟢 green |
| `heartbeat_stale_seconds < gap <= 60`                      | 🟡 yellow |
| `gap > 60`                                                 | 🔴 red |

`heartbeat_stale_seconds` is fetched from center config (default 15) and
shipped in the agent list response so the frontend doesn't need its own
copy.

### 6.4 Report summary fields

Per agent (one query joining `ad_agent_heartbeat` LEFT JOIN
`ad_replication_status`):

- `lastReportAt` = `MAX(ad_replication_status.collected_at)` for this agent
- `latestErrorMessage` = `MAX(error_message) WHERE status_code != 0`
- `latestFailedLink` = `CONCAT(source_dc, '→', dest_dc) WHERE status_code != 0 ORDER BY collected_at DESC LIMIT 1`
- `totalLinks` = `COUNT(*)` for the most recent `collected_at`
- `successCount` = `COUNT(*) WHERE status_code = 0` for the most recent
- `failCount` = `totalLinks - successCount`

### 6.5 Tab differences

- **按 Agent tab**: agent_id, agent_version, last_heartbeat_at, last_report_at, last_report_status, pending_queue_size
- **按 DC tab**: same columns PLUS dc_name (== agent_id), site_name,
  region_code, ip_address, os_version, is_pdc (joined from ad_dcs + ad_sites)

In practice agent_id == dc_name (the agent runs on the DC it monitors), so
the row set is the same. The DC tab adds location metadata; the Agent tab
adds queue/version metadata. Both backed by different
`/api/admin/heartbeat-report/{agents,dcs}` endpoints.

### 6.6 Auto-refresh

Default 5s. User can change to 10s / 30s / off. The refresh interval is
cleared in `onBeforeUnmount` to avoid leaked timers when the user navigates
away.

## 7. Backend Admin Endpoints

### 7.1 `GET /api/admin/heartbeat-report/agents` (auth)

Returns:

```json
{
  "agents": [
    {
      "agentId": "dc01.contoso",
      "agentVersion": "0.1.0",
      "lastHeartbeatAt": "2026-08-07T15:30:00Z",
      "lastReportAt": "2026-08-07T15:15:00Z",
      "lastReportStatus": "ok",
      "pendingQueueSize": 0,
      "reportSummary": {
        "totalLinks": 12,
        "successCount": 12,
        "failCount": 0,
        "latestErrorMessage": null,
        "latestFailedLink": null
      }
    },
    {
      "agentId": "dc03.contoso",
      "agentVersion": null,
      "lastHeartbeatAt": null,
      "reportSummary": null
    }
  ],
  "heartbeatStaleSeconds": 15
}
```

### 7.2 `GET /api/admin/heartbeat-report/dcs` (auth)

Same shape but `dc_name` (== agentId), `siteName`, `regionCode`, `ipAddress`,
`osVersion`, `isPdc`. Missing DC info → row still appears with null site
fields (LEFT JOIN).

### 7.3 `GET /api/admin/heartbeat-report/agents/:agentId/report-detail` (auth)

Returns the full last report JSON for the side-drawer detail view:

```json
{
  "agentId": "dc01.contoso",
  "collectedAt": "...",
  "entries": [
    { "sourceDc": "...", "destDc": "...", "statusCode": 0, "errorMessage": null, ... },
    ...
  ]
}
```

Truncated to last 100 entries if larger.

## 8. Testing

### 8.1 Backend

**`center/tests/multi-port.test.js`** (4 tests)
- three different ports → 3 servers created
- `heartbeatPort == webPort` → only 2 servers (dedupe)
- listen error on one → `startServers` rejects, no zombie servers
- `closeAll` is idempotent

**`center/tests/routes/agent-multi-mount.test.js`** (3 tests)
- `mount: 'heartbeat'` → `/heartbeat` 200, `/report` 404
- `mount: 'report'` → `/report` 200, `/heartbeat` 404
- `mount: 'full'` → all routes 200

**`center/tests/admin-heartbeat-report.test.js`** (4 tests)
- `/agents` returns correct JSON shape (mock `ad_agent_heartbeat` + `ad_replication_status`)
- `/dcs` joins `ad_dcs` correctly (no match → null site fields)
- agent with no reports → `lastReportAt: null`, `reportSummary: null`
- 401 without token

### 8.2 Frontend

**`frontend/tests/heartbeat-report-monitor-view.test.js`** (5 tests)
- default tab = "按 Agent"
- 4-color heartbeat rendering (green/yellow/red/grey-never)
- report summary OK / partial-fail / never-reported
- click row opens drawer with payload
- 5s auto-refresh tick (vi.useFakeTimers)

### 8.3 Agent

**`agent/tests/reporter-multi-port.test.js`** (3 tests)
- `postHeartbeat({ port: 8081 })` URL = `http://host:8081/api/agent/heartbeat`
- `postHeartbeat({ port: null })` URL = `centerUrl` verbatim
- `postReport` mirror of above

## 9. Migration / Rollout

- **No DB migration**: only new rows in `system_config` (key-value store)
- **No appsettings.json change required**: defaults from `getAgentConfig()` (8081/8082/15) apply automatically
- **No agent restart required**: agent picks up ports via `/api/agent/config` every 5min
- **Backward compatible**: existing agent with no port override continues to use `centerUrl:8080`

## 10. Out of Scope

- TLS per-port (use a single TLS terminator like nginx in front)
- Per-agent port overrides (all agents use the same two ports)
- WebSocket push for live updates (5s polling is enough; YAGNI)
- Historical heartbeat timeline (point-in-time snapshot only)
- Agent-side fallback logic (if new port is unreachable, fall back to centerUrl port) — agent just retries; no special handling

## 11. Risks

1. **Firewall rules**: deploying centers must open the new ports (8081/8082). Mitigation: document in deployment.md.
2. **Default-port collision**: if 8081/8082 are taken on the host, the center fails to start. Mitigation: clear error log line + admin can change in ConfigView.
3. **Three servers = three uncaughtException handlers**: keep them on the shared logger; each server still has its own handler.
4. **Schema drift on heartbeat table**: existing columns only; no migration.