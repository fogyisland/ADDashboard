import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// We test tryRecoverCenterPort indirectly by replicating its behavior with
// the real port-scanner + writer + reporter. Mirroring the agent.js helper
// here keeps the integration test self-contained and avoids importing the
// whole agent entrypoint (which would require DB + heartbeat setup).

import { discoverCenterPort } from '../src/port-scanner.js';
import { writeCenterUrlAtomic } from '../src/appsettings-writer.js';
import { fetchConfig } from '../src/reporter.js';

function configJsonHandler(_req, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 }));
}

async function startServer(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return [srv.address().port, () => new Promise(r => srv.close(r))];
}

test('stale centerUrl: scan finds new port, swaps config, rewrites appsettings', async () => {
  // 1. Spin up a "center" on an OS-assigned port.
  const [realPort, close] = await startServer(configJsonHandler);
  // 2. Write an appsettings.json pointing at port 1 (nothing there).
  const dir = mkdtempSync(join(tmpdir(), 'agent-recovery-'));
  const settingsPath = join(dir, 'appsettings.json');
  writeFileSync(settingsPath, JSON.stringify({
    centerUrl: `http://127.0.0.1:1`,  // wrong port
    agentId: 'DC1',
    agentToken: 'tok',
    centerHost: '127.0.0.1'
  }, null, 2));

  // 3. Simulate the in-memory config the agent holds.
  const config = JSON.parse(readFileSync(settingsPath, 'utf8'));

  // 4. First fetchConfig fails (port 1 is dead).
  const first = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  assert.equal(first.ok, false);

  // 5. Scan — should find realPort via priority or range.
  const scan = await discoverCenterPort({
    host: config.centerHost,
    agentToken: config.agentToken,
    priorityPorts: [realPort],   // short-circuit by listing real port in priority
    rangeStart: 20000,
    rangeEnd: 20001,
    perPortTimeoutMs: 500
  });
  assert.ok(scan, 'scan should find the center');
  assert.equal(scan.port, realPort);

  // 6. Replace port in centerUrl and rewrite appsettings atomically.
  const newUrl = String(config.centerUrl).replace(/\/+$/, '').replace(/:\d+$/, '') + ':' + scan.port;
  const w = writeCenterUrlAtomic({ path: settingsPath, newUrl });
  assert.equal(w.ok, true);
  config.centerUrl = newUrl;

  // 7. Retry fetchConfig with new url — must succeed.
  const second = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  assert.equal(second.ok, true);
  assert.equal(second.data.heartbeatPort, 8081);
  assert.equal(second.data.reportPort, 8082);

  // 8. appsettings.json on disk reflects the new port.
  const reread = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(reread.centerUrl, newUrl);

  await close();
  rmSync(dir, { recursive: true, force: true });
});
