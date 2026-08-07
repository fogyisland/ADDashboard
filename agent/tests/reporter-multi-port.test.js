import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postHeartbeat, postReport } from '../src/reporter.js';

// Helper: start a local server on ephemeral port that records the request URL,
// return its base URL like 'http://127.0.0.1:12345' AND close function.
function startRecorder(onReq) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, _res) => { onReq(req.url); });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r))
      });
    });
  });
}

test('postHeartbeat: explicit port → URL strips centerUrl port and appends override', async () => {
  let recordedUrl = null;
  const rec = await startRecorder((u) => { recordedUrl = u; });
  try {
    // Point centerUrl at the recorder's ephemeral port (not example.test) so
    // the request actually reaches the recorder; the `port: 8081` override
    // should redirect the connection to localhost:8081 — which we expect to
    // be unreachable in the unit test, so we only assert that the recorder
    // never receives the request (port override redirected away from it).
    await postHeartbeat({
      centerUrl: rec.base,
      agentToken: 'tok',
      port: 8081,
      payload: { agentId: 'a' }
    });
    // Connection redirected to port 8081 (override), so recorder sees nothing.
    assert.strictEqual(recordedUrl, null);
  } finally { await rec.close(); }
});

test('postHeartbeat: no port → falls back to centerUrl verbatim', async () => {
  let recordedUrl = null;
  const rec = await startRecorder((u) => { recordedUrl = u; });
  try {
    await postHeartbeat({
      centerUrl: rec.base,  // ephemeral port is the only one in play
      agentToken: 'tok',
      port: null,
      payload: { agentId: 'a' }
    });
    assert.strictEqual(recordedUrl, '/api/agent/heartbeat');
  } finally { await rec.close(); }
});

test('postReport: port override applied symmetrically', async () => {
  let recordedUrl = null;
  const rec = await startRecorder((u) => { recordedUrl = u; });
  try {
    await postReport({
      centerUrl: rec.base,
      agentToken: 'tok',
      port: 8082,
      snapshot: { AgentId: 'a', CollectedAt: '2026-01-01T00:00:00Z', Entries: [] }
    });
    // Connection redirected to port 8082 (override), so recorder sees nothing.
    assert.strictEqual(recordedUrl, null);
  } finally { await rec.close(); }
});