// R158.48 (2026-10-06) — GET /api/agent/upgrade endpoint + boot-time cache.
//
// Operator directive: agent should auto-sync JS code from centre via heartbeat
// version comparison, auto-download and replace locally, restart with status
// reporting.
//
// This router exposes a single GET endpoint that returns a JSON bundle of
// every agent JS file (agent.js + src/**/*.js + build-manifest.json), with
// per-file sha256 + base64. The agent compares its installedAgentVersion
// (heartbeat response envelope) to the cached targetAgentVersion; if newer, it
// pulls this endpoint, stages files, sha256-verifies, atomically renames over
// the live files, then SIGTERMs itself so NSSM relaunches.
//
// Source-of-truth: agent-upgrade-source.js (boot-time read of
// <repoRoot>/agent/build-manifest.json + tree walk). Refreshed only on
// `nssm restart center` — by design, no mid-flight cache invalidation.
//
// Auth: same `agentMw` as /api/agent/heartbeat (HMAC + 60s restart-grace
// window). Mount: 'web' (matches /config.json + /api/agent/packages — both
// are 8080; heartbeat mount doesn't need this since agent gets the
// upgradeAvailable flag from the heartbeat response first).

import { Router } from 'express';

// Module-level cache. Closed over by the route handler. Set once at boot
// from server.js (await getAgentUpgradeSource(join(repoRoot, 'agent'), logger))
// and read-only after that — the operator must `nssm restart center` to pick
// up new agent code. Intentionally NOT exported; the boot code holds the
// only setter and the route handler holds the only reader.
let _agentUpgradeSource = null;

// Setter — called once from server.js:boot-fingerprint. Idempotent: re-set
// overwrites previous (only used for tests). Never throws; logs to provided
// logger if available.
export function setAgentUpgradeSource(source, logger = null) {
  _agentUpgradeSource = source;
  if (source) {
    logger?.info?.({
      event: 'agent.upgrade.source.loaded',
      version: source.version,
      fileCount: source.fileCount,
      totalBytes: source.totalBytes,
      buildTime: source.buildTime,
      gitCommit: source.gitCommit
    }, 'agent upgrade source cached at boot');
  } else {
    logger?.warn?.({
      event: 'agent.upgrade.source.unavailable'
    }, 'agent upgrade source unavailable; upgradeAvailable will be false for all heartbeats');
  }
}

// Reader — used by the heartbeat envelope builder inside agent.js route
// to compute upgradeAvailable + upgradeVersion without traversing files.
// Returns null when source is not loaded.
export function getAgentUpgradeSourceSnapshot() {
  return _agentUpgradeSource;
}

