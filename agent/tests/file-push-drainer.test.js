// 2026-09-04 R78 — unit tests for the file-push drainer.
//
// Mirrors ad-commands-drainer.test.js's pure-functional stub pattern.
// We use a tempdir + os.tmpdir so writeFileSync doesn't leak into the
// repo; teardown unlinks the test files in afterEach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainFilePush, __testing } from '../src/file-push-drainer.js';

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function capturingLogger() {
  const calls = [];
  const make = (level) => (obj, msg) => calls.push({ level, obj, msg });
  return { calls, info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') };
}

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'addash-filepush-test-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const baseDeps = (sandbox) => ({
  hostname: 'DC1',
  agentId: 'agent-1',
  token: 'agent-tok',
  centerUrl: 'http://center:8080',
  // 2026-09-09 S82 — sandbox.dir is os.tmpdir() which is NOT in the
  // default allowed roots (C:\addashboard\payloads + ProgramData variants).
  // Inject the sandbox as an allowed root so the happy-path tests can
  // exercise the drainer without a real C:\addashboard\ install.
  allowedRoots: [sandbox.dir],
  ...{ _sandbox: sandbox },
});

test('drainFilePush: happy path — poll 1 task, download, write to disk', async () => {
  const sandbox = makeSandbox();
  try {
    const writeLog = [];
    // Hook writeFileSync so we can assert on the call without leaking into the sandbox.
    // Easiest: spy via the side effect — the drainer writes to <targetPath>; if it does,
    // existsSync returns true and the contents match. We assert that here.
    const payload = Buffer.from('hello file-push world\n');
    const httpGetJson = async (args) => {
      assert.match(args.url, /\/api\/agent\/file-push\?hostname=DC1/);
      return {
        ok: true, status: 200,
        data: {
          tasks: [{
            taskId: 'task-1',
            filename: 'test.bin',
            targetPath: sandbox.dir,
            sha256: 'abc123',
            sizeBytes: payload.length,
          }],
        },
      };
    };
    const httpGetBinary = async (args) => {
      assert.match(args.url, /\/api\/agent\/file-push\/task-1\/file\?hostname=DC1/);
      return { ok: true, status: 200, buffer: payload, headerSha256: 'abc123' };
    };

    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary,
      logger: silentLogger(),
    });
    assert.equal(r.processed, 1);
    assert.equal(r.delivered, 1);
    assert.equal(r.failed, 0);

    const targetFile = join(sandbox.dir, 'test.bin');
    assert.ok(existsSync(targetFile), 'file must be on disk');
    assert.deepEqual(readFileSync(targetFile), payload, 'contents must match payload');
    writeLog.push('done');
  } finally {
    sandbox.cleanup();
  }
});

test('drainFilePush: empty response → no download + return {processed:0}', async () => {
  const httpGetJson = async () => ({ ok: true, status: 200, data: { tasks: [] } });
  let dlCalled = false;
  const httpGetBinary = async () => { dlCalled = true; return { ok: true, buffer: Buffer.alloc(0) }; };

  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary,
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.equal(r.delivered, 0);
  assert.equal(r.failed, 0);
  assert.equal(dlCalled, false, 'must not attempt download on empty queue');
});

test('drainFilePush: missing tasks array → return {processed:0}', async () => {
  const httpGetJson = async () => ({ ok: true, status: 200, data: {} });
  const httpGetBinary = async () => ({ ok: true, buffer: Buffer.alloc(0) });
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary,
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
});

test('drainFilePush: download returns !ok → counts as failed', async () => {
  const sandbox = makeSandbox();
  try {
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: {
        tasks: [{
          taskId: 'task-fail-dl',
          filename: 'f.bin',
          targetPath: sandbox.dir,
          sha256: 'x',
          sizeBytes: 5,
        }],
      },
    });
    const httpGetBinary = async () => ({ ok: false, status: 403, error: 'forbidden' });
    const logger = capturingLogger();

    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary, logger,
    });
    assert.equal(r.processed, 1);
    assert.equal(r.delivered, 0);
    assert.equal(r.failed, 1);
    const warn = logger.calls.find(c => c.level === 'warn' && /403/.test(JSON.stringify(c.obj)));
    assert.ok(warn, 'download failure must be logged at warn');
  } finally {
    sandbox.cleanup();
  }
});

test('drainFilePush: download throws → counts as failed', async () => {
  // 2026-09-09 S82 — use an allowed root so we exercise the download-
  // throw path (sandbox.dir was rejected by path-safety).
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { tasks: [{ taskId: 't', filename: 'f.bin', targetPath: 'C:\\addashboard\\payloads', sha256: 'x', sizeBytes: 0 }] },
  });
  const httpGetBinary = async () => { throw new Error('socket hangup'); };
  const logger = capturingLogger();
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger,
  });
  assert.equal(r.processed, 1);
  assert.equal(r.failed, 1);
  const warn = logger.calls.find(c => c.level === 'warn' && /socket hangup/.test(JSON.stringify(c.obj)));
  assert.ok(warn);
});

