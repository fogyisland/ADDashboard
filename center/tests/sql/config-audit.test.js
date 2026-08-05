// config-audit.test.js — covers the config.audit SQL helper block
// for sys_config_audit (dual-dialect mysql + mssql). This is pure SQL-string
// shape validation; no DB required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';

test('config.audit.write: 5 placeholders', () => {
  const s = buildSql('mysql').config.audit.write;
  const ph = (s.match(/\?/g) || []).length;
  assert.equal(ph, 5);
});

test('config.audit.list: includes LEFT JOIN sys_users and ORDER BY changed_at DESC, id DESC LIMIT 20', () => {
  const s = buildSql('mysql').config.audit.list;
  assert.match(s, /FROM\s+sys_config_audit/i);
  assert.match(s, /LEFT\s+JOIN\s+sys_users/i);
  assert.match(s, /ORDER\s+BY\s+.*changed_at\s+DESC/i);
  assert.match(s, /LIMIT\s+20\b/);
});

test('config.audit.getById: WHERE id = ?', () => {
  const s = buildSql('mysql').config.audit.getById;
  assert.match(s, /WHERE\s+id\s*=\s*\?/i);
});

test('mssql audit.list uses TOP 20 instead of LIMIT', () => {
  const s = buildSql('mssql').config.audit.list;
  assert.match(s, /TOP\s+20\b/i);
  assert.doesNotMatch(s, /\bLIMIT\b/i);
});

test('mssql audit.write also has 5 placeholders', () => {
  const s = buildSql('mssql').config.audit.write;
  const ph = (s.match(/\?/g) || []).length;
  assert.equal(ph, 5);
});
