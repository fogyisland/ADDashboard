// Logger factory. Two entry points:
//
//   createLogger(opts)         — sync, writes to stderr (or a caller-supplied stream)
//   createRotatedLogger(opts)  — async, writes to a daily-rotated file via pino-roll
//
// The sync createLogger is the default for tests + non-bootstrap fatal traps
// (logger.test.js, fatal-handler.test.js, test-app.js). The async
// createRotatedLogger is what server.js uses for production — it points
// pino at a single file under <installPath>/logs/ that rolls daily via
// pino-roll's SonicBoom backend.
//
// Why async for production: pino-roll is itself an async factory that has
// to detect existing rotation numbers + initial file size. There's no
// sync equivalent that preserves the SonicBoom sync-write guarantee
// (sonic-boom sync:true is what keeps fatal lines from being lost on
// process.exit). Async at startup, sync at runtime — same model as the
// existing logger.js, just with the destination moved from stderr to
// a rotating file.
//
// Why NSSM AppStderr must be empty when using createRotatedLogger:
// pino-roll renames the file on rotation. If NSSM is also writing to the
// same path, it will keep writing to the renamed (now-unlinked) file
// handle, which creates a phantom file NSSM owns but pino doesn't. So
// the install script must set NSSM's AppStderr to empty/null — pino-roll
// is the sole writer. The crash-diagnostic line that justified the sync
// destination (uncaughtException → process.exit) still works because
// SonicBoom's sync:true flushes before the process actually exits.
//
// R119 additions (per-module/per-route server-side log directory):
//
//   withModuleLogger(modLog, { component })
//     Express middleware factory that rebinds `req.log` so downstream
//     handlers / pino-http see the per-route pino instance. component
//     is attached as `req.log.fields().component` (already set on the
//     underlying pino instance) and used by pino-http's serializers.
//
//   createMultiRotatedLogger({ modules, baseDir, level, ... })
//     Async factory that creates N pino instances, each pointing at
//     `<baseDir>/APP/<module.name>.log` via pino-roll daily rotation.
//     Returns an object keyed by `module.name` so server.js can pass the
//     whole set down to buildServerApps / mount points.
//
// Why a separate `APP/` subdirectory (R119 spec §2 + §4):
//   The legacy top-level `logs/center.log` is the global error sink —
//   if one route starts flooding (heartbeat loop / broken agent), the
//   global log fills and obscures unrelated issues. APP/ isolates each
//   route so the operator can `tail -f logs/APP/agent.log` to diagnose
//   a single endpoint without grep'ing past 60s of heartbeats.

