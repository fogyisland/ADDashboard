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

export const heartbeatReportService = {
  async listAgents(db = null) {
    const conn = db ?? getDb();
    const { rows: agents } = await conn.query(conn.sql.heartbeat.agentsList);
    const since = new Date(Date.now() - REPORT_SUMMARY_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    const heartbeatStaleSeconds = await this._staleSeconds();
    return {
      agents: await Promise.all(agents.map(async (row) => ({
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        lastHeartbeatAt: toIsoOrNull(row.last_heartbeat_at),
        lastReportAt: toIsoOrNull(row.last_report_at),
        lastReportStatus: row.last_report_status,
        pendingQueueSize: Number(row.pending_queue_size) || 0,
        reportSummary: await this._summaryFor(conn, row.agent_id, row.last_report_at, since)
      }))),
      heartbeatStaleSeconds
    };
  },

  async listDcs(db = null) {
    const conn = db ?? getDb();
    const { rows: dcs } = await conn.query(conn.sql.heartbeat.dcsList);
    const since = new Date(Date.now() - REPORT_SUMMARY_LOOKBACK_HOURS * 3600 * 1000).toISOString();
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
        reportSummary: await this._summaryFor(conn, row.agent_id, row.last_report_at, since)
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

  async _summaryFor(conn, agentId, lastReportAt, since) {
    if (!lastReportAt) return null;
    const { rows } = await conn.query(conn.sql.heartbeat.reportSummaryFor(agentId, since));
    if (!rows.length) return null;
    let successCount = 0;
    let failCount = 0;
    let latestErrorMessage = null;
    let latestFailedLink = null;
    for (const row of rows) {
      if (Number(row.status_code) === 0) {
        successCount++;
      } else {
        failCount++;
        if (!latestErrorMessage && row.error_message) {
          latestErrorMessage = row.error_message;
          latestFailedLink = `${row.source_dc}→${row.dest_dc}`;
        }
      }
    }
    return {
      totalLinks: rows.length,
      successCount,
      failCount,
      latestErrorMessage,
      latestFailedLink
    };
  },

  async _staleSeconds() {
    const cfg = await getConfig();
    return Number(cfg.heartbeat_stale_seconds) || 15;
  }
};