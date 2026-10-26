// center/src/routes/reports.js
// R158.61 (2026-10-10) — Daily / weekly email report admin endpoints.
//
//   GET  /api/admin/reports/history?kind=&limit=    List recent runs (default 20)
//   GET  /api/admin/reports/preview?kind=          Render HTML, do NOT enqueue
//   POST /api/admin/reports/run                    Enqueue immediately (body: {kind})
//
// All three are guarded by [userAuth, requirePerm('admin:config')] (injected
// by the factory from server.js — same auth posture as /api/admin/email/test).
// There's no dangerous side-effect on GET endpoints; the POST run endpoint
// triggers an enqueue (adds a row to alert_email_outbox + daily_reports) but
// does not actually send email — the existing createEmailDeliveryLoop owns
// SMTP.
//
// Errors use the project's normal-error shape (HTTP code + JSON body),
// except the run endpoint surfaces a 4xx with the underlying message so
// the operator can debug config issues from the EmailConfigView toast.

import express from 'express';
import { enqueueReport, listRecentReports, previewReport } from '../services/reports.js';

export function createReportsRouter({ db, requireAuth, requirePerm }) {
  const router = express.Router();
  // Per-route guard: admin:config perm (matches EmailConfigView's
  // /api/admin/email/test contract). requireAuth is userAuth({db,logger}),
  // requirePerm is the rbac helper.
  const guard = [requireAuth, requirePerm('admin:config')];

  // GET /api/admin/reports/history?kind=daily&limit=20
  router.get('/api/admin/reports/history', guard, async (req, res) => {
    const kind = (req.query.kind === 'daily' || req.query.kind === 'weekly') ? req.query.kind : null;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
    try {
      const rows = await listRecentReports({ kind, limit });
      res.json({ rows, count: rows.length, kind, limit });
    } catch (err) {
      res.status(500).json({ error: 'history failed', detail: err.message });
    }
  });

  // GET /api/admin/reports/preview?kind=daily
  // Returns the rendered HTML inline. The EmailConfigView opens this in
  // a new tab so the operator can visually verify before saving cron /
  // recipient config and waiting for the next scheduled run.
  router.get('/api/admin/reports/preview', guard, async (req, res) => {
    const kind = (req.query.kind === 'daily' || req.query.kind === 'weekly') ? req.query.kind : null;
    if (!kind) {
      res.status(400).json({ error: 'kind must be "daily" or "weekly"' });
      return;
    }
    try {
      const r = await previewReport(kind);
      // Set Content-Type explicitly so the browser renders as HTML. The
      // template uses inline CSS so it renders identically in the
      // browser tab and inside an email client.
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(r.html);
    } catch (err) {
      res.status(500).json({ error: 'preview failed', detail: err.message });
    }
  });

  // POST /api/admin/reports/run  body: { kind: 'daily' | 'weekly' }
  // Enqueues immediately. Does NOT send email — the existing email
  // delivery loop will pick up the outbox row on its next tick.
  // app.js already mounts express.json() globally; do NOT install a
  // second body parser here or the request stream will be consumed
  // twice (the second parse sees a 0-byte body → SyntaxError → 500
  // via the app-level error handler).
  router.post('/api/admin/reports/run', guard, async (req, res) => {
    const kind = (req.body && (req.body.kind === 'daily' || req.body.kind === 'weekly')) ? req.body.kind : null;
    if (!kind) {
      res.status(400).json({ error: 'kind must be "daily" or "weekly"' });
      return;
    }
    try {
      const r = await enqueueReport(kind);
      if (!r.ok) {
        // 4xx for config issues (no recipients), 500 for actual server errors.
        // enqueueReport currently only returns {ok:false, error} for the
        // "no recipients" case — surface that as 400 so the UI can show
        // the operator a helpful toast ("set report_daily_to in system_config").
        res.status(400).json({ error: r.error, kind });
        return;
      }
      res.status(201).json({
        ok: true,
        kind,
        runId: r.runId,
        outboxId: r.outboxId,
        to: r.to,
        cc: r.cc,
        subject: r.subject,
        htmlSize: r.htmlSize,
        summary: r.summary,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd
      });
    } catch (err) {
      res.status(500).json({ error: 'run failed', detail: err.message });
    }
  });

  return router;
}
