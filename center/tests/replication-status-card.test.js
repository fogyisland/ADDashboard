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

test('partnersCount query exists for both dialects with dialect-specific time-shift syntax', () => {
  // MySQL must use INTERVAL ? MINUTE; MSSQL must use DATEADD(MINUTE, ...).
  // Both must filter out __dc_summary__ and bind 5 params (dcHost, window,
  // collectedAt, window, collectedAt) so the route's bind array matches.
  const mysqlSql = buildSql('mysql');
  assert.ok(mysqlSql.replication.partnersCount, 'mysql: partnersCount missing');
  assert.match(mysqlSql.replication.partnersCount,
    /INTERVAL\s+\?\s+MINUTE/i,
    'mysql partnersCount must use INTERVAL ? MINUTE');
  assert.match(mysqlSql.replication.partnersCount, /__dc_summary__/);
  const mysqlPlaceholders = (mysqlSql.replication.partnersCount.match(/\?/g) || []).length;
  assert.strictEqual(mysqlPlaceholders, 5,
    `mysql partnersCount must have 5 ? placeholders, got ${mysqlPlaceholders}`);

  const mssqlSql = buildSql('mssql');
  assert.ok(mssqlSql.replication.partnersCount, 'mssql: partnersCount missing');
  assert.match(mssqlSql.replication.partnersCount,
    /DATEADD\s*\(\s*MINUTE\s*,/i,
    'mssql partnersCount must use DATEADD(MINUTE, ...)');
  assert.doesNotMatch(mssqlSql.replication.partnersCount,
    /INTERVAL\s+\?\s+MINUTE/i,
    'mssql partnersCount must NOT use MySQL INTERVAL syntax');
  assert.match(mssqlSql.replication.partnersCount, /__dc_summary__/);
  const mssqlPlaceholders = (mssqlSql.replication.partnersCount.match(/\?/g) || []).length;
  assert.strictEqual(mssqlPlaceholders, 5,
    `mssql partnersCount must have 5 ? placeholders, got ${mssqlPlaceholders}`);
});