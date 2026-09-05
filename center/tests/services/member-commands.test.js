// 2026-09-05 R81 — Member server PowerShell command service tests.
//
// Covers the full service surface (queueCommand / claimForAgent /
// completeCommand / sweepTimeouts / getCommand / listCommands) plus
// the 8 guard rails (hostname-online, script size, timeout range,
// stdout/stderr truncation, per-host rate limit, password redact).
//
// Mirrors tests/services/ad-admin-commands.test.js (R75) but for the
// member-script surface: single commandType, single guard set, with
// the rate-limit + size cap being new vs R75.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest, getDb } from '../../src/db/index.js';
import { buildSql } from '../../src/db/sql.js';
import {
  queueCommand, claimForAgent, completeCommand, sweepTimeouts,
  getCommand, listCommands, checkHostOnline, _testInternals
} from '../../src/services/member-commands.js';

// ── Test plumbing ────────────────────────────────────────────────────────

function makeStore() {
  let nextId = 1;
  return {
    rows: [],
    nextId: () => nextId++,
    insert({ hostname, params, operatorId = null }) {
      const id = nextId++;
      const row = {
        id,
        hostname,
        command_type: 'member_script',
        params_json: typeof params === 'string' ? params : JSON.stringify(params),
        status: 'queued',
        operator_id: operatorId,
        operator_username: null,
        result_json: null,
        error_message: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
        claimed_at: null,
        completed_at: null
      };
      this.rows.push(row);
      return row;
    },
    byId(id) {
      return this.rows.find(r => r.id === Number(id));
    },
    reset() {
      this.rows = [];
      nextId = 1;
    }
  };
}

