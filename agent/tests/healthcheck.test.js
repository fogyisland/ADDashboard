import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthChecks } from '../src/healthcheck.js';

test('runHealthChecks returns adModule boolean', async () => {
  const r = await runHealthChecks({ centerUrl: 'http://127.0.0.1:1', agentToken: 't', hostname: 'X' });
  assert.equal(typeof r.checks.adModule, 'boolean');
  assert.equal(typeof r.checks.center, 'boolean');
});