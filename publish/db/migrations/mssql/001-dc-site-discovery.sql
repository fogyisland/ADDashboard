-- AD Dashboard DC/Site Discovery migration (SQL Server 2014+)
-- Applies after 01-tables.sql + 02-seed-roles.sql.
-- For upgrade-from-pre-1.x deployments only: fresh installs already include
-- these columns inline via db/schema/mssql/01-tables.sql.
-- SQL Server 2014 lacks `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
-- so each column add is guarded by a sys.columns lookup.
-- All blocks are idempotent: re-running on a fresh schema is a no-op.

-- ad_sites: add description + timestamps
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_sites') AND name = 'description'
)
BEGIN
  ALTER TABLE ad_sites ADD description NVARCHAR(256) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_sites') AND name = 'created_at'
)
BEGIN
  ALTER TABLE ad_sites ADD created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_sites') AND name = 'updated_at'
)
BEGIN
  ALTER TABLE ad_sites ADD updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME();
END;

-- ad_dcs: agent-reported metadata + discovery tracking
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'when_created'
)
BEGIN
  ALTER TABLE ad_dcs ADD when_created DATETIME2 NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'is_gc'
)
BEGIN
  ALTER TABLE ad_dcs ADD is_gc BIT NOT NULL DEFAULT 0;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'is_rid_master'
)
BEGIN
  ALTER TABLE ad_dcs ADD is_rid_master BIT NOT NULL DEFAULT 0;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'is_schema_master'
)
BEGIN
  ALTER TABLE ad_dcs ADD is_schema_master BIT NOT NULL DEFAULT 0;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'is_domain_naming_master'
)
BEGIN
  ALTER TABLE ad_dcs ADD is_domain_naming_master BIT NOT NULL DEFAULT 0;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'is_infrastructure_master'
)
BEGIN
  ALTER TABLE ad_dcs ADD is_infrastructure_master BIT NOT NULL DEFAULT 0;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'site_hint'
)
BEGIN
  ALTER TABLE ad_dcs ADD site_hint NVARCHAR(64) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'discovered_at'
)
BEGIN
  ALTER TABLE ad_dcs ADD discovered_at DATETIME2 NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = 'discovered_by_agent_id'
)
BEGIN
  ALTER TABLE ad_dcs ADD discovered_by_agent_id NVARCHAR(64) NULL;
END;

-- New system_config rows (idempotent via IF NOT EXISTS guards)
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'discovery_interval_hours')
  INSERT INTO system_config (config_key, config_value, description)
    VALUES ('discovery_interval_hours', '4', 'Agent 上报本地 DC 元数据的时间间隔 (小时)');

IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'site_matrix_refresh_seconds')
  INSERT INTO system_config (config_key, config_value, description)
    VALUES ('site_matrix_refresh_seconds', '10', '站点复制矩阵页面自动刷新间隔 (秒)');