-- 2026-08-24 round-12: heartbeat "report now" feature.
-- Center sets this column when admin clicks 回报 on the heartbeat monitor;
-- agent picks it up on its next heartbeat response (carried as the
-- reportRequested boolean field). Agent clears the column by sending
-- report_requested_at: NULL in a subsequent heartbeat POST body.
ALTER TABLE ad_agent_heartbeat
  ADD COLUMN report_requested_at DATETIME NULL AFTER agent_token_version;
