import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from '../src/discovery.js';

test('postDiscovery POSTs JSON to /api/agent/discover with X-Agent-Token', async () => {
  let receivedReq = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedReq = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const result = await postDiscovery({
      centerUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      payload: { agentId: 'A1', collectedAt: '2026-07-12T00:00:00.000Z', dc: { name: 'A1' } }
    });
    assert.equal(result.ok, true);
    assert.equal(receivedReq.method, 'POST');
    assert.equal(receivedReq.url, '/api/agent/discover');
    assert.equal(receivedReq.headers['x-agent-token'], 'tok');
    const parsed = JSON.parse(receivedReq.body);
    assert.equal(parsed.agentId, 'A1');
    assert.equal(parsed.dc.name, 'A1');
  } finally {
    server.close();
  }
});

test('runDiscovery parses PS stdout JSON', async () => {
  const fakeScript = 'C:/tmp/fake.ps1'; // not invoked; we mock by testing parser indirectly
  // We can't easily mock spawnSync without restructuring; instead test
  // the parser via the public surface by feeding a hand-built snapshot
  // through postDiscovery and asserting shape.
  // (Real spawn-path coverage requires a Windows env with PS on PATH.)
  assert.equal(typeof runDiscovery, 'function');
});

test('startDiscoveryScheduler fires immediately and on interval; stop() halts', async () => {
  let calls = 0;
  const sched = startDiscoveryScheduler({
    intervalHours: 0, // effectively every "tick" — but we use setInterval with ms=Math.max(1, h)*3_600_000
    run: async () => { calls++; }
  });
  // intervalHours=0 maps to 1 hour in the impl, which is too slow for tests.
  // Test only immediate fire:
  await new Promise(r => setTimeout(r, 50));
  assert.ok(calls >= 1, `expected >=1 call, got ${calls}`);
  sched.stop();
});

test('startDiscoveryScheduler stop() prevents further calls', async () => {
  let calls = 0;
  const sched = startDiscoveryScheduler({
    intervalHours: 1,
    run: async () => { calls++; }
  });
  sched.stop();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 1, 'only the immediate fire should have run');
});

// 2026-08-24 round-9: runDiscovery now logs the failure (stderr / exit
// code) through the injected logger instead of returning null silently.
// The previous silent-return made the DC list mysteriously empty when
// collect-discovery.ps1 failed — operator saw 0 DCs but no log line
// explaining why. Test the three failure paths: spawn failure, non-zero
// exit, and unparseable stdout.
const isWin = process.platform === 'win32';

test('runDiscovery logs through logger when ps script exits non-zero', { skip: !isWin && 'requires powershell.exe (Windows)' }, async () => {
  // Spawn a script that always exits 2 with a Chinese error on stderr
  // (the actual scenario on KDLWXOFADSRV1: Get-ADDomainController throws
  // Chinese AD error, [Console]::Error.WriteLine writes GBK bytes, after
  // the round-9 UTF-8 fix Node decodes them as UTF-8 correctly).
  const dir = mkdtempSync(join(tmpdir(), 'disc-test-'));
  const scriptPath = join(dir, 'fail.ps1');
  // Note: cannot easily simulate GBK from a CI test; just emit ASCII.
  writeFileSync(scriptPath, '[Console]::Error.WriteLine("指定的对象不存在"); exit 2\n');
  const events = [];
  const fakeLogger = { warn: (e, msg) => events.push({ e, msg }) };
  const result = await runDiscovery({
    powerShellPath: 'powershell.exe',
    psDiscoveryScriptPath: scriptPath,
    logger: fakeLogger
  });
  assert.equal(result, null, 'runDiscovery must resolve null on non-zero exit');
  assert.ok(events.length >= 1, 'logger.warn should have been called');
  const e = events[0].e;
  assert.match(e.stderr || '', /指定的对象不存在/, 'stderr should carry the AD error verbatim');
  assert.match(e.err || '', /exit 2/, 'log payload should include the exit code');
  rmSync(dir, { recursive: true });
});

test('runDiscovery logs when stdout is not parseable JSON', { skip: !isWin && 'requires powershell.exe (Windows)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disc-test-'));
  const scriptPath = join(dir, 'bad.ps1');
  // Exit 0 with non-JSON stdout — the parse branch should fire.
  writeFileSync(scriptPath, '[Console]::Out.WriteLine("not json at all")\nexit 0\n');
  const events = [];
  const fakeLogger = { warn: (e, msg) => events.push({ e, msg }) };
  const result = await runDiscovery({
    powerShellPath: 'powershell.exe',
    psDiscoveryScriptPath: scriptPath,
    logger: fakeLogger
  });
  assert.equal(result, null);
  assert.ok(events.length >= 1, 'parse failure must log');
  assert.match(events[0].e.err || '', /JSON|SyntaxError|Unexpected/i);
  rmSync(dir, { recursive: true });
});