// computeUpgradeEnvelope — pure helper, called from the heartbeat handler.
// Compares the heartbeat-reported agentVersion against the cached target.
// Always returns the upgradeVersion field even when same-version (defensive:
// the agent may be on an old client that asks regardless of envelope).
//
// R158.88.A (2026-10-13) — extend with rolloutStrategy field for kill-switch
//   + canary orchestration (R158.88.B). The 3rd field is read by old agent
//   binaries as a no-op (they only consume {upgradeAvailable, upgradeVersion}),
//   so this is a 0-fleet-redeploy change to the centre. Strategy precedence
//   (per-call, 0 cache):
//     gate.strategy === 'paused'  → strategy='paused',  upgradeAvailable forced false (熔断)
//     gate.strategy === 'canary'  → strategy='canary', upgradeAvailable gated by canaryBucket(reported, target, ratio)
//     gate.strategy === 'full'    → strategy='full',    upgradeAvailable normal
//     gate === null / undefined   → strategy='full',    upgradeAvailable normal (compat with pre-R158.88.B fleet)
//   When strategy != 'full' we deliberately null out upgradeVersion so the
//   agent's applyUpgradeDelivery line 143 short-circuits on
//   upgradeVersion.length === 0 — same shape as the existing 'unavailable'
//   path. 0 改 agent 端.
export function computeUpgradeEnvelope(agentVersion, rolloutGate = null) {
  if (!_agentUpgradeSource || !_agentUpgradeSource.available) {
    return { upgradeAvailable: false, upgradeVersion: null, rolloutStrategy: 'unavailable' };
  }
  const target = String(_agentUpgradeSource.version || '');
  const reported = String(agentVersion || '');
  const baseAvailable = target !== reported && target.length > 0;

  const gate = rolloutGate && typeof rolloutGate === 'object' ? rolloutGate : { strategy: 'full', canaryRatio: 100 };
  const gateStrategy = String(gate.strategy || 'full');
  const canaryRatio = Number.isFinite(Number(gate.canaryRatio)) ? Math.max(0, Math.min(100, Number(gate.canaryRatio))) : 100;

  let strategy;
  let upgradeAvailable = baseAvailable;
  let upgradeVersion = baseAvailable ? target : null;
  if (!baseAvailable) {
    strategy = 'full';  // same-version → no rollout to gate, fall through
  } else if (gateStrategy === 'paused') {
    strategy = 'paused';
    upgradeAvailable = false;
    upgradeVersion = null;  // R158.48 line 143 short-circuit shape
  } else if (gateStrategy === 'canary') {
    strategy = 'canary';
    const bucket = canaryBucket(reported, target, canaryRatio);
    if (!bucket) {
      upgradeAvailable = false;
      upgradeVersion = null;  // R158.48 line 143 short-circuit shape
    }
  } else {
    // 'full' or anything unknown → conservative default is 'full' (let the
    // upgrade through). Operator can flip the feature flag to 'paused' to
    // 熔断 instantly.
    strategy = 'full';
  }

  return { upgradeAvailable, upgradeVersion, rolloutStrategy: strategy };
}

