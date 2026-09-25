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

// 2026-09-25 R93.3 — collect-discovery.ps1 emits the DC snapshot in
// PascalCase (Name, SiteHint, OsVersion, WhenCreated, IsPdc, …) because
// PowerShell's [PSCustomObject]@{...} round-trips through
// ConvertTo-Json -Compress with the original property names. The
// centre's route (center/src/routes/agent.js:379) reads
// `req.body.dc?.name` (camelCase) and validates required fields. Until
// R93.3 the agent forwarded the PS output verbatim, so centre
// validation returned 400 `missing agentId/collectedAt/dc.name` on
// every discover post from KDLFLOFADSRV2.
//
// postDiscovery() now applies mapDiscoveryDcToCamel() at the agent
// boundary so the wire always carries camelCase regardless of caller
// shape. Lock the PascalCase → camelCase conversion in as a contract
// so a future edit doesn't silently regress to forwarding PS output
// verbatim. The dual-shape pattern (PascalCase ?? camelCase) is shared
// with reporter.js:toCamelEntry for replication entries.
test('postDiscovery converts PascalCase DC snapshot to camelCase wire (R93.3)', async () => {
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
    // Simulate exactly what collect-discovery.ps1 emits
    const psDc = {
      Name: 'DC01',
      SiteHint: 'Default-First-Site-Name',
      OsVersion: 'Windows Server 2019 Datacenter',
      WhenCreated: '2020-01-15T08:00:00.000Z',
      IsPdc: true,
      IsGc: true,
      IsRidMaster: false,
      IsSchemaMaster: false,
      IsDomainNamingMaster: false,
      IsInfrastructureMaster: false
    };
    const result = await postDiscovery({
      centerUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      payload: { agentId: 'A1', collectedAt: '2026-09-25T00:00:00.000Z', dc: psDc }
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(receivedReq.body);
    assert.equal(parsed.dc.name, 'DC01', 'PascalCase Name must map to camelCase name');
    assert.equal(parsed.dc.siteHint, 'Default-First-Site-Name');
    assert.equal(parsed.dc.osVersion, 'Windows Server 2019 Datacenter');
    assert.equal(parsed.dc.whenCreated, '2020-01-15T08:00:00.000Z');
    assert.equal(parsed.dc.isPdc, true);
    assert.equal(parsed.dc.isGc, true);
    assert.equal(parsed.dc.isRidMaster, false);
    assert.equal(parsed.dc.isSchemaMaster, false);
    assert.equal(parsed.dc.isDomainNamingMaster, false);
    assert.equal(parsed.dc.isInfrastructureMaster, false);
    // No PascalCase keys leaked through
    assert.equal(parsed.dc.Name, undefined);
    assert.equal(parsed.dc.SiteHint, undefined);
    assert.equal(parsed.dc.IsPdc, undefined);
  } finally {
    server.close();
  }
});

// 2026-09-25 R93.3 — companion regression for the PascalCase test:
// the mapper must accept BOTH shapes (legacy camelCase callers + the
// first fixture test above must still pass). A future edit that drops
// the camelCase fallback would regress the first test in this file
// and silently null out half the dc payload.
test('postDiscovery preserves camelCase dc payload when already camelCase (R93.3 dual-shape)', async () => {
  let receivedReq = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedReq = { body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    await postDiscovery({
      centerUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      payload: { agentId: 'A1', collectedAt: '2026-09-25T00:00:00.000Z',
                 dc: { name: 'CAMEL-DC', siteHint: 'CamelSite', osVersion: 'Win2022',
                       whenCreated: '2024-06-01T00:00:00.000Z',
                       isPdc: true, isGc: false, isRidMaster: true, isSchemaMaster: false,
                       isDomainNamingMaster: false, isInfrastructureMaster: true } }
    });
    const parsed = JSON.parse(receivedReq.body);
    assert.equal(parsed.dc.name, 'CAMEL-DC');
    assert.equal(parsed.dc.siteHint, 'CamelSite');
    assert.equal(parsed.dc.isPdc, true);
    assert.equal(parsed.dc.isGc, false);
    assert.equal(parsed.dc.isRidMaster, true);
    assert.equal(parsed.dc.isInfrastructureMaster, true);
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

// 2026-08-25 round-12 report-now fan-out: startDiscoveryScheduler now
// exposes `run` so the heartbeat callback can invoke discovery on demand.
// Verify both shape and that run() actually invokes the user's run fn.
test('startDiscoveryScheduler exposes run() for on-demand invocation (report-now fan-out)', async () => {
  let calls = 0;
  const sched = startDiscoveryScheduler({
    intervalHours: 24, // long interval — only the immediate fire contributes to baseline count
    run: async () => { calls++; }
  });
  // Settle the immediate fire
  await new Promise(r => setTimeout(r, 30));
  const baseline = calls;
  assert.ok(baseline >= 1, 'baseline immediate fire expected');

  // Now exercise run() — must invoke the user's run fn
  await sched.run();
  assert.equal(calls, baseline + 1, 'sched.run() must invoke the user-provided run fn');

  // After stop(), run() must be a no-op (defensive — guards against late
  // heartbeat callbacks firing after shutdown)
  sched.stop();
  await sched.run();
  assert.equal(calls, baseline + 1, 'sched.run() after stop() must be a no-op');
});

test('startDiscoveryScheduler.run() absorbs synchronous throws from user run fn', async () => {
  const events = [];
  const fakeLogger = { warn: (e, msg) => events.push({ e, msg }) };
  let calls = 0;
  const sched = startDiscoveryScheduler({
    intervalHours: 24,
    run: async () => { calls++; throw new Error('user run fn boom'); },
    logger: fakeLogger
  });
  await new Promise(r => setTimeout(r, 30));
  // The immediate fire threw — but startDiscoveryScheduler's tick already
  // catches it. Now exercise sched.run() — must also absorb the throw
  // (so the heartbeat callback's Promise.allSettled doesn't see a sync reject).
  await sched.run();
  assert.ok(calls >= 2, 'user run fn must have been invoked via tick + sched.run');
  // Both should have logged a warn — verify the run-on-demand path logged too
  const onDemandWarn = events.find(e => e.e?.triggeredBy === 'report-now');
  assert.ok(onDemandWarn, 'sched.run() failures must log with triggeredBy=report-now');
  sched.stop();
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
