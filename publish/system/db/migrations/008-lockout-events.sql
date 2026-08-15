-- verify: table ad_lockout_events

-- 008-lockout-events.sql
-- Lockout troubleshooting feature: persist Windows Security event 4740
-- (user account locked out) from every DC. Server-side dedup on
-- (dc_name, event_record_id) means the 15-min lookback can re-read the
-- same window without creating duplicates. The agent emits only the last
-- 15 minutes; the table grows ~10k events/year per DC at typical rates.
CREATE TABLE IF NOT EXISTS ad_lockout_events (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at           DATETIME NOT NULL,
  collected_at          DATETIME NOT NULL,
  agent_id              VARCHAR(64)  NOT NULL,
  dc_name               VARCHAR(128) NOT NULL,
  event_record_id       BIGINT       NOT NULL,
  target_user_name      VARCHAR(256) NOT NULL,
  subject_user_name     VARCHAR(256) NULL,
  subject_domain        VARCHAR(256) NULL,
  caller_computer_name  VARCHAR(256) NULL,
  UNIQUE KEY uq_lockout_dc_record (dc_name, event_record_id),
  KEY ix_lockout_target_time (target_user_name, occurred_at),
  KEY ix_lockout_caller_time  (caller_computer_name, occurred_at),
  KEY ix_lockout_dc_time      (dc_name, occurred_at),
  KEY ix_lockout_occurred     (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;