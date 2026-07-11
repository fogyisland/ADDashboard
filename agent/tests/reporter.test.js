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