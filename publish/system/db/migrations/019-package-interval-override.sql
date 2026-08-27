-- 2026-08-26: per-package operator-overridable execution interval.
--
-- Why a separate column instead of editing manifest.agent.intervalSec?
-- The manifest is a packaged artifact (immutable after install per the v2
-- contract — installer/registry re-installs overwrite the column to whatever
-- the manifest declares). The operator's "throttle this package to 5
-- minutes because I don't need minute-level fidelity on member-server CPU"
-- decision is a runtime operational override that must survive package
-- upgrades and re-imports. Storing it on its own column, with NULL meaning
-- "fall back to manifest.agent.intervalSec", preserves both intents.
--
-- Range matches the manifest schema's intervalSec constraint (5..86400 =
-- 5 seconds..1 day). Out-of-range values are rejected by the admin route,
-- not by the column — keeps the column simple INT NULL and lets the route
-- own the operator-facing error message.
--
-- Idempotency: no IF NOT EXISTS for ADD COLUMN in MySQL 8, so query
-- information_schema.columns and skip the ALTER when present.
ALTER TABLE installed_packages
  ADD COLUMN interval_override_sec INT NULL AFTER params_json;
