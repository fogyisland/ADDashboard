// migration-parser.test.js — verify CREATE TABLE extraction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCreateTables, parseAllCreateTables } from '../../src/services/migration-parser.js';

test('parseCreateTables: extracts a single CREATE TABLE block', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ad_users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'viewer',
      last_login_at DATETIME NULL,
      UNIQUE KEY uq_ad_users_username (username)
    ) ENGINE=InnoDB;
  `;
  const tables = parseCreateTables(sql);
  assert.ok(tables.has('ad_users'));
  const cols = tables.get('ad_users').columns.map((c) => c.name);
  assert.deepEqual(cols, ['id', 'username', 'role', 'last_login_at']);
  const username = tables.get('ad_users').columns.find((c) => c.name === 'username');
  assert.equal(username.nullable, false);
  const lastLogin = tables.get('ad_users').columns.find((c) => c.name === 'last_login_at');
  assert.equal(lastLogin.nullable, true);
});

test('parseCreateTables: parses multiple tables from one file', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ad_users (id INT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ad_sites (id INT PRIMARY KEY, name VARCHAR(64) NOT NULL);
  `;
  const tables = parseCreateTables(sql);
  assert.equal(tables.size, 2);
  assert.ok(tables.has('ad_users'));
  assert.ok(tables.has('ad_sites'));
});

test('parseCreateTables: supports backtick / double-quote / bracket identifiers', () => {
  const sql = `
    CREATE TABLE \`ad_users\` (id INT PRIMARY KEY);
    CREATE TABLE "ad_sites" (id INT PRIMARY KEY);
    CREATE TABLE [ad_roles] (id INT PRIMARY KEY);
  `;
  const tables = parseCreateTables(sql);
  assert.ok(tables.has('ad_users'));
  assert.ok(tables.has('ad_sites'));
  assert.ok(tables.has('ad_roles'));
});

test('parseCreateTables: ignores PRIMARY KEY / UNIQUE KEY / KEY lines', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ad_users (
      id BIGINT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_username (username),
      KEY ix_role (role)
    );
  `;
  const tables = parseCreateTables(sql);
  const cols = tables.get('ad_users').columns.map((c) => c.name);
  assert.deepEqual(cols, ['id', 'username']);
});

test('parseAllCreateTables: walks db/schema and db/migrations trees', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  try {
    const schemaDir = path.join(tmp, 'db', 'schema');
    const migDir = path.join(tmp, 'db', 'migrations');
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(schemaDir, '01-tables.sql'),
      'CREATE TABLE IF NOT EXISTS ad_users (id INT PRIMARY KEY, username VARCHAR(64) NOT NULL);');
    fs.writeFileSync(path.join(migDir, '017-heartbeat.sql'),
      'CREATE TABLE IF NOT EXISTS ad_agent_heartbeat (agent_id VARCHAR(64) PRIMARY KEY);');
    const tables = parseAllCreateTables(tmp);
    assert.ok(tables.has('ad_users'));
    assert.ok(tables.has('ad_agent_heartbeat'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression: AUTO_INCREMENT / PRIMARY KEY must NOT be folded into the
// type. The captured type for `id BIGINT AUTO_INCREMENT PRIMARY KEY`
// should be just `BIGINT`, with AUTO_INCREMENT + PRIMARY KEY consumed
// by the trailing-options group. Same for VARCHAR NOT NULL (must not
// include `NOT` in the type).
test('parseCreateTables: type captures only the canonical type, not trailing attributes', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS ad_users (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      age INT UNSIGNED,
      seq INT ZEROFILL
    );
  `;
  const tables = parseCreateTables(sql);
  const cols = Object.fromEntries(tables.get('ad_users').columns.map((c) => [c.name, c]));
  assert.equal(cols.id.type, 'BIGINT');
  assert.equal(cols.username.type, 'VARCHAR(64)');
  assert.equal(cols.age.type, 'INT UNSIGNED');
  assert.equal(cols.seq.type, 'INT ZEROFILL');
});