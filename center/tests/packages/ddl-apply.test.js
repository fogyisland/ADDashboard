// ddl-apply.test.js — real-DB integration tests for the DDL apply orchestrator.
//
// Pattern follows ddl-sandbox.test.js + the sql/* integration tests:
// tests are gated on TEST_MYSQL_URL so the suite stays green on dev machines
// without a live MySQL. Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/ddl-apply.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { ensureSchema, createSchemaMigrationsTable, applyMigrations, dropSchema, schemaExists } from '../../src/packages/ddl-apply.js';
import { parseTestUrl } from '../integration/_url.js';

const SCHEMA = 'pkg_ddl_apply_test';

test('ddl-apply: end-to-end create + apply + drop', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();

  try {
    // Clean up any prior test residue
    if (await schemaExists(db, SCHEMA, 'mysql')) {
      await db.execute(`DROP DATABASE ${SCHEMA}`);
    }

    await ensureSchema(db, SCHEMA, 'mysql');
    assert.strictEqual(await schemaExists(db, SCHEMA, 'mysql'), true);

    await createSchemaMigrationsTable(db, SCHEMA, 'mysql');

    const files = [
      { filename: '001_initial.sql', content: `CREATE TABLE ${SCHEMA}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` },
      { filename: '002_add.sql', content: `ALTER TABLE ${SCHEMA}.metrics ADD COLUMN extra VARCHAR(16) NULL` }
    ];
    await applyMigrations(db, { schemaName: SCHEMA, dialect: 'mysql', files });

    const { rows } = await db.execute(`SELECT filename, version FROM ${SCHEMA}.schema_migrations ORDER BY filename`);
    assert.deepStrictEqual(rows.map(r => r.filename), ['001_initial.sql', '002_add.sql']);

    const { rows: cols } = await db.execute(`SHOW COLUMNS FROM ${SCHEMA}.metrics`);
    const colNames = cols.map(c => c.Field);
    assert.ok(colNames.includes('extra'), `extra column should exist; got ${colNames.join(',')}`);
  } finally {
    try { await dropSchema(db, SCHEMA, 'mysql'); } catch {}
    try { await close(); } catch {}
  }
});

test('ddl-apply: rejects forbidden DDL mid-apply (no partial apply)', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();

  try {
    if (await schemaExists(db, SCHEMA, 'mysql')) {
      await db.execute(`DROP DATABASE ${SCHEMA}`);
    }
    await ensureSchema(db, SCHEMA, 'mysql');
    await createSchemaMigrationsTable(db, SCHEMA, 'mysql');

    const files = [
      { filename: '001_good.sql', content: `CREATE TABLE ${SCHEMA}.metrics (id INT)` },
      { filename: '002_evil.sql', content: 'DROP TABLE metrics' }
    ];
    await assert.rejects(
      () => applyMigrations(db, { schemaName: SCHEMA, dialect: 'mysql', files }),
      /PKG_DDL_FORBIDDEN|forbidden|blocked/i
    );
    // 001 not applied (sandbox blocks before any execute)
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${SCHEMA}.schema_migrations`);
    assert.strictEqual(Number(rows[0].n), 0);
  } finally {
    try { await dropSchema(db, SCHEMA, 'mysql'); } catch {}
    try { await close(); } catch {}
  }
});

test('ddl-apply: dropSchema is idempotent (best-effort swallow)', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();

  try {
    // Drop a non-existent schema — must not throw
    await dropSchema(db, 'pkg_does_not_exist_xyz', 'mysql');
    // Drop a real schema
    await ensureSchema(db, SCHEMA, 'mysql');
    await dropSchema(db, SCHEMA, 'mysql');
    assert.strictEqual(await schemaExists(db, SCHEMA, 'mysql'), false);
  } finally {
    try { await close(); } catch {}
  }
});
