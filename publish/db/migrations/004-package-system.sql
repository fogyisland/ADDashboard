-- AD Dashboard migration 004: package system (6 new tables).
-- Adds tables for the v2 plugin system:
--   installed_packages: registry of packages installed on this center
--   metric_gauge: latest value per (agent, metric) for point-in-time gauges
--   metric_counter: latest cumulative + delta per (agent, metric)
--   metric_timeseries: append-only history of metric samples
--   metric_status: latest OK/WARN/CRIT status per (agent, metric)
--   package_runs: audit log of package executions on agents
-- Idempotent via CREATE TABLE IF NOT EXISTS.
-- For MySQL 8+.

CREATE TABLE IF NOT EXISTS installed_packages (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32) NOT NULL,
  type            VARCHAR(16) NOT NULL,
  manifest_json   JSON NOT NULL,
  enabled         TINYINT NOT NULL DEFAULT 0,
  params_json     JSON NULL,
  installed_at    DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  source          VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_pkg_name (name),
  KEY ix_pkg_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_gauge (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  unit            VARCHAR(16) NULL,
  threshold_warn  DOUBLE NULL,
  threshold_crit  DOUBLE NULL,
  UNIQUE KEY uq_gauge_agent_metric (agent_id, metric_id),
  KEY ix_gauge_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_counter (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           BIGINT NOT NULL,
  delta           BIGINT NOT NULL DEFAULT 0,
  unit            VARCHAR(16) NULL,
  UNIQUE KEY uq_counter_agent_metric (agent_id, metric_id),
  KEY ix_counter_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_timeseries (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  tags_json       JSON NULL,
  unit            VARCHAR(16) NULL,
  KEY ix_ts_agent_metric_ts (agent_id, metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS metric_status (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  status          VARCHAR(64) NOT NULL,
  message         VARCHAR(512) NULL,
  UNIQUE KEY uq_status_agent_metric (agent_id, metric_id),
  KEY ix_status_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS package_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  package_name    VARCHAR(128) NOT NULL,
  started_at      DATETIME NOT NULL,
  finished_at     DATETIME NULL,
  exit_code       INT NULL,
  stdout_preview  VARCHAR(2048) NULL,
  stderr_preview  VARCHAR(2048) NULL,
  error           VARCHAR(512) NULL,
  KEY ix_run_agent_pkg (agent_id, package_name, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
