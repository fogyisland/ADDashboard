-- 003_os_baseline_r158_30_fields.sql (MySQL)
-- R158.30 — extend pkg_ad_os_baseline.metrics with system manufacturer /
-- network IPs / memory modules. Adds 3 columns to the table created by
-- 001_initial.sql + extended by 002_os_baseline_extra_fields.sql:
--   system_info    JSON         (Win32_ComputerSystem Manufacturer/Model object)
--   network_info   JSON         ({ipv4: [string, ...]} — physical adapters only)
--   memory_modules JSON         ([{manufacturer, part_number, speed_mhz, capacity_bytes}, ...])
--
-- Idempotency: ADD COLUMN IF NOT EXISTS. Pre-existing 1.0.3 rows get NULL on
-- the new columns until the agent runs the 1.0.4 PS1 (intervalSec=60).
-- bios_info + disks are extended inline in the 1.0.4 collect.ps1 (no DDL).

ALTER TABLE pkg_ad_os_baseline.metrics
  ADD COLUMN IF NOT EXISTS system_info    JSON NULL,
  ADD COLUMN IF NOT EXISTS network_info   JSON NULL,
  ADD COLUMN IF NOT EXISTS memory_modules JSON NULL;