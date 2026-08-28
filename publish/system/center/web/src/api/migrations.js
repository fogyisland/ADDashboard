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

// 2026-08-28 round-55: refresh stored SHA-256 checksum to match the
// current file on disk. Used when SchemaMigrationsView shows ⚠️
// "File edited after apply" — typically because the file was edited
// after apply (verify-marker comments, dialect-compat rewrite with
// identical schema output, etc.) but the DB schema is verified
// working. Server refuses with 409 if the row is not 'applied'.
export function refreshChecksum(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/refresh-checksum`, {});
}

export function markApplied(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/mark-applied`, {});
}

export function baseline(version) {
  return api.post('/api/admin/migrations/baseline', { version });
}

export function applyUpTo(version) {
  return api.post('/api/admin/migrations/apply-up-to', { version });
}

export function upgrade() {
  return api.post('/api/admin/migrations/upgrade', {});
}