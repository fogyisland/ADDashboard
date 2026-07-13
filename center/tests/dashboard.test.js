import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildThrowingPool } from './helpers/db-mock.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';

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
  _setDbForTest(buildMockDb());
  const app = buildApp();
  const r = await supertest(app).get('/api/dashboard/overview');
  assert.equal(r.status, 401);
});

test('overview: 403 when missing read:dash perm', async () => {
  _setDbForTest(buildMockDb());
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
  const db = buildMockDb([
    {
      match: /FROM\s+ad_replication_status/i,
      rows: [
        { source_site: 'SITE-A', dest_site: 'SITE-B',
          source_dc: 'DC-A1', dest_dc: 'DC-B1',
          status_code: 0, last_success_time: last },
        { source_site: 'SITE-A', dest_site: 'SITE-B',
          source_dc: 'DC-A1', dest_dc: 'DC-B2',
          status_code: 2, last_success_time: last }
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
  assert.ok(siteNodes.length >= 2, 'expect at least 2 site nodes');
  for (const n of siteNodes) {
    assert.ok(typeof n.name === 'string');
    assert.equal(n.site, undefined);
  }
  // DC nodes: name + site
  const dcNodes = r.body.nodes.filter(n => n.type === 'dc');
  assert.ok(dcNodes.length >= 3, 'expect at least 3 distinct dc nodes');
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

// ----- SITE REPLICATION MATRIX (G) -----

test('GET /api/dashboard/site-replication-matrix: 200 returns site + dcs + links', async () => {
  const db = buildMockDb([
    // 1) site lookup
    {
      match: /FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i,
      rows: [{ site_id: 1, site_name: 'Beijing-Site', region_code: 'BJ', is_hub: 1, description: 'BJ-DC' }]
    },
    // 2) DCs in site
    {
      match: /FROM\s+ad_dcs\s+WHERE\s+site_id\s*=\s*\?/i,
      rows: [
        { dc_name: 'DC-BJ-01', os_version: 'Win2022', is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, discovered_at: new Date(), discovered_by_agent_id: 'DC-BJ-01' },
        { dc_name: 'DC-BJ-02', os_version: 'Win2019', is_pdc: 0, is_gc: 1, is_rid_master: 0, is_schema_master: 0, is_domain_naming_master: 0, is_infrastructure_master: 0, discovered_at: new Date(), discovered_by_agent_id: 'DC-BJ-02' }
      ]
    },
    // 3) replication links
    {
      match: /FROM\s+ad_replication_status/i,
      rows: [
        { source_dc: 'DC-BJ-01', dest_dc: 'DC-BJ-02', naming_context: 'DC=contoso,DC=com', status_code: 0, last_success_time: new Date(), last_attempt_time: new Date(), duration_minutes: 5 }
      ]
    },
    // 4) refresh seconds config
    {
      match: /FROM\s+system_config\s+WHERE\s+config_key\s*=\s*['"]site_matrix_refresh_seconds['"]/i,
      rows: [{ config_value: '10' }]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix?site=Beijing-Site')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.site.siteName, 'Beijing-Site');
  assert.equal(r.body.dcs.length, 2);
  assert.equal(r.body.dcs[0].dcName, 'DC-BJ-01');
  assert.equal(r.body.links.length, 1);
  assert.equal(r.body.links[0].source, 'DC-BJ-01');
  assert.equal(r.body.links[0].target, 'DC-BJ-02');
  assert.equal(r.body.siteRefreshSeconds, 10);
});

test('GET /api/dashboard/site-replication-matrix: 404 when site not found', async () => {
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix?site=NoSuch')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'site not found');
});

test('GET /api/dashboard/site-replication-matrix: 200 empty arrays when site has no DCs', async () => {
  const db = buildMockDb([
    { match: /FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, rows: [{ site_id: 5, site_name: 'Empty-Site', region_code: null, is_hub: 0, description: null }] },
    { match: /FROM\s+ad_dcs\s+WHERE\s+site_id\s*=\s*\?/i, rows: [] },
    { match: /FROM\s+ad_replication_status/i, rows: [] },
    { match: /site_matrix_refresh_seconds/i, rows: [{ config_value: '10' }] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix?site=Empty-Site')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dcs, []);
  assert.deepEqual(r.body.links, []);
});

test('GET /api/dashboard/site-replication-matrix: 400 when site query missing', async () => {
  const db = buildMockDb().standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/site-replication-matrix')
    .set('Authorization', `Bearer ${adminToken(['read:dash'])}`);
  assert.equal(r.status, 400);
});