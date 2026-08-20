// Regression test for init-mode uncaughtException handling.
//
// Symptom: with config=null (operator hasn't completed the /api/init wizard),
// agents that send heartbeats / fetchConfig to the center trigger
// `getDb()` → throws `Error('db not initialized; call db.init(config) first')`.
// Pre-fix, that throw reached process.on('uncaughtException') and the handler
// called `process.exit(1)`. NSSM then restarted the service → next heartbeat
// did the same thing → "ran for <1500ms, restart delayed by 32000ms" loop.
// The init wizard (which writes appsettings.json + init marker) was
// unreachable because the service was always restarting.
//
// Fix: the global uncaughtException handler now recognizes
// "db not initialized; ..." and stays up (warn log, no exit). The wizard
// stays reachable, the operator can finish init, and DB writes become
// possible.
//
// This test captures the handler at registration time (mocking process.on
// before server.js is imported), then exercises both branches:
//   1. db-not-initialized error → no process.exit
//   2. other error               → process.exit(1)

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('uncaughtException handler is non-fatal for "db not initialized"', async () => {
  // Capture process.on callbacks before server.js loads.
  const origOn = process.on.bind(process);
  const captured = {};
  process.on = (event, handler) => {
    captured[event] = handler;
    return origOn(event, handler);
  };

  let exitCalled = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCalled = code; };

  try {
    // Importing server.js registers the uncaughtException + unhandledRejection
    // handlers at module top (line ~102). The runtime IIFE is gated on
    // `import.meta.url === pathToFileURL(process.argv[1])` so it does not
    // fire — only the handler registration runs.
    await import('../../server.js');

    assert.ok(captured.uncaughtException, 'server.js should register an uncaughtException listener');

    // Branch 1: db-not-initialized must NOT exit.
    exitCalled = null;
    captured.uncaughtException(
      new Error('db not initialized; call db.init(config) first'),
      'uncaughtException'
    );
    assert.equal(exitCalled, null, 'should not call process.exit for db-not-initialized');

    // Branch 2: any other error must exit(1) as before.
    exitCalled = null;
    captured.uncaughtException(new Error('disk on fire'), 'uncaughtException');
    assert.equal(exitCalled, 1, 'should exit(1) for non-init errors');
  } finally {
    process.on = origOn;
    process.exit = origExit;
  }
});

test('unhandledRejection handler is non-fatal for "db not initialized"', async () => {
  const origOn = process.on.bind(process);
  const captured = {};
  process.on = (event, handler) => {
    captured[event] = handler;
    return origOn(event, handler);
  };

  let exitCalled = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCalled = code; };

  try {
    await import('../../server.js?variant=rejection');

    assert.ok(captured.unhandledRejection, 'server.js should register an unhandledRejection listener');

    exitCalled = null;
    captured.unhandledRejection(
      new Error('db not initialized; call db.init(config) first')
    );
    assert.equal(exitCalled, null, 'should not call process.exit for db-not-initialized');

    exitCalled = null;
    captured.unhandledRejection(new Error('network partition'));
    assert.equal(exitCalled, 1, 'should exit(1) for non-init errors');
  } finally {
    process.on = origOn;
    process.exit = origExit;
  }
});