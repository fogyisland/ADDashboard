import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startServers, closeAll } from '../src/multi-port.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

test('startServers: 3 distinct ports → 3 server instances', async () => {
  // Brief originally used port: 0 (ephemeral) for all three entries. That is
  // incompatible with dedupe-by-literal-port semantics because port 0 would
  // collapse all three to a single server. The contract says "dedupes by
  // port, first wins" — so the multi-server case requires three distinct
  // literal ports. We pick three ports in the dynamic/private range that are
  // virtually guaranteed free in any normal test environment.
  const apps = [express(), express(), express()];
  apps.forEach((a, i) => { a.get(`/r${i}`, (_req, res) => res.send(`${i}`)); });
  const servers = await startServers({
    logger: silentLogger,
    roleAppPortList: [
      { role: 'web', app: apps[0], port: 49152 },
      { role: 'heartbeat', app: apps[1], port: 49153 },
      { role: 'report', app: apps[2], port: 49154 }
    ]
  });
  assert.strictEqual(servers.length, 3);
  // Each server has a distinct port
  const ports = servers.map((s) => s.port);
  assert.strictEqual(new Set(ports).size, 3);
  await closeAll(servers, silentLogger);
});

test('startServers: same port shared across roles → only 1 server', async () => {
  const apps = [express(), express()];
  const servers = await startServers({
    logger: silentLogger,
    roleAppPortList: [
      { role: 'web', app: apps[0], port: 0 },
      { role: 'heartbeat', app: apps[1], port: 0 }  // intentionally same port
    ]
  });
  // Dedupes: only the first entry wins
  assert.strictEqual(servers.length, 1);
  assert.strictEqual(servers[0].role, 'web');
  await closeAll(servers, silentLogger);
});

test('startServers: listen error on one port → rejects, no leaked server', async () => {
  const apps = [express(), express()];
  // First app uses port 1 (privileged, almost always fails); second uses 0 (ephemeral).
  await assert.rejects(
    startServers({
      logger: silentLogger,
      roleAppPortList: [
        { role: 'web', app: apps[0], port: 1 },
        { role: 'report', app: apps[1], port: 0 }
      ]
    })
  );
});

test('closeAll: safe to call twice', async () => {
  const app = express();
  const servers = await startServers({
    logger: silentLogger,
    roleAppPortList: [{ role: 'web', app, port: 0 }]
  });
  await closeAll(servers, silentLogger);
  await closeAll(servers, silentLogger); // must not throw
});