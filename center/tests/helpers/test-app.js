import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';

export function buildTestApp({ pool }) {
  const config = {
    listenPort: 0, jwtSecret: 'test', agentToken: 'tok',
    staticDir: process.cwd(), env: 'test', logLevel: 'silent',
    mysql: { host: '', database: '' }
  };
  return createApp({ config, pool, logger: createLogger({ component: 'test', level: 'silent' }) });
}
