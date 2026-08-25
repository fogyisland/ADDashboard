import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { PackageManager } from '../src/package-manager.js';

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeFetchStub(routes) {
  // routes: { 'GET /api/agent/packages': handler, ... }
  // The PackageManager calls _fetchJson({ method, url, headers, body, timeoutMs }) —
  // config object shape, not fetch()'s (url, opts) shape.
  return (config) => {
    const key = `${config.method || 'GET'} ${new URL(config.url).pathname}`;
    const h = routes[key];
    if (!h) return Promise.resolve({ ok: false, status: 404, data: null, error: 'no stub' });
    return Promise.resolve(h());
  };
}

// Use the same requestJson-style pattern as the real reporter: returns
// { ok, status, data }. We stub requestJson by injecting a fetchJson factory
// into the PackageManager.

test('PackageManager.syncFromCenter writes manifest, script, current.json; removes stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    // Seed a stale local package "old" that should be removed
    const staleDir = join(dir, 'packages', 'old-pkg', '1.0.0');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'manifest.json'), '{}');
    writeFileSync(join(staleDir, 'collect.ps1'), 'old');
    writeFileSync(join(dir, 'packages', 'old-pkg', 'current.json'), JSON.stringify({ version: '1.0.0' }));

    const fetchJson = makeFetchStub({
      'GET /api/agent/packages': () => ({
        ok: true, status: 200, data: {
          packages: [{
            name: 'new-pkg',
            version: '2.0.0',
            manifest: { name: 'new-pkg', version: '2.0.0', agent: { intervalSec: 60, timeoutMs: 10000 } },
            script: Buffer.from('Write-Output "hi"').toString('base64'),
            params: { foo: 'bar' }
          }]
        }
      })
    });

    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger(),
      fetchJson
    });
    await pm.syncFromCenter();

    // New package files written
    const newDir = join(dir, 'packages', 'new-pkg', '2.0.0');
    assert.ok(existsSync(join(newDir, 'manifest.json')));
    assert.ok(existsSync(join(newDir, 'collect.ps1')));
    assert.equal(readFileSync(join(newDir, 'collect.ps1'), 'utf8'), 'Write-Output "hi"');
    const manifest = JSON.parse(readFileSync(join(newDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, 'new-pkg');
    assert.equal(manifest.agent.intervalSec, 60);

    // current.json pointer
    const current = JSON.parse(readFileSync(join(dir, 'packages', 'new-pkg', 'current.json'), 'utf8'));
    assert.equal(current.version, '2.0.0');

    // Stale package removed
    assert.ok(!existsSync(join(dir, 'packages', 'old-pkg')), 'stale package should be removed');

    // listLocal returns just the new package
    const local = pm.listLocal();
    assert.deepEqual(local.sort(), ['new-pkg']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.flushReportQueue POSTs batch to /api/agent/packages/report and clears on success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"processed":2,"errors":[]}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    // Inject a batch
    pm.reportBatch.push(
      { packageName: 'p1', exitCode: 0, metrics: { m: 1 }, error: null },
      { packageName: 'p2', exitCode: 0, metrics: { m: 2 }, error: null }
    );
    await pm.flushReportQueue();
    assert.equal(receivedBody.runs.length, 2);
    assert.equal(pm.reportBatch.length, 0);
    assert.equal(pm.queue.length, 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.flushReportQueue on HTTP failure persists to report-queue.json capped at 1000', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  const server = http.createServer((req, res) => {
    res.writeHead(503); res.end('upstream down');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    // Pre-fill queue with 999 fake items
    for (let i = 0; i < 999; i++) pm.queue.push({ packageName: `old${i}`, exitCode: 0 });
    // Now add a fresh batch of 5
    for (let i = 0; i < 5; i++) pm.reportBatch.push({ packageName: `new${i}`, exitCode: 0 });
    await pm.flushReportQueue();
    // 999 + 5 = 1004, capped to last 1000
    const persisted = JSON.parse(readFileSync(join(dir, 'report-queue.json'), 'utf8'));
    assert.equal(persisted.length, 1000);
    // The 5 newest should be the tail
    assert.equal(persisted[999].packageName, 'new4');
    // The oldest 4 should have been dropped
    assert.equal(persisted[0].packageName, 'old4');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.runOne spawns runner and adds result to reportBatch; flushes when >= 10', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  let postCalled = 0;
  const server = http.createServer((req, res) => {
    postCalled++;
    res.writeHead(200); res.end('{"processed":1,"errors":[]}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: `http://127.0.0.1:${port}`,
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    // Build a pkg with the script already on disk
    const ver = '1.0.0';
    const pkgDir = join(dir, 'packages', 'demo', ver);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'collect.ps1'), 'echo hi');
    writeFileSync(join(pkgDir, 'manifest.json'), '{}');
    mkdirSync(join(dir, 'packages', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'demo', 'current.json'), JSON.stringify({ version: ver }));

    const pkg = {
      name: 'demo', version: ver,
      manifest: { name: 'demo', version: ver, agent: { intervalSec: 60, timeoutMs: 5000 } },
      script: Buffer.from('echo hi').toString('base64'),
      params: {}
    };
    // Stub runner to avoid real spawn
    pm._runPackageScript = async () => ({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      metrics: { m: 1 },
      error: null
    });
    // Fill batch to 9, then runOne should trigger flush
    for (let i = 0; i < 9; i++) pm.reportBatch.push({ packageName: `pre${i}` });
    await pm.runOne(pkg);
    assert.ok(pm.reportBatch.length <= 10, 'batch should have been flushed when >= 10');
    assert.equal(postCalled, 1, 'flush should have POSTed to center');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.reschedule sets one timer per package, replaces existing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    const pkgs = [
      { name: 'a', version: '1', manifest: { agent: { intervalSec: 60 } } },
      { name: 'b', version: '1', manifest: { agent: { intervalSec: 120 } } }
    ];
    pm.reschedule(pkgs);
    assert.equal(pm.tasks.size, 2);
    const ta = pm.tasks.get('a');
    const tb = pm.tasks.get('b');
    assert.ok(ta, 'timer a exists');
    assert.ok(tb, 'timer b exists');
    assert.equal(ta.intervalMs, 60_000);
    assert.equal(tb.intervalMs, 120_000);
    // Reschedule with a different set — old timers should be cleared
    pm.reschedule([pkgs[0]]);
    assert.equal(pm.tasks.size, 1);
    assert.ok(pm.tasks.has('a'));
    assert.ok(!pm.tasks.has('b'));
    // cleanup
    for (const t of pm.tasks.values()) clearInterval(t.timer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager removes cache and timer when package no longer enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    const fetchJson = makeFetchStub({
      'GET /api/agent/packages': () => ({ ok: true, status: 200, data: { packages: [] } })
    });
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger(),
      fetchJson
    });
    // Seed a local package
    const pkgDir = join(dir, 'packages', 'gone', '1.0.0');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'manifest.json'), '{}');
    writeFileSync(join(pkgDir, 'collect.ps1'), 'x');
    writeFileSync(join(dir, 'packages', 'gone', 'current.json'), JSON.stringify({ version: '1.0.0' }));
    // Pre-seed a timer
    pm.tasks.set('gone', { timer: setInterval(() => {}, 1000), intervalMs: 1000 });
    await pm.syncFromCenter();
    assert.ok(!existsSync(join(dir, 'packages', 'gone')));
    assert.ok(!pm.tasks.has('gone'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2026-08-25 round-12 report-now fan-out: PackageManager.runAllNow() must
// re-run every synced package in parallel when the operator clicks 回报.
// Each package is independent; a failure in one does NOT block the others.
// ============================================================================

test('PackageManager.runAllNow fans out to every synced package in parallel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    // Two packages — a + b
    for (const name of ['a', 'b']) {
      const pkgDir = join(dir, 'packages', name, '1.0.0');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'manifest.json'), '{}');
      writeFileSync(join(pkgDir, 'collect.ps1'), 'echo ' + name);
      writeFileSync(join(dir, 'packages', name, 'current.json'), JSON.stringify({ version: '1.0.0' }));
    }

    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    // Simulate a prior sync (sets pm.packages)
    pm.packages = [
      { name: 'a', version: '1.0.0', manifest: { name: 'a', version: '1.0.0', agent: { intervalSec: 60, timeoutMs: 5000 } } },
      { name: 'b', version: '1.0.0', manifest: { name: 'b', version: '1.0.0', agent: { intervalSec: 60, timeoutMs: 5000 } } }
    ];
    // Track parallel entry: both packages must be in-flight simultaneously.
    let inFlight = 0;
    let maxInFlight = 0;
    let aEntered = false;
    let bEntered = false;
    const releases = [];
    pm._runPackageScript = async ({ scriptPath }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (scriptPath.includes('\\a\\')) aEntered = true;
      if (scriptPath.includes('\\b\\')) bEntered = true;
      await new Promise(r => releases.push(r));
      inFlight--;
      return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, metrics: { ok: true }, error: null };
    };

    const p = pm.runAllNow({ triggeredBy: 'report-now' });
    // Let both packages enter their first await
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(maxInFlight, 2, 'both packages must be in-flight at the same time');
    assert.ok(aEntered && bEntered, 'both packages must have entered runOne');

    // Release both
    releases.forEach(r => r());
    const r = await p;
    assert.equal(r.count, 2);
    assert.equal(r.results.length, 2);
    assert.ok(r.results.every(x => x.status === 'fulfilled'), 'both packages must fulfill');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.runAllNow no-ops cleanly when no packages are installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    // No sync done → pm.packages is []
    const r = await pm.runAllNow();
    assert.equal(r.count, 0);
    assert.deepEqual(r.results, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.runAllNow absorbs per-package rejections (other packages still run)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    for (const name of ['good', 'bad']) {
      const pkgDir = join(dir, 'packages', name, '1.0.0');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'manifest.json'), '{}');
      writeFileSync(join(pkgDir, 'collect.ps1'), 'echo ' + name);
      writeFileSync(join(dir, 'packages', name, 'current.json'), JSON.stringify({ version: '1.0.0' }));
    }
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: fakeLogger()
    });
    pm.packages = [
      { name: 'good', version: '1.0.0', manifest: { name: 'good', version: '1.0.0', agent: { intervalSec: 60, timeoutMs: 5000 } } },
      { name: 'bad',  version: '1.0.0', manifest: { name: 'bad',  version: '1.0.0', agent: { intervalSec: 60, timeoutMs: 5000 } } }
    ];
    let goodCalled = 0;
    let badCalled = 0;
    pm._runPackageScript = async ({ scriptPath }) => {
      if (scriptPath.includes('\\good\\')) {
        goodCalled++;
        return { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, metrics: {}, error: null };
      }
      badCalled++;
      throw new Error('script crashed');
    };

    const r = await pm.runAllNow();
    assert.equal(goodCalled, 1, 'good package must run despite bad package failing');
    assert.equal(badCalled, 1, 'bad package must attempt to run');
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].status, 'fulfilled', 'good package must fulfill');
    assert.equal(r.results[1].status, 'rejected', 'bad package must reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PackageManager.runAllNow tags per-run logs with triggeredBy=report-now', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-mgr-'));
  try {
    const pkgDir = join(dir, 'packages', 'tagged', '1.0.0');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'manifest.json'), '{}');
    writeFileSync(join(pkgDir, 'collect.ps1'), 'echo tagged');
    writeFileSync(join(dir, 'packages', 'tagged', 'current.json'), JSON.stringify({ version: '1.0.0' }));

    const logCalls = [];
    const capturingLogger = {
      info: (obj, msg) => logCalls.push({ obj, msg }),
      warn: () => {}, error: () => {}, debug: () => {}
    };
    const pm = new PackageManager({
      agentId: 'A1',
      agentVersion: '0.1.0',
      centerBaseUrl: 'http://unused',
      agentToken: 'tok',
      dataDir: dir,
      logger: capturingLogger
    });
    pm.packages = [{ name: 'tagged', version: '1.0.0', manifest: { name: 'tagged', version: '1.0.0', agent: { intervalSec: 60, timeoutMs: 5000 } } }];
    pm._runPackageScript = async () => ({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, metrics: {}, error: null });

    await pm.runAllNow({ triggeredBy: 'report-now' });

    const runLog = logCalls.find(c => c.obj?.event === 'package.run');
    assert.ok(runLog, 'must log per-run event');
    assert.equal(runLog.obj.triggeredBy, 'report-now', 'per-run log must carry the triggeredBy tag');
    const fanOutLog = logCalls.find(c => c.obj?.event === 'package.runAllNow');
    assert.ok(fanOutLog, 'must log fan-out event');
    assert.equal(fanOutLog.obj.triggeredBy, 'report-now');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
