-- verify: table probe_state

-- 012-probe-state.sql (MSSQL)
-- Port self-probe state: one row per port_role (web / heartbeat / report),
-- updated at 1 Hz by the center's internal probe service. See the MySQL
-- counterpart for semantics; here we use the project-standard IF OBJECT_ID
-- guard (no CREATE TABLE IF NOT EXISTS in MSSQL) and DATETIME2 (project
-- convention).
IF OBJECT_ID('probe_state', 'U') IS NULL
BEGIN
  CREATE TABLE probe_state (
    port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
    status               VARCHAR(16) NOT NULL,
    latency_ms           INT NULL,
    last_probe_at        DATETIME2 NULL,
    last_up_at           DATETIME2 NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,
    CONSTRAINT ck_probe_role   CHECK (port_role IN ('web','heartbeat','report')),
    CONSTRAINT ck_probe_status CHECK (status IN ('healthy','degraded','unknown'))
  );

  INSERT INTO probe_state (port_role, status, consecutive_failures) VALUES
    ('web',       'unknown', 0),
    ('heartbeat', 'unknown', 0),
    ('report',    'unknown', 0);
END;