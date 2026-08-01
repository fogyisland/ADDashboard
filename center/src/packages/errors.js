// Package-specific errors. Extends the project-wide HttpError pattern from
// center/src/utils/errors.js (status + code) but lives in the packages module
// to keep package concerns colocated.
//
// Code convention: all package errors are prefixed PKG_ so log filters /
// audit logs can group them. statusFor() maps the canonical error codes to
// HTTP statuses used by the REST layer (Task 6).

export class PkgError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PkgError';
    this.code = code;
    this.status = PkgError.statusFor(code);
  }
  static statusFor(code) {
    return {
      PKG_INVALID_MANIFEST: 400,
      PKG_VALIDATION_FAILED: 400,
      PKG_UNSUPPORTED_TYPE: 400,
      PKG_UNSUPPORTED_VERSION: 400,
      PKG_NAME_CONFLICT: 409,
      PKG_NOT_FOUND: 404,
      PKG_AGENT_INCOMPATIBLE: 409,
      PKG_CENTER_INCOMPATIBLE: 409,
      PKG_REGISTRY_UNREACHABLE: 502,
      PKG_REGISTRY_INVALID: 502,
      PKG_CHECKSUM_MISMATCH: 502,
    }[code] || 500;
  }
}
