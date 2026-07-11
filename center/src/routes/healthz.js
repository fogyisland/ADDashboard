import { Router } from 'express';
import { getPool } from '../db.js';

export function healthzRouter() {
  const r = Router();
  r.get('/healthz', async (req, res) => {
    try {
      const pool = await getPool();
      const [ping] = await pool.execute('SELECT 1 AS ok');
      const [last] = await pool.execute(
        'SELECT last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC LIMIT 1'
      );
      res.json({ status: 'ok', db: ping[0]?.ok === 1 ? 'ok' : 'fail', lastHeartbeat: last[0]?.last ?? null });
    } catch (e) {
      res.status(503).json({ status: 'degraded', error: e.message });
    }
  });
  return r;
}