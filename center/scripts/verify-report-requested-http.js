// Live HTTP verify — boot a tiny Express app, mount heartbeatReportRouter
// with a real JWT, and confirm the JSON response carries reportRequestedAt.
import express from 'express';
import { heartbeatReportRouter } from '../src/routes/heartbeat-report.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { init, getDb } from '../src/db/index.js';
import { signJwt } from '../src/auth/jwt.js';
import fs from 'node:fs/promises';

const cfg = JSON.parse(await fs.readFile('appsettings.json', 'utf8'));
await init(cfg);

// Pull jwt secret from system_config so userAuth can verify our token.
const { rows: [{ config_value: JWT_SECRET }] } = await getDb().query(
  "SELECT config_value FROM system_config WHERE config_key = 'jwt_secret_current'"
);

const token = signJwt({ sub: 1, role: 'admin', permissions: ['*'] }, JWT_SECRET, 300);

const app = express();
app.use(express.json());
const logger = {
  error: (...a) => console.error('[logger.error]', ...a),
  warn: (...a) => console.warn('[logger.warn]', ...a),
  info: (...a) => console.log('[logger.info]', ...a)
};
app.use(heartbeatReportRouter({
  requireAuth: userAuth({ db: getDb(), logger }),
  requirePerm
}));

const srv = app.listen(0, async () => {
  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/heartbeat-report/agents`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await res.json();
  console.log('HTTP', res.status);
  if (res.status !== 200) {
    console.log('body:', JSON.stringify(body));
    srv.close();
    process.exit(1);
  }
  console.log(JSON.stringify(body.agents.map(a => ({
    agentId: a.agentId,
    reportRequestedAt: a.reportRequestedAt,
    hasReportRequestedAtField: 'reportRequestedAt' in a
  })), null, 2));
  srv.close();
  process.exit(0);
});