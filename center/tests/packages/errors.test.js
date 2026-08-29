import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PkgError } from '../../src/packages/errors.js';

describe('PkgError.statusFor', () => {
  it('maps PKG_UNSUPPORTED_TYPE to 400', () => {
    assert.equal(PkgError.statusFor('PKG_UNSUPPORTED_TYPE'), 400);
  });
  it('maps PKG_UNSUPPORTED_VERSION to 400', () => {
    assert.equal(PkgError.statusFor('PKG_UNSUPPORTED_VERSION'), 400);
  });
  it('preserves the status on constructed PkgError instances', () => {
    const e = new PkgError('PKG_UNSUPPORTED_TYPE', 'bad type');
    assert.equal(e.status, 400);
    assert.equal(e.code, 'PKG_UNSUPPORTED_TYPE');
    assert.equal(e.name, 'PkgError');
  });
  it('maps PKG_REGISTRY_UNREACHABLE to 502', () => {
    assert.equal(PkgError.statusFor('PKG_REGISTRY_UNREACHABLE'), 502);
  });
  it('maps PKG_REGISTRY_INVALID to 502', () => {
    assert.equal(PkgError.statusFor('PKG_REGISTRY_INVALID'), 502);
  });
  it('maps PKG_CHECKSUM_MISMATCH to 400', () => {
    assert.equal(PkgError.statusFor('PKG_CHECKSUM_MISMATCH'), 400);
  });
  it('maps PKG_AGENT_INCOMPATIBLE to 400', () => {
    assert.equal(PkgError.statusFor('PKG_AGENT_INCOMPATIBLE'), 400);
  });
  it('maps PKG_CENTER_INCOMPATIBLE to 400', () => {
    assert.equal(PkgError.statusFor('PKG_CENTER_INCOMPATIBLE'), 400);
  });
  // 2026-08-29 R66 — script-service codes (unprefixed). T7 router reads
  // e.status to set the HTTP response; without these entries validation
  // errors fall back to 500 instead of the correct 400/404/409/413.
  it('R66 maps PACKAGE_EXISTS to 409', () => {
    assert.equal(PkgError.statusFor('PACKAGE_EXISTS'), 409);
  });
  it('R66 maps PACKAGE_NOT_FOUND to 404', () => {
    assert.equal(PkgError.statusFor('PACKAGE_NOT_FOUND'), 404);
  });
  it('R66 maps SCRIPT_TOO_LARGE to 413', () => {
    assert.equal(PkgError.statusFor('SCRIPT_TOO_LARGE'), 413);
  });
  it('R66 maps validation errors to 400', () => {
    for (const c of ['INVALID_NAME', 'INVALID_CONTENT', 'INVALID_TYPE', 'INVALID_AGENT_TYPE',
                     'INVALID_INTERVAL', 'INVALID_TIMEOUT', 'INVALID_SCOPE', 'EMPTY_POLICY']) {
      assert.equal(PkgError.statusFor(c), 400, `${c} should map to 400`);
    }
  });
  it('R66 unknown code still falls back to 500', () => {
    assert.equal(PkgError.statusFor('SOMETHING_NEW'), 500);
  });
});