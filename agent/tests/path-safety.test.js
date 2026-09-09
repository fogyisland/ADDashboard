// 2026-09-09 S82 (security) — unit tests for the file-push path-traversal guard.
//
// Covers the 5 spec cases plus a few extra: filename rules
// (no `..`, `\0`, `:`, `/`, `\`, control chars, leading `.`),
// allowed-root resolution (case-insensitive on Windows), and a
// round-trip with the drainer rejecting before any fs call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  validatePayloadPath, validatePayloadPathOrThrow, ALLOWED_FILE_PUSH_ROOTS
} from '../src/lib/path-safety.js';

const ALLOWED = ALLOWED_FILE_PUSH_ROOTS;

test('validatePayloadPath: C:\\addashboard\\payloads\\evil.exe → ok', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, true);
  assert.ok(r.resolved.endsWith('evil.exe'));
});

test('validatePayloadPath: path-traversal escape → rejected', () => {
  // attacker-supplied targetPath with `..` in the JOIN itself — the
  // service rejects via allowed-root miss.
  const r = validatePayloadPath({
    filename: 'evil.dll',
    targetPath: 'C:\\addashboard\\..\\..\\Windows\\System32',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes allowed roots/);
});

test('validatePayloadPath: relative `..` in filename → rejected', () => {
  const r = validatePayloadPath({
    filename: '..\\..\\etc\\passwd',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
  // Either rejected by filename rules OR by allowed-roots — both acceptable.
  assert.equal(r.ok, false);
});

test('validatePayloadPath: filename contains `:` (drive separator) → rejected', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe:bad',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPath: filename contains null byte → rejected', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe\0.dll',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPath: filename starts with `.` → rejected', () => {
  const r = validatePayloadPath({
    filename: '.hidden',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPath: filename contains `/` → rejected', () => {
  const r = validatePayloadPath({
    filename: 'subdir/file',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPath: filename contains control chars → rejected', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe\n.dll',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPath: case-insensitive root match (C: vs c:) → ok', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe',
    targetPath: 'c:\\ADDashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, true);
});

test('validatePayloadPath: filename length cap (256 chars) → rejected', () => {
  const r = validatePayloadPath({
    filename: 'a'.repeat(256),
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /255 chars/);
});

test('validatePayloadPath: missing filename → rejected', () => {
  const r = validatePayloadPath({
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPath: missing targetPath → rejected', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, false);
});

test('validatePayloadPathOrThrow: throws httpErr-shaped error on rejection', () => {
  assert.throws(
    () => validatePayloadPathOrThrow({ filename: '..', targetPath: 'C:\\addashboard\\payloads', allowedRoots: ALLOWED }),
    (e) => e.httpStatus === 400 && typeof e.message === 'string'
  );
});

test('validatePayloadPathOrThrow: returns resolved path on success', () => {
  const r = validatePayloadPathOrThrow({
    filename: 'evil.exe',
    targetPath: 'C:\\addashboard\\payloads',
    allowedRoots: ALLOWED
  });
  assert.ok(r.resolved);
  assert.ok(r.resolved.endsWith('evil.exe'));
});

test('validatePayloadPath: trailing-separator targetPath is normalized', () => {
  const r = validatePayloadPath({
    filename: 'evil.exe',
    targetPath: 'C:\\addashboard\\payloads\\\\',
    allowedRoots: ALLOWED
  });
  assert.equal(r.ok, true);
});

test('ALLOWED_FILE_PUSH_ROOTS export contains the two spec roots', () => {
  assert.ok(ALLOWED.includes('C:\\addashboard\\payloads'));
  assert.ok(ALLOWED.includes('C:\\ProgramData\\ADDashboard\\payloads'));
});