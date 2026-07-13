import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeConfig } from '../../src/init/config-writer.js';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('writeConfig writes appsettings.json with mysql dialect block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const path = join(dir, 'appsettings.json');
    writeConfig({
      path,
      dialect: 'mysql',
      connParams: { host: '127.0.0.1', port: 3306, database: 'ad_monitoring', user: 'root', password: 'pw' },
      listenPort: 8080,
      agentToken: 'tok',
      jwtSecret: 'sec',
      logLevel: 'info',
      env: 'prod',
      staticDir: './dist'
    });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(written.db.dialect, 'mysql');
    assert.strictEqual(written.db.mysql.host, '127.0.0.1');
    assert.strictEqual(written.db.mysql.port, 3306);
    assert.strictEqual(written.listenPort, 8080);
    assert.strictEqual(written.agentToken, 'tok');
    assert.strictEqual(written.jwtSecret, 'sec');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfig writes appsettings.json with mssql dialect block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const path = join(dir, 'appsettings.json');
    writeConfig({
      path,
      dialect: 'mssql',
      connParams: { server: 'sql.example.com', port: 1433, database: 'ad_monitoring', user: 'sa', password: 'pw', encrypt: false },
      listenPort: 8080,
      agentToken: 'tok',
      jwtSecret: 'sec',
      logLevel: 'info',
      env: 'prod',
      staticDir: './dist'
    });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(written.db.dialect, 'mssql');
    assert.strictEqual(written.db.mssql.server, 'sql.example.com');
    assert.strictEqual(written.db.mssql.port, 1433);
    assert.strictEqual(written.db.mssql.encrypt, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfig is atomic (writes .tmp then renames)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const path = join(dir, 'appsettings.json');
    writeConfig({
      path, dialect: 'mysql',
      connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080, agentToken: 'a', jwtSecret: 'j', logLevel: 'info', env: 'prod', staticDir: './d'
    });
    // After write, no .tmp file should remain
    const files = readdirSync(dir);
    assert.deepStrictEqual(files, ['appsettings.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});