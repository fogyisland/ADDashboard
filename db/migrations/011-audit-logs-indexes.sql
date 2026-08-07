-- 011-audit-logs-indexes.sql
-- Speed up tab-category + per-user drill-down queries as the table grows.
-- No verify markers: indexes are not tables/columns per the marker grammar
-- (see center/src/init/verify-marker.js). bootstrapMigrations probes the
-- table itself, which already exists from migration 001, so this file is
-- not gated on its own marker.
-- See: docs/superpowers/specs/2026-08-07-audit-log-redesign-design.md
CREATE INDEX IF NOT EXISTS ix_audit_action_time ON audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_user_time   ON audit_logs (user_id, created_at);