-- AD Dashboard migration 003: MSSQL flavor. Idempotent.
-- Bit + DATETIME2 instead of TINYINT(1) + DATETIME(3).

IF OBJECT_ID('dbo.system_ports', 'U') IS NULL
CREATE TABLE dbo.system_ports (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  port       INT NOT NULL,
  label      NVARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  CONSTRAINT uk_system_ports_port UNIQUE (port)
);

IF OBJECT_ID('dbo.ad_agent_port_status', 'U') IS NULL
CREATE TABLE dbo.ad_agent_port_status (
  agent_id        VARCHAR(64) NOT NULL,
  port            INT NOT NULL,
  ok              BIT NOT NULL,
  latency_ms      INT NULL,
  last_checked_at DATETIME2(3) NOT NULL,
  CONSTRAINT pk_aps PRIMARY KEY (agent_id, port)
  -- intentionally NO FK to ad_agent_heartbeat (see MySQL note)
);
