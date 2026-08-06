-- verify: table system_ports
-- verify: table ad_agent_port_status

-- AD Dashboard migration 003: add system_ports (admin-curated port list) and
-- ad_agent_port_status (latest per-port probe result per agent). Idempotent.
-- For MySQL 8+.

CREATE TABLE IF NOT EXISTS system_ports (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  port       INT NOT NULL,
  label      VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_system_ports_port (port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_agent_port_status (
  agent_id        VARCHAR(64) NOT NULL,
  port            INT NOT NULL,
  ok              TINYINT(1) NOT NULL,
  latency_ms      INT NULL,
  last_checked_at DATETIME(3) NOT NULL,
  PRIMARY KEY (agent_id, port)
  -- intentionally NO FK to ad_agent_heartbeat: probe results are a separate
  -- fact from heartbeats and must survive retention purges of old heartbeats.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
