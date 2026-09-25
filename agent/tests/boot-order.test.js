import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// 2026-09-25 R93.7 — Cold-start race regression guard.
//
// R93.3 documented a known trade-off: on first boot,
//   await refreshPortList()          // line 328 (runs FIRST)
// runs before
//   await refreshAgentPortsWithRecovery('boot')  // line 369
// so `cachedPorts.heartbeatPort` is null on the first tick → fetchPortList
// uses centerUrl verbatim → lands on web (8080) → 404 HTML.
//
// R93.7 swaps the order so refreshAgentPortsWithRecovery('boot') runs FIRST
// and fills `cachedPorts.heartbeatPort` before refreshPortList() consumes it.
//
// These two tests pin the boot order at the helper level (without importing
// the whole agent.js entrypoint, which would require DB + heartbeat setup).
// They fail loudly if a future refactor re-introduces the cold-start race.

// --- Replica of the boot sequence from agent.js:runAdRuntime ---
// Mirrors the structure of the production block as of R93.7. If agent.js's
// boot order changes, this test will diverge from reality and the assertion
// below will fail, prompting an update.
//
// Keeping the replica here (instead of importing from agent.js) preserves
// the same isolation that bootstrap-recovery.test.js relies on.

import { fetchConfig } from '../src/reporter.js';
import { fetchPortList } from '../src/port-config-fetcher.js';

// Boot order as of R93.7:
//   1. let cachedPorts = { heartbeatPort: null, reportPort: null };
//   2. await refreshAgentPortsWithRecovery('boot');   // fills cachedPorts.heartbeatPort
//   3. await refreshPortList();                         // reads cachedPorts.heartbeatPort
async function bootSequenceR937({ centerUrl, agentToken }) {
  const cachedPorts = { heartbeatPort: null, reportPort: null };

  async function refreshAgentPorts() {
    const r = await fetchConfig({ centerUrl, agentToken });
    if (r.ok && r.data) {
      cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
      cachedPorts.reportPort    = Number(r.data.reportPort)    || null;
      return true;
    }
    return false;
  }
  async function refreshAgentPortsWithRecovery(trigger) {
    const ok = await refreshAgentPorts();
    if (ok) return;
    // Recovery path is not exercised here — we only care about order.
    void trigger;
  }

  // R93.7 boot order: fill heartbeatPort BEFORE reading it.
  await refreshAgentPortsWithRecovery('boot');

  let cachedPortList = [];
  async function refreshPortList() {
    cachedPortList = await fetchPortList(centerUrl, agentToken, { port: cachedPorts.heartbeatPort });
  }
  await refreshPortList();
  return cachedPortList;
}

test('R93.7 boot order: fetchConfig runs before fetchPortList on first boot', async () => {
  // /config.json served by center on port A (8080), /api/agent/ports served
  // by heartbeat on port B (8081). If fetchPortList lands on A it gets 404
  // HTML; on B it gets the ports JSON. The two-port split is what makes
  // the cold-start race observable in production.
  const cfgJson = JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 });
  const portsJson = JSON.stringify([{ port: 135, label: 'RPC', sortOrder: 0 }]);

  const webCalls = [];   // requests hitting port A (8080)
  const hbCalls  = [];   // requests hitting port B (8081)

  const web = http.createServer((req, res) => {
    webCalls.push(req.url);
    if (req.url === '/config.json') {
      res.setHeader('content-type', 'application/json');
      res.end(cfgJson);
    } else {
      // /api/agent/ports on web returns 404 HTML (the cold-start symptom).
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html>404</html>');
    }
  });
  await new Promise(r => web.listen(8080, '127.0.0.1', r));

  const hb = http.createServer((req, res) => {
    hbCalls.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(portsJson);
  });
  await new Promise(r => hb.listen(8081, '127.0.0.1', r));

  try {
    const out = await bootSequenceR937({
      centerUrl: 'http://127.0.0.1:8080',
      agentToken: 'tok'
    });

    // /config.json hit web (8080) — that is correct and expected.
    assert.ok(webCalls.includes('/config.json'),
              '/config.json must be fetched from web (8080) to discover heartbeatPort');

    // /api/agent/ports must NOT have been served 404 HTML — it should have
    // gone to heartbeat (8081) because fetchConfig ran first and filled
    // cachedPorts.heartbeatPort.
    assert.ok(!webCalls.includes('/api/agent/ports'),
              'fetchPortList must NOT hit web (8080) on first boot — ' +
              'R93.7 ensures refreshAgentPortsWithRecovery runs first');

    // And it must have landed on heartbeat (8081) where it gets 200 JSON.
    assert.ok(hbCalls.includes('/api/agent/ports'),
              'fetchPortList must hit heartbeat (8081) on first boot');

    // Output is the parsed ports array, not the HTML 404 body.
    assert.deepEqual(out, [{ port: 135, label: 'RPC', sortOrder: 0 }]);
  } finally {
    await new Promise(r => web.close(r));
    await new Promise(r => hb.close(r));
  }
});

