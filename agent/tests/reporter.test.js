import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postReport, postHeartbeat, fetchConfig, toCamelEntry } from '../src/reporter.js';

async function withServer(handler, fn) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(() => resolve()); }
    });
  });
}

test('postReport sends payload and parses response', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end(JSON.stringify({ ok: true })); });
  }, async (url) => {
    const r = await postReport({ centerUrl: url, agentToken: 't', snapshot: { AgentId: 'X', Entries: [] } });
    assert.equal(r.ok, true);
    // postReport sends { agentId: ..., collectedAt: ..., data: ... } (lowercase agentId)
    assert.equal(received.agentId, 'X');
  });
});

test('postHeartbeat sends heartbeat', async () => {
  await withServer((req, res) => { res.end('{}'); }, async (url) => {
    const r = await postHeartbeat({ centerUrl: url, agentToken: 't', payload: { agentId: 'X' } });
    assert.equal(r.status, 200);
  });
});

test('postReport converts PascalCase entries to camelCase (cross-task center contract)', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    const r = await postReport({
      centerUrl: url, agentToken: 't',
      snapshot: {
        AgentId: 'DC1',
        CollectedAt: '2026-07-11T00:00:00.000Z',
        Entries: [{
          SourceDc: 'DC1', DestDc: 'DC2',
          SourceSite: 'S1', DestSite: 'S2',
          NamingContext: 'DC=x', LastSuccessTime: '2026-07-11T00:00:00.000Z',
          LastAttemptTime: null, StatusCode: 0, ErrorMessage: null
        }]
      }
    });
    assert.equal(r.ok, true);
    assert.equal(received.agentId, 'DC1');
    assert.equal(received.data.length, 1);
    const row = received.data[0];
    assert.equal(row.sourceDc, 'DC1', 'sourceDc camelCase');
    assert.equal(row.destDc, 'DC2', 'destDc camelCase');
    assert.equal(row.sourceSite, 'S1', 'sourceSite camelCase');
    assert.equal(row.destSite, 'S2', 'destSite camelCase');
    assert.equal(row.namingContext, 'DC=x', 'namingContext camelCase');
    assert.equal(row.lastSuccessTime, '2026-07-11T00:00:00.000Z', 'lastSuccessTime camelCase');
    assert.equal(row.statusCode, 0, 'statusCode camelCase');
  });
});

test('postReport returns ok:true for 2xx with empty body (not swallow as failure)', async () => {
  await withServer((req, res) => { res.end(''); }, async (url) => {
    const r = await postReport({ centerUrl: url, agentToken: 't', snapshot: { AgentId: 'X', Entries: [] } });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.data, null);
  });
});

test('postHeartbeat includes agentVersion (not version) for cross-task center contract', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    await postHeartbeat({ centerUrl: url, agentToken: 't', payload: { agentId: 'X', agentVersion: '0.1.0' } });
    assert.equal(received.agentVersion, '0.1.0');
    assert.equal(received.version, undefined, 'should NOT use the version key (renamed to agentVersion)');
  });
});

// fetchConfig hits the web-port bootstrap endpoint /config.json (not the
// legacy /api/agent/config on the report port). Sends X-Agent-Token and
// parses the JSON response containing the agent's runtime config.
test('fetchConfig hits /config.json with X-Agent-Token and parses response', async () => {
  let receivedPath = null;
  let receivedToken = null;
  await withServer((req, res) => {
    receivedPath = req.url;
    receivedToken = req.headers['x-agent-token'];
    res.end(JSON.stringify({ heartbeatPort: 8081, reportPort: 8082, pollingIntervalMinutes: 5, agentToken: 'tok' }));
  }, async (url) => {
    const r = await fetchConfig({ centerUrl: url, agentToken: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(receivedPath, '/config.json');
    assert.equal(receivedToken, 'tok');
    assert.equal(r.data.heartbeatPort, 8081);
    assert.equal(r.data.reportPort, 8082);
    assert.equal(r.data.pollingIntervalMinutes, 5);
  });
});

// 2026-08-25 round-12 observability: the agent stamps `source` on every
// outgoing body so the centre's per-route info log can attribute the
// request to a specific collector / PS script. Without this the log
// shows 'unknown' (backward compat for old agents), which the operator
// can't tie back to the script they meant to debug.
test('postReport stamps source="collect-replication" on the body', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    await postReport({
      centerUrl: url, agentToken: 't',
      snapshot: { AgentId: 'X', CollectedAt: '2026-07-11T00:00:00Z', Entries: [] }
    });
    assert.equal(received.source, 'collect-replication');
  });
});

