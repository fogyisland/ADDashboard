-- verify: table installed_packages
-- verify: table metric_gauge
-- verify: table metric_counter
-- verify: table metric_timeseries
-- verify: table metric_status
-- verify: table package_runs

-- AD Dashboard migration 004: package system (MSSQL flavor).
-- 6 new tables for the v2 plugin system.
-- Idempotent via IF OBJECT_ID('dbo.<table>', 'U') IS NULL.
-- VARCHAR -> NVARCHAR; DATETIME -> DATETIMEOFFSET (UTC); JSON -> NVARCHAR(MAX).

IF OBJECT_ID('dbo.installed_packages', 'U') IS NULL
CREATE TABLE dbo.installed_packages (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  name            NVARCHAR(128) NOT NULL,
  version         NVARCHAR(32) NOT NULL,
  type            NVARCHAR(16) NOT NULL,
  manifest_json   NVARCHAR(MAX) NOT NULL,
  enabled         TINYINT NOT NULL DEFAULT 0,
  params_json     NVARCHAR(MAX) NULL,
  installed_at    DATETIMEOFFSET NOT NULL,
  updated_at      DATETIMEOFFSET NOT NULL,
  source          NVARCHAR(255) NOT NULL,
  CONSTRAINT uq_pkg_name UNIQUE (name)
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'ix_pkg_enabled' AND object_id = OBJECT_ID('dbo.installed_packages'))
CREATE INDEX ix_pkg_enabled ON dbo.installed_packages(enabled);

IF OBJECT_ID('dbo.metric_gauge', 'U') IS NULL
CREATE TABLE dbo.metric_gauge (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  agent_id        NVARCHAR(64) NOT NULL,
  metric_id       NVARCHAR(192) NOT NULL,
  ts              DATETIMEOFFSET NOT NULL,
  value           FLOAT NOT NULL,
  unit            NVARCHAR(16) NULL,
  threshold_warn  FLOAT NULL,
  threshold_crit  FLOAT NULL,
  CONSTRAINT uq_gauge_agent_metric UNIQUE (agent_id, metric_id)
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'ix_gauge_metric_ts' AND object_id = OBJECT_ID('dbo.metric_gauge'))
CREATE INDEX ix_gauge_metric_ts ON dbo.metric_gauge(metric_id, ts DESC);

IF OBJECT_ID('dbo.metric_counter', 'U') IS NULL
CREATE TABLE dbo.metric_counter (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  agent_id        NVARCHAR(64) NOT NULL,
  metric_id       NVARCHAR(192) NOT NULL,
  ts              DATETIMEOFFSET NOT NULL,
  value           BIGINT NOT NULL,
  delta           BIGINT NOT NULL DEFAULT 0,
  unit            NVARCHAR(16) NULL,
  CONSTRAINT uq_counter_agent_metric UNIQUE (agent_id, metric_id)
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'ix_counter_metric_ts' AND object_id = OBJECT_ID('dbo.metric_counter'))
CREATE INDEX ix_counter_metric_ts ON dbo.metric_counter(metric_id, ts DESC);

IF OBJECT_ID('dbo.metric_timeseries', 'U') IS NULL
CREATE TABLE dbo.metric_timeseries (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  agent_id        NVARCHAR(64) NOT NULL,
  metric_id       NVARCHAR(192) NOT NULL,
  ts              DATETIMEOFFSET NOT NULL,
  value           FLOAT NOT NULL,
  tags_json       NVARCHAR(MAX) NULL,
  unit            NVARCHAR(16) NULL
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'ix_ts_agent_metric_ts' AND object_id = OBJECT_ID('dbo.metric_timeseries'))
CREATE INDEX ix_ts_agent_metric_ts ON dbo.metric_timeseries(agent_id, metric_id, ts DESC);

IF OBJECT_ID('dbo.metric_status', 'U') IS NULL
CREATE TABLE dbo.metric_status (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  agent_id        NVARCHAR(64) NOT NULL,
  metric_id       NVARCHAR(192) NOT NULL,
  ts              DATETIMEOFFSET NOT NULL,
  status          NVARCHAR(64) NOT NULL,
  message         NVARCHAR(512) NULL,
  CONSTRAINT uq_status_agent_metric UNIQUE (agent_id, metric_id)
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'ix_status_metric_ts' AND object_id = OBJECT_ID('dbo.metric_status'))
CREATE INDEX ix_status_metric_ts ON dbo.metric_status(metric_id, ts DESC);

IF OBJECT_ID('dbo.package_runs', 'U') IS NULL
CREATE TABLE dbo.package_runs (
  id              BIGINT IDENTITY(1,1) PRIMARY KEY,
  agent_id        NVARCHAR(64) NOT NULL,
  package_name    NVARCHAR(128) NOT NULL,
  started_at      DATETIMEOFFSET NOT NULL,
  finished_at     DATETIMEOFFSET NULL,
  exit_code       INT NULL,
  stdout_preview  NVARCHAR(2048) NULL,
  stderr_preview  NVARCHAR(2048) NULL,
  error           NVARCHAR(512) NULL
);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'ix_run_agent_pkg' AND object_id = OBJECT_ID('dbo.package_runs'))
CREATE INDEX ix_run_agent_pkg ON dbo.package_runs(agent_id, package_name, started_at DESC);
