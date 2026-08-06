import { test, expect } from 'vitest';
import { parseVerifyMarker } from '../src/init/verify-marker.js';

test('parses single table marker', () => {
  const sql = '-- verify: table sys_config_audit\nCREATE TABLE foo (...);';
  expect(parseVerifyMarker(sql)).toEqual([
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

test('parses single column marker', () => {
  const sql = '-- verify: column ad_dcs.is_pdc\nALTER TABLE ...;';
  expect(parseVerifyMarker(sql)).toEqual([
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ]);
});

test('parses multiple markers in same file', () => {
  const sql = [
    '-- 001-foo.sql',
    '-- verify: column ad_sites.description',
    '-- verify: column ad_dcs.is_gc',
    'CREATE TABLE bar (...);'
  ].join('\n');
  expect(parseVerifyMarker(sql)).toEqual([
    { kind: 'column', name: 'ad_sites.description' },
    { kind: 'column', name: 'ad_dcs.is_gc' }
  ]);
});

test('returns empty array for SQL with no markers', () => {
  const sql = 'CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);';
  expect(parseVerifyMarker(sql)).toEqual([]);
});

test('stops scanning after 50 lines', () => {
  // 50 non-marker lines, then marker on line 51 — should NOT be parsed
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`-- comment line ${i}`);
  lines.push('-- verify: table should_not_be_seen');
  const sql = lines.join('\n');
  expect(parseVerifyMarker(sql)).toEqual([]);
});

test('ignores markers inside block comments', () => {
  const sql = [
    '/*',
    '-- verify: table inside_comment',
    '*/',
    '-- verify: table outside_comment',
    'CREATE TABLE foo;'
  ].join('\n');
  expect(parseVerifyMarker(sql)).toEqual([
    { kind: 'table', name: 'outside_comment' }
  ]);
});

test('case-insensitive verify keyword', () => {
  const sql = '-- VERIFY: TABLE sys_config_audit\n';
  expect(parseVerifyMarker(sql)).toEqual([
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

test('whitespace tolerant between tokens', () => {
  const sql = '--   verify:    table   sys_config_audit   \n';
  expect(parseVerifyMarker(sql)).toEqual([
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});