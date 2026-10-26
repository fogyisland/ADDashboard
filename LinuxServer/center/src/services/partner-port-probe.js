// R125 — ad_partner_ports_probe post-hook helper.
//
// Why this exists:
//   ad_partner_ports_probe is a PUBLIC table write (operator's "公共表"
//   intent — same architectural pivot as R110.A's ad_dc_overview), so
//   the package manifest omits the `database` block to bypass the v2
//   metricstore guards. The metricstore path therefore never runs for
//   this package; we have to write to the table ourselves from a
//   runner.js post-hook.
//
// Wire shape (matches ad_partner_ports_probe/1.0.0/collect.ps1):
//   { metrics: { agent_id, collected_at, peers: [
//     { destDc, ports: [{port, ok, latency}, ...] }
//   ]}}
//
// One ad_replication_status row per (source_dc=this DC, dest_dc=peer DC,
// naming_context="__partner_ports__:<sha256[0..8]>"). Rows dedupe on
// (source_dc, dest_dc, naming_context), so a stale row from a previous
// 15-minute cycle is overwritten in-place — the dashboard's
// `latestPartnerPortPerPair` (sql.js dashboard.latestPartnerPortPerPair)
// only reads the latest collected_at per naming_context anyway.
//
// Same architectural patterns as services/dc-overview.js:
//   - dialect dispatch is BAKED INTO the SQL helper itself
//     (sql.js replication.upsertStatus takes positional params + JSON
//     encoding for both dialects; no per-dialect fork in this module).
//   - per-record try/catch so one bad peer doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summary for the runner
//     log line.
//   - falls back to fallbackAgentId when the wire shape omits agentId,
//     but here the wire shape aliases it to peerDc — see normalizePartnerProbe.

import crypto from 'node:crypto';

export function pickField(o, camelKey, snakeKey) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  return null;
}

// SHA-256 → first 4 bytes (8 hex chars) over `agentId|peerHost|partner_ports`.
// Byte-identical to the same algorithm in center/mock-snapshot.mjs:762-769
// (collect-replication.ps1 wires the same hash). Mock and real-agent
// partners emit a row keyed on the same naming_context for the same
// (agent, peer) tuple.
export function partnerPortNamingContext(agentId, peerHost) {
  const raw = `${agentId}|${peerHost}|partner_ports`.toLowerCase();
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `__partner_ports__:${hash}`;
}

export function normalizePartnerProbe(probe, fallbackAgentId) {
  // probe wire shape (matches collect.ps1 metrics.peers[i] AND
  // mock-snapshot.mjs buildPartnerPortEntries DestDc PascalCase that the
  // reporter converts to camelCase):
  //   { destDc, ports: [{port, ok, latency}, ...] }
  // Also accept peerDc / peer_dc / dest_dc for snake_case / legacy compat.
  // R132 — fix: prior version only checked peerDc/peer_dc, but real
  // collect.ps1 emits destDc (see agent stdout_preview: {"destDc":...}).
  // Skipped rows were silently dropped, surfacing as
  //   "partner_ports_probe.etl count:1 upserted:0 skipped:1 errors:0"
  // with no error and no DB row, breaking the
  //   /replication-log/monitor port-health surface.
  const agentId = pickField(probe, 'agentId', 'agent_id') || fallbackAgentId || null;
  const peerDc  = pickField(probe, 'destDc',  'dest_dc')
               || pickField(probe, 'peerDc',  'peer_dc')
               || null;
  if (!peerDc) {
    return null; // refuse to write a row without a destination identity
  }
  const rawPorts = Array.isArray(probe.ports)
    ? probe.ports
    : (Array.isArray(probe.portResults) ? probe.portResults : []);
  // Defence-in-depth — coerce port probe entries to {port, ok, latency};
  // the PS1 emits this shape literally but the helper may be re-used for
  // mock ingestion (mock-snapshot.mjs probeMockPort returns the same shape
  // at line 771-783). Latency stays integer-millis (or null when unreachable).
  const ports = rawPorts.map((p) => ({
    // R158.52 — the previous pickField call passed the same key twice
    // (camelCase=snake_case), which is dead code. Default missing port to
    // 0 so JSON_VALUE never returns null into a NOT NULL INT column.
    port:    Number(p?.port ?? 0),
    ok:      pickField(p, 'ok',      'ok'),
    latency: pickField(p, 'latency', 'latency')
  }));
  return {
    agentId,
    peerDc,
    ports
  };
}