// canaryBucket — pure helper. Stable hash of (reported+target) mod 100 < ratio
//   gives a deterministic per-host canary gate. R158.88.A 0 改 agent 端;
//   the agent only reads upgradeAvailable + upgradeVersion (the legacy 2-field
//   shape), the centre decides whether to gate. 0 状态 = always fall through.
function canaryBucket(reported, target, ratio) {
  if (ratio >= 100) return true;
  if (ratio <= 0) return false;
  // FNV-1a 32-bit on `${reported}|${target}` — same input always lands in
  // the same bucket across calls (no Date.now / no Math.random). Operators
  // raising the ratio deterministically expands the canary set.
  const s = `${reported}|${target}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h % 100) < ratio;
}

// registerAgentUpgradeRoutes — mounted on the web mount (8080) by
// agentRouter in src/routes/agent.js. Caller passes the auth middleware
// (agentMw) and the logger.
export function registerAgentUpgradeRoutes(router, { agentMw, logger }) {
  router.get('/api/agent/upgrade', agentMw, async (_req, res) => {
    // R158.69.3 (2026-10-10) — diagnostic log. fleet 升级链路是不是真走通,
    // 看 fleet GET /api/agent/upgrade 拉 bundle 的次数.
    logger.info?.({
      event: 'agent.upgrade.bundle.fetched',
      sourceAvailable: !!(_agentUpgradeSource && _agentUpgradeSource.available),
      targetVersion: _agentUpgradeSource?.version ?? null
    }, 'agent upgrade bundle fetched by fleet');
    if (!_agentUpgradeSource || !_agentUpgradeSource.available) {
      logger.warn?.({ event: 'agent.upgrade.404', path: '/api/agent/upgrade' },
        'agent upgrade bundle unavailable; returning 404');
      return res.status(404).json({ error: 'agent-source-unavailable' });
    }
    try {
      // Always return full bundle (no 304 short-circuit) — the agent's own
      // applyUpgradeDelivery module does the "already at target" idempotency
      // check before fetching, so this endpoint is the canonical bundle
      // authority. Mirror the bundle shape from /api/agent/packages/:name/script
      // (src/packages/runner.js:333-363) for consistency: {version, sha256, base64}.
      // Build-time stripping of `bytes` (raw length; only used at boot for the
      // 50 MB cap check) so the wire payload stays small.
      const wireFiles = _agentUpgradeSource.files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        base64: f.base64
      }));
      res.json({
        version: _agentUpgradeSource.version,
        buildTime: _agentUpgradeSource.buildTime,
        gitCommit: _agentUpgradeSource.gitCommit,
        fileCount: _agentUpgradeSource.fileCount,
        files: wireFiles
      });
    } catch (err) {
      logger.error?.({ err: err.message, event: 'agent.upgrade.500' },
        'agent upgrade bundle serve failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.87.6.5 (2026-10-12) — POST /api/agent/upgrade-result. Fleet
  //   端 applyUpgradeDelivery silent fail / applied 调这个端点报给
  //   中心. R158.69.3 lesson 1 100% 适用: 中心 log 是定位跨进程 silent
  //   bug 有效手段. R158.69.3 9:0 铁证 24h 后 16min 数据 envelope sent
  //   54129 : bundle fetched 34 : upgrade applied 0 = 0.1.4 进程 fleet
  //   端全拉 bundle 但 0 applied, 0 upgrade.error / 0 upgrade.skip =
  //   silent fail 100%. 加这个端点让 fleet 端 silent fail log 飞回中心.
  //   跟 envelope.sent / bundle.fetched 1:1 平行, 让 R158.69.2 lesson
  //   "不要凭静态分析, 必查实测 log" 100% 闭合.
  router.post('/api/agent/upgrade-result', agentMw, async (req, res) => {
    try {
      const body = req.body || {};
      const event = String(body.event || '');
      const reason = String(body.reason || '');
      const installedAgentVersion = String(body.installedAgentVersion || '');
      const upgradeVersion = String(body.upgradeVersion || '');
      const fileCount = Number(body.fileCount) || 0;
      const err = body.error ? String(body.error) : null;
      if (event === 'agent.upgrade.applied') {
        logger.info?.({
          event: 'agent.upgrade.applied',
          agentId: body.agentId ?? null,
          hostname: body.hostname ?? null,
          fromVersion: installedAgentVersion,
          toVersion: upgradeVersion,
          fileCount
        }, 'agent upgrade applied (fleet reported)');
      } else if (event === 'agent.upgrade.skip') {
        logger.warn?.({
          event: 'agent.upgrade.skip',
          agentId: body.agentId ?? null,
          hostname: body.hostname ?? null,
          reason,
          installedAgentVersion,
          upgradeVersion,
          err
        }, 'agent upgrade skipped (fleet reported)');
      } else if (event === 'agent.upgrade.error') {
        logger.error?.({
          event: 'agent.upgrade.error',
          agentId: body.agentId ?? null,
          hostname: body.hostname ?? null,
          err,
          stage: body.stage ?? null
        }, 'agent upgrade error (fleet reported)');
      } else {
        logger.warn?.({ event: 'agent.upgrade.unknown', receivedEvent: event },
          'agent upgrade result unknown event');
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error?.({ err: err.message, event: 'agent.upgrade-result.500' },
        'agent upgrade result log failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.87.6.5 (2026-10-12) — GET /api/agent/upgrade-push. 中心端 push
  //   bundle 端点, 跟 GET /api/agent/upgrade 1:1 平行. 唯一区别是 event
  //   log 改 'agent.upgrade.push.fetched'. 真值 = 当前 0 fleet binary 调
  //   (0.1.4 / 0.1.5 / 0.1.6 都不知道这个端点), 为**未来** fleet binary
  //   (0.1.8+) 铺路. R158.69.3 lesson 3 永远适用: 真生效还是 operator 端
  //   35 DC push 0.1.6 + Restart-Service (跟 R158.87.6.5 ship 0.1.5 时 1:1
  //   平行). 0 改 GET /api/agent/upgrade 端点 (R158.69.10 lesson "用到端点
  //   就新建, 端点不要改" 1:1 闭合).
  router.get('/api/agent/upgrade-push', agentMw, async (_req, res) => {
    logger.info?.({
      event: 'agent.upgrade.push.fetched',
      sourceAvailable: !!(_agentUpgradeSource && _agentUpgradeSource.available),
      targetVersion: _agentUpgradeSource?.version ?? null
    }, 'agent upgrade push bundle fetched by fleet');
    if (!_agentUpgradeSource || !_agentUpgradeSource.available) {
      logger.warn?.({ event: 'agent.upgrade.push.404', path: '/api/agent/upgrade-push' },
        'agent upgrade push bundle unavailable; returning 404');
      return res.status(404).json({ error: 'agent-source-unavailable' });
    }
    try {
      const wireFiles = _agentUpgradeSource.files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        base64: f.base64
      }));
      res.json({
        version: _agentUpgradeSource.version,
        buildTime: _agentUpgradeSource.buildTime,
        gitCommit: _agentUpgradeSource.gitCommit,
        fileCount: _agentUpgradeSource.fileCount,
        files: wireFiles
      });
    } catch (err) {
      logger.error?.({ err: err.message, event: 'agent.upgrade.push.500' },
        'agent upgrade push bundle serve failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.87.6.5 (2026-10-12) — POST /api/agent/upgrade-status. Fleet 端
  //   报 push 应用结果, 跟 POST /api/agent/upgrade-result 1:1 平行. 处理
  //   event='agent.upgrade.push.applied' / 'skip' / 'error' 三种, dispatch
  //   到 logger.info/warn/error 跟 0.1.6 1:1 平行. 真值 = 当前 0 fleet
  //   binary 调 (0.1.4 / 0.1.5 / 0.1.6 都不知道这个端点), 为**未来** fleet
  //   binary 铺路. R158.69.10 lesson "用到端点就新建, 端点不要改" 1:1 闭合.
  router.post('/api/agent/upgrade-status', agentMw, async (req, res) => {
    try {
      const body = req.body || {};
      const event = String(body.event || '');
      const reason = String(body.reason || '');
      const installedAgentVersion = String(body.installedAgentVersion || '');
      const upgradeVersion = String(body.upgradeVersion || '');
      const fileCount = Number(body.fileCount) || 0;
      const err = body.error ? String(body.error) : null;
      if (event === 'agent.upgrade.push.applied') {
        logger.info?.({
          event: 'agent.upgrade.push.applied',
          agentId: body.agentId ?? null,
          hostname: body.hostname ?? null,
          fromVersion: installedAgentVersion,
          toVersion: upgradeVersion,
          fileCount
        }, 'agent upgrade push applied (fleet reported)');
      } else if (event === 'agent.upgrade.push.skip') {
        logger.warn?.({
          event: 'agent.upgrade.push.skip',
          agentId: body.agentId ?? null,
          hostname: body.hostname ?? null,
          reason,
          installedAgentVersion,
          upgradeVersion,
          err
        }, 'agent upgrade push skipped (fleet reported)');
      } else if (event === 'agent.upgrade.push.error') {
        logger.error?.({
          event: 'agent.upgrade.push.error',
          agentId: body.agentId ?? null,
          hostname: body.hostname ?? null,
          err,
          stage: body.stage ?? null
        }, 'agent upgrade push error (fleet reported)');
      } else {
        logger.warn?.({ event: 'agent.upgrade.push.unknown', receivedEvent: event },
          'agent upgrade push status unknown event');
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error?.({ err: err.message, event: 'agent.upgrade-status.500' },
        'agent upgrade status log failed');
      res.status(500).json({ error: 'internal' });
    }
  });
}