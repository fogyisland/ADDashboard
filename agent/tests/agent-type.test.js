// Tests for the agentType switch in agent.js boot sequence.
//
// T16 contract:
//   - AD agents (default agentType='ad') MUST NOT call
//     /api/admin/member-servers/self-register on boot.
//   - non-AD agents (agentType='non-ad') MUST call self-register on boot
//     with { hostname, agentVersion, osVersion, ipAddress }.
//   - non-AD agents MUST filter packages by
//     pkg.agent?.type === 'non-ad' && (pkg.agent.platforms || []).includes('windows').
//
// These tests stub agent.js boot via dynamic-import + module-level overrides,
// since the boot sequence runs at import time. Pattern: monkey-patch the
// node:http module's request function to capture outgoing requests without
// actually starting a real listener.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldRunPackageForNonAd } from '../src/agent-filters.js';

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function writeAppsettings(dir, extra = {}) {
  const cfg = {
    centerUrl: 'http://127.0.0.1:65535',
    agentId: 'host-A',
    agentToken: 'tok',
    logLevel: 'info',
    pollingIntervalMinutes: 15,
    heartbeatIntervalSeconds: 5,
    discoveryIntervalHours: 4,
    queueDbPath: join(dir, 'queue.db'),
    agentDataDir: join(dir, 'data'),
    powerShellPath: 'powershell.exe',
    psScriptPath: join(dir, 'collect-replication.ps1'),
    psDiscoveryScriptPath: join(dir, 'collect-discovery.ps1'),
    healthCheckIntervalMs: 600_000,
    ...extra
  };
  const p = join(dir, 'appsettings.json');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

// Build a fake http server that records every request path/method/body and
// replies with empty 2xx. Returns { requests, close, port }.
function startCaptureServer() {
  // Use dynamic import so this works under ESM
  return import('node:http').then(({ default: http }) => new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          path: req.url.split('?')[0],
          headers: req.headers,
          body
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        requests,
        port: server.address().port,
        close: () => new Promise(r => server.close(r))
      });
    });
  }));
}

test('ad agent (default agentType) does NOT call /api/admin/member-servers/self-register on boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-type-ad-'));
  try {
    const cap = await startCaptureServer();
    const cfgPath = writeAppsettings(dir, { /* no agentType → defaults to 'ad' */ });
    // Set the centerUrl to our capture server
    const cfg = JSON.parse(JSON.stringify({ centerUrl: `http://127.0.0.1:${cap.port}` }));
    writeFileSync(cfgPath, JSON.stringify({
      ...cfg,
      centerUrl: `http://127.0.0.1:${cap.port}`,
      agentId: 'host-A',
      agentToken: 'tok',
      queueDbPath: join(dir, 'queue.db'),
      agentDataDir: join(dir, 'data'),
      psScriptPath: join(dir, 'collect-replication.ps1'),
      psDiscoveryScriptPath: join(dir, 'collect-discovery.ps1')
    }));

    // Now boot agent.js as a subprocess so we don't pollute the host process
    // with timers. The subprocess will exit on its own — but we only care
    // that no self-register call lands before it does. We kill it after a
    // short window.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['agent.js', cfgPath], {
      cwd: process.cwd(),
      env: { ...process.env }
    });
    // Let it boot for a short window
    await new Promise(r => setTimeout(r, 1500));
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));

    const selfRegisters = cap.requests.filter(r => r.path === '/api/admin/member-servers/self-register');
    assert.equal(selfRegisters.length, 0, 'AD agent must NOT call self-register on boot');
    await cap.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-ad agent calls /api/admin/member-servers/self-register on boot with the expected payload shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-type-nonad-'));
  try {
    const cap = await startCaptureServer();
    const cfgPath = writeAppsettings(dir, {
      agentType: 'non-ad',
      centerUrl: `http://127.0.0.1:${cap.port}`,
      agentId: 'host-M1',
      agentToken: 'tok'
    });

    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['agent.js', cfgPath], {
      cwd: process.cwd(),
      env: { ...process.env }
    });
    await new Promise(r => setTimeout(r, 1500));
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));

    const selfRegisters = cap.requests.filter(r => r.path === '/api/admin/member-servers/self-register');
    assert.ok(selfRegisters.length >= 1, `non-AD agent MUST call self-register; saw ${selfRegisters.length}`);
    const body = JSON.parse(selfRegisters[0].body);
    // Payload contract from the brief: hostname, agentVersion, osVersion, ipAddress.
    assert.equal(typeof body.hostname, 'string', 'hostname must be a string');
    assert.ok(body.hostname.length > 0, 'hostname must be non-empty');
    assert.equal(typeof body.agentVersion, 'string', 'agentVersion must be a string');
    assert.equal(typeof body.osVersion, 'string', 'osVersion must be a string');
    assert.equal(typeof body.ipAddress, 'string', 'ipAddress must be a string');
    await cap.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-ad agent filter: includes pkg with agent.type === non-ad && platforms includes windows; excludes everything else', async () => {
  // Import the SAME predicate the runtime uses (agent/src/agent-filters.js).
  // If agent.js diverges from this assertion, the import in agent.js will
  // also diverge — this test exercises the real exported function, not a
  // local re-statement.
  const filter = shouldRunPackageForNonAd;

  // PASS cases
  assert.equal(filter({ name: 'a', agent: { type: 'non-ad', platforms: ['windows'] } }), true);
  assert.equal(filter({ name: 'a', agent: { type: 'non-ad', platforms: ['linux', 'windows'] } }), true);
  // FAIL cases — wrong type
  assert.equal(filter({ name: 'a', agent: { type: 'ad', platforms: ['windows'] } }), false);
  assert.equal(filter({ name: 'a', agent: { type: 'dc-only', platforms: ['windows'] } }), false);
  // FAIL cases — wrong platform
  assert.equal(filter({ name: 'a', agent: { type: 'non-ad', platforms: ['linux'] } }), false);
  assert.equal(filter({ name: 'a', agent: { type: 'non-ad', platforms: [] } }), false);
  // FAIL cases — missing fields
  assert.equal(filter({ name: 'a' }), false);
  assert.equal(filter({ name: 'a', agent: {} }), false);
  assert.equal(filter({ name: 'a', agent: { type: 'non-ad' } }), false);
});

test('ad agent: legacy DC runtime path still POSTs heartbeats to /api/agent/heartbeat', async () => {
  // Positive liveness assertion for the AD runtime — verifies the agent
  // keeps using /api/agent/heartbeat (the endpoint the center routes to the
  // DC collector flow). Catches a regression where a T16 refactor might
  // accidentally drop or rename the AD heartbeat URL.
  const dir = mkdtempSync(join(tmpdir(), 'agent-type-ad-hb-'));
  try {
    const cap = await startCaptureServer();
    const cfgPath = writeAppsettings(dir, {
      centerUrl: `http://127.0.0.1:${cap.port}`,
      heartbeatIntervalSeconds: 1
    });
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['agent.js', cfgPath], {
      cwd: process.cwd(),
      env: { ...process.env }
    });
    // Wait long enough for at least one heartbeat to land (intervalSec=1, plus boot overhead).
    await new Promise(r => setTimeout(r, 2500));
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));

    const heartbeats = cap.requests.filter(r => r.path === '/api/agent/heartbeat');
    assert.ok(heartbeats.length >= 1, `AD agent MUST call /api/agent/heartbeat; saw ${heartbeats.length}`);
    // The AD heartbeat should NOT advertise agentType (center treats absence
    // as 'ad'; see center/src/routes/agent.js:27 — the non-AD extension
    // branches on agentType === 'non-ad').
    const body = JSON.parse(heartbeats[0].body);
    assert.equal(body.agentType, undefined, 'AD heartbeat must not set agentType');
    await cap.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});