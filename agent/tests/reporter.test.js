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

// --- Round-45: partnerPortStatus removed end-to-end --------------------
//
// The R35 port monitoring surface is gone (collect-replication.ps1 no longer
// emits `__partner_ports__:%` rows, no partnerPortStatus column on the
// ad_replication_status INSERT shape). toCamelEntry now emits exactly the
// 15 INSERT-shape fields the centre's rowParams() reads. These tests pin
// the agent→centre boundary contract post-round-45.

// The canonical 15 camelCase keys the centre's rowParams() reads.
// Keep in sync with center/src/services/replication.js.
const INSERT_SHAPE_KEYS = [
  'collectedAt', 'agentId', 'sourceDc', 'destDc', 'sourceSite', 'destSite',
  'namingContext', 'lastSuccessTime', 'lastAttemptTime', 'statusCode',
  'errorMessage', 'usersCount', 'groupsCount', 'gposCount', 'lockedCount'
];

test('toCamelEntry forwards all 15 INSERT-shape fields from a PascalCase entry', () => {
  const out = toCamelEntry({
    CollectedAt: '2026-08-20T01:02:03.000Z',
    AgentId: 'DC1',
    SourceDc: 'DC1',
    DestDc: 'DC2',
    SourceSite: 'S1',
    DestSite: 'S2',
    NamingContext: 'DC=contoso,DC=com',
    LastSuccessTime: '2026-08-20T01:02:03.000Z',
    LastAttemptTime: '2026-08-20T01:02:03.000Z',
    StatusCode: 0,
    ErrorMessage: null,
    UsersCount: 11,
    GroupsCount: 22,
    GposCount: 33,
    LockedCount: 44,
    // partnerPortStatus used to be on the wire — round-45 deletes it
    // entirely. The PS1 no longer emits it; if a stale PS1 somehow still
    // does, toCamelEntry must drop the value (not forward a stray camelCase
    // key the centre's rowParams() doesn't read).
    PartnerPortStatus: '{"checked_at":"...","ports":{}}'
  });

  // Round-45 contract: the 15 INSERT-shape keys must all be present AND
  // partnerPortStatus must be absent. attemptDurationMs / objectsTransferred
  // / _realNamingContext are unrelated (round-42 history-attempt forwarders
  // + mock-only NC rebind) — those are tested separately and don't change
  // the agent→centre boundary contract.
  for (const k of INSERT_SHAPE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, k),
      `toCamelEntry must emit ${k} (round-45 15 INSERT-shape keys)`);
  }

  assert.equal(out.collectedAt, '2026-08-20T01:02:03.000Z');
  assert.equal(out.agentId, 'DC1');
  assert.equal(out.sourceDc, 'DC1');
  assert.equal(out.destDc, 'DC2');
  assert.equal(out.sourceSite, 'S1');
  assert.equal(out.destSite, 'S2');
  assert.equal(out.namingContext, 'DC=contoso,DC=com');
  assert.equal(out.lastSuccessTime, '2026-08-20T01:02:03.000Z');
  assert.equal(out.lastAttemptTime, '2026-08-20T01:02:03.000Z');
  assert.equal(out.statusCode, 0);
  assert.equal(out.errorMessage, null);
  assert.equal(out.usersCount, 11);
  assert.equal(out.groupsCount, 22);
  assert.equal(out.gposCount, 33);
  assert.equal(out.lockedCount, 44);
  // partnerPortStatus must be ABSENT (not even present as null) so the
  // wire shape is byte-for-byte the 15 INSERT-shape columns.
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'partnerPortStatus'), false,
    'partnerPortStatus must not be on the wire after round-45');
});

// Round-45: postReport must NOT carry partnerPortStatus on the wire.
// The endpoint takes the entry's PartnerPortStatus field and forwards it
// (after the camelCase conversion) to the centre. With the field gone
// from toCamelEntry entirely, the row must not include it.
test('postReport does NOT carry partnerPortStatus on the wire (round-45)', async () => {
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
          // A stale PS1 might still set PartnerPortStatus — toCamelEntry
          // must drop it (R35 port monitoring is gone, the centre would
          // only see a stray camelCase key).
          PartnerPortStatus: portJson
        }]
      }
    });
    const row = received.data[0];
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'partnerPortStatus'), false,
      'partnerPortStatus must not appear on the wire after round-45');
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
    // partnerPortStatus must not appear on the wire at all.
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'partnerPortStatus'), false,
      'partnerPortStatus must not be on the wire after round-45');
  });
});