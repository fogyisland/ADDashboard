import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { agentRouter } from '../../src/routes/agent.js';
import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';

// I3 (Task 5): agentRouter now calls agentToken({ db: getDb() }) at mount
// time, which throws `db not initialized` unless a mock db is wired first.
// Tests below only assert route mounting (404 vs not-404), so any token
// value is fine — we just need getDb() to return a facade.
const TEST_TOKEN = 'test-token';
const BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;
before(() => {
  _setDbForTest(buildMockDb([
    { match: BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: TEST_TOKEN }] }
  ]).standard());
});

// Mirror call() from tests/init/router.test.js: ephemeral port + raw node:http.
async function req(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://localhost:${port}${path}`;
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers }
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const r = http.request(url, opts, (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          server.close();
          let body = null;
          if (buf) {
            const ct = String(res.headers['content-type'] || '');
            if (ct.includes('application/json')) {
              try { body = JSON.parse(buf); } catch { body = buf; }
            } else {
              body = buf;
            }
          }
          resolve({ status: res.statusCode, body });
        });
      });
      r.on('error', reject);
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

function makeApp(mount) {
  const app = express();
  app.use(express.json());
  const config = { agentToken: 'test-token' };
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  app.use(agentRouter({ config, logger, mount }));
  return app;
}

test('mount=heartbeat: POST /heartbeat registered, POST /report 404', async () => {
  const app = makeApp('heartbeat');
  const r1 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.notStrictEqual(r1.status, 404, 'heartbeat should be mounted');
  const r2 = await req(app, 'POST', '/api/agent/report', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.strictEqual(r2.status, 404, 'report should NOT be mounted');
});

test('mount=report: POST /report registered, POST /heartbeat 404', async () => {
  const app = makeApp('report');
  const r1 = await req(app, 'POST', '/api/agent/report', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.notStrictEqual(r1.status, 404, 'report should be mounted');
  const r2 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.strictEqual(r2.status, 404, 'heartbeat should NOT be mounted');
});

test('mount=full: all routes registered', async () => {
  const app = makeApp('full');
  const r1 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.notStrictEqual(r1.status, 404, 'heartbeat should be mounted');
  const r2 = await req(app, 'POST', '/api/agent/report', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.notStrictEqual(r2.status, 404, 'report should be mounted');
  const r3 = await req(app, 'GET', '/api/agent/ports');
  assert.notStrictEqual(r3.status, 404, 'ports should be mounted');
  const r4 = await req(app, 'GET', '/api/agent/config');
  assert.notStrictEqual(r4.status, 404, 'config should be mounted');
  const r5 = await req(app, 'POST', '/api/agent/discover', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', dc: { name: 'd' } });
  assert.notStrictEqual(r5.status, 404, 'discover should be mounted');
  const r6 = await req(app, 'GET', '/config.json', undefined, { 'X-Agent-Token': 'test-token' });
  assert.notStrictEqual(r6.status, 404, 'config.json (web mount bootstrap) should be mounted');
});

// The web mount is a stripped-down bootstrap surface — only /config.json,
// no heartbeat / report / ports / discover / legacy /api/agent/config.
// Tested by mounting with `mount: 'web'` and verifying the others 404.
test('mount=web: only /config.json registered, heartbeat/report/legacy 404', async () => {
  const app = makeApp('web');
  // The bootstrap endpoint itself must be reachable.
  const r0 = await req(app, 'GET', '/config.json', undefined, { 'X-Agent-Token': 'test-token' });
  assert.notStrictEqual(r0.status, 404, '/config.json should be mounted on web mount');
  // No other agent routes should be exposed.
  const r1 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.strictEqual(r1.status, 404, 'heartbeat should NOT be mounted on web mount');
  const r2 = await req(app, 'POST', '/api/agent/report', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.strictEqual(r2.status, 404, 'report should NOT be mounted on web mount');
  const r3 = await req(app, 'GET', '/api/agent/ports');
  assert.strictEqual(r3.status, 404, 'ports should NOT be mounted on web mount');
  const r4 = await req(app, 'GET', '/api/agent/config');
  assert.strictEqual(r4.status, 404, 'legacy /api/agent/config should NOT be mounted on web mount');
  const r5 = await req(app, 'POST', '/api/agent/discover', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', dc: { name: 'd' } });
  assert.strictEqual(r5.status, 404, 'discover should NOT be mounted on web mount');
});

// SPA-fallback regression: the web app installs a catch-all that sends
// index.html for any path not under /api/ or /healthz. /config.json lives
// outside those prefixes — the fallback regex must exclude it explicitly,
// otherwise the bootstrap endpoint is shadowed by the SPA shell.
test('web mount /config.json survives the SPA-fallback (would otherwise be shadowed)', async () => {
  const { createApp } = await import('../../src/app.js');
  const { agentRouter } = await import('../../src/routes/agent.js');
  const app = createApp({
    config: { agentToken: 'tok', staticDir: 'D:\\does-not-exist' },
    logger: { info(){}, error(){}, warn(){}, debug(){} }
  });
  app.use(agentRouter({ config: { agentToken: 'tok' }, logger: { info(){}, error(){}, warn(){}, debug(){} }, mount: 'web' }));
  // /api/admin/users is under the SPA-fallback exclusion (it starts with /api/)
  // so we don't need to worry about that path here.
  const r = await req(app, 'GET', '/config.json', undefined, { 'X-Agent-Token': 'tok' });
  // Must NOT be the SPA shell — that means the agentRouter mount was reached.
  // We don't care about the exact status here (could be 401/500/etc since no DB);
  // we just need the body to NOT be HTML.
  if (r.status === 200 && typeof r.body === 'string' && r.body.startsWith('<!DOCTYPE')) {
    assert.fail('/config.json is being shadowed by the SPA fallback — the fallback regex must exclude /config.json');
  }
});