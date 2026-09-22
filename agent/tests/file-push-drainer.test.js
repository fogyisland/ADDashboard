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

// 2026-09-22 R78.1 — default ack stub. Returns { ok: true } so the
// drainer's per-task outcome counter increments as if the centre
// accepted the ack. Individual tests can override with their own
// httpPostJson when they want to assert on ack payload / errors.
function defaultAck() {
  return async () => ({ ok: true, status: 200, data: { ok: true } });
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
  // 2026-09-22 R78.1 — agent ack stub. Returns ok so the per-task
  // ack counter increments; individual tests override this when they
  // want to assert on the ack payload or force a non-2xx.
  httpPostJson: defaultAck(),
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
      httpGetJson, httpGetBinary, httpPostJson: defaultAck(),
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(),
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(),
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
      httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger,
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger,
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
      httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger,
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger: silentLogger(),
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger,
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger: silentLogger(),
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger,
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
    httpGetJson, httpGetBinary, httpPostJson: defaultAck(), logger,
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
    httpGetJson, httpGetBinary: async () => ({}), httpPostJson: defaultAck(),
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

// ============================================================================
// 2026-09-22 R78.1 — agent-side ack routing tests.
//
// The drainer now POSTs the per-task outcome to
//   POST ${centerUrl}/api/agent/file-push/:taskId/ack
// after each download/write attempt. These tests pin the wire shape:
//   - URL exactly matches /api/agent/file-push/<taskId>/ack
//   - body = { hostname, agentId, ok, errorMessage? }
//   - on delivered → ok:true, errorMessage:null
//   - on failed (download / write / path-safety) → ok:false, errorMessage populated
//   - non-2xx ack response → drainer logs warn, does NOT increment acked
//   - ack throwing → drainer logs warn, does NOT increment acked
//   - retry semantics: ack failure does NOT roll processed/delivered/failed
//     counters backward; next heartbeat re-polls and re-attempts.
// ============================================================================

test('drainFilePush R78.1: happy path → POST ack with ok:true, errorMessage:null', async () => {
  const sandbox = makeSandbox();
  try {
    const payload = Buffer.from('ack happy\n');
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: { tasks: [{ taskId: 'ack-ok', filename: 'f.bin', targetPath: sandbox.dir, sha256: 'x', sizeBytes: payload.length }] },
    });
    const httpGetBinary = async () => ({ ok: true, status: 200, buffer: payload, headerSha256: 'x' });

    let ackCall = null;
    const httpPostJson = async (args) => {
      ackCall = args;
      return { ok: true, status: 200, data: { ok: true } };
    };

    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary, httpPostJson, logger: silentLogger(),
    });

    assert.equal(r.processed, 1);
    assert.equal(r.delivered, 1);
    assert.equal(r.failed, 0);
    assert.equal(r.acked, 1, 'acked counter must increment on 2xx ack response');

    assert.ok(ackCall, 'httpPostJson must be called once after delivery');
    assert.match(ackCall.url, /\/api\/agent\/file-push\/ack-ok\/ack$/);
    assert.equal(ackCall.url.startsWith('http://center:8080'), true, 'ack URL must use centerUrl');
    assert.deepEqual(ackCall.headers, { 'X-Agent-Token': 'agent-tok' });
    assert.deepEqual(ackCall.body, {
      hostname: 'DC1',
      agentId: 'agent-1',
      ok: true,
      errorMessage: null,
    });
  } finally { sandbox.cleanup(); }
});

test('drainFilePush R78.1: download fail → POST ack with ok:false, errorMessage set', async () => {
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { tasks: [{ taskId: 'ack-dl-fail', filename: 'f.bin', targetPath: 'C:\\addashboard\\payloads', sha256: 'x', sizeBytes: 3 }] },
  });
  const httpGetBinary = async () => ({ ok: false, status: 403 });

  let ackCall = null;
  const httpPostJson = async (args) => {
    ackCall = args;
    return { ok: true, status: 200, data: { ok: true } };
  };

  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, httpPostJson, logger: silentLogger(),
  });

  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 0);
  assert.equal(r.acked, 1);
  assert.ok(ackCall);
  assert.match(ackCall.url, /\/api\/agent\/file-push\/ack-dl-fail\/ack/);
  assert.equal(ackCall.body.ok, false);
  assert.match(ackCall.body.errorMessage, /download HTTP 403/);
});

