import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { getAgentConfig } from '../src/services/config.js';

test('loadConfig parses required keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'appsettings.json');
  writeFileSync(path, JSON.stringify({
    db: {
      dialect: 'mysql',
      mysql: { host: 'localhost', port: 3306, database: 'AD_Monitoring', user: 'root', password: 'pw' }
    },
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

test('getAgentConfig exposes discoveryIntervalHours from system_config', async () => {
  const pool = {
    async execute() {
      return [[
        { config_key: 'polling_interval_minutes', config_value: '10' },
        { config_key: 'latency_threshold_minutes', config_value: '90' },
        { config_key: 'heartbeat_interval_seconds', config_value: '3' },
        { config_key: 'discovery_interval_hours', config_value: '6' },
        { config_key: 'agent_token', config_value: 't0k' }
      ], []];
    }
  };
  const cfg = await getAgentConfig(pool);
  assert.equal(cfg.pollingIntervalMinutes, 10);
  assert.equal(cfg.latencyThresholdMinutes, 90);
  assert.equal(cfg.heartbeatIntervalSeconds, 3);
  assert.equal(cfg.discoveryIntervalHours, 6);
  assert.equal(cfg.agentToken, 't0k');
});

test('getAgentConfig defaults discoveryIntervalHours to 4 when missing', async () => {
  const pool = {
    async execute() {
      return [[], []];
    }
  };
  const cfg = await getAgentConfig(pool);
  assert.equal(cfg.discoveryIntervalHours, 4);
});
