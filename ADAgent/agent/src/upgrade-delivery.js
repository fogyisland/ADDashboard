// R158.48 (2026-10-06) — agent auto-update consumer.
//
// Mirror of settings-delivery.js (R158.13 auto-delivery envelope):
//   1. Heartbeat response carries {upgradeAvailable, upgradeVersion} when the
//      centre has a newer agent bundle (boot-time cache from agent.js:49
//      VERSION vs <repoRoot>/agent/build-manifest.json).
//   2. applyUpgradeDelivery reads the envelope; if upgradeAvailable=true AND
//      upgradeVersion !== config.installedAgentVersion, fetches GET
//      /api/agent/upgrade (signed, 60s timeout, fetchUpgrade() helper in
//      reporter.js), gets {version, files: [{path, sha256, base64}, ...]}.
//   3. Stages each file under `<agentInstallDir>/.upgrade-staging/<version>/`,
//      sha256-verifies per file against the centre's bundle.
//   4. Atomically renames each staged file over the live `<agentInstallDir>/<path>`.
//   5. Persists config.installedAgentVersion atomically (writeAppsettingsPatchAtomic).
//   6. Appends an entry to `<agentInstallDir>/data/upgrade-history.json` (audit).
//   7. Cleans up staging dir.
//   8. Returns {applied, previousVersion, newVersion, fileCount, exiting: true}.
//   9. Caller (makeSendCallback) schedules setImmediate(() => process.kill(...SIGTERM))
//      so the return value reaches the caller first, then NSSM relaunches.
//
// Failure semantics (matches settings-delivery.js / agent-token-delivery.js):
//   - envelope absent                      → no shape change
//   - same-version (idempotent)            → no shape change
//   - staging mkdir fail                   → {applied: false, error}, NO SIGTERM
//   - bundle invalid / version skew        → {applied: false, error}, NO SIGTERM
//   - sha256 mismatch                      → rm staging, {applied: false, error}, NO SIGTERM
//   - rename EBUSY x 3 retry (Windows)     → rm staging, {applied: false, error}, NO SIGTERM
//   - persist appsettings fail             → log error, STILL return applied=true
//                                          (bundle is on disk; next boot retries persist)
//   - upgrade-history write fail           → log warn, STILL return applied=true
//   - the SIGTERM itself is best-effort; if it throws, the agent crashlogs
//     but NSSM still restarts on the next event.

import {
  mkdirSync, writeFileSync, readFileSync, renameSync, rmSync
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAppsettingsPatchAtomic } from './appsettings-writer.js';

const EBUSY_RETRY_COUNT = 3;
const EBUSY_RETRY_DELAY_MS = 250;

function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* tight spin — Windows lacks usleep */ }
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// R158.87.6.5 (2026-10-12) — fleet-side reportUpgradeResult helper.
//   Fleet 端 silent fail / applied 调这个 helper 报给中心, 让中心 log
//   收 fleet 端结果 (R158.69.3 lesson 1 100% 适用). 不抛错, best-effort.
//   跟 reporter.js fetchUpgrade 同 HMAC signing 模式走 _signedFetchJson
//   (60s restart-grace window 兼容性), 但通过动态 import 避开循环依赖.
async function reportUpgradeResult({ event, reason, installedAgentVersion, upgradeVersion, fileCount, error, stage, config, logger, fetchUpgradeResult }) {
  try {
    if (typeof fetchUpgradeResult !== 'function') return;
    const body = {
      event,
      reason: reason || '',
      installedAgentVersion: installedAgentVersion || '',
      upgradeVersion: upgradeVersion || '',
      fileCount: fileCount || 0,
      error: error || null,
      stage: stage || null,
      agentId: config?.agentId ?? null,
      hostname: config?.hostname ?? null
    };
    await fetchUpgradeResult(body);
  } catch (e) {
    logger?.warn?.({ event: 'agent.upgrade.result-report.warn', err: e?.message || String(e) },
      'agent upgrade result report failed (non-fatal)');
  }
}

