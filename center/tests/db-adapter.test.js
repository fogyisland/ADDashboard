import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../src/db/sql.js';
import { DbError } from '../src/db/errors.js';

// --- buildSql ---

test('buildSql(mysql) returns frozen object with all expected domains', () => {
  const sql = buildSql('mysql');
  assert.equal(Object.isFrozen(sql), true);
  for (const domain of ['health', 'replication', 'discovery', 'users', 'roles', 'config', 'audit', 'sites', 'dcs', 'dashboard', 'heartbeat']) {
    assert.ok(sql[domain], `missing domain: ${domain}`);
    assert.equal(Object.isFrozen(sql[domain]), true);
  }
});

test('buildSql(unknown) throws', () => {
  assert.throws(() => buildSql('postgres'), /unknown dialect/);
});

// --- DbError normalization ---

test('DbError.wrap: mysql ER_DUP_ENTRY -> DUP_ENTRY', () => {
  const e = new Error('Duplicate entry');
  e.code = 'ER_DUP_ENTRY';
  const wrapped = DbError.wrap(e);
  assert.ok(wrapped instanceof DbError);
  assert.equal(wrapped.code, 'DUP_ENTRY');
});

test('DbError.wrap: mssql EREQUEST with number 2627 -> DRIVER_ERROR (caller checks sqlState)', () => {
  const e = new Error('Violation of UNIQUE KEY constraint');
  e.code = 'EREQUEST';
  e.number = 2627;
  const wrapped = DbError.wrap(e);
  assert.equal(wrapped.code, 'DRIVER_ERROR');
  assert.equal(wrapped.sqlState, '2627');
});

test('DbError.wrap: passes through already-wrapped DbError', () => {
  const original = new DbError(new Error('x'), { code: 'X' });
  assert.strictEqual(DbError.wrap(original), original);
});

test('DbError.wrap: unknown error -> code UNKNOWN', () => {
  const wrapped = DbError.wrap(new Error('boom'));
  assert.equal(wrapped.code, 'UNKNOWN');
});