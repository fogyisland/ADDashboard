import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../src/packages/manifest.js';

describe('validateManifest', () => {
  it('accepts a complete valid manifest', () => {
    const m = {
      name: 'ad-memory-monitor', version: '1.0.0', type: 'gauge',
      description: 'test', agent: { minVersion: '1.0.0', platforms: ['windows'], runtime: 'powershell', script: 'collect.ps1', timeoutMs: 30000, intervalSec: 60 },
      metrics: [{ key: 'mem_used_pct', label: 'Memory Used', unit: '%', thresholds: { warn: 75, crit: 90 } }],
      params: { schema: { type: 'object', properties: {} }, required: [] },
      widget: { type: 'builtin', component: 'GaugeTile' },
    };
    const r = validateManifest(m);
    assert.equal(r.valid, true);
  });
  it('rejects missing name', () => {
    const r = validateManifest({ version: '1.0.0', type: 'gauge' });
    assert.equal(r.valid, false);
  });
  it('rejects invalid type', () => {
    const r = validateManifest({ name: 'x', version: '1.0.0', type: 'invalid' });
    assert.equal(r.valid, false);
  });
  it('rejects metric key with dot', () => {
    const r = validateManifest({ name: 'x', version: '1.0.0', type: 'gauge', metrics: [{ key: 'a.b', label: 'L' }] });
    assert.equal(r.valid, false);
  });
  it('rejects unknown fields', () => {
    const r = validateManifest({ name: 'x', version: '1.0.0', type: 'gauge', unknown: 'field' });
    assert.equal(r.valid, false);
  });
});