// Compute status / error / success-time from the per-port probe array.
// Mirrors mock-snapshot.mjs buildPartnerPortEntries:816-833:
//   unreachable count = 0        → status 0 (all reachable)
//   unreachable count = ports    → status 2 (all unreachable)
//   mixed                          → status 1 (partial)
// Status 0 → lastSuccessTime = ts; status 1/2 → null.
function deriveStatus(ports) {
  const unreachableCount = ports.filter((p) => !p.ok).length;
  if (unreachableCount === 0) return { status: 0, lastSuccessTime: '__TS__', errorMessage: null };
  if (unreachableCount === ports.length) {
    return { status: 2, lastSuccessTime: null, errorMessage: 'all partner ports unreachable' };
  }
  return { status: 1, lastSuccessTime: null, errorMessage: 'partial partner port reachability' };
}

// Stub used as a ts placeholder — replaced by the caller once collectedAt
// is known. Keeps deriveStatus pure of state for unit-testability.
export async function upsertPartnerProbe(db, probe, fallbackAgentId = null, log = null) {
  const normalized = normalizePartnerProbe(probe, fallbackAgentId);
  if (!normalized) {
    return { ok: false, reason: 'missing peer_dc', probe };
  }
  const collectedAtRaw = pickField(probe, 'collectedAt', 'collected_at');
  const collectedAt = collectedAtRaw instanceof Date
    ? collectedAtRaw
    : (collectedAtRaw ? new Date(collectedAtRaw) : new Date());

  // source_dc is the agent that ran the probe (this DC); dest_dc is the
  // peer. naming_context is the synthetic partner-port key per
  // (agent, peer) tuple. sites are not available on the PS1 wire shape
  // (collect.ps1 only resolves destDc + portResults); site lookup
  // happens at the centre side via the existing ad_dcs table when the
  // dashboard renders the row — same R110.A pattern. Keep sourceSite /
  // destSite null here so the row stays queryable without a join.
  const agentId       = normalized.agentId || fallbackAgentId;
  const peerDc        = normalized.peerDc;
  const namingContext = partnerPortNamingContext(agentId, peerDc);

  const { status, lastSuccessTime, errorMessage } = deriveStatus(normalized.ports);
  const lastAttemptTime = collectedAt;
  const effectiveLastSuccessTime = lastSuccessTime === '__TS__' ? collectedAt : lastSuccessTime;

  // partner_port_status is the JSON column; both dialects accept a JSON
  // string here (mysql2 / mssql both store a string in the parameterized
  // JSON / NVARCHAR(MAX) column). The replication.upsertStatus SQL helper
  // at sql.js:23 (mysql) / sql.js:1107 (mssql) does NOT JSON.stringify
  // internally, so we encode at this boundary.
  const partnerPortStatus = JSON.stringify({ ports: normalized.ports });

  // replication.upsertStatus takes positional params in this order
  // (sql.js:23 mysql + sql.js:1107 mssql — both dialects accept the same
  // 12-param shape via `?` placeholders):
  //   collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
  //   naming_context, last_success_time, last_attempt_time, status_code,
  //   error_message, partner_port_status
  // Bound via db.execute(sqlString, [12 params]) — same dispatch as
  // services/replication.js rowParams.
  const params = [
    collectedAt,
    agentId,
    agentId,        // source_dc = this DC
    peerDc,         // dest_dc = peer
    null,           // source_site — null, not resolved at agent level
    null,           // dest_site   — null, not resolved at agent level
    namingContext,
    effectiveLastSuccessTime,
    lastAttemptTime,
    status,
    errorMessage,
    partnerPortStatus
  ];
  try {
    await db.execute(db.sql.replication.upsertStatus, params);
    // R158.X.116.p (2026-10-23) — 端口探测失败也要进后台复制错误页.
    // 本函数是 ad_replication_status 的第二个写入点 (另一个是
    // services/replication.js upsertStatus), 之前直接 db.execute 绕过了
    // 那边的 ad_replication_active_errors 双写逻辑 → 端口不可达
    // (status 1/2) 永远不会出现在 /admin/replication-errors.
    // 两处写入点必须同判定, 否则又是口径分裂 (lesson 158/159).
    // 判定用 `> 0` 与 replication.js:sc > 0 及 sql.js listActiveErrors
    // 的 `status_code > 0` 三方收敛; 本函数 status 由 deriveStatus 产,
    // 值域 0/1/2, `> 0` 与 `=== 1 || === 2` 等价但对未来的 Windows
    // 错误码更稳健。
    if (status === 0) {
      try {
        await db.execute(db.sql.replication.removeActiveError, [
          agentId, peerDc, namingContext
        ]);
      } catch (e) {
        log?.warn?.({ err: e?.message, peerDc, agentId },
          'partner-port-probe removeActiveError failed (auto-remove skipped)');
      }
    } else if (status > 0) {
      try {
        await db.execute(db.sql.replication.upsertActiveError, [
          agentId, peerDc, namingContext, status,
          lastAttemptTime, lastAttemptTime, lastAttemptTime, errorMessage
        ]);
      } catch (e) {
        log?.warn?.({ err: e?.message, peerDc, agentId, namingContext, status },
          'partner-port-probe upsertActiveError failed (active-error row NOT recorded)');
      }
    }
    return { ok: true, peerDc, status };
  } catch (e) {
    log?.error?.({
      event: 'partner_port_probe.upsert_failed',
      peerDc,
      agentId,
      err: e?.message || String(e)
    }, 'partner-port-probe upsert failed');
    return { ok: false, reason: e?.message || String(e), peerDc };
  }
}