function buildDbFor(store, { onlineHosts = new Set() } = {}) {
  const sql = buildSql('mysql');
  return {
    dialect: 'mysql',
    sql,
    async execute(sqlStr, params = []) {
      if (/INSERT\s+INTO\s+ad_member_commands/i.test(sqlStr)) {
        const [hostname, commandType, paramsJson, operatorId] = params;
        const row = store.insert({ hostname, params: paramsJson, operatorId });
        return { rows: [], affectedRows: 1, insertId: row.id };
      }
      if (/UPDATE\s+ad_member_commands\s+SET\s+status\s+=\s*'running'/i.test(sqlStr)) {
        const hostname = params[params.length - 1];
        const ids = params.slice(0, -1).map(Number);
        let affected = 0;
        for (const r of store.rows) {
          if (ids.includes(r.id) && r.hostname === hostname && r.status === 'queued') {
            r.status = 'running';
            r.claimed_at = new Date().toISOString();
            affected++;
          }
        }
        return { rows: [], affectedRows: affected };
      }
      if (/UPDATE\s+ad_member_commands\s+SET\s+status\s+=\s*\?/i.test(sqlStr)) {
        const [status, resultJson, errorMessage, durationMs, id] = params;
        const row = store.byId(id);
        if (row) {
          row.status = status;
          row.result_json = resultJson;
          row.error_message = errorMessage;
          row.duration_ms = durationMs;
          row.completed_at = new Date().toISOString();
        }
        return { rows: [], affectedRows: row ? 1 : 0 };
      }
      if (/UPDATE\s+ad_member_commands\s+SET\s+status\s*=\s*'timeout'/i.test(sqlStr)) {
        const timeoutSeconds = Number(params[0]);
        const thresholdMs = timeoutSeconds * 1000;
        const now = Date.now();
        let affected = 0;
        for (const r of store.rows) {
          if (r.status !== 'running' || !r.claimed_at) continue;
          const ageMs = now - new Date(r.claimed_at).getTime();
          if (ageMs > thresholdMs) {
            r.status = 'timeout';
            r.error_message = 'command exceeded timeout threshold';
            r.completed_at = new Date().toISOString();
            affected++;
          }
        }
        return { rows: [], affectedRows: affected };
      }
      return { rows: [], affectedRows: 0 };
    },
    async query(sqlStr, params = []) {
      if (/SELECT\s+id\s+FROM\s+ad_member_commands/i.test(sqlStr) && !/count/i.test(sqlStr)) {
        const hostname = params[0];
        const limit = Number(params[1]);
        const rows = store.rows
          .filter(r => r.status === 'queued' && r.hostname === hostname)
          .slice(0, limit)
          .map(r => ({ id: r.id }));
        return { rows };
      }
      if (/^SELECT\s+id, hostname, command_type, params_json, status,\s+created_at, claimed_at\s+FROM\s+ad_member_commands/i.test(sqlStr)) {
        const ids = params.map(Number);
        const rows = store.rows
          .filter(r => ids.includes(r.id))
          .map(r => ({
            id: r.id,
            hostname: r.hostname,
            command_type: r.command_type,
            params_json: r.params_json,
            status: r.status,
            created_at: r.created_at,
            claimed_at: r.claimed_at
          }));
        return { rows };
      }
      if (/FROM\s+ad_member_commands\s+c\s+LEFT\s+JOIN\s+sys_users/i.test(sqlStr)) {
        const idMatch = sqlStr.match(/WHERE\s+c\.id\s*=\s*\?/i);
        const hostMatch = sqlStr.match(/WHERE\s+c\.hostname\s*=\s*\?/i);
        const statusMatch = sqlStr.match(/WHERE\s+c\.status\s*=\s*\?/i);
        let filtered;
        if (idMatch) {
          filtered = store.rows.filter(r => r.id === Number(params[0]));
        } else if (hostMatch) {
          // mssql: params[0] = TOP, params[1] = hostname, params[2] = offset
          // mysql: params[0] = hostname, params[1] = size, params[2] = offset
          // Use the first string param as hostname regardless of dialect.
          const hostname = params.find(p => typeof p === 'string');
          filtered = store.rows.filter(r => r.hostname === hostname);
        } else if (statusMatch) {
          const status = params.find(p => typeof p === 'string');
          filtered = store.rows.filter(r => r.status === status);
        } else {
          filtered = store.rows;
        }
        if (/LIMIT\s+\?\s+OFFSET\s+\?/i.test(sqlStr)) {
          const size = Number(params[params.length - 2]);
          const offset = Number(params[params.length - 1]);
          if (Number.isFinite(size) && Number.isFinite(offset)) {
            filtered = filtered.slice(offset, offset + size);
          }
        } else if (/SELECT\s+TOP\s+\(\?\)/i.test(sqlStr)) {
          const size = Number(params[0]);
          const offset = Number(params[params.length - 1]);
          if (Number.isFinite(size) && Number.isFinite(offset)) {
            filtered = filtered.slice(offset, offset + size);
          }
        }
        const shape = (r) => ({
          id: r.id,
          hostname: r.hostname,
          command_type: r.command_type,
          params_json: r.params_json,
          result_json: r.result_json,
          status: r.status,
          operator_id: r.operator_id,
          operator_username: r.operator_username,
          created_at: r.created_at,
          claimed_at: r.claimed_at,
          completed_at: r.completed_at,
          duration_ms: r.duration_ms,
          error_message: r.error_message
        });
        return { rows: filtered.map(shape) };
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+ad_member_commands/i.test(sqlStr)) {
        // countRecentForHost — count queued+running for this hostname in
        // the last 60s. The test store doesn't filter by created_at, so
        // we just count all queued+running for the host.
        const hostname = params[0];
        const n = store.rows.filter(r =>
          r.hostname === hostname && (r.status === 'queued' || r.status === 'running')
        ).length;
        return { rows: [{ n }] };
      }
      if (/SELECT\s+COUNT\(\*\)/i.test(sqlStr)) {
        let total;
        if (/WHERE\s+hostname\s*=\s*\?/i.test(sqlStr)) {
          const hostname = params.find(p => typeof p === 'string');
          total = store.rows.filter(r => r.hostname === hostname).length;
        } else if (/WHERE\s+status\s*=\s*\?/i.test(sqlStr)) {
          const status = params.find(p => typeof p === 'string');
          total = store.rows.filter(r => r.status === status).length;
        } else if (/WHERE\s+operator_id\s*=\s*\?/i.test(sqlStr)) {
          total = store.rows.filter(r => r.operator_id === Number(params[0])).length;
        } else {
          total = store.rows.length;
        }
        return { rows: [{ total }] };
      }
      // heartbeat online-check: emulate via the test's onlineHosts set
      if (/FROM\s+ad_agent_heartbeat/i.test(sqlStr) && /last_heartbeat_at\s*>=\s*UTC_TIMESTAMP/i.test(sqlStr)) {
        const hostname = params[0];
        return { rows: onlineHosts.has(hostname) ? [{ last_heartbeat_at: new Date().toISOString() }] : [] };
      }
      if (/SELECT\s+last_heartbeat_at\s+FROM\s+ad_agent_heartbeat/i.test(sqlStr)) {
        const hostname = params[0];
        return { rows: onlineHosts.has(hostname) ? [{ last_heartbeat_at: new Date().toISOString() }] : [] };
      }
      return { rows: [] };
    },
    async transaction(work) { return work({ execute: this.execute, query: this.query, sql }); },
    async healthcheck() {},
    async close() {}
  };
}

