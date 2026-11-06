// R158.51 (2026-10-08) — baseline freeze. The admin Schema Migrations UI
// only needs to list the single 1.0.0 baseline row, dry-run it for
// inspection, and trigger an upgrade if the operator wants to re-apply.
// The other 6 endpoints (apply / reset / refreshChecksum / markApplied /
// baseline / applyUpTo) are still served by the backend for backwards
// compatibility with any scripts/clients, but no longer called from
// the frontend.

import api from './client.js';

export function listMigrations() {
  return api.get('/api/admin/migrations');
}

export function dryRunMigration(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/dry-run`, {});
}

export function upgrade() {
  return api.post('/api/admin/migrations/upgrade', {});
}