import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postReport, postHeartbeat } from '../src/reporter.js';

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