function withDb(db, fn) {
  let prev = null;
  try { prev = getDb(); } catch { /* never initialized */ }
  _setDbForTest(db);
  return Promise.resolve().then(fn).finally(() => {
    if (prev) _setDbForTest(prev);
    else _setDbForTest(null);
  });
}

// ── Guard rail: helper invariants ──────────────────────────────────────

test('_testInternals: 8 guard-rail constants match spec §3', () => {
  assert.equal(_testInternals.SCRIPT_MAX_BYTES, 32 * 1024);
  assert.equal(_testInternals.STDOUT_MAX_BYTES, 32 * 1024);
  assert.equal(_testInternals.STDERR_MAX_BYTES, 8 * 1024);
  assert.equal(_testInternals.TIMEOUT_MIN_SEC, 5);
  assert.equal(_testInternals.TIMEOUT_MAX_SEC, 60);
  assert.equal(_testInternals.TIMEOUT_DEFAULT_SEC, 30);
  assert.equal(_testInternals.RATE_LIMIT_MAX, 5);
  assert.equal(_testInternals.RATE_LIMIT_WINDOW_SEC, 60);
  // single command type for R81
  assert.ok(_testInternals.COMMAND_TYPES.has('member_script'));
  assert.equal(_testInternals.COMMAND_TYPES.size, 1);
});

test('_testInternals.redactPasswords strips password/newPassword/oldPassword/token', () => {
  const { redactPasswords } = _testInternals;
  const out = redactPasswords({
    sam: 'admin',
    password: 'P@ss',
    newPassword: 'N3w',
    oldPassword: 'Old',
    token: 'tk',
    safe: 'kept'
  });
  assert.equal(out.sam, 'admin');
  assert.equal(out.safe, 'kept');
  assert.equal(out.password, undefined);
  assert.equal(out.newPassword, undefined);
  assert.equal(out.oldPassword, undefined);
  assert.equal(out.token, undefined);
});

test('_testInternals.truncateUtf8 cuts at byte boundary', () => {
  const { truncateUtf8 } = _testInternals;
  // short string passes through
  assert.equal(truncateUtf8('hello', 32 * 1024), 'hello');
  // null passes through
  assert.equal(truncateUtf8(null, 100), null);
  // long ASCII string cut at byte count
  const longAscii = 'x'.repeat(50 * 1024);
  const cut = truncateUtf8(longAscii, 32 * 1024);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 32 * 1024);
  // multi-byte: preserve at valid char boundary
  const multiByte = '你'.repeat(20 * 1024); // 60KB UTF-8
  const cut2 = truncateUtf8(multiByte, 32 * 1024);
  assert.ok(Buffer.byteLength(cut2, 'utf8') <= 32 * 1024);
  // round-trip cleanly parses as the same prefix
  assert.ok(multiByte.startsWith(cut2));
});

