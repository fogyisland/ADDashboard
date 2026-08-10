// Manifest agent.type enum tests — verifies the optional `agent.type` field
// accepts "ad" and "non-ad" and rejects anything else. This is the contract
// between the WPF package designer (which authors the value) and the agent
// runtime (which reads it to switch behavior).
//
// Default (omitted agent.type) must still be accepted so existing manifests
// continue to validate — agents default to "ad" when the field is absent.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../src/packages/manifest.js';
import { validateRegistryIndex } from '../../src/packages/registry.js';

const baseAgent = { minVersion: '0.1.0', script: 'collect.ps1', intervalSec: 60 };

describe('validateManifest — agent.type enum', () => {
  it('accepts agent.type = "ad"', () => {
    const m = {
      name: 'x', version: '1.0.0', type: 'gauge',
      agent: { ...baseAgent, type: 'ad' },
    };
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('accepts agent.type = "non-ad"', () => {
    const m = {
      name: 'x', version: '1.0.0', type: 'gauge',
      agent: { ...baseAgent, type: 'non-ad' },
    };
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('rejects agent.type = "weird"', () => {
    const m = {
      name: 'x', version: '1.0.0', type: 'gauge',
      agent: { ...baseAgent, type: 'weird' },
    };
    const r = validateManifest(m);
    assert.equal(r.valid, false);
  });

  it('accepts manifest without agent.type (default = ad)', () => {
    const m = {
      name: 'x', version: '1.0.0', type: 'gauge',
      agent: { ...baseAgent },
    };
    const r = validateManifest(m);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});

describe('validateRegistryIndex — agent.type enum', () => {
  const basePkg = {
    name: 'ad-os-baseline',
    latestVersion: '1.0.0',
    type: 'gauge',
    versions: [
      { version: '1.0.0', package: 'x.zip', size: 100, sha256: 'a'.repeat(64) },
    ],
  };

  it('accepts agent.type = "ad"', () => {
    const idx = {
      version: 1,
      updatedAt: '2026-08-09T00:00:00Z',
      packages: [{ ...basePkg, agent: { type: 'ad' } }],
    };
    const r = validateRegistryIndex(idx);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('accepts agent.type = "non-ad"', () => {
    const idx = {
      version: 1,
      updatedAt: '2026-08-09T00:00:00Z',
      packages: [{ ...basePkg, agent: { type: 'non-ad' } }],
    };
    const r = validateRegistryIndex(idx);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('rejects agent.type = "weird"', () => {
    const idx = {
      version: 1,
      updatedAt: '2026-08-09T00:00:00Z',
      packages: [{ ...basePkg, agent: { type: 'weird' } }],
    };
    const r = validateRegistryIndex(idx);
    assert.equal(r.valid, false);
  });

  it('accepts registry entry without agent block (back-compat)', () => {
    const idx = {
      version: 1,
      updatedAt: '2026-08-09T00:00:00Z',
      packages: [{ ...basePkg }],
    };
    const r = validateRegistryIndex(idx);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});
