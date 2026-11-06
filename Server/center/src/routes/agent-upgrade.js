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
// R161.22 (2026-10-29) — 纯逻辑外移到 services/agent-upgrade-envelope.js,
//   因为本模块 import 了 express ⇒ 本机 center/node_modules 是空的 ⇒
//   离线回归网没法 import 它。纯函数搬出去 ⇒ 可断言。
import {
  LINEAGE_AD, LINEAGE_NON_AD, normalizeLineage,
  selectUpgradeSource, computeUpgradeEnvelopeFrom
} from '../services/agent-upgrade-envelope.js';

// Module-level cache. Closed over by the route handler. Set once at boot
// from server.js (await getAgentUpgradeSource(join(repoRoot, 'agent'), logger))
// and read-only after that — the operator must `nssm restart center` to pick
// up new agent code. Intentionally NOT exported; the boot code holds the
// only setter and the route handler holds the only reader.
//
// R161.22 — 这是 **AD 血统** 的升级源 (34 台 DC 跑的那棵树)。
let _agentUpgradeSource = null;

// R161.22 (2026-10-29) — **non-AD 血统** 的升级源 (<repoRoot>/noadagent)。
//
//   为什么要有第二棵树: R158.48 建自动升级时只加载了
//   join(repoRoot, 'agent') (AD 血统), 于是 non-AD 代理也被告知
//   「有 0.1.9 可升」, 而 /api/agent/upgrade 吐的正是 AD 包 ⇒
//   成员代理会把 **AD 代码** 原子覆盖到自己的安装目录 ⇒ 成员服务器
//   变成 DC 代理。本轮把两棵树分开: AD 代理照旧拿 AD 包, non-AD
//   代理只拿 noad 包。
//
//   两棵树的源都不可用时 (LinuxServer 镜像里两棵都没有), 对应血统
//   的代理拿到的信封是 {upgradeAvailable:false, upgradeVersion:null}
//   ⇒ 代理端早退。**绝不**回退到另一棵树的源。
let _noadAgentUpgradeSource = null;

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

// R161.22 — non-AD 血统的升级源 setter / getter。跟 AD 那对 1:1 平行。
export function setNoadAgentUpgradeSource(source, logger = null) {
  _noadAgentUpgradeSource = source;
  if (source) {
    logger?.info?.({
      event: 'agent.upgrade.source.loaded',
      lineage: LINEAGE_NON_AD,
      version: source.version,
      fileCount: source.fileCount,
      totalBytes: source.totalBytes,
      buildTime: source.buildTime,
      gitCommit: source.gitCommit
    }, 'non-ad agent upgrade source cached at boot');
  } else {
    logger?.warn?.({
      event: 'agent.upgrade.source.unavailable',
      lineage: LINEAGE_NON_AD
    }, 'non-ad agent upgrade source unavailable; upgradeAvailable will be false for non-ad heartbeats');
  }
}

export function getNoadAgentUpgradeSourceSnapshot() {
  return _noadAgentUpgradeSource;
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
// R161.22 (2026-10-29) — 加 agentType 维度。**本函数是这次 P0 的修复点**:
//   之前不管来的是 AD 代理还是 non-AD 代理, 比的都是 AD 源的版本号,
//   所以成员代理永远被告知「有 AD 包可升」⇒ 它拉到的也是 AD 包 ⇒
//   成员服务器会被 AD 代码原子覆盖 ⇒ 成员服务器变成 DC 代理。
//   现在按血统选源, 且 non-AD 血统**绝不**回退到 AD 源
//   (selectUpgradeSource 的不变量)。
//   AD 路径的返回值逐字不变 (34 台 DC 零影响)。
//
//   @param {unknown} agentVersion  代理自报版本
//   @param {object|null} rolloutGate 灰度闸门 {strategy, canaryRatio}
//   @param {unknown} agentType     'ad' (默认) | 'non-ad'
export function computeUpgradeEnvelope(agentVersion, rolloutGate = null, agentType = LINEAGE_AD) {
  const source = selectUpgradeSource({
    ad: _agentUpgradeSource,
    nonAd: _noadAgentUpgradeSource
  }, agentType);
  return computeUpgradeEnvelopeFrom(source, agentVersion, rolloutGate);
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

  // R161.22 (2026-10-29) — GET /api/agent/upgrade-non-ad. **成员代理专用
  //   的升级包端点**, 吐的是 <repoRoot>/noadagent 那棵树 (non-AD 血统)。
  //
  //   为什么必须**新建端点**而不是给 /api/agent/upgrade 加个查询参数:
  //     · R158.69.10 lesson —— 「用到端点就新建, 端点不要改」。/api/agent/upgrade
  //       是已经随 34 台 DC 出厂的端点, 它的行为**逐字不变** (AD 代理照旧
  //       拿 AD 包), 本端点是**并行**的新端点。
  //     · 签名不含 URL (centre 的 agent-token.js:104 只对
  //       `hostname:agentId:body` 做 HMAC), 所以端点选择不能靠 URL 参数
  //       —— 那样任何代理都能声称自己是别的血统。端点本身就是血统声明。
  //
  //   成员代理的取包路径: noadagent/src/reporter.js 的 fetchUpgrade() 现在
  //   打这个端点。
  //
  //   源不可用时 (部署树里没有 noadagent/, 例如 LinuxServer 镜像) ⇒ 404,
  //   代理端 applyUpgradeDelivery 收到 'invalid-bundle' ⇒ 早退, 不升级。
  //   **绝不**回退到 AD 包。
  router.get('/api/agent/upgrade-non-ad', agentMw, async (_req, res) => {
    logger.info?.({
      event: 'agent.upgrade.nonad.bundle.fetched',
      sourceAvailable: !!(_noadAgentUpgradeSource && _noadAgentUpgradeSource.available),
      targetVersion: _noadAgentUpgradeSource?.version ?? null
    }, 'non-ad agent upgrade bundle fetched by fleet');
    if (!_noadAgentUpgradeSource || !_noadAgentUpgradeSource.available) {
      logger.warn?.({ event: 'agent.upgrade.nonad.404', path: '/api/agent/upgrade-non-ad' },
        'non-ad agent upgrade bundle unavailable; returning 404');
      return res.status(404).json({ error: 'agent-source-unavailable' });
    }
    try {
      const wireFiles = _noadAgentUpgradeSource.files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        base64: f.base64
      }));
      res.json({
        version: _noadAgentUpgradeSource.version,
        buildTime: _noadAgentUpgradeSource.buildTime,
        gitCommit: _noadAgentUpgradeSource.gitCommit,
        fileCount: _noadAgentUpgradeSource.fileCount,
        files: wireFiles
      });
    } catch (err) {
      logger.error?.({ err: err.message, event: 'agent.upgrade.nonad.500' },
        'non-ad agent upgrade bundle serve failed');
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