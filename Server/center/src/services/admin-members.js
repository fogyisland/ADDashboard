// R158.47 (2026-10-06) — ad_admin_members post-hook helper.
//
// Why this exists:
//   ad_admin_members is a PUBLIC table (operator's "公共表" intent, like
//   ad_dc_overview), so the package manifest omits the `database` block
//   to bypass the v2 metricstore guards (seedBuiltinPackages:218 +
//   metricstore.ingestRunV2:97). The metricstore path therefore never
//   runs for this package; we have to write to the table ourselves from
//   a runner.js post-hook.
//
//   "Single-DC" semantic (operator: "这个包只需要在一台 DC 执行即可") is
//   NOT enforced agent-side. Every DC runs collect.ps1 and reports the
//   Domain Admins / Enterprise Admins membership; the MERGE ON
//   (domain_dn, group_name, member_sam) in db.sql.adminMembers.upsert
//   collapses duplicate rows automatically — saves the agent from doing
//   any PDC-selection logic and saves LDAP bandwidth on non-PDC DCs.
//
// Shape:
//   - dialect dispatch on db.dialect === 'mssql' (R101 canonical pattern)
//     is BAKED INTO the SQL helper itself (sql.js adminMembers.upsert
//     returns { sql, params } built from the active dialect), not in
//     this module — keeps the service dialect-agnostic.
//   - per-record try/catch so one bad row doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summary for the route log.
//   - Unlike dc-overview (single per-DC row), this iterates one MERGE
//     per (domain, group, member_sam) — Domain Admins + Enterprise
//     Admins groups can easily have 50+ members total across a forest.

function pickField(o, camelKey, snakeKey) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  return null;
}

function normalizeMember(raw, groupName, domainDn, dcName, collectedAt, runId) {
  // collect.ps1 wire shape for each member entry:
  //   { sam, dn }   (camelCase per PowerShell JSON helper)
  // camelCase first, snake_case fallback defensively in case an older
  // agent sends the underscore form.
  const sam = pickField(raw, 'sam', 'sam');
  const dn  = pickField(raw, 'dn',  'dn');
  if (!sam) return null;
  return {
    domainDn,
    groupName,
    memberSam:     String(sam),
    memberDn:      dn ? String(dn) : null,
    memberEnabled: null,  // current PS doesn't surface enable-state — left for future enhancement
    collectedAt,
    dcName,
    runId
  };
}

function normalizeMetrics(metrics, fallbackAgentId, runId) {
  // collect.ps1 wire shape (matches the JSON envelope from PS):
  //   { agent_id, dc_name, domain_dn, forest_dn,
  //     domain_admins: [{ sam, dn }],
  //     enterprise_admins: [{ sam, dn }],
  //     collected_at }
  const agentId = pickField(metrics, 'agentId', 'agent_id') || fallbackAgentId || null;
  const dcName  = pickField(metrics, 'dcName', 'dc_name')  || agentId;
  const domainDn = pickField(metrics, 'domainDn', 'domain_dn');
  const forestDn = pickField(metrics, 'forestDn', 'forest_dn');

  const collectedAtRaw = pickField(metrics, 'collectedAt', 'collected_at');
  const collectedAt = collectedAtRaw instanceof Date
    ? collectedAtRaw
    : (collectedAtRaw ? new Date(collectedAtRaw) : new Date());

  // PS serializes "domainAdmins" / "enterpriseAdmins" as camelCase arrays;
  // the underscore variant is a defensive fallback for any agent that
  // passes the raw hashtable keys directly.
  const domainAdminsRaw     = Array.isArray(metrics?.domainAdmins)     ? metrics.domainAdmins
                            : (Array.isArray(metrics?.domain_admins)   ? metrics.domain_admins   : []);
  const enterpriseAdminsRaw = Array.isArray(metrics?.enterpriseAdmins) ? metrics.enterpriseAdmins
                            : (Array.isArray(metrics?.enterprise_admins) ? metrics.enterprise_admins : []);

  // Domain Admins → bind to this DC's domainDn (the group lives in the
  // local domain). Enterprise Admins → bind to forestDn (the group lives
  // in the forest root, queried via -Server $forest.RootDomain).
  // Fall back to domainDn if forestDn is missing (single-domain forests
  // are the common case and the two are often identical anyway).
  const domainAdmins = domainAdminsRaw
    .map(m => normalizeMember(m, 'Domain Admins', domainDn, dcName, collectedAt, runId))
    .filter(Boolean);
  const enterpriseAdmins = enterpriseAdminsRaw
    .map(m => normalizeMember(m, 'Enterprise Admins', forestDn || domainDn, dcName, collectedAt, runId))
    .filter(Boolean);

  return {
    dcName,
    agentId,
    domainDn,
    forestDn,
    domainAdmins,
    enterpriseAdmins,
    collectedAt
  };
}

