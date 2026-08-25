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
  assert.equal(c.discoveryIntervalHours, 1);
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

test('loadConfig provides centerHost empty default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }));
  const c = loadConfig(p);
  assert.equal(c.centerHost, '');
  rmSync(dir, { recursive: true });
});

test('loadConfig provides scan defaults (scanOnBoot=true, scanOnRuntimeFail=true, threshold=5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }));
  const c = loadConfig(p);
  assert.equal(c.scanOnBoot, true);
  assert.equal(c.scanOnRuntimeFail, true);
  assert.equal(c.scanFailureThreshold, 5);
  rmSync(dir, { recursive: true });
});

test('loadConfig respects explicit scanOnBoot=false override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok',
    scanOnBoot: false, scanFailureThreshold: 10
  }));
  const c = loadConfig(p);
  assert.equal(c.scanOnBoot, false);
  assert.equal(c.scanFailureThreshold, 10);
  rmSync(dir, { recursive: true });
});

// 2026-08-24 round-8: PowerShell 5.1 `Set-Content -Encoding UTF8` writes a
// UTF-8 BOM (EF BB BF) into appsettings.json as a side-effect of its
// encoding mode. Node's JSON.parse rejects leading BOM bytes with
// `SyntaxError: Unexpected token` — so the agent's loadConfig strips
// them defensively. Test the strip behavior end-to-end (the round-trip the
// real installer produces) and the leading-only-strip guard.
test('loadConfig strips a leading UTF-8 BOM (PS 5.1 Set-Content wrote one)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-bom-'));
  const p = join(dir, 'a.json');
  // Simulate exactly what Register-ADDashboardAgent.ps1 used to write:
  //   $cfg | ConvertTo-Json | Set-Content -Encoding UTF8
  // which produces ﻿{...} (3 BOM bytes + JSON).
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const json = Buffer.from(JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }), 'utf8');
  writeFileSync(p, Buffer.concat([bom, json]));
  const c = loadConfig(p);
  assert.equal(c.centerUrl, 'http://center:8080');
  assert.equal(c.agentId, 'DC1');
  assert.equal(c.agentToken, 'tok');
  rmSync(dir, { recursive: true });
});

test('loadConfig still throws on syntactically invalid content (BOM strip does not mask errors)', () => {
  // The strip is leading-only so a stray embedded BOM still surfaces as
  // a parse error. Just guards against an overzealous "strip all BOMs"
  // future fix that would silently accept malformed JSON.
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-bad-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, '{ this is not json }');
  assert.throws(() => loadConfig(p), /JSON|SyntaxError|Unexpected/i);
  rmSync(dir, { recursive: true });
});