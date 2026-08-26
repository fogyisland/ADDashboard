// Heartbeat/Report admin aggregator. Produces the per-agent view consumed by
// the admin monitor UI (Task 7): for each agent in ad_agent_heartbeat, return
// its current state plus a small "report summary" computed from the most
// recent ad_replication_status snapshot (within REPORT_SUMMARY_LOOKBACK_HOURS).
//
// Used by GET /api/admin/heartbeat-report/{agents,dcs,agents/:id/report-detail}.
// Only callable on the web app (per-route [userAuth, requirePerm('admin:users')]).

import { getDb } from '../db/index.js';
import { getConfig } from './config.js';

const REPORT_SUMMARY_LOOKBACK_HOURS = 24;
const REPORT_DETAIL_LIMIT = 100;

function toIsoOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// 2026-08-24 round-12 T3 — thrown by requestReport() when the agent row is
// not in ad_agent_heartbeat. The route layer (T5) catches this by `code`
// and translates to 404; the service stays HTTP-agnostic.
export class AgentNotFoundError extends Error {
  constructor(agentId) {
    super(`agent not found: ${agentId}`);
    this.code = 'AGENT_NOT_FOUND';
    this.agentId = agentId;
  }
}

export const heartbeatReportService = {
  async listAgents(db = null) {
    const conn = db ?? getDb();
    const { rows: agents } = await conn.query(conn.sql.heartbeat.agentsList);
    const heartbeatStaleSeconds = await this._staleSeconds();
    return {
      agents: await Promise.all(agents.map(async (row) => ({
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        lastHeartbeatAt: toIsoOrNull(row.last_heartbeat_at),
        lastReportAt: toIsoOrNull(row.last_report_at),
        lastReportStatus: row.last_report_status,
        pendingQueueSize: Number(row.pending_queue_size) || 0,
        // 2026-08-26 round-15: counts are aggregated in SQL over the
        // 1-hour lookback. reportSummary is null only when the agent has
        // NEVER produced a replication row — anything else (stale but
        // historical, or recent) returns a summary so the UI can decide
        // between ✅ / ⚠️ / 数据陈旧 / 未上传 without us duplicating that
        // logic here.
        reportSummary: row.last_report_at === null
          ? null
          : await this._summaryFor(conn, row.agent_id,
              Number(row.success_count) || 0,
              Number(row.fail_count) || 0,
              Number(row.total_count) || 0)
      }))),
      heartbeatStaleSeconds
    };
  },

  async listDcs(db = null) {
    const conn = db ?? getDb();
    const { rows: dcs } = await conn.query(conn.sql.heartbeat.dcsList);
    const heartbeatStaleSeconds = await this._staleSeconds();
    return {
      agents: await Promise.all(dcs.map(async (row) => ({
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        lastHeartbeatAt: toIsoOrNull(row.last_heartbeat_at),
        lastReportAt: toIsoOrNull(row.last_report_at),
        lastReportStatus: row.last_report_status,
        pendingQueueSize: Number(row.pending_queue_size) || 0,
        siteName: row.site_name ?? null,
        regionCode: row.region_code ?? null,
        ipAddress: row.ip_address ?? null,
        osVersion: row.os_version ?? null,
        isPdc: !!row.is_pdc,
        reportSummary: row.last_report_at === null
          ? null
          : await this._summaryFor(conn, row.agent_id,
              Number(row.success_count) || 0,
              Number(row.fail_count) || 0,
              Number(row.total_count) || 0)
      }))),
      heartbeatStaleSeconds
    };
  },

  async getLatestReportDetail(agentId, db = null) {
    const conn = db ?? getDb();
    const since = new Date(Date.now() - REPORT_SUMMARY_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    const query = conn.sql.heartbeat.latestReportEntries(agentId, since, REPORT_DETAIL_LIMIT);
    const { rows } = await conn.query(query, [agentId, agentId, since]);
    if (!rows.length) {
      return { agentId, collectedAt: null, entries: [] };
    }
    // The SQL constrains rows to one snapshot, so every row has this timestamp.
    const collectedAt = toIsoOrNull(rows[0].collected_at);
    return {
      agentId,
      collectedAt,
      entries: rows.map((r) => ({
        sourceDc: r.source_dc,
        destDc: r.dest_dc,
        sourceSite: r.source_site,
        destSite: r.dest_site,
        namingContext: r.naming_context,
        statusCode: r.status_code,
        errorMessage: r.error_message,
        lastSuccessTime: toIsoOrNull(r.last_success_time),
        lastAttemptTime: toIsoOrNull(r.last_attempt_time)
      }))
    };
  },

  // 2026-08-24 round-12 T3 — set the report_requested_at flag for one agent
  // so the next heartbeat ack tells it to ship a report immediately. The
  // UPSERT is silent on existence (it would happily INSERT a stub row for
  // an unknown agent), so we MUST SELECT 1 first to throw AgentNotFoundError
  // before any write. The current flag is read once to compute alreadyPending
  // (no race vs the agent consuming it — we don't care; the agent will treat
  // the latest value as authoritative).
  async requestReport(agentId, db = null) {
    const conn = db ?? getDb();
    const exists = await conn.execute(
      'SELECT 1 FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    const existsRows = exists?.rows ?? exists?.[0] ?? [];
    if (existsRows.length === 0) {
      throw new AgentNotFoundError(agentId);
    }

    const current = await conn.execute(
      'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    const currentRows = current?.rows ?? current?.[0] ?? [];
    const alreadyPending = currentRows.length > 0 &&
      currentRows[0].report_requested_at !== null &&
      currentRows[0].report_requested_at !== undefined;

    const requestedAt = new Date();
    const sql = conn.sql.heartbeat.requestReport(agentId, requestedAt.toISOString());
    await conn.execute(sql, [agentId, requestedAt]);

    return { agentId, requestedAt, alreadyPending };
  },

  // 2026-08-26 round-15: counts are pre-computed in SQL (1-hour window).
  // _summaryFor only does the latest-failure lookup, and only when the
  // 1-hour window saw at least one failure — otherwise the dashboard's
  // "错误摘要" column shows '—'. The earlier implementation iterated a
  // full snapshot and accumulated counts inline; that's now redundant.
  async _summaryFor(conn, agentId, successCount, failCount, totalCount) {
    if (totalCount === 0) {
      // Agent has a historical report (last_report_at non-null) but no
      // rows in the 1-hour window — surface empty summary so the UI can
      // still render a row.
      return { totalLinks: 0, successCount: 0, failCount: 0, latestErrorMessage: null, latestFailedLink: null };
    }
    let latestErrorMessage = null;
    let latestFailedLink = null;
    if (failCount > 0) {
      const { rows } = await conn.query(conn.sql.heartbeat.latestFailureFor(agentId), [agentId]);
      if (rows.length > 0) {
        latestErrorMessage = rows[0].error_message ?? null;
        latestFailedLink = `${rows[0].source_dc}→${rows[0].dest_dc}`;
      }
    }
    return {
      totalLinks: totalCount,
      successCount,
      failCount,
      latestErrorMessage,
      latestFailedLink
    };
  },

  async _staleSeconds() {
    const cfg = await getConfig();
    return Number(cfg.heartbeat_stale_seconds) || 15;
  },

  // Probe state for the admin monitor UI (Task 7). Reads the three rows
  // written by the 1 Hz self-probe loop and re-shapes them into camelCase
  // entries keyed by port_role. The 30 s stale sentinel fires when ANY row's
  // last_probe_at is older than 30 s OR ALL rows are still in the boot
  // 'unknown' state (no probe tick has completed yet).
  async listProbeStatus(db = null) {
    const conn = db ?? getDb();
    const { rows } = await conn.query(conn.sql.probeState.getAll);
    const probes = {};
    for (const row of rows) {
      probes[row.port_role] = {
        status: row.status,
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        lastProbeAt: toIsoOrNull(row.last_probe_at),
        lastUpAt: toIsoOrNull(row.last_up_at),
        consecutiveFailures: Number(row.consecutive_failures) || 0
      };
    }
    const now = Date.now();
    const STALE_MS = 30_000;
    const allUnknown = rows.length > 0 && rows.every((r) => r.status === 'unknown');
    const anyStale = rows.some((r) => {
      if (r.last_probe_at == null) return true;        // missing
      const t = new Date(r.last_probe_at).getTime();
      if (!Number.isFinite(t)) return true;             // NaN / Infinity (garbage string)
      if (t > now) return true;                         // future (clock skew — probe hasn't happened yet)
      return (now - t) > STALE_MS;                      // older than 30 s
    });
    return { probes, nowCenterProbeStale: allUnknown || anyStale };
  }
};