// compat tests — SemVer range checks for agent vs manifest, and center vs
// manifest. Returns {ok, error?, code?}. checkAll combines both and tags
// failures with the appropriate PKG_AGENT_INCOMPATIBLE / PKG_CENTER_INCOMPATIBLE
// codes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentCompat, checkCenterCompat, checkAll } from '../../src/packages/compat.js';

describe('checkAgentCompat', () => {
  it('rejects agent 1.0.0 against manifest ^1.1.0', () => {
    const r = checkAgentCompat('1.0.0', { agent: { minVersion: '^1.1.0' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /1\.0\.0/);
  });
  it('accepts agent 1.2.0 against manifest ^1.1.0', () => {
    const r = checkAgentCompat('1.2.0', { agent: { minVersion: '^1.1.0' } });
    assert.equal(r.ok, true);
  });
  it('accepts when manifest has no agent constraint', () => {
    const r = checkAgentCompat('0.1.0', {});
    assert.equal(r.ok, true);
  });
});

describe('checkCenterCompat', () => {
  it('rejects center 1.0.0 below minVersion 1.5.0', () => {
    const r = checkCenterCompat('1.0.0', { center: { minVersion: '1.5.0' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /1\.0\.0/);
  });
  it('accepts center 1.5.0 at minVersion 1.5.0', () => {
    const r = checkCenterCompat('1.5.0', { center: { minVersion: '1.5.0' } });
    assert.equal(r.ok, true);
  });
  it('rejects center above maxVersion', () => {
    const r = checkCenterCompat('3.0.0', { center: { minVersion: '1.0.0', maxVersion: '^2.0.0' } });
    assert.equal(r.ok, false);
  });
});

describe('checkAll', () => {
  it('accepts when both agent and center are compatible', () => {
    const manifest = {
      agent: { minVersion: '^1.0.0' },
      center: { minVersion: '1.0.0', maxVersion: '^1.0.0' },
    };
    const r = checkAll('1.5.0', '1.2.0', manifest);
    assert.equal(r.ok, true);
  });
  it('tags agent failure with PKG_AGENT_INCOMPATIBLE', () => {
    const manifest = {
      agent: { minVersion: '^2.0.0' },
      center: { minVersion: '1.0.0' },
    };
    const r = checkAll('1.5.0', '1.2.0', manifest);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PKG_AGENT_INCOMPATIBLE');
  });
  it('tags center failure with PKG_CENTER_INCOMPATIBLE', () => {
    const manifest = {
      agent: { minVersion: '^1.0.0' },
      center: { minVersion: '3.0.0' },
    };
    const r = checkAll('1.5.0', '1.2.0', manifest);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PKG_CENTER_INCOMPATIBLE');
  });
});
