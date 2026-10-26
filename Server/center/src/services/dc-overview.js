// R110.A — ad_dc_overview post-hook helper.
//
// Why this exists:
//   ad_dc_overview is a PUBLIC table (operator's "公共表" intent), so the
//   package manifest omits the `database` block to bypass the v2 metricstore
//   guards (seedBuiltinPackages:218 + metricstore.ingestRunV2:97). The
//   metricstore path therefore never runs for this package; we have to
//   write to the table ourselves from a runner.js post-hook.
//
// This module mirrors center/src/services/lockout.js shape:
//   - dialect dispatch on db.dialect === 'mssql' (R101 canonical pattern)
//     is BAKED INTO the SQL helper itself (sql.js dcOverview.upsert
//     returns { sql, params } built from the active dialect), not in
//     this module — keeps the service dialect-agnostic.
//   - per-record try/catch so one bad row doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summary for the route log.
//
// Unlike lockout.js (which has a stable 9-param BIND_ORDER), this helper
// uses function-form SQL builders because the row shape carries an
// optional partner_port_status JSON column and a nullable site_id —
// named-arg param form is clearer than positional.

function pickField(o, camelKey, snakeKey) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  return null;
}

function normalizeOverview(overview, fallbackAgentId) {
  // overview wire shape (matches collect.ps1 metrics output):
  //   { agent_id, dc_name, site_id, users_count, groups_count, gpos_count,
  //     partner_port_status, collected_at }
  const agentId = pickField(overview, 'agentId', 'agent_id') || fallbackAgentId || null;
  const dcName  = pickField(overview, 'dcName', 'dc_name')  || agentId;
  if (!agentId || !dcName) {
    return null; // refuse to write a half-row without identity fields
  }

  const collectedAtRaw = pickField(overview, 'collectedAt', 'collected_at');
  const collectedAt = collectedAtRaw instanceof Date
    ? collectedAtRaw
    : (collectedAtRaw ? new Date(collectedAtRaw) : new Date());

  return {
    agentId,
    dcName,
    siteId:             pickField(overview, 'siteId', 'site_id'),
    usersCount:         pickField(overview, 'usersCount', 'users_count'),
    computersCount:     pickField(overview, 'computersCount', 'computers_count'),
    serversCount:       pickField(overview, 'serversCount', 'servers_count'),
    groupsCount:        pickField(overview, 'groupsCount', 'groups_count'),
    gposCount:          pickField(overview, 'gposCount', 'gpos_count'),
    partnerPortStatus:  pickField(overview, 'partnerPortStatus', 'partner_port_status'),
    collectedAt
  };
}

export async function upsertOverview(db, overview, fallbackAgentId = null, log = null) {
  const normalized = normalizeOverview(overview, fallbackAgentId);
  if (!normalized) {
    return { ok: false, reason: 'missing agent_id / dc_name' };
  }
  // R158.8 — operator directive 2026-09-30 "在 ad_dc_overview 中是否取
  // 当前的 Agent 在 ad_dcs 表中信息，填充，这样在 ad_dc_overview 可
  // 以更好的展现内容". ad_dcs.site_id is the authoritative catalogue
  // (operator-maintained), so we look up the canonical site_id for this
  // dc_name BEFORE the UPSERT and use it as the primary source. The
  // payload's siteId is only used as a fallback when ad_dcs has no row
  // (rare — DC just discovered, not yet in catalogue) or ad_dcs.site_id
  // is NULL (DC bound but ungrouped). SELECT-then-INSERT is two SQLs
  // per row but the dc_name index on ad_dcs keeps it cheap.
  let canonicalSiteId = null;
  try {
    const lookup = await db.query(
      db.dialect === 'mssql'
        ? `SELECT site_id FROM ad_dcs WHERE dc_name = ?`
        : `SELECT site_id FROM ad_dcs WHERE dc_name = ? LIMIT 1`,
      [normalized.dcName]
    );
    const rows = Array.isArray(lookup) ? lookup : (lookup.rows || []);
    const candidate = rows[0]?.site_id;
    if (candidate != null) canonicalSiteId = candidate;
  } catch (lookupErr) {
    // Catalogue lookup failure is non-fatal — fall back to payload
    // siteId and let the caller decide. Logged at warn so we notice
    // catalogue table outages but don't reject the row.
    log?.warn?.({
      event: 'dc_overview.catalogue_lookup_failed',
      dcName: normalized.dcName,
      err: lookupErr?.message || String(lookupErr)
    }, 'dc-overview catalogue lookup failed; using payload siteId');
  }
  // Priority: ad_dcs.site_id (canonical) → payload siteId → NULL.
  const finalSiteId = canonicalSiteId != null ? canonicalSiteId : (normalized.siteId != null ? normalized.siteId : null);
  const withSite = { ...normalized, siteId: finalSiteId };

  // dcOverview.upsert is a function-form SQL helper (sql.js returns
  // { sql, params }) for both dialects. The SQL string and CAST/JSON
  // dialect glue lives in sql.js — this module just dispatches.
  const built = db.sql.dcOverview.upsert(withSite);
  try {
    await db.execute(built.sql, built.params);
    return {
      ok: true,
      dcName: normalized.dcName,
      siteId: finalSiteId,
      siteIdSource: canonicalSiteId != null ? 'ad_dcs' : (normalized.siteId != null ? 'payload' : 'null')
    };
  } catch (e) {
    log?.error?.({
      event: 'dc_overview.upsert_failed',
      dcName: normalized.dcName,
      agentId: normalized.agentId,
      err: e?.message || String(e)
    }, 'dc-overview upsert failed');
    return { ok: false, reason: e?.message || String(e), dcName: normalized.dcName };
  }
}

// Batch wrapper: skip null entries (missing identity), swallow per-row
// errors so one bad DC doesn't kill the batch.
export async function upsertOverviews(db, overviews, fallbackAgentId = null, log = null) {
  if (!Array.isArray(overviews)) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < overviews.length; i++) {
    const ov = overviews[i];
    try {
      const res = await upsertOverview(db, ov, fallbackAgentId, log);
      if (res.ok) {
        upserted++;
      } else if (res.reason === 'missing agent_id / dc_name') {
        skipped++;
      } else {
        errors.push({ index: i, dcName: res.dcName ?? null, error: res.reason });
      }
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// Re-export for tests so the dispatch surface stays a single source of truth.
export { normalizeOverview };