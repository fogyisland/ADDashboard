import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig parses required keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'appsettings.json');
  writeFileSync(path, JSON.stringify({
    mysql: { host: 'localhost', port: 3306, database: 'AD_Monitoring', user: 'root', password: 'pw' },
    listenPort: 8080,
    jwtSecret: 'abc',
    agentToken: 'tok',
    staticDir: 'C:/web',
    logLevel: 'info',
    env: 'dev'
  }));
  const cfg = loadConfig(path);
  assert.equal(cfg.listenPort, 8080);
  assert.equal(cfg.agentToken, 'tok');
  rmSync(dir, { recursive: true });
});

test('loadConfig throws if required key missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'appsettings.json');
  writeFileSync(path, JSON.stringify({ listenPort: 8080 }));
  assert.throws(() => loadConfig(path), /required key/);
  rmSync(dir, { recursive: true });
});
