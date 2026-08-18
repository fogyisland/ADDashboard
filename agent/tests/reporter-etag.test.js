// I8: ETag support for fetchConfig + requestJson 304 handling.
//
// Center's GET /config.json emits an ETag (Express default weak etag of
// the response body). The agent round-trips it:
//   - On every fetch, capture the ETag from the response header.
//   - On the next fetch, send it back as If-None-Match.
//   - On a 304, `data` is null and `etag` is set — caller is responsible
//     for treating that as "your cached config is still current".
//
// requestJson also has to recognise 304 as `ok: true` (it currently
// classifies only 2xx as `ok`); 304 is a success — the body is empty
// by design and the ETag header carries the meaning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchConfig, requestJson } from '../src/reporter.js';

async function withServer(handler, fn) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(() => resolve()); }
    });
  });
}

test('requestJson treats 304 as ok:true with no parsed body', async () => {
  await withServer((_req, res) => {
    res.statusCode = 304;
    res.setHeader('ETag', '"abc"');
    res.end();
  }, async (baseUrl) => {
    const r = await requestJson({ method: 'GET', url: `${baseUrl}/x` });
    assert.equal(r.ok, true, '304 is a success — not ok:false');
    assert.equal(r.status, 304);
    assert.equal(r.data, null);
    assert.equal(r.etag, '"abc"', 'ETag header must be captured even on 304');
  });
});

test('requestJson captures ETag header on 2xx responses too', async () => {
  await withServer((_req, res) => {
    res.setHeader('ETag', '"v1"');
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const r = await requestJson({ method: 'GET', url: `${baseUrl}/x` });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.etag, '"v1"');
  });
});

test('fetchConfig captures the ETag on a 200 response', async () => {
  await withServer((_req, res) => {
    res.setHeader('ETag', '"server-etag-v1"');
    res.end(JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 }));
  }, async (baseUrl) => {
    const r = await fetchConfig({ centerUrl: baseUrl, agentToken: 'tok' });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.data.heartbeatPort, 8081);
    assert.equal(r.etag, '"server-etag-v1"');
  });
});

test('fetchConfig sends If-None-Match when ifNoneMatch is supplied', async () => {
  let receivedInm = null;
  await withServer((req, res) => {
    receivedInm = req.headers['if-none-match'];
    // Simulate center's 304 on matching ETag.
    if (receivedInm === '"server-etag-v1"') {
      res.statusCode = 304;
      res.setHeader('ETag', '"server-etag-v1"');
      res.end();
    } else {
      res.setHeader('ETag', '"server-etag-v2"');
      res.end(JSON.stringify({ heartbeatPort: 8081 }));
    }
  }, async (baseUrl) => {
    const r = await fetchConfig({
      centerUrl: baseUrl,
      agentToken: 'tok',
      ifNoneMatch: '"server-etag-v1"'
    });
    assert.equal(receivedInm, '"server-etag-v1"', 'If-None-Match header must round-trip');
    assert.equal(r.status, 304);
    assert.equal(r.ok, true);
    assert.equal(r.data, null, '304 has no body');
    assert.equal(r.etag, '"server-etag-v1"');
  });
});

test('fetchConfig without ifNoneMatch still works (no If-None-Match header sent)', async () => {
  let receivedInm;
  await withServer((req, res) => {
    receivedInm = req.headers['if-none-match'];
    res.setHeader('ETag', '"v1"');
    res.end(JSON.stringify({ heartbeatPort: 8081 }));
  }, async (baseUrl) => {
    const r = await fetchConfig({ centerUrl: baseUrl, agentToken: 'tok' });
    assert.equal(receivedInm, undefined, 'must not send If-None-Match if caller did not supply one');
    assert.equal(r.status, 200);
    assert.equal(r.data.heartbeatPort, 8081);
    assert.equal(r.etag, '"v1"');
  });
});

test('fetchConfig on 304 leaves data null but exposes etag for the caller to detect', async () => {
  await withServer((_req, res) => {
    res.statusCode = 304;
    res.setHeader('ETag', '"unchanged"');
    res.end();
  }, async (baseUrl) => {
    const r = await fetchConfig({
      centerUrl: baseUrl,
      agentToken: 'tok',
      ifNoneMatch: '"unchanged"'
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 304);
    assert.equal(r.data, null);
    assert.equal(r.etag, '"unchanged"', 'caller uses this to know "config unchanged"');
  });
});