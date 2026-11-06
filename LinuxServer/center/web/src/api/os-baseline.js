// R116 — OS Baseline 前台 API client.
//
// Access contract: regular authenticated users (any role) can call this
// endpoint; the back-end mounts `osBaselineRouter` with `userAuth` only
// (no `requirePerm`) per the operator directive (2026-09-26) "我们不需要
// 在 admin 后台看到，直接在前台就可以看到".
//
// Returns one row per member-server (agent_id), with the latest snapshot
// within `sinceHours`. Cards on the front-end render `diskFree` (JSON)
// client-side — the back-end never parses JSON so the wire stays a
// portable text column.

import api from './client.js';

export function listOsBaseline({ sinceHours = 24 } = {}) {
  const qs = `?sinceHours=${encodeURIComponent(sinceHours)}`;
  return api.get(`/api/os-baseline${qs}`);
}

// R158.29 — per-agent 24h CPU + memory time-series for the dual-line
// chart on each OS baseline card. Same data source as listOsBaseline
// (pkg_ad_os_baseline.metrics); the back-end returns bucketed series
// instead of one row per agent. Hours is clamped to [1, 24] on the
// server; the front-end always sends 24 so callers don't need to think
// about it.
//
// Wire shape:
//   { hours, bucketMinutes, agentCount, sampleCount, ts,
//     seriesByAgent: { [agentId]: { cpu: [{ts,value}], memory: [{ts,value}] } } }
export function getOsBaselineTimeseries({ hours = 24 } = {}) {
  const qs = `?hours=${encodeURIComponent(hours)}`;
  return api.get(`/api/os-baseline/timeseries${qs}`);
}