import { mkdir as fsMkdir, stat as fsStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import pino from 'pino';
import pinoRoll from 'pino-roll';

export function createLogger({ component, level = 'info', stream } = {}) {
  const opts = {
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (stream) return pino(opts, stream);
  // Default: synchronous writes to stderr (fd 2). Sync destinations are
  // load-bearing under process.exit so fatal lines survive the buffer drain
  // when a service crashes fast (<1500ms). Used by tests + the bootstrap
  // fatal-trap registration before the rotated logger is ready.
  return pino(opts, pino.destination({ dest: 2, sync: true }));
}

export async function createRotatedLogger({
  component,
  level = 'info',
  file,
  frequency = 'daily',
  dateFormat = 'yyyy-MM-dd',
  limit = { count: 7 },
  mkdir = true,
  sync = true
} = {}) {
  if (!file) throw new Error('createRotatedLogger: file is required');
  const opts = {
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  // pino-roll is an async factory: it inspects the target directory for
  // existing rotation numbers, then returns a SonicBoom bound to the
  // current rotation file. SonicBoom's sync:true keeps individual writes
  // synchronous even though construction is async.
  const dest = await pinoRoll({ file, frequency, dateFormat, limit, mkdir, sync });
  return pino(opts, dest);
}

// R119: per-route module logger middleware. Rebinds `req.log` so pino-http
// and downstream handlers emit to the module-specific file. The middleware
// is mounted at the route boundary (e.g. `app.use('/api/init',
// withModuleLogger(modLog.init, { component: 'init' }), initRouter(...))`),
// so every request handled by that subtree — including 404s thrown by the
// router — writes to modLog.
//
// Why rebind req.log vs creating a child logger: pino-http (and a dozen
// downstream libraries that read req.log) treats req.log as a complete
// pino instance with `.info()` / `.error()` etc. A `.child()` is also a
// pino instance but mutating req.log to point at the module logger keeps
// the call-site contract uniform across the three Express apps.
//
// What we deliberately do NOT do:
//   - Replace req.id / req.headers. pino-http upstream of this middleware
//     owns the per-request requestId binding.
//   - Touch res.log. pino-http doesn't write through res.log; it writes
//     through req.log at response-finish time.
//   - Force a specific level. The module logger inherits whatever level
//     was set at createMultiRotatedLogger time so operator config knobs
//     (env var / future runtime toggle) stay authoritative.
export function withModuleLogger(modLog, { component } = {}) {
  if (!modLog || typeof modLog.info !== 'function') {
    throw new Error('withModuleLogger: modLog must be a pino instance');
  }
  // Surface the component on the underlying logger if it wasn't already.
  // createMultiRotatedLogger sets base.component, but if a caller passes
  // an external pino (tests, ad-hoc), we coerce it here so log lines are
  // always self-describing. pino exposes `bindings()` for reading current
  // bindings; child() always returns a NEW instance, so we only swap
  // when the caller-supplied pino actually needs the component attached.
  let bound = modLog;
  if (component) {
    const current = (typeof modLog.bindings === 'function') ? modLog.bindings() : {};
    if (current.component !== component) {
      bound = modLog.child({ component });
    }
  }
  return function moduleLoggerMiddleware(req, _res, next) {
    req.log = bound;
    next();
  };
}

// R119: factory that creates N module loggers, each writing to
// `<baseDir>/APP/<module.name>.log` via pino-roll daily rotation. The
// `APP/` subdirectory is created eagerly (mkdir -p) so the first request
// can write without an EACCES race against the directory creation.
//
// Returns: `{ [module.name]: pinoInstance }` — caller passes the whole
// map down to buildServerApps so each mount point can pick the right one.
//
// Why async: same reasoning as createRotatedLogger — pino-roll is an
// async factory. We construct them in parallel via Promise.all to keep
// startup latency bounded by the slowest pino-roll init (not N×init).
export async function createMultiRotatedLogger({
  modules,
  baseDir,
  level = 'info',
  frequency = 'daily',
  dateFormat = 'yyyy-MM-dd',
  limit = { count: 7 },
  sync = true,
  subDir = 'APP'
} = {}) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('createMultiRotatedLogger: modules must be a non-empty array');
  }
  if (!baseDir) {
    throw new Error('createMultiRotatedLogger: baseDir is required');
  }
  // R149 — allow callers to override the layout subdir so we can host the
  // 6 R149 business-feature modules (os_baseline / lockout / eventlog /
  // partner_port / replication / heartbeat) under <baseDir>/FEATURE/ while
  // the R119 transport-layer modules (agent / heartbeat / init / web) keep
  // their existing <baseDir>/APP/ layout. Default stays 'APP' to preserve
  // R119 behaviour. Path is restricted to simple identifiers — refuses
  // anything containing a slash/dot so a malicious module.name can't
  // escape the baseDir tree.
  if (!/^[A-Za-z0-9_-]+$/.test(subDir)) {
    throw new Error(`createMultiRotatedLogger: subDir must match [A-Za-z0-9_-]+, got ${JSON.stringify(subDir)}`);
  }
  const appDir = join(baseDir, subDir);
  if (!existsSync(appDir)) {
    await fsMkdir(appDir, { recursive: true });
  }
  const results = await Promise.all(modules.map(async ({ name, component }) => {
    if (!name) throw new Error('createMultiRotatedLogger: every module needs a name');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`createMultiRotatedLogger: module.name must match [A-Za-z0-9_-]+, got ${JSON.stringify(name)}`);
    }
    const file = join(appDir, `${name}.log`);
    // Eagerly touch the parent of the file (in case mkdir was racy and
    // APP existed but the file path's dirname differs). Defensive — for
    // baseDir/APP/<name>.log the dirname is just appDir, but future-proofs
    // nested layouts.
    await fsMkdir(dirname(file), { recursive: true });
    const dest = await pinoRoll({ file, frequency, dateFormat, limit, mkdir: true, sync });
    const logger = pino({ level, base: { component: component || name }, timestamp: pino.stdTimeFunctions.isoTime }, dest);
    return [name, logger];
  }));
  return Object.fromEntries(results);
}