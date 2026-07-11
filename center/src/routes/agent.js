import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus } from '../services/replication.js';
import { getConfig, getAgentConfig } from '../services/config.js';

const HEARTBEAT_MERGE = `
MERGE INTO ad_agent_heartbeat AS tgt
USING (SELECT
  @agentId          AS agent_id,
  @agentVersion     AS agent_version,
  @lastReportAt     AS last_report_at,
  @lastReportStatus AS last_report_status,
  @pendingQueueSize AS pending_queue_size
) AS src
ON (tgt.agent_id = src.agent_id)
WHEN MATCHED THEN UPDATE SET
  last_heartbeat_at   = GETUTCDATE(),
  agent_version       = src.agent_version,
  last_report_at      = ISNULL(src.last_report_at, tgt.last_report_at),
  last_report_status  = ISNULL(src.last_report_status, tgt.last_report_status),
  pending_queue_size  = src.pending_queue_size
WHEN NOT MATCHED THEN INSERT (
  agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size
) VALUES (
  src.agent_id, GETUTCDATE(), src.agent_version, src.last_report_at, src.last_report_status, src.pending_queue_size
);
`.trim();

const TOUCH_HEARTBEAT = `
UPDATE ad_agent_heartbeat
   SET last_report_at = GETUTCDATE(),
       last_report_status = 'success'
 WHERE agent_id = @agentId;
`.trim();

export function agentRouter({ config, pool, logger }) {
  const r = Router();
  r.use(agentToken(config.agentToken));

  // POST /api/agent/heartbeat
  r.post('/api/agent/heartbeat', async (req, res) => {
    const { agentId, agentVersion, lastReportAt, lastReportStatus, pendingQueueSize } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'missing agentId' });
    try {
      await pool.request()
        .input('agentId', agentId)
        .input('agentVersion', agentVersion ?? null)
        .input('lastReportAt', lastReportAt ?? null)
        .input('lastReportStatus', lastReportStatus ?? null)
        .input('pendingQueueSize', pendingQueueSize ?? 0)
        .query(HEARTBEAT_MERGE);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e, agentId }, 'heartbeat failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/agent/report
  r.post('/api/agent/report', async (req, res) => {
    const { agentId, collectedAt, data } = req.body || {};
    if (!agentId || !collectedAt || !Array.isArray(data)) {
      return res.status(400).json({ error: 'missing agentId, collectedAt, or data[]' });
    }
    try {
      const cfg = await getConfig(pool);
      const historyEnabled = String(cfg.history_enabled ?? 'false').toLowerCase() === 'true';
      const rows = data.map(row => ({ ...row, agentId, collectedAt }));
      await upsertStatus(pool, rows, { appendHistory: historyEnabled });
      await pool.request()
        .input('agentId', agentId)
        .query(TOUCH_HEARTBEAT);
      const { pollingIntervalMinutes, latencyThresholdMinutes } = await getAgentConfig(pool);
      res.json({ ok: true, config: { pollingIntervalMinutes, latencyThresholdMinutes } });
    } catch (e) {
      logger.error({ err: e, agentId }, 'report failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/agent/config
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