-- 004_os_baseline_r158_56c_fields.sql (MySQL)
-- R158.56c (2026-10-08) — extend pkg_ad_os_baseline.metrics with the 3
-- JSON columns that R158.50.7j PS1 has been writing since 1.0.6 but the
-- centre manifest never knew about:
--   motherboard  JSON         (Win32_BaseBoard {manufacturer, product} object)
--   cpu          JSON         (Win32_Processor {name, cores} object — supersedes
--                              the 1.0.3 cpu_brand varchar column; PS1 1.0.5+ no
--                              longer writes cpu_brand, but the column stays for
--                              legacy 1.0.3 row back-compat)
--   ips          JSON         (array of IPv4 strings from
--                              Win32_NetworkAdapterConfiguration IPEnabled —
--                              supersedes the 1.0.3 network_info {ipv4:[..]}
--                              wrapper object; PS1 1.0.5+ emits a bare array)
--
-- Why this fix exists: R158.50.7j ship bumped PS1 to output motherboard/cpu/ips
-- but only renamed manifest description + version, never updated metricSchema.
-- 5h+ all-fleet metricstore.ingest.failed with "unknown keys: motherboard,ips,cpu"
-- was the symptom. After this migration + 1.0.7 manifest, the next 60s PS1 run
-- writes the 3 new columns to JSON and ingestRunV2 stops rejecting.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS. Pre-existing 1.0.6 rows get NULL on the
-- new columns until the agent's next 60s PS1 run (the existing rows in DB
-- already lack the 3 keys because they were rejected at ingest time and never
-- landed; nothing to backfill). The cpu_brand / network_info columns stay
-- populated for any historical 1.0.4 ingest row.

ALTER TABLE pkg_ad_os_baseline.metrics
  ADD COLUMN IF NOT EXISTS motherboard JSON NULL,
  ADD COLUMN IF NOT EXISTS cpu         JSON NULL,
  ADD COLUMN IF NOT EXISTS ips         JSON NULL;
