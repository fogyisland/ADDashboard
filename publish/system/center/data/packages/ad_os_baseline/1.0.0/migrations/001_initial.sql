-- 001_initial.sql (MySQL)
-- Creates pkg_ad_os_baseline.metrics for the ad_os_baseline v2 package.
-- Each row stores one agent's CPU/memory/disk/services/events snapshot.
-- Schema-qualified so it lands in pkg_ad_os_baseline when applyMigrations
-- runs against the connection's current default DB (no USE pkg_* is issued
-- upstream — the mysql2 pool would persist USE per-connection and leak it
-- into subsequent unqualified queries).
-- Idempotent on rerun via CREATE TABLE IF NOT EXISTS (Task 430 fix:
-- pre-fix CREATE TABLE metrics was unqualified AND not idempotent, so the
-- seeder crashed on second start with "Table 'metrics' already exists").

CREATE TABLE IF NOT EXISTS pkg_ad_os_baseline.metrics (
  agent_id   VARCHAR(64)  NOT NULL,
  ts         DATETIME     NOT NULL,
  cpu_pct    DOUBLE NULL,
  memory_pct DOUBLE NULL,
  disk_free  JSON NULL,
  disk_total JSON NULL,
  services   JSON NULL,
  events     JSON NULL
);