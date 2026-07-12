import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus } from '../services/replication.js';
import { getConfig, getAgentConfig } from '../services/config.js';
import { upsertDiscoveredDc } from '../services/discovery.js';
import { getDb } from '../db/index.js';

export function agentRouter({ config, logger }) {
  const r = Router();
  const agentMw = agentToken(config.agentToken);

  r.post('/api/agent/heartbeat', agentMw, async (req, res) => {
    const { agentId, agentVersion, pendingQueueSize } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'missing agentId' });
    try {
      const db = getDb();
      await db.execute(db.sql.heartbeat.upsert, [agentId, agentVersion ?? null, pendingQueueSize ?? 0]);
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
      const db = getDb();
      const cfg = await getConfig();
      const historyEnabled = String(cfg.history_enabled ?? 'false').toLowerCase() === 'true';
      await upsertStatus(
        data.map(row => ({ ...row, agentId, collectedAt })),
        { appendHistory: historyEnabled }
      );
      const { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds, centerPublicHost, centerPublicPort } = await getAgentConfig();
      res.json({ ok: true, config: { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds, centerPublicHost, centerPublicPort } });
    } catch (e) {
      logger.error({ err: e, agentId }, 'report failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/agent/discover', agentMw, async (req, res) => {
    const { agentId, collectedAt, dc } = req.body || {};
    if (!agentId || !collectedAt || !dc?.name) {
      return res.status(400).json({ error: 'missing agentId/collectedAt/dc.name' });
    }
    try {
      await upsertDiscoveredDc({ agentId, collectedAt, dc });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e, agentId }, 'discover failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/agent/config', async (_req, res) => {
    try {
      const full = await getAgentConfig();
      res.json(full);
    } catch (e) {
      logger.error({ err: e }, 'agent config fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
