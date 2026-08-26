-- 001_initial.sql (MySQL)
-- Creates pkg_ad_lockout_summary.metrics for the ad_lockout_summary v2
-- package. Each row stores one 15-minute sample of the local DC's locked-
-- account count. Schema-qualified so it lands in pkg_ad_lockout_summary
-- when applyMigrations runs against the connection's current default DB
-- (Task 430 fix). Idempotent on rerun via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS pkg_ad_lockout_summary.metrics (
  agent_id     VARCHAR(64) NOT NULL,
  ts           DATETIME    NOT NULL,
  locked_count INT         NULL,
  error_code   INT         NULL
);
