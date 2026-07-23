import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPortList } from '../src/port-config-fetcher.js';

test('fetchPortList returns [] when center is unreachable', async () => {
  const r = await fetchPortList('http://127.0.0.1:1', 'x'); // port 1: nothing listening
  assert.deepEqual(r, []);
});

test('fetchPortList parses a valid response', async () => {
  // Spin up a tiny http server that returns [{port:135,label:'RPC',sortOrder:0}]
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ port: 135, label: 'RPC', sortOrder: 0 }]));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const out = await fetchPortList(`http://127.0.0.1:${port}`, 'tok');
    assert.deepEqual(out, [{ port: 135, label: 'RPC', sortOrder: 0 }]);
  } finally {
    await new Promise(r0 => srv.close(r0));
  }
});

test('fetchPortList returns [] on 401 response', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end('Unauthorized');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const out = await fetchPortList(`http://127.0.0.1:${port}`, 'tok');
    assert.deepEqual(out, []);
  } finally {
    await new Promise(r0 => srv.close(r0));
  }
});

test('fetchPortList returns [] on non-array response', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ not: 'an array' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const out = await fetchPortList(`http://127.0.0.1:${port}`, 'tok');
    assert.deepEqual(out, []);
  } finally {
    await new Promise(r0 => srv.close(r0));
  }
});
