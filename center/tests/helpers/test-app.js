import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';

export function buildTestApp({ db } = {}) {
  const config = {
    listenPort: 0, jwtSecret: 'test', agentToken: 'tok',
    staticDir: process.cwd(), env: 'test', logLevel: 'silent'
  };
  return createApp({ config, db, logger: createLogger({ component: 'test', level: 'silent' }) });
}