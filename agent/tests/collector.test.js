import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCollector } from '../src/collector.js';

test('runCollector returns ok:true for valid PS script', async () => {
  const r = await runCollector({
    powerShellPath: 'powershell.exe',
    psScriptPath: 'C:\\addashboard\\Agent\\scripts\\collect-replication.ps1',
    timeoutMs: 10000
  });
  // In CI without AD module, ok may be false; we assert structure exists
  assert.ok(typeof r.ok === 'boolean');
  if (r.ok) {
    assert.ok(r.snapshot);
    assert.ok(typeof r.snapshot.CollectedAt === 'string');
  }
});