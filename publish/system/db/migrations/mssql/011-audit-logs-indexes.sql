-- 011-audit-logs-indexes.sql (MSSQL)
-- See mysql counterpart. Existence-check pattern matches other MSSQL migrations.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'ix_audit_action_time' AND object_id = OBJECT_ID('audit_logs')
)
  CREATE INDEX ix_audit_action_time ON audit_logs (action, created_at);

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'ix_audit_user_time' AND object_id = OBJECT_ID('audit_logs')
)
  CREATE INDEX ix_audit_user_time ON audit_logs (user_id, created_at);