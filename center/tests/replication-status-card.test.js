import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../src/db/sql.js';

test('mysql upsertStatus binds 15 params and includes 4 new counter columns', () => {
  const sql = buildSql('mysql');
  const upsert = sql.replication.upsertStatus;
  const placeholders = (upsert.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, 15,
    `expected 15 ? placeholders in mysql upsertStatus, got ${placeholders}`);
  assert.match(upsert, /users_count/);
  assert.match(upsert, /groups_count/);
  assert.match(upsert, /gpos_count/);
  assert.match(upsert, /locked_count/);
  assert.match(upsert, /ON DUPLICATE KEY UPDATE.*users_count\s*=\s*VALUES\(users_count\)/s);
});

test('mssql upsertStatus binds 15 params via MERGE and includes 4 new counter columns', () => {
  const sql = buildSql('mssql');
  const upsert = sql.replication.upsertStatus;
  // The mssql driver rewrites ? -> @pN at execute() time, so the registry
  // holds SQL in `?` form (same as mysql). Count `?` placeholders here.
  const placeholders = (upsert.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, 15,
    `expected 15 ? placeholders in mssql upsertStatus, got ${placeholders}`);
  assert.match(upsert, /users_count/);
  assert.match(upsert, /groups_count/);
  assert.match(upsert, /gpos_count/);
  assert.match(upsert, /locked_count/);
  assert.match(upsert, /WHEN MATCHED THEN UPDATE SET[\s\S]*users_count\s*=\s*s\.users_count/);
});

test('latestSummaryPerDc query exists for both dialects and filters by __dc_summary__', () => {
  for (const dialect of ['mysql', 'mssql']) {
    const sql = buildSql(dialect);
    assert.ok(sql.replication.latestSummaryPerDc, `${dialect}: latestSummaryPerDc missing`);
    assert.match(sql.replication.latestSummaryPerDc, /__dc_summary__/);
    assert.match(sql.replication.latestSummaryPerDc, /ad_replication_status/i);
  }
});