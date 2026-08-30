import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildThrowingPool } from './helpers/db-mock.js';

const SECRET = 'test-secret';

function buildApp() {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(dashboardRouter({ config, logger }));
  return a;
}

function adminToken(extraPerms) {
  return signJwt(
    { sub: 'u1', role: 'admin', permissions: extraPerms ?? ['*'] },
    SECRET,
    60
  );
}

// ----- AUTH WIRING -----

test('overview: 401 when no token', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get('/api/dashboard/overview');
  assert.equal(r.status, 401);
});

test('overview: 403 when missing read:dash perm', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const tok = signJwt(
    { sub: 'u2', role: 'viewer', permissions: ['read:something-else'] },
    SECRET,
    60
  );
  const r = await supertest(app)
    .get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${tok}`);
  assert.equal(r.status, 403);
});

test('overview: 200 with valid token + wildcard perm', async () => {
  const db = buildMockDb([
    {
      // overview count SELECT (SUM CASE WHEN ...)
      match: /SUM\s*\(\s*CASE\s+WHEN/i,
      rows: [{
        total: 10,
        healthy: 8,
        warning: 1,
        errored: 1,
        last_update: new Date('2026-07-10T00:00:00Z')
      }]
    },
    {
      // agent count SELECT
      match: /COUNT\(\*\)\s+AS\s+agent_count/i,
      rows: [{ agent_count: 3 }]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.totalLinks, 10);
  assert.equal(r.body.healthy, 8);
  assert.equal(r.body.warning, 1);
  assert.equal(r.body.error, 1);
  assert.equal(r.body.agentCount, 3);
  assert.ok(r.body.lastUpdate, 'lastUpdate should be present');
});

// ----- SITE MATRIX -----

test('site-matrix: returns camelCase keys sourceSite/destSite/errorCount/warningCount/total', async () => {
  const db = buildMockDb([
    {
      match: /GROUP\s+BY\s+source_site\s*,\s*dest_site/i,
      rows: [
        { source_site: 'SITE-A', dest_site: 'SITE-B',
          error_count: 0, warning_count: 2, total: 5 },
        { source_site: 'SITE-B', dest_site: 'SITE-C',
          error_count: 1, warning_count: 1, total: 3 }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/site-matrix')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2);
  assert.deepEqual(Object.keys(r.body[0]).sort(),
    ['destSite','errorCount','sourceSite','total','warningCount']);
  assert.equal(r.body[0].sourceSite, 'SITE-A');
  assert.equal(r.body[0].destSite, 'SITE-B');
  assert.equal(r.body[0].errorCount, 0);
  assert.equal(r.body[0].warningCount, 2);
  assert.equal(r.body[0].total, 5);
});

// ----- TOPOLOGY -----

test('topology: returns nodes (site + dc) and links with source/target/statusCode/lastSuccessTime', async () => {
  const last = new Date('2026-07-10T12:34:56Z');
  // 2026-08-26 round-21: topologyNodes derives from ad_sites + ad_dcs;
  // topologyLinks picks the latest per (source_dc, dest_dc) pair from
  // ad_replication_status joined against ad_dcs (skips self-loops,
  // junk rows, and stale round-19 leftovers).
  const db = buildMockDb([
    {
      match: /FROM\s+ad_sites/i,
      rows: [
        { site_id: 1, site_name: 'SITE-A', dc_name: 'DC-A1' },
        { site_id: 1, site_name: 'SITE-A', dc_name: 'DC-A2' },
        { site_id: 2, site_name: 'SITE-B', dc_name: 'DC-B1' },
        { site_id: 2, site_name: 'SITE-B', dc_name: 'DC-B2' }
      ]
    },
    {
      match: /INNER\s+JOIN\s+ad_dcs\s+sd\s+ON\s+sd\.dc_name\s+=\s+t1\.source_dc/i,
      rows: [
        { source_dc: 'DC-A1', dest_dc: 'DC-B1', status_code: 0, last_success_time: last },
        { source_dc: 'DC-A1', dest_dc: 'DC-B2', status_code: 2, last_success_time: last }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/topology')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.nodes));
  assert.ok(Array.isArray(r.body.links));

  // Site nodes: only `name`
  const siteNodes = r.body.nodes.filter(n => n.type === 'site');
  assert.equal(siteNodes.length, 2, 'expect 2 site nodes (SITE-A + SITE-B)');
  for (const n of siteNodes) {
    assert.ok(typeof n.name === 'string');
    assert.equal(n.site, undefined);
  }
  // DC nodes: name + site
  const dcNodes = r.body.nodes.filter(n => n.type === 'dc');
  assert.equal(dcNodes.length, 4, 'expect 4 DC nodes (DC-A1, DC-A2, DC-B1, DC-B2)');
  for (const n of dcNodes) {
    assert.ok(typeof n.name === 'string');
    assert.ok(typeof n.site === 'string');
  }
  // Links: interface block field names
  assert.equal(r.body.links.length, 2);
  assert.deepEqual(
    Object.keys(r.body.links[0]).sort(),
    ['lastSuccessTime','source','statusCode','target']
  );
  assert.equal(r.body.links[0].statusCode, 0);
  assert.equal(r.body.links[1].statusCode, 2);
});

// ----- ERRORS -----

test('errors: returns camelCase rows with status_code <> 0 and computed duration', async () => {
  const db = buildMockDb([
    {
      match: /status_code\s*<>\s*0/i,
      rows: [
        {
          source_dc: 'DC-A1', dest_dc: 'DC-B1',
          source_site: 'SITE-A', dest_site: 'SITE-B',
          naming_context: 'DC=contoso,DC=com',
          status_code: 2,
          last_success_time: new Date('2026-07-10T00:00:00Z'),
          last_attempt_time: new Date('2026-07-10T01:00:00Z'),
          duration_minutes: 60
        }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/errors')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].sourceDc, 'DC-A1');
  assert.equal(r.body[0].destDc, 'DC-B1');
  assert.equal(r.body[0].sourceSite, 'SITE-A');
  assert.equal(r.body[0].destSite, 'SITE-B');
  assert.equal(r.body[0].namingContext, 'DC=contoso,DC=com');
  assert.equal(r.body[0].statusCode, 2);
  assert.equal(r.body[0].durationMinutes, 60);
});

// ----- AGENTS -----

test('agents: returns camelCase rows with computed secondsSinceHeartbeat', async () => {
  const db = buildMockDb([
    {
      match: /FROM\s+ad_agent_heartbeat/i,
      rows: [
        {
          agent_id: 'agent-1',
          last_heartbeat_at: new Date('2026-07-10T00:00:00Z'),
          agent_version: '1.0.0',
          last_report_at: new Date('2026-07-10T00:01:00Z'),
          last_report_status: 'success',
          pending_queue_size: 0,
          seconds_since_heartbeat: 42
        }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].agentId, 'agent-1');
  assert.equal(r.body[0].agentVersion, '1.0.0');
  assert.equal(r.body[0].lastReportStatus, 'success');
  assert.equal(r.body[0].pendingQueueSize, 0);
  assert.equal(r.body[0].secondsSinceHeartbeat, 42);
});

test('agents: attaches portStatuses per agent (stale rows hidden via INNER JOIN)', async () => {
  // Two agents; only agent-1 (dc01) has probe results. agent-2 (dc02) has none.
  // SQL helper does INNER JOIN against system_ports, so a status row whose
  // port is no longer registered is filtered at the DB layer. The mock
  // simulates the post-JOIN output: only dc01/port 135 survives (label from
  // system_ports), and dc01/port 99999 is gone.
  const checkedAt = new Date('2026-07-23T00:00:00Z');
  const db = buildMockDb([
    {
      match: /FROM\s+ad_agent_heartbeat/i,
      rows: [
        {
          agent_id: 'dc01',
          last_heartbeat_at: new Date('2026-07-23T00:00:00Z'),
          agent_version: '1.0.0',
          last_report_at: null,
          last_report_status: 'success',
          pending_queue_size: 0,
          seconds_since_heartbeat: 5
        },
        {
          agent_id: 'dc02',
          last_heartbeat_at: new Date('2026-07-23T00:00:00Z'),
          agent_version: '1.0.0',
          last_report_at: null,
          last_report_status: 'success',
          pending_queue_size: 0,
          seconds_since_heartbeat: 7
        }
      ]
    },
    {
      // listPortStatusesForAgents -> portStatus.listForAgents (post-INNER-JOIN)
      match: /FROM\s+ad_agent_port_status[\s\S]*?WHERE\s+\S*\.?agent_id\s+IN/i,
      rows: [
        { agentId: 'dc01', port: 135, ok: 1, latencyMs: 3, lastCheckedAt: checkedAt, label: 'RPC' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  const dc01 = r.body.find(a => a.agentId === 'dc01');
  const dc02 = r.body.find(a => a.agentId === 'dc02');
  assert.deepEqual(dc01.portStatuses, [
    { port: 135, label: 'RPC', ok: true, latencyMs: 3, lastCheckedAt: checkedAt.toISOString() }
  ], 'port 135 status row passes through with label from JOIN');
  assert.deepEqual(dc02.portStatuses, [], 'dc02 has no port statuses yet');
});

test('agents: portStatuses empty for all agents when system_ports is empty (fallback)', async () => {
  const checkedAt = new Date('2026-07-23T00:00:00Z');
  const db = buildMockDb([
    {
      match: /FROM\s+ad_agent_heartbeat/i,
      rows: [
        {
          agent_id: 'dc01',
          last_heartbeat_at: new Date('2026-07-23T00:00:00Z'),
          agent_version: '1.0.0',
          last_report_at: null,
          last_report_status: 'success',
          pending_queue_size: 0,
          seconds_since_heartbeat: 5
        }
      ]
    },
    {
      // system_ports empty -> INNER JOIN returns zero rows -> empty statuses.
      match: /FROM\s+ad_agent_port_status[\s\S]*?WHERE\s+\S*\.?agent_id\s+IN/i,
      rows: []
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.deepEqual(r.body[0].portStatuses, [], 'no registered ports -> all statuses hidden');
});

// ----- DB ERROR PATH -----

test('overview: 500 on DB error, returns {error: "internal"}', async () => {
  _setDbForTest(buildThrowingPool('boom'));
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'internal');
});

// ----- SITE REPLICATION MATRIX (ALL SITES) — round-27 -----

test("GET /api/dashboard/site-replication-matrix/all: 401 when no token", async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get("/api/dashboard/site-replication-matrix/all");
  assert.equal(r.status, 401);
});

test("GET /api/dashboard/site-replication-matrix/all: 200 hub-first with per-primary partner tables (inbound only)", async () => {
  // Round-35 envelope: each site contributes one primary DC (lexically
  // first dc_name; PDC marker NOT used). The primary surfaces every
  // INBOUND replication link (other DCs sending TO this primary).
  // Outbound is intentionally dropped — a TCP probe shows once from the
  // destination's perspective, not twice from both ends. The `direction`
  // field is no longer present (every entry is inbound).
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    // 1) allSitesOrdered — hub first
    {
      match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [
        { site_id: 1, site_name: "核心站点", region_code: "BJ", is_hub: 1, description: null },
        { site_id: 2, site_name: "上海站点", region_code: "SH", is_hub: 0, description: null }
      ]
    },
    // 2) allDcsBySite — INNER JOIN ad_sites
    {
      match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-BJ-01", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-01" },
        { dc_name: "DC-BJ-02", site_id: 1, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-02" },
        { dc_name: "DC-SH-01", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-SH-01" }
      ]
    },
    // 3) allReplicationLinks — naming_context NOT IN (excludes summary/meta)
    {
      match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        // within-link for 核心站点 (BJ-01 → BJ-02): from BJ-02's perspective
        // this is an inbound partner row. From BJ-01's perspective the row
        // would be outbound — must be dropped.
        { source_dc: "DC-BJ-01", dest_dc: "DC-BJ-02", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 1 },
        // cross-link 核心 → 上海 (BJ-01 → SH-01, status 1 = warn): outbound
        // for BJ-01, inbound for SH-01. Only the SH-01 primary surfaces it.
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com", status_code: 1, last_success_time: ls, last_attempt_time: la, duration_minutes: 12 }
      ]
    },
    // 4) refreshSeconds config
    {
      match: /site_matrix_refresh_seconds/i,
      rows: [{ config_value: "15" }]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.siteRefreshSeconds, 15);
  // round-45: ports/portRows removed from /all envelope (R35 port monitoring
  // surface deleted). perPort + lastProbeAt also gone from partner entries.

  // hub first
  assert.equal(r.body.primaries.length, 2);
  assert.equal(r.body.primaries[0].dcName, "DC-BJ-01"); // lex first of 01, 02
  assert.equal(r.body.primaries[0].siteName, "核心站点");
  assert.equal(r.body.primaries[0].isHub, true);
  assert.equal(r.body.primaries[1].dcName, "DC-SH-01");
  assert.equal(r.body.primaries[1].siteName, "上海站点");
  assert.equal(r.body.primaries[1].isHub, false);

  // round-31: every primary surfaces its full DC list (all siblings in
  // the site, with role flags + osVersion). 核心站点 has BJ-01 + BJ-02;
  // 上海站点 has only SH-01.
  assert.equal(r.body.primaries[0].dcs.length, 2);
  assert.deepEqual(r.body.primaries[0].dcs.map(d => d.dcName), ["DC-BJ-01", "DC-BJ-02"]);
  assert.equal(r.body.primaries[0].dcs[0].isPdc, true);
  assert.equal(r.body.primaries[0].dcs[0].isGc, true);
  assert.equal(r.body.primaries[0].dcs[0].osVersion, "Win2022");
  assert.equal(r.body.primaries[0].dcs[0].isBridgehead, false);
  assert.equal(r.body.primaries[1].dcs.length, 1);
  assert.equal(r.body.primaries[1].dcs[0].dcName, "DC-SH-01");

  // DC-BJ-01 primary (round-35: inbound only — BJ-01 is the bridgehead for
  // both ends of every link in this scenario, so it has NO inbound
  // partners; outbound links to BJ-02 + SH-01 are dropped).
  const hub = r.body.primaries[0];
  assert.equal(hub.partners.length, 0, "BJ-01 has no inbound partners in this scenario");

  // round-36: per-DC partner tables. The operator directive was
  // "本地站点只显示了一台，另外一台没有显示出来" — every DC in the site
  // must surface its own partners[]. The 核心站点 has BJ-01 (no inbound)
  // and BJ-02 (BJ-01 → BJ-02 is inbound to BJ-02's perspective).
  assert.ok(Array.isArray(hub.dcPartners), "primaries[0].dcPartners is an array");
  assert.equal(hub.dcPartners.length, 2, "核心站点 has 2 DCs → 2 dcPartners entries");
  const hubBJ01 = hub.dcPartners.find(d => d.dcName === "DC-BJ-01");
  const hubBJ02 = hub.dcPartners.find(d => d.dcName === "DC-BJ-02");
  assert.ok(hubBJ01, "DC-BJ-01 entry present");
  assert.ok(hubBJ02, "DC-BJ-02 entry present");
  assert.equal(hubBJ01.partners.length, 0, "BJ-01 has no inbound partners");
  assert.equal(hubBJ01.isPdc, true);
  assert.equal(hubBJ01.isGc, true);
  assert.equal(hubBJ01.osVersion, "Win2022");
  assert.equal(hubBJ02.partners.length, 1, "BJ-02 has 1 inbound partner (BJ-01 → BJ-02)");
  assert.equal(hubBJ02.partners[0].peerDc, "DC-BJ-01");
  assert.equal(hubBJ02.partners[0].peerSite, "核心站点");
  assert.equal(hubBJ02.partners[0].peerType, "within");
  // round-45: perPort + lastProbeAt removed from partner entries (R35
  // port monitoring surface deleted). No assertions here for those keys.

  // DC-SH-01 primary (round-35: inbound only):
  //   - in: DC-BJ-01 (cross-site, status 1, was formerly probed but R35 dropped)
  const spoke = r.body.primaries[1];
  assert.equal(spoke.partners.length, 1);
  // round-35: direction field is gone — every entry is implicitly inbound.
  assert.equal(spoke.partners[0].direction, undefined);
  assert.equal(spoke.partners[0].peerDc, "DC-BJ-01");
  assert.equal(spoke.partners[0].peerSite, "核心站点");
  assert.equal(spoke.partners[0].peerSiteIsHub, true);
  assert.equal(spoke.partners[0].peerType, "bridgehead");

  // round-36: 上海站点 has only SH-01, so its dcPartners[] has 1 entry.
  assert.equal(spoke.dcPartners.length, 1);
  assert.equal(spoke.dcPartners[0].dcName, "DC-SH-01");
  assert.equal(spoke.dcPartners[0].partners.length, 1);
  assert.equal(spoke.dcPartners[0].partners[0].peerDc, "DC-BJ-01");
});

test("GET /api/dashboard/site-replication-matrix/all: 500 on DB error", async () => {
  _setDbForTest(buildThrowingPool("boom"));
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "internal");
});

test("GET /api/dashboard/site-replication-matrix/all: empty catalog returns primaries: []", async () => {
  const db = buildMockDb([
    // Only allSitesOrdered matches; everything else falls through to []
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i, rows: [] },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.primaries, []);
  assert.equal(r.body.siteRefreshSeconds, 10);
});

test("GET /api/dashboard/site-replication-matrix/all: orphan DC link produces no partner row", async () => {
  // catalog has 1 DC but the link refers to an orphan DC not in the catalog.
  // The route must drop the link silently — primary.partners stays empty.
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i, rows: [{ site_id: 1, site_name: "SITE-A", region_code: "BJ", is_hub: 1, description: null }] },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i, rows: [
      { dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" }
    ]},
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i, rows: [
      // this link refers to ORPHAN-DC which is NOT in ad_dcs
      { source_dc: "DC-A1", dest_dc: "ORPHAN-DC", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 5 }
    ]},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.primaries.length, 1);
  assert.equal(r.body.primaries[0].dcName, "DC-A1");
  assert.equal(r.body.primaries[0].partners.length, 0);
});



test("GET /api/dashboard/site-replication-matrix/all: primary DC is lexically first dc_name per site, NOT is_pdc", async () => {
  // Round-28 operator ruling: PDC is a role, not a marker — do NOT use
  // is_pdc to choose primary. Even though DC-A2 has is_pdc=1, DC-A1 is
  // primary because A1 < A2 alphabetically.
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i, rows: [
      { site_id: 1, site_name: "SITE-A", region_code: "BJ", is_hub: 1, description: null }
    ]},
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i, rows: [
      { dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" },
      { dc_name: "DC-A2", site_id: 1, os_version: "Win2019", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A2" }
    ]},
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i, rows: []},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.primaries.length, 1);
  assert.equal(r.body.primaries[0].dcName, "DC-A1", "lexically first wins over is_pdc=1");
});

test("GET /api/dashboard/site-replication-matrix/all: bridgehead DC wins over lex-first, isBridgehead surfaced in response", async () => {
  // Round-28.5 operator ruling: 桥头DC (bridgehead DC) — operator-marked
  // via ad_dcs.is_bridgehead — is the primary. Even though DC-A1 is
  // lex-first, DC-A2 is_bridgehead=1 wins. The response surfaces
  // isBridgehead so the view can show a "桥头" badge.
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i, rows: [
      { site_id: 1, site_name: "SITE-A", region_code: "BJ", is_hub: 1, description: null }
    ]},
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i, rows: [
      { dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" },
      { dc_name: "DC-A2", site_id: 1, os_version: "Win2019", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 1, discovered_at: ls, discovered_by_agent_id: "DC-A2" }
    ]},
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i, rows: []},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.primaries.length, 1);
  assert.equal(r.body.primaries[0].dcName, "DC-A2", "is_bridgehead=1 wins over lex-first");
  assert.equal(r.body.primaries[0].isBridgehead, true);
});

test("GET /api/dashboard/site-replication-matrix/all: lex-first fallback when no DC marked bridgehead", async () => {
  // Round-28.5 fallback: if no DC in a site has is_bridgehead=1, the
  // lexically-first dc_name wins. isBridgehead must be false in the
  // response so the view can render an "未指定桥头" state if it chooses.
  const ls = new Date("2026-08-27T10:00:00Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i, rows: [
      { site_id: 1, site_name: "SITE-A", region_code: "BJ", is_hub: 1, description: null }
    ]},
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i, rows: [
      { dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" },
      { dc_name: "DC-A2", site_id: 1, os_version: "Win2019", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A2" }
    ]},
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i, rows: []},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.primaries.length, 1);
  assert.equal(r.body.primaries[0].dcName, "DC-A1", "no bridgehead marked → lex-first");
  assert.equal(r.body.primaries[0].isBridgehead, false);
});

// 2026-08-27 round-35: inbound-only filter. When both DC-A1 and DC-B1
// replicate to each other (bidirectional), each link surfaces ONCE at
// the destination's primary, never at the source's. The `direction`
// field is gone — every entry is implicitly inbound.
test("GET /api/dashboard/site-replication-matrix/all: round-35 inbound-only filter drops outbound, surfaces inbound once", async () => {
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i, rows: [
      { site_id: 1, site_name: "SITE-A", region_code: "BJ", is_hub: 1, description: null },
      { site_id: 2, site_name: "SITE-B", region_code: "SH", is_hub: 0, description: null }
    ]},
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i, rows: [
      { dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" },
      { dc_name: "DC-B1", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-B1" }
    ]},
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i, rows: [
      // bidirectional replication between the two primaries
      { source_dc: "DC-A1", dest_dc: "DC-B1", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 3 },
      { source_dc: "DC-B1", dest_dc: "DC-A1", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 4 }
    ]},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  // DC-A1 (hub primary) has 1 inbound from DC-B1 (the B→A link)
  const hub = r.body.primaries[0];
  assert.equal(hub.dcName, "DC-A1");
  assert.equal(hub.partners.length, 1, "DC-A1 has 1 inbound partner (DC-B1)");
  assert.equal(hub.partners[0].peerDc, "DC-B1");
  assert.equal(hub.partners[0].peerType, "bridgehead");
  assert.equal(hub.partners[0].direction, undefined, "direction field is gone (round-35)");
  // DC-B1 (spoke primary) has 1 inbound from DC-A1 (the A→B link)
  const spoke = r.body.primaries[1];
  assert.equal(spoke.dcName, "DC-B1");
  assert.equal(spoke.partners.length, 1, "DC-B1 has 1 inbound partner (DC-A1)");
  assert.equal(spoke.partners[0].peerDc, "DC-A1");
  assert.equal(spoke.partners[0].direction, undefined);
});


// ----- ROUND-45 PAIR HISTORY (复制过程历史) -----
// New per-pair history lazy-fetch endpoint. The /all route no longer embeds
// history rows inline; the matrix view expands each partner row on demand
// and calls this endpoint. Tests pin the envelope, the auth gate, the
// (source, dest) WHERE binding, and the dialect-aware LIMIT-first binding.

test("GET /api/dashboard/site-replication-matrix/pair-history: 401 when no token", async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get("/api/dashboard/site-replication-matrix/pair-history?source=DC-A&dest=DC-B");
  assert.equal(r.status, 401);
});

test("GET /api/dashboard/site-replication-matrix/pair-history: 400 when source missing", async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/pair-history?dest=DC-B")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /source and dest required/);
});

test("GET /api/dashboard/site-replication-matrix/pair-history: 400 when dest missing", async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/pair-history?source=DC-A")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /source and dest required/);
});

test("GET /api/dashboard/site-replication-matrix/pair-history: 200 returns history rows mapped to attemptAt/statusCode/durationMs envelope", async () => {
  // Mock returns 2 history rows for (DC-A, DC-B); expect 2 entries with the
  // expected keys + ISO attemptAt + passthrough errorMessage.
  const db = buildMockDb([
    {
      match: /FROM\s+ad_replication_history/i,
      rows: [
        { source_dc: 'DC-A', dest_dc: 'DC-B', naming_context: 'CN=Config', status_code: 0,
          last_success_time: new Date('2026-08-28T01:00:00Z'),
          last_attempt_time: new Date('2026-08-28T01:00:30Z'),
          attempt_duration_ms: 1234, objects_transferred: 42,
          error_message: null, collected_at: new Date('2026-08-28T01:00:30Z') },
        { source_dc: 'DC-A', dest_dc: 'DC-B', naming_context: 'CN=Config', status_code: 2,
          last_success_time: null,
          last_attempt_time: new Date('2026-08-28T00:55:00Z'),
          attempt_duration_ms: null, objects_transferred: null,
          error_message: 'RPC server unavailable', collected_at: new Date('2026-08-28T00:55:00Z') }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/pair-history?source=DC-A&dest=DC-B&limit=10")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'DC-A');
  assert.equal(r.body.dest, 'DC-B');
  assert.equal(r.body.limit, 10);
  assert.equal(r.body.entries.length, 2);
  const e0 = r.body.entries[0];
  assert.ok(e0.attemptAt, 'attemptAt must be ISO string');
  assert.equal(e0.statusCode, 0);
  assert.equal(e0.durationMs, 1234);
  assert.equal(e0.objectsTransferred, 42);
  assert.equal(e0.errorMessage, null);
  const e1 = r.body.entries[1];
  assert.equal(e1.statusCode, 2);
  assert.equal(e1.errorMessage, 'RPC server unavailable');
  assert.equal(e1.lastSuccessTime, null);
});

test("GET /api/dashboard/site-replication-matrix/pair-history: 500 on DB error", async () => {
  // Use buildThrowingPool: every query throws, the route returns 500/{error:internal}.
  _setDbForTest(buildThrowingPool('boom'));
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/pair-history?source=DC-A&dest=DC-B")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'internal');
});

test("GET /api/dashboard/site-replication-matrix/pair-history: clamps limit to [1, 50] (default 10)", async () => {
  // limit=999 → clamp to 50; missing → default 10.
  const db = buildMockDb([
    { match: /FROM\s+ad_replication_history/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r1 = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/pair-history?source=DC-A&dest=DC-B&limit=999")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r1.body.limit, 50);
  const r2 = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/pair-history?source=DC-A&dest=DC-B")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r2.body.limit, 10);
});
// ----- PARTNER PORT HEALTH MONITOR (复制伙伴端口健康监控) — round-47 -----
//
// Renamed from 复制日志监控 (round-42) in round-47. The route mirrors
// /api/dashboard/site-replication-matrix/all (per-DC partner tables,
// inbound-only) but augments every partner with portHealth[] (latest
// per-(source_dc, dest_dc) partner-port probe) and configuredPorts[]
// (the global system_ports list). The replication-attempts caret history
// (R42/R46) is intentionally dropped — that surface is exclusive to
// 复制状态概览's inline expansion via /pair-history. Tests pin the
// envelope, the auth gate, the inbound-only partner filter, and the
// port-health wire shape.

test("GET /api/dashboard/partner-port-health/all: 401 when no token", async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get("/api/dashboard/partner-port-health/all");
  assert.equal(r.status, 401);
});

test("GET /api/dashboard/partner-port-health/all: 200 hub-first, no attempts field on partners", async () => {
  // 2026-08-28 round-47 dropped two R42/R46 attempts-history tests:
  //   - "attempts slice to last 10 grouped by source/dest/naming_context"
  //     (route no longer queries ad_replication_history)
  //   - "attempts grouped per naming_context (different NCs don't share attempts)"
  //     (attempts[] field removed from response envelope)
  // The history surface moved exclusively to 复制状态概览's inline caret
  // via /pair-history. This test pins the "no attempts field" contract.
  // Mirror the matrix/all fixture: 2 sites, 1 cross-link. R47: the
  // history-rows mock is gone because the route no longer queries
  // ad_replication_history; partners do NOT carry an `attempts` field.
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");

  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [
        { site_id: 1, site_name: "核心站点", region_code: "BJ", is_hub: 1, description: null },
        { site_id: 2, site_name: "上海站点", region_code: "SH", is_hub: 0, description: null }
      ]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-BJ-01", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-01" },
        { dc_name: "DC-SH-01", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-SH-01" }
      ]
    },
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        // single cross-link BJ-01 → SH-01
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 1 }
      ]
    },
    { match: /site_matrix_refresh_seconds/i,
      rows: [{ config_value: "12" }]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.refreshSeconds, 12);

  // Hub first; R46 inbound-only filter: 核心站点 has 1 DC (BJ-01) with 0 partners
  // (its outbound link is NOT surfaced here — operator directive "出战没有意义").
  // 上海 has 1 DC (SH-01) with 1 partner (inbound from BJ-01, direction='in').
  assert.equal(r.body.sites.length, 2);
  assert.equal(r.body.sites[0].siteName, "核心站点");
  assert.equal(r.body.sites[0].primaryDc, "DC-BJ-01");
  // R46 inbound-only: BJ-01's outbound to SH-01 is filtered; it surfaces on SH-01 below.
  assert.equal(r.body.sites[0].dcs[0].partners.length, 0,
    "R46: BJ-01 has 0 partners (outbound side filtered out)");
  assert.equal(r.body.sites[1].siteName, "上海站点");
  assert.equal(r.body.sites[1].primaryDc, "DC-SH-01");
  const sh01 = r.body.sites[1].dcs[0];
  assert.equal(sh01.dcName, "DC-SH-01");
  assert.equal(sh01.partners.length, 1);
  const partner = sh01.partners[0];
  assert.equal(partner.peerDc, "DC-BJ-01");
  assert.equal(partner.peerSite, "核心站点");
  assert.equal(partner.peerType, "bridgehead");
  assert.equal(partner.statusCode, 0);
  assert.equal(partner.direction, "in");

  // R47: attempts field removed — the route is port-health only.
  assert.equal(partner.attempts, undefined, "R47: attempts[] field removed");
});

test("GET /api/dashboard/partner-port-health/all: empty partners returns DC with zero entries", async () => {
  const ls = new Date("2026-08-27T10:00:00Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [{ site_id: 1, site_name: "S", region_code: "BJ", is_hub: 1, description: null }]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [{ dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" }]
    },
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i, rows: [] },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.sites.length, 1);
  // 1 DC, no partners (no inbound links), no error.
  assert.equal(r.body.sites[0].dcs[0].partners.length, 0);
});

test("GET /api/dashboard/partner-port-health/all: 500 on DB error", async () => {
  _setDbForTest(buildThrowingPool("boom"));
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "internal");
});

// 2026-08-28 round-46 (preserved in R47): filter partners to inbound-only.
// The inbound destination (SH-01) still sees the link with direction='in';
// the source (BJ-01) does NOT. The two-direction surface stays alive in
// 复制状态概览 (R36 view).
test("GET /api/dashboard/partner-port-health/all: inbound-only filter — dest gets direction='in', source has no partner", async () => {
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [
        { site_id: 1, site_name: "核心站点", region_code: "BJ", is_hub: 1, description: null },
        { site_id: 2, site_name: "上海站点", region_code: "SH", is_hub: 0, description: null }
      ]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-BJ-01", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-01" },
        { dc_name: "DC-SH-01", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-SH-01" }
      ]
    },
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        // BJ-01 → SH-01 (cross-site hub-to-spoke)
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 12 }
      ]
    },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  // Hub site (核心站点) — BJ-01 has NO partners (outbound side filtered)
  const bj01 = r.body.sites.find(s => s.siteName === "核心站点").dcs[0];
  assert.equal(bj01.dcName, "DC-BJ-01");
  assert.equal(bj01.partners.length, 0, "R46: BJ-01 outbound side filtered out");
  // Spoke site (上海站点) — SH-01 sees BJ-01's inbound as direction='in'
  const sh01 = r.body.sites.find(s => s.siteName === "上海站点").dcs[0];
  assert.equal(sh01.dcName, "DC-SH-01");
  assert.equal(sh01.partners.length, 1);
  assert.equal(sh01.partners[0].peerDc, "DC-BJ-01");
  assert.equal(sh01.partners[0].direction, "in", "SH-01's inbound from BJ-01 → direction='in'");
});

// 2026-08-28 round-46 (supersedes R43 within-site variant): R46 inbound-only
// filter — A1 (source) gets no partner; A2 (dest) sees A1 with direction='in'.
test("GET /api/dashboard/partner-port-health/all: within-site link — only dest side surfaces with direction='in' (R46 inbound-only)", async () => {
  // Within-site link A1→A2: A2 sees A1 with direction='in' (A2 receives from A1);
  // A1 sees no partner (outbound side filtered — R46).
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [{ site_id: 1, site_name: "S", region_code: "BJ", is_hub: 1, description: null }]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-A1", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A1" },
        { dc_name: "DC-A2", site_id: 1, os_version: "Win2022", is_pdc: 0, is_gc: 0, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-A2" }
      ]
    },
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        // A1 → A2 within-site
        { source_dc: "DC-A1", dest_dc: "DC-A2", naming_context: "DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 1 }
      ]
    },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  const site = r.body.sites[0];
  const a1 = site.dcs.find(d => d.dcName === "DC-A1");
  const a2 = site.dcs.find(d => d.dcName === "DC-A2");
  // R46 inbound-only filter — A1 (source) has no partner rows; A2 (dest) sees the inbound from A1.
  assert.equal(a1.partners.length, 0, "R46: A1 outbound side filtered out");
  assert.equal(a2.partners.length, 1);
  assert.equal(a2.partners[0].peerDc, "DC-A1");
  assert.equal(a2.partners[0].direction, "in", "A2 dest side: direction='in'");
});

// 2026-08-28 round-46: route attaches configuredPorts[] and portHealth[] to
// each partner. Tests pin both fields' shapes (empty when DB has no port
// data, populated when latestPartnerPortPerPair + ports.list return rows).
test("GET /api/dashboard/partner-port-health/all: partners carry empty configuredPorts[]/portHealth[] when no port data", async () => {
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [
        { site_id: 1, site_name: "核心站点", region_code: "BJ", is_hub: 1, description: null },
        { site_id: 2, site_name: "上海站点", region_code: "SH", is_hub: 0, description: null }
      ]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-BJ-01", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-01" },
        { dc_name: "DC-SH-01", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-SH-01" }
      ]
    },
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 12 }
      ]
    },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
    // latestPartnerPortPerPair + ports.list intentionally absent — route must default to []
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  const sh01 = r.body.sites[1].dcs[0];
  assert.equal(sh01.partners.length, 1);
  const partner = sh01.partners[0];
  assert.ok(Array.isArray(partner.configuredPorts), "configuredPorts is an array");
  assert.equal(partner.configuredPorts.length, 0, "no system_ports rows → empty configuredPorts");
  assert.ok(Array.isArray(partner.portHealth), "portHealth is an array");
  assert.equal(partner.portHealth.length, 0, "no latestPartnerPortPerPair rows → empty portHealth");
});

test("GET /api/dashboard/partner-port-health/all: partners carry configuredPorts[] + portHealth[] from latestPartnerPortPerPair and ports.list", async () => {
  const ls = new Date("2026-08-27T10:00:00Z");
  const la = new Date("2026-08-27T10:00:30Z");
  const partnerPortStatusJson = JSON.stringify({
    ports: [
      { port: 135, ok: true,  latency: 4 },
      { port: 445, ok: true,  latency: 3 },
      { port: 389, ok: false, latency: null }
    ]
  });
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [
        { site_id: 1, site_name: "核心站点", region_code: "BJ", is_hub: 1, description: null },
        { site_id: 2, site_name: "上海站点", region_code: "SH", is_hub: 0, description: null }
      ]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-BJ-01", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-01" },
        { dc_name: "DC-SH-01", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-SH-01" }
      ]
    },
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 12 }
      ]
    },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] },
    // latestPartnerPortPerPair row keyed on (source_dc=BJ-01, dest_dc=SH-01)
    // SQL: SELECT ... FROM ad_replication_status t1 WHERE t1.naming_context LIKE '__partner_ports__:%'
    { match: /FROM\s+ad_replication_status\s+t1/i,
      rows: [
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01",
          status_code: 1, last_attempt_time: la, partner_port_status: partnerPortStatusJson }
      ]
    },
    // ports.list (system_ports) — global probe target list
    { match: /FROM\s+system_ports/i,
      rows: [
        { port: 135, label: "RPC"   },
        { port: 445, label: "SMB"   },
        { port: 389, label: "LDAP"  },
        { port: 636, label: "LDAPS" }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  const sh01 = r.body.sites[1].dcs[0];
  const partner = sh01.partners[0];
  // configuredPorts: array of {port, label} from system_ports
  assert.equal(partner.configuredPorts.length, 4);
  assert.deepEqual(partner.configuredPorts.map(p => p.port), [135, 445, 389, 636]);
  assert.equal(partner.configuredPorts[0].label, "RPC");
  // portHealth: single entry for (BJ-01, SH-01) with parsed JSON
  assert.equal(partner.portHealth.length, 1);
  const ph = partner.portHealth[0];
  assert.equal(ph.statusCode, 1, "partial reachability (one port failed)");
  assert.equal(ph.lastAttemptTime, new Date(la).toISOString());
  assert.equal(ph.ports.length, 3);
  assert.deepEqual(ph.ports.map(p => p.port), [135, 445, 389]);
  // R47 colour-rule data-layer inputs — view renders these via
  // SLOW_THRESHOLD_MS=1000. Pin the inputs so the cell-matrix has
  // known colour cases to render.
  assert.equal(ph.ports[0].ok, true);
  assert.equal(ph.ports[0].latency, 4,    "latency 4 ≤ 1000 → green");
  assert.equal(ph.ports[1].ok, true);
  assert.equal(ph.ports[1].latency, 3,    "latency 3 ≤ 1000 → green");
  assert.equal(ph.ports[2].ok, false,      "ok=false → red ✕");
  assert.equal(ph.ports[2].latency, null);
});

// 2026-08-28 round-56: regression test for the "monitor 有重复的数据"
// operator bug. `allReplicationLinks` returns one row per
// (source_dc, dest_dc, naming_context) tuple — AD reports 3 naming
// contexts per partner pair (CN=Configuration, CN=Schema, DC=domain)
// plus the synthetic `__partner_ports__:<hash>` rows the port probe
// emits. Before this fix, the route's dedup key was
// `${peerDc}${sep}${naming_context}${sep}${direction}` so each naming
// context became its own partner entry → operator saw each pair 4×.
// After the fix, dedup key is `${peerDc}${sep}${direction}` only,
// keeping the most recent attempt across all naming contexts and
// yielding exactly ONE partner row per (DC, peer, direction).
test("GET /api/dashboard/partner-port-health/all: R56 dedup — one partner per (dc, peer, direction) regardless of naming_context", async () => {
  const ls = new Date("2026-08-27T10:00:00Z");
  const la1 = new Date("2026-08-27T10:00:30Z"); // older attempt
  const la2 = new Date("2026-08-27T10:01:00Z"); // newer attempt (wins)
  const partnerPortStatusJson = JSON.stringify({
    ports: [{ port: 135, ok: true, latency: 5 }]
  });
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+ORDER\s+BY\s+is_hub/i,
      rows: [
        { site_id: 1, site_name: "核心站点", region_code: "BJ", is_hub: 1, description: null },
        { site_id: 2, site_name: "上海站点", region_code: "SH", is_hub: 0, description: null }
      ]
    },
    { match: /FROM\s+ad_dcs\s+d\s+INNER\s+JOIN\s+ad_sites/i,
      rows: [
        { dc_name: "DC-BJ-01", site_id: 1, os_version: "Win2022", is_pdc: 1, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-BJ-01" },
        { dc_name: "DC-SH-01", site_id: 2, os_version: "Win2019", is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, is_bridgehead: 0, discovered_at: ls, discovered_by_agent_id: "DC-SH-01" }
      ]
    },
    // allReplicationLinks returns 3 naming_contexts for the same
    // (BJ-01, SH-01) pair — exactly the operator's bug condition.
    { match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "CN=Configuration,DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la1, duration_minutes: 1 },
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "CN=Schema,CN=Configuration,DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la1, duration_minutes: 1 },
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com",
          status_code: 0, last_success_time: ls, last_attempt_time: la2, duration_minutes: 2 }
      ]
    },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] },
    // partner-port row — same (BJ-01, SH-01), different naming_context,
    // status_code=1 (the synthetic hash format). Mirror the live agent's
    // pattern where the hash suffix makes equality comparisons impossible.
    { match: /FROM\s+ad_replication_status\s+t1/i,
      rows: [
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01",
          naming_context: "__partner_ports__:abc12345",
          status_code: 1, last_attempt_time: la2, partner_port_status: partnerPortStatusJson }
      ]
    },
    { match: /FROM\s+system_ports/i,
      rows: [{ port: 135, label: "RPC" }]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/partner-port-health/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  // R46 inbound-only: BJ-01 outbound is filtered; SH-01 inbound is shown.
  const sh01 = r.body.sites[1].dcs[0];
  assert.equal(sh01.dcName, "DC-SH-01");
  // R56: was 4 partner entries (one per naming_context). After fix: 1.
  assert.equal(sh01.partners.length, 1,
    "R56: must collapse all naming_context variants into one partner entry");
  const partner = sh01.partners[0];
  assert.equal(partner.peerDc, "DC-BJ-01");
  assert.equal(partner.direction, "in");
  // The newer attempt (la2) wins; the older la1 rows are dropped.
  assert.equal(partner.lastAttemptTime, new Date(la2).toISOString());
  // portHealth is keyed on (source_dc, dest_dc) — independent of
  // naming_context — so it still joins back in to the single partner row.
  assert.equal(partner.portHealth.length, 1);
  assert.equal(partner.portHealth[0].statusCode, 1);
  assert.equal(partner.portHealth[0].ports.length, 1);
});

// ----- R67-T2: GET /api/dashboard/packages-runs (包执行状态监控) -----

test('packages-runs: 401 when no token', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get('/api/dashboard/packages-runs');
  assert.equal(r.status, 401);
});

test('packages-runs: 200 + envelope with 24h breakdown + recent runs', async () => {
  // Two built-in scripts; recent-runs rows include success / partial / failure
  // spans to exercise the classifier. started_at must be recent (within 24h)
  // for the 24h counters to count; the runner-side failure is older than 24h
  // so the failure should NOT count toward the 24h summary (but should still
  // surface in `recent`).
  //
  // The mock returns rows in declaration order (the db-mock helper does not
  // actually run SQL ORDER BY), so we list rows in started_at DESC order to
  // mirror what `packageRuns.listRecent` would surface in production.
  const now = Date.now();
  const minutesAgo = (n) => new Date(now - n * 60_000);
  const hoursAgo = (n) => new Date(now - n * 3600_000);

  _setDbForTest(buildMockDb([
    {
      match: /FROM\s+package_scripts\b/i,
      rows: [
        {
          name: 'ad_os_baseline', version: '1.0.0',
          script_content: '...', script_sha256: 'aaaa',
          manifest_json: JSON.stringify({ type: 'gauge', agent: { type: 'ad' }, description: 'OS baseline check' }),
          source: 'builtin', created_at: hoursAgo(48), updated_at: hoursAgo(1)
        },
        {
          name: 'ad_local_port_check', version: '1.0.0',
          script_content: '...', script_sha256: 'bbbb',
          manifest_json: JSON.stringify({ type: 'gauge', agent: { type: 'ad' }, description: 'Local port probe' }),
          source: 'builtin', created_at: hoursAgo(48), updated_at: hoursAgo(2)
        }
      ]
    },
    {
      match: /FROM\s+package_runs\b/i,
      // Recent LIMIT 200 — handler groups by package_name + computes 24h
      // buckets + slices first 10 per package. Listed in started_at DESC.
      rows: [
        // ad_os_baseline — 3 rows, all within 24h. Listed newest first.
        { id: 3, agent_id: 'MOCK-NCADSRV1', package_name: 'ad_os_baseline',
          started_at: minutesAgo(10), finished_at: minutesAgo(9),
          exit_code: null, stdout_preview: 'partial', stderr_preview: 'partial output', error: null },
        { id: 2, agent_id: 'MOCK-NCADSRV1', package_name: 'ad_os_baseline',
          started_at: minutesAgo(20), finished_at: minutesAgo(19),
          exit_code: 0, stdout_preview: 'ok', stderr_preview: null, error: null },
        { id: 1, agent_id: 'MOCK-HUBADSRV1', package_name: 'ad_os_baseline',
          started_at: minutesAgo(30), finished_at: minutesAgo(29),
          exit_code: 0, stdout_preview: 'ok', stderr_preview: null, error: null },
        // ad_local_port_check — 3 rows: 1 success, 1 failure (24h), 1 old failure (>24h)
        { id: 4, agent_id: 'MOCK-HUBADSRV1', package_name: 'ad_local_port_check',
          started_at: minutesAgo(5), finished_at: minutesAgo(4),
          exit_code: 0, stdout_preview: 'all reachable', stderr_preview: null, error: null },
        { id: 5, agent_id: 'MOCK-NCADSRV1', package_name: 'ad_local_port_check',
          started_at: minutesAgo(15), finished_at: minutesAgo(14),
          exit_code: 2, stdout_preview: null, stderr_preview: 'port 88 unreachable', error: 'port 88 unreachable' },
        { id: 6, agent_id: 'MOCK-NCADSRV1', package_name: 'ad_local_port_check',
          started_at: hoursAgo(30), finished_at: hoursAgo(30),
          exit_code: 2, stdout_preview: null, stderr_preview: 'old failure', error: 'old failure' }
      ]
    }
  ]).standard());

  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/packages-runs')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);

  assert.equal(r.status, 200);
  assert.equal(r.body.refreshSeconds, 10);
  assert.equal(r.body.packages.length, 2);

  const baseline = r.body.packages.find((p) => p.name === 'ad_os_baseline');
  assert.ok(baseline, 'expected ad_os_baseline package');
  assert.equal(baseline.summary24h.total, 3);
  assert.equal(baseline.summary24h.success, 2);
  assert.equal(baseline.summary24h.failure, 0);
  assert.equal(baseline.summary24h.partial, 1);
  // All 3 rows surface in `recent` (sliced to 10)
  assert.equal(baseline.recent.length, 3);
  // recent is sorted by started_at DESC — id=3 (10min ago) comes first
  assert.equal(baseline.recent[0].id, 3);
  // exit_code=null surfaced; durationMs computed from finished - started
  assert.equal(baseline.recent[0].exitCode, null);
  assert.equal(baseline.recent[0].durationMs, 60_000);

  const port = r.body.packages.find((p) => p.name === 'ad_local_port_check');
  assert.ok(port);
  // Old failure (id=6) is outside the 24h window → does NOT count toward failure
  assert.equal(port.summary24h.total, 2);
  assert.equal(port.summary24h.success, 1);
  assert.equal(port.summary24h.failure, 1);
  // recent slice: handler does not filter by 24h, so all 3 rows surface
  // but ordered by started_at DESC → newest first
  assert.equal(port.recent.length, 3);
  assert.equal(port.recent[0].id, 4); // most recent (5min ago)
  assert.equal(port.recent[port.recent.length - 1].id, 6); // oldest (30h ago)
  // Failure row carries the stderr_preview + error string
  const failRow = port.recent.find((r) => r.id === 5);
  assert.equal(failRow.stderrPreview, 'port 88 unreachable');
  assert.equal(failRow.error, 'port 88 unreachable');
  // Old failure (id=6) is outside 24h and stays in recent[] with same shape
  const oldRow = port.recent.find((r) => r.id === 6);
  assert.equal(oldRow.stderrPreview, 'old failure');
});

test('packages-runs: empty packages array when no scripts installed', async () => {
  _setDbForTest(buildMockDb([
    { match: /FROM\s+package_scripts\b/i, rows: [] },
    { match: /FROM\s+package_runs\b/i, rows: [] }
  ]).standard());

  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/packages-runs')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.packages, []);
  assert.equal(r.body.refreshSeconds, 10);
});

test('packages-runs: 500 on db error', async () => {
  _setDbForTest(buildThrowingPool('packages-runs boom'));
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/packages-runs')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'internal' });
});
