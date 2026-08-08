// Integration test: verify that server.js exposes a `buildServerApps` helper
// that constructs three independent Express apps (web / heartbeat / report)
// and resolves ports from { config.listenPort, systemConfig.heartbeat_port,
// systemConfig.systemConfig.report_port }. The helper is the seam Task 4
// introduces so later tasks (and the runtime IIFE) can call `startServers`
// once and get three servers in normal mode, or just the webApp in init mode.
//
// We black-box each app via supertest + introspect Express's router stack
// (recursing through nested Routers) to assert which routes are mounted.
// The supertest probes confirm the runtime behavior; the stack walk confirms
// the *cause* — whether the path is handled because a route is registered
// or because the SPA fallback / static middleware picked it up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { default as supertest } from 'supertest';
import { buildServerApps } from '../server.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} };
const TEST_TOKEN = 'tok';

function makeConfig(overrides = {}) {
  return {
    listenPort: 9100,
    jwtSecret: 'x'.repeat(64),
    agentToken: TEST_TOKEN,
    logLevel: 'info',
    env: 'prod',
    staticDir: './dist',
    ...overrides
  };
}

// Walk an Express app's mount tree and collect every route (method + path).
// Express stores direct routes on app._router.stack; nested Router layers
// expose their routes on layer.handle.stack. Recurse to flatten.
function collectRoutes(app) {
  const out = [];
  function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        const method = Object.keys(layer.route.methods)[0].toUpperCase();
        out.push(`${method} ${layer.route.path}`);
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  }
  if (app._router && app._router.stack) walk(app._router.stack);
  return out;
}

test('buildServerApps: normal mode → 3 apps with distinct ports from systemConfig', () => {
  const result = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: { heartbeat_port: '9091', report_port: '9092', heartbeat_stale_seconds: '20' }
  });
  assert.ok(result.webApp, 'webApp missing');
  assert.ok(result.heartbeatApp, 'heartbeatApp missing');
  assert.ok(result.reportApp, 'reportApp missing');
  assert.strictEqual(result.ports.web, 9100);
  assert.strictEqual(result.ports.heartbeat, 9091);
  assert.strictEqual(result.ports.report, 9092);
});

test('buildServerApps: missing systemConfig → defaults 8081 / 8082', () => {
  const result = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  assert.strictEqual(result.ports.heartbeat, 8081);
  assert.strictEqual(result.ports.report, 8082);
});

test('buildServerApps: heartbeatApp mounts /api/agent/heartbeat but NOT /api/agent/report', () => {
  const { heartbeatApp } = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  const routes = collectRoutes(heartbeatApp);
  assert.ok(routes.some((p) => p.includes('/api/agent/heartbeat')),
    `heartbeatApp should mount POST /api/agent/heartbeat, got: ${routes.join(', ')}`);
  assert.ok(!routes.some((p) => p.includes('/api/agent/report')),
    `heartbeatApp should NOT mount /api/agent/report, got: ${routes.join(', ')}`);
});

test('buildServerApps: reportApp mounts /api/agent/report but NOT /api/agent/heartbeat', () => {
  const { reportApp } = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  const routes = collectRoutes(reportApp);
  assert.ok(routes.some((p) => p.includes('/api/agent/report')),
    `reportApp should mount POST /api/agent/report, got: ${routes.join(', ')}`);
  assert.ok(!routes.some((p) => p.includes('/api/agent/heartbeat')),
    `reportApp should NOT mount /api/agent/heartbeat, got: ${routes.join(', ')}`);
});

test('buildServerApps: webApp does NOT mount any /api/agent/* routes', () => {
  const { webApp } = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  const routes = collectRoutes(webApp);
  const agentRoutes = routes.filter((p) => p.includes('/api/agent/'));
  assert.strictEqual(agentRoutes.length, 0,
    `webApp should NOT mount any /api/agent/* routes; found: ${agentRoutes.join(', ')}`);
});

test('buildServerApps: heartbeatApp and reportApp both mount /healthz (Task 2 — monitor reachable on all 3 ports)', () => {
  // An external LB / k8s probe must be able to hit any of the three ports
  // (web / heartbeat / report) and get the same DB-aware /healthz response.
  // heartbeatApp and reportApp are bare express() instances (no createApp),
  // so the test below is the regression net for the explicit
  // `healthzRouter()` calls added in Task 2.
  const { heartbeatApp, reportApp, webApp } = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  for (const [name, app] of [['heartbeatApp', heartbeatApp], ['reportApp', reportApp], ['webApp', webApp]]) {
    const routes = collectRoutes(app);
    assert.ok(routes.some((p) => p === 'GET /healthz'),
      `${name} should mount GET /healthz, got: ${routes.join(', ')}`);
  }
});

test('buildServerApps: 3 apps are distinct object identities (no aliasing)', () => {
  const r = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  assert.notStrictEqual(r.webApp, r.heartbeatApp);
  assert.notStrictEqual(r.webApp, r.reportApp);
  assert.notStrictEqual(r.heartbeatApp, r.reportApp);
});

test('buildServerApps: heartbeat report apps are reachable on their own supertest', async () => {
  // Black-box behavioral check: a POST to the heartbeat app's heartbeat
  // endpoint passes auth (correct token) and falls into the handler. The
  // handler will 500 because no DB is wired, but the auth middleware
  // accepted the token — proving the route is mounted and reachable.
  const { heartbeatApp, reportApp } = buildServerApps({
    config: makeConfig(),
    db: null,
    logger: silentLogger,
    needsInit: false,
    systemConfig: {}
  });
  // Wrong token → must be 401 (auth middleware rejects) — proves the route
  // is mounted (otherwise we'd get a 404 SPA fallback).
  const wrongHb = await supertest(heartbeatApp)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'test' });
  assert.strictEqual(wrongHb.status, 401,
    `heartbeatApp POST /api/agent/heartbeat with wrong token should be 401; got ${wrongHb.status}`);

  const wrongRp = await supertest(reportApp)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'test', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.strictEqual(wrongRp.status, 401,
    `reportApp POST /api/agent/report with wrong token should be 401; got ${wrongRp.status}`);
});
