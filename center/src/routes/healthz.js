import { Router } from 'express';
import { getPool } from '../db.js';

export function healthzRouter() {
  const r = Router();
  r.get('/healthz', async (req, res) => {
    try {
      const pool = await getPool();
      const r1 = await pool.request().query("SELECT 1 AS ok");
      const r2 = await pool.request().query(
        "SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC"
      );
      res.json({ status: 'ok', db: r1.recordset[0].ok === 1 ? 'ok' : 'fail', lastHeartbeat: r2.recordset[0]?.last ?? null });
    } catch (e) {
      res.status(503).json({ status: 'degraded', error: e.message });
    }
  });
  return r;
}
