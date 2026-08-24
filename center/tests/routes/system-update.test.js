// Tests for /api/system/update — the operator-facing update endpoint.
//
// Contract:
//   - Localhost-only: 127.0.0.1, ::1, ::ffff:127.0.0.1. Remote → 403.
//   - No auth required (intentional; localhost gate is the protection).
//   - On success: applies pending DB migrations via service.upgrade(),
//     writes a system_update audit row, schedules process.exit(0) after
//     a delay so NSSM picks the new code on the next launch.
//   - Returns 200 with { ok, restarted, migrationsApplied, migrationsFailed,
//     seed, message } — even when there are zero pending migrations.
//
// These tests stub process.exit so the test runner doesn't actually die when
// the route triggers its shutdown timer, AND stub setTimeout so each test
// case starts with a clean timer slate. Without the setTimeout stub, a
// 500ms timer from a previous test can fire mid-execution of the next test
// (Node 20+ test runner supports per-file concurrency, so leftover timers
// bleed). supertest connects from 127.0.0.1 so the localhost check passes
// by default; the remote-rejection test injects a middleware that overrides
// req.ip via Object.defineProperty (Express makes it a getter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { systemRouter } from '../../src/routes/system.js';
import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';

const FAST_DELAY_MS = 10;

// Stub process.exit AND setTimeout for the duration of one test. setTimeout
// is intercepted so leftover timers from a previous test can't fire during
// this test's assertions — every test starts with an empty timer queue and
// restores Node's real setTimeout on teardown.
function isolate() {
  const exitCalls = [];
  const origExit = process.exit;
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  process.exit = (code) => { exitCalls.push(code); };
  global.setTimeout = (fn, ms, ...args) => {
    // For test purposes, run timers synchronously on the next tick via
    // queueMicrotask so the test can `await` and observe their effect
    // without real-world delay. Real Node behavior is preserved for any
    // delay >= 0 (Express + supertest internal timers).
    queueMicrotask(() => fn(...args));
    return { unref() { return this; }, ref() { return this; } };
  };
  global.clearTimeout = () => {};
  return {
    exitCalls,
    restore: () => {
      process.exit = origExit;
      global.setTimeout = origSetTimeout;
      global.clearTimeout = origClearTimeout;
    }
  };
}

function buildApp({ delayMs = FAST_DELAY_MS } = {}) {
  const a = express();
  a.use(express.json());
  a.use(systemRouter({
    logger: { warn() {}, error() {}, info() {}, child() { return this; } },
    getRepoRoot: () => '/fake/root',
    getExitDelayMs: () => delayMs
  }));
  return a;
}

// Express derives req.ip from req.socket.remoteAddress (via the proxy-addr
// npm package). The IncomingMessage.prototype defines `ip` as a non-writable
// getter so direct assignment throws — instead we replace req.socket with a
// stub whose remoteAddress is what we want Express to see. The route's
// clientIp() helper falls back to req.socket.remoteAddress anyway, so this
// also covers the guard's secondary check.
function setRemoteIp(req, ip) {
  req.socket = { remoteAddress: ip };
}

// Default DB mock that returns nothing for everything — the upgrade service
// sees no pending migrations and no seed file at the fake repoRoot, so the
// happy path returns { applied: [], failed: [], seed: { reason:
// 'no-seed-file' }, ok: true }.
function emptyDb() {
  return buildMockDb([]);
}

test('POST /api/system/update returns 200 + restart scheduled for localhost', async () => {
  const iso = isolate();
  try {
    _setDbForTest(emptyDb());
    const r = await supertest(buildApp()).post('/api/system/update');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.restarted, true);
    assert.deepEqual(r.body.migrationsApplied, []);
    assert.deepEqual(r.body.migrationsFailed, []);
    assert.equal(r.body.seed.reason, 'no-seed-file');
    // Yield once so the queueMicrotask-scheduled exit timer fires.
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(iso.exitCalls, [0], 'process.exit(0) should fire exactly once');
  } finally {
    iso.restore();
  }
});