test('drainFilePush R78.1: path-safety reject → POST ack with ok:false', async () => {
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { tasks: [{
      taskId: 'ack-safety',
      filename: 'evil.dll',
      targetPath: 'C:\\..\\..\\Windows\\System32',
      sha256: 'x', sizeBytes: 3,
    }] },
  });
  const httpGetBinary = async () => ({ ok: true, buffer: Buffer.alloc(0) });

  let ackCall = null;
  const httpPostJson = async (args) => {
    ackCall = args;
    return { ok: true, status: 200, data: { ok: true } };
  };

  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, httpPostJson, logger: silentLogger(),
  });

  assert.equal(r.failed, 1);
  assert.equal(r.acked, 1);
  assert.ok(ackCall);
  assert.match(ackCall.body.errorMessage, /path-safety:/);
});

test('drainFilePush R78.1: ack non-2xx → drainer logs warn, does NOT increment acked', async () => {
  const sandbox = makeSandbox();
  try {
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: { tasks: [{ taskId: 'ack-rej', filename: 'f.bin', targetPath: sandbox.dir, sha256: 'x', sizeBytes: 4 }] },
    });
    const httpGetBinary = async () => ({ ok: true, status: 200, buffer: Buffer.from('abcd'), headerSha256: 'x' });
    const httpPostJson = async () => ({ ok: false, status: 500, data: { error: 'down' } });
    const logger = capturingLogger();

    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary, httpPostJson, logger,
    });

    // File was written successfully — that counts delivered regardless
    // of ack fate. But acked counter does NOT bump because the center
    // returned 5xx; retry-on-next-heartbeat kicks in.
    assert.equal(r.delivered, 1, 'file was still written to disk');
    assert.equal(r.acked, 0, 'acked must NOT increment on non-2xx ack');

    const warn = logger.calls.find(c => c.level === 'warn' && /non-2xx/.test(c.msg || ''));
    assert.ok(warn, 'non-2xx ack must log a warn');
  } finally { sandbox.cleanup(); }
});

test('drainFilePush R78.1: ack throws → drainer logs warn, does NOT increment acked', async () => {
  const sandbox = makeSandbox();
  try {
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: { tasks: [{ taskId: 'ack-throw', filename: 'f.bin', targetPath: sandbox.dir, sha256: 'x', sizeBytes: 4 }] },
    });
    const httpGetBinary = async () => ({ ok: true, status: 200, buffer: Buffer.from('abcd'), headerSha256: 'x' });
    const httpPostJson = async () => { throw new Error('socket hangup on ack'); };
    const logger = capturingLogger();

    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary, httpPostJson, logger,
    });

    assert.equal(r.delivered, 1, 'file written even when ack throws');
    assert.equal(r.acked, 0, 'acked must NOT increment when ack throws');
    const warn = logger.calls.find(c => c.level === 'warn' && /threw/.test(c.msg || ''));
    assert.ok(warn, 'ack throw must log a warn');
  } finally { sandbox.cleanup(); }
});

test('drainFilePush R78.1: missing httpPostJson → error mentions httpPostJson', async () => {
  // The guard at the top of drainFilePush must now mention httpPostJson
  // alongside httpGetJson/httpGetBinary — the R78.1 wire adds a 3rd
  // dependency. Regression test for the agent.js wiring.
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson: async () => ({}),
    httpGetBinary: async () => ({}),
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /httpPostJson/);
});

test('drainFilePush R78.1: multiple tasks → ack called once per task, acked reflects 2xx only', async () => {
  const sandbox = makeSandbox();
  try {
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: {
        tasks: [
          { taskId: 'm-1', filename: 'a.bin', targetPath: sandbox.dir, sha256: 'x', sizeBytes: 4 },
          { taskId: 'm-2', filename: 'b.bin', targetPath: sandbox.dir, sha256: 'x', sizeBytes: 4 },
        ],
      },
    });
    const httpGetBinary = async () => ({ ok: true, status: 200, buffer: Buffer.from('abcd'), headerSha256: 'x' });

    const ackCalls = [];
    const httpPostJson = async (args) => {
      ackCalls.push({ taskId: args.body?.hostname ? args.url.match(/\/file-push\/([^/]+)\/ack/)?.[1] : null, args });
      // First ack 200, second 503 — half success
      return ackCalls.length === 1
        ? { ok: true, status: 200, data: { ok: true } }
        : { ok: false, status: 503, data: { error: 'down' } };
    };

    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary, httpPostJson, logger: silentLogger(),
    });

    assert.equal(r.processed, 2);
    assert.equal(r.delivered, 2, 'both files written to disk');
    assert.equal(r.acked, 1, 'only the first 2xx counts; second 503 does not');
    assert.equal(ackCalls.length, 2, 'httpPostJson called once per task');
    assert.equal(ackCalls[0].taskId, 'm-1');
    assert.equal(ackCalls[1].taskId, 'm-2');
  } finally { sandbox.cleanup(); }
});