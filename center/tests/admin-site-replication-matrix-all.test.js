import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildSql } from '../src/db/sql.js';
import { buildMockDb } from './helpers/db-mock.js';
import { signJwt } from '../src/auth/jwt.js';

const SECRET = 'test-secret';

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function buildApp(db) {
  const a = express();
  a.use(express.json());
  // dashboardRouter internally composes userAuth + requirePerm, so mount
  // it directly. The route handler reads db via getDb() which returns
  // whatever _setDbForTest installed — the same shape buildMockDb emits.
  // The auth middleware's per-request SELECTs (sys_users / jwt_secret)
  // fall through buildMockDb's default empty-rows path; db-mock.js's
  // defaultQuery (installed by buildMockDb.standard()) routes those to
  // auth-success rows.
  _setDbForTest(db);
  return a.use(
    dashboardRouter({
      config: {},
      logger: null
    })
  );
}

// Catalogue row for a DC. Bare name only — matches the actual ad_dcs
// schema (see sql.dashboard.allDcsBySite).
function fakeDc(overrides = {}) {
  return {
    dc_name: 'KDLFLOFADSRV2',
    site_id: 'site-fl',
    is_bridgehead: true,
    is_pdc: false, is_gc: false, is_rid_master: false, is_schema_master: false,
    is_domain_naming_master: false, is_infrastructure_master: false,
    os_version: 'Win2022', discovered_at: new Date(),
    ...overrides
  };
}

function fakeSite(overrides = {}) {
  return {
    site_id: 'site-fl', site_name: 'KDL-FL-HubSite',
    region_code: 'CN-FL', is_hub: true,
    ...overrides
  };
}

// Link row with full NTDS Settings DN (as collector emits to
// ad_replication_status).
function fakeLink(overrides = {}) {
  return {
    source_dc: 'CN=NTDS Settings,CN=KDLBJOFADSRV1,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
    dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
    source_site: 'KDL-BeiJing', dest_site: 'KDL-FL-HubSite',
    naming_context: 'DC=shaphar,DC=com',
    status_code: 0,
    last_success_time: new Date('2026-09-25T08:00:00Z'),
    last_attempt_time: new Date('2026-09-25T08:00:00Z'),
    duration_minutes: 5,
    ...overrides
  };
}

function mockMatrixDb({ dcs = [], sites = [], links = [] } = {}) {
  return buildMockDb([
    {
      // allSitesOrdered: SELECT ... FROM ad_sites ORDER BY is_hub DESC, ...
      match: /FROM\s+ad_sites\s+ORDER\s+BY/i,
      rows: sites
    },
    {
      // allDcsBySite: SELECT ... FROM ad_dcs d INNER JOIN ad_sites s ...
      match: /FROM\s+ad_dcs\b[\s\S]*?INNER\s+JOIN\s+ad_sites/i,
      rows: dcs
    },
    {
      // allReplicationLinks: SELECT ... FROM ad_replication_status t1
      //   WHERE t1.source_dc <> t1.dest_dc AND naming_context NOT IN ...
      match: /FROM\s+ad_replication_status[\s\S]*?WHERE\s+t1\.source_dc\s*<>\s*t1\.dest_dc/i,
      rows: links
    },
    {
      // refreshSeconds: SELECT config_value FROM system_config ...
      match: /FROM\s+system_config/i,
      rows: [{ config_key: 'dashboard_refresh_seconds', config_value: '10' }]
    }
  ]).standard();
}

