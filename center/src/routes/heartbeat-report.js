import { Router } from 'express';
import { heartbeatReportService } from '../services/heartbeat-report.js';
import { writeAudit } from '../services/audit.js';

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

  // Center self-probe state (Task 5). Surfaced by the admin monitor UI's
  // probe panel (Task 7) so operators can see whether the center app is
  // actually probing its own three ports at 1 Hz. Registered BEFORE
  // /agents/:agentId/report-detail so the static path wins over the param.
  r.get('/api/admin/heartbeat-report/probe', ...auth, async (_req, res) => {
    try {
      const out = await heartbeatReportService.listProbeStatus();
      res.json(out);
    } catch (e) {
      _req.log?.error?.({ err: e.message }, 'heartbeat-report probe failed');
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

  // 2026-08-24 round-12 T5 — admin-initiated "report now" for a single agent.
  // Sets the report_requested_at flag so the next heartbeat ack tells the
  // agent to ship a report immediately. Audit-logged via the
  // `request_agent_report` action (see audit-classifier.js — T4). The
  // idempotent UPSERT inside requestReport means rapid clicks refresh the
  // timestamp without surfacing an error.
  r.post('/api/admin/agents/:agentId/request-report', ...auth, async (req, res) => {
    try {
      const { agentId } = req.params;
      const out = await heartbeatReportService.requestReport(agentId);
      await writeAudit({
        action: 'request_agent_report',
        target: `agent:${agentId}`,
        payload: {
          requestedAt: out.requestedAt.toISOString(),
          alreadyPending: out.alreadyPending
        },
        userId: req.user?.sub ?? null
      }, req.log);
      res.json({
        ok: true,
        agentId,
        requestedAt: out.requestedAt.toISOString(),
        alreadyPending: out.alreadyPending
      });
    } catch (e) {
      if (e.code === 'AGENT_NOT_FOUND') {
        return res.status(404).json({ error: 'agent_not_found' });
      }
      req.log?.error?.({ err: e.message }, 'request-report failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 2026-08-26 round-19+: heartbeat-table 删除 button. Cascades through
  // ad_agent_heartbeat + ad_replication_status (both directions) +
  // package_runs so the dashboard view doesn't keep orphans pointing
  // at a decommissioned agent. Audit-logged as `delete_agent_heartbeat`
  // (changes/medium/删除 Agent 心跳记录).
  r.delete('/api/admin/heartbeat-report/agents/:agentId', ...auth, async (req, res) => {
    const { agentId } = req.params;
    try {
      const out = await heartbeatReportService.deleteAgent(agentId);
      await writeAudit({
        action: 'delete_agent_heartbeat',
        target: `agent:${agentId}`,
        payload: { deleted: out.deleted },
        userId: req.user?.sub ?? null
      }, req.log);
      res.json({ ok: true, agentId, deleted: out.deleted });
    } catch (e) {
      if (e.code === 'AGENT_NOT_FOUND') {
        return res.status(404).json({ error: 'agent_not_found' });
      }
      req.log?.error?.({ err: e.message, agentId }, 'delete-agent failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 2026-08-26 round-19+: DC-tab 删除 button. Removes only the ad_dcs row;
  // the agent's heartbeat row stays put so the operator can still see
  // its presence on the Agent tab. Audit-logged as `delete_dc`
  // (changes/medium/删除 DC 记录).
  r.delete('/api/admin/heartbeat-report/dcs/:dcName', ...auth, async (req, res) => {
    const { dcName } = req.params;
    try {
      const out = await heartbeatReportService.deleteDc(dcName);
      await writeAudit({
        action: 'delete_dc',
        target: `dc:${dcName}`,
        payload: { deleted: out.deleted },
        userId: req.user?.sub ?? null
      }, req.log);
      res.json({ ok: true, dcName, deleted: out.deleted });
    } catch (e) {
      if (e.code === 'DC_NOT_FOUND') {
        return res.status(404).json({ error: 'dc_not_found' });
      }
      req.log?.error?.({ err: e.message, dcName }, 'delete-dc failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}