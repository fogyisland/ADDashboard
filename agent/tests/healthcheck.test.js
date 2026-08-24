import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { runHealthChecks, tcpProbe } from '../src/healthcheck.js';

test('runHealthChecks returns adModule boolean', async () => {
  const r = await runHealthChecks({ centerUrl: 'http://127.0.0.1:1', agentToken: 't', hostname: 'X' });
  assert.equal(typeof r.checks.adModule, 'boolean');
  assert.equal(typeof r.checks.center, 'boolean');
});

test('tcpProbe returns ok=true on a reachable port', async () => {
  const srv = net.createServer((sock) => sock.end());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await tcpProbe('127.0.0.1', port, 1000);
    assert.strictEqual(r.port, port);
    assert.strictEqual(r.ok, true);
    assert.ok(r.latencyMs >= 0 && r.latencyMs < 1000);
  } finally {
    srv.close();
  }
});

test('tcpProbe returns ok=false on an unreachable port', async () => {
  // Pick a port that's almost certainly closed (e.g. bind then close to get a known-free port).
  const tmp = net.createServer();
  await new Promise(r => tmp.listen(0, '127.0.0.1', r));
  const port = tmp.address().port;
  await new Promise(r => tmp.close(r));
  const r = await tcpProbe('127.0.0.1', port, 200);
  assert.strictEqual(r.port, port);
  assert.strictEqual(r.ok, false);
  assert.ok(r.latencyMs >= 0);
});

test('runHealthChecks aggregates port results', async () => {
  const srv = net.createServer((sock) => sock.end());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const livePort = srv.address().port;
  try {
    const out = await runHealthChecks({
      centerUrl: 'http://nonexistent.invalid',
      agentToken: 'x',
      hostname: 'test-host',
      ports: [livePort]
    });
    assert.ok(Array.isArray(out.ports));
    assert.strictEqual(out.ports.length, 1);
    assert.strictEqual(out.ports[0].port, livePort);
    assert.strictEqual(out.ports[0].ok, true);
  } finally {
    srv.close();
  }
});

test('runHealthChecks threads heartbeatPort to center probe (TCP probe, not HTTP POST)', async () => {
  // 2026-08-24 round-9: checkCenter no longer POSTs a synthetic
  // '__healthcheck__' heartbeat. It uses tcpProbe against heartbeatPort.
  // Bind a TCP listener on heartbeatPort; checkCenter should hit it
  // (center=true) and NOT hit a parallel HTTP server on centerUrl's port.
  const centerSrv = http.createServer(() => { });
  let centerHttpHit = false;
  centerSrv.on('request', () => { centerHttpHit = true; });
  const hbSrv = net.createServer();
  let hbTcpHit = false;
  hbSrv.on('connection', () => { hbTcpHit = true; });
  await Promise.all([
    new Promise(r => centerSrv.listen(0, '127.0.0.1', r)),
    new Promise(r => hbSrv.listen(0, '127.0.0.1', r))
  ]);
  const centerPort = centerSrv.address().port;
  const hbPort = hbSrv.address().port;
  try {
    const out = await runHealthChecks({
      centerUrl: `http://127.0.0.1:${centerPort}`,
      agentToken: 'x',
      hostname: 'test-host',
      heartbeatPort: hbPort
    });
    assert.strictEqual(out.checks.center, true, 'should TCP-probe the heartbeat port successfully');
    assert.strictEqual(centerHttpHit, false, 'should NOT POST a synthetic heartbeat to centerUrl');
    assert.strictEqual(hbTcpHit, true, 'should TCP-probe the heartbeat port');
  } finally {
    centerSrv.close();
    hbSrv.close();
  }
});

test('runHealthChecks returns checks.center=false when heartbeatPort is unreachable', async () => {
  // 2026-08-24 round-9: close a freshly-bound port to get a known-free
  // port and confirm checkCenter returns false when the TCP probe fails.
  const tmp = net.createServer();
  await new Promise(r => tmp.listen(0, '127.0.0.1', r));
  const deadPort = tmp.address().port;
  await new Promise(r => tmp.close(r));
  const out = await runHealthChecks({
    centerUrl: 'http://127.0.0.1:8080',
    agentToken: 'x',
    hostname: 'test-host',
    heartbeatPort: deadPort
  });
  assert.strictEqual(out.checks.center, false, 'unreachable heartbeat port must yield center=false');
});
test('runHealthChecks returns ports:[] when no ports supplied', async () => {
  const out = await runHealthChecks({
    centerUrl: 'http://nonexistent.invalid',
    agentToken: 'x',
    hostname: 'test-host'
  });
  assert.deepEqual(out.ports, []);
});
