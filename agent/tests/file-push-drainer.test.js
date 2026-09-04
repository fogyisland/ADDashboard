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
  // Use the sandbox dir as the write target; the drainer joins task.targetPath with task.filename.
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
  const sandbox = makeSandbox();
  try {
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: { tasks: [{ taskId: 't', filename: 'f', targetPath: sandbox.dir, sha256: 'x', sizeBytes: 0 }] },
    });
    const httpGetBinary = async () => { throw new Error('socket hangup'); };
    const logger = capturingLogger();
    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary, logger,
    });
    assert.equal(r.processed, 1);
    assert.equal(r.failed, 1);
    const warn = logger.calls.find(c => c.level === 'warn' && /socket hangup/.test(JSON.stringify(c.obj)));
    assert.ok(warn);
  } finally {
    sandbox.cleanup();
  }
});

test('drainFilePush: write failure → counts as failed (invalid path)', async () => {
  // Drive letter Z is unbound on virtually every machine (Windows
  // allows Z: to be a substitute drive; it's almost never used).
  // mkdirSync on Z:\\anything throws ENOENT even with {recursive:true}
  // because the root volume itself doesn't exist.
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { tasks: [{ taskId: 't', filename: 'f.bin', targetPath: 'Z:\\no\\such\\path', sha256: 'x', sizeBytes: 3 }] },
  });
  const httpGetBinary = async () => ({ ok: true, status: 200, buffer: Buffer.from('abc'), headerSha256: 'x' });
  const logger = capturingLogger();
  const r = await drainFilePush({
    hostname: 'X', agentId: 'a', token: 't', centerUrl: 'http://x',
    httpGetJson, httpGetBinary, logger,
  });
  assert.equal(r.processed, 1);
  assert.equal(r.failed, 1, 'write to nonexistent Z:\\ path must count as failed');
  assert.equal(r.delivered, 0);
  const warn = logger.calls.find(c => c.level === 'warn' && /write failed/.test(c.msg || ''));
  assert.ok(warn, 'write failure must be logged at warn');
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
  const sandbox = makeSandbox();
  try {
    const payload = Buffer.from('hi\n');
    const httpGetJson = async () => ({
      ok: true, status: 200,
      data: { tasks: [{
        taskId: 't-slash', filename: 'f.bin',
        // Trailing slash — drainer should strip it before joining.
        targetPath: sandbox.dir + '\\\\',
        sha256: 'x', sizeBytes: payload.length,
      }] },
    });
    const httpGetBinary = async () => ({ ok: true, status: 200, buffer: payload, headerSha256: 'x' });
    const r = await drainFilePush({
      ...baseDeps(sandbox),
      httpGetJson, httpGetBinary,
      logger: silentLogger(),
    });
    assert.equal(r.delivered, 1);
    const f = join(sandbox.dir, 'f.bin');
    assert.ok(existsSync(f), 'file must be at sandbox/f.bin (not sandbox\\\\f.bin)');
  } finally {
    sandbox.cleanup();
  }
});

test('drainFilePush: __testing export re-exports drainFilePush', () => {
  assert.equal(typeof __testing.drainFilePush, 'function');
  assert.equal(__testing.drainFilePush, drainFilePush);
});