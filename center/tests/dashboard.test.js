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

test("GET /api/dashboard/site-replication-matrix/all: 200 hub-first with per-primary partner tables (out + in + perPort)", async () => {
  // Round-28 envelope: each site contributes one primary DC (lexically
  // first dc_name; PDC marker NOT used). The primary surfaces every
  // replication link it participates in, both as source (direction=out)
  // and as destination (direction=in).
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
    // 3) allReplicationLinks — naming_context NOT IN (excludes summary/meta/partner-port)
    {
      match: /naming_context\s+NOT\s+IN\s*\(\s*'__dc_summary__'/i,
      rows: [
        // within-link for 核心站点
        { source_dc: "DC-BJ-01", dest_dc: "DC-BJ-02", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 1 },
        // cross-link 核心 → 上海 (status 1 = warn)
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", naming_context: "DC=contoso,DC=com", status_code: 1, last_success_time: ls, last_attempt_time: la, duration_minutes: 12 }
      ]
    },
    // 4) latestPartnerPortPerPair — partner-port JSON probe rows
    {
      match: /naming_context\s+LIKE\s+'__partner_ports__:%/i,
      rows: [
        { source_dc: "DC-BJ-01", dest_dc: "DC-SH-01", source_site: "MOCK-NC", dest_site: "MOCK-NC",
          partner_port_status: JSON.stringify({ "135": { reachable: true, latencyMs: 3 }, "445": { reachable: false, error: "timeout" } }),
          last_attempt_time: la, collected_at: la }
      ]
    },
    // 5) refreshSeconds config
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
  assert.ok(Array.isArray(r.body.ports), "ports is array");
  assert.equal(r.body.ports.length, 5, "5 default partner-probe ports when system_ports empty");

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

  // DC-BJ-01 primary:
  //   - out: DC-BJ-02 (within-site, status 0)
  //   - out: DC-SH-01 (cross-site, status 1, with partner-port probe)
  const hub = r.body.primaries[0];
  assert.equal(hub.partners.length, 2);
  const outWithin = hub.partners.find(p => p.direction === "out" && p.peerDc === "DC-BJ-02");
  const outCross = hub.partners.find(p => p.direction === "out" && p.peerDc === "DC-SH-01");
  assert.ok(outWithin, "BJ-01 → BJ-02 must surface as out-partner");
  assert.ok(outCross, "BJ-01 → SH-01 must surface as out-partner");
  assert.equal(outWithin.peerSite, "核心站点");
  assert.equal(outCross.peerSite, "上海站点");
  assert.deepEqual(outCross.perPort, {
    "135": { reachable: true, latencyMs: 3 },
    "445": { reachable: false, error: "timeout" }
  });
  // out rows come before in rows
  assert.equal(hub.partners[0].direction, "out");

  // DC-SH-01 primary:
  //   - in: DC-BJ-01 (cross-site, status 1, with partner-port probe)
  const spoke = r.body.primaries[1];
  assert.equal(spoke.partners.length, 1);
  assert.equal(spoke.partners[0].direction, "in");
  assert.equal(spoke.partners[0].peerDc, "DC-BJ-01");
  assert.equal(spoke.partners[0].peerSite, "核心站点");
  assert.equal(spoke.partners[0].peerSiteIsHub, true);
  assert.deepEqual(spoke.partners[0].perPort, {
    "135": { reachable: true, latencyMs: 3 },
    "445": { reachable: false, error: "timeout" }
  });
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

test("GET /api/dashboard/site-replication-matrix/all: partner-port JSON STRING (MSSQL) is parsed", async () => {
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
      { source_dc: "DC-A1", dest_dc: "DC-B1", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 3 }
    ]},
    // MSSQL-style: partner_port_status is a STRING (the tedious driver returns
    // JSON columns as raw strings). The route must JSON.parse it before merge.
    { match: /naming_context\s+LIKE\s+'__partner_ports__:%/i, rows: [
      { source_dc: "DC-A1", dest_dc: "DC-B1", source_site: "MOCK-NC", dest_site: "MOCK-NC",
        partner_port_status: "{\"135\":{\"reachable\":true,\"latencyMs\":4}}",
        last_attempt_time: la, collected_at: la }
    ]},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  const partner = r.body.primaries[0].partners.find(p => p.peerDc === "DC-B1");
  assert.ok(partner, "DC-A1 primary must surface DC-B1 as out-partner");
  assert.ok(partner.perPort && typeof partner.perPort === "object", "perPort must be parsed object, not string");
  assert.equal(partner.perPort["135"].reachable, true);
  assert.equal(partner.perPort["135"].latencyMs, 4);
});

test("GET /api/dashboard/site-replication-matrix/all: partner-port JSON OBJECT (MySQL) is preserved", async () => {
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
      { source_dc: "DC-A1", dest_dc: "DC-B1", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 3 }
    ]},
    // MySQL-style: mysql2 driver auto-parses JSON columns -> object
    { match: /naming_context\s+LIKE\s+'__partner_ports__:%/i, rows: [
      { source_dc: "DC-A1", dest_dc: "DC-B1", source_site: "MOCK-NC", dest_site: "MOCK-NC",
        partner_port_status: { "135": { reachable: true, latencyMs: 4 } },
        last_attempt_time: la, collected_at: la }
    ]},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  const partner = r.body.primaries[0].partners.find(p => p.peerDc === "DC-B1");
  assert.deepEqual(partner.perPort, {
    "135": { reachable: true, latencyMs: 4 }
  });
});

test("GET /api/dashboard/site-replication-matrix/all: malformed partner-port JSON falls back to empty perPort", async () => {
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
      { source_dc: "DC-A1", dest_dc: "DC-B1", naming_context: "DC=contoso,DC=com", status_code: 0, last_success_time: ls, last_attempt_time: la, duration_minutes: 3 }
    ]},
    // malformed JSON — route must catch and treat as empty probe map
    { match: /naming_context\s+LIKE\s+'__partner_ports__:%/i, rows: [
      { source_dc: "DC-A1", dest_dc: "DC-B1", source_site: "MOCK-NC", dest_site: "MOCK-NC",
        partner_port_status: "not json{",
        last_attempt_time: la, collected_at: la }
    ]},
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: "10" }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get("/api/dashboard/site-replication-matrix/all")
    .set("Authorization", `Bearer ${adminToken(["read:dash"])}`);
  assert.equal(r.status, 200);
  const partner = r.body.primaries[0].partners.find(p => p.peerDc === "DC-B1");
  assert.deepEqual(partner.perPort, {});
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
});;