// R93.12: collector writes full NTDS Settings DN into
// ad_replication_status.source_dc / dest_dc, but ad_dcs.dc_name is the bare
// DC name. The matrix route handler must normalise both sides before
// joining link rows against the catalogue, otherwise every link is dropped
// and the matrix renders empty.
test('site-replication-matrix/all: DN link rows match bare-name catalogue (R93.12 normalisation)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-bj', site_name: 'KDL-BeiJing', region_code: 'CN-BJ', is_hub: true }),
      fakeSite({ site_id: 'site-fl', site_name: 'KDL-FL-HubSite', region_code: 'CN-FL', is_hub: true }),
      fakeSite({ site_id: 'site-sh', site_name: 'KDL-ShangHai', region_code: 'CN-SH', is_hub: false })
    ],
    dcs: [
      fakeDc({ dc_name: 'KDLBJOFADSRV1', site_id: 'site-bj' }),
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' }),
      fakeDc({ dc_name: 'KDLSHTOFADSRV1', site_id: 'site-sh' })
    ],
    links: [
      // Inbound to KDLFLOFADSRV2 from KDLBJOFADSRV1
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLBJOFADSRV1,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-BeiJing', dest_site: 'KDL-FL-HubSite',
        status_code: 0, last_success_time: new Date('2026-09-25T08:00:00Z'),
        last_attempt_time: new Date('2026-09-25T08:00:00Z'), duration_minutes: 5
      }),
      // Outbound from KDLFLOFADSRV2 to KDLSHTOFADSRV1
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLSHTOFADSRV1,CN=Servers,CN=KDL-ShangHai,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-FL-HubSite', dest_site: 'KDL-ShangHai',
        status_code: 2, last_success_time: null,
        last_attempt_time: new Date('2026-09-25T08:00:00Z'), duration_minutes: 30
      })
    ]
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  const payload = res.body;
  assert.ok(Array.isArray(payload.primaries), 'payload.primaries should be an array');
  assert.equal(payload.primaries.length, 3, 'all 3 sites should be present');

  // KDLFLOFADSRV2 lives in KDL-FL-HubSite — that site appears as a primary row.
  const fl = payload.primaries.find(p => p.siteName === 'KDL-FL-HubSite');
  assert.ok(fl, 'KDL-FL-HubSite must be in primaries');
  const flDc = fl.dcPartners.find(d => d.dcName === 'KDLFLOFADSRV2');
  assert.ok(flDc, 'KDLFLOFADSRV2 should be listed in dcPartners for KDL-FL-HubSite');

  // DN-format link KDLBJOFADSRV1 → KDLFLOFADSRV2 produces a partner entry
  // on KDLFLOFADSRV2 with bare-name peerDc (R93.12 normalisation).
  const bjPeer = flDc.partners.find(p => p.peerDc === 'KDLBJOFADSRV1');
  assert.ok(bjPeer, 'inbound partner from KDLBJOFADSRV1 must land on KDLFLOFADSRV2 with bare-name peerDc');
  assert.equal(bjPeer.peerType, 'bridgehead');
  assert.equal(bjPeer.peerSite, 'KDL-BeiJing');
  assert.equal(bjPeer.statusCode, 0);

  // Reverse direction: KDLFLOFADSRV2 → KDLSHTOFADSRV1. Look at the ShangHai
  // primary — it should have an inbound entry from KDLFLOFADSRV2 with
  // bare-name peerDc.
  const sh = payload.primaries.find(p => p.siteName === 'KDL-ShangHai');
  assert.ok(sh, 'KDL-ShangHai must be in primaries');
  const shDc = sh.dcPartners.find(d => d.dcName === 'KDLSHTOFADSRV1');
  assert.ok(shDc, 'KDLSHTOFADSRV1 should be listed in dcPartners for KDL-ShangHai');
  const flPeer = shDc.partners.find(p => p.peerDc === 'KDLFLOFADSRV2');
  assert.ok(flPeer, 'inbound partner from KDLFLOFADSRV2 must land on KDLSHTOFADSRV1 with bare-name peerDc');
  assert.equal(flPeer.statusCode, 2);
});

// Pre-R93.12 sentinel: if a future refactor accidentally drops the
// DN-to-bare-name normalisation, this test catches the regression.
test('site-replication-matrix/all: DN link rows must surface partner entries (sentinel)', async () => {
  const db = mockMatrixDb({
    sites: [
      fakeSite({ site_id: 'site-bj', site_name: 'KDL-BeiJing', region_code: 'CN-BJ', is_hub: true }),
      fakeSite({ site_id: 'site-fl', site_name: 'KDL-FL-HubSite', region_code: 'CN-FL', is_hub: true })
    ],
    dcs: [
      fakeDc({ dc_name: 'KDLBJOFADSRV1', site_id: 'site-bj' }),
      fakeDc({ dc_name: 'KDLFLOFADSRV2', site_id: 'site-fl' })
    ],
    links: [
      fakeLink({
        source_dc: 'CN=NTDS Settings,CN=KDLBJOFADSRV1,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        dest_dc:   'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=shaphar,DC=net',
        source_site: 'KDL-BeiJing', dest_site: 'KDL-FL-HubSite',
        status_code: 0
      })
    ]
  });
  _setDbForTest(db);

  const res = await supertest(buildApp(db))
    .get('/api/dashboard/site-replication-matrix/all')
    .set('Authorization', `Bearer ${adminToken()}`);

  assert.equal(res.status, 200);
  const fl = res.body.primaries.find(p => p.siteName === 'KDL-FL-HubSite');
  assert.ok(fl, 'KDL-FL-HubSite must be in primaries');
  const flDc = fl.dcPartners.find(d => d.dcName === 'KDLFLOFADSRV2');
  assert.ok(flDc, 'KDLFLOFADSRV2 must be listed in dcPartners');
  assert.ok(flDc.partners.length > 0,
    `expected at least one inbound partner after DN normalisation, got ${flDc.partners.length}`);
});