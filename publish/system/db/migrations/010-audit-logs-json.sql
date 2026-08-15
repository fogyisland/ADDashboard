-- verify: table audit_logs

-- 010-audit-logs-json.sql
-- Change audit_logs.payload from TEXT to native JSON so the backend can parse
-- it on read and future work can index payload keys. Existing rows survive
-- because every prior write used JSON.stringify — MySQL auto-casts the TEXT
-- payload into JSON on ALTER COLUMN. See:
-- docs/superpowers/specs/2026-08-07-audit-log-redesign-design.md
ALTER TABLE audit_logs MODIFY COLUMN payload JSON NULL;