import { Router } from 'express';
import { getDb } from '../db/index.js';
import { createMigrationsService } from '../services/migrations.js';
import { writeAudit } from '../services/audit.js';
// R158.X.99.report (2026-10-21) — 复用 auth/mcp-token.js 的 `_clientIp` 单一真源
//   (R158.X.99.28 遗留的 3 份同源代码之一, 本次收敛到 1 份). 本文件原本还有
//   一段独立实现, 注释解释"trust proxy 关闭时 req.ip 是真实 TCP 对端" ——
//   该解释已搬到 mcp-token.js 的 `_clientIp` 定义处 (含 ⚠ F4 反伪造警告),
//   不要在别处重新解读 req.ip 的可信度.
import { _clientIp as clientIp } from '../auth/mcp-token.js';

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
            // R158.X.116-fix (2026-10-23) — 去掉 seed.reason。upgrade() 在
            //   R158.51 baseline freeze 后不再返回 seed 字段。同一处 bug 的
            //   三个消费点: server.js 启动路径 / schema-migrations.js /
            //   这里的响应体 —— 后者最严重, 它让「应用更新并重启」端点直接 500。
            migrationsSkipped: result.migrations.skipped.length,
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
        migrationsSkipped: result.migrations.skipped
      });
    } catch (e) {
      req.log?.error?.({ err: e.message, stack: e.stack }, 'system_update failed');
      res.status(500).json({ error: 'internal', message: e.message });
    }
  });

  return r;
}
