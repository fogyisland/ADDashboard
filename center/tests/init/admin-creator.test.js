import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin, AdminConflictError } from '../../src/init/admin-creator.js';
import { buildMockDb } from '../helpers/db-mock.js';

test('createAdmin inserts with hashed password and returns insertId', async () => {
  const calls = [];
  const db = buildMockDb().withRecording(calls);
  // Override execute to inject custom responses while still recording calls.
  const origExecute = db.execute;
  db.execute = async (sql, params) => {
    calls.push({ sql, params: [...(params || [])] });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }], affectedRows: 0 };
    if (/INSERT INTO sys_users/.test(sql)) {
      // Fix defect #3: only 2 user-bound placeholders; role_id is a subquery.
      assert.strictEqual(params.length, 2);
      assert.strictEqual(params[0], 'admin');
      assert.ok(params[1].startsWith('$2'), 'password should be bcrypt-hashed');
      return { rows: [], affectedRows: 1, insertId: 42 };
    }
    return { rows: [], affectedRows: 0 };
  };
  const r = await createAdmin(db, { username: 'admin', password: 'hunter22pass' });
  assert.deepStrictEqual(r, { id: 42, username: 'admin' });
});

test('createAdmin throws AdminConflictError when admin already exists', async () => {
  const calls = [];
  const db = buildMockDb().withRecording(calls);
  db.execute = async (sql) => {
    calls.push({ sql, params: [] });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 1 }], affectedRows: 0 };
    throw new Error('INSERT should not run');
  };
  await assert.rejects(
    createAdmin(db, { username: 'admin', password: 'hunter22pass' }),
    AdminConflictError
  );
});

test('createAdmin mssql uses SELECT ... FROM shape', async () => {
  const calls = [];
  const db = buildMockDb([], { dialect: 'mssql' }).withRecording(calls);
  db.execute = async (sql, params) => {
    calls.push({ sql, params: [...(params || [])] });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }], affectedRows: 0 };
    if (/INSERT INTO sys_users/.test(sql)) {
      return { rows: [], affectedRows: 1, insertId: 7 };
    }
    return { rows: [], affectedRows: 0 };
  };
  const r = await createAdmin(db, { username: 'sa-admin', password: 'hunter22pass' });
  assert.strictEqual(r.id, 7);
  // Fix defect #2: stored SQL uses `?` placeholders; mssql driver rewrites
  // at execute() time. Assert against the stored form, not the rewritten one.
  const insertCall = calls.find(c => /INSERT INTO sys_users/.test(c.sql));
  assert.match(insertCall.sql, /SELECT\s+\?,\s+\?,/);
});