// Batch wrapper: skip null entries (missing peerDc), swallow per-row
// errors so one bad peer doesn't kill the batch. Mirrors
// services/dc-overview.js upsertOverviews() shape.
//
// R132 — fix: skipped rows were previously silent. The runner.js
// post-hook pushes `result.errors` back to the agent via
//   POST /api/agent/packages/report → { processed, errors }
// so a `missing peer_dc` skipped row now lands there with
//   `{ error: 'partner_ports_probe ETL skipped 1 row(s) — missing peer_dc' }`
// instead of disappearing. Post-mortem: grep
//   "partner_ports_probe ETL" / "missing peer_dc" in centre logs.
export async function upsertPartnerProbes(db, probes, fallbackAgentId = null, log = null) {
  if (!Array.isArray(probes) || probes.length === 0) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    try {
      const res = await upsertPartnerProbe(db, probe, fallbackAgentId, log);
      if (res.ok) {
        upserted++;
      } else if (res.reason === 'missing peer_dc') {
        skipped++;
        // Surface the skip on the same channel as real ETL errors so the
        // agent + centre operator see "something was off about this peer"
        // instead of `count:1 upserted:0 skipped:1 errors:0` (silent).
        errors.push({ index: i, error: 'missing peer_dc', peer: probe });
      } else {
        errors.push({ index: i, peerDc: res.peerDc ?? null, error: res.reason });
      }
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// (normalizePartnerProbe is already exported via `export function`
// above — single source of truth.)

// R158.X.116.d (2026-10-22) — 删 upsertOutboundProbe / upsertOutboundProbes
//   (R155.4 引入)。ad_dc_probe_outbound 表已 DROP (migration 038), BUILTIN
//   包条目已移除, runner 门控因 package_scripts 0 行而永不为真 (实测 2026-10-22:
//   该表 0 行, 同族活包 ad_dc_probe_inbound 1 行 v1.0.2)。探针包脚本已归档
//   .backups/packages-ad_dc_probe_outbound-20261022/。
//   normalizePartnerProbe / deriveStatus 仍被 inbound helper 使用, 保留。
