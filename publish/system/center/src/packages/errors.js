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
      // Legacy ZIP-installer codes (PKG_ prefix).
      PKG_INVALID_MANIFEST: 400,
      PKG_VALIDATION_FAILED: 400,
      PKG_UNSUPPORTED_TYPE: 400,
      PKG_UNSUPPORTED_VERSION: 400,
      PKG_CHECKSUM_MISMATCH: 400,
      PKG_AGENT_INCOMPATIBLE: 400,
      PKG_CENTER_INCOMPATIBLE: 400,
      PKG_NAME_CONFLICT: 409,
      PKG_NOT_FOUND: 404,
      PKG_REGISTRY_UNREACHABLE: 502,
      PKG_REGISTRY_INVALID: 502,
      PKG_DDL_FORBIDDEN: 400,
      PKG_DDL_INVALID_SQL: 400,
      PKG_SCHEMA_EXISTS: 409,
      PKG_CONFIRM_REQUIRED: 400,
      PKG_INSTALL_FAILED: 500,
      PKG_UPGRADE_FAILED: 500,
      PKG_METRIC_KEY_UNKNOWN: 400,
      PKG_METRIC_TYPE_MISMATCH: 400,
      PKG_METRIC_REQUIRED: 400,
      PKG_BUILTIN: 400,
      // 2026-08-29 R66 — script-service codes (unprefixed; see
      // src/packages/script-service.js). Routers consume e.status for HTTP
      // mapping; without these entries validation errors fall back to 500
      // instead of the correct 400/404/409.
      INVALID_NAME: 400,
      INVALID_CONTENT: 400,
      SCRIPT_TOO_LARGE: 413,
      INVALID_TYPE: 400,
      INVALID_AGENT_TYPE: 400,
      INVALID_INTERVAL: 400,
      INVALID_TIMEOUT: 400,
      INVALID_SCOPE: 400,
      EMPTY_POLICY: 400,
      PACKAGE_EXISTS: 409,
      PACKAGE_NOT_FOUND: 404,
    }[code] || 500;
  }
}