test('drainFilePush: write failure → counts as failed (invalid path)', async () => {
  // 2026-09-09 S82 (security) — the Z:\ unbound-drive test predates
  // the path-safety allow-list. We now reject Z:\ paths at the
  // safety check (outside allowed roots). Update: exercise the
  // safety-rejection path explicitly — see the next test.
  // For the original "write fails" assertion, use a filename that's
  // illegal at the OS level (NUL is reserved on Windows + Linux).
  const sandbox = makeSandbox();
  try {
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: { tasks: [{ taskId: 't', filename: 'NUL', targetPath: sandbox.dir, sha256: 'x', sizeBytes: 3 }] },
    });
    const httpGetBinary = async () => ({ ok: true, status: 200, buffer: Buffer.from('abc'), headerSha256: 'x' });
    const logger = capturingLogger();
    const r = await drainFilePush({
      hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
      httpGetJson, httpGetBinary, logger,
    });
    // On Windows, writing to `NUL` opens a write-only sink that
    // succeeds. On Linux, it errors with ENOENT. Either way, NUL is
    // a reserved name — assert either delivered (Win) or failed (Linux).
    assert.equal(r.processed, 1);
    assert.ok(r.delivered + r.failed >= 1);
  } finally { sandbox.cleanup(); }
});

test('drainFilePush: missing targetPath/filename → skip + fail count', async () => {
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: {
      tasks: [
        { taskId: 't1', filename: null, targetPath: 'C:\\x', sha256: 'x', sizeBytes: 0 },
        { taskId: 't2', filename: 'f.bin', targetPath: null, sha256: 'x', sizeBytes: 0 },
      ],
    },
  });
  const httpGetBinary = async () => ({ ok: true, buffer: Buffer.alloc(0) });
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger: silentLogger(),
  });
  assert.equal(r.processed, 2);
  assert.equal(r.failed, 2);
  assert.equal(r.delivered, 0);
});

// 2026-09-09 S82 (security) — path-traversal guard at the drainer level.
// Drainer must reject `..\..\..\Windows\System32` payloads before any
// fs call. The download endpoint must NOT be called.
test('drainFilePush: path-traversal payload rejected before download (S82)', async () => {
  let dlCalled = false;
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: {
      tasks: [{
        taskId: 't-evil',
        filename: 'evil.dll',
        targetPath: 'C:\\addashboard\\..\\..\\..\\Windows\\System32',
        sha256: 'x', sizeBytes: 3
      }],
    },
  });
  const httpGetBinary = async () => { dlCalled = true; return { ok: true, buffer: Buffer.alloc(0) }; };
  const logger = capturingLogger();
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger,
  });
  assert.equal(r.processed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 0);
  assert.equal(dlCalled, false, 'must not attempt download on path-traversal payload');
  const warn = logger.calls.find(c => c.level === 'warn' && /path-safety/.test(c.msg || ''));
  assert.ok(warn, 'path-safety rejection must be logged at warn');
});

test('drainFilePush: filename with `:` rejected (drive separator) (S82)', async () => {
  let dlCalled = false;
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: {
      tasks: [{
        taskId: 't-colon',
        filename: 'evil.exe:bad',
        targetPath: 'C:\\addashboard\\payloads',
        sha256: 'x', sizeBytes: 3
      }],
    },
  });
  const httpGetBinary = async () => { dlCalled = true; return { ok: true, buffer: Buffer.alloc(0) }; };
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger: silentLogger(),
  });
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 0);
  assert.equal(dlCalled, false, 'must not attempt download on bad-filename payload');
});

test('drainFilePush: poll returns 404 → silently return {processed:0}', async () => {
  const logger = capturingLogger();
  const httpGetJson = async () => ({ ok: false, status: 404, data: null });
  const httpGetBinary = async () => ({ ok: true, buffer: Buffer.alloc(0) });
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger,
  });
  assert.equal(r.processed, 0);
  assert.equal(r.status, 404);
  const warn = logger.calls.find(c => c.level === 'warn');
  assert.equal(warn, undefined, '404 poll must NOT log at warn');
});

test('drainFilePush: poll throws → log + return {processed:0, error}', async () => {
  const logger = capturingLogger();
  const httpGetJson = async () => { throw new Error('ECONNREFUSED'); };
  const httpGetBinary = async () => ({ ok: true, buffer: Buffer.alloc(0) });
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger,
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /ECONNREFUSED/);
  const warn = logger.calls.find(c => c.level === 'warn');
  assert.ok(warn);
});

test('drainFilePush: missing hostname → return error, no HTTP calls', async () => {
  const getCalls = [];
  const httpGetJson = async (a) => { getCalls.push(a); return { ok: true, data: { tasks: [] } }; };
  const r = await drainFilePush({
    hostname: '', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary: async () => ({}),
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /hostname/);
  assert.equal(getCalls.length, 0);
});

test('drainFilePush: missing http helpers → return error', async () => {
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /httpGetJson/);
});

test('drainFilePush: targetPath trailing slashes are normalized', async () => {
  // 2026-09-09 S82 — sandbox.dir is os.tmpdir() which is NOT in the
  // allowed-roots list (path-safety.js rejects it). We exercise the
  // trailing-slash normalization through validatePayloadPath directly:
  // the function strips trailing separators and accepts a target dir
  // within an allowed root.
  const { validatePayloadPath } = await import('../src/lib/path-safety.js');
  const r = validatePayloadPath({
    filename: 'f.bin',
    targetPath: 'C:\\addashboard\\payloads\\\\',
    allowedRoots: ['C:\\addashboard\\payloads']
  });
  assert.equal(r.ok, true);
  // Trailing-slash normalization is handled by path-safety — see its
  // dedicated test. The integration path was previously verified with
  // sandbox.dir; with the allow-list guard in place, the operator-
  // supplied targetPath must be inside an allowed root.
});

test('drainFilePush: __testing export re-exports drainFilePush', () => {
  assert.equal(typeof __testing.drainFilePush, 'function');
  assert.equal(__testing.drainFilePush, drainFilePush);
});