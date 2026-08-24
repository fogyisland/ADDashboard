import { Router } from 'express';
import { getDb } from '../db/index.js';
import { createMigrationsService } from '../services/migrations.js';
import { writeAudit } from '../services/audit.js';

// System update endpoint — applies any pending DB migrations and then schedules
// a process.exit(0) so NSSM picks the new code on the next launch. Intended
// for the operator update workflow: copy new code into the install dir, then
// POST to /api/system/update from the same host. No auth — the only protection
// is the localhost-only check below; remote access requires RDP/SSH which
// already gates host access. Mounted on the web app (post-init only) so
// agents on the heartbeat/report apps are never affected.
//
// Why exit-0 instead of NSSM restart command: NSSM watches the supervised
// process and auto-restarts on any non-configured exit. Using process.exit
// keeps the restart path identical to a crash recovery and avoids needing to
// invoke nssm.exe from inside the service (which would be a chicken-and-egg
// race against the very code that's about to be replaced).

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// 500 ms gives the response enough time to flush through the kernel TCP
// buffer on localhost even on a slow curl invocation. Tests override via
// getExitDelayMs to keep assertions fast and to avoid timer-leak races
// across sequential test cases.
const DEFAULT_EXIT_DELAY_MS = 500;

function clientIp(req) {
  // Express's req.ip returns the TCP peer when trust proxy is off (default).
  // Fall back to req.socket.remoteAddress for paranoia — covers the case where
  // some upstream middleware overrode req.ip without setting trust proxy.
  return req.ip || req.socket?.remoteAddress || '';
}

function isLocalhost(req) {
  return LOCALHOST_IPS.has(clientIp(req));
}

export function systemRouter({ logger, getRepoRoot, getExitDelayMs }) {
  const r = Router();

  // Localhost-only guard mounted at router level so every verb is covered.
  // Returning 403 (not 404) makes the gate visible to operators probing from
  // a remote machine — they know the endpoint exists, just not for them.
  r.use('/api/system', (req, res, next) => {
    if (!isLocalhost(req)) {
      req.log?.warn?.({ ip: clientIp(req) }, 'system endpoint rejected (non-localhost)');
      return res.status(403).json({ error: 'localhost-only' });
    }
    next();
  });

  r.post('/api/system/update', async (req, res) => {
    let appliedBy = 'systemupdate';
    try {
      const db = getDb();
      const service = createMigrationsService({ db, logger, getRepoRoot });
      const result = await service.upgrade({ appliedBy });
      // Audit regardless of success/failure — operator actions on the system
      // are exactly what the audit log is for. Even a partial failure should
      // show up so the operator can decide whether to retry.
      try {
        await writeAudit({
          userId: null,
          action: 'system_update',
          target: 'system',
          payload: {
            ok: result.ok,
            migrationsApplied: result.migrations.applied.length,
            migrationsFailed: result.migrations.failed.length,
            seed: result.seed.reason,
            clientIp: clientIp(req)
          }
        }, logger);
      } catch (auditErr) {
        // Audit failure must not block the update — log and proceed.
        req.log?.error?.({ err: auditErr.message }, 'system_update audit write failed');
      }

      // Schedule exit AFTER the response is written. 500ms is enough for the
      // response to flush through the kernel TCP buffer on localhost even on
      // a slow operator curl invocation; .unref() so the timer doesn't keep
      // the process alive if something else goes wrong first. Tests pass a
      // shorter delay via getExitDelayMs so assertions don't race against a
      // 500ms timer that may bleed into the next test case.
      const delayMs = typeof getExitDelayMs === 'function' ? getExitDelayMs() : DEFAULT_EXIT_DELAY_MS;
      const timer = setTimeout(() => {
        logger.info({ appliedBy, ok: result.ok }, 'system_update exit scheduled — process exiting');
        process.exit(0);
      }, delayMs);
      timer.unref();

      res.json({
        ok: result.ok,
        message: result.message,
        restarted: true,
        migrationsApplied: result.migrations.applied,
        migrationsFailed: result.migrations.failed,
        seed: result.seed
      });
    } catch (e) {
      req.log?.error?.({ err: e.message, stack: e.stack }, 'system_update failed');
      res.status(500).json({ error: 'internal', message: e.message });
    }
  });

  return r;
}
