import pino from 'pino';

export function createLogger({ component, level = 'info', stream } = {}) {
  const opts = {
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (stream) return pino(opts, stream);
  // Default: synchronous writes to stderr (fd 2). Sync destinations are
  // load-bearing under process.exit so fatal lines survive the buffer drain
  // when a service crashes fast (<1500ms). NSSM redirects stderr to a file.
  return pino(opts, pino.destination({ dest: 2, sync: true }));
}
