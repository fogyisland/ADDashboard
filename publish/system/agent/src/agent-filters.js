// agent-filters.js — agent-side filters for packages.
//
// The non-AD runtime fetches its manifest list from
// `/api/admin/agent/packages-for-host`, which returns the merged set of
// globally-enabled + server-group-bound packages for the calling hostname.
// Not every returned manifest is eligible for this agent — some are AD/DC
// only, some target Linux or macOS. The filter predicate selects the subset
// the non-AD Windows runtime should actually run.
//
// Exported as a named function so unit tests can import the SAME predicate
// the runtime uses — no re-statement, no drift.

// Pure function: returns true iff the manifest targets a non-AD agent on
// Windows. Defensive against missing fields — every property access is
// optional-chained, and a missing `agent` block simply rejects the package.
export function shouldRunPackageForNonAd(pkg) {
  return pkg?.agent?.type === 'non-ad'
      && (pkg.agent?.platforms || []).includes('windows');
}
