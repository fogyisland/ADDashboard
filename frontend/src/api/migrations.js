import api from './client.js';

export function listMigrations() {
  return api.get('/api/admin/migrations');
}

export function applyMigration(version, body) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/apply`, body || {});
}

export function dryRunMigration(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/dry-run`, {});
}

export function resetMigration(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/reset`, {});
}