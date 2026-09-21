-- 001_initial.sql (MySQL)
-- Creates pkg_ad_domain_consistency.metrics for the ad_domain_consistency v2
-- package. Each row stores one agent's local-DC snapshot fingerprint of users,
-- groups, and GPOs. The <class>_count columns hold the integer count returned
-- by Get-ADUser / Get-ADGroup / Get-GPO; the <class>_hash columns hold the
-- 64-character lowercase SHA-256 hex digest of the sorted, pipe-joined
-- canonical-name list for the class. error_code is a bit accumulator:
--   1 = users class failed
--   2 = groups class failed
--   4 = gpos class failed
-- so error_code = 0 means all three classes succeeded; 7 means all three failed.
--
-- Schema-qualified so it lands in pkg_ad_domain_consistency when
-- applyMigrations runs against the connection's current default DB
-- (Task 430 fix: pre-fix CREATE TABLE IF NOT EXISTS metrics was
-- unqualified, so the table landed in addashboard.metrics instead of
-- pkg_ad_domain_consistency.metrics and the metricstore v2 INSERT failed
-- with "Table 'pkg_ad_domain_consistency.metrics' doesn't exist").
-- Idempotent on rerun via CREATE TABLE IF NOT EXISTS.
-- DATETIME(3) matches other package tables for ms-precision timestamps.
-- Primary key on (agent_id, ts) is the unique-source row identity (Task 1 R2).

CREATE TABLE IF NOT EXISTS pkg_ad_domain_consistency.metrics (
  agent_id    VARCHAR(64) NOT NULL,
  ts          DATETIME(3) NOT NULL,
  user_count  INT         NULL,
  user_hash   VARCHAR(64) NULL,
  group_count INT         NULL,
  group_hash  VARCHAR(64) NULL,
  gpo_count   INT         NULL,
  gpo_hash    VARCHAR(64) NULL,
  error_code  INT         NULL,
  PRIMARY KEY (agent_id, ts)
);