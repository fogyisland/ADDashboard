-- 001_initial.sql (MySQL)
-- Creates pkg_ad_lockout_list.metrics for the ad_lockout_list v2 package.
-- Each row stores one 15-minute sample of the local DC's lockout events
-- (Security event 4740) as a JSON array in `events`, plus the integer
-- event_count and a bit-accumulator error_code column.
--
-- Schema-qualified so it lands in pkg_ad_lockout_list when applyMigrations
-- runs against the connection's current default DB (Task 430 fix).
-- Idempotent on rerun via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS pkg_ad_lockout_list.metrics (
  agent_id    VARCHAR(64) NOT NULL,
  ts          DATETIME    NOT NULL,
  events      JSON        NULL,
  event_count INT         NULL,
  error_code  INT         NULL
);
