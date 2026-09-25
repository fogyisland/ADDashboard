// R96 — boot-time dialect mismatch probe.
//
// Symptom (operator, 2026-09-25): centre installed with `db.dialect: 'mysql'`
// in appsettings.json but the real backend is MSSQL. The matrix endpoint
// returns an empty partner grid because the MySQL `allReplicationLinks`
// query (`... AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE`)
// explodes on MSSQL with error 195:
//   "'UTC_TIMESTAMP' is not a recognized built-in function name."
// The route catches the error and returns 500 "internal" — operator sees
// an empty matrix with no actionable hint that the install is misconfigured.
//
// Root cause: db.init() builds the driver + frozen SQL registry for the
// *configured* dialect without verifying the actual backend vendor. A
// fresh install whose wizard was filled out with `dialect: 'mysql'` but
// whose `connParams` happen to point at an MSSQL server silently produces
// a centre that talks MySQL SQL to MSSQL.
//
// Fix: after building the facade in db.init(), run a vendor-specific probe
// query (a function name only the actual backend recognises):
//   - dialect === 'mysql'  → probe `SELECT UTC_TIMESTAMP() AS v`
//   - dialect === 'mssql'  → probe `SELECT SYSUTCDATETIME() AS v`
// If the probe throws MSSQL error 195 / MySQL error 1305
// (`'<func>' is not a recognized built-in function name`), the configured
// dialect is wrong. Reject with an actionable message that names the
// configured dialect, names the detected backend, and tells the operator
// which appsettings.json key to flip.
//
// These tests cover the three behaviours:
//   1. happy path — probe succeeds, init() returns a usable facade
//   2. mysql configured + mssql backend (the operator's real case)
//   3. mssql configured + mysql backend (symmetric)
//
// Test seam: db.init(config, { driverFactory }) lets tests swap the
// real driver factory with a stub that throws the relevant error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close } from '../../src/db/index.js';

function mssqlError195(message) {
  const err = new Error(message);
  err.code = 'EREQUEST';
  err.number = 195;
  err.sqlMessage = message;
  return err;
}

function mysqlError1305(message) {
  const err = new Error(message);
  err.code = 'ER_SP_DOES_NOT_EXIST';
  err.errno = 1305;
  err.sqlState = '42000';
  return err;
}

test('R96 happy path — mysql probe succeeds, init returns a usable facade', async () => {
  let probeRan = false;
  const stubDriver = {
    dialect: 'mysql',
    execute: async () => ({ rows: [], affectedRows: 0 }),
    query: async (s) => {
      if (/UTC_TIMESTAMP/i.test(s)) {
        probeRan = true;
        return { rows: [{ v: new Date() }] };
      }
      return { rows: [] };
    },
    transaction: async () => null,
    healthcheck: async () => {},
    close: async () => {}
  };
  const result = await init(
    { db: { dialect: 'mysql', mysql: { host: 'x', database: 'x', user: 'x', password: 'x' } } },
    { driverFactory: () => stubDriver, bootstrapMigrations: async () => {} }
  );
  assert.ok(result, 'init must return the facade on happy path');
  assert.equal(result.dialect, 'mysql');
  assert.ok(result.sql, 'sql registry must be populated for the configured dialect');
  assert.ok(result.sql.dashboard, 'sql registry must contain the dashboard domain');
  assert.equal(probeRan, true, 'probe must have executed during init');
  await close();
});

test('R96 mysql configured + mssql backend — probe fails with actionable message', async () => {
  const stubDriver = {
    dialect: 'mysql',
    execute: async () => ({ rows: [], affectedRows: 0 }),
    query: async (s) => {
      if (/UTC_TIMESTAMP/i.test(s)) {
        throw mssqlError195(`'UTC_TIMESTAMP' is not a recognized built-in function name.`);
      }
      return { rows: [] };
    },
    transaction: async () => null,
    healthcheck: async () => {},
    close: async () => {}
  };
  await assert.rejects(
    () => init(
      { db: { dialect: 'mysql', mysql: { host: 'x', database: 'x', user: 'x', password: 'x' } } },
      { driverFactory: () => stubDriver, bootstrapMigrations: async () => {} }
    ),
    (err) => {
      assert.match(err.message, /mysql/i, 'message must mention the configured dialect (mysql)');
      assert.match(err.message, /mssql/i, 'message must mention the detected backend (mssql)');
      assert.match(err.message, /appsettings\.json/i, 'message must point at appsettings.json');
      assert.match(err.message, /db\.dialect/i, 'message must name the dialect key to change');
      return true;
    }
  );
});

test('R96 mssql configured + mysql backend — symmetric probe failure', async () => {
  const stubDriver = {
    dialect: 'mssql',
    execute: async () => ({ rows: [], affectedRows: 0 }),
    query: async (s) => {
      if (/SYSUTCDATETIME/i.test(s)) {
        throw mysqlError1305(`FUNCTION db.SYSUTCDATETIME does not exist`);
      }
      return { rows: [] };
    },
    transaction: async () => null,
    healthcheck: async () => {},
    close: async () => {}
  };
  await assert.rejects(
    () => init(
      { db: { dialect: 'mssql', mssql: { server: 'x', database: 'x', user: 'x', password: 'x' } } },
      { driverFactory: () => stubDriver, bootstrapMigrations: async () => {} }
    ),
    (err) => {
      assert.match(err.message, /mssql/i, 'message must mention the configured dialect (mssql)');
      assert.match(err.message, /mysql/i, 'message must mention the detected backend (mysql)');
      assert.match(err.message, /appsettings\.json/i);
      return true;
    }
  );
});

test('R96 happy path — mssql probe succeeds, init returns a usable facade', async () => {
  let probeRan = false;
  const stubDriver = {
    dialect: 'mssql',
    execute: async () => ({ rows: [], affectedRows: 0 }),
    query: async (s) => {
      if (/SYSUTCDATETIME/i.test(s)) {
        probeRan = true;
        return { rows: [{ v: new Date() }] };
      }
      return { rows: [] };
    },
    transaction: async () => null,
    healthcheck: async () => {},
    close: async () => {}
  };
  const result = await init(
    { db: { dialect: 'mssql', mssql: { server: 'x', database: 'x', user: 'x', password: 'x' } } },
    { driverFactory: () => stubDriver, bootstrapMigrations: async () => {} }
  );
  assert.ok(result);
  assert.equal(result.dialect, 'mssql');
  assert.ok(result.sql.dashboard);
  assert.equal(probeRan, true, 'mssql probe must have executed during init');
  await close();
});