// decodeBundleFile — validates + decodes one entry from the centre's bundle.
// Returns {decoded, sha256} on success; throws Error('sha256-mismatch:<path>')
// if the centre's sha256 doesn't match what we decoded locally.
function decodeBundleFile(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('invalid-file-entry');
  }
  if (typeof file.path !== 'string' || file.path.length === 0) {
    throw new Error('invalid-file-path');
  }
  if (typeof file.sha256 !== 'string' || file.sha256.length !== 64) {
    throw new Error('invalid-file-sha256');
  }
  if (typeof file.base64 !== 'string' || file.base64.length === 0) {
    throw new Error('invalid-file-base64');
  }
  // Defence: file paths must not escape <agentInstallDir>. Reject any path
  // containing '..' segments or absolute paths. The centre-side filter already
  // enforces this (only includes files under <repoRoot>/agent/) but we
  // belt-and-braces guard against a future centre-side bug that ships an
  // arbitrary path.
  if (file.path.includes('..') || /^[\\/]/.test(file.path)) {
    throw new Error(`unsafe-path:${file.path}`);
  }
  const decoded = Buffer.from(file.base64, 'base64');
  const actual = sha256Hex(decoded);
  if (actual !== file.sha256.toLowerCase()) {
    throw new Error(`sha256-mismatch:${file.path}`);
  }
  return { decoded };
}

