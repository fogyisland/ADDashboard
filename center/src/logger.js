import pino from 'pino';

export function createLogger({ component, level = 'info', stream } = {}) {
  const opts = {
    level,
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return stream ? pino(opts, stream) : pino(opts);
}
