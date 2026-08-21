// agent/src/appsettings-writer.js — atomic appsettings.json centerUrl rewrite.
//
// Pattern: read → parse → mutate → write-tmp → fsync → rename. The tmp+rename
// pair is atomic on the same volume on Windows + POSIX, so a crash mid-write
// leaves the original file intact. NEVER throws; all failure paths return
// { ok: false, error: '<reason>' }.

import {
  readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync
} from 'node:fs';

export function writeCenterUrlAtomic({ path, newUrl }) {
  // Defensive input check — caller passed garbage. Don't crash, return error.
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (typeof newUrl !== 'string' || !newUrl) {
    return { ok: false, error: 'invalid-newUrl' };
  }

  // 1. Read original
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  // 2. Parse
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  // 3. Mutate
  cfg.centerUrl = newUrl;

  // 4. Write tmp + fsync
  const tmpPath = `${path}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  // 5. Rename over original (atomic on same volume)
  try {
    renameSync(tmpPath, path);
  } catch (e) {
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true };
}

// 2026-08-21 UX redesign (auto-delivery): when the centre pushes a new
// agentToken + agentTokenVersion via the heartbeat response, the agent
// MUST persist both atomically so a crash mid-write can't leave the file
// with the new version pointing at the old credential (or vice versa).
// Same shape as writeCenterUrlAtomic: read → parse → mutate → write-tmp
// → fsync → rename. NEVER throws.
export function writeAgentTokenAtomic({ path, newToken, newVersion }) {
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (typeof newToken !== 'string' || !newToken) {
    return { ok: false, error: 'invalid-newToken' };
  }
  // Version is a non-negative integer (matches the centre's monotonic
  // counter). Accept anything truthy + coerce via Number; reject NaN/0
  // because version=0 means "fresh install, never seen a credential".
  const versionNum = Number(newVersion);
  if (!Number.isInteger(versionNum) || versionNum < 1) {
    return { ok: false, error: 'invalid-newVersion' };
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  cfg.agentToken = newToken;
  cfg.agentTokenVersion = versionNum;

  const tmpPath = `${path}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  try {
    renameSync(tmpPath, path);
  } catch (e) {
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true };
}