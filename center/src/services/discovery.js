// UPSERT for agent-reported DC metadata.
// On duplicate, all agent-reported columns are refreshed; site_id is
// NEVER touched (admin owns it).
const DISCOVERY_UPSERT = `
INSERT INTO ad_dcs (
  dc_name, site_hint, os_version, when_created,
  is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master,
  discovered_at, discovered_by_agent_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  site_hint                = VALUES(site_hint),
  os_version               = VALUES(os_version),
  when_created             = VALUES(when_created),
  is_pdc                   = VALUES(is_pdc),
  is_gc                    = VALUES(is_gc),
  is_rid_master            = VALUES(is_rid_master),
  is_schema_master         = VALUES(is_schema_master),
  is_domain_naming_master  = VALUES(is_domain_naming_master),
  is_infrastructure_master = VALUES(is_infrastructure_master),
  discovered_at            = NOW(),
  discovered_by_agent_id   = VALUES(discovered_by_agent_id)
`.trim();

export async function upsertDiscoveredDc(pool, { agentId, collectedAt, dc }) {
  await pool.execute(DISCOVERY_UPSERT, [
    dc.name,
    dc.siteHint ?? null,
    dc.osVersion ?? null,
    dc.whenCreated ?? null,
    dc.isPdc ? 1 : 0,
    dc.isGc ? 1 : 0,
    dc.isRidMaster ? 1 : 0,
    dc.isSchemaMaster ? 1 : 0,
    dc.isDomainNamingMaster ? 1 : 0,
    dc.isInfrastructureMaster ? 1 : 0,
    collectedAt,
    agentId
  ]);
}
