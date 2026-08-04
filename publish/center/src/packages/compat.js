// SemVer compatibility checks between a package manifest and the running
// agent/center versions. Used by:
//   - install/upgrade validation (center rejects packages that don't satisfy
//     agent.minVersion or center.minVersion/maxVersion)
//   - agent pull (center filters out packages whose agent.minVersion is
//     above the requesting agent's version)
//
// Returns { ok, error?, code? } shape so callers can map errors to HTTP
// status codes via PkgError.statusFor().

import semver from 'semver';
import { PkgError } from './errors.js';

export function checkAgentCompat(agentVersion, manifest) {
  const range = manifest.agent?.minVersion;
  if (!range) return { ok: true }; // no constraint declared
  // '*' is a sentinel meaning "skip the agent constraint check". Used by
  // admin-side install/upgrade paths where the agent isn't on hand yet
  // (see router.js: POST /api/admin/packages/install and /:name/upgrade,
  // which call checkAll(centerVersion, '*', candidate) to validate only
  // the center constraint before any DB writes). The agent-side check
  // (agent pull / package sync) passes a real version — never '*'. Don't
  // error on '*' or null; just skip the constraint.
  if (agentVersion === '*' || agentVersion == null) return { ok: true };
  if (!semver.valid(agentVersion)) {
    return { ok: false, error: `agent version ${agentVersion} is not valid SemVer` };
  }
  if (!semver.satisfies(agentVersion, range)) {
    return {
      ok: false,
      error: `agent version ${agentVersion} does not satisfy ${range}`,
      code: 'PKG_AGENT_INCOMPATIBLE',
    };
  }
  return { ok: true };
}

export function checkCenterCompat(centerVersion, manifest) {
  const min = manifest.center?.minVersion;
  const max = manifest.center?.maxVersion;
  if (min && semver.lt(centerVersion, min)) {
    return {
      ok: false,
      error: `center version ${centerVersion} below required ${min}`,
      code: 'PKG_CENTER_INCOMPATIBLE',
    };
  }
  if (max && !semver.satisfies(centerVersion, max)) {
    return {
      ok: false,
      error: `center version ${centerVersion} does not satisfy ${max}`,
      code: 'PKG_CENTER_INCOMPATIBLE',
    };
  }
  return { ok: true };
}

export function checkAll(centerVersion, agentVersion, manifest) {
  const a = checkAgentCompat(agentVersion, manifest);
  if (!a.ok) return { ...a, code: 'PKG_AGENT_INCOMPATIBLE' };
  const c = checkCenterCompat(centerVersion, manifest);
  if (!c.ok) return { ...c, code: 'PKG_CENTER_INCOMPATIBLE' };
  return { ok: true };
}
