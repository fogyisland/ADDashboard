-- verify: table sys_config_audit

-- 005-sys-config-audit.sql (MSSQL)
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
CREATE INDEX idx_changed_at ON sys_config_audit (changed_at DESC);
CREATE INDEX idx_config_key ON sys_config_audit (config_key);
