import pino from 'pino';

export function createLogger({ component, level = 'info', stream } = {}) {
  const opts = {
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (stream) return pino(opts, stream);
  // Default: synchronous writes to stderr (fd 2). The sync destination is
  // load-bearing for services: every server.js exit path runs through
  // process.exit(), and pino's async buffer can lose fatal lines when the
  // process exits within the same tick (typical for "service crashed in
  // <1500ms" cases). NSSM redirects stderr to a file, so sync stderr is
  // the only reliably-flushed channel for crash diagnostics.
  return pino(opts, pino.destination({ dest: 2, sync: true }));
}
