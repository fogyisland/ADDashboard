// Agent-facing endpoint serving the merged package list for a single
// member-server host. Lives on the webApp under
// /api/admin/agent/packages-for-host (Task 8 of the non-AD server
// management plan, spec §4.3 — surfaced to non-AD agents on heartbeat).
//
// Auth: agentToken (X-Agent-Token header) — matches the no-cross-poll
// rule with userAuth and is the same gate as agentRouter's `packages`
// subpath and the self-register endpoint.
//
// SQL: dual-dialect via db.sql.installedPackages.listEnabled and
// db.sql.serverGroups.listPackagesForHost — never hardcode
// `sql.mysql.foo` here.

import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { getDb } from '../db/index.js';
import { mergePackagesForHost } from '../services/agent-packages-for-host.js';

// Hydrate a raw `installed_packages` row: parse `manifest_json` (JSON
// string in mssql, already-parsed object in mysql2) into the manifest
// field. The mysql2 driver returns json columns as JS objects; mssql
// returns them as JSON strings. Same approach as the inline `hydrate()`
// inside src/db/sql/installed-packages.js — duplicated here so this
// route doesn't have to import a service-of-services helper.
function hydrateInstalledRow(row) {
  if (!row) return row;
  // The column is `manifest_json` (string) in the DB schema. mysql2 may
  // have already auto-parsed it to `row.manifest` — fall back to that
  // when the column-shaped key isn't a string.
  let manifest = row.manifest_json;
  if (typeof manifest !== 'string') {
    manifest = row.manifest;
  }
  if (typeof manifest === 'string') {
    try { manifest = JSON.parse(manifest); } catch { manifest = null; }
  }
  return {
    ...row,
    manifest,
    // mysql2 returns INT columns as JS numbers; mssql returns them as
    // numbers too. Either way, surface as `intervalOverrideSec` (camelCase)
    // matching the rest of the admin API's shape.
    intervalOverrideSec: row.interval_override_sec == null ? null : Number(row.interval_override_sec)
  };
}

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
      // List global enabled packages; the SQL string returns raw rows
      // (manifest_json is a JSON string), so hydrate() parses the manifest
      // before handing the rows to mergePackagesForHost. Same pattern as
      // `installedPackages.list` in src/db/sql/installed-packages.js.
      const [{ rows: installedRows }, { rows: memberRows }] = await Promise.all([
        db.execute(db.sql.installedPackages.listEnabled, []),
        db.query(db.sql.serverGroups.listPackagesForHost, [hostname])
      ]);
      // mergePackagesForHost expects manifest objects (it reads p.name
      // and p.agent.type), not the raw DB rows. Map hydrated rows to
      // their parsed manifest, dropping any row whose manifest failed
      // to parse — a corrupted manifest_json column should not crash
      // the agent's package fetch.
      const hydrated = installedRows.map(hydrateInstalledRow);
      const installedGlobal = hydrated
        .filter(r => r && r.manifest && r.manifest.name)
        .map(r => r.manifest);
      const merged = mergePackagesForHost({
        installedGlobal,
        memberServerPackages: memberRows
      });
      // 2026-08-26 round-19 follow-up: apply per-package operator
      // interval overrides. The agent's setInterval is keyed on the
      // resolved interval (agent/src/non-ad-scheduler.js:32), so writing
      // a different intervalSec here causes the next applyPackageList
      // poll to clearInterval + start a fresh timer with the new
      // cadence. NULL overrides fall through to the manifest default,
      // which is what the manifest-validation minimum=5 already guards.
      // We mutate a shallow copy so the upstream DB row's manifest object
      // is never shared / mutated.
      const overridesByName = new Map(
        hydrated
          .filter(r => r && r.manifest && r.intervalOverrideSec != null)
          .map(r => [r.manifest.name, r.intervalOverrideSec])
      );
      const items = merged.map((m) => {
        if (!m || !m.agent) return m;
        const override = overridesByName.get(m.name);
        if (override == null) return m;
        return {
          ...m,
          agent: { ...m.agent, intervalSec: override }
        };
      });
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
