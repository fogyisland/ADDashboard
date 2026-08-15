-- verify: table probe_state

-- 012-probe-state.sql
-- Port self-probe state: one row per port_role (web / heartbeat / report),
-- updated at 1 Hz by the center's internal probe service. The /api/probe
-- endpoint reads it; the admin HeartbeatReportMonitorView consumes the same
-- data to show "is the new port actually listening?". See:
-- docs/superpowers/specs/2026-08-08-port-config-and-health-design.md
--
-- Idempotent on rerun via CREATE TABLE IF NOT EXISTS + INSERT IGNORE so the
-- migration runner can re-apply safely during deployment upgrades.
CREATE TABLE IF NOT EXISTS probe_state (
  port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
  status               VARCHAR(16) NOT NULL,
  latency_ms           INT NULL,
  last_probe_at        DATETIME NULL,
  last_up_at           DATETIME NULL,
  consecutive_failures INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO probe_state (port_role, status, consecutive_failures) VALUES
  ('web',       'unknown', 0),
  ('heartbeat', 'unknown', 0),
  ('report',    'unknown', 0);