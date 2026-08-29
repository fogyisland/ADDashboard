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
import { mergePackagesForHost } from '../services/agent-packages-for-host.js';

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
      // parseManifest — handle both shapes:
      //   mysql2 (json column): already a JS object
      //   mssql (NVARCHAR): JSON string
      // Defensive: a corrupt JSON string should drop the row, not crash
      // the agent's package fetch.
      const parseManifest = (v) => {
        if (v == null) return null;
        if (typeof v === 'string') {
          try { return JSON.parse(v); } catch { return null; }
        }
        return v;
      };
      const installedGlobal = enabledRows
        .map((r) => {
          const manifest = parseManifest(r.manifest_json);
          if (!manifest || !manifest.name) return null;
          // JSON.parse(JSON.stringify(...)) is a cheap deep clone so the
          // upstream DB row's manifest object is never shared/mutated
          // (matches runner.js:73).
          const baked = JSON.parse(JSON.stringify(manifest));
          baked.agent = baked.agent || {};
          baked.agent.intervalSec = Number(r.interval_sec);
          baked.agent.timeoutMs = Number(r.timeout_ms);
          return baked;
        })
        .filter(Boolean);
      const merged = mergePackagesForHost({
        installedGlobal,
        memberServerPackages: memberRows
      });
      // T14: R66 bakes policy interval_sec/timeout_ms into the manifest
      // at hydration time. No more per-row override — the agent wire-format
      // reads pkg.manifest.agent.intervalSec directly. The V0
      // `installed_packages.interval_override_sec` column is gone
      // (migration 023 collapsed V0→V1 precedence at migration time).
      res.json({ items: merged });
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
