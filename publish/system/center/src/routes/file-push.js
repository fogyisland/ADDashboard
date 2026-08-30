// 2026-08-30 R65 followup — 文件推送 (file push) admin routes.
//
// Operator-facing endpoints. Auth: same chain as the rest of
// adminRouter ([userAuth, requirePerm('admin:users')]).
//
// Body shape for POST /api/admin/file-push:
//
//   {
//     filename:   string  — original file name (required)
//     contentB64: string  — base64-encoded file bytes (required)
//     sha256:     string  — operator-computed SHA-256; we re-verify
//                            and 400 if it disagrees (catches
//                            upload truncation / clipboard mistakes)
//     targetType: 'dc' | 'server'
//     targets:    string[]  — hostnames or DC names
//     targetPath: string    — absolute dir on each agent
//   }
//
// We use base64-in-JSON rather than multipart/form-data because the
// existing webApp body limit (express.json, 10 MB) is already wired
// and adding multer/busboy would be a new dep just for this one
// endpoint. The 10 MB ceiling matches the reportApp ceiling for
// replication snapshots, which are similarly text/JSON-heavy.
//
// All four lifecycle actions emit audit rows via writeAudit:
//   push_file_uploaded   — POST /file-push
//   push_file_claimed    — GET  /agent/file-push (logged by the
//                           agent router; admin can also see it
//                           implicitly via listTasks status)
//   push_file_delivered  — POST /file-push/:id/ack with ok=true
//   push_file_failed     — POST /file-push/:id/ack with ok=false

import { Router } from 'express';
import { Buffer } from 'node:buffer';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { writeAudit } from '../services/audit.js';
import {
  createTask, listTasks, getTask, getTaskFile, ackTask
} from '../services/file-push.js';

export function filePushRouter({ logger, db }) {
  const r = Router();
  const auth = [userAuth({ db, logger }), requirePerm('admin:users')];

  // ── Upload ─────────────────────────────────────────────────────────
  r.post('/api/admin/file-push', auth, async (req, res) => {
    const body = req.body || {};
    const { filename, contentB64, sha256, targetType, targets, targetPath } = body;
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename required' });
    }
    if (!contentB64 || typeof contentB64 !== 'string') {
      return res.status(400).json({ error: 'contentB64 required' });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: 'targets array required (non-empty)' });
    }
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'targetPath required' });
    }
    if (targetType !== 'dc' && targetType !== 'server') {
      return res.status(400).json({ error: 'targetType must be dc or server' });
    }
    let buffer;
    try {
      buffer = Buffer.from(contentB64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'contentB64 is not valid base64' });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'file is empty' });
    }
    // Defense-in-depth: cross-check the operator-supplied sha256 against
    // the freshly-decoded bytes. Mismatch ⇒ upload truncation or wrong
    // clipboard payload; refuse rather than silently accept.
    if (sha256 && typeof sha256 === 'string' && sha256.length === 64) {
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== sha256.toLowerCase()) {
        return res.status(400).json({ error: 'sha256 mismatch — file was truncated or corrupted in transit' });
      }
    }
    try {
      const out = await createTask({
        filename,
        buffer,
        targetType,
        targets,
        targetPath,
        uploadedBy: req.user?.sub ?? null
      });
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'push_file_uploaded',
        target: out.taskId,
        payload: {
          taskId: out.taskId,
          filename,
          sizeBytes: out.sizeBytes,
          sha256: out.sha256,
          targetType,
          targetCount: out.targetCount,
          targetPath
        },
        logger
      });
      res.status(201).json(out);
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'file-push upload failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── List ───────────────────────────────────────────────────────────
  r.get('/api/admin/file-push', auth, async (_req, res) => {
    try {
      const tasks = await listTasks();
      res.json(tasks);
    } catch (e) {
      logger.error({ err: e }, 'file-push list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Single task ────────────────────────────────────────────────────
  r.get('/api/admin/file-push/:id', auth, async (req, res) => {
    try {
      const t = await getTask(req.params.id);
      res.json(t);
    } catch (e) {
      if (e.httpStatus === 404) return res.status(404).json({ error: e.message });
      logger.error({ err: e }, 'file-push get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Admin file download (UI needs this to re-fetch the bytes) ────
  r.get('/api/admin/file-push/:id/file', auth, async (req, res) => {
    try {
      const t = await getTask(req.params.id);
      const buf = await getTaskFile(req.params.id);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
      res.setHeader('X-File-Sha256', t.sha256);
      res.send(buf);
    } catch (e) {
      if (e.httpStatus === 404) return res.status(404).json({ error: e.message });
      logger.error({ err: e }, 'file-push download failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Agent ack endpoint ────────────────────────────────────────────
  // Agents call this after they have written the file (or hit a write
  // error). Per-target status flips to delivered / failed; one audit
  // row is emitted per ack call so the trail reads cleanly when an
  // operator scans for "which files failed to push".
  r.post('/api/admin/file-push/:id/ack', auth, async (req, res) => {
    const body = req.body || {};
    const hostname = String(body.hostname || '').trim();
    const agentId = String(body.agentId || '').trim();
    const ok = body.ok === true || body.ok === 'true';
    const errorMessage = typeof body.errorMessage === 'string' ? body.errorMessage : null;
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    try {
      const t = await ackTask(req.params.id, hostname, agentId, ok, errorMessage);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: ok ? 'push_file_delivered' : 'push_file_failed',
        target: req.params.id,
        payload: {
          taskId: req.params.id,
          hostname,
          agentId,
          errorMessage,
          taskStatus: t.status
        },
        logger
      });
      res.json(t);
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
      logger.error({ err: e }, 'file-push ack failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}