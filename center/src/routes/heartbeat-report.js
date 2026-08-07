import { Router } from 'express';
import { heartbeatReportService } from '../services/heartbeat-report.js';

// Admin read-only endpoints that surface per-agent heartbeat + latest-report
// snapshot data. Three views:
//   - GET /api/admin/heartbeat-report/agents
//   - GET /api/admin/heartbeat-report/dcs      (joined with ad_dcs + ad_sites)
//   - GET /api/admin/heartbeat-report/agents/:agentId/report-detail
// Auth: per-route [userAuth, requirePerm('admin:users')] — matches the
// dcsRouter / lockoutRouter / schemaMigrationsRouter contract. Mounted on the
// web app only (not on heartbeat/report apps).

export function heartbeatReportRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/admin/heartbeat-report/agents', ...auth, async (_req, res) => {
    try {
      const out = await heartbeatReportService.listAgents();
      res.json(out);
    } catch (e) {
      _req.log?.error?.({ err: e.message }, 'heartbeat-report agents list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/heartbeat-report/dcs', ...auth, async (_req, res) => {
    try {
      const out = await heartbeatReportService.listDcs();
      res.json(out);
    } catch (e) {
      _req.log?.error?.({ err: e.message }, 'heartbeat-report dcs list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/heartbeat-report/agents/:agentId/report-detail', ...auth, async (req, res) => {
    try {
      const out = await heartbeatReportService.getLatestReportDetail(req.params.agentId);
      res.json(out);
    } catch (e) {
      _req.log?.error?.({ err: e.message }, 'heartbeat-report detail failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}