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

// R161.22 (2026-10-29) — 本代理只允许装**同血统**的包。
//
//   为什么需要这一层 (纵深防御, 不能只靠中心端):
//     中心端已经按血统分流了 (routes/agent-upgrade.js 的
//     selectUpgradeSource + /api/agent/upgrade-non-ad 端点), 但中心端的
//     分流是**配置/部署**层面的 —— 一旦有人把中心端的包源指错、或者代理
//     被手工喂了别的血统的 bundle, 后果是「成员服务器的 agent.js +
//     src/** 被换成 AD 代码」⇒ 成员服务器变成 DC 代理。
//
//   判定方式: bundle 里必须带一个 `build-manifest.json`, 且它的
//   `lineage` 字段**显式**等于 'noad'。
//     · noadagent/build-manifest.json 里本来就有 "lineage": "noad"
//       (R158.75 fork 时加的) ⇒ 正常路径 100% 通过。
//     · AD 血统的 build-manifest.json 没有 lineage 字段 (或将来是 'ad')
//       ⇒ 这里拒收 ⇒ 成员代理**宁可不动**也不变成 DC 代理。
//   ★ 这里是「显式要求」而不是「显式排除」: 中心端若回退到旧版本
//     (manifest 里没有 lineage 字段), 成员代理会拒收 —— 这是**故意的**,
//     因为「不升级」是可恢复的 (操作员手工推), 「血统被换掉」是不可恢复的。
const EXPECTED_LINEAGE = 'noad';

/**
 * checkBundleLineage — 纯函数: 从 bundle 的文件清单里读出血统并判定。
 *
 * 判定规则 (noad 端 = **显式要求**):
 *   · bundle 里没有 build-manifest.json      → ok:false 'missing-build-manifest'
 *   · build-manifest.json 解析不了            → ok:false 'manifest-unparsable'
 *   · lineage 字段不是 'noad' (含缺失 / 'ad') → ok:false 'lineage-mismatch'
 *   · lineage === 'noad'                      → ok:true
 *
 * 无 IO、无时钟、无第三方依赖 ⇒ 可离线断言 (回归网
 * Server/center/tests/agent-upgrade-lineage.test.js 直接 import 本函数)。
 *
 * @param {Array<{path?: string, base64?: string}>} files bundle 文件清单
 * @returns {{ok: boolean, reason: string|null, lineage: string|null}}
 */
export function checkBundleLineage(files) {
  const list = Array.isArray(files) ? files : [];
  const manifestEntry = list.find((f) => f && f.path === 'build-manifest.json');
  if (!manifestEntry) {
    return { ok: false, reason: 'missing-build-manifest', lineage: null };
  }
  let parsed = null;
  try {
    const decoded = Buffer.from(String(manifestEntry.base64 || ''), 'base64').toString('utf8');
    parsed = JSON.parse(decoded.replace(/^﻿/, ''));
  } catch {
    return { ok: false, reason: 'manifest-unparsable', lineage: null };
  }
  const lineage = typeof parsed?.lineage === 'string' ? parsed.lineage : null;
  if (lineage !== EXPECTED_LINEAGE) {
    return { ok: false, reason: 'lineage-mismatch', lineage };
  }
  return { ok: true, reason: null, lineage };
}

function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* tight spin — Windows lacks usleep */ }
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
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
  fetchUpgrade
}) {
  if (!result || !result.ok || !result.data) return { applied: false };
  const data = result.data;
  const upgradeAvailable = data.upgradeAvailable === true;
  const upgradeVersion = typeof data.upgradeVersion === 'string' ? data.upgradeVersion : '';
  if (!upgradeAvailable || upgradeVersion.length === 0) {
    return { applied: false };
  }
  // Idempotency — same-version short-circuit. Same shape as
  // applySettingsDelivery:18 monotonic guard.
  if (upgradeVersion === String(config.installedAgentVersion || '')) {
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
    return { applied: false, error: 'fetch-threw' };
  }
  if (!r || !r.ok || !r.data || !Array.isArray(r.data.files) || typeof r.data.version !== 'string') {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    logger?.error?.({ event: 'agent.upgrade.error', status: r?.status, err: r?.error },
      'agent upgrade bundle invalid; aborting');
    return { applied: false, error: 'invalid-bundle' };
  }
  if (String(r.data.version) !== upgradeVersion) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    logger?.error?.({ event: 'agent.upgrade.error',
        envelopeVersion: upgradeVersion, bundleVersion: r.data.version },
      'agent upgrade bundle version skew; aborting');
    return { applied: false, error: 'version-skew' };
  }

  // R161.22 (2026-10-29) — 血统校验。同源才装, 不同源一律拒收。
  //
  //   规则见 checkBundleLineage 的文档: bundle 必须带 build-manifest.json
  //   且 lineage 显式等于 'noad'。AD 包 / 老包 (无 lineage 字段) 都在这里
  //   被拒 ⇒ 成员服务器不会被别的血统的代码覆盖。
  //
  //   判定放在「已收到 bundle、还没写盘」这一步 —— 此时磁盘上还是干净的,
  //   拒收的代价是 0。
  const lineageVerdict = checkBundleLineage(r.data.files);
  if (!lineageVerdict.ok) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    logger?.error?.({ event: 'agent.upgrade.error',
        reason: lineageVerdict.reason,
        expectedLineage: EXPECTED_LINEAGE,
        bundleLineage: lineageVerdict.lineage },
      'agent upgrade bundle lineage mismatch; aborting (refuse to cross lineage)');
    return { applied: false, error: lineageVerdict.reason };
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