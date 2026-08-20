-- 001_initial.sql (MySQL)
-- Creates pkg_ad_local_port_check.metrics for the ad_local_port_check v2
-- package. Each row stores one agent's probe snapshot of the five local
-- ports [135, 445, 50001, 50002, 50003]. The port_<N> columns hold JSON
-- shapes: { "reachable": <bool>, "latencyMs": <number|null>, "error": <string|null> }.
--
-- Idempotent on rerun via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS metrics (
  agent_id   VARCHAR(64) NOT NULL,
  ts         DATETIME    NOT NULL,
  port_135   JSON        NULL,
  port_445   JSON        NULL,
  port_50001 JSON        NULL,
  port_50002 JSON        NULL,
  port_50003 JSON        NULL
);