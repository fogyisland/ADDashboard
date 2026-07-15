import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig returns parsed values with defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }));
  const c = loadConfig(p);
  assert.equal(c.centerUrl, 'http://center:8080');
  assert.equal(c.pollingIntervalMinutes, 15);
  assert.equal(c.heartbeatIntervalSeconds, 5);
  assert.equal(c.discoveryIntervalHours, 4);
  assert.equal(c.psDiscoveryScriptPath, 'C:\\addashboard\\Agent\\scripts\\collect-discovery.ps1');
  assert.equal(c.healthCheckIntervalMs, 600_000);
  rmSync(dir, { recursive: true });
});

test('loadConfig throws on missing required', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({ centerUrl: 'http://x' }));
  assert.throws(() => loadConfig(p), /agentToken/);
  rmSync(dir, { recursive: true });
});

test('loadConfig rejects empty-string required value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080',
    agentId: 'DC1',
    agentToken: ''
  }));
  assert.throws(() => loadConfig(p), /agentToken/);
  rmSync(dir, { recursive: true });
});