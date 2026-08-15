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
  return { ...row, manifest };
}

export function agentPackagesRouter({ config }) {
  const r = Router();
  const agentMw = agentToken(config.agentToken);

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
      const installedGlobal = installedRows
        .map(hydrateInstalledRow)
        .filter(r => r && r.manifest && r.manifest.name)
        .map(r => r.manifest);
      const merged = mergePackagesForHost({
        installedGlobal,
        memberServerPackages: memberRows
      });
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
