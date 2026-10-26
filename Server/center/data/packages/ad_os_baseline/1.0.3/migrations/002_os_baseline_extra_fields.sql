-- 002_os_baseline_extra_fields.sql (MySQL)
-- R147 — extend pkg_ad_os_baseline.metrics with hardware-identity + C-drive-used columns.
-- Adds 5 columns to the table created by 001_initial.sql:
--   bios_info        JSON         (Win32_BIOS Manufacturer/Name/Version/ReleaseDate object)
--   cpu_brand        VARCHAR(128) (Win32_Processor Name)
--   mem_total_bytes  BIGINT       (Win32_ComputerSystem TotalPhysicalMemory)
--   disks            JSON         (array of {letter, free_bytes, total_bytes} for DriveType=3)
--   c_used_pct       DOUBLE       (derived from disks[] where letter='C:')
--
-- Idempotency: MySQL 8+ ADD COLUMN IF NOT EXISTS (no INFORMATION_SCHEMA guard
-- dance needed). Pre-existing 1.0.2 rows will have NULL on the new columns
-- until the agent next runs the 1.0.3 PS1 (intervalSec=60, default).
--
-- ALTER TABLE on a small v2-wide metric store is acceptable; the table is
-- owned by the centre, not the agent. If the agent is mid-write when this
-- runs, mysql2 holds a row-level lock for the duration of the ALTER and
-- the agent's INSERT will queue (a few ms — well below the 20s
-- timeoutMs).

ALTER TABLE pkg_ad_os_baseline.metrics
  ADD COLUMN IF NOT EXISTS bios_info       JSON         NULL,
  ADD COLUMN IF NOT EXISTS cpu_brand       VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS mem_total_bytes BIGINT       NULL,
  ADD COLUMN IF NOT EXISTS disks           JSON         NULL,
  ADD COLUMN IF NOT EXISTS c_used_pct      DOUBLE       NULL;