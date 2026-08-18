// 016-agent-token-rotate-mssql.test.js — real-MSSQL integration test for
// the I3 dual-key agent-token rotation SQL surface (Tasks 1-5).
//
// Pattern follows 015-user-token-version-mssql.test.js: driver-level,
// gated on TEST_MSSQL_URL so the suite stays green on dev machines without
// a live DB. The test drives the round-trip through the real service
// functions (`seedAgentTokenIfMissing`, `rotateAgentToken`,
// `commitAgentToken`) against a live MSSQL driver so the actual product
// SQL — `db.sql.config.upsert` (MSSQL MERGE), `db.sql.config.getAgentTokenBundle`,
// `db.sql.audit.write` — is what hits the database. This is exactly the
// "real-DB SQL test" gate the project's SQL-regression rule requires;
// re-implementing the SQL by hand would defeat the test.
//
// Verifies:
//   1. seedAgentTokenIfMissing: writes all four bundle rows (current/previous/
//      rotated_at/previous_ttl_days) into system_config via MERGE.
//   2. getAgentTokenState: reads them back via the bundle SQL.
//   3. rotateAgentToken: swaps previous=OLD, current=NEW (the previous token
//      continues to be accepted during the overlap window), records
//      rotated_at, writes an audit row to audit_logs.
//   4. commitAgentToken: clears previous and rotated_at while leaving
//      current=NEW, writes a second audit row.
//
// Critical: the test is self-cleaning. `system_config.agent_token_*` rows
// are real production-shaped config (current is the actual agent token
// presented at auth time); capture the pre-existing values of all four keys
// at test start and restore them in the `finally` block. Running this
// against a live DB leaves the system in its original rotated state.
//
// MSSQL dialect notes:
//   - All `?` placeholders are rewritten to `@p1`, `@p2`, ... by the driver.
//   - `db.sql.config.upsert` is a MERGE terminated with `;` (required by
//     SQL Server).
//   - `db.sql.audit.write` casts the change_type parameter to VARCHAR(16).
//   - The driver routes IF-prefixed batches through `request.batch()`, but
//     none of the SQL this test exercises uses control flow.
//
// `db` is wrapped to expose a `sql` registry (config.upsert,
// config.getAgentTokenBundle, audit.write) and forward `execute`/`query`/
// `transaction` to the underlying driver. The driver passes `sql` into
// `db.transaction(work, sqlRegistry)` so `tx.sql` mirrors it — required
// because `writeAudit` inside the service resolves `tx.sql.audit.write`
// (see services/audit.js:62-64).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestUrl } from '../integration/_url.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';
import { buildSql } from '../../src/db/sql.js';
import {
  getAgentTokenState,
  rotateAgentToken,
  commitAgentToken,
  seedAgentTokenIfMissing
} from '../../src/services/agent-token.js';

const MSSQL = !!process.env.TEST_MSSQL_URL;
const BUNDLE_KEYS = [
  'agent_token_current',
  'agent_token_previous',
  'agent_token_rotated_at',
  'agent_token_previous_ttl_days'
];
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildDb({ host, port, user, password }) {
  const driver = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
  const sql = buildSql('mssql');
  // transaction must forward `sql` so writeAudit's `tx.sql.audit.write`
  // resolves to the real INSERT string.
  return {
    dialect: 'mssql',
    sql,
    execute: (s, p) => driver.execute(s, p),
    query:   (s, p) => driver.query(s, p),
    transaction: (work) => driver.transaction(work, sql),
    healthcheck: () => driver.healthcheck(),
    close: () => driver.close()
  };
}

