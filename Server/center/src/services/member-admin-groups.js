// R158.100 (2026-10-13) - member_admin_groups post-hook helper.
//
// Why this exists:
//   member_admin_groups is a PUBLIC table (operator's "公共表" intent, like
//   ad_admin_members / ad_dc_overview), so the package manifest omits the
//   `database` block to bypass the v2 metricstore guards. The metricstore
//   path therefore never runs for this package; we have to write to the
//   table ourselves from a runner.js post-hook.
//
//   "Single-DC" semantic is NOT enforced agent-side. Every member-server
//   runs collect.ps1 and reports its 3 local groups membership; the MERGE
//   ON (hostname, group_name, member_sid) in db.sql.memberAdminGroups.upsert
//   collapses duplicate rows automatically.
//
// Shape:
//   - dialect dispatch is BAKED INTO the SQL helper (sql.js memberAdminGroups
//     block returns { sql, params } from the active dialect), not in this
//     module - keeps the service dialect-agnostic.
//   - per-record try/catch so one bad row doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summary for the route log.
//   - Unlike dc-overview (single per-DC row), this iterates one MERGE
//     per (hostname, group, member) - 3 groups × N members per host.
//   - 0 enrich (跟 ad_admin_members 不同): collect.ps1 自身 Get-LocalUser.FullName
//     enrich 已够, member-server 0 跨域 0 ad_users_snapshot.

function pickField(o, camelKey, snakeKey) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  return null;
}

function normalizeMember(raw, groupName, hostname, collectedAt, runId) {
  // collect.ps1 wire shape for each member entry:
  //   { sid, name, class, principal_source, is_enabled, display_name }
  // camelCase first, snake_case fallback defensively.
  const sid = pickField(raw, 'sid', 'sid');
  if (!sid) return null;
  return {
    hostname,
    groupName,
    memberSid:        String(sid),
    memberName:       pickField(raw, 'name', 'name') ? String(raw.name) : null,
    memberClass:      pickField(raw, 'class', 'class') ? String(raw.class) : null,
    principalSource:  pickField(raw, 'principalSource', 'principal_source')
                       ? String(pickField(raw, 'principalSource', 'principal_source'))
                       : null,
    // is_enabled: collect.ps1 emits 0/1, but PS hashtable may emit boolean. Normalize.
    isEnabled:        (() => {
                       const v = pickField(raw, 'isEnabled', 'is_enabled');
                       if (v === null || v === undefined) return null;
                       if (typeof v === 'boolean') return v ? 1 : 0;
                       const n = Number(v);
                       return Number.isFinite(n) ? n : null;
                     })(),
    displayName:      pickField(raw, 'displayName', 'display_name')
                       ? String(pickField(raw, 'displayName', 'display_name'))
                       : null,
    collectedAt,
    runId
  };
}

function normalizeMetrics(metrics, fallbackHostname, runId) {
  // collect.ps1 wire shape:
  //   { agent_id, hostname, collected_at,
  //     groups: [{ name, members: [{ sid, name, class, principal_source, is_enabled, display_name }] }],
  //     groups_count, total_members_count, error_code }
  const hostname = pickField(metrics, 'hostname', 'hostname') || fallbackHostname || null;
  const agentId  = pickField(metrics, 'agentId', 'agent_id')  || hostname;

  const collectedAtRaw = pickField(metrics, 'collectedAt', 'collected_at');
  const collectedAt = collectedAtRaw instanceof Date
    ? collectedAtRaw
    : (collectedAtRaw ? new Date(collectedAtRaw) : new Date());

  const groupsRaw = Array.isArray(metrics?.groups) ? metrics.groups : [];
  const groups = groupsRaw
    .map(g => ({
      name:    pickField(g, 'name', 'name') ? String(g.name) : null,
      members: Array.isArray(g?.members) ? g.members : []
    }))
    .filter(g => g.name);

  return { hostname, agentId, groups, collectedAt };
}

export async function upsertGroups(db, metrics, fallbackHostname = null, runId = null, log = null) {
  const normalized = normalizeMetrics(metrics, fallbackHostname, runId);
  if (!normalized.hostname) {
    return { upserted: 0, skipped: 0, errors: [{ reason: 'missing hostname' }] };
  }

  // Flatten groups × members to N rows.
  const rows = [];
  for (const g of normalized.groups) {
    for (const m of g.members) {
      const row = normalizeMember(m, g.name, normalized.hostname, normalized.collectedAt, runId);
      if (row) rows.push(row);
    }
  }

  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (const row of rows) {
    try {
      const built = db.sql.memberAdminGroups.upsert(row);
      await db.execute(built.sql, built.params);
      upserted++;
    } catch (e) {
      log?.error?.({
        event: 'member_admin_groups.upsert_failed',
        hostname: row.hostname,
        group: row.groupName,
        memberSid: row.memberSid,
        err: e?.message || String(e)
      }, 'member-admin-groups upsert failed');
      errors.push({
        hostname: row.hostname,
        group: row.groupName,
        memberSid: row.memberSid,
        error: e?.message || String(e)
      });
    }
  }
  return { upserted, skipped, errors };
}

// R158.100 — summary reader for /api/dashboard/member-admin-groups endpoint.
//   Returns per-(hostname, group) member count for the LATEST collected_at window.
export async function getSummary(db, log = null) {
  const spec = db.sql.memberAdminGroups.summary();
  const { rows } = await db.query(spec.sql, spec.params);
  return rows || [];
}

// R158.100 — list all members per hostname for sub-tab main table.
export async function listByHostname(db, hostname, log = null) {
  // R158.99.1 (2026-10-13) — case-insensitive hostname filter. Centre side
  //   normalize 跟前端 sub-tab R158.99.1 1:1 平行 (KDLFLPBISRV vs KDLFLPBISrv
  //   100% 出现, Windows 跨进程 case-mismatch 必然).
  const spec = db.sql.memberAdminGroups.listByHostname({ hostname: String(hostname || '').toLowerCase() });
  const { rows } = await db.query(spec.sql, spec.params);
  return rows || [];
}

// R158.100 — drill-down per (hostname, group_name) for default-expanded view.
export async function listByGroup(db, hostname, groupName, log = null) {
  const spec = db.sql.memberAdminGroups.listByGroup({ hostname: String(hostname || '').toLowerCase(), groupName });
  const { rows } = await db.query(spec.sql, spec.params);
  return rows || [];
}

// Re-export for tests.
export { normalizeMetrics, normalizeMember };