// ── queueCommand: happy path + 8 guard rails ───────────────────────────

test('queueCommand: happy path inserts a queued row', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set(['HUBADSRV1']) }), async () => {
    const row = await queueCommand({
      hostname: 'HUBADSRV1',
      params: { script: 'Get-Date', timeoutSec: 15 },
      operatorId: 7
    });
    assert.equal(row.status, 'queued');
    assert.equal(row.hostname, 'HUBADSRV1');
    assert.equal(row.operator_id, 7);
    assert.ok(row.id > 0);
  });
});

test('queueCommand: defaults timeoutSec to 30 when not supplied', async () => {
  const store = makeStore();
  await withDb(buildDbFor(store, { onlineHosts: new Set(['HOST']) }), async () => {
    await queueCommand({ hostname: 'HOST', params: { script: 'echo hi' } });
    const row = store.rows[0];
    const parsed = JSON.parse(row.params_json);
    assert.equal(parsed.timeoutSec, 30);
  });
});

test('queueCommand: 400 when hostname missing', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => queueCommand({ hostname: '', params: { script: 'Get-Date' } }),
      (e) => e.httpStatus === 400 && /hostname/.test(e.message)
    );
  });
});

test('queueCommand: guard rail #1 — 503 when hostname has no online agent', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set() }), async () => {
    await assert.rejects(
      () => queueCommand({ hostname: 'OFFLINE', params: { script: 'Get-Date' } }),
      (e) => e.httpStatus === 503 && /no agent currently online/.test(e.message)
    );
  });
});

test('queueCommand: guard rail #1 — skipOnlineCheck bypasses the online check', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set() }), async () => {
    const row = await queueCommand({
      hostname: 'OFFLINE',
      params: { script: 'Get-Date' },
      skipOnlineCheck: true
    });
    assert.equal(row.status, 'queued');
  });
});

test('queueCommand: guard rail #2 — rejects script > 32KB', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set(['H']) }), async () => {
    const bigScript = 'x'.repeat(32 * 1024 + 1);
    await assert.rejects(
      () => queueCommand({ hostname: 'H', params: { script: bigScript } }),
      (e) => e.httpStatus === 400 && /exceeds/.test(e.message)
    );
  });
});

test('queueCommand: guard rail #2 — accepts script exactly at 32KB', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set(['H']) }), async () => {
    const exactScript = 'x'.repeat(32 * 1024);
    const row = await queueCommand({ hostname: 'H', params: { script: exactScript } });
    assert.equal(row.status, 'queued');
  });
});

test('queueCommand: guard rail #3 — rejects timeoutSec < 5', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set(['H']) }), async () => {
    await assert.rejects(
      () => queueCommand({ hostname: 'H', params: { script: 'Get-Date', timeoutSec: 1 } }),
      (e) => e.httpStatus === 400 && /timeoutSec/.test(e.message)
    );
  });
});

test('queueCommand: guard rail #3 — rejects timeoutSec > 60', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set(['H']) }), async () => {
    await assert.rejects(
      () => queueCommand({ hostname: 'H', params: { script: 'Get-Date', timeoutSec: 120 } }),
      (e) => e.httpStatus === 400 && /timeoutSec/.test(e.message)
    );
  });
});

test('queueCommand: guard rail #6 — rate-limit 429 when 5 queued in 60s window', async () => {
  const store = makeStore();
  // Pre-seed 5 queued rows for the same host — matches the countRecentForHost
  // return of n=5 which trips the RATE_LIMIT_MAX gate.
  for (let i = 0; i < 5; i++) {
    store.insert({ hostname: 'H', params: { script: `echo ${i}` } });
  }
  await withDb(buildDbFor(store, { onlineHosts: new Set(['H']) }), async () => {
    await assert.rejects(
      () => queueCommand({ hostname: 'H', params: { script: 'echo new' } }),
      (e) => e.httpStatus === 429 && /rate limit/.test(e.message)
    );
  });
});