test('POST /api/system/update returns 403 for non-localhost IP', async () => {
  const iso = isolate();
  try {
    _setDbForTest(emptyDb());
    // Inject a middleware that overrides req.ip BEFORE the system router
    // so the localhost guard sees a remote address.
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      setRemoteIp(req, '203.0.113.5'); // RFC 5737 documentation range
      next();
    });
    a.use(systemRouter({
      logger: { warn() {}, error() {}, info() {}, child() { return this; } },
      getRepoRoot: () => '/fake/root',
      getExitDelayMs: () => FAST_DELAY_MS
    }));
    const r = await supertest(a).post('/api/system/update');
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'localhost-only' });
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(iso.exitCalls.length, 0, 'process.exit must NOT fire on rejection');
  } finally {
    iso.restore();
  }
});

test('POST /api/system/update accepts ::1 (IPv6 loopback)', async () => {
  const iso = isolate();
  try {
    _setDbForTest(emptyDb());
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      setRemoteIp(req, '::1');
      next();
    });
    a.use(systemRouter({
      logger: { warn() {}, error() {}, info() {}, child() { return this; } },
      getRepoRoot: () => '/fake/root',
      getExitDelayMs: () => FAST_DELAY_MS
    }));
    const r = await supertest(a).post('/api/system/update');
    assert.equal(r.status, 200);
    assert.equal(r.body.restarted, true);
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(iso.exitCalls, [0]);
  } finally {
    iso.restore();
  }
});

test('POST /api/system/update accepts ::ffff:127.0.0.1 (IPv4-mapped IPv6)', async () => {
  const iso = isolate();
  try {
    _setDbForTest(emptyDb());
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      setRemoteIp(req, '::ffff:127.0.0.1');
      next();
    });
    a.use(systemRouter({
      logger: { warn() {}, error() {}, info() {}, child() { return this; } },
      getRepoRoot: () => '/fake/root',
      getExitDelayMs: () => FAST_DELAY_MS
    }));
    const r = await supertest(a).post('/api/system/update');
    assert.equal(r.status, 200);
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(iso.exitCalls, [0]);
  } finally {
    iso.restore();
  }
});

test('POST /api/system/update responds before scheduling exit (response flushed first)', async () => {
  // The route returns the response body synchronously (res.json), then
  // schedules process.exit via setTimeout. Express flushes the response
  // before our exit timer fires (Express's res.json writes synchronously
  // and the socket sends on the next I/O tick). This test verifies the
  // response arrives and has the expected shape; the timer-leak isolation
  // stub from isolate() guarantees only this test's exit can fire.
  const iso = isolate();
  try {
    _setDbForTest(emptyDb());
    const r = await supertest(buildApp()).post('/api/system/update');
    assert.equal(r.status, 200);
    assert.equal(r.body.restarted, true);
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(iso.exitCalls, [0]);
  } finally {
    iso.restore();
  }
});

test('POST /api/system/update propagates unexpected DB errors as 500 (no exit)', async () => {
  // Force an unexpected throw inside upgrade() by making getRepoRoot return
  // undefined — `path.join(undefined, ...)` throws TypeError synchronously.
  // The DB mock is irrelevant because the throw happens before any DB call.
  const iso = isolate();
  try {
    _setDbForTest(emptyDb());
    const a = express();
    a.use(express.json());
    a.use(systemRouter({
      logger: { warn() {}, error() {}, info() {}, child() { return this; } },
      getRepoRoot: () => undefined,
      getExitDelayMs: () => FAST_DELAY_MS
    }));
    const r = await supertest(a).post('/api/system/update');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'internal');
    await new Promise(resolve => queueMicrotask(resolve));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(iso.exitCalls.length, 0, 'process.exit must NOT fire on failure');
  } finally {
    iso.restore();
  }
});
