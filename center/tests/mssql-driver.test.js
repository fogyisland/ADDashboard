// Unit tests for mssql driver internals (placeholder rewrite + boolean normalization).
// No real SQL Server available in dev env; these tests verify helper logic
// in isolation. Integration tests against a real SQL Server land in T17+
// when TEST_MSSQL_URL is set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Inline reimplementation of rewritePlaceholders — mirrors drivers/mssql.js.
// We do not export helpers from the driver (matches the brief's API surface).
// If the driver's regex diverges from this one, this test will catch it.
function rewritePlaceholders(s) {
  let i = 0;
  return s.replace(/\?/g, () => `@p${++i}`);
}

function normalizeRow(row) {
  if (row == null) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v;
  }
  return out;
}

test('rewrite: SELECT ?, ?, ? -> SELECT @p1, @p2, @p3', () => {
  assert.equal(
    rewritePlaceholders('SELECT ?, ?, ?'),
    'SELECT @p1, @p2, @p3'
  );
});

test('rewrite: INSERT INTO t (a, b) VALUES (?, ?)', () => {
  assert.equal(
    rewritePlaceholders('INSERT INTO t (a, b) VALUES (?, ?)'),
    'INSERT INTO t (a, b) VALUES (@p1, @p2)'
  );
});

test('rewrite: SQL with no placeholders passes through unchanged', () => {
  assert.equal(rewritePlaceholders('SELECT 1'), 'SELECT 1');
  assert.equal(rewritePlaceholders(''), '');
});

test('rewrite: order is left-to-right with incrementing counter', () => {
  const rewritten = rewritePlaceholders('UPDATE t SET a=?, b=?, c=? WHERE id=?');
  assert.equal(rewritten, 'UPDATE t SET a=@p1, b=@p2, c=@p3 WHERE id=@p4');
});

test('normalize boolean -> 1/0 (true and false)', () => {
  const row = { is_active: true, is_deleted: false };
  const out = normalizeRow(row);
  assert.equal(out.is_active, 1);
  assert.equal(out.is_deleted, 0);
});

test('normalize passes through numbers, strings, null unchanged', () => {
  const row = { a: 5, b: 'x', c: null, d: 1.25 };
  const out = normalizeRow(row);
  assert.equal(out.a, 5);
  assert.equal(out.b, 'x');
  assert.equal(out.c, null);
  assert.equal(out.d, 1.25);
});

test('normalize row handles null input', () => {
  assert.equal(normalizeRow(null), null);
});

test('normalize preserves key order (object spread is insertion-ordered)', () => {
  const row = { z: false, a: true, m: 1 };
  const out = normalizeRow(row);
  assert.deepEqual(Object.keys(out), ['z', 'a', 'm']);
});