test('postHeartbeat stamps source="heartbeat" on the body', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    await postHeartbeat({ centerUrl: url, agentToken: 't', payload: { agentId: 'X' } });
    assert.equal(received.source, 'heartbeat');
    // The payload's other fields must be preserved alongside source —
    // we use object spread, so {source, ...payload} merges without
    // clobbering agentId/ports/etc.
    assert.equal(received.agentId, 'X');
  });
});

// --- Round-46: partnerPortStatus restored end-to-end -------------------
//
// R46 (复制日志监控 合并入站 + 端口健康) undid R45's partnerPortStatus
// removal. The 16-column ad_replication_status INSERT shape now includes
// partner_port_status at position 16 — bound as JSON string on
// `__partner_ports__:%` rows. The agent boundary must forward
// PascalCase `PartnerPortStatus` to camelCase `partnerPortStatus` so the
// centre's rowParams() can read it off the row and bind it at position 16.
// Without this forwarder the column was always NULL → route's
// portHealthByPair map always empty → /replication-log/all port health
// surface empty (regression of R35 surface restored in R46).

// The canonical 16 camelCase keys the centre's rowParams() reads.
// Keep in sync with center/src/services/replication.js.
const INSERT_SHAPE_KEYS = [
  'collectedAt', 'agentId', 'sourceDc', 'destDc', 'sourceSite', 'destSite',
  'namingContext', 'lastSuccessTime', 'lastAttemptTime', 'statusCode',
  'errorMessage', 'usersCount', 'groupsCount', 'gposCount', 'lockedCount',
  'partnerPortStatus'
];

test('toCamelEntry forwards all 16 INSERT-shape fields including partnerPortStatus (R46 restore)', () => {
  const portJson = '{"checked_at":"...","ports":{}}';
  const out = toCamelEntry({
    CollectedAt: '2026-08-20T01:02:03.000Z',
    AgentId: 'DC1',
    SourceDc: 'DC1',
    DestDc: 'DC2',
    SourceSite: 'S1',
    DestSite: 'S2',
    NamingContext: '__partner_ports__:DC2',
    LastSuccessTime: '2026-08-20T01:02:03.000Z',
    LastAttemptTime: '2026-08-20T01:02:03.000Z',
    StatusCode: 0,
    ErrorMessage: null,
    UsersCount: 11,
    GroupsCount: 22,
    GposCount: 33,
    LockedCount: 44,
    // R46: forward the PascalCase PartnerPortStatus as camelCase
    // partnerPortStatus so the centre's rowParams() can bind it at
    // position 16. If we drop it here, /replication-log/all port health
    // shows empty on every partner row.
    PartnerPortStatus: portJson
  });

  for (const k of INSERT_SHAPE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, k),
      `toCamelEntry must emit ${k} (R46 16 INSERT-shape keys)`);
  }

  assert.equal(out.collectedAt, '2026-08-20T01:02:03.000Z');
  assert.equal(out.agentId, 'DC1');
  assert.equal(out.sourceDc, 'DC1');
  assert.equal(out.destDc, 'DC2');
  assert.equal(out.sourceSite, 'S1');
  assert.equal(out.destSite, 'S2');
  assert.equal(out.namingContext, '__partner_ports__:DC2');
  assert.equal(out.lastSuccessTime, '2026-08-20T01:02:03.000Z');
  assert.equal(out.lastAttemptTime, '2026-08-20T01:02:03.000Z');
  assert.equal(out.statusCode, 0);
  assert.equal(out.errorMessage, null);
  assert.equal(out.usersCount, 11);
  assert.equal(out.groupsCount, 22);
  assert.equal(out.gposCount, 33);
  assert.equal(out.lockedCount, 44);
  // R46: partnerPortStatus must be forwarded as the original JSON string
  // (centre's rowParams() JSON.stringify()es only when it's an object).
  assert.equal(out.partnerPortStatus, portJson,
    'partnerPortStatus must be forwarded end-to-end (R46 restore)');
});

