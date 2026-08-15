import { Router } from 'express';
import { getDb } from '../db/index.js';

export function healthzRouter() {
  const r = Router();
  r.get('/healthz', async (_req, res) => {
    try {
      const db = getDb();
      await db.healthcheck();
      const { rows: lastRows } = await db.query(db.sql.health.lastHeartbeat);
      res.json({
        status: 'ok',
        db: 'ok',
        dialect: db.dialect,
        lastHeartbeat: lastRows[0]?.last ?? null
      });
    } catch (e) {
      res.status(503).json({ status: 'degraded', error: e.message });
    }
  });
  return r;
}
