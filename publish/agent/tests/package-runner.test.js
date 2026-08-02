import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runPackageScript } from '../src/package-runner.js';

// Minimal hand-built ChildProcess. The runner reads from .stdout/.stderr
// (EventEmitter 'data' events) and writes to .stdin (synchronous string
// capture). We never spawn a real process — these tests run on Linux CI.
function fakeChild() {
  const child = new EventEmitter();
  const stdinChunks = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(chunk) { stdinChunks.push(String(chunk)); return true; },
    end() { /* no-op */ }
  };
  child._stdinChunks = stdinChunks;
  child.kill = (sig) => { child._killedWith = sig; };
  return child;
}

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeSpawn(behavior) {
  return (_cmd, _args) => {
    const child = fakeChild();
    // Defer to next microtask so the runner can attach its listeners first.
    queueMicrotask(() => behavior(child));
    return child;
  };
}

test('runPackageScript: success — parses last non-empty stdout line as JSON metrics', async () => {
  const spawnFn = makeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('noise from PS1\n'));
    child.stdout.emit('data', Buffer.from('{"metrics":{"m1":42,"m2":"x"}}\n'));
    child.emit('exit', 0);
  });
  const r = await runPackageScript({
    scriptPath: '/tmp/whatever.ps1',
    params: { a: 1 },
    timeoutMs: 5000,
    logger: fakeLogger(),
    spawnFn
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.error, null);
  assert.deepEqual(r.metrics, { m1: 42, m2: 'x' });
  assert.ok(r.startedAt && r.finishedAt);
});

test('runPackageScript: invalid JSON on stdout — error is set, metrics null', async () => {
  const spawnFn = makeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('not json at all\n'));
    child.emit('exit', 0);
  });
  const r = await runPackageScript({
    scriptPath: '/tmp/whatever.ps1',
    params: {},
    timeoutMs: 5000,
    logger: fakeLogger(),
    spawnFn
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.metrics, null);
  assert.ok(r.error && r.error.includes('not json'), `expected parse error, got: ${r.error}`);
});

test('runPackageScript: spawn ENOENT — error contains spawn message', async () => {
  const spawnFn = makeSpawn((child) => {
    child.emit('error', new Error('spawn powershell.exe ENOENT'));
  });
  const r = await runPackageScript({
    scriptPath: '/tmp/whatever.ps1',
    params: {},
    timeoutMs: 5000,
    logger: fakeLogger(),
    spawnFn
  });
  assert.equal(r.exitCode, -1);
  assert.equal(r.metrics, null);
  assert.ok(r.error.includes('ENOENT'), `expected ENOENT in error, got: ${r.error}`);
});

test('runPackageScript: timeout — kill called with SIGKILL and error reported', async () => {
  const spawnFn = makeSpawn((child) => {
    // Track kill without emitting 'exit'. Unref so the timer doesn't keep the
    // event loop alive past the test (otherwise the suite hangs at 30s).
    setTimeout(() => { /* never */ }, 60_000).unref();
    child.kill = (sig) => { child._killedWith = sig; };
  });
  const start = Date.now();
  const r = await runPackageScript({
    scriptPath: '/tmp/whatever.ps1',
    params: {},
    timeoutMs: 50,
    logger: fakeLogger(),
    spawnFn
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `should resolve soon after timeout, took ${elapsed}ms`);
  assert.ok(r.error && r.error.includes('timeout'), `expected timeout error, got: ${r.error}`);
  assert.equal(r.metrics, null);
});

test('runPackageScript: pipes {name,params} JSON to stdin', async () => {
  // The spawnFn runs synchronously; we wrap the returned child's stdin BEFORE
  // the runner can call write on it. Then we drive the child via the wrapper
  // closure after the runner has finished.
  let capturedStdin = '';
  const spawnFn = () => {
    const child = fakeChild();
    const origWrite = child.stdin.write;
    child.stdin.write = (chunk) => { capturedStdin += String(chunk); return origWrite(chunk); };
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('{"metrics":{}}\n'));
      child.emit('exit', 0);
    });
    return child;
  };
  await runPackageScript({
    scriptPath: '/tmp/whatever.ps1',
    params: { x: 7, y: 'z' },
    timeoutMs: 5000,
    logger: fakeLogger(),
    spawnFn
  });
  assert.ok(capturedStdin.length > 0, `expected something written to stdin, got: '${capturedStdin}'`);
  const parsed = JSON.parse(capturedStdin);
  assert.deepEqual(parsed.params, { x: 7, y: 'z' });
  assert.equal(typeof parsed.name, 'string');
});
