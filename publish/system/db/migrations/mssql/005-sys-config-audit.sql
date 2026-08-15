-- verify: table sys_config_audit

-- 005-sys-config-audit.sql (MSSQL)
-- Idempotent: CREATE TABLE plus each CREATE INDEX is guarded by IF NOT EXISTS,
-- matching the patterns in 004/011. Without the index guards, re-running on a
-- partial-state DB (e.g. where a previous apply succeeded the CREATE TABLE but
-- failed mid-statement before reaching CREATE INDEX) throws
-- "index or statistics with name 'idx_changed_at' already exists" — the
-- underlying cause of the wizard's "Could not create constraint or index" 500.
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sys_config_audit' AND xtype='U')
CREATE TABLE sys_config_audit (
  id INT PRIMARY KEY IDENTITY(1,1),
  config_key NVARCHAR(64) NOT NULL,
  old_value NVARCHAR(MAX) NULL,
  new_value NVARCHAR(MAX) NULL,
  changed_by INT NULL,
  changed_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  change_type VARCHAR(16) NOT NULL DEFAULT 'UPDATE'
    CHECK (change_type IN ('UPDATE','ROLLBACK'))
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_changed_at' AND object_id = OBJECT_ID('sys_config_audit'))
CREATE INDEX idx_changed_at ON sys_config_audit (changed_at DESC);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_config_key' AND object_id = OBJECT_ID('sys_config_audit'))
CREATE INDEX idx_config_key ON sys_config_audit (config_key);
