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
});