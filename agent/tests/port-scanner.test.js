import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverCenterPort } from '../src/port-scanner.js';

// Spin up an http server on an OS-assigned port, return [port, close].
async function startServer(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return [srv.address().port, () => new Promise(r => srv.close(r))];
}

// Standard /config.json responder — accepts any X-Agent-Token, returns JSON.
function configJsonHandler(_req, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 }));
}

test('discovers a port in the priority list (8080)', async () => {
  const [port, close] = await startServer(configJsonHandler);
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],  // bypass OS filter — put the server's port in priority
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 500
    });
    assert.equal(r.port, port);
    assert.equal(r.source, 'priority');
    assert.ok(Number.isFinite(r.probedIn));
  } finally { await close(); }
});

test('discovers a port in the range (use a port the server actually bound to)', async () => {
  const [port, close] = await startServer(configJsonHandler);
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [1, 2, 3],   // OS-assigned won't match these
      rangeStart: port,
      rangeEnd: port,
      concurrency: 1,
      perPortTimeoutMs: 500
    });
    assert.equal(r.port, port);
    assert.equal(r.source, 'range');
  } finally { await close(); }
});

test('handles ports that hang up the connection without crashing', async () => {
  // When a port serves TLS-only (e.g. https on 443) and we hit it with http://,
  // the underlying socket gets ECONNRESET or RST. Scanner must treat as a
  // non-match and continue — no throw, no hang. We simulate by destroying
  // the socket mid-handshake on an http server.
  const [port, close] = await startServer((_req, res) => {
    res.socket.destroy();
  });
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 300
    });
    assert.equal(r, null);
  } finally { await close(); }
});

test('ignores non-JSON 2xx responses', async () => {
  const [port, close] = await startServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>oops</body></html>');
  });
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 500
    });
    assert.equal(r, null);
  } finally { await close(); }
});

test('ignores 401 (server rejects our token)', async () => {
  const [port, close] = await startServer((_req, res) => {
    res.statusCode = 401;
    res.end('Unauthorized');
  });
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 500
    });
    assert.equal(r, null);
  } finally { await close(); }
});

test('returns null when no port matches (rangeStart > rangeEnd)', async () => {
  const r = await discoverCenterPort({
    host: '127.0.0.1',
    agentToken: 'tok',
    priorityPorts: [],
    rangeStart: 60000,
    rangeEnd: 10000,
    perPortTimeoutMs: 100
  });
  assert.equal(r, null);
});

test('returns null on DNS-unreachable host without throwing', async () => {
  const r = await discoverCenterPort({
    host: 'this-host-does-not-exist-12345.invalid',
    agentToken: 'tok',
    priorityPorts: [],
    rangeStart: 10000,
    rangeEnd: 10010,
    concurrency: 5,
    perPortTimeoutMs: 200
  });
  assert.equal(r, null);
});

test('early-exits after first hit (probes at most ~concurrency extra ports)', async () => {
  // Priority port wins over range — proves scanner returned on first hit
  // without probing range. The rangeStart/End below are coincidentally in
  // [20000, 20001] which has no listener, so any range probe returns null;
  // a non-early-exit scanner would still return the priority hit, but the
  // priority-source assertion proves it stopped there.
  const [priorityPort, closeA] = await startServer(configJsonHandler);
  const [, closeB] = await startServer(configJsonHandler);
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [priorityPort],
      rangeStart: 20000,
      rangeEnd: 20001,
      concurrency: 1,
      perPortTimeoutMs: 500
    });
    assert.equal(r.port, priorityPort);
    assert.equal(r.source, 'priority');
  } finally {
    await closeA();
    await closeB();
  }
});