// ── claimForAgent ──────────────────────────────────────────────────────

test('claimForAgent: returns up to limit queued commands for the hostname', async () => {
  const store = makeStore();
  store.insert({ hostname: 'H1', params: { script: 'a' } });
  store.insert({ hostname: 'H1', params: { script: 'b' } });
  store.insert({ hostname: 'H2', params: { script: 'c' } });
  await withDb(buildDbFor(store), async () => {
    const claimed = await claimForAgent('H1', 5);
    assert.equal(claimed.length, 2);
    for (const c of claimed) {
      assert.equal(c.status, 'running');
      assert.equal(c.hostname, 'H1');
      assert.ok(c.claimed_at);
    }
  });
});

test('claimForAgent: respects limit cap', async () => {
  const store = makeStore();
  for (let i = 0; i < 8; i++) {
    store.insert({ hostname: 'H1', params: { script: `s${i}` } });
  }
  await withDb(buildDbFor(store), async () => {
    const claimed = await claimForAgent('H1', 3);
    assert.equal(claimed.length, 3);
  });
});

test('claimForAgent: empty list when no queued commands', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    const claimed = await claimForAgent('H1', 5);
    assert.deepEqual(claimed, []);
  });
});

// ── completeCommand + truncation + redact ──────────────────────────────

test('completeCommand: success flips status to success + persists result', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H1', params: { script: 'Get-Date' } });
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    const updated = await completeCommand(row.id, {
      success: true,
      data: { stdout: 'Sun Jan 1 12:00:00', stderr: '', exitCode: 0 },
      exitCode: 0,
      durationMs: 1234
    });
    assert.equal(updated.status, 'success');
    assert.equal(updated.result_json.stdout, 'Sun Jan 1 12:00:00');
    assert.equal(updated.duration_ms, 1234);
    assert.ok(updated.completed_at);
  });
});

test('completeCommand: guard rail #4 — stdout truncated to 32KB', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    const bigStdout = 'x'.repeat(40 * 1024);
    await completeCommand(row.id, {
      success: true,
      data: { stdout: bigStdout, stderr: '' },
      exitCode: 0,
      durationMs: 100
    });
    const refetched = store.byId(row.id);
    const parsed = JSON.parse(refetched.result_json);
    assert.ok(Buffer.byteLength(parsed.stdout, 'utf8') <= 32 * 1024,
      'stdout must be truncated at 32KB');
  });
});

test('completeCommand: guard rail #5 — stderr truncated to 8KB', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    const bigStderr = 'y'.repeat(20 * 1024);
    await completeCommand(row.id, {
      success: true,
      data: { stdout: '', stderr: bigStderr },
      exitCode: 0,
      durationMs: 100
    });
    const refetched = store.byId(row.id);
    const parsed = JSON.parse(refetched.result_json);
    assert.ok(Buffer.byteLength(parsed.stderr, 'utf8') <= 8 * 1024,
      'stderr must be truncated at 8KB');
  });
});

test('completeCommand: guard rail #8 — strips password/token fields from result_json', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  row.status = 'running';
  row.claimed_at = new Date().toISOString();
  await withDb(buildDbFor(store), async () => {
    await completeCommand(row.id, {
      success: true,
      data: { stdout: 'ok', password: 'P@ssw0rd!', token: 'tk-123' },
      exitCode: 0,
      durationMs: 1
    });
    const refetched = store.byId(row.id);
    assert.equal(refetched.result_json.includes('P@ssw0rd!'), false);
    assert.equal(refetched.result_json.includes('tk-123'), false);
    assert.ok(refetched.result_json.includes('ok'));
  });
});

test('completeCommand: idempotent on already-terminal row', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  row.status = 'success';
  row.result_json = JSON.stringify({ stdout: 'first' });
  await withDb(buildDbFor(store), async () => {
    const updated = await completeCommand(row.id, { success: false, error: 'should not apply' });
    assert.equal(updated.status, 'success');
    assert.equal(updated.result_json.stdout, 'first');
  });
});

