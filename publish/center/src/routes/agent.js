import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus } from '../services/replication.js';
import { getConfig, getAgentConfig } from '../services/config.js';
import { upsertDiscoveredDc } from '../services/discovery.js';
import { listPorts } from '../services/ports.js';
import { upsertPortStatuses } from '../services/port-status.js';
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

export function agentRouter({ config, logger }) {
  const r = Router();
  const agentMw = agentToken(config.agentToken);

  r.get('/api/agent/ports', agentMw, async (_req, res) => {
    try {
      const rows = await listPorts();
      res.json(rows);
    } catch (e) {
      logger.error({ err: e }, 'agent ports fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/agent/heartbeat', agentMw, async (req, res) => {
    const { agentId, agentVersion, pendingQueueSize, lastReportAt, lastReportStatus, ports } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'missing agentId' });
    try {
      const db = getDb();
      await db.execute(db.sql.heartbeat.upsert, [
        agentId,
        agentVersion ?? null,
        toMysqlDatetime(lastReportAt),
        lastReportStatus ?? null,
        pendingQueueSize ?? 0
      ]);

      // Optional port-status ingest (back-compat: pre-feature agents omit `ports`).
      if (ports !== undefined && ports !== null) {
        if (!Array.isArray(ports)) {
          return res.status(400).json({ error: 'ports must be an array' });
        }
        const portRows = await listPorts();
        const validPortsSet = new Set(portRows.map(p => p.port));
        const { accepted, rejected } = await upsertPortStatuses(agentId, ports, { validPortsSet });
        return res.json({ ok: true, accepted, rejected });
      }

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
      const { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds } = await getAgentConfig();
      res.json({ ok: true, config: { pollingIntervalMinutes, latencyThresholdMinutes, heartbeatIntervalSeconds } });
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
