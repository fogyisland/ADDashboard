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