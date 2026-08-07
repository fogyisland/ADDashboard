import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { agentRouter } from '../../src/routes/agent.js';

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
});