// applyUpgradeDelivery — invoked after every postHeartbeat. Mirror of
// applySettingsDelivery's call shape ({result, agentInstallDir, config, ...}).
//
// Returns:
//   { applied: false }                                                       — no incoming payload
//   { applied: false, reason: 'no upgrade pending' }                         — envelope absent
//   { applied: false, reason: 'already at target' }                          — idempotent
//   { applied: false, error }                                                 — bundle / sha / io fail
//   { applied: true, previousVersion, newVersion, fileCount, exiting: true }  — bundle applied; caller SIGTERMs
export async function applyUpgradeDelivery({
  result,
  agentInstallDir,
  config,
  configPath,
  logger,
  fetchUpgrade,
  fetchUpgradeResult
}) {
  if (!result || !result.ok || !result.data) {
    // R158.87.6.5 (2026-10-12) — silent fail log. R158.69.3 铁证 envelope
    //   sent : bundle fetched = 54129 : 34 (R158.87.6.5 ship 24h 后 16min 数据)
    //   = 0.1.4 进程 fleet 端全拉 bundle, 但 0 applied. 0 upgrade.error /
    //   0 upgrade.skip = 100% silent fail. Line 102 早 return 时写 log,
    //   跟 R158.69.2 lesson "不要凭静态分析, 必查实测 log" 1:1 平行.
    logger?.warn?.({ event: 'agent.upgrade.skip', reason: 'no-result' },
      'agent upgrade skipped: result/data missing');
    await reportUpgradeResult({ event: 'agent.upgrade.skip', reason: 'no-result', config, logger, fetchUpgradeResult });
    return { applied: false };
  }
  const data = result.data;
  const upgradeAvailable = data.upgradeAvailable === true;
  const upgradeVersion = typeof data.upgradeVersion === 'string' ? data.upgradeVersion : '';
  if (!upgradeAvailable || upgradeVersion.length === 0) {
    return { applied: false };
  }
  // Idempotency — same-version short-circuit. Same shape as
  // applySettingsDelivery:18 monotonic guard.
  if (upgradeVersion === String(config.installedAgentVersion || '')) {
    // R158.87.6.5 (2026-10-12) — silent fail log. 0.1.4 进程 fleet 端
    //   appsettings installedAgentVersion 已经 0.1.4 (跟 binary 0.1.4 一致),
    //   中心 envelope upgradeAvailable: true, upgradeVersion: 0.1.5,
    //   applyUpgradeDelivery line 111 same-version 检查 = upgradeVersion 0.1.5
    //   vs installedAgentVersion 0.1.4, 不应触发. 但 0 applied 100% = 别的
    //   stage silent fail. Line 111 早 return 时写 log 排除这条路径,
    //   跟 line 102 silent fail log 1:1 平行 (R158.69.2 lesson 100% 适用).
    logger?.warn?.({ event: 'agent.upgrade.skip', reason: 'already-at-target',
        installedAgentVersion: config.installedAgentVersion, upgradeVersion },
      'agent upgrade skipped: already at target version');
    await reportUpgradeResult({ event: 'agent.upgrade.skip', reason: 'already-at-target',
        installedAgentVersion: config.installedAgentVersion, upgradeVersion, config, logger, fetchUpgradeResult });
    return { applied: false, reason: 'already at target' };
  }
  if (typeof agentInstallDir !== 'string' || agentInstallDir.length === 0) {
    logger?.error?.({ event: 'agent.upgrade.skip', reason: 'no-agent-install-dir' },
      'agent upgrade skipped: agentInstallDir missing');
    return { applied: false, error: 'no-agent-install-dir' };
  }
  if (typeof fetchUpgrade !== 'function') {
    logger?.error?.({ event: 'agent.upgrade.skip', reason: 'no-fetch-upgrade' },
      'agent upgrade skipped: fetchUpgrade helper missing');
    return { applied: false, error: 'no-fetch-upgrade' };
  }

  const previousVersion = String(config.installedAgentVersion || '');

  // Stage 1 — mkdir staging dir.
  const stagingDir = join(agentInstallDir, '.upgrade-staging', upgradeVersion);
  try {
    mkdirSync(stagingDir, { recursive: true });
  } catch (e) {
    logger?.error?.({ event: 'agent.upgrade.error', err: e.message, stagingDir },
      'agent upgrade staging mkdir failed; aborting');
    await reportUpgradeResult({ event: 'agent.upgrade.error', error: 'staging-mkdir-failed', stage: '1', config, logger, fetchUpgradeResult });
    return { applied: false, error: 'staging-mkdir-failed' };
  }

  // Stage 2 — fetch the bundle.
  let r;
  try {
    r = await fetchUpgrade();
  } catch (e) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    logger?.error?.({ event: 'agent.upgrade.error', err: e.message },
      'agent upgrade bundle fetch threw; aborting');
    await reportUpgradeResult({ event: 'agent.upgrade.error', error: 'fetch-threw', stage: '2', config, logger, fetchUpgradeResult });
    return { applied: false, error: 'fetch-threw' };
  }
  if (!r || !r.ok || !r.data || !Array.isArray(r.data.files) || typeof r.data.version !== 'string') {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // R158.87.6.5 (2026-10-12) — silent fail log 加 more 字段. R158.69.3
    //   铁证 0.1.4 进程拉 bundle 34 次 0 applied, 这里检查 r 真值.
    logger?.error?.({ event: 'agent.upgrade.error', status: r?.status, err: r?.error,
        hasData: !!r?.data, hasFiles: Array.isArray(r?.data?.files), hasVersion: typeof r?.data?.version === 'string' },
      'agent upgrade bundle invalid; aborting');
    await reportUpgradeResult({ event: 'agent.upgrade.error', error: 'invalid-bundle', stage: '2', config, logger, fetchUpgradeResult });
    return { applied: false, error: 'invalid-bundle' };
  }
  if (String(r.data.version) !== upgradeVersion) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    logger?.error?.({ event: 'agent.upgrade.error',
        envelopeVersion: upgradeVersion, bundleVersion: r.data.version },
      'agent upgrade bundle version skew; aborting');
    await reportUpgradeResult({ event: 'agent.upgrade.error', error: 'version-skew', stage: '2',
        installedAgentVersion: config.installedAgentVersion, upgradeVersion, config, logger, fetchUpgradeResult });
    return { applied: false, error: 'version-skew' };
  }

  // Stage 3 — write each file to staging, sha256-verifying as we go.
  const writeSettled = [];
  for (const file of r.data.files) {
    let decoded;
    try {
      decoded = decodeBundleFile(file).decoded;
    } catch (e) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
      logger?.error?.({ event: 'agent.upgrade.error', err: e.message, path: file?.path },
        'agent upgrade decode/sha failed; aborting');
      await reportUpgradeResult({ event: 'agent.upgrade.error', error: 'sha256-mismatch', stage: '3', config, logger, fetchUpgradeResult });
      return { applied: false, error: 'sha256-mismatch' };
    }
    const stagingPath = join(stagingDir, file.path);
    try {
      mkdirSync(join(stagingPath, '..'), { recursive: true });
    } catch { /* dir likely exists */ }
    try {
      writeFileSync(stagingPath, decoded);
    } catch (e) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
      logger?.error?.({ event: 'agent.upgrade.error', err: e.message, stagingPath },
        'agent upgrade staging write failed; aborting');
      return { applied: false, error: 'staging-write-failed' };
    }
    writeSettled.push(file.path);
  }

  // Stage 4 — atomic rename over live files. EBUSY retry mirrors the existing
  // package-manager.js:230-289 hardening for Windows NTFS (PS1 child processes
  // can briefly hold a handle to a .js file we're trying to overwrite).
  const renameErrors = [];
  for (const file of r.data.files) {
    const stagingPath = join(stagingDir, file.path);
    const livePath = join(agentInstallDir, file.path);
    let lastErr = null;
    for (let i = 0; i < EBUSY_RETRY_COUNT; i++) {
      try {
        renameSync(stagingPath, livePath);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (e.code === 'EBUSY' || e.code === 'EPERM') {
          sleepSync(EBUSY_RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }
    if (lastErr) {
      renameErrors.push({ path: file.path, code: lastErr.code, message: lastErr.message });
    }
  }
  if (renameErrors.length > 0) {
    // Leave staging in place — operator can inspect / retry next heartbeat.
    logger?.error?.({ event: 'agent.upgrade.error', failures: renameErrors },
      'agent upgrade rename failed for some files; leaving staging; will retry next heartbeat');
    await reportUpgradeResult({ event: 'agent.upgrade.error', error: 'rename-failed', stage: '4',
        upgradeVersion, fileCount: r.data.files.length, config, logger, fetchUpgradeResult });
    return { applied: false, error: 'rename-failed', failures: renameErrors };
  }

  // Stage 5 — persist installedAgentVersion atomically. Best-effort: log and
  // continue on failure (bundle is on disk; next heartbeat will retry the
  // persist). Mirror the R158.13 settings-delivery path.
  const w = writeAppsettingsPatchAtomic({
    path: configPath,
    patch: { installedAgentVersion: upgradeVersion }
  });
  if (!w.ok) {
    logger?.warn?.({ event: 'agent.upgrade.persist.warn', error: w.error, upgradeVersion },
      'agent upgrade bundle applied but persist failed; next heartbeat will retry persist');
  }

  // Stage 6 — append audit log to data/upgrade-history.json. Read-modify-write
  // with tmp+rename (same atomic pattern as appsettings-writer).
  try {
    const historyPath = join(agentInstallDir, 'data', 'upgrade-history.json');
    let history = [];
    try {
      const raw = readFileSync(historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    } catch {
      // missing or malformed — start fresh
    }
    history.push({
      at: new Date().toISOString(),
      fromVersion: previousVersion,
      toVersion: upgradeVersion,
      fileCount: r.data.files.length,
      files: r.data.files.map((f) => f.path),
      agentId: config?.agentId ?? null,
      hostname: config?.hostname ?? null
    });
    const tmpPath = historyPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(history, null, 2));
    renameSync(tmpPath, historyPath);
  } catch (e) {
    logger?.warn?.({ event: 'agent.upgrade.history.warn', err: e.message },
      'agent upgrade history append failed; non-fatal');
  }

  // Stage 7 — cleanup staging dir.
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Stage 8 — bump in-memory config so the next heartbeat payload reflects the
  // new version. The persistent appsettings.json was already updated above (or
  // will be retried next heartbeat).
  config.installedAgentVersion = upgradeVersion;

  logger?.info?.({
    event: 'agent.upgrade.applied',
    fromVersion: previousVersion,
    toVersion: upgradeVersion,
    fileCount: r.data.files.length,
    buildTime: r.data.buildTime ?? null,
    gitCommit: r.data.gitCommit ?? null
  }, 'agent upgrade applied; NSSM will relaunch');

  // R158.87.6.5 (2026-10-12) — fleet 端 applied 上报中心. R158.69.3
  //   9:0 铁证 24h 后 16min 数据 envelope sent 54129 : bundle fetched 34
  //   : upgrade applied 0, 加这一行让中心 log 收 fleet 端 applied.
  //   跟 envelope.sent / bundle.fetched 1:1 平行, R158.69.2 lesson 100% 闭合.
  await reportUpgradeResult({
    event: 'agent.upgrade.applied',
    installedAgentVersion: previousVersion,
    upgradeVersion,
    fileCount: r.data.files.length,
    config, logger, fetchUpgradeResult
  });

  // Stage 9 — emit the one-shot status event so the NEXT heartbeat body
  // forwards {last_upgrade_event} to the centre. makePayload in
  // heartbeat-callbacks.js reads this closure-captured ref.
  if (typeof config.__setLastUpgradeEvent === 'function') {
    config.__setLastUpgradeEvent({
      fromVersion: previousVersion,
      toVersion: upgradeVersion,
      completedAt: new Date().toISOString(),
      fileCount: r.data.files.length
    });
  }

  return {
    applied: true,
    previousVersion,
    newVersion: upgradeVersion,
    fileCount: r.data.files.length,
    exiting: true
  };
}