test('agent_token rotate + commit round-trip on system_config (mssql)', { skip: !MSSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  const db = buildDb({ host, port, user, password });

  // Snapshot pre-existing values of the four bundle rows so we can restore
  // them after the test. The current row in particular is a live auth
  // secret — leaving the DB rotated would break the running center.
  const snapshot = {};
  try {
    const { rows: pre } = await db.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (@p1, @p2, @p3, @p4)`,
      BUNDLE_KEYS
    );
    for (const r of pre) snapshot[r.config_key] = r.config_value ?? '';
    // If a key didn't exist before, snapshot it as null so restore can
    // delete it instead of overwriting.
    for (const k of BUNDLE_KEYS) if (!(k in snapshot)) snapshot[k] = null;

    // --- 1. seedAgentTokenIfMissing: writes all four bundle rows ---
    // Wipe the bundle first so the seed path is exercised (current='' branch).
    for (const k of BUNDLE_KEYS) {
      await db.execute(`DELETE FROM system_config WHERE config_key = @p1`, [k]);
    }
    const seeded = await seedAgentTokenIfMissing(db, '__test_i3_seed__', noopLogger);
    assert.equal(seeded.seeded, true, 'seed path must run when current is empty');
    assert.equal(seeded.current, '__test_i3_seed__');

    const { rows: afterSeed } = await db.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (@p1, @p2, @p3, @p4) ORDER BY config_key`,
      BUNDLE_KEYS
    );
    const seedMap = Object.fromEntries(afterSeed.map(r => [r.config_key, r.config_value]));
    assert.equal(seedMap.agent_token_current, '__test_i3_seed__', 'current seeded');
    assert.equal(seedMap.agent_token_previous, '', 'previous seeded as empty');
    assert.equal(seedMap.agent_token_rotated_at, '', 'rotated_at seeded as empty');
    assert.equal(seedMap.agent_token_previous_ttl_days, '30', 'ttl_days seeded as 30');

    // --- 2. getAgentTokenState reads via bundle SQL ---
    const state1 = await getAgentTokenState(db);
    assert.equal(state1.current, '__test_i3_seed__');
    assert.equal(state1.previous, '');
    assert.equal(state1.rotatedAt, '');
    assert.equal(state1.ttlDays, 30);

    // --- 3. rotateAgentToken: previous=OLD, current=NEW, rotated_at set ---
    // Set current to a known OLD value before rotating so the previous-row
    // write is deterministic.
    await db.execute(
      db.sql.config.upsert,
      ['agent_token_current', '__test_i3_old__']
    );
    const rotated = await rotateAgentToken(db, { logger: noopLogger, userId: null });
    assert.match(rotated.newToken, /^[a-f0-9]{96}$/, 'newToken is 48-byte hex');
    assert.match(rotated.rotatedAt, /^\d{4}-\d{2}-\d{2}T/, 'rotatedAt is ISO 8601');

    const state2 = await getAgentTokenState(db);
    assert.equal(state2.current, rotated.newToken, 'current is the new token');
    assert.equal(state2.previous, '__test_i3_old__', 'previous is OLD');
    assert.equal(state2.rotatedAt, rotated.rotatedAt, 'rotatedAt recorded');

    // Verify the audit row was written by the rotate call. writeAudit
    // routes through db.sql.audit.write → INSERT INTO audit_logs.
    const auditsResult = await db.query(
      `SELECT TOP 1 action, target, payload FROM audit_logs WHERE action = @p1 AND target = @p2 ORDER BY id DESC`,
      ['rotate_agent_token', 'system_config']
    );
    const audits = auditsResult.rows;
    assert.equal(audits.length, 1, 'rotate must write exactly one audit row');
    assert.equal(audits[0].target, 'system_config');
    assert.match(audits[0].payload, /"rotatedAt"/, 'audit payload records rotatedAt');

    // --- 4. commitAgentToken: clears previous + rotated_at, leaves current ---
    const committed = await commitAgentToken(db, { logger: noopLogger, userId: null });
    assert.deepEqual(committed, { ok: true });

    const state3 = await getAgentTokenState(db);
    assert.equal(state3.current, rotated.newToken, 'current preserved through commit');
    assert.equal(state3.previous, '', 'previous cleared after commit');
    assert.equal(state3.rotatedAt, '', 'rotated_at cleared after commit');

    const commitAuditsResult = await db.query(
      `SELECT TOP 1 action, target FROM audit_logs WHERE action = @p1 AND target = @p2 ORDER BY id DESC`,
      ['commit_agent_token', 'system_config']
    );
    const commitAudits = commitAuditsResult.rows;
    assert.equal(commitAudits.length, 1, 'commit must write exactly one audit row');
  } finally {
    // Restore: write back the four snapshot rows (or delete if missing pre-test).
    // Best-effort — a failure here is logged but never propagated so we
    // always close the pool.
    try {
      for (const k of BUNDLE_KEYS) {
        if (snapshot[k] === null) {
          await db.execute(`DELETE FROM system_config WHERE config_key = @p1`, [k]);
        } else {
          await db.execute(db.sql.config.upsert, [k, snapshot[k]]);
        }
      }
    } catch (e) {
      console.error(`[016-mssql] snapshot restore failed: ${e.message}`);
    }
    try {
      await db.execute(
        `DELETE FROM audit_logs WHERE action IN (@p1, @p2, @p3) AND target = @p4`,
        ['rotate_agent_token', 'commit_agent_token', 'seed_agent_token', 'system_config']
      );
    } catch {
      // ignore — audit_logs may not exist on a freshly-created DB; not our problem
    }
    await db.close();
  }
});