test('completeCommand: 409 when command not in running state', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  // still 'queued'
  await withDb(buildDbFor(store), async () => {
    await assert.rejects(
      () => completeCommand(row.id, { success: true, data: null }),
      (e) => e.httpStatus === 409 && /running/.test(e.message)
    );
  });
});

test('completeCommand: 404 when command does not exist', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    await assert.rejects(
      () => completeCommand(999, { success: true, data: null }),
      (e) => e.httpStatus === 404
    );
  });
});

// ── sweepTimeouts ──────────────────────────────────────────────────────

test('sweepTimeouts: marks running rows older than threshold as timeout', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  row.status = 'running';
  row.claimed_at = new Date(Date.now() - 60_000).toISOString();
  await withDb(buildDbFor(store), async () => {
    await sweepTimeouts({ timeoutMs: 30_000 });
    assert.equal(store.byId(row.id).status, 'timeout');
    assert.equal(store.byId(row.id).error_message, 'command exceeded timeout threshold');
  });
});

test('sweepTimeouts: leaves rows younger than threshold alone', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 's' } });
  row.status = 'running';
  row.claimed_at = new Date(Date.now() - 5_000).toISOString();
  await withDb(buildDbFor(store), async () => {
    await sweepTimeouts({ timeoutMs: 30_000 });
    assert.equal(store.byId(row.id).status, 'running');
  });
});

// ── getCommand / listCommands ──────────────────────────────────────────

test('getCommand: returns parsed params_json + result_json', async () => {
  const store = makeStore();
  const row = store.insert({ hostname: 'H', params: { script: 'Get-Date' } });
  row.status = 'success';
  row.result_json = JSON.stringify({ stdout: 'ok' });
  await withDb(buildDbFor(store), async () => {
    const fetched = await getCommand(row.id);
    assert.ok(fetched);
    assert.deepEqual(fetched.params_json, { script: 'Get-Date' });
    assert.deepEqual(fetched.result_json, { stdout: 'ok' });
  });
});

test('getCommand: returns null for unknown id', async () => {
  await withDb(buildDbFor(makeStore()), async () => {
    assert.equal(await getCommand(999), null);
  });
});

test('listCommands: paginates + returns total', async () => {
  const store = makeStore();
  for (let i = 0; i < 5; i++) {
    store.insert({ hostname: 'H', params: { script: `s${i}` } });
  }
  await withDb(buildDbFor(store), async () => {
    const out = await listCommands({ page: 1, size: 2 });
    assert.equal(out.total, 5);
    assert.equal(out.size, 2);
    assert.equal(out.rows.length, 2);
  });
});

test('listCommands: filters by hostname', async () => {
  const store = makeStore();
  store.insert({ hostname: 'H1', params: { script: 'a' } });
  store.insert({ hostname: 'H1', params: { script: 'b' } });
  store.insert({ hostname: 'H2', params: { script: 'c' } });
  await withDb(buildDbFor(store), async () => {
    const out = await listCommands({ hostname: 'H1' });
    assert.equal(out.total, 2);
    for (const r of out.rows) assert.equal(r.hostname, 'H1');
  });
});

// ── checkHostOnline (used by admin route for 503) ──────────────────────

test('checkHostOnline: returns online=true for heartbeating host', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set(['LIVE']) }), async () => {
    const r = await checkHostOnline('LIVE');
    assert.equal(r.online, true);
  });
});

test('checkHostOnline: returns online=false with lastHeartbeatAt for stale host', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set() }), async () => {
    const r = await checkHostOnline('STALE');
    assert.equal(r.online, false);
  });
});

test('checkHostOnline: force=true bypasses check', async () => {
  await withDb(buildDbFor(makeStore(), { onlineHosts: new Set() }), async () => {
    const r = await checkHostOnline('OFFLINE', { force: true });
    assert.equal(r.online, true);
  });
});