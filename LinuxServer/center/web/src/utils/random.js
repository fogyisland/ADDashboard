// Polyfill crypto.randomUUID() for browsers that lack it.
//
// Web Crypto's randomUUID() was added in Chrome 92 (2021-07), Firefox 95
// (2021-12), and Safari 15.4 (2022-03). Older browsers (and some embedded
// webviews) ship crypto.getRandomValues() but not randomUUID() — and a few
// browsers also gate randomUUID() behind a secure context (HTTPS / localhost),
// so even a "modern" browser can produce the same error on an http:// page.
//
// Failure mode: the init wizard's finalize() step throws
//   "crypto.randomUUID is not a function"
// and the user cannot complete initialization. This module replaces that call
// with an RFC 4122 v4 UUID built from getRandomValues() (universally available
// since IE 11, and works in any context — secure or not).
//
// We install the polyfill as a side-effect at import time so existing
// `crypto.randomUUID()` call sites keep working without code changes, and
// the native implementation is preferred when available (avoids a wasted
// polyfill evaluation on every modern browser load).

function buildV4Uuid(getRandom) {
  // 16 random bytes → 128 bits of entropy → format with v4 + variant markers.
  const bytes = getRandom(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20, 32)
  );
}

function ensurePolyfill(cryptoObj) {
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error(
      'Web Crypto API is unavailable in this environment: ' +
      'crypto.getRandomValues is required for secure token generation. ' +
      'This browser is too old to run the AD Dashboard init wizard.'
    );
  }
  if (typeof cryptoObj.randomUUID !== 'function') {
    // Bind the implementation so the `this` value inside randomUUID() is the
    // crypto object — keep cryptoObj.getRandomValues callable from the closure.
    cryptoObj.randomUUID = function () {
      return buildV4Uuid((arr) => cryptoObj.getRandomValues(arr));
    };
  }
}

ensurePolyfill(typeof globalThis !== 'undefined' ? globalThis.crypto : undefined);

export function randomUUID() {
  // Re-check at call time — some test harnesses replace globalThis.crypto
  // after module load. Cheap (one typeof + one function-call indirection).
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(
      'crypto.randomUUID is not available — Web Crypto polyfill not installed. ' +
      'Ensure the init wizard bundle includes utils/random.js at module init.'
    );
  }
  return globalThis.crypto.randomUUID();
}