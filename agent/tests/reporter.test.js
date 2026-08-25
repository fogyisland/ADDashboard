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

// --- Task 3 fix round 1 regression tests -------------------------------
//
// toCamelEntry used to forward only 9 of the 16 ad_replication_status
// INSERT-shape fields. partnerPortStatus (Task 1's new column) and the 4
// counters were silently dropped on the wire, so they always landed NULL
// in the DB no matter what collect-replication.ps1 emitted. These tests
// pin the full 16-field contract at the agent->centre boundary.

// The canonical 16 camelCase keys the centre's rowParams() reads.
// Keep in sync with center/src/services/replication.js.
const INSERT_SHAPE_KEYS = [
  'collectedAt', 'agentId', 'sourceDc', 'destDc', 'sourceSite', 'destSite',
  'namingContext', 'lastSuccessTime', 'lastAttemptTime', 'statusCode',
  'errorMessage', 'usersCount', 'groupsCount', 'gposCount', 'lockedCount',
  'partnerPortStatus'
];

test('toCamelEntry forwards all 16 INSERT-shape fields from a PascalCase entry', () => {
  // partnerPortStatus arrives pre-stringified from the PS1 (ConvertTo-Json
  // -Compress), so assert it survives as an untouched JSON *string*.
  const portJson = '{"checked_at":"2026-08-20T01:02:03.000Z","ports":{"135":{"reachable":true,"latencyMs":3,"error":null}}}';
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
    PartnerPortStatus: portJson
  });

  assert.deepEqual(
    Object.keys(out).sort(),
    [...INSERT_SHAPE_KEYS].sort(),
    'toCamelEntry must emit exactly the 16 INSERT-shape keys'
  );

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
  assert.equal(out.partnerPortStatus, portJson, 'partnerPortStatus stays a verbatim JSON string');
});

test('toCamelEntry accepts camelCase input and defaults missing fields to null', () => {
  const out = toCamelEntry({ sourceDc: 'DC1', destDc: 'DC2', partnerPortStatus: '{"ports":{}}' });
  assert.equal(out.sourceDc, 'DC1');
  assert.equal(out.destDc, 'DC2');
  assert.equal(out.partnerPortStatus, '{"ports":{}}');
  // Everything not supplied must be an explicit null, never undefined —
  // undefined would drop the key entirely during JSON.stringify on the wire.
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
  });
});

test('postReport puts partnerPortStatus JSON on the wire (Task 3 primary deliverable)', async () => {
  const portJson = '{"checked_at":"2026-08-20T00:00:00.000Z","ports":{"135":{"reachable":true,"latencyMs":2,"error":null},"445":{"reachable":false,"latencyMs":null,"error":"timeout"}}}';
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
          StatusCode: 1, ErrorMessage: null,
          PartnerPortStatus: portJson
        }]
      }
    });
    const row = received.data[0];
    assert.equal(row.partnerPortStatus, portJson, 'partnerPortStatus survives JSON round-trip to the centre');
    // Sanity: it is still parseable and carries the per-port map.
    const parsed = JSON.parse(row.partnerPortStatus);
    assert.equal(parsed.ports['445'].reachable, false);
    assert.equal(parsed.ports['135'].latencyMs, 2);
    assert.equal(row.namingContext, '__partner_ports__:DC2');
  });
});