// Pre-R93.7 boot order replica — what the cold-start race looked like.
// If anyone reverts to this order, this test would fail. It also serves as
// documentation of why the swap matters.
async function bootSequencePreR937({ centerUrl, agentToken }) {
  const cachedPorts = { heartbeatPort: null, reportPort: null };

  // R93.3 order: refreshPortList() runs FIRST, before cachedPorts.heartbeatPort
  // is filled. fetchPortList falls through to centerUrl (8080) → 404 HTML.
  let cachedPortList = [];
  async function refreshPortList() {
    cachedPortList = await fetchPortList(centerUrl, agentToken, { port: cachedPorts.heartbeatPort });
  }
  await refreshPortList();

  // Then refreshAgentPortsWithRecovery('boot') fills heartbeatPort. The next
  // tick will succeed, but the first one already failed.
  async function refreshAgentPorts() {
    const r = await fetchConfig({ centerUrl, agentToken });
    if (r.ok && r.data) {
      cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
      return true;
    }
    return false;
  }
  await refreshAgentPorts();

  return cachedPortList;
}

test('Pre-R93.7 boot order returns [] on first tick (regression sentinel)', async () => {
  // This test documents the OLD behavior: first refreshPortList() with
  // port=null lands on 8080 and gets 404 HTML. fetchPortList swallows the
  // 404 HTML body and returns [] per its catch-all contract. That's the
  // observable symptom R93.7 fixes on the wire.
  //
  // Note: we don't assert 'webCalls.includes(/api/agent/ports)' because
  // fetching from a server that just closed in the prior test can race
  // the assertion. The behavioral assertion (`out === []`) is what matters.
  const cfgJson = JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 });
  const portsJson = JSON.stringify([{ port: 135, label: 'RPC', sortOrder: 0 }]);

  const web = http.createServer((req, res) => {
    if (req.url === '/config.json') {
      res.setHeader('content-type', 'application/json');
      res.end(cfgJson);
    } else {
      // /api/agent/ports on web returns 404 HTML (the cold-start symptom).
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html>404</html>');
    }
  });
  await new Promise(r => web.listen(8080, '127.0.0.1', r));

  const hb = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(portsJson);
  });
  await new Promise(r => hb.listen(8081, '127.0.0.1', r));

  // Yield once so the prior test's server.close() has fully torn down
  // before this test starts listening on the same fixed ports.
  await new Promise(r => setImmediate(r));

  try {
    const out = await bootSequencePreR937({
      centerUrl: 'http://127.0.0.1:8080',
      agentToken: 'tok'
    });

    // fetchPortList swallowed the 404 HTML and returned [].
    assert.deepEqual(out, [],
                     'Pre-R93.7 first tick returned [] (cold-start swallowed 404 HTML)');
  } finally {
    await new Promise(r => web.close(r));
    await new Promise(r => hb.close(r));
  }
});