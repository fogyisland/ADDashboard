// Agent-facing endpoint serving the merged package list for a single
// member-server host. Lives on the webApp under
// /api/admin/agent/packages-for-host (Task 8 of the non-AD server
// management plan, spec §4.3 — surfaced to non-AD agents on heartbeat).
//
// Auth: agentToken (X-Agent-Token header) — matches the no-cross-poll
// rule with userAuth and is the same gate as agentRouter's `packages`
// subpath and the self-register endpoint.
//
// SQL: dual-dialect via db.sql.packageScripts.listEnabledGlobal and
// db.sql.serverGroups.listPackagesForHost — never hardcode
// `sql.mysql.foo` here. R66 T14 switched the global-list source from
// `installed_packages` to a JOIN of `package_scripts + package_policies`
// so the agent wire format is driven by the V1 schema (migration 023).
// Policy interval_sec/timeout_ms is baked into manifest.agent.* at
// hydration time, matching the bakeManifest shape from runner.js:65.

import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { getDb } from '../db/index.js';
import { buildManifestItems } from '../services/agent-packages-manifest.js';

// R161.21 (2026-10-29) — 「DB 行 → 上线 manifest 列表」这段逻辑已经
// 抽成零依赖的纯函数, 放在 services/agent-packages-manifest.js:
//   · 放 services/ 而不是本文件, 是为了让回归网
//     tests/agent-packages-scope.test.js 能同时 import 「服务端纯函数」
//     和「agent 端真谓词」(noadagent/src/non-ad-scheduler.js) 来断言
//     1:1 契约, 而不必把 express / mysql2 / mssql 拖进测试依赖里。
//   · 三个判定 (水合送 scope / 合并后挡住 AD 作用域 / agent 端字段 1:1)
//     的说明与断言全部落在那个模块 + 那条测试里, 本文件只负责取数与回包。
export function agentPackagesRouter({ config, logger }) {
  const r = Router();
  // I3: agentToken now resolves the bundle at request time via the db
  // facade (so a rotate+commit takes effect on the very next request).
  // Passing the old `config.agentToken` string would silently 503 every
  // request — Task 1 introduced this signature and Task 5 propagates it
  // to every caller. The handler body uses `getDb()` lazily so this
  // middleware is wired once at mount time. `logger` is optional and is
  // threaded in so a previous-token match emits the spec §5 warn.
  const agentMw = agentToken({ db: getDb(), logger });

  // GET /api/admin/agent/packages-for-host?hostname=...
  // Body: { items: Manifest[] } — the merged manifest list for the host.
  // 400 if hostname is missing; 401 if agent token is absent/wrong.
  r.get('/api/admin/agent/packages-for-host', agentMw, async (req, res) => {
    const { hostname } = req.query;
    if (!hostname) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'hostname required' } });
    }
    try {
      const db = getDb();
      // T14: JOIN helper reads from package_scripts + package_policies
      // (the V1 schema); policy interval_sec/timeout_ms is then baked
      // into manifest.agent.* at hydration time. Same pattern as
      // runner.js:65 bakeManifest, so the agent wire shape is byte-
      // identical to the /api/agent/packages endpoint.
      const [{ rows: enabledRows }, { rows: memberRows }] = await Promise.all([
        db.execute(db.sql.packageScripts.listEnabledGlobal, []),
        db.query(db.sql.serverGroups.listPackagesForHost, [hostname])
      ]);
      // R161.21 — 水合 / 合并 / 作用域收口三步全部收敛到纯函数
      // buildManifestItems (见文件头), 便于离线断言整条链路.
      const items = buildManifestItems({ enabledRows, memberRows });
      // T14: R66 bakes policy interval_sec/timeout_ms into the manifest
      // at hydration time. No more per-row override — the agent wire-format
      // reads pkg.manifest.agent.intervalSec directly. The V0
      // `installed_packages.interval_override_sec` column is gone
      // (migration 023 collapsed V0→V1 precedence at migration time).
      res.json({ items });
    } catch (e) {
      // Route is unaudited by design — agents retry on 5xx, no operator
      // action needed. Surface a stable shape so agent tests can match.
      const log = req?.log || null;
      if (log) log.error({ err: e.message, hostname }, 'agent-packages-for-host failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  return r;
}
