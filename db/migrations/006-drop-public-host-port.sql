-- 006-drop-public-host-port.sql
-- Remove dead config rows left over from deployments predating the
-- center_public_host/center_public_port removal. Idempotent: re-running on
-- a clean DB is a no-op.
DELETE FROM system_config
 WHERE config_key IN ('center_public_host', 'center_public_port');