// R46: postReport must carry partnerPortStatus on the wire for the
// __partner_ports__:% row the centre routes through its port-health
// surface. The endpoint takes the entry's PartnerPortStatus field and
// forwards it (after camelCase conversion) to the centre.
test('postReport carries partnerPortStatus on the wire (R46 restore)', async () => {
  const portJson = '{"checked_at":"2026-08-20T00:00:00.000Z","ports":{"135":{"reachable":true,"latencyMs":2}}}';
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    await postReport({
      centerUrl: url, agentToken: 't',
      snapshot: {
        AgentId: 'DC1',
        CollectedAt: '2026-08-20T00:00:00.000Z',
        Entries: [{
          SourceDc: 'DC1', DestDc: 'DC2',
          NamingContext: '__partner_ports__:DC2',
          StatusCode: 0, ErrorMessage: null,
          PartnerPortStatus: portJson
        }]
      }
    });
    const row = received.data[0];
    assert.equal(row.partnerPortStatus, portJson,
      'partnerPortStatus must appear on the wire after R46 restore');
    assert.equal(row.namingContext, '__partner_ports__:DC2');
  });
});

test('toCamelEntry accepts camelCase input and defaults missing fields to null', () => {
  const out = toCamelEntry({ sourceDc: 'DC1', destDc: 'DC2' });
  assert.equal(out.sourceDc, 'DC1');
  assert.equal(out.destDc, 'DC2');
  // Everything not supplied must be an explicit null, never undefined —
  // undefined would drop the key entirely during JSON.stringify on the wire.
  // Note: we only assert the 15 INSERT-shape keys (the wire contract with
  // the centre). attemptDurationMs / objectsTransferred / _realNamingContext
  // are also nullable but unrelated to this contract.
  for (const k of INSERT_SHAPE_KEYS) {
    assert.notEqual(out[k], undefined, `${k} must not be undefined`);
  }
  assert.equal(out.usersCount, null);
  assert.equal(out.gposCount, null);
});

test('postReport puts the 4 counters on the wire (previously dropped)', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    await postReport({
      centerUrl: url, agentToken: 't',
      snapshot: {
        AgentId: 'DC1',
        CollectedAt: '2026-08-20T00:00:00.000Z',
        Entries: [{
          SourceDc: 'DC1', DestDc: 'DC1', NamingContext: '__dc_summary__',
          StatusCode: 0,
          UsersCount: 1200, GroupsCount: 340, GposCount: 56, LockedCount: 7
        }]
      }
    });
    const row = received.data[0];
    assert.equal(row.usersCount, 1200, 'usersCount reaches the centre');
    assert.equal(row.groupsCount, 340, 'groupsCount reaches the centre');
    assert.equal(row.gposCount, 56, 'gposCount reaches the centre');
    assert.equal(row.lockedCount, 7, 'lockedCount reaches the centre');
    // R46: for the __dc_summary__ row, partnerPortStatus is null (PS1 doesn't
    // emit it). The wire shape is still the 16 INSERT-shape keys — null is
    // the centre's "skip partner-port binding" sentinel.
    assert.equal(row.partnerPortStatus, null,
      'partnerPortStatus on __dc_summary__ row is null (no probe)');
  });
});

