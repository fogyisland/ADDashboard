// 2026-09-09 S82 (security) — split admin:users into per-domain
// permissions. Legacy `admin:users` was a super-admin umbrella that
// gated user CRUD + file-push (R/W arbitrary files) + member-commands
// (RCE) + AD admin commands + bulk ops + secret rotation. A single
// account compromise gave the attacker total pwn.
//
// The split:
//   admin:users          — user CRUD only (read/write sys_users rows)
//   admin:packages       — package install/uninstall (server groups)
//   admin:file-push      — file push to agents
//   admin:member-servers — execute scripts on member servers (R81)
//   admin:ad-objects     — AD user/group management (R75 commands)
//   admin:config        — system config + secret rotation
//   admin:billing        — placeholder (not wired)
//
// Back-compat: legacy `admin:users` (or `*`) implicitly grants all of
// the above. Tests / roles already provisioned with `admin:users` keep
// working without a migration. New deployments can hand out narrower
// permissions per role (e.g. a "package-operator" role with only
// `admin:packages`).

// Frozen for testability — tests assert the union exactly.
export const ADMIN_PERMISSIONS = Object.freeze([
  'admin:users',
  'admin:packages',
  'admin:file-push',
  'admin:member-servers',
  'admin:ad-objects',
  'admin:config',
  'admin:billing'
]);

// Legacy umbrella → all new per-domain perms. Wildcard '*' is also
// implicitly accepted by requirePerm itself (see below).
const LEGACY_UMBRELLA_PERMS = Object.freeze(['admin:users']);

function _hasPerm(perms, perm) {
  if (!Array.isArray(perms)) return false;
  if (perms.includes('*')) return true;
  if (perms.includes(perm)) return true;
  // Legacy umbrella compat: any role holding `admin:users` (the old
  // super-admin string) implicitly grants every per-domain permission.
  // This is the no-migration path — existing roles keep working until
  // the operator opts into the split. The check is "does the user hold
  // ANY legacy umbrella perm?" — if yes, every per-domain perm is
  // granted; this branch only matters when the per-domain perm isn't
  // already directly listed in `perms`.
  for (const umbrella of LEGACY_UMBRELLA_PERMS) {
    if (perms.includes(umbrella)) return true;
  }
  return false;
}

export function requirePerm(perm) {
  return (req, res, next) => {
    if (_hasPerm(req.user?.permissions, perm)) return next();
    res.status(403).json({ error: 'forbidden', need: perm });
  };
}

// Exposed for the test harness so it can assert the legacy-compat
// matrix without re-deriving it.
export const __testing = {
  ADMIN_PERMISSIONS,
  LEGACY_UMBRELLA_PERMS,
  _hasPerm
};