export async function upsertMembers(db, metrics, fallbackAgentId = null, runId = null, log = null) {
  const normalized = normalizeMetrics(metrics, fallbackAgentId, runId);
  if (!normalized.dcName || !normalized.agentId) {
    return { upserted: 0, skipped: 0, errors: [{ reason: 'missing agent_id / dc_name' }] };
  }
  const all = [...normalized.domainAdmins, ...normalized.enterpriseAdmins];
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (const row of all) {
    try {
      // R158.69.10 (2026-10-11) — 中心 enrich displayName. 不动 collect.ps1
      //   (operator "这是指标包, 不涉及 agent 修改"). enrich 失败不阻塞
      //   upsert — displayName 留 null, UI 显示 "—".
      if (!row.displayName) {
        row.displayName = await enrichDisplayName(db, row.memberSam, log);
      }
      const built = db.sql.adminMembers.upsert(row);
      await db.execute(built.sql, built.params);
      upserted++;
    } catch (e) {
      log?.error?.({
        event: 'admin_members.upsert_failed',
        sam: row.memberSam,
        group: row.groupName,
        domainDn: row.domainDn,
        err: e?.message || String(e)
      }, 'admin-members upsert failed');
      errors.push({
        sam: row.memberSam,
        group: row.groupName,
        domainDn: row.domainDn,
        error: e?.message || String(e)
      });
    }
  }
  return { upserted, skipped, errors };
}

// R158.69.10 (2026-10-11) — enrich displayName from ad_users_snapshot.
//   仅 sam 限定 (37/40 命中实测, 跨域 sam 多行取首行非空, 跟 backfill 同语义).
//   dialect-agnostic (sql.js 内部 dispatch). enrich 失败 isolate (try/catch),
//   不阻塞 upsert.
async function enrichDisplayName(db, sam, log) {
  if (!sam) return null;
  try {
    const spec = db.sql.adminMembers.lookupDisplayName({ sam });
    const { rows } = await db.query(spec.sql, spec.params);
    if (rows && rows.length) {
      return rows[0].display_name || null;
    }
  } catch (e) {
    log?.warn?.({
      event: 'admin_members.enrich_failed',
      sam,
      err: e?.message || String(e)
    }, 'admin-members enrich failed');
  }
  return null;
}

// Summary reader used by /api/dashboard/summary. Returns the per-group
// member_count for the LATEST collected_at window per (domain_dn,
// group_name) — mirrors the summary SQL in sql.js adminMembers.summary.
// The dashboard.js endpoint adds the COUNT(DISTINCT member_sam) cross-
// group number ("去重成员") on top of this, since distinct dedup across
// groups needs a separate query.
export async function getSummary(db, log = null) {
  const sql = db.sql.adminMembers.summary();
  const { rows } = await db.query(sql.sql, sql.params);
  let domainAdmins = 0;
  let enterpriseAdmins = 0;
  for (const r of rows) {
    const g = String(r.group_name || '');
    const c = Number(r.member_count) || 0;
    if (g === 'Domain Admins') domainAdmins += c;
    else if (g === 'Enterprise Admins') enterpriseAdmins += c;
  }
  return { domainAdmins, enterpriseAdmins };
}

// R158.69.10 (2026-10-11) — drill-down per-group member list for Dashboard 下钻表格.
//   直接读 ad_admin_members 表 (已 enrich), 不再 LEFT JOIN ad_users_snapshot.
export async function listByGroup(db, groupName, log = null) {
  const spec = db.sql.adminMembers.listByGroup({ groupName });
  const { rows } = await db.query(spec.sql, spec.params);
  return rows || [];
}

// Re-export for tests so the dispatch surface stays a single source of truth.
export { normalizeMetrics, normalizeMember };