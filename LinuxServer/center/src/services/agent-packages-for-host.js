// mergePackagesForHost — pure function that combines the global
// `package_scripts + package_policies` (T14) list with the per-host
// `ad_member_server_packages` rows to produce the final manifest list
// served to a non-AD agent on heartbeat.
//
// Spec contract (Task 8 of the non-AD server management plan):
//   - Member-server rows win over global rows (same package name in both
//     → keep the member row's package, which must be non-ad type).
//   - Member-server rows with enabled=0 are dropped (disabled at the
//     per-host layer → package does not run on this host).
//   - A package in member_server_packages whose global manifest has
//     agent.type='ad' is dropped (type mismatch — DCs and member-servers
//     don't share packages).
//   - A package only in package_scripts+package_policies (no member row)
//     is treated as AD type (global) and surfaces for AD hosts.
//   - A package referenced only in ad_member_server_packages but missing
//     from the global tables is dropped (no script to run — the agent
//     loop relies on the manifest for collection shape).
//
// All inputs are defensive: missing/empty arrays are equivalent to "no
// rows". The function is pure (no side effects, no DB calls) so it stays
// unit-testable without harness.
//
// R66 T14: the global list source moved from `installed_packages` (V0) to
// `package_scripts + package_policies` JOIN (V1). The pure-function
// signature is unchanged — the route hydrates the JOIN rows into manifest
// objects via bakeManifest (see runner.js:65) before passing them in.
//
// Exports a single named function `mergePackagesForHost` so the route
// handler can compose it after the two DB queries.

/**
 * @param {object} args
 * @param {Array<{name: string, agent?: {type?: string}}>} [args.installedGlobal]
 *   The hydrated manifests from `package_scripts + package_policies`
 *   (enabled=1, JOIN row hydrated via bakeManifest). The `agent` field is
 *   the parsed manifest's agent block; only `agent.type` is read.
 * @param {Array<{package_name: string, enabled: number|boolean}>} [args.memberServerPackages]
 *   The rows from `ad_member_server_packages` for the host.
 * @returns {Array<object>} The merged manifests (same shapes as
 *   `installedGlobal[]`); only the manifest objects are returned,
 *   not the DB rows.
 */
export function mergePackagesForHost({ installedGlobal, memberServerPackages } = {}) {
  const global = installedGlobal || [];
  const memberRows = memberServerPackages || [];

  const byName = new Map();

  // Member-server rows take precedence; their packages must be non-ad.
  // Track both enabled and disabled rows separately so a disabled row
  // can still block the global fallback for this host (the per-host
  // disable is "this host opts out", not "this row is silently ignored").
  for (const row of memberRows) {
    if (!row) continue;
    if (!row.package_name) continue;
    if (row.enabled) {
      byName.set(row.package_name, { source: 'member' });
    } else {
      byName.set(row.package_name, { source: 'disabled' });
    }
  }

  // Global packages are always ad (the V1 global
  // `package_scripts + package_policies` tables only contain AD-typed —
  // non-ad runtimes have their own per-host bind layer). Skip globals
  // that a member row already claimed (enabled OR disabled — the disabled
  // block is what makes the per-host opt-out work).
  for (const p of global) {
    if (!p || !p.name) continue;
    if (byName.has(p.name)) continue;
    byName.set(p.name, { source: 'global', manifest: p });
  }

  const out = [];
  for (const [name, meta] of byName) {
    if (meta.source === 'member') {
      // Find the global manifest so we can return the manifest (and run
      // the type-mismatch guard). If the manifest is missing locally —
      // e.g. the package was uninstalled but the per-host bind row wasn't
      // cleaned up — drop the entry: the agent has no script to run.
      const m = global.find(p => p.name === name);
      if (!m) continue;
      if (m.agent && m.agent.type !== 'non-ad') continue;
      out.push(m);
    } else if (meta.source === 'global') {
      out.push(meta.manifest);
    }
    // Disabled rows: nothing to surface AND the global is also blocked.
  }
  return out;
}