// 2026-08-28 round-58.4 (CRITICAL): mock-snapshot.mjs emits the
// _RealNamingContext field as PascalCase-with-underscore (matching the rest
// of its PascalCase keys like SourceDc/NamingContext). The centre's
// historyParams reads `row._realNamingContext ?? null` and binds it as the
// stored naming_context for `__history__:%` rows. If toCamelEntry fails to
// forward the field, historyParams gets null, SQL fails
// (ER_BAD_NULL_ERROR), and every replication report with `__history__:%`
// rows 500s. This test pins the forwarder to accept all three shapes —
// mock (_RealNamingContext), real-agent (RealNamingContext), and the
// already-camelCase _realNamingContext — so a future refactor can't drop
// one of them.
test('toCamelEntry forwards _RealNamingContext for __history__:% rows (round-58.4 regression)', () => {
  const real = 'CN=DC1->DC2';

  // mock-snapshot.mjs shape (PascalCase + underscore prefix)
  const fromMock = toCamelEntry({
    SourceDc: 'DC1', DestDc: 'DC2', NamingContext: '__history__:abc123',
    _RealNamingContext: real
  });
  assert.equal(fromMock._realNamingContext, real,
    'toCamelEntry must forward _RealNamingContext from mock-snapshot.mjs');

  // collect-replication.ps1 shape (PascalCase, no underscore prefix)
  const fromReal = toCamelEntry({
    SourceDc: 'DC1', DestDc: 'DC2', NamingContext: '__history__:abc123',
    RealNamingContext: real
  });
  assert.equal(fromReal._realNamingContext, real,
    'toCamelEntry must forward RealNamingContext from collect-replication.ps1');

  // already-camelCase shape (defensive — both fallbacks must yield the same field)
  const fromCamel = toCamelEntry({
    sourceDc: 'DC1', destDc: 'DC2', namingContext: '__history__:abc123',
    _realNamingContext: real
  });
  assert.equal(fromCamel._realNamingContext, real,
    'toCamelEntry must forward _realNamingContext when pre-camelCased');

  // missing field → null (matches the centre's null-binding behavior)
  const missing = toCamelEntry({
    SourceDc: 'DC1', DestDc: 'DC2', NamingContext: '__history__:abc123'
  });
  assert.equal(missing._realNamingContext, null,
    'toCamelEntry must default _realNamingContext to null when not present');
});

// 2026-08-28 round-58.4 (CRITICAL): postReport end-to-end — verify the
// _RealNamingContext actually reaches the centre over the wire (not just
// the in-memory toCamelEntry). This is the integration counterpart of the
// unit test above; if a future refactor splits the JSON wire shape from
// the in-memory shape, this test catches it.
test('postReport forwards _RealNamingContext end-to-end (round-58.4 regression)', async () => {
  let received = null;
  await withServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received = JSON.parse(body); res.end('{}'); });
  }, async (url) => {
    await postReport({
      centerUrl: url, agentToken: 't',
      snapshot: {
        AgentId: 'MOCK-FAKE',
        CollectedAt: '2026-08-28T00:00:00.000Z',
        Entries: [{
          SourceDc: 'MOCK-FAKE', DestDc: 'MOCK-PEER',
          NamingContext: '__history__:abcdef',
          StatusCode: 0, LastSuccessTime: '2026-08-28T00:00:00.000Z',
          LastAttemptTime: '2026-08-28T00:00:00.000Z',
          _RealNamingContext: 'CN=MOCK-FAKE->MOCK-PEER'
        }]
      }
    });
  });
  const row = received.data[0];
  assert.equal(row.namingContext, '__history__:abcdef');
  assert.equal(row._realNamingContext, 'CN=MOCK-FAKE->MOCK-PEER',
    '_RealNamingContext must reach the centre over the wire so historyParams can strip the prefix');
});