import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus } from '../services/replication.js';
import { getConfig, getAgentConfig } from '../services/config.js';

// MySQL: last_heartbeat_at is auto-touched via NOW() in INSERT, and preserved
// (overwritten) on UPDATE. The IFNULL semantics from SQL Server become COALESCE.
const HEARTBEAT_UPSERT = `
INSERT INTO ad_agent_heartbeat (
  agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size
) VALUES (?, NOW(), ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  last_heartbeat_at   = NOW(),
  agent_version       = VALUES(agent_version),
  last_report_at      = COALESCE(VALUES(last_report_at), last_report_at),
  last_report_status  = COALESCE(VALUES(last_report_status), last_report_status),
  pending_queue_size  = VALUES(pending_queue_size)
`.trim();

const TOUCH_HEARTBEAT = `
UPDATE ad_agent_heartbeat
   SET last_report_at = NOW(),
       last_report_status = 'success'
 WHERE agent_id = ?
`.trim();

export function agentRouter({ config, pool, logger }) {
  const r = Router();
  const agentMw = agentToken(config.agentToken);

  r.post('/api/agent/heartbeat', agentMw, async (req, res) => {
    const { agentId, agentVersion, lastReportAt, lastReportStatus, pendingQueueSize } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'missing agentId' });
    try {
      await pool.execute(HEARTBEAT_UPSERT, [
        agentId,
        agentVersion ?? null,
        lastReportAt ?? null,
        lastReportStatus ?? null,
        pendingQueueSize ?? 0
      ]);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e, agentId }, 'heartbeat failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/agent/report', agentMw, async (req, res) => {
    const { agentId, collectedAt, data } = req.body || {};
    if (!agentId || !collectedAt || !Array.isArray(data)) {
      return res.status(400).json({ error: 'missing agentId, collectedAt, or data[]' });
    }
    try {
      const cfg = await getConfig(pool);
      const historyEnabled = String(cfg.history_enabled ?? 'false').toLowerCase() === 'true';
      const rows = data.map(row => ({ ...row, agentId, collectedAt }));
      await upsertStatus(pool, rows, { appendHistory: historyEnabled });
      await pool.execute(TOUCH_HEARTBEAT, [agentId]);
      const { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds, centerPublicHost, centerPublicPort } = await getAgentConfig(pool);
      res.json({ ok: true, config: { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds, centerPublicHost, centerPublicPort } });
    } catch (e) {
      logger.error({ err: e, agentId }, 'report failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/agent/config', async (_req, res) => {
    try {
      const full = await getAgentConfig(pool);
      res.json(full);
    } catch (e) {
      logger.error({ err: e }, 'agent config fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}