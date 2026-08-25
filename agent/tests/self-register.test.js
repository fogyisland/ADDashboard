// Tests for the self-register boot step in non-AD agent runtime.
//
// T16 contract (brief §Step 1):
//   - non-AD agent MUST POST to /api/admin/member-servers/self-register on
//     boot, with body { hostname, agentVersion, osVersion, ipAddress }.
//   - AD agent MUST skip this call.
//
// Approach: same as agent-type.test.js — boot agent.js as a child process
// against a fake http capture server, then assert the requests landed (or
// did not) as expected. We use a separate test file because the brief asked
// for `tests/self-register.test.js` and we want a focused per-contract
// surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function writeAppsettings(dir, extra = {}) {
  const cfg = {
    centerUrl: 'http://127.0.0.1:65535',
    agentId: 'host-X',
    agentToken: 'tok',
    logLevel: 'info',
    pollingIntervalMinutes: 15,
    heartbeatIntervalSeconds: 5,
    discoveryIntervalHours: 1,
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

function startCaptureServer() {
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

test('non-ad self-register body contains hostname, agentVersion, osVersion, ipAddress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-register-'));
  try {
    const cap = await startCaptureServer();
    const cfgPath = writeAppsettings(dir, {
      agentType: 'non-ad',
      centerUrl: `http://127.0.0.1:${cap.port}`,
      agentId: 'host-M2',
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

    const calls = cap.requests.filter(r => r.path === '/api/admin/member-servers/self-register');
    assert.ok(calls.length >= 1, 'expected at least one self-register call from non-AD agent');
    // Auth header must be set (matches the rest of the agent's traffic)
    assert.equal(calls[0].headers['x-agent-token'], 'tok', 'X-Agent-Token must be sent');
    const body = JSON.parse(calls[0].body);
    for (const key of ['hostname', 'agentVersion', 'osVersion', 'ipAddress']) {
      assert.ok(key in body, `self-register body missing key: ${key}`);
      assert.equal(typeof body[key], 'string', `self-register body.${key} must be string`);
    }
    await cap.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ad agent (default agentType) skips self-register call entirely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-register-ad-'));
  try {
    const cap = await startCaptureServer();
    const cfgPath = writeAppsettings(dir, {
      // No agentType — should default to 'ad'
      centerUrl: `http://127.0.0.1:${cap.port}`,
      agentId: 'host-DC1',
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

    const calls = cap.requests.filter(r => r.path === '/api/admin/member-servers/self-register');
    assert.equal(calls.length, 0, 'AD agent must NEVER call /api/admin/member-servers/self-register');
    await cap.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
