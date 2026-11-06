// 2026-10-01 R158.13 — client-settings auto-delivery. Mirror of
// agent-token-delivery.js: when the centre replies to a heartbeat
// with {agentSettings, clientSettingsVersion}, the agent MUST
// persist the patch atomically + mutate in-memory values + (for
// heartbeatIntervalSeconds) hot-restart the heartbeat setInterval
// via the heartbeat handle passed in.
//
// Used by both AD and non-AD runtimes via the three heartbeat call
// sites in agent.js. Kept in its own module so unit tests can
// exercise the version-compare + whitelist + atomic-write +
// in-memory-swap + restart logic without booting the full agent
// runtime (which is expensive + non-deterministic for side-effects).
//
// Failure semantics (matches agent-token-delivery.js 1-for-1):
//   - monotonic guard fail      → no bump, no write
//   - whitelist miss (centre sent bad field) → bump version (rejected:
//     the agent acknowledges but does NOT apply, so the centre doesn't
//     keep re-pushing the same bad payload forever)
//   - disk write failed          → no bump, retry on next heartbeat
//   - heartbeat.restart() threw → applied=true with restarted=false;
//     in-memory value already updated so subsequent ticks honour it

import { writeAppsettingsPatchAtomic } from './appsettings-writer.js';

// Same whitelist as centre/src/services/client-settings.js —
// defence-in-depth. If a future operator adds a field on the centre
// side without updating this set, the agent silently rejects it.
const ALLOWED_FIELDS = new Set([
  'heartbeatIntervalSeconds',
  'pollingIntervalMinutes',
  'discoveryIntervalHours',
  'healthCheckIntervalMs',
  'logLevel'
]);

const ALLOWED_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

// validatePatch — side-effect free, never throws. Returns the cleaned
// patch object (only whitelisted + range-validated keys) or null on any
// failure (caller logs + bumps version to acknowledge the bad payload).
//
// Number guards mirror the centre's validateSettingsPatch: must be
// finite, positive integer (no fractional seconds for the cadence
// fields). Range guards live in the centre (this layer doesn't
// re-implement them — agent trusts operator-pushed ranges, but the
// whitelist + type guards here prevent the agent from blindly writing
// arbitrary keys like "centerUrl").
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const cleaned = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_FIELDS.has(k)) return null;
    if (k === 'logLevel') {
      if (typeof v !== 'string' || !ALLOWED_LOG_LEVELS.has(v)) return null;
      cleaned[k] = v;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) return null;
    cleaned[k] = v;
  }
  return cleaned;
}

// applySettingsDelivery — invoked after every postHeartbeat. Mirrors
// applyAgentTokenDelivery's call shape ({result, config, configPath, logger}).
// Adds `heartbeat` (the closure-captured handle from startHeartbeat) so
// we can restart the setInterval when heartbeatIntervalSeconds changed.
//
// Returns:
//   { applied: false }                                    — no incoming payload
//   { applied: false, rejected: true, newVersion }        — whitelist miss
//   { applied: false, error }                             — disk write failed
//   { applied: true, previousVersion, newVersion, restarted, fields }
export async function applySettingsDelivery({
  result,
  config,
  configPath,
  logger,
  heartbeat
}) {
  if (!result || !result.ok || !result.data) return { applied: false };
  const data = result.data;
  const incomingSettings = data.agentSettings;
  const incomingVersion = Number(data.clientSettingsVersion);
  if (!incomingSettings || typeof incomingSettings !== 'object') return { applied: false };
  if (!Number.isInteger(incomingVersion) || incomingVersion < 1) return { applied: false };
  // Monotonic guard — never accept a down-rev patch. Same shape as
  // applyAgentTokenDelivery:18.
  if (incomingVersion <= Number(config.clientSettingsVersion || 0)) return { applied: false };

  const cleaned = validatePatch(incomingSettings);
  if (!cleaned || Object.keys(cleaned).length === 0) {
    // Centre sent a payload we can't apply (whitelist miss, bad type,
    // empty after cleaning). Acknowledge via in-memory version write so
    // the centre doesn't loop on the same bad payload forever, but
    // DON'T touch appsettings.json or any runtime state.
    logger.warn(
      { version: incomingVersion, raw: incomingSettings },
      'agent settings delivery rejected by agent-side whitelist; ignored'
    );
    config.clientSettingsVersion = incomingVersion;
    return { applied: false, rejected: true, newVersion: incomingVersion };
  }

  // Atomic write to appsettings.json. If the disk write fails, return
  // without bumping so the next heartbeat retries. Same pattern as
  // applyAgentTokenDelivery:25-31.
  const w = writeAppsettingsPatchAtomic({ path: configPath, patch: cleaned });
  if (!w.ok) {
    logger.error(
      { error: w.error, version: incomingVersion },
      'appsettings.json patch write failed; new client settings NOT persisted (in-memory only this run)'
    );
    return { applied: false, error: w.error };
  }

  // Snapshot the previous heartbeat cadence BEFORE mutating config so we
  // can decide whether to call heartbeat.restart(). restart() is best-
  // effort: a throw is caught and we still report applied=true with
  // restarted=false (the in-memory value already updated so subsequent
  // ticks honour the new cadence once the timer is replaced at the next
  // restart trigger — e.g. agent restart, or the operator pushes again).
  const previousVersion = config.clientSettingsVersion;
  const previousHeartbeatSec = config.heartbeatIntervalSeconds;
  for (const [k, v] of Object.entries(cleaned)) {
    config[k] = v;
  }
  config.clientSettingsVersion = incomingVersion;

  let restarted = false;
  if (
    heartbeat &&
    typeof heartbeat.restart === 'function' &&
    Number.isInteger(cleaned.heartbeatIntervalSeconds) &&
    cleaned.heartbeatIntervalSeconds !== previousHeartbeatSec
  ) {
    try {
      heartbeat.restart({ intervalMs: cleaned.heartbeatIntervalSeconds * 1000 });
      restarted = true;
    } catch (e) {
      logger.warn(
        { err: e.message, newSec: cleaned.heartbeatIntervalSeconds },
        'heartbeat timer restart threw; continuing with new in-memory value'
      );
    }
  }

  logger.info(
    {
      version: incomingVersion,
      previousVersion,
      fields: Object.keys(cleaned),
      restarted,
      newHeartbeatSec: cleaned.heartbeatIntervalSeconds ?? null,
      previousHeartbeatSec
    },
    'client settings auto-delivered from heartbeat response'
  );
  return {
    applied: true,
    previousVersion,
    newVersion: incomingVersion,
    restarted,
    fields: Object.keys(cleaned)
  };
}