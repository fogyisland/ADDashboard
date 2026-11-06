// agent/src/appsettings-writer.js — atomic appsettings.json field rewrite.
//
// Pattern: read → parse → mutate → write-tmp → fsync → rename. The tmp+rename
// pair is atomic on the same volume on Windows + POSIX, so a crash mid-write
// leaves the original file intact. NEVER throws; all failure paths return
// { ok: false, error: '<reason>' }.
//
// R158.0.1.9 (2026-10-20): writeCenterUrlAtomic() removed. It existed only
// for the port-scanner recovery path (rewrite centerUrl to a discovered
// port); with the scanner gone it had no callers. writeAppsettingsPatchAtomic()
// below is unrelated and still used by token/settings/upgrade delivery.

import {
  readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync
} from 'node:fs';

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

// 2026-10-01 R158.13 — generic appsettings.json patch writer. Used by
// applySettingsDelivery when the centre pushes {agentSettings, client
// SettingsVersion}. Accepts an arbitrary key/value patch object
// (heartbeatIntervalSeconds, pollingIntervalMinutes, …) atomically.
// Same five-step pattern as the two specialised writers above:
//   read → parse → mutate → write-tmp + fsync → rename
// NEVER throws; returns { ok, error? }.
//
// The mutation is shallow — every key in `patch` overwrites the
// existing value. Unrelated keys are preserved verbatim (we re-write
// the entire parsed JSON object). Centre range/whitelist enforcement
// happens BEFORE the patch reaches this function; agent-side
// validatePatch (settings-delivery.js) is a defence-in-depth check.
export function writeAppsettingsPatchAtomic({ path, patch }) {
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid-patch' };
  }
  const entries = Object.entries(patch);
  if (entries.length === 0) {
    // Reject empty patches — there's nothing to apply and writing a
    // fresh mtime on appsettings.json would be a no-op side-effect.
    return { ok: false, error: 'empty-patch' };
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

  for (const [k, v] of entries) {
    cfg[k] = v;
  }

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