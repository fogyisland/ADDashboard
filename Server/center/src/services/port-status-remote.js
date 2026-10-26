// R114 — port-status-remote service helpers.
//
// Spec: docs/superpowers/specs/2026-09-26-r114-centre-remote-port-probe-design.md §4.1
//
// Two read helpers used by /api/dashboard/agents:
//   - listRemoteProbeForDcs(db, dcNames): full INNER JOIN of ad_remote_port_probe
//     × system_ports for the given DC subset. Each row is one (dc, port) pair.
//   - probeAtByDcs(db, dcNames): MAX(probe_at) per dc — the "lastConnectAt"
//     for the new "最后连接" column on /agents.
//
// Both dispatch via db.execute(sql, params). The SQL helpers live in
// db.sql.remotePortProbe (added to center/src/db/sql.js). Empty dcNames is a
// short-circuit (no DB hit) so callers don't have to gate separately.
//
// Defensive: rejects non-array dcNames up-front (matches the project's
// "defense in depth" rule — fail-fast on contract violation rather than
// silently producing wrong SQL with a one-element IN (...) clause).

import { ok } from 'node:assert/strict';

export async function listRemoteProbeForDcs(db, dcNames) {
  ok(Array.isArray(dcNames), 'dcNames must be array');
  if (dcNames.length === 0) return [];
  const placeholders = dcNames.map(() => '?').join(',');
  const res = await db.execute(
    db.sql.remotePortProbe.listForDcs(placeholders),
    dcNames
  );
  return res.rows || [];
}

export async function probeAtByDcs(db, dcNames) {
  ok(Array.isArray(dcNames), 'dcNames must be array');
  if (dcNames.length === 0) return [];
  const placeholders = dcNames.map(() => '?').join(',');
  const res = await db.execute(
    db.sql.remotePortProbe.probeAtByDcs(placeholders),
    dcNames
  );
  